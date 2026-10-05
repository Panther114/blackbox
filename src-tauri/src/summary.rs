//! Run summary files: `latest-summary.txt` (logs folder) and
//! `blackbox-run-report.json` (download folder).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailedFile {
    pub name: String,
    pub reason: String,
}

/// The run totals shown on the summary screen.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub courses_discovered: usize,
    pub courses_selected: usize,
    pub files_discovered: usize,
    pub files_selected: usize,
    pub files_downloaded: usize,
    pub files_skipped: usize,
    pub already_saved: usize,
    pub files_rejected: usize,
    pub files_failed: usize,
    pub failed_files: Vec<FailedFile>,
    pub instruction_courses_selected: usize,
    pub instructions_discovered: usize,
    pub instructions_downloaded: usize,
    pub instruction_warnings: Vec<String>,
    pub cancelled: bool,
    pub download_dir: String,
    pub duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report<'a> {
    started_at: &'a str,
    ended_at: &'a str,
    courses_discovered: usize,
    courses_selected: usize,
    files_discovered: usize,
    files_selected: usize,
    files_downloaded: usize,
    files_skipped: usize,
    files_already_saved: usize,
    files_rejected: usize,
    files_failed: usize,
    failed_files: &'a [FailedFile],
    instruction_courses_selected: usize,
    instructions_discovered: usize,
    instructions_downloaded: usize,
    instruction_warnings: &'a [String],
    log_file_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_error: Option<&'a str>,
}

fn absolute(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Write both summary files. `summary_file` is the text summary path.
pub fn write_run_summary(
    summary: &Summary,
    started_at: &str,
    ended_at: &str,
    log_file: &Path,
    summary_file: &Path,
    download_dir: &Path,
    run_error: Option<&str>,
) -> Result<(), String> {
    let mut lines = vec![
        format!("startedAt: {started_at}"),
        format!("endedAt: {ended_at}"),
        format!("courses discovered: {}", summary.courses_discovered),
        format!("courses selected: {}", summary.courses_selected),
        format!("files discovered: {}", summary.files_discovered),
        format!("files selected: {}", summary.files_selected),
        format!("files downloaded: {}", summary.files_downloaded),
        format!("files skipped: {}", summary.files_skipped),
        format!("files already saved before the run: {}", summary.already_saved),
        format!("files rejected: {}", summary.files_rejected),
        format!("files failed: {}", summary.files_failed),
        format!("instruction courses selected: {}", summary.instruction_courses_selected),
        format!("instructions discovered: {}", summary.instructions_discovered),
        format!("instructions downloaded: {}", summary.instructions_downloaded),
        format!("log file: {}", absolute(log_file).display()),
    ];
    if !summary.instruction_warnings.is_empty() {
        lines.push("instruction warnings:".into());
        lines.extend(summary.instruction_warnings.iter().map(|w| format!("- {w}")));
    }
    if let Some(error) = run_error.filter(|e| !e.is_empty()) {
        lines.push(format!("run error: {error}"));
    }
    if !summary.failed_files.is_empty() {
        lines.push("failed files:".into());
        lines.extend(summary.failed_files.iter().map(|f| format!("- {}: {}", f.name, f.reason)));
    }
    if let Some(parent) = summary_file.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(summary_file, lines.join("\n") + "\n").map_err(|e| e.to_string())?;

    let report = Report {
        started_at,
        ended_at,
        courses_discovered: summary.courses_discovered,
        courses_selected: summary.courses_selected,
        files_discovered: summary.files_discovered,
        files_selected: summary.files_selected,
        files_downloaded: summary.files_downloaded,
        files_skipped: summary.files_skipped,
        files_already_saved: summary.already_saved,
        files_rejected: summary.files_rejected,
        files_failed: summary.files_failed,
        failed_files: &summary.failed_files,
        instruction_courses_selected: summary.instruction_courses_selected,
        instructions_discovered: summary.instructions_discovered,
        instructions_downloaded: summary.instructions_downloaded,
        instruction_warnings: &summary.instruction_warnings,
        log_file_path: absolute(log_file).to_string_lossy().into_owned(),
        run_error: run_error.filter(|e| !e.is_empty()),
    };
    fs::create_dir_all(download_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    fs::write(download_dir.join("blackbox-run-report.json"), json).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn writes_the_text_summary_and_the_json_report() {
        let root = tempdir().unwrap();
        let summary = Summary {
            courses_discovered: 5,
            courses_selected: 3,
            files_discovered: 100,
            files_selected: 80,
            files_downloaded: 75,
            files_skipped: 3,
            files_failed: 2,
            failed_files: vec![FailedFile { name: "bad.pdf".into(), reason: "network".into() }],
            ..Default::default()
        };
        let summary_file = root.path().join("logs").join("latest-summary.txt");
        let log_file = root.path().join("logs").join("blackbox.log");
        let downloads = root.path().join("downloads");
        write_run_summary(&summary, "2026-01-01T00:00:00.000Z", "2026-01-01T00:01:00.000Z", &log_file, &summary_file, &downloads, Some("partial failure")).unwrap();

        let text = fs::read_to_string(&summary_file).unwrap();
        assert!(text.contains("startedAt: 2026-01-01T00:00:00.000Z"));
        assert!(text.contains(&format!("log file: {}", log_file.display())));
        assert!(text.contains("run error: partial failure"));
        assert!(text.contains("- bad.pdf: network"));

        let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(downloads.join("blackbox-run-report.json")).unwrap()).unwrap();
        assert_eq!(json["filesFailed"], 2);
        assert_eq!(json["failedFiles"][0]["name"], "bad.pdf");
        assert_eq!(json["runError"], "partial failure");
    }
}
