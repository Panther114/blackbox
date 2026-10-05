//! File rules: the document allowlist, filename safety, Content-Disposition
//! parsing, layout-aware save paths and the download-directory index. A direct
//! port of src/utils/{fileType,fileValidation,helpers}.ts and
//! src/downloadDirectory.ts.

use std::collections::HashSet;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use percent_encoding::percent_decode_str;
use regex::Regex;
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use url::Url;

// ---------------------------------------------------------------------------
// Document allowlist
// ---------------------------------------------------------------------------

pub const SUPPORTED_FILE_TYPES: [&str; 7] = ["pdf", "ppt", "pptx", "doc", "docx", "xls", "xlsx"];

const BLOCKED_FILE_EXTENSIONS: &[&str] = &[
    "zip", "rar", "7z", "gz", "png", "jpg", "jpeg", "gif", "bmp", "svg", "webp", "heic", "mp4", "mp3", "mov", "avi",
    "mkv", "wmv", "webm", "flv", "wav", "aac", "ogg", "m4a", "m4v", "txt", "csv", "json", "xml",
];

const MIME_TO_EXTENSION: &[(&str, &str)] = &[
    ("application/pdf", "pdf"),
    ("application/msword", "doc"),
    ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"),
    ("application/vnd.ms-powerpoint", "ppt"),
    ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "pptx"),
    ("application/vnd.ms-excel", "xls"),
    ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"),
];

const BLOCKED_MIME_TYPES: &[&str] = &[
    "application/zip",
    "application/x-zip-compressed",
    "application/x-rar-compressed",
    "application/x-7z-compressed",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "text/plain",
    "text/csv",
    "application/csv",
    "application/json",
    "application/xml",
    "text/xml",
];
const BLOCKED_MIME_PREFIXES: &[&str] = &["audio/", "video/", "image/"];

fn is_supported(ext: &str) -> bool {
    SUPPORTED_FILE_TYPES.contains(&ext)
}

fn is_blocked_ext(ext: &str) -> bool {
    BLOCKED_FILE_EXTENSIONS.contains(&ext)
}

fn allowed_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!(r"(?i)\.({})\b", SUPPORTED_FILE_TYPES.join("|"))).unwrap())
}

fn blocked_token_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!(r"(?i)\.({})\b", BLOCKED_FILE_EXTENSIONS.join("|"))).unwrap())
}

/// Matches the extensions Blackboard serves documents with (`/file.pdf`, `.pptx`, ...).
pub fn allowed_doc_ext_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)\.(pdf|pptx?|docx?|xlsx?)$").unwrap())
}

/// Like `decodeURIComponent`, but returns the input unchanged when it is not valid.
pub fn safely_decode(input: &str) -> String {
    percent_decode_str(input).decode_utf8().map(|decoded| decoded.into_owned()).unwrap_or_else(|_| input.to_string())
}

/// `path.extname(name).slice(1).toLowerCase()`, or `None` when there is no extension.
pub fn extension_of(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let dot = base.rfind('.')?;
    if dot == 0 {
        return None;
    }
    let ext = &base[dot + 1..];
    if ext.is_empty() {
        None
    } else {
        Some(ext.to_lowercase())
    }
}

fn ext_of_path_like(input: &str) -> Option<String> {
    extension_of(&safely_decode(&input.trim().to_lowercase()))
}

fn normalize_mime(mime: Option<&str>) -> Option<String> {
    let value = mime?.split(';').next()?.trim().to_lowercase();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

pub fn supported_extension_from_mime(mime: Option<&str>) -> Option<&'static str> {
    let normalized = normalize_mime(mime)?;
    MIME_TO_EXTENSION.iter().find(|(known, _)| *known == normalized).map(|(_, ext)| *ext)
}

pub fn has_supported_extension(filename: &str) -> bool {
    extension_of(filename).is_some_and(|ext| is_supported(&ext))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    UnsupportedExtension,
    UnknownType,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedName {
    pub accepted: bool,
    pub name: String,
    pub extension: Option<String>,
    pub reason: Option<Rejection>,
}

fn accepted(name: String, extension: &str) -> NormalizedName {
    NormalizedName { accepted: true, name, extension: Some(extension.to_string()), reason: None }
}

fn rejected(name: String, reason: Rejection) -> NormalizedName {
    NormalizedName { accepted: false, name, extension: None, reason: Some(reason) }
}

/// Make sure a downloaded name carries a supported extension, borrowing it from the MIME type when needed.
pub fn normalize_supported_filename(filename: &str, mime: Option<&str>) -> NormalizedName {
    let trimmed = filename.trim();
    let safe = if trimmed.is_empty() { "file".to_string() } else { trimmed.to_string() };
    let from_mime = supported_extension_from_mime(mime);

    if let Some(current) = extension_of(&safe) {
        if is_supported(&current) {
            return accepted(safe, &current);
        }
        if is_blocked_ext(&current) {
            return rejected(safe, Rejection::UnsupportedExtension);
        }
        if let Some(ext) = from_mime {
            let cut = safe.rfind('.').unwrap_or(safe.len());
            let base = if safe[..cut].is_empty() { "file" } else { &safe[..cut] };
            return accepted(format!("{base}.{ext}"), ext);
        }
        return rejected(safe, Rejection::UnknownType);
    }
    match from_mime {
        Some(ext) => accepted(format!("{safe}.{ext}"), ext),
        None => rejected(safe, Rejection::UnknownType),
    }
}

pub fn allowed_ext_from_name(name_or_url: &str) -> Option<String> {
    let normalized = safely_decode(name_or_url.trim());
    if normalized.is_empty() {
        return None;
    }
    if let Ok(url) = Url::parse(&normalized) {
        if let Some(ext) = ext_of_path_like(url.path()) {
            if is_supported(&ext) {
                return Some(ext);
            }
        }
    }
    if let Some(ext) = ext_of_path_like(&normalized) {
        if is_supported(&ext) {
            return Some(ext);
        }
    }
    allowed_token_re().captures(&normalized).map(|caps| caps[1].to_lowercase()).filter(|ext| is_supported(ext))
}

fn extension_from_url_path(url: &str) -> Option<String> {
    if url.is_empty() {
        return None;
    }
    match Url::parse(url) {
        Ok(parsed) => ext_of_path_like(parsed.path()),
        Err(_) => ext_of_path_like(url),
    }
}

pub fn is_allowed_mime(mime: Option<&str>) -> bool {
    supported_extension_from_mime(mime).is_some()
}

pub fn is_blocked_mime(mime: Option<&str>) -> bool {
    let Some(value) = mime else { return false };
    let normalized = value.trim().to_lowercase();
    BLOCKED_MIME_TYPES.contains(&normalized.as_str()) || BLOCKED_MIME_PREFIXES.iter().any(|prefix| normalized.starts_with(prefix))
}

pub fn has_blocked_extension(name_or_url: &str) -> bool {
    if name_or_url.is_empty() {
        return false;
    }
    let ext = extension_from_url_path(name_or_url).or_else(|| ext_of_path_like(name_or_url));
    if ext.as_deref().is_some_and(is_blocked_ext) {
        return true;
    }
    blocked_token_re()
        .captures(&safely_decode(name_or_url))
        .map(|caps| caps[1].to_lowercase())
        .is_some_and(|ext| is_blocked_ext(&ext))
}

pub fn is_allowed_document_candidate(name: Option<&str>, url: Option<&str>, mime: Option<&str>) -> bool {
    if is_blocked_mime(mime) {
        return false;
    }
    if name.is_some_and(has_blocked_extension) || url.is_some_and(has_blocked_extension) {
        return false;
    }
    is_allowed_mime(mime)
        || name.is_some_and(|value| allowed_ext_from_name(value).is_some())
        || url.is_some_and(|value| allowed_ext_from_name(value).is_some())
}

// ---------------------------------------------------------------------------
// Filenames
// ---------------------------------------------------------------------------

fn is_illegal_name_char(c: char) -> bool {
    matches!(c, '/' | '?' | '<' | '>' | '\\' | ':' | '*' | '|' | '"') || ('\u{0}'..='\u{1f}').contains(&c) || ('\u{80}'..='\u{9f}').contains(&c)
}

fn is_windows_reserved_name(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$").unwrap()).is_match(name)
}

/// Filesystem-safe file name (NFKC, no reserved characters or device names, at most 200 characters).
pub fn sanitize_filename(name: &str) -> String {
    if name.is_empty() {
        return "file".into();
    }
    let mut out: String = name.nfkc().collect::<String>().replace(':', " - ");
    out.retain(|c| !is_illegal_name_char(c));
    if out == "." || out == ".." || is_windows_reserved_name(&out) {
        out.clear();
    }
    let mut out = out.trim_end_matches(['.', ' ']).to_string();
    // Cap the length first so the extension survives, then guard the byte length.
    if out.chars().count() > 200 {
        let ext = extension_of(&out).map(|e| format!(".{e}")).unwrap_or_default();
        let keep = 200usize.saturating_sub(ext.chars().count());
        let base: String = out.chars().take(keep).collect();
        out = format!("{base}{ext}");
    }
    while out.len() > 255 {
        out.pop();
    }
    let out = out.trim().trim_end_matches(|c: char| c == '.' || c.is_whitespace()).to_string();
    if out.is_empty() {
        "file".into()
    } else {
        out
    }
}

pub fn extract_filename_from_url(url: &str) -> String {
    Url::parse(url)
        .ok()
        .map(|parsed| safely_decode(parsed.path()))
        .and_then(|path| path.rsplit('/').next().map(str::to_string))
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| "file".into())
}

/// The real server-side file name from a Content-Disposition header.
pub fn parse_content_disposition(header: &str) -> Option<String> {
    if header.is_empty() {
        return None;
    }
    static STAR: OnceLock<Regex> = OnceLock::new();
    static QUOTED: OnceLock<Regex> = OnceLock::new();
    static BARE: OnceLock<Regex> = OnceLock::new();
    let star = STAR.get_or_init(|| Regex::new(r"(?i)filename\*=(?:UTF-8''|utf-8'')([^;\r\n]+)").unwrap());
    let quoted = QUOTED.get_or_init(|| Regex::new(r#"(?i)filename="([^"\r\n]+)""#).unwrap());
    let bare = BARE.get_or_init(|| Regex::new(r#"(?i)filename=([^;\r\n"]+)"#).unwrap());

    if let Some(caps) = star.captures(header) {
        if let Ok(decoded) = percent_decode_str(&caps[1]).decode_utf8() {
            return Some(decoded.into_owned());
        }
    }
    if let Some(caps) = quoted.captures(header) {
        return Some(caps[1].to_string());
    }
    bare.captures(header).map(|caps| caps[1].trim().to_string())
}

// ---------------------------------------------------------------------------
// Unique paths for in-flight downloads
// ---------------------------------------------------------------------------

fn reserved() -> &'static Mutex<HashSet<PathBuf>> {
    static SET: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

fn split_ext(filename: &str) -> (String, String) {
    match filename.rfind('.') {
        Some(dot) if dot > 0 && dot + 1 < filename.len() => (filename[..dot].to_string(), filename[dot..].to_string()),
        _ => (filename.to_string(), String::new()),
    }
}

/// A free path in `dir` for `filename`, reserved so a concurrent download cannot claim it too.
pub fn unique_file_path(dir: &Path, filename: &str) -> PathBuf {
    let (base, ext) = split_ext(filename);
    let mut guard = reserved().lock().unwrap();
    let mut n = 0u32;
    loop {
        let candidate = dir.join(if n == 0 { filename.to_string() } else { format!("{base} ({n}){ext}") });
        if !candidate.exists() && !guard.contains(&candidate) {
            guard.insert(candidate.clone());
            return candidate;
        }
        n += 1;
    }
}

pub fn release_reserved_path(path: &Path) {
    reserved().lock().unwrap().remove(path);
}

pub fn is_path_reserved(path: &Path) -> bool {
    reserved().lock().unwrap().contains(path)
}

/// A random-looking hidden `.tmp` sibling used while a download is in progress.
pub fn tmp_file_path(final_path: &Path) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    let mut value = nanos ^ COUNTER.fetch_add(1, Ordering::Relaxed).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    let mut token = String::new();
    for _ in 0..8 {
        token.push(char::from_digit((value % 36) as u32, 36).unwrap());
        value /= 36;
    }
    let name = final_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    final_path.with_file_name(format!(".{name}.{token}.tmp"))
}

// ---------------------------------------------------------------------------
// Layout and the download-directory index
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DownloadLayout {
    #[default]
    Hierarchy,
    Flat,
}

fn absolute(path: &Path) -> PathBuf {
    let base = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut out = PathBuf::new();
    for component in base.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn fold(value: &str) -> String {
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value.to_string()
    }
}

/// A stable key for a path. Windows paths are case-insensitive.
pub fn normalize_download_path(path: &Path) -> String {
    fold(&absolute(path).to_string_lossy())
}

/// The path segments of `path` below `root`, or `None` when it lies outside.
fn segments_below(root: &Path, path: &Path) -> Option<Vec<String>> {
    let root = absolute(root);
    let path = absolute(path);
    let root_parts: Vec<String> = root.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    let path_parts: Vec<String> = path.components().map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    if path_parts.len() < root_parts.len() {
        return None;
    }
    if root_parts.iter().zip(&path_parts).any(|(a, b)| fold(a) != fold(b)) {
        return None;
    }
    Some(path_parts[root_parts.len()..].to_vec())
}

/// Where a file is written for a layout: `hierarchy` keeps the Blackboard tree,
/// `flat` collapses everything into its course folder (the first folder under the download root).
pub fn resolve_save_path_for_layout(download_dir: &Path, save_path: &Path, layout: DownloadLayout) -> PathBuf {
    if layout != DownloadLayout::Flat {
        return save_path.to_path_buf();
    }
    match segments_below(download_dir, save_path) {
        Some(parts) if parts.len() > 1 => absolute(download_dir).join(&parts[0]),
        _ => save_path.to_path_buf(),
    }
}

/// The course folder behind a save path (first folder under the download root).
pub fn course_folder_for_save_path(download_dir: &Path, save_path: &Path) -> Option<PathBuf> {
    let parts = segments_below(download_dir, save_path)?;
    parts.first().map(|first| absolute(download_dir).join(first))
}

/// Name inside a flat course folder: the plain name while it is free, otherwise
/// qualified with the section ("Lecture.pdf" -> "Lecture (Week 2).pdf").
pub fn preferred_flat_filename(directory: &Path, filename: &str, section: Option<&str>, is_taken: &dyn Fn(&Path) -> bool) -> String {
    if !is_taken(&directory.join(filename)) {
        return filename.to_string();
    }
    let raw = section.map(str::trim).unwrap_or("");
    if raw.is_empty() {
        return filename.to_string();
    }
    let section = sanitize_filename(raw);
    let section = section.trim();
    if section.is_empty() {
        return filename.to_string();
    }
    let (base, ext) = split_ext(filename);
    let candidate = format!("{base} ({section}){ext}");
    if candidate.chars().count() > 180 {
        filename.to_string()
    } else {
        candidate
    }
}

/// Remove empty folders below `root` (never the root, files or links). Returns how many were removed.
pub fn prune_empty_directories(root: &Path) -> usize {
    fn prune(directory: &Path, removed: &mut usize) -> bool {
        let Ok(entries) = fs::read_dir(directory) else { return false };
        let mut empty = true;
        for entry in entries.flatten() {
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if !is_dir {
                empty = false;
                continue;
            }
            let child = entry.path();
            if prune(&child, removed) {
                if fs::remove_dir(&child).is_ok() {
                    *removed += 1;
                } else {
                    empty = false;
                }
            } else {
                empty = false;
            }
        }
        empty
    }
    let mut removed = 0;
    if root.exists() {
        prune(root, &mut removed);
    }
    removed
}

/// Index every regular file under the download directory (links are not followed).
pub fn scan_download_directory(download_dir: &Path) -> HashSet<String> {
    fn visit(directory: &Path, files: &mut HashSet<String>) {
        let Ok(entries) = fs::read_dir(directory) else { return };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                visit(&entry.path(), files);
            } else if kind.is_file() {
                files.insert(normalize_download_path(&entry.path()));
            }
        }
    }
    let mut files = HashSet::new();
    visit(download_dir, &mut files);
    files
}

/// Both the displayed and the sanitized name: older runs may have written either.
pub fn download_path_candidates(directory: &Path, filename: &str) -> Vec<PathBuf> {
    let mut out = vec![directory.join(filename)];
    let sanitized = directory.join(sanitize_filename(filename));
    if !out.contains(&sanitized) {
        out.push(sanitized);
    }
    out
}

pub fn is_download_present(indexed: &HashSet<String>, directory: &Path, filename: &str) -> bool {
    download_path_candidates(directory, filename).iter().any(|candidate| indexed.contains(&normalize_download_path(candidate)))
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_default()
}

/// Delete everything inside the download directory but keep the directory. Returns the number of entries removed.
pub fn clear_download_directory(download_dir: &Path) -> Result<usize, String> {
    let resolved = absolute(download_dir);
    let is_root = resolved.parent().is_none();
    let home = home_dir();
    // The home folder, and any folder that contains it (e.g. C:\Users), must never be wiped.
    let contains_home = !home.as_os_str().is_empty() && segments_below(&resolved, &home).is_some();
    if is_root || contains_home {
        return Err("Refusing to clear a filesystem or home-directory root. Choose a dedicated download folder.".into());
    }
    if !resolved.exists() {
        fs::create_dir_all(&resolved).map_err(|e| e.to_string())?;
        return Ok(0);
    }
    let entries = fs::read_dir(&resolved).map_err(|e| format!("Could not read the download directory: {e}"))?;
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let result = if is_dir { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        result.map_err(|e| format!("Could not remove \"{}\": {e}", entry.file_name().to_string_lossy()))?;
        removed += 1;
    }
    Ok(removed)
}

// ---------------------------------------------------------------------------
// Tests (ported from the jest suites)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn keeps_a_supported_extension() {
        let r = normalize_supported_filename("Lecture Notes.pdf", Some("application/pdf"));
        assert!(r.accepted);
        assert_eq!(r.name, "Lecture Notes.pdf");
        assert_eq!(r.extension.as_deref(), Some("pdf"));
    }

    #[test]
    fn appends_the_extension_from_mime() {
        let r = normalize_supported_filename("download", Some("application/pdf"));
        assert_eq!((r.accepted, r.name.as_str()), (true, "download.pdf"));
    }

    #[test]
    fn replaces_blackboard_style_extensions_using_mime() {
        assert_eq!(normalize_supported_filename("download.aspx", Some("application/pdf")).name, "download.pdf");
        let pptx = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
        let r = normalize_supported_filename("resource.do", Some(pptx));
        assert_eq!((r.name.as_str(), r.extension.as_deref()), ("resource.pptx", Some("pptx")));
        assert_eq!(supported_extension_from_mime(Some(pptx)), Some("pptx"));
    }

    #[test]
    fn rejects_blocked_and_unknown_types() {
        let zip = normalize_supported_filename("archive.zip", Some("application/pdf"));
        assert_eq!((zip.accepted, zip.reason), (false, Some(Rejection::UnsupportedExtension)));
        let png = normalize_supported_filename("image.png", Some("application/pdf"));
        assert_eq!(png.reason, Some(Rejection::UnsupportedExtension));
        let unknown = normalize_supported_filename("unknown.weird", Some("application/x-unknown"));
        assert_eq!((unknown.accepted, unknown.reason), (false, Some(Rejection::UnknownType)));
        assert!(has_supported_extension("x.docx"));
        assert!(!has_supported_extension("x.txt"));
    }

    #[test]
    fn accepts_every_allowed_extension_and_rejects_blocked_ones() {
        for ext in SUPPORTED_FILE_TYPES {
            assert!(is_allowed_document_candidate(Some(&format!("lesson.{ext}")), None, None), "{ext}");
            assert_eq!(allowed_ext_from_name(&format!("lesson.{ext}")).as_deref(), Some(ext));
        }
        for ext in ["zip", "rar", "7z", "png", "jpg", "mp4", "mp3", "txt", "csv", "json", "xml"] {
            assert!(!is_allowed_document_candidate(Some(&format!("blocked.{ext}")), None, None), "{ext}");
        }
    }

    #[test]
    fn uses_the_mime_allowlist() {
        assert!(is_allowed_mime(Some("application/pdf")));
        let url = "https://example.com/webapps/blackboard/execute/content/file?cmd=view";
        let docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        assert!(is_allowed_document_candidate(None, Some(url), Some(docx)));
        // An execute/content link needs a file name or MIME as proof.
        let link = "https://example.com/webapps/blackboard/execute/content/file?cmd=view&content_id=_1_1";
        assert!(!is_allowed_document_candidate(None, Some(link), None));
        assert!(is_allowed_document_candidate(Some("Week2.docx"), Some(link), None));
        for mime in ["video/mp4", "application/zip", "image/png", "text/csv", "application/json"] {
            assert!(!is_allowed_document_candidate(None, None, Some(mime)), "{mime}");
        }
    }

    #[test]
    fn parses_content_disposition() {
        assert_eq!(parse_content_disposition(r#"attachment; filename="Lecture Notes.pdf""#).as_deref(), Some("Lecture Notes.pdf"));
        assert_eq!(parse_content_disposition(r#"attachment; filename="a.pdf"; size="5""#).as_deref(), Some("a.pdf"));
        assert_eq!(parse_content_disposition(r#"attachment; filename="report (final).docx""#).as_deref(), Some("report (final).docx"));
        assert_eq!(parse_content_disposition("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf; foo=bar").as_deref(), Some("résumé.pdf"));
        assert_eq!(parse_content_disposition("attachment; filename*=UTF-8''plain.txt").as_deref(), Some("plain.txt"));
        assert_eq!(parse_content_disposition("attachment; filename=notes.txt; size=3").as_deref(), Some("notes.txt"));
        assert_eq!(parse_content_disposition(""), None);
        assert_eq!(parse_content_disposition("inline"), None);
    }

    #[test]
    fn sanitizes_filenames() {
        assert_eq!(sanitize_filename("Lecture: Notes?.pdf"), "Lecture -  Notes.pdf");
        assert_eq!(sanitize_filename("con.pdf"), "file");
        assert_eq!(sanitize_filename("trailing dots..."), "trailing dots");
        assert_eq!(sanitize_filename(""), "file");
        assert_eq!(sanitize_filename("ＡＢＣ.pdf"), "ABC.pdf");
        let long = format!("{}.pdf", "a".repeat(300));
        let cleaned = sanitize_filename(&long);
        assert_eq!(cleaned.chars().count(), 200);
        assert!(cleaned.ends_with(".pdf"));
    }

    #[test]
    fn reservations_are_released_and_numbered() {
        let dir = tempdir().unwrap();
        let first = unique_file_path(dir.path(), "report.pdf");
        release_reserved_path(&first);
        let again = unique_file_path(dir.path(), "report.pdf");
        assert_eq!(again, first);
        let second = unique_file_path(dir.path(), "report.pdf");
        assert_eq!(second, dir.path().join("report (1).pdf"));
        release_reserved_path(&again);
        release_reserved_path(&second);
    }

    #[test]
    fn keeps_the_hierarchy_path_and_collapses_a_flat_one() {
        let root = tempdir().unwrap();
        let save = root.path().join("Course A").join("Week 1").join("Slides");
        assert_eq!(resolve_save_path_for_layout(root.path(), &save, DownloadLayout::Hierarchy), save);
        assert_eq!(resolve_save_path_for_layout(root.path(), &save, DownloadLayout::Flat), absolute(&root.path().join("Course A")));
        let course = root.path().join("Course A");
        assert_eq!(resolve_save_path_for_layout(root.path(), &course, DownloadLayout::Flat), course);
    }

    #[test]
    fn never_moves_files_outside_the_download_directory() {
        let root = tempdir().unwrap();
        let outside = if cfg!(windows) { PathBuf::from("C:\\elsewhere\\Course A\\Week 1") } else { PathBuf::from("/elsewhere/Course A/Week 1") };
        assert_eq!(resolve_save_path_for_layout(root.path(), &outside, DownloadLayout::Flat), outside);
        assert_eq!(course_folder_for_save_path(root.path(), &outside), None);
        let save = root.path().join("Course A").join("Week 1");
        assert_eq!(course_folder_for_save_path(root.path(), &save), Some(absolute(&root.path().join("Course A"))));
    }

    #[test]
    fn qualifies_a_taken_flat_name_with_the_section() {
        let dir = tempdir().unwrap();
        let taken = |p: &Path| p.exists();
        assert_eq!(preferred_flat_filename(dir.path(), "Lecture.pdf", Some("Week 1"), &taken), "Lecture.pdf");
        fs::write(dir.path().join("Lecture.pdf"), "week 1").unwrap();
        assert_eq!(preferred_flat_filename(dir.path(), "Lecture.pdf", Some("Week 2"), &taken), "Lecture (Week 2).pdf");
        assert_eq!(preferred_flat_filename(dir.path(), "Lecture.pdf", None, &taken), "Lecture.pdf");
    }

    #[test]
    fn prunes_only_empty_folders() {
        let root = tempdir().unwrap();
        let course = root.path().join("Course A");
        fs::create_dir_all(course.join("Week 1").join("Slides")).unwrap();
        fs::create_dir_all(course.join("Week 2")).unwrap();
        fs::write(course.join("Week 1").join("Slides").join("Lecture.pdf"), "nested").unwrap();
        fs::write(course.join("flat.pdf"), "flat").unwrap();
        assert_eq!(prune_empty_directories(&course), 1);
        assert!(!course.join("Week 2").exists());
        assert!(course.join("Week 1").join("Slides").join("Lecture.pdf").exists());
        assert!(course.join("flat.pdf").exists());
    }

    #[test]
    fn indexes_files_and_recognises_sanitized_names() {
        let root = tempdir().unwrap();
        let save = root.path().join("Course A");
        fs::create_dir_all(&save).unwrap();
        fs::write(save.join("Lecture -  Notes.pdf"), "existing").unwrap();
        let index = scan_download_directory(root.path());
        assert!(is_download_present(&index, &save, "Lecture: Notes?.pdf"));
        assert!(!is_download_present(&index, &save, "Other.pdf"));
    }

    #[test]
    fn clears_contents_but_keeps_the_directory() {
        let root = tempdir().unwrap();
        let nested = root.path().join("Course A").join("Week 1");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("Lecture.pdf"), "content").unwrap();
        fs::write(root.path().join(".partial"), "partial").unwrap();
        assert_eq!(clear_download_directory(root.path()).unwrap(), 2);
        assert!(root.path().exists());
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 0);
    }

    #[test]
    fn refuses_roots_the_home_folder_and_its_parents() {
        let root = if cfg!(windows) { PathBuf::from("C:\\") } else { PathBuf::from("/") };
        assert!(clear_download_directory(&root).unwrap_err().contains("Refusing to clear"));
        let home = home_dir();
        if !home.as_os_str().is_empty() {
            assert!(clear_download_directory(&home).is_err());
            if let Some(parent) = home.parent().filter(|p| p.parent().is_some()) {
                assert!(clear_download_directory(parent).is_err());
            }
            if cfg!(windows) {
                assert!(clear_download_directory(Path::new(&home.to_string_lossy().to_uppercase())).is_err());
            }
        }
    }
}
