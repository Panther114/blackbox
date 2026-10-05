#![allow(dead_code)]

mod blackboard;
mod downloader;
mod export;
mod files;
mod markdown;
mod model;
mod parse;
mod pipeline;
mod ledger;
mod settings;
mod summary;
mod timeutil;

use serde_json::{json, Value};
use tauri::window::{Effect, EffectsBuilder};
use tauri::{Manager, Theme};

/// Which window material the shell managed to apply ("mica" or "none").
struct Shell {
    material: &'static str,
}

fn user_dir(var: &str, fallback: &str) -> String {
    std::env::var(var).unwrap_or_else(|_| fallback.to_string())
}

fn data_dir() -> String {
    format!("{}\\blackbox\\data", user_dir("APPDATA", "."))
}

/// Single entry point the web UI calls through its `window.blackboxGui` bridge.
/// Methods are ported to Rust one stage at a time; the rest report clearly
/// that they are not available yet instead of failing silently.
#[tauri::command]
fn bridge(method: String, _args: Value) -> Result<Value, String> {
    match method.as_str() {
        "getVersion" => Ok(json!(env!("CARGO_PKG_VERSION"))),
        "loadConfig" => Ok(json!({
            "hasCredentials": false,
            "username": "",
            "password": "",
            "passwordStored": false,
            "passwordReadable": false,
            "downloadDir": format!("{}\\Downloads\\Blackbox", user_dir("USERPROFILE", ".")),
            "headless": true,
            "courseFilter": "",
            "autoCheckUpdates": true,
            "blockedCourses": []
        })),
        "getPaths" => {
            let data = data_dir();
            Ok(json!({
                "downloads": format!("{}\\Downloads\\Blackbox", user_dir("USERPROFILE", ".")),
                "logs": format!("{}\\logs", data),
                "summary": format!("{}\\logs\\latest-summary.txt", data)
            }))
        }
        "getUpdateState" => Ok(json!({ "status": "idle", "message": "Updates arrive in a later build." })),
        "getAgentStatus" => Ok(json!({ "busy": false, "configured": false })),
        _ => Err("This action is not available in the Tauri preview build yet.".into()),
    }
}

#[tauri::command]
fn shell_info(state: tauri::State<Shell>) -> Value {
    json!({ "material": state.material })
}

pub fn run() {
    // Developer hook: expose the WebView2 DevTools port so a script can capture a hidden window.
    if let Ok(port) = std::env::var("BLACKBOX_CDP_PORT") {
        std::env::set_var(
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            format!("--remote-debugging-port={port}"),
        );
    }

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![bridge, shell_info])
        .setup(|app| {
            let window = app.get_webview_window("main").expect("main window");
            let _ = window.set_theme(Some(Theme::Dark));
            // Mica needs Windows 11 22H2+; older builds report an error and keep the flat dark ground.
            let mica = window
                .set_effects(EffectsBuilder::new().effect(Effect::Mica).build())
                .is_ok();
            app.manage(Shell { material: if mica { "mica" } else { "none" } });
            if std::env::var("BLACKBOX_HIDDEN").is_err() {
                let _ = window.show();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Blackbox");
}
