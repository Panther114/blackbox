//! File transfer: metadata (HEAD), the per-layout "already saved" check and the
//! downloader itself (concurrency, retries, stall watchdog, cancel, atomic
//! writes). Port of src/downloader/index.ts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio_util::sync::CancellationToken;

use crate::files::{
    allowed_ext_from_name, course_folder_for_save_path, extension_of, extract_filename_from_url, has_blocked_extension, is_allowed_document_candidate, is_blocked_mime,
    is_download_present, is_path_reserved, normalize_supported_filename, parse_content_disposition, preferred_flat_filename, release_reserved_path,
    resolve_save_path_for_layout, sanitize_filename, scan_download_directory, tmp_file_path, unique_file_path, DownloadLayout,
};
use crate::ledger::Ledger;
use crate::model::{DiscoveredFile, ExistingFileState};
use crate::transfer::{Kind, TransferTracker};

type Tracker = Arc<Mutex<TransferTracker>>;

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

const STALL_TIMEOUT: Duration = Duration::from_secs(30);
const HEAD_TIMEOUT: Duration = Duration::from_secs(5);
const PROGRESS_THROTTLE: Duration = Duration::from_millis(120);
const MAX_METADATA_CONCURRENCY: usize = 12;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Outcome {
    Completed,
    Skipped,
    Rejected,
    Failed,
    Cancelled,
}

#[derive(Debug)]
enum DownloadError {
    Cancelled,
    Http(u16),
    Other(String),
}

impl std::fmt::Display for DownloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "cancelled by user"),
            Self::Http(status) => write!(f, "HTTP {status}"),
            Self::Other(message) => write!(f, "{message}"),
        }
    }
}

/// Permanent HTTP failures (4xx other than 429) and a full disk must fail fast instead of retrying.
fn is_retryable(error: &DownloadError) -> bool {
    match error {
        DownloadError::Cancelled => false,
        DownloadError::Http(status) => *status >= 500 || *status == 429,
        DownloadError::Other(message) => !(message.contains("ENOSPC") || message.to_lowercase().contains("not enough space")),
    }
}

fn io_error(error: std::io::Error) -> DownloadError {
    // 112 = ERROR_DISK_FULL on Windows, 28 = ENOSPC elsewhere.
    if matches!(error.raw_os_error(), Some(112) | Some(28)) {
        DownloadError::Other(format!("ENOSPC: {error}"))
    } else {
        DownloadError::Other(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileResult {
    pub url: String,
    pub name: String,
    pub outcome: Outcome,
    pub error: Option<String>,
}

pub struct Downloader {
    pub client: reqwest::Client,
    pub ledger: Arc<Mutex<Ledger>>,
    pub download_dir: PathBuf,
    pub emit: Emit,
    pub cancel: CancellationToken,
    pub max_concurrent: usize,
    pub retries: u32,
    pub retry_delay: Duration,
}

fn mime_of(response: &reqwest::Response) -> Option<String> {
    let value = response.headers().get(reqwest::header::CONTENT_TYPE)?.to_str().ok()?;
    let mime = value.split(';').next()?.trim().to_lowercase();
    if mime.is_empty() {
        None
    } else {
        Some(mime)
    }
}

fn header_text(response: &reqwest::Response, name: reqwest::header::HeaderName) -> Option<String> {
    response.headers().get(name)?.to_str().ok().map(str::to_string)
}

impl Downloader {
    pub fn new(client: reqwest::Client, ledger: Arc<Mutex<Ledger>>, download_dir: PathBuf, emit: Emit, cancel: CancellationToken) -> Self {
        Self { client, ledger, download_dir, emit, cancel, max_concurrent: 5, retries: 3, retry_delay: Duration::from_secs(2) }
    }

    // -- Metadata ------------------------------------------------------------

    /// HEAD every file for its size, MIME type and real file name. Media and non-documents are dropped.
    pub async fn fetch_metadata(&self, files: Vec<DiscoveredFile>) -> Vec<DiscoveredFile> {
        let total = files.len();
        (self.emit)("files:metadata:progress", json!({ "phase": "metadata", "completed": 0, "total": total, "currentFile": "" }));
        let concurrency = self.max_concurrent.max(4).min(MAX_METADATA_CONCURRENCY);
        let completed = Arc::new(Mutex::new((0usize, Instant::now() - PROGRESS_THROTTLE)));

        let mut results: Vec<(usize, Option<DiscoveredFile>)> = stream::iter(files.into_iter().enumerate())
            .map(|(index, file)| {
                let completed = completed.clone();
                async move {
                    let result = self.describe(&file).await;
                    let (done, due) = {
                        let mut guard = completed.lock().unwrap();
                        guard.0 += 1;
                        let due = guard.1.elapsed() >= PROGRESS_THROTTLE || guard.0 == total;
                        if due {
                            guard.1 = Instant::now();
                        }
                        (guard.0, due)
                    };
                    if due {
                        (self.emit)("files:metadata:progress", json!({ "phase": "metadata", "completed": done, "total": total, "currentFile": "" }));
                    }
                    (index, result)
                }
            })
            .buffer_unordered(concurrency)
            .collect()
            .await;
        results.sort_by_key(|(index, _)| *index);
        let accepted: Vec<DiscoveredFile> = results.into_iter().filter_map(|(_, file)| file).collect();
        (self.emit)("files:metadata:complete", json!({ "phase": "metadata", "completed": total, "total": total, "accepted": accepted.len() }));
        accepted
    }

    async fn describe(&self, file: &DiscoveredFile) -> Option<DiscoveredFile> {
        let Ok(response) = self.client.head(&file.url).timeout(HEAD_TIMEOUT).send().await else { return Some(file.clone()) };
        let size = response.headers().get(reqwest::header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).filter(|n| *n > 0);
        let mime = mime_of(&response);
        if is_blocked_mime(mime.as_deref()) {
            return None;
        }
        let mut name = file.name.clone();
        if let Some(parsed) = header_text(&response, reqwest::header::CONTENT_DISPOSITION).and_then(|h| parse_content_disposition(&h)) {
            name = parsed;
        }
        let normalized = normalize_supported_filename(&name, mime.as_deref());
        name = normalized.name.clone();
        if has_blocked_extension(&name) || has_blocked_extension(&file.url) {
            return None;
        }
        if !normalized.accepted || !is_allowed_document_candidate(Some(&name), Some(&file.url), mime.as_deref()) {
            return None;
        }
        let file_type = normalized.extension.or_else(|| allowed_ext_from_name(&file.name)).or_else(|| extension_of(&file.name)).map(|e| e.to_uppercase());
        Some(DiscoveredFile { name, size, mime_type: mime, file_type, ..file.clone() })
    }

    // -- What is already on disk ----------------------------------------------

    fn flat_taken(path: &Path) -> bool {
        path.exists() || is_path_reserved(path)
    }

    fn has_saved_copy(&self, indexed: &HashSet<String>, file: &DiscoveredFile, layout: DownloadLayout) -> bool {
        let save_path = Path::new(&file.save_path);
        let ledger = self.ledger.lock().unwrap();
        if layout == DownloadLayout::Flat {
            let course_folder = course_folder_for_save_path(&self.download_dir, save_path).unwrap_or_else(|| save_path.to_path_buf());
            if ledger.saved_copy_in_directory(&file.url, &course_folder).is_some() {
                return true;
            }
            let qualified = preferred_flat_filename(&course_folder, &file.name, Some(&file.section_name), &Self::flat_taken);
            return is_download_present(indexed, &course_folder, &file.name) || (qualified != file.name && is_download_present(indexed, &course_folder, &qualified));
        }
        is_download_present(indexed, save_path, &file.name) || ledger.saved_copy_in_directory(&file.url, save_path).is_some()
    }

    /// For each file, which layouts already hold a copy. The two layouts are tracked separately.
    pub fn inspect_existing(&self, files: &[DiscoveredFile]) -> HashMap<String, ExistingFileState> {
        let indexed = scan_download_directory(&self.download_dir);
        files
            .iter()
            .map(|file| {
                let size = self.ledger.lock().unwrap().get(&file.url).filter(|r| r.status == "completed").and_then(|r| r.size);
                let state = ExistingFileState {
                    hierarchy: self.has_saved_copy(&indexed, file, DownloadLayout::Hierarchy),
                    flat: self.has_saved_copy(&indexed, file, DownloadLayout::Flat),
                    size,
                };
                (file.url.clone(), state)
            })
            .collect()
    }

    // -- Download --------------------------------------------------------------

    /// Download everything with bounded concurrency. Cancelling drops the queue and aborts transfers in flight.
    pub async fn download_files(&self, files: Vec<DiscoveredFile>, layout: DownloadLayout) -> Vec<FileResult> {
        if files.is_empty() {
            return Vec::new();
        }
        let indexed = Arc::new(scan_download_directory(&self.download_dir));
        let tracker: Tracker = Arc::new(Mutex::new(TransferTracker::new(files.iter().map(|f| (f.url.clone(), f.name.clone(), f.size)))));
        let publish = {
            let (tracker, emit) = (tracker.clone(), self.emit.clone());
            move || {
                let snapshot = tracker.lock().unwrap().snapshot(Instant::now());
                emit("transfer:progress", serde_json::to_value(snapshot).unwrap_or(Value::Null));
            }
        };
        let ticker = {
            let publish = publish.clone();
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_millis(200));
                loop {
                    interval.tick().await;
                    publish();
                }
            })
        };
        let results: Vec<FileResult> = stream::iter(files)
            .map(|file| {
                let (indexed, tracker) = (indexed.clone(), tracker.clone());
                async move {
                    let (outcome, error) = self.download_file(&file, layout, &indexed, &tracker).await;
                    let kind = match outcome {
                        Outcome::Completed => Kind::Completed,
                        Outcome::Skipped => Kind::Skipped,
                        Outcome::Rejected => Kind::Rejected,
                        Outcome::Failed => Kind::Failed,
                        Outcome::Cancelled => Kind::Cancelled,
                    };
                    tracker.lock().unwrap().settle(&file.url, kind);
                    FileResult { url: file.url.clone(), name: file.name.clone(), outcome, error }
                }
            })
            .buffer_unordered(self.max_concurrent.max(1))
            .collect()
            .await;
        ticker.abort();
        publish();
        let _ = self.ledger.lock().unwrap().save();
        results
    }

    async fn download_file(&self, file: &DiscoveredFile, layout: DownloadLayout, indexed: &HashSet<String>, tracker: &Tracker) -> (Outcome, Option<String>) {
        if self.cancel.is_cancelled() {
            return (Outcome::Cancelled, None);
        }
        let flat = layout == DownloadLayout::Flat;
        let target_dir = resolve_save_path_for_layout(&self.download_dir, Path::new(&file.save_path), layout);
        let saved_flat = if flat { self.ledger.lock().unwrap().saved_copy_in_directory(&file.url, &target_dir) } else { None };
        if saved_flat.is_some() || (!flat && is_download_present(indexed, &target_dir, &file.name)) {
            let name = saved_flat.and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| file.name.clone());
            (self.emit)("download:skip", json!({ "url": file.url, "filename": name }));
            return (Outcome::Skipped, None);
        }

        (self.emit)("download:start", json!({ "url": file.url, "name": file.name, "filename": file.name }));
        let mut resolved = file.name.clone();
        let mut attempt = 0u32;
        loop {
            tracker.lock().unwrap().attempt(&file.url);
            match self.attempt(file, &target_dir, flat, indexed, &mut resolved, tracker).await {
                Ok(outcome) => return (outcome, None),
                Err(DownloadError::Cancelled) => return (Outcome::Cancelled, None),
                Err(error) => {
                    if self.cancel.is_cancelled() {
                        return (Outcome::Cancelled, None);
                    }
                    if !is_retryable(&error) || attempt >= self.retries {
                        let message = error.to_string();
                        (self.emit)("download:error", json!({ "url": file.url, "filename": resolved, "error": message }));
                        self.ledger.lock().unwrap().record_failed(&file.url, &target_dir, &resolved, &message);
                        return (Outcome::Failed, Some(message));
                    }
                    let delay = self.retry_delay * 2u32.pow(attempt);
                    tokio::select! {
                        _ = tokio::time::sleep(delay) => {}
                        _ = self.cancel.cancelled() => return (Outcome::Cancelled, None),
                    }
                    attempt += 1;
                }
            }
        }
    }

    /// One attempt. Writes to a hidden `.tmp` file and renames it on success, so a partial file never looks complete.
    async fn attempt(&self, file: &DiscoveredFile, target_dir: &Path, flat: bool, indexed: &HashSet<String>, resolved: &mut String, tracker: &Tracker) -> Result<Outcome, DownloadError> {
        let response = tokio::select! {
            result = self.client.get(&file.url).send() => result.map_err(|e| DownloadError::Other(e.to_string()))?,
            _ = self.cancel.cancelled() => return Err(DownloadError::Cancelled),
        };
        if !response.status().is_success() {
            return Err(DownloadError::Http(response.status().as_u16()));
        }

        let mime = mime_of(&response);
        let mut filename = header_text(&response, reqwest::header::CONTENT_DISPOSITION)
            .and_then(|h| parse_content_disposition(&h))
            .unwrap_or_else(|| file.name.clone());
        if filename.is_empty() {
            filename = extract_filename_from_url(&file.url);
        }
        let normalized = normalize_supported_filename(&filename, mime.as_deref());
        filename = normalized.name.clone();
        let blocked = is_blocked_mime(mime.as_deref()) || has_blocked_extension(&filename) || has_blocked_extension(&file.url);
        if !normalized.accepted || blocked || !is_allowed_document_candidate(Some(&filename), Some(&file.url), mime.as_deref()) {
            (self.emit)("download:rejected", json!({ "url": file.url, "filename": filename, "reason": if normalized.accepted { "blocked-type" } else { "not-in-allowlist" } }));
            return Ok(Outcome::Rejected);
        }
        filename = sanitize_filename(&filename);
        *resolved = filename.clone();

        // The server-side name can differ from the label found during discovery.
        if !flat && is_download_present(indexed, target_dir, &filename) {
            (self.emit)("download:skip", json!({ "url": file.url, "filename": filename }));
            return Ok(Outcome::Skipped);
        }

        tokio::fs::create_dir_all(target_dir).await.map_err(io_error)?;
        let target_name = if flat { preferred_flat_filename(target_dir, &filename, Some(&file.section_name), &Self::flat_taken) } else { filename.clone() };
        let final_path = unique_file_path(target_dir, &target_name);
        *resolved = target_name;
        let tmp_path = tmp_file_path(&final_path);

        let outcome = self.write_body(response, &tmp_path, file, resolved, tracker).await;
        match outcome {
            Ok(size) => {
                let renamed = tokio::fs::rename(&tmp_path, &final_path).await.map_err(io_error);
                release_reserved_path(&final_path);
                renamed?;
                self.ledger.lock().unwrap().record_completed(&file.url, &final_path, resolved, size);
                (self.emit)("download:complete", json!({ "url": file.url, "filename": resolved, "size": size }));
                Ok(Outcome::Completed)
            }
            Err(error) => {
                let _ = tokio::fs::remove_file(&tmp_path).await;
                release_reserved_path(&final_path);
                Err(error)
            }
        }
    }

    async fn write_body(&self, response: reqwest::Response, tmp_path: &Path, file: &DiscoveredFile, name: &str, tracker: &Tracker) -> Result<u64, DownloadError> {
        let total = response.content_length().unwrap_or(0);
        let mut stream = response.bytes_stream();
        let mut out = tokio::fs::File::create(tmp_path).await.map_err(io_error)?;
        let mut downloaded = 0u64;
        let mut last_emit = Instant::now() - PROGRESS_THROTTLE;
        loop {
            let chunk = tokio::select! {
                next = tokio::time::timeout(STALL_TIMEOUT, stream.next()) => match next {
                    Ok(chunk) => chunk,
                    Err(_) => return Err(DownloadError::Other(format!("Download stalled: no data received for {}s", STALL_TIMEOUT.as_secs()))),
                },
                _ = self.cancel.cancelled() => return Err(DownloadError::Cancelled),
            };
            let Some(chunk) = chunk else { break };
            let bytes = chunk.map_err(|e| DownloadError::Other(e.to_string()))?;
            out.write_all(&bytes).await.map_err(io_error)?;
            downloaded += bytes.len() as u64;
            tracker.lock().unwrap().progress(&file.url, downloaded, Instant::now());
            if last_emit.elapsed() >= PROGRESS_THROTTLE {
                last_emit = Instant::now();
                (self.emit)("download:progress", json!({ "url": file.url, "filename": name, "downloaded": downloaded, "total": total }));
            }
        }
        out.flush().await.map_err(io_error)?;
        drop(out);
        (self.emit)("download:progress", json!({ "url": file.url, "filename": name, "downloaded": downloaded, "total": total }));
        // A connection that closes cleanly mid-body still ends the stream: verify the byte count.
        if total > 0 && downloaded != total {
            return Err(DownloadError::Other(format!("Download truncated: received {downloaded} of {total} bytes for {name}")));
        }
        Ok(downloaded)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blackboard::{mock, BbClient, LoginOutcome};
    use tempfile::{tempdir, TempDir};

    struct Fixture {
        _server: mock::Server,
        _data: TempDir,
        downloads: TempDir,
        base: String,
        client: BbClient,
        events: Arc<Mutex<Vec<String>>>,
    }

    async fn fixture() -> Fixture {
        let server = mock::start("G1", "pw");
        let client = BbClient::new(&server.base).unwrap();
        assert!(matches!(client.login("G1", "pw").await, LoginOutcome::LoggedIn(_)));
        Fixture { base: server.base.clone(), _server: server, _data: tempdir().unwrap(), downloads: tempdir().unwrap(), client, events: Arc::new(Mutex::new(Vec::new())) }
    }

    impl Fixture {
        fn downloader(&self, cancel: CancellationToken) -> Downloader {
            let events = self.events.clone();
            let emit: Emit = Arc::new(move |name, _| events.lock().unwrap().push(name.to_string()));
            let ledger = Arc::new(Mutex::new(Ledger::open(self._data.path())));
            let mut d = Downloader::new(self.client.http().clone(), ledger, self.downloads.path().to_path_buf(), emit, cancel);
            d.retry_delay = Duration::from_millis(5);
            d.retries = 1;
            d
        }

        fn file(&self, route: &str, section: &str, name: &str) -> DiscoveredFile {
            DiscoveredFile {
                name: name.into(),
                url: format!("{}{route}", self.base),
                course_name: "Math".into(),
                section_name: section.into(),
                save_path: self.downloads.path().join("Math").join(section).to_string_lossy().into_owned(),
                size: None,
                mime_type: None,
                file_type: None,
                status: "pending".into(),
            }
        }

        fn course_files(&self) -> Vec<String> {
            let mut names: Vec<String> = std::fs::read_dir(self.downloads.path().join("Math")).unwrap().flatten().filter(|e| e.path().is_file()).map(|e| e.file_name().to_string_lossy().into_owned()).collect();
            names.sort();
            names
        }
    }

    fn outcomes(results: &[FileResult]) -> Vec<Outcome> {
        results.iter().map(|r| r.outcome).collect()
    }

    #[tokio::test]
    async fn reads_metadata_and_filters_non_documents() {
        let f = fixture().await;
        let files = vec![f.file("/bbcswebdav/xid-1_1", "Week 1", "Lecture"), f.file("/missing/zip", "Week 1", "archive.zip")];
        let described = f.downloader(CancellationToken::new()).fetch_metadata(files).await;
        assert_eq!(described.len(), 1);
        assert_eq!(described[0].name, "Lecture.pdf");
        assert_eq!(described[0].file_type.as_deref(), Some("PDF"));
        assert_eq!(described[0].size, Some(12));
    }

    #[tokio::test]
    async fn flat_keeps_every_section_file_and_is_idempotent() {
        let f = fixture().await;
        let files = vec![f.file("/dup/1", "Week 1", "Lecture.pdf"), f.file("/dup/2", "Week 2", "Lecture.pdf")];
        let first = f.downloader(CancellationToken::new()).download_files(files.clone(), DownloadLayout::Flat).await;
        assert_eq!(outcomes(&first), vec![Outcome::Completed, Outcome::Completed]);
        let names = f.course_files();
        assert_eq!(names.len(), 2);
        assert!(names.contains(&"Lecture.pdf".to_string()));
        let mut bodies: Vec<String> = names.iter().map(|n| std::fs::read_to_string(f.downloads.path().join("Math").join(n)).unwrap()).collect();
        bodies.sort();
        assert_eq!(bodies, vec!["week-1", "week-2"]);
        // A second flat run (a new session, so a fresh ledger load) saves nothing new.
        let again = f.downloader(CancellationToken::new()).download_files(files, DownloadLayout::Flat).await;
        assert_eq!(outcomes(&again), vec![Outcome::Skipped, Outcome::Skipped]);
        assert_eq!(f.course_files(), names);
    }

    #[tokio::test]
    async fn folder_structure_and_flat_runs_share_a_course_folder() {
        let f = fixture().await;
        let files = vec![f.file("/dup/1", "Week 1", "Lecture.pdf"), f.file("/dup/2", "Week 2", "Lecture.pdf")];
        f.downloader(CancellationToken::new()).download_files(files.clone(), DownloadLayout::Hierarchy).await;
        assert_eq!(std::fs::read_to_string(f.downloads.path().join("Math/Week 1/Lecture.pdf")).unwrap(), "week-1");
        assert_eq!(std::fs::read_to_string(f.downloads.path().join("Math/Week 2/Lecture.pdf")).unwrap(), "week-2");

        let flat = f.downloader(CancellationToken::new()).download_files(files.clone(), DownloadLayout::Flat).await;
        assert_eq!(outcomes(&flat), vec![Outcome::Completed, Outcome::Completed]);
        let flat_names = f.course_files();
        assert_eq!(flat_names.len(), 2);

        let hierarchy_again = f.downloader(CancellationToken::new()).download_files(files.clone(), DownloadLayout::Hierarchy).await;
        assert_eq!(outcomes(&hierarchy_again), vec![Outcome::Skipped, Outcome::Skipped]);
        let flat_again = f.downloader(CancellationToken::new()).download_files(files, DownloadLayout::Flat).await;
        assert_eq!(outcomes(&flat_again), vec![Outcome::Skipped, Outcome::Skipped]);
        assert_eq!(f.course_files(), flat_names);
    }

    #[tokio::test]
    async fn reports_which_layouts_already_hold_a_file() {
        let f = fixture().await;
        let file = f.file("/dup/1", "Week 1", "Lecture.pdf");
        let downloader = f.downloader(CancellationToken::new());
        assert_eq!(downloader.inspect_existing(&[file.clone()])[&file.url], ExistingFileState { hierarchy: false, flat: false, size: None });
        downloader.download_files(vec![file.clone()], DownloadLayout::Hierarchy).await;
        let state = f.downloader(CancellationToken::new()).inspect_existing(&[file.clone()]);
        assert!(state[&file.url].hierarchy && !state[&file.url].flat);
        assert_eq!(state[&file.url].size, Some(6));
        std::fs::remove_file(f.downloads.path().join("Math/Week 1/Lecture.pdf")).unwrap();
        assert!(!f.downloader(CancellationToken::new()).inspect_existing(&[file.clone()])[&file.url].hierarchy);
    }

    #[tokio::test]
    async fn cancelling_stops_the_queue_and_leaves_no_partial_files() {
        let f = fixture().await;
        let cancel = CancellationToken::new();
        cancel.cancel();
        let results = f.downloader(cancel).download_files(vec![f.file("/dup/1", "Week 1", "Lecture.pdf")], DownloadLayout::Hierarchy).await;
        assert_eq!(outcomes(&results), vec![Outcome::Cancelled]);
        assert!(!f.downloads.path().join("Math").exists());
    }

    #[tokio::test]
    async fn permanent_http_errors_fail_fast_and_are_reported_once() {
        let f = fixture().await;
        let results = f.downloader(CancellationToken::new()).download_files(vec![f.file("/nope/missing.pdf", "Week 1", "missing.pdf")], DownloadLayout::Hierarchy).await;
        assert_eq!(outcomes(&results), vec![Outcome::Failed]);
        assert_eq!(results[0].error.as_deref(), Some("HTTP 404"));
        assert_eq!(f.events.lock().unwrap().iter().filter(|e| *e == "download:error").count(), 1);
    }

    #[test]
    fn classifies_retryable_errors() {
        assert!(is_retryable(&DownloadError::Http(503)));
        assert!(is_retryable(&DownloadError::Http(429)));
        assert!(!is_retryable(&DownloadError::Http(404)));
        assert!(!is_retryable(&DownloadError::Cancelled));
        assert!(!is_retryable(&DownloadError::Other("ENOSPC: disk full".into())));
        assert!(is_retryable(&DownloadError::Other("connection reset".into())));
    }
}
