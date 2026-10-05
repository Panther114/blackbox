//! User settings (settings.json, compatible with the Electron build) and the
//! password store (Windows DPAPI).

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::BlockedCourse;
use crate::parse::normalize_course_id;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub username: String,
    pub download_dir: String,
    pub headless: bool,
    pub course_filter: String,
    pub auto_check_updates: bool,
    pub blocked_courses: Vec<BlockedCourse>,
}

pub fn default_download_dir() -> String {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join("Downloads").join("Blackbox").to_string_lossy().into_owned()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            username: String::new(),
            download_dir: default_download_dir(),
            headless: true,
            course_filter: String::new(),
            auto_check_updates: true,
            blocked_courses: Vec::new(),
        }
    }
}

/// Blocked courses with repaired ids, no duplicates and no unnamed entries.
pub fn normalize_blocked_courses(value: &Value) -> Vec<BlockedCourse> {
    let Some(entries) = value.as_array() else { return Vec::new() };
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for entry in entries {
        let Some(record) = entry.as_object() else { continue };
        let id = record.get("id").and_then(Value::as_str).map(normalize_course_id).unwrap_or_default();
        let name = record.get("name").and_then(Value::as_str).map(|n| n.trim().to_string()).unwrap_or_default();
        if id.is_empty() || name.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        out.push(BlockedCourse { id, name });
    }
    out
}

impl Settings {
    /// Every field is coerced on its own so a hand-edited or partly corrupt file never poisons the app.
    pub fn from_json(value: &Value) -> Self {
        let defaults = Self::default();
        let text = |key: &str, fallback: &str| value.get(key).and_then(Value::as_str).unwrap_or(fallback).to_string();
        let flag = |key: &str, fallback: bool| value.get(key).and_then(Value::as_bool).unwrap_or(fallback);
        let download_dir = value.get("downloadDir").and_then(Value::as_str).filter(|d| !d.trim().is_empty()).unwrap_or(&defaults.download_dir).to_string();
        Self {
            username: text("username", ""),
            download_dir,
            headless: flag("headless", defaults.headless),
            course_filter: text("courseFilter", ""),
            auto_check_updates: flag("autoCheckUpdates", defaults.auto_check_updates),
            blocked_courses: normalize_blocked_courses(value.get("blockedCourses").unwrap_or(&Value::Null)),
        }
    }

    pub fn load(file: &Path) -> Self {
        fs::read_to_string(file).ok().and_then(|text| serde_json::from_str::<Value>(&text).ok()).map(|v| Self::from_json(&v)).unwrap_or_default()
    }

    pub fn save(&self, file: &Path) -> Result<(), String> {
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(self).map_err(|e| e.to_string())?;
        fs::write(file, format!("{json}\n")).map_err(|e| e.to_string())
    }
}

// ---------------------------------------------------------------------------
// Password (Windows DPAPI: only this Windows user can decrypt the file)
// ---------------------------------------------------------------------------

#[cfg(windows)]
mod dpapi {
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB};

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr() as *mut u8 }
    }

    fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        // SAFETY: the OS allocated `pbData` with `cbData` bytes; it is copied and then freed exactly once.
        unsafe {
            let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
            LocalFree(out.pbData as _);
            bytes
        }
    }

    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        // SAFETY: `input` points at live memory for the call; `out` receives an OS-owned buffer.
        let ok = unsafe { CryptProtectData(&input, null(), null(), null(), null(), 0, &mut out) };
        if ok == 0 {
            return Err("The Windows credential store could not encrypt the password.".into());
        }
        Ok(take(out))
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        let input = blob(data);
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        // SAFETY: as above.
        let ok = unsafe { CryptUnprotectData(&input, null_mut(), null(), null(), null(), 0, &mut out) };
        if ok == 0 {
            return Err("The saved password could not be unlocked on this account.".into());
        }
        Ok(take(out))
    }
}

#[cfg(not(windows))]
mod dpapi {
    pub fn protect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("Secure password storage is only available on Windows.".into())
    }
    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>, String> {
        Err("Secure password storage is only available on Windows.".into())
    }
}

pub struct PasswordStore {
    file: PathBuf,
}

impl PasswordStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { file: data_dir.join("credentials.dpapi") }
    }

    pub fn exists(&self) -> bool {
        self.file.exists()
    }

    pub fn save(&self, password: &str) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&self.file, dpapi::protect(password.as_bytes())?).map_err(|e| e.to_string())
    }

    /// Empty when nothing is stored or it cannot be unlocked.
    pub fn read(&self) -> String {
        fs::read(&self.file).ok().and_then(|bytes| dpapi::unprotect(&bytes).ok()).and_then(|plain| String::from_utf8(plain).ok()).unwrap_or_default()
    }

    pub fn clear(&self) {
        let _ = fs::remove_file(&self.file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn repairs_and_deduplicates_blocked_courses() {
        let value = json!([
            { "id": "_7247_1&url=", "name": "Writing Center 2025-2026" },
            { "id": "_7247_1", "name": "Duplicate entry" },
            { "id": "", "name": "No id" },
            "not-an-object"
        ]);
        assert_eq!(normalize_blocked_courses(&value), vec![BlockedCourse { id: "_7247_1".into(), name: "Writing Center 2025-2026".into() }]);
        assert!(normalize_blocked_courses(&json!("nope")).is_empty());
    }

    #[test]
    fn coerces_every_field_on_its_own() {
        let settings = Settings::from_json(&json!({ "username": 42, "downloadDir": null, "headless": "yes", "courseFilter": "x", "autoCheckUpdates": false }));
        assert_eq!(settings.username, "");
        assert_eq!(settings.download_dir, default_download_dir());
        assert!(settings.headless);
        assert_eq!(settings.course_filter, "x");
        assert!(!settings.auto_check_updates);
    }

    #[test]
    fn settings_round_trip_through_a_file() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("data").join("settings.json");
        let mut settings = Settings::default();
        settings.username = "G123".into();
        settings.blocked_courses.push(BlockedCourse { id: "_1_1".into(), name: "Math".into() });
        settings.save(&file).unwrap();
        assert_eq!(Settings::load(&file), settings);
        assert_eq!(Settings::load(&dir.path().join("missing.json")), Settings::default());
    }

    #[cfg(windows)]
    #[test]
    fn password_round_trips_through_dpapi_without_storing_plaintext() {
        let dir = tempdir().unwrap();
        let store = PasswordStore::new(dir.path());
        assert!(!store.exists() && store.read().is_empty());
        store.save("correct horse battery").unwrap();
        assert!(store.exists());
        assert_eq!(store.read(), "correct horse battery");
        let raw = fs::read(dir.path().join("credentials.dpapi")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("correct horse"));
        store.clear();
        assert!(!store.exists());
    }
}
