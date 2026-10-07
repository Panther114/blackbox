//! Sign in through a real (web view) window when plain HTTP cannot finish the
//! login, or when the user asked for the visible browser. The window is
//! incognito, lives only for the sign-in, and hands its cookies to the HTTP client.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::pipeline::BrowserLogin;

const LABEL: &str = "signin";
const HIDDEN_TIMEOUT: Duration = Duration::from_secs(120);
const VISIBLE_TIMEOUT: Duration = Duration::from_secs(300);

/// Runs inside the Blackboard login page: fills the form, accepts the consent box and presses Login once.
const FILL_SCRIPT: &str = r#"
(function () {
  if (!/\/webapps\/login/i.test(location.pathname)) return;
  var USER = __USER__, PASS = __PASS__, pressed = false, ticks = 0;
  function setValue(el, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function visible(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }
  function consent() {
    var direct = document.querySelector('#agree_button, #onetrust-accept-btn-handler');
    if (visible(direct)) { direct.click(); return true; }
    var buttons = document.querySelectorAll('.lb-wrapper button, [role="dialog"] button');
    for (var i = 0; i < buttons.length; i++) {
      if (visible(buttons[i]) && /agree|accept|^ok$|我同意|确定/i.test(buttons[i].textContent.trim())) { buttons[i].click(); return true; }
    }
    return false;
  }
  var timer = setInterval(function () {
    if (++ticks > 400) { clearInterval(timer); return; }
    var user = document.querySelector('#user_id'), pass = document.querySelector('#password'), go = document.querySelector('#entry-login');
    if (!user || !pass || !go) return;
    if (pressed) return;
    consent();
    setValue(user, USER);
    setValue(pass, PASS);
    pressed = true;
    setTimeout(function () { if (!consent()) { /* nothing was in the way */ } go.click(); }, 250);
  }, 300);
})();
"#;

struct CloseOnDrop(tauri::WebviewWindow);

impl Drop for CloseOnDrop {
    fn drop(&mut self) {
        let _ = self.0.close();
    }
}

fn script_for(username: &str, password: &str) -> String {
    FILL_SCRIPT.replace("__USER__", &serde_json::to_string(username).unwrap_or_default()).replace("__PASS__", &serde_json::to_string(password).unwrap_or_default())
}

fn is_session_cookie(name: &str) -> bool {
    let lower = name.to_lowercase();
    lower == "jsessionid" || lower == "s_session_id" || lower == "session_id"
}

async fn sign_in(app: AppHandle, site: String, username: String, password: String, visible: bool) -> Result<Vec<(String, String)>, String> {
    if let Some(old) = app.get_webview_window(LABEL) {
        let _ = old.close();
    }
    let login_url = format!("{}/webapps/login/", site.trim_end_matches('/'));
    let base = url::Url::parse(&site).map_err(|e| e.to_string())?;
    let window = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::External(login_url.parse().map_err(|e: url::ParseError| e.to_string())?))
        .title("Blackbox - Blackboard sign-in")
        .inner_size(960.0, 720.0)
        .visible(visible)
        .center()
        .incognito(true)
        .initialization_script(script_for(&username, &password))
        .build()
        .map_err(|e| format!("The sign-in window could not open: {e}"))?;

    // Cancelling the sign-in drops this future; the window must not outlive it.
    let _closer = CloseOnDrop(window.clone());
    let limit = if visible { VISIBLE_TIMEOUT } else { HIDDEN_TIMEOUT };
    let started = Instant::now();
    let result = loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if started.elapsed() > limit {
            break Err(if visible {
                "Blackboard sign-in did not finish in time. Complete the sign-in in the window, or retry.".to_string()
            } else {
                "Blackboard sign-in did not finish. Turn on Visible browser in Credentials to see what Blackboard is asking for, then retry.".to_string()
            });
        }
        let Some(window) = app.get_webview_window(LABEL) else {
            break Err("The sign-in window was closed before signing in.".to_string());
        };
        let Ok(current) = window.url() else { continue };
        let on_login = current.path().to_lowercase().contains("/webapps/login");
        if on_login || current.host_str() != base.host_str() || started.elapsed() < Duration::from_secs(1) {
            continue;
        }
        // Cookie access has to leave the UI thread, or the web view deadlocks.
        let probe = window.clone();
        let target = base.clone();
        let cookies = tokio::task::spawn_blocking(move || probe.cookies_for_url(target)).await.map_err(|e| e.to_string())?;
        let Ok(cookies) = cookies else { continue };
        if cookies.iter().any(|c| is_session_cookie(c.name())) {
            break Ok(cookies.iter().map(|c| (c.name().to_string(), c.value().to_string())).collect());
        }
    };
    let _ = window.close();
    result
}

pub fn browser_login(app: AppHandle, site: String) -> BrowserLogin {
    Arc::new(move |username, password, visible| {
        let (app, site) = (app.clone(), site.clone());
        Box::pin(sign_in(app, site, username, password, visible))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credentials_are_embedded_as_escaped_literals() {
        let script = script_for("G\"1", "p\\w'd</script>");
        assert!(script.contains(r#"USER = "G\"1""#));
        assert!(script.contains(r#"PASS = "p\\w'd</script>""#));
        assert!(!script.contains("__USER__") && !script.contains("__PASS__"));
    }

    #[test]
    fn recognises_blackboard_session_cookies() {
        assert!(is_session_cookie("JSESSIONID") && is_session_cookie("s_session_id") && !is_session_cookie("web_client_cache_guid"));
    }
}
