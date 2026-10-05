//! Updates from GitHub releases: check the latest release, download its
//! installer (verified against the SHA-256 GitHub publishes for the asset), then
//! run it. Nothing is installed without the user pressing "Restart and install".

use std::path::PathBuf;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const LATEST_RELEASE: &str = "https://api.github.com/repos/Panther114/blackbox/releases/latest";

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    digest: Option<String>,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: Option<String>,
    assets: Vec<Asset>,
}

/// `v2.1.0` / `2.1.0-beta` -> [2, 1, 0]; anything unreadable counts as 0.
fn parts(version: &str) -> Vec<u64> {
    version.trim_start_matches(['v', 'V']).split(['-', '+']).next().unwrap_or("").split('.').map(|p| p.parse().unwrap_or(0)).collect()
}

pub fn is_newer(current: &str, candidate: &str) -> bool {
    let (a, b) = (parts(current), parts(candidate));
    (0..a.len().max(b.len())).map(|i| (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0))).find(|(x, y)| x != y).is_some_and(|(x, y)| y > x)
}

fn pick_installer(assets: Vec<Asset>) -> Option<Asset> {
    assets.into_iter().find(|a| {
        let name = a.name.to_lowercase();
        name.ends_with(".exe") && name.contains("setup") || name.ends_with("-x64.exe")
    })
}

pub struct Updater {
    state: Mutex<Value>,
    installer: Mutex<Option<PathBuf>>,
    pending: Mutex<Option<(String, Option<String>)>>,
    notify: Box<dyn Fn(Value) + Send + Sync>,
    current: String,
}

impl Updater {
    pub fn new(current: &str, notify: Box<dyn Fn(Value) + Send + Sync>) -> Self {
        Self { state: Mutex::new(json!({ "status": "idle" })), installer: Mutex::new(None), pending: Mutex::new(None), notify, current: current.to_string() }
    }

    pub fn state(&self) -> Value {
        self.state.lock().unwrap().clone()
    }

    fn set(&self, next: Value) -> Value {
        *self.state.lock().unwrap() = next.clone();
        (self.notify)(next.clone());
        next
    }

    pub async fn check(&self) -> Value {
        self.set(json!({ "status": "checking" }));
        let client = match reqwest::Client::builder().user_agent("Blackbox-updater").build() {
            Ok(client) => client,
            Err(error) => return self.set(json!({ "status": "error", "message": format!("Update check failed: {error}") })),
        };
        let response = match client.get(LATEST_RELEASE).header("Accept", "application/vnd.github+json").timeout(std::time::Duration::from_secs(20)).send().await {
            Ok(response) => response,
            Err(error) => return self.set(json!({ "status": "error", "message": format!("Update check failed: {error}") })),
        };
        if response.status().as_u16() == 404 {
            return self.set(json!({ "status": "idle", "message": "No published release was found yet." }));
        }
        let release: Release = match response.error_for_status().map_err(|e| e.to_string()) {
            Ok(response) => match response.text().await.map_err(|e| e.to_string()).and_then(|body| serde_json::from_str::<Release>(&body).map_err(|e| e.to_string())) {
                Ok(release) => release,
                Err(error) => return self.set(json!({ "status": "error", "message": format!("Update check failed: {error}") })),
            },
            Err(error) => return self.set(json!({ "status": "error", "message": format!("Update check failed: {error}") })),
        };
        if !is_newer(&self.current, &release.tag_name) {
            return self.set(json!({ "status": "idle", "message": "You are up to date." }));
        }
        let version = release.tag_name.trim_start_matches(['v', 'V']).to_string();
        let Some(asset) = pick_installer(release.assets) else {
            return self.set(json!({ "status": "error", "message": "The newest release has no Windows installer attached." }));
        };
        *self.pending.lock().unwrap() = Some((asset.browser_download_url, asset.digest));
        self.set(json!({ "status": "available", "version": version, "notes": release.body }))
    }

    pub async fn download(&self) -> Result<Value, String> {
        let Some((url, digest)) = self.pending.lock().unwrap().clone() else { return Err("No update is ready to download.".into()) };
        let version = self.state().get("version").cloned().unwrap_or(Value::Null);
        self.set(json!({ "status": "downloading", "percent": 0, "version": version }));
        let result = self.fetch(&url, digest.as_deref(), &version).await;
        match result {
            Ok(path) => {
                *self.installer.lock().unwrap() = Some(path);
                Ok(self.set(json!({ "status": "ready", "version": version })))
            }
            Err(message) => Ok(self.set(json!({ "status": "error", "message": message }))),
        }
    }

    async fn fetch(&self, url: &str, digest: Option<&str>, version: &Value) -> Result<PathBuf, String> {
        let response = reqwest::Client::builder().user_agent("Blackbox-updater").build().map_err(|e| e.to_string())?.get(url).send().await.and_then(|r| r.error_for_status()).map_err(|e| format!("Update download failed: {e}"))?;
        let total = response.content_length().unwrap_or(0);
        let path = std::env::temp_dir().join("blackbox-update-setup.exe");
        let mut file = tokio::fs::File::create(&path).await.map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();
        let (mut got, mut last_percent) = (0u64, 0u64);
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| format!("Update download failed: {e}"))?;
            hasher.update(&bytes);
            file.write_all(&bytes).await.map_err(|e| e.to_string())?;
            got += bytes.len() as u64;
            if total > 0 {
                let percent = got * 100 / total;
                if percent != last_percent {
                    last_percent = percent;
                    self.set(json!({ "status": "downloading", "percent": percent, "version": version }));
                }
            }
        }
        file.flush().await.map_err(|e| e.to_string())?;
        if let Some(expected) = digest.and_then(|d| d.strip_prefix("sha256:")) {
            let actual: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
            if !actual.eq_ignore_ascii_case(expected) {
                let _ = tokio::fs::remove_file(&path).await;
                return Err("The downloaded update did not match its published checksum, so it was discarded.".into());
            }
        }
        Ok(path)
    }

    /// Start the downloaded installer; the caller then exits the app so the installer can replace it.
    pub fn install(&self) -> Result<(), String> {
        let path = self.installer.lock().unwrap().clone().ok_or("No downloaded update is ready to install.")?;
        std::process::Command::new(path).args(["/P", "/R", "/UPDATE"]).spawn().map_err(|e| format!("The installer could not start: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions_numerically() {
        assert!(is_newer("2.0.0", "v2.0.1") && is_newer("2.0.9", "2.1.0") && is_newer("2.9.0", "10.0.0"));
        assert!(!is_newer("2.0.0", "v2.0.0") && !is_newer("2.1.0", "2.0.9") && !is_newer("2.0.0", "2.0.0-beta"));
    }

    #[test]
    fn picks_the_windows_installer() {
        let asset = |name: &str| Asset { name: name.into(), browser_download_url: format!("https://x/{name}"), digest: None };
        let picked = pick_installer(vec![asset("latest.yml"), asset("Blackbox_2.1.0_x64-setup.exe"), asset("notes.txt")]).unwrap();
        assert_eq!(picked.name, "Blackbox_2.1.0_x64-setup.exe");
        assert!(pick_installer(vec![asset("source.zip")]).is_none());
    }
}
