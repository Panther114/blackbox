//! What the UI's `window.blackboxGui` methods do, independent of the window
//! system: settings, credentials, the download workflow, diagnostics, agent
//! export and updates. `lib.rs` adds the few calls that need the OS shell
//! (folder dialog, opening Explorer, quitting for an update).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use crate::blackboard::BASE_URL;
use crate::downloader::Emit;
use crate::export::{harness_skill_status, install_harness_skill, remove_harness_skill};
use crate::files::DownloadLayout;
use crate::ledger::Ledger;
use crate::model::{Course, DiscoveredFile};
use crate::pipeline::{AppPaths, Credentials, Pipeline};
use crate::settings::{normalize_blocked_courses, PasswordStore, Settings};
use crate::timeutil::iso_now;
use crate::updater::Updater;

pub struct Core {
    pub data_dir: PathBuf,
    pub pipeline: Arc<Pipeline>,
    pub updater: Arc<Updater>,
    pub emit: Emit,
    pub version: String,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

fn flag(value: &Value, key: &str) -> Option<bool> {
    value.get(key).and_then(Value::as_bool)
}

/// Blackboard's address. `BLACKBOX_BASE_URL` exists only so the sign-in can be tested against a local stand-in.
pub fn base_url() -> String {
    std::env::var("BLACKBOX_BASE_URL").ok().filter(|v| v.starts_with("http")).unwrap_or_else(|| BASE_URL.to_string())
}

pub fn home_dir() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into()))
}

pub fn app_paths(data_dir: &Path) -> AppPaths {
    AppPaths { data_dir: data_dir.to_path_buf(), log_file: data_dir.join("logs").join("blackbox.log"), summary_file: data_dir.join("logs").join("latest-summary.txt") }
}

pub fn write_log(data_dir: &Path, level: &str, message: &str) {
    use std::io::Write;
    let file = app_paths(data_dir).log_file;
    if let Some(parent) = file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut out) = std::fs::OpenOptions::new().create(true).append(true).open(file) {
        let _ = writeln!(out, "{} [{level}] {message}", iso_now());
    }
}

/// The one-line log entry for a workflow event, or nothing for chatty progress events.
pub fn describe_event(name: &str, payload: &Value) -> Option<(&'static str, String)> {
    let field = |k: &str| payload.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    match name {
        "login:start" => Some(("info", "Signing in to Blackboard".into())),
        "login:success" => Some(("info", "Signed in".into())),
        "login:failure" => Some(("error", format!("Sign-in failed: {}", field("message")))),
        "courses:discovered" => Some(("info", format!("Found {} courses", payload.get("total").and_then(Value::as_u64).unwrap_or(0)))),
        "files:ready" => Some(("info", format!("{} files found, {} already saved", payload.get("filesDiscovered").and_then(Value::as_u64).unwrap_or(0), payload.get("skippedOnDisk").and_then(Value::as_u64).unwrap_or(0)))),
        "download:complete" => Some(("info", format!("Saved {}", field("filename")))),
        "download:skip" => Some(("debug", format!("Skipped {} (already saved)", field("filename")))),
        "download:rejected" => Some(("debug", format!("Rejected file type: {}", field("filename")))),
        "download:error" => Some(("error", format!("Failed {}: {}", field("filename"), field("error")))),
        "download:cancel" => Some(("warn", "Download cancelled by the user".into())),
        "instructions:write:complete" => Some(("info", format!("Wrote {} instruction files", payload.get("instructionsDownloaded").and_then(Value::as_u64).unwrap_or(0)))),
        "summary:ready" => Some(("info", "Run finished".into())),
        _ => None,
    }
}

fn key(path: &Path) -> String {
    path.to_string_lossy().to_lowercase().trim_end_matches(['\\', '/']).to_string()
}

/// Empty a download folder. Refuses drive roots, the home folder and anything that contains it.
pub fn clear_download_directory(dir: &Path, home: &Path) -> Result<usize, String> {
    let resolved = std::path::absolute(dir).map_err(|e| e.to_string())?;
    let is_root = resolved.parent().is_none();
    let contains_home = std::path::absolute(home).map(|h| key(&h).starts_with(&key(&resolved))).unwrap_or(false);
    if is_root || contains_home {
        return Err("Refusing to clear a filesystem or home-directory root. Choose a dedicated download folder.".into());
    }
    if !resolved.exists() {
        std::fs::create_dir_all(&resolved).map_err(|e| e.to_string())?;
        return Ok(0);
    }
    let mut removed = 0;
    let mut failures = Vec::new();
    for entry in std::fs::read_dir(&resolved).map_err(|e| format!("Could not read the download directory: {e}"))?.flatten() {
        let target = entry.path();
        let result = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) { std::fs::remove_dir_all(&target) } else { std::fs::remove_file(&target) };
        match result {
            Ok(()) => removed += 1,
            Err(error) => failures.push(format!("{}: {error}", entry.file_name().to_string_lossy())),
        }
    }
    if failures.is_empty() {
        Ok(removed)
    } else {
        Err(format!("Some items could not be removed ({}). Close any program using them and retry.", failures.join("; ")))
    }
}

async fn reachable(url: &str) -> bool {
    match reqwest::Client::builder().timeout(Duration::from_secs(8)).build() {
        Ok(client) => client.get(url).send().await.is_ok(),
        Err(_) => false,
    }
}

fn writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".blackbox-write-test");
    let ok = std::fs::write(&probe, b"ok").is_ok();
    let _ = std::fs::remove_file(probe);
    ok
}

impl Core {
    pub fn settings_file(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn settings(&self) -> Settings {
        Settings::load(&self.settings_file())
    }

    fn passwords(&self) -> PasswordStore {
        PasswordStore::new(&self.data_dir)
    }

    pub fn log(&self, level: &str, message: &str) {
        write_log(&self.data_dir, level, message);
    }

    /// Credentials from the request, falling back to what is saved.
    fn credentials(&self, payload: &Value) -> Credentials {
        let settings = self.settings();
        let password = text(payload, "password").filter(|p| !p.is_empty()).unwrap_or_else(|| self.passwords().read());
        Credentials {
            username: text(payload, "username").filter(|u| !u.trim().is_empty()).unwrap_or(settings.username.clone()),
            password,
            visible_browser: !flag(payload, "headless").unwrap_or(settings.headless),
        }
    }

    pub fn downloads_dir(&self) -> PathBuf {
        PathBuf::from(self.settings().download_dir)
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.data_dir.join("logs")
    }

    pub async fn call(&self, method: &str, args: &[Value]) -> Result<Value, String> {
        let arg = |i: usize| args.get(i).cloned().unwrap_or(Value::Null);
        match method {
            "getVersion" => Ok(json!(self.version)),

            "loadConfig" => {
                let settings = self.settings();
                let store = self.passwords();
                let password = store.read();
                let stored = store.exists();
                Ok(json!({
                    "hasCredentials": !settings.username.is_empty() && !password.is_empty(),
                    "username": settings.username,
                    "password": password,
                    "passwordStored": stored,
                    "passwordReadable": !stored || !password.is_empty(),
                    "passwordError": if stored && password.is_empty() { json!("The saved password could not be unlocked on this account. Enter it again.") } else { Value::Null },
                    "downloadDir": settings.download_dir,
                    "headless": settings.headless,
                    "courseFilter": settings.course_filter,
                    "autoCheckUpdates": settings.auto_check_updates,
                    "blockedCourses": settings.blocked_courses,
                }))
            }

            "saveSetup" => self.save_setup(&arg(0)).await,

            "resetSetup" => {
                let mut settings = self.settings();
                settings.username.clear();
                settings.headless = true;
                settings.course_filter.clear();
                settings.blocked_courses.clear();
                settings.save(&self.settings_file())?;
                self.passwords().clear();
                Ok(json!({ "ok": true }))
            }

            "runDoctor" => Ok(self.doctor(flag(&arg(0), "loginTest").unwrap_or(false)).await),

            "workflowStart" => {
                let credentials = self.credentials(&arg(0));
                self.log("info", "Starting a download workflow");
                self.pipeline.start(&credentials, &self.data_dir).await?;
                Ok(json!({ "ok": true, "downloadDir": self.settings().download_dir, "logFile": app_paths(&self.data_dir).log_file }))
            }

            "discoverCourses" => {
                let settings = self.settings();
                let courses = self.pipeline.discover_courses(&settings.blocked_courses).await?;
                let pattern = text(&arg(0), "filterPattern").unwrap_or_default();
                let pattern = pattern.trim();
                if pattern.is_empty() {
                    return Ok(json!(courses));
                }
                match regex::Regex::new(pattern) {
                    Ok(regex) => Ok(json!(courses.into_iter().filter(|c| regex.is_match(&c.name)).collect::<Vec<_>>())),
                    Err(_) => {
                        self.log("warn", &format!("Course filter \"{pattern}\" is not a valid regular expression; ignoring it."));
                        Ok(json!(courses))
                    }
                }
            }

            "discoverFiles" => {
                // The UI passes the course list itself; accept the `{ courses }` form too.
                let given = arg(0);
                let list = if given.is_array() { given } else { given.get("courses").cloned().unwrap_or(json!([])) };
                let courses: Vec<Course> = serde_json::from_value(list).map_err(|e| e.to_string())?;
                self.pipeline.discover_files(courses, &self.downloads_dir()).await
            }

            "downloadFiles" => {
                let files: Vec<DiscoveredFile> = serde_json::from_value(arg(0)).map_err(|e| e.to_string())?;
                let instruction_courses: Vec<Course> = serde_json::from_value(if arg(1).is_null() { json!([]) } else { arg(1) }).map_err(|e| e.to_string())?;
                let layout = if arg(2).as_str() == Some("flat") { DownloadLayout::Flat } else { DownloadLayout::Hierarchy };
                let summary = self.pipeline.download(files, instruction_courses, layout, &self.downloads_dir()).await?;
                serde_json::to_value(summary).map_err(|e| e.to_string())
            }

            "cancelDownload" => Ok(self.pipeline.cancel()),
            "cleanupWorkflow" => {
                self.pipeline.cleanup().await;
                Ok(json!({ "ok": true }))
            }

            "getPaths" => {
                let logs = self.logs_dir();
                Ok(json!({ "downloads": self.settings().download_dir, "logs": logs, "summary": logs.join("latest-summary.txt") }))
            }

            "clearDownloads" => {
                self.pipeline.cleanup().await;
                let requested = text(&arg(0), "downloadDir").unwrap_or_default();
                let dir = if requested.trim().is_empty() { self.downloads_dir() } else { PathBuf::from(requested.trim()) };
                let removed = clear_download_directory(&dir, &home_dir())?;
                let mut ledger = Ledger::open(&self.data_dir);
                ledger.clear();
                self.log("info", &format!("Cleared {removed} items from {}", dir.display()));
                Ok(json!({ "ok": true, "removed": removed, "directory": dir }))
            }

            "scanCourses" => {
                let credentials = self.credentials(&arg(0));
                let courses = self.pipeline.scan_courses(&credentials).await?;
                Ok(json!(courses))
            }

            "getAgentStatus" => {
                let settings = self.settings();
                Ok(json!({
                    "busy": self.pipeline.busy().is_some(),
                    "configured": !settings.username.is_empty() && !self.passwords().read().is_empty(),
                    "downloadDir": settings.download_dir,
                    "harnessSkill": harness_skill_status(&home_dir()),
                }))
            }

            "syncAgent" => {
                let options = arg(0);
                let credentials = self.credentials(&Value::Null);
                let dir = text(&options, "outputDir").filter(|d| !d.trim().is_empty()).map(PathBuf::from).unwrap_or_else(|| self.downloads_dir());
                self.pipeline.agent_sync(&credentials, &dir, flag(&options, "includeFiles").unwrap_or(false), flag(&options, "includeInstructions").unwrap_or(true)).await
            }

            "installHarnessSkill" => Ok(json!({ "harnessSkill": install_harness_skill(&self.downloads_dir(), &home_dir())? })),
            "removeHarnessSkill" => Ok(json!({ "harnessSkill": remove_harness_skill(&home_dir())? })),

            "getUpdateState" => Ok(self.updater.state()),
            "checkForUpdates" => Ok(self.updater.check().await),
            "downloadUpdate" => self.updater.download().await,

            "loadAutomationSettings" | "saveAutomationSettings" | "chooseAutomationDirectory" | "openAutomationDirectory" | "startAutomationRun" | "cancelAutomationRun" | "clearAutomationDownloads" => {
                Err("Automation is not part of this build yet.".into())
            }

            other => Err(format!("Unknown action: {other}")),
        }
    }

    async fn save_setup(&self, payload: &Value) -> Result<Value, String> {
        let current = self.settings();
        let blocked = match payload.get("blockedCourses") {
            Some(value) if !value.is_null() => normalize_blocked_courses(value),
            _ => current.blocked_courses.clone(),
        };
        let next = Settings {
            username: text(payload, "username").unwrap_or_default().trim().to_string(),
            download_dir: text(payload, "downloadDir").map(|d| d.trim().to_string()).filter(|d| !d.is_empty()).unwrap_or(current.download_dir.clone()),
            headless: flag(payload, "headless").unwrap_or(current.headless),
            course_filter: text(payload, "courseFilter").unwrap_or(current.course_filter.clone()),
            auto_check_updates: flag(payload, "autoCheckUpdates").unwrap_or(current.auto_check_updates),
            blocked_courses: blocked,
        };
        next.save(&self.settings_file())?;
        // A missing password keeps the stored one; an explicitly empty one clears it.
        match payload.get("password").and_then(Value::as_str) {
            None => {}
            Some("") => self.passwords().clear(),
            Some(password) => self.passwords().save(password)?,
        }
        let mut result = json!({ "ok": true });
        if flag(payload, "testLogin").unwrap_or(false) {
            let credentials = self.credentials(payload);
            match self.pipeline.test_login(&credentials).await {
                Ok(()) => result["loginTestPassed"] = json!(true),
                Err(error) => {
                    result["loginTestPassed"] = json!(false);
                    result["loginTestError"] = json!(error);
                }
            }
        }
        Ok(result)
    }

    async fn doctor(&self, login_test: bool) -> Value {
        let total = if login_test { 10 } else { 9 };
        let mut checks: Vec<Value> = Vec::new();
        let add = |status: &str, message: String, required: bool, checks: &mut Vec<Value>| {
            checks.push(json!({ "status": status, "message": message, "required": required }));
            (self.emit)("diagnostics:progress", json!({ "running": true, "completed": checks.len(), "total": total, "current": message, "loginTest": login_test }));
        };
        (self.emit)("diagnostics:progress", json!({ "running": true, "completed": 0, "total": total, "current": "Starting environment checks...", "loginTest": login_test }));

        add("pass", format!("Native runtime available (Blackbox {})", self.version), true, &mut checks);
        match tauri::webview_version() {
            Ok(version) => add("pass", format!("Web view available (WebView2 {version})"), true, &mut checks),
            Err(_) => add("fail", "Microsoft WebView2 runtime not found".into(), true, &mut checks),
        }
        let settings = self.settings();
        let password = self.passwords().read();
        add("pass", "Per-user application settings available".into(), true, &mut checks);
        let configured = !settings.username.is_empty() && !password.is_empty();
        add(if configured { "pass" } else { "fail" }, if configured { "Blackboard credentials configured".into() } else { "Blackboard credentials missing".into() }, true, &mut checks);
        for (label, dir) in [("Download directory", PathBuf::from(&settings.download_dir)), ("Log directory", self.logs_dir()), ("Data directory", self.data_dir.clone())] {
            let ok = writable(&dir);
            add(if ok { "pass" } else { "fail" }, format!("{label} {} ({})", if ok { "writable" } else { "not writable" }, dir.display()), true, &mut checks);
        }
        let site = reachable(&base_url()).await;
        add(if site { "pass" } else { "warn" }, format!("Blackboard {}", if site { "reachable" } else { "unreachable right now" }), false, &mut checks);

        if login_test {
            if !configured {
                add("fail", "Cannot run login test: credentials are missing".into(), true, &mut checks);
            } else {
                match self.pipeline.test_login(&self.credentials(&Value::Null)).await {
                    Ok(()) => add("pass", "Blackboard login test passed".into(), true, &mut checks),
                    Err(error) => add("fail", format!("Blackboard login test failed: {error}"), true, &mut checks),
                }
            }
        }
        (self.emit)("diagnostics:progress", json!({ "running": false, "completed": checks.len(), "total": total, "current": "Diagnostics complete", "loginTest": login_test }));
        json!(checks)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blackboard::mock;
    use std::sync::Mutex;
    use tempfile::tempdir;

    fn core(data: &Path) -> (Core, mock::Server) {
        let events = Arc::new(Mutex::new(Vec::<String>::new()));
        let sink = events.clone();
        let emit: Emit = Arc::new(move |name, _| sink.lock().unwrap().push(name.to_string()));
        let server = mock::start("G1", "pw");
        let pipeline = Arc::new(Pipeline::with_base_url(emit.clone(), app_paths(data), None, &server.base));
        (Core { data_dir: data.to_path_buf(), pipeline, updater: Arc::new(Updater::new("2.0.0", Box::new(|_| {}))), emit, version: "2.0.0".into() }, server)
    }

    #[tokio::test]
    async fn settings_and_password_round_trip_through_the_bridge() {
        let data = tempdir().unwrap();
        let (core, _server) = core(data.path());
        let saved = core.call("saveSetup", &[json!({ "username": " G1 ", "password": "pw", "downloadDir": "D:/dl", "headless": false, "courseFilter": "Math" })]).await.unwrap();
        assert_eq!(saved["ok"], true);
        let loaded = core.call("loadConfig", &[]).await.unwrap();
        assert_eq!((loaded["username"].as_str(), loaded["downloadDir"].as_str(), loaded["headless"].as_bool()), (Some("G1"), Some("D:/dl"), Some(false)));
        assert_eq!(loaded["hasCredentials"], cfg!(windows));

        // No password key keeps the stored one; an empty one clears it; an empty filter can be cleared.
        core.call("saveSetup", &[json!({ "username": "G1", "courseFilter": "" })]).await.unwrap();
        assert_eq!(core.call("loadConfig", &[]).await.unwrap()["courseFilter"], "");
        assert_eq!(core.passwords().exists(), cfg!(windows));
        core.call("saveSetup", &[json!({ "username": "G1", "password": "" })]).await.unwrap();
        assert!(!core.passwords().exists());
    }

    #[tokio::test]
    async fn the_download_folder_is_read_from_settings_when_saving() {
        let data = tempdir().unwrap();
        let first = tempdir().unwrap();
        let second = tempdir().unwrap();
        let (core, _server) = core(data.path());
        core.call("saveSetup", &[json!({ "username": "G1", "password": "pw", "downloadDir": first.path() })]).await.unwrap();
        if !cfg!(windows) {
            return; // the saved password needs DPAPI
        }
        core.call("workflowStart", &[json!({})]).await.unwrap();
        let courses = core.call("discoverCourses", &[json!({})]).await.unwrap();
        let scan = core.call("discoverFiles", &[courses]).await.unwrap();
        // The folder is changed after the scan, before saving.
        core.call("saveSetup", &[json!({ "username": "G1", "downloadDir": second.path() })]).await.unwrap();
        let summary = core.call("downloadFiles", &[scan["files"].clone(), json!([]), json!("hierarchy")]).await.unwrap();
        assert_eq!(summary["filesDownloaded"], 2);
        assert_eq!(Path::new(summary["downloadDir"].as_str().unwrap()), second.path());
        assert!(std::fs::read_dir(first.path()).unwrap().next().is_none(), "nothing may land in the old folder");
        assert!(std::fs::read_dir(second.path()).unwrap().count() > 0);
    }

    #[test]
    fn clearing_refuses_roots_and_the_home_folder() {
        let home = tempdir().unwrap();
        assert!(clear_download_directory(home.path(), home.path()).is_err());
        assert!(clear_download_directory(home.path().parent().unwrap(), home.path()).is_err());
        let sub = home.path().join("dl");
        std::fs::create_dir_all(sub.join("course")).unwrap();
        std::fs::write(sub.join("a.pdf"), b"x").unwrap();
        assert_eq!(clear_download_directory(&sub, home.path()).unwrap(), 2);
        assert!(sub.exists() && std::fs::read_dir(&sub).unwrap().next().is_none());
    }

    #[tokio::test]
    async fn unknown_and_unported_actions_say_so() {
        let data = tempdir().unwrap();
        let (core, _server) = core(data.path());
        assert!(core.call("loadAutomationSettings", &[]).await.unwrap_err().contains("not part of this build"));
        assert!(core.call("nope", &[]).await.unwrap_err().contains("Unknown action"));
    }
}
