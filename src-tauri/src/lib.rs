#![allow(dead_code)]

mod app;
mod blackboard;
mod downloader;
mod export;
mod files;
mod ledger;
mod markdown;
mod model;
mod parse;
mod pipeline;
mod settings;
mod summary;
mod timeutil;
mod transfer;
mod updater;
mod weblogin;

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::window::{Effect, EffectsBuilder};
use tauri::{AppHandle, Emitter, Manager, State, Theme};
use tauri_plugin_dialog::DialogExt;

use app::{app_paths, describe_event, write_log, Core};
use downloader::Emit;
use pipeline::Pipeline;
use updater::Updater;

/// Which window material the shell managed to apply ("mica" or "none").
struct Shell {
    material: &'static str,
}

fn data_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into())).join("blackbox").join("data")
}

/// Open a folder in Explorer, creating it first so "Open downloads" never fails on a fresh install.
fn open_folder(path: &Path) -> Result<Value, String> {
    std::fs::create_dir_all(path).map_err(|e| format!("The folder could not be created: {e}"))?;
    std::process::Command::new("explorer.exe").arg(path).spawn().map_err(|e| format!("Explorer could not open the folder: {e}"))?;
    Ok(json!(""))
}

/// Single entry point the web UI calls through its `window.blackboxGui` bridge.
#[tauri::command]
async fn bridge(handle: AppHandle, core: State<'_, Arc<Core>>, method: String, args: Vec<Value>) -> Result<Value, String> {
    match method.as_str() {
        "openDownloads" => open_folder(&core.downloads_dir()),
        "openLogs" => open_folder(&core.logs_dir()),
        "chooseDownloadDirectory" => {
            let start = core.downloads_dir();
            let picked = tauri::async_runtime::spawn_blocking(move || {
                let mut dialog = handle.dialog().file().set_title("Choose download directory");
                if start.exists() {
                    dialog = dialog.set_directory(&start);
                }
                dialog.blocking_pick_folder()
            })
            .await
            .map_err(|e| e.to_string())?;
            Ok(match picked.and_then(|p| p.into_path().ok()) {
                Some(path) => json!(path),
                None => Value::Null,
            })
        }
        "installUpdate" => {
            core.updater.install()?;
            // Give the installer a moment to start before this process lets go of its files.
            let exiting = handle.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(600)).await;
                exiting.exit(0);
            });
            Ok(json!({ "ok": true }))
        }
        _ => core.call(&method, &args).await,
    }
}

#[tauri::command]
fn shell_info(state: State<Shell>) -> Value {
    json!({ "material": state.material })
}

fn build_core(handle: &AppHandle) -> Arc<Core> {
    let dir = data_dir();
    let version = env!("CARGO_PKG_VERSION").to_string();
    let events = handle.clone();
    let log_dir = dir.clone();
    let emit: Emit = Arc::new(move |name, payload| {
        if let Some((level, message)) = describe_event(name, &payload) {
            write_log(&log_dir, level, &message);
        }
        let _ = events.emit("workflow:event", json!({ "type": name, "payload": payload }));
    });
    let pipeline = Arc::new(Pipeline::new(emit.clone(), app_paths(&dir), Some(weblogin::browser_login(handle.clone()))));
    let notifier = handle.clone();
    let updater = Arc::new(Updater::new(&version, Box::new(move |state| {
        let _ = notifier.emit("workflow:event", json!({ "type": "update:state", "payload": state }));
    })));
    Arc::new(Core { data_dir: dir, pipeline, updater, emit, version })
}

/// Look for updates shortly after start and then every six hours, while the setting is on.
fn schedule_update_checks(core: Arc<Core>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(10)).await;
        loop {
            if core.settings().auto_check_updates {
                let _ = core.updater.check().await;
            }
            tokio::time::sleep(Duration::from_secs(6 * 60 * 60)).await;
        }
    });
}

pub fn run() {
    // Developer hook: expose the WebView2 DevTools port so a script can capture a hidden window.
    if let Ok(port) = std::env::var("BLACKBOX_CDP_PORT") {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", format!("--remote-debugging-port={port}"));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![bridge, shell_info])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            let _ = window.set_theme(Some(Theme::Dark));
            // Mica needs Windows 11 22H2+; older builds report an error and keep the flat dark ground.
            let mica = window.set_effects(EffectsBuilder::new().effect(Effect::Mica).build()).is_ok();
            app.manage(Shell { material: if mica { "mica" } else { "none" } });
            let core = build_core(app.handle());
            schedule_update_checks(core.clone());
            app.manage(core);
            if std::env::var("BLACKBOX_HIDDEN").is_err() {
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Blackbox");
}
