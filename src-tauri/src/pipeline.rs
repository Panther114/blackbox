//! The download workflow: log in, list courses, walk them for files and
//! instructions, download, and summarise. Port of src/index.ts,
//! src/workflow/downloadWorkflow.ts and the worker's run bookkeeping.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::blackboard::{BbClient, LoginOutcome, BASE_URL};
use crate::downloader::{Downloader, Emit, Outcome};
use crate::export::{write_agent_export, write_manual_instructions, InstructionProgress};
use crate::files::{extension_of, DownloadLayout};
use crate::ledger::Ledger;
use crate::markdown::stable_id;
use crate::model::{AgentAttachment, BlockedCourse, ContentItem, Course, DiscoveredFile, ExistingFileState};
use crate::parse::{collect_download_candidates, parse_content_items, parse_content_links, parse_courses, parse_sidebar_links, parse_subfolders};
use crate::summary::{write_run_summary, FailedFile, Summary};
use crate::timeutil::iso_now;

const MAX_FOLDER_DEPTH: usize = 10;

/// Sign in with a real browser window and return its cookies. Used when plain HTTP is not enough.
pub type BrowserLogin = Arc<dyn Fn(String, String, bool) -> Pin<Box<dyn Future<Output = Result<Vec<(String, String)>, String>> + Send>> + Send + Sync>;

#[derive(Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub log_file: PathBuf,
    pub summary_file: PathBuf,
}

pub struct Credentials {
    pub username: String,
    pub password: String,
    pub visible_browser: bool,
}

struct Session {
    client: BbClient,
    portal_html: String,
    ledger: Arc<Mutex<Ledger>>,
    existing: HashMap<String, ExistingFileState>,
    started_at: String,
    courses_discovered: usize,
    courses_selected: usize,
    files_discovered: usize,
}

pub struct Pipeline {
    emit: Emit,
    paths: AppPaths,
    base_url: String,
    browser_login: Option<BrowserLogin>,
    session: tokio::sync::Mutex<Option<Session>>,
    cancel: Mutex<CancellationToken>,
    busy: Mutex<Option<&'static str>>,
}

fn now_pair() -> (String, String) {
    (iso_now(), iso_now())
}

struct Walk {
    files: Vec<DiscoveredFile>,
    items: Vec<ContentItem>,
    warnings: Vec<String>,
}

async fn fetch_page(client: &BbClient, url: &str) -> Result<String, String> {
    match client.get_html(url).await {
        Ok(html) => Ok(html),
        Err(_) => {
            tokio::time::sleep(Duration::from_millis(500)).await;
            client.get_html(url).await
        }
    }
}

impl Pipeline {
    pub fn new(emit: Emit, paths: AppPaths, browser_login: Option<BrowserLogin>) -> Self {
        Self::with_base_url(emit, paths, browser_login, BASE_URL)
    }

    pub fn with_base_url(emit: Emit, paths: AppPaths, browser_login: Option<BrowserLogin>, base_url: &str) -> Self {
        Self { emit, paths, base_url: base_url.to_string(), browser_login, session: tokio::sync::Mutex::new(None), cancel: Mutex::new(CancellationToken::new()), busy: Mutex::new(None) }
    }

    pub fn busy(&self) -> Option<&'static str> {
        *self.busy.lock().unwrap()
    }

    // -- Login -----------------------------------------------------------------

    async fn open(&self, credentials: &Credentials) -> Result<(BbClient, String), String> {
        if credentials.username.trim().is_empty() || credentials.password.is_empty() {
            return Err("Blackboard credentials are missing. Open Credentials and save your username/password.".into());
        }
        let client = BbClient::new(&self.base_url)?;
        let mut reason = String::new();
        if !credentials.visible_browser {
            match client.login(credentials.username.trim(), &credentials.password).await {
                LoginOutcome::LoggedIn(html) => return Ok((client, html)),
                LoginOutcome::Rejected => return Err("Login failed. Check your username and password, then retry.".into()),
                LoginOutcome::NeedsBrowser(why) => reason = why,
            }
        }
        // Visible mode, or HTTP could not finish the sign-in: use a real browser window for the login only.
        let Some(browser_login) = &self.browser_login else {
            return Err(if reason.is_empty() { "Blackboard sign-in needs a browser window.".into() } else { reason });
        };
        let cookies = browser_login(credentials.username.trim().to_string(), credentials.password.clone(), credentials.visible_browser).await?;
        client.import_cookies(&cookies);
        let portal = client.get_html(&format!("{}/", client.base_url())).await?;
        if parse_courses(&portal, client.base_url()).is_empty() {
            return Err("Login failed - could not find course list. Check your username and password, then retry.".into());
        }
        Ok((client, portal))
    }

    fn begin(&self, owner: &'static str) -> Result<(), String> {
        let mut busy = self.busy.lock().unwrap();
        if let Some(current) = *busy {
            return Err(format!("A Blackboard workflow is already running ({current}). Try again when it finishes."));
        }
        *busy = Some(owner);
        Ok(())
    }

    fn end(&self) {
        *self.busy.lock().unwrap() = None;
    }

    /// Log in for a download run. Replaces any previous run.
    pub async fn start(&self, credentials: &Credentials, ledger_dir: &Path) -> Result<(), String> {
        self.cleanup().await;
        *self.cancel.lock().unwrap() = CancellationToken::new();
        self.begin("download")?;
        (self.emit)("login:start", json!({}));
        let (client, portal_html) = match self.open(credentials).await {
            Ok(opened) => opened,
            Err(error) => {
                self.end();
                (self.emit)("login:failure", json!({ "message": error }));
                return Err(error);
            }
        };
        (self.emit)("login:success", json!({}));
        let ledger = Arc::new(Mutex::new(Ledger::open(ledger_dir)));
        *self.session.lock().await = Some(Session {
            client,
            portal_html,
            ledger,
            existing: HashMap::new(),
            started_at: iso_now(),
            courses_discovered: 0,
            courses_selected: 0,
            files_discovered: 0,
        });
        Ok(())
    }

    pub async fn discover_courses(&self, blocked: &[BlockedCourse]) -> Result<Vec<Course>, String> {
        let mut guard = self.session.lock().await;
        let session = guard.as_mut().ok_or("Workflow not started")?;
        let blocked: HashSet<&str> = blocked.iter().map(|c| c.id.as_str()).collect();
        let courses: Vec<Course> = parse_courses(&session.portal_html, session.client.base_url()).into_iter().filter(|c| !blocked.contains(c.id.as_str())).collect();
        session.courses_discovered = courses.len();
        (self.emit)("courses:discovered", json!({ "total": courses.len(), "visible": courses.len() }));
        Ok(courses)
    }

    // -- Walking courses ---------------------------------------------------------

    async fn walk_course(
        &self,
        client: &BbClient,
        download_dir: &Path,
        course: &Course,
        want_files: bool,
        want_items: bool,
        include_announcements: bool,
        on_section: &(dyn Fn(&str) + Send + Sync),
    ) -> Walk {
        let mut walk = Walk { files: Vec::new(), items: Vec::new(), warnings: Vec::new() };
        let base = client.base_url().to_string();
        let course_html = match fetch_page(client, &course.url).await {
            Ok(html) => html,
            Err(error) => {
                walk.warnings.push(format!("Could not scan {}: {error}", course.name));
                return walk;
            }
        };
        let links = parse_sidebar_links(&course_html, &base, include_announcements);
        for link in links {
            if self.cancel.lock().unwrap().is_cancelled() {
                break;
            }
            on_section(&link.title);
            let section_dir = download_dir.join(&course.path).join(&link.path);
            let mut visited: HashSet<String> = HashSet::new();
            visited.insert(link.url.clone());
            // (page url, directory, folder path, depth); sub-folders are visited with an explicit stack.
            let mut stack: Vec<(String, PathBuf, Vec<String>, usize)> = vec![(link.url.clone(), section_dir, Vec::new(), 0)];
            while let Some((url, dir, folder_path, depth)) = stack.pop() {
                let html = match fetch_page(client, &url).await {
                    Ok(html) => html,
                    Err(_) => {
                        walk.warnings.push(format!("Could not open {} / {}", course.name, link.title));
                        continue;
                    }
                };
                if want_items {
                    if let Some(items) = parse_content_items(&html, course, &link.title, &folder_path, &url, &base) {
                        walk.items.extend(items);
                    }
                }
                if want_files {
                    if let Some(raw_links) = parse_content_links(&html) {
                        let save_path = dir.to_string_lossy().into_owned();
                        for raw in collect_download_candidates(&raw_links, &base, &save_path) {
                            let file_type = extension_of(&raw.name).map(|e| e.to_uppercase());
                            walk.files.push(DiscoveredFile {
                                name: raw.name,
                                url: raw.url,
                                course_name: course.name.clone(),
                                section_name: link.title.clone(),
                                save_path: save_path.clone(),
                                size: None,
                                mime_type: None,
                                file_type,
                                status: "pending".into(),
                            });
                        }
                    }
                }
                if depth + 1 >= MAX_FOLDER_DEPTH {
                    continue;
                }
                // Reverse so folders are visited in page order.
                for folder in parse_subfolders(&html, &base).into_iter().rev() {
                    if visited.insert(folder.url.clone()) {
                        let mut path = folder_path.clone();
                        path.push(folder.title.clone());
                        stack.push((folder.url, dir.join(&folder.path), path, depth + 1));
                    }
                }
            }
        }
        walk
    }

    // -- Discovery ---------------------------------------------------------------

    pub async fn discover_files(&self, courses: Vec<Course>, download_dir: &Path) -> Result<Value, String> {
        let (client, ledger) = {
            let mut guard = self.session.lock().await;
            let session = guard.as_mut().ok_or("Workflow not started")?;
            session.courses_selected = courses.len();
            (session.client.clone(), session.ledger.clone())
        };
        (self.emit)("files:discovery:start", json!({ "courseCount": courses.len() }));

        let mut discovered: Vec<DiscoveredFile> = Vec::new();
        for (index, course) in courses.iter().enumerate() {
            if self.cancel.lock().unwrap().is_cancelled() {
                break;
            }
            let found_so_far = discovered.len();
            let emit = self.emit.clone();
            let (name, total) = (course.name.clone(), courses.len());
            let progress = move |section: &str| {
                emit("files:discovery:progress", json!({ "phase": "courses", "completed": index, "total": total, "currentCourse": name, "currentSection": section, "filesFound": found_so_far }));
            };
            progress("");
            let walk = self.walk_course(&client, download_dir, course, true, false, false, &progress).await;
            discovered.extend(walk.files);
            (self.emit)("files:discovery:progress", json!({ "phase": "courses", "completed": index + 1, "total": courses.len(), "currentCourse": course.name, "currentSection": "", "filesFound": discovered.len() }));
        }
        (self.emit)("files:discovery:complete", json!({ "filesDiscovered": discovered.len() }));

        let downloader = Downloader::new(client.http().clone(), ledger, download_dir.to_path_buf(), self.emit.clone(), self.cancel.lock().unwrap().clone());
        // Ask the disk first and only then spend a HEAD request per file: a saved course needs no metadata.
        let disk_state = downloader.inspect_existing(&discovered);
        let pending: Vec<DiscoveredFile> = discovered.iter().filter(|f| disk_state.get(&f.url).is_some_and(|s| !s.hierarchy && !s.flat)).cloned().collect();
        let enriched_pending = downloader.fetch_metadata(pending).await;
        let by_url: HashMap<&str, &DiscoveredFile> = enriched_pending.iter().map(|f| (f.url.as_str(), f)).collect();
        let enriched: Vec<DiscoveredFile> = discovered.iter().filter_map(|f| by_url.get(f.url.as_str()).map(|e| (*e).clone())).collect();

        let mut existing = disk_state;
        existing.extend(downloader.inspect_existing(&enriched));
        let already = |layout: DownloadLayout| discovered.iter().filter(|f| existing.get(&f.url).is_some_and(|s| if layout == DownloadLayout::Flat { s.flat } else { s.hierarchy })).count();
        let any = discovered.iter().filter(|f| existing.get(&f.url).is_some_and(|s| s.hierarchy || s.flat)).count();
        (self.emit)(
            "files:ready",
            json!({ "filesDiscovered": discovered.len(), "filesSelectable": discovered.len() - any, "skippedOnDisk": any, "alreadySavedHierarchy": already(DownloadLayout::Hierarchy), "alreadySavedFlat": already(DownloadLayout::Flat) }),
        );

        if let Some(session) = self.session.lock().await.as_mut() {
            session.files_discovered = discovered.len();
            session.existing = existing.clone();
        }
        Ok(json!({ "discovered": discovered, "enriched": enriched, "files": enriched, "skippedOnDisk": any, "existing": existing }))
    }

    // -- Download ------------------------------------------------------------------

    pub async fn download(&self, files: Vec<DiscoveredFile>, instruction_courses: Vec<Course>, layout: DownloadLayout, download_dir: &Path) -> Result<Summary, String> {
        let session = self.session.lock().await.take().ok_or("Workflow not started")?;
        let cancel = self.cancel.lock().unwrap().clone();
        let already_saved = session.existing.values().filter(|s| if layout == DownloadLayout::Flat { s.flat } else { s.hierarchy }).count();
        let mut summary = Summary {
            courses_discovered: session.courses_discovered,
            courses_selected: session.courses_selected,
            files_discovered: session.files_discovered,
            files_selected: files.len(),
            already_saved,
            instruction_courses_selected: instruction_courses.len(),
            ..Default::default()
        };

        if !instruction_courses.is_empty() && !cancel.is_cancelled() {
            (self.emit)("instructions:discovery:start", json!({ "courseCount": instruction_courses.len() }));
            let mut items: Vec<ContentItem> = Vec::new();
            for (index, course) in instruction_courses.iter().enumerate() {
                if cancel.is_cancelled() {
                    break;
                }
                let emit = self.emit.clone();
                let (name, total, found) = (course.name.clone(), instruction_courses.len(), items.len());
                let progress = move |section: &str| {
                    emit("instructions:discovery:progress", json!({ "phase": "sections", "completed": index, "total": total, "currentCourse": name, "currentSection": section, "itemsFound": found }));
                };
                progress("");
                let walk = self.walk_course(&session.client, download_dir, course, false, true, true, &progress).await;
                items.extend(walk.items);
                summary.instruction_warnings.extend(walk.warnings);
                (self.emit)("instructions:discovery:progress", json!({ "phase": "courses", "completed": index + 1, "total": instruction_courses.len(), "currentCourse": course.name, "currentSection": "", "itemsFound": items.len() }));
            }
            summary.instructions_discovered = items.len();
            (self.emit)("instructions:discovery:complete", json!({ "instructionsDiscovered": items.len(), "warnings": summary.instruction_warnings }));
            if !cancel.is_cancelled() {
                (self.emit)("instructions:write:start", json!({ "instructionsDiscovered": items.len() }));
                let emit = self.emit.clone();
                let written = write_manual_instructions(
                    download_dir,
                    &instruction_courses,
                    &items,
                    Some(&move |p: InstructionProgress| {
                        emit(
                            "instructions:write:progress",
                            json!({ "completed": p.completed, "total": p.total, "currentCourse": p.current_course, "currentSection": p.current_section, "currentTitle": p.current_title }),
                        );
                    }),
                );
                summary.instructions_downloaded = written.written;
                summary.instruction_warnings.extend(written.warnings.clone());
                (self.emit)("instructions:write:complete", json!({ "instructionsDownloaded": written.written, "warnings": written.warnings }));
            }
        }

        if !files.is_empty() && !cancel.is_cancelled() {
            let downloader = Downloader::new(session.client.http().clone(), session.ledger.clone(), download_dir.to_path_buf(), self.emit.clone(), cancel.clone());
            for result in downloader.download_files(files.clone(), layout).await {
                match result.outcome {
                    Outcome::Completed => summary.files_downloaded += 1,
                    Outcome::Skipped => summary.files_skipped += 1,
                    Outcome::Rejected => summary.files_rejected += 1,
                    Outcome::Failed => {
                        summary.files_failed += 1;
                        summary.failed_files.push(FailedFile { name: result.name, reason: result.error.unwrap_or_else(|| "Unknown error".into()) });
                    }
                    Outcome::Cancelled => {}
                }
            }
            if layout == DownloadLayout::Flat {
                prune_flat_leftovers(download_dir, &files);
            }
        }
        summary.cancelled = cancel.is_cancelled();

        let (started, ended) = (session.started_at.clone(), now_pair().1);
        let _ = write_run_summary(&summary, &started, &ended, &self.paths.log_file, &self.paths.summary_file, download_dir, None);
        (self.emit)("summary:ready", serde_json::to_value(&summary).unwrap_or(Value::Null));
        self.end();
        Ok(summary)
    }

    pub fn cancel(&self) -> Value {
        let running = self.busy().is_some();
        if running {
            self.cancel.lock().unwrap().cancel();
            (self.emit)("download:cancel", json!({}));
        }
        json!({ "cancelled": running, "running": running })
    }

    pub async fn cleanup(&self) {
        *self.session.lock().await = None;
        self.end();
    }

    // -- One-shot jobs ---------------------------------------------------------------

    /// Every course on the account, including blocked ones (for the course filter settings).
    pub async fn scan_courses(&self, credentials: &Credentials) -> Result<Vec<Course>, String> {
        self.begin("courses")?;
        let result = async {
            let (client, portal) = self.open(credentials).await?;
            Ok(parse_courses(&portal, client.base_url()))
        }
        .await;
        self.end();
        result
    }

    pub async fn test_login(&self, credentials: &Credentials) -> Result<(), String> {
        self.begin("login-test")?;
        let result = self.open(credentials).await.map(|_| ());
        self.end();
        result
    }

    /// Read-only export of instructions and attachments for coding agents.
    pub async fn agent_sync(&self, credentials: &Credentials, download_dir: &Path, include_files: bool, include_instructions: bool) -> Result<Value, String> {
        self.begin("agent")?;
        let result = self.agent_sync_inner(credentials, download_dir, include_files, include_instructions).await;
        self.end();
        result
    }

    async fn agent_sync_inner(&self, credentials: &Credentials, download_dir: &Path, include_files: bool, include_instructions: bool) -> Result<Value, String> {
        *self.cancel.lock().unwrap() = CancellationToken::new();
        let (client, portal) = self.open(credentials).await?;
        let courses = parse_courses(&portal, client.base_url());
        let mut files = Vec::new();
        let mut items = Vec::new();
        let mut warnings = Vec::new();
        for course in &courses {
            let walk = self.walk_course(&client, download_dir, course, true, include_instructions, true, &|_| {}).await;
            files.extend(walk.files);
            items.extend(walk.items);
            warnings.extend(walk.warnings);
        }
        let mut attachments: Vec<AgentAttachment> = files
            .iter()
            .map(|f| {
                let local = Path::new(&f.save_path).join(&f.name);
                AgentAttachment {
                    id: stable_id("attachment", &f.url),
                    name: f.name.clone(),
                    url: f.url.clone(),
                    course_name: f.course_name.clone(),
                    section_name: f.section_name.clone(),
                    relative_path: local.strip_prefix(download_dir).ok().map(|p| p.to_string_lossy().into_owned()),
                    local_path: Some(local.to_string_lossy().into_owned()),
                    size: f.size,
                    mime_type: f.mime_type.clone(),
                    status: "pending".into(),
                }
            })
            .collect();

        if include_files {
            let ledger = Arc::new(Mutex::new(Ledger::open(&self.paths.data_dir)));
            let downloader = Downloader::new(client.http().clone(), ledger, download_dir.to_path_buf(), self.emit.clone(), self.cancel.lock().unwrap().clone());
            let described = downloader.fetch_metadata(files).await;
            let results: HashMap<String, Outcome> = downloader.download_files(described, DownloadLayout::Hierarchy).await.into_iter().map(|r| (r.url, r.outcome)).collect();
            for attachment in &mut attachments {
                attachment.status = match results.get(&attachment.url) {
                    Some(Outcome::Completed) => "downloaded",
                    Some(Outcome::Skipped) => "skipped",
                    Some(Outcome::Failed) => "failed",
                    _ => "pending",
                }
                .into();
            }
        }
        let (manifest_path, manifest) = write_agent_export(download_dir, client.base_url(), &courses, &items, &attachments, &warnings)?;
        Ok(json!({
            "manifestPath": manifest_path,
            "courses": manifest.summary.courses,
            "items": manifest.summary.items,
            "attachments": manifest.summary.attachments,
            "downloadedFiles": manifest.summary.downloaded_files,
            "warnings": manifest.warnings
        }))
    }
}

/// A flat run still discovers the folder shells; drop the ones left empty.
fn prune_flat_leftovers(download_dir: &Path, files: &[DiscoveredFile]) {
    let mut courses = HashSet::new();
    for file in files {
        if let Some(folder) = crate::files::course_folder_for_save_path(download_dir, Path::new(&file.save_path)) {
            courses.insert(folder);
        }
    }
    for folder in courses {
        crate::files::prune_empty_directories(&folder);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::blackboard::mock;
    use tempfile::tempdir;

    fn pipeline(server: &mock::Server, data: &Path) -> (Pipeline, Arc<Mutex<Vec<String>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let emit: Emit = Arc::new(move |name, _| sink.lock().unwrap().push(name.to_string()));
        let paths = AppPaths { data_dir: data.to_path_buf(), log_file: data.join("logs/blackbox.log"), summary_file: data.join("logs/latest-summary.txt") };
        (Pipeline::with_base_url(emit, paths, None, &server.base), events)
    }

    fn credentials(password: &str) -> Credentials {
        Credentials { username: "G1".into(), password: password.into(), visible_browser: false }
    }

    #[tokio::test]
    async fn runs_a_whole_download_against_the_mock_site() {
        let server = mock::start("G1", "pw");
        let data = tempdir().unwrap();
        let downloads = tempdir().unwrap();
        let (pipeline, events) = pipeline(&server, data.path());

        pipeline.start(&credentials("pw"), data.path()).await.unwrap();
        let courses = pipeline.discover_courses(&[]).await.unwrap();
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].id, "_11_1");

        let scan = pipeline.discover_files(courses.clone(), downloads.path()).await.unwrap();
        let files: Vec<DiscoveredFile> = serde_json::from_value(scan["files"].clone()).unwrap();
        let mut names: Vec<&str> = files.iter().map(|f| f.name.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["Lecture.pdf", "Slides.pptx"]);
        assert!(files.iter().any(|f| f.save_path.ends_with("Course Content") || f.save_path.contains("Week 1")));

        let summary = pipeline.download(files, courses, DownloadLayout::Hierarchy, downloads.path()).await.unwrap();
        assert_eq!((summary.files_downloaded, summary.files_failed, summary.instructions_downloaded), (2, 0, 2));
        assert!(!summary.cancelled);
        assert!(downloads.path().join("Mock Course/Course Content/Week 1/Lecture.pdf").exists() || downloads.path().join("Mock Course/Course Content/Lecture.pdf").exists());
        assert!(data.path().join("logs/latest-summary.txt").exists());
        assert!(downloads.path().join("blackbox-run-report.json").exists());
        let seen = events.lock().unwrap();
        for expected in ["login:start", "login:success", "courses:discovered", "files:ready", "download:complete", "instructions:write:complete", "summary:ready"] {
            assert!(seen.iter().any(|e| e == expected), "missing event {expected}");
        }

        // A second run on the same folder has nothing left to save.
        pipeline.start(&credentials("pw"), data.path()).await.unwrap();
        let courses = pipeline.discover_courses(&[]).await.unwrap();
        let again = pipeline.discover_files(courses, downloads.path()).await.unwrap();
        assert_eq!(again["skippedOnDisk"], 2);
        pipeline.cleanup().await;
    }

    #[tokio::test]
    async fn blocked_courses_are_hidden_and_bad_logins_are_explained() {
        let server = mock::start("G1", "pw");
        let data = tempdir().unwrap();
        let (pipeline, _events) = pipeline(&server, data.path());
        pipeline.start(&credentials("pw"), data.path()).await.unwrap();
        let blocked = vec![BlockedCourse { id: "_11_1".into(), name: "Mock Course".into() }];
        assert!(pipeline.discover_courses(&blocked).await.unwrap().is_empty());
        pipeline.cleanup().await;

        let error = pipeline.start(&credentials("wrong"), data.path()).await.unwrap_err();
        assert!(error.contains("Check your username and password"));
        assert!(pipeline.busy().is_none());
        assert!(pipeline.start(&Credentials { username: String::new(), password: String::new(), visible_browser: false }, data.path()).await.unwrap_err().contains("credentials are missing"));
    }

    #[tokio::test]
    async fn cancel_marks_the_summary_and_keeps_the_run_consistent() {
        let server = mock::start("G1", "pw");
        let data = tempdir().unwrap();
        let downloads = tempdir().unwrap();
        let (pipeline, _events) = pipeline(&server, data.path());
        pipeline.start(&credentials("pw"), data.path()).await.unwrap();
        let courses = pipeline.discover_courses(&[]).await.unwrap();
        let scan = pipeline.discover_files(courses.clone(), downloads.path()).await.unwrap();
        let files: Vec<DiscoveredFile> = serde_json::from_value(scan["files"].clone()).unwrap();
        assert_eq!(pipeline.cancel()["running"], true);
        let summary = pipeline.download(files, courses, DownloadLayout::Hierarchy, downloads.path()).await.unwrap();
        assert!(summary.cancelled);
        assert_eq!(summary.files_downloaded, 0);
    }

    #[tokio::test]
    async fn scanning_courses_and_exporting_for_agents_work_without_a_download_run() {
        let server = mock::start("G1", "pw");
        let data = tempdir().unwrap();
        let downloads = tempdir().unwrap();
        let (pipeline, _events) = pipeline(&server, data.path());
        assert_eq!(pipeline.scan_courses(&credentials("pw")).await.unwrap().len(), 1);
        assert!(pipeline.test_login(&credentials("pw")).await.is_ok());
        assert!(pipeline.test_login(&credentials("nope")).await.is_err());
        let exported = pipeline.agent_sync(&credentials("pw"), downloads.path(), false, true).await.unwrap();
        assert_eq!(exported["courses"], 1);
        assert!(downloads.path().join("agent-export/manifest.json").exists());
    }
}
