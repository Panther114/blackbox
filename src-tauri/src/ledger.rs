//! Download history. One small JSON file replaces the old SQLite database and
//! file-tree cache: it records where each URL was saved so repeat downloads
//! (including the flat layout) can be skipped. It also reads the Electron
//! build's `blackbox.json` and `file_tree.json`, so existing history carries over.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::files::normalize_download_path;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Record {
    pub url: String,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub filename: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, rename = "downloadedAt", skip_serializing_if = "Option::is_none")]
    pub downloaded_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Every place a completed copy of this URL was saved.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct LedgerFile {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    records: Vec<Record>,
}

pub struct Ledger {
    file: PathBuf,
    records: HashMap<String, Record>,
    /// Paths recorded by earlier versions' file-tree cache (read-only).
    tree_paths: HashMap<String, Vec<String>>,
    dirty: bool,
}

/// Collect `url -> localPath` pairs from the old file-tree cache.
fn read_tree_paths(file: &Path) -> HashMap<String, Vec<String>> {
    let mut out: HashMap<String, Vec<String>> = HashMap::new();
    let Some(tree) = fs::read_to_string(file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { return out };
    let Some(courses) = tree.get("courses").and_then(Value::as_object) else { return out };
    for course in courses.values() {
        for section in course.get("sections").and_then(Value::as_object).into_iter().flat_map(|m| m.values()) {
            for folder in section.get("folders").and_then(Value::as_object).into_iter().flat_map(|m| m.values()) {
                for entry in folder.get("files").and_then(Value::as_object).into_iter().flat_map(|m| m.values()) {
                    let url = entry.get("url").and_then(Value::as_str).unwrap_or("");
                    let local = entry.get("localPath").and_then(Value::as_str).unwrap_or("");
                    if !url.is_empty() && !local.is_empty() {
                        out.entry(url.to_string()).or_default().push(local.to_string());
                    }
                }
            }
        }
    }
    out
}

impl Ledger {
    /// `data_dir` holds `blackbox.json` (this ledger) and, if present, the old `file_tree.json`.
    pub fn open(data_dir: &Path) -> Self {
        let file = data_dir.join("blackbox.json");
        let mut records = HashMap::new();
        if let Some(parsed) = fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<LedgerFile>(&t).ok()) {
            for mut record in parsed.records {
                // A record still pending belongs to a run that was interrupted.
                if record.status == "pending" {
                    record.status = "failed".into();
                    record.error = Some("Interrupted (pending at startup)".into());
                }
                records.insert(record.url.clone(), record);
            }
        }
        Self { file, records, tree_paths: read_tree_paths(&data_dir.join("file_tree.json")), dirty: false }
    }

    pub fn get(&self, url: &str) -> Option<&Record> {
        self.records.get(url)
    }

    /// A completed copy of `url` that sits directly in `directory` and still exists on disk.
    pub fn saved_copy_in_directory(&self, url: &str, directory: &Path) -> Option<PathBuf> {
        let target = normalize_download_path(directory);
        let mut candidates: Vec<&str> = Vec::new();
        if let Some(record) = self.records.get(url) {
            if record.status == "completed" && !record.path.is_empty() {
                candidates.push(&record.path);
            }
            candidates.extend(record.paths.iter().map(String::as_str));
        }
        candidates.extend(self.tree_paths.get(url).into_iter().flatten().map(String::as_str));
        candidates
            .into_iter()
            .map(PathBuf::from)
            .find(|candidate| candidate.parent().is_some_and(|parent| normalize_download_path(parent) == target) && candidate.exists())
    }

    pub fn record_completed(&mut self, url: &str, path: &Path, filename: &str, size: u64) {
        let saved = path.to_string_lossy().into_owned();
        let record = self.records.entry(url.to_string()).or_insert_with(|| Record { url: url.to_string(), ..Default::default() });
        record.path = saved.clone();
        record.filename = filename.to_string();
        record.status = "completed".into();
        record.size = Some(size);
        record.downloaded_at = Some(crate::timeutil::iso_now());
        record.error = None;
        if !record.paths.contains(&saved) {
            record.paths.push(saved);
        }
        self.dirty = true;
    }

    pub fn record_failed(&mut self, url: &str, path: &Path, filename: &str, error: &str) {
        let record = self.records.entry(url.to_string()).or_insert_with(|| Record { url: url.to_string(), ..Default::default() });
        // A failure never erases the memory of an earlier successful copy.
        if record.status != "completed" {
            record.path = path.to_string_lossy().into_owned();
            record.filename = filename.to_string();
            record.status = "failed".into();
            record.error = Some(error.to_string());
            self.dirty = true;
        }
    }

    pub fn clear(&mut self) {
        self.records.clear();
        self.tree_paths.clear();
        self.dirty = true;
        let _ = self.save();
        let data_dir = self.file.parent().map(Path::to_path_buf).unwrap_or_default();
        let _ = fs::remove_file(data_dir.join("file_tree.json"));
    }

    /// Write the ledger atomically (temp file, then rename). A no-op when nothing changed.
    pub fn save(&mut self) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let body = LedgerFile { version: 1, records: self.records.values().cloned().collect() };
        let temp = self.file.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec(&body).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        fs::rename(&temp, &self.file).map_err(|e| e.to_string())?;
        self.dirty = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn remembers_where_a_url_was_saved_and_forgets_deleted_files() {
        let dir = tempdir().unwrap();
        let course = dir.path().join("downloads").join("Course A");
        fs::create_dir_all(&course).unwrap();
        let file = course.join("Lecture.pdf");
        fs::write(&file, "x").unwrap();

        let mut ledger = Ledger::open(dir.path());
        ledger.record_completed("https://bb/f/1", &file, "Lecture.pdf", 1);
        ledger.save().unwrap();

        let reopened = Ledger::open(dir.path());
        assert_eq!(reopened.saved_copy_in_directory("https://bb/f/1", &course), Some(file.clone()));
        assert_eq!(reopened.saved_copy_in_directory("https://bb/f/1", &dir.path().join("elsewhere")), None);
        fs::remove_file(&file).unwrap();
        assert_eq!(reopened.saved_copy_in_directory("https://bb/f/1", &course), None);
    }

    #[test]
    fn a_failure_does_not_erase_an_earlier_success_and_pending_becomes_failed() {
        let dir = tempdir().unwrap();
        let mut ledger = Ledger::open(dir.path());
        ledger.record_completed("u", Path::new("C:/a.pdf"), "a.pdf", 5);
        ledger.record_failed("u", Path::new("C:/a.pdf"), "a.pdf", "boom");
        assert_eq!(ledger.get("u").unwrap().status, "completed");
        fs::write(dir.path().join("blackbox.json"), r#"{"version":1,"records":[{"url":"p","status":"pending"}]}"#).unwrap();
        let reopened = Ledger::open(dir.path());
        assert_eq!(reopened.get("p").unwrap().status, "failed");
    }

    #[test]
    fn reads_paths_from_the_old_file_tree_cache() {
        let dir = tempdir().unwrap();
        let course = dir.path().join("Course A");
        fs::create_dir_all(&course).unwrap();
        let file = course.join("Old.pdf");
        fs::write(&file, "x").unwrap();
        let tree = serde_json::json!({ "version": 1, "courses": { "Course A": { "sections": { "W1": { "folders": { "f": { "files": {
            "Old.pdf": { "url": "https://bb/f/old", "localPath": file.to_string_lossy() } } } } } } } } });
        fs::write(dir.path().join("file_tree.json"), tree.to_string()).unwrap();
        let ledger = Ledger::open(dir.path());
        assert_eq!(ledger.saved_copy_in_directory("https://bb/f/old", &course), Some(file));
    }
}
