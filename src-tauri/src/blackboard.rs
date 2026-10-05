//! Blackboard over plain HTTP: a cookie-keeping client, form login and page
//! fetching. When Blackboard needs a real browser (JavaScript-only login, consent
//! dialogs) `login` reports `NeedsBrowser` and the caller falls back to a web view.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use reqwest::cookie::Jar;
use scraper::{Html, Selector};
use url::Url;

use crate::parse::parse_courses;

pub const BASE_URL: &str = "https://shs.blackboardchina.cn";
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LoginOutcome {
    /// Logged in; carries the portal page that lists the courses.
    LoggedIn(String),
    /// The server showed the login form again: wrong username or password.
    Rejected,
    /// Something HTTP cannot do alone happened (no form, JavaScript-only flow, unreachable page).
    NeedsBrowser(String),
}

#[derive(Clone)]
pub struct BbClient {
    http: reqwest::Client,
    jar: Arc<Jar>,
    base_url: String,
}

fn sel(css: &str) -> Selector {
    Selector::parse(css).unwrap_or_else(|_| panic!("invalid selector: {css}"))
}

/// The login form's action URL and every field it would submit.
fn login_form(html: &str, page_url: &Url) -> Option<(Url, Vec<(String, String)>)> {
    let document = Html::parse_document(html);
    let form_selector = sel("form");
    let user_input = sel("input[name=\"user_id\"]");
    let inputs = sel("input[name]");
    for form in document.select(&form_selector) {
        if form.select(&user_input).next().is_none() {
            continue;
        }
        let action = form.value().attr("action").unwrap_or("");
        let action_url = page_url.join(action).ok()?;
        let fields = form
            .select(&inputs)
            .filter_map(|input| {
                let name = input.value().attr("name")?.to_string();
                let kind = input.value().attr("type").unwrap_or("text").to_lowercase();
                // Buttons other than the Blackboard `login` submit are not part of the payload.
                if matches!(kind.as_str(), "button" | "image" | "reset" | "file") || (kind == "submit" && name != "login") {
                    return None;
                }
                Some((name, input.value().attr("value").unwrap_or("").to_string()))
            })
            .collect();
        return Some((action_url, fields));
    }
    None
}

fn set_field(fields: &mut Vec<(String, String)>, name: &str, value: &str, add_if_missing: bool) {
    match fields.iter_mut().find(|(key, _)| key == name) {
        Some(entry) => entry.1 = value.to_string(),
        None if add_if_missing => fields.push((name.to_string(), value.to_string())),
        None => {}
    }
}

impl BbClient {
    pub fn new(base_url: &str) -> Result<Self, String> {
        let jar = Arc::new(Jar::default());
        let http = reqwest::Client::builder()
            .cookie_provider(jar.clone())
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self { http, jar, base_url: base_url.trim_end_matches('/').to_string() })
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The underlying client (used for downloads); it shares the login cookies.
    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }

    /// Adopt cookies from a browser login so later requests are authenticated.
    pub fn import_cookies(&self, cookies: &[(String, String)]) {
        if let Ok(url) = Url::parse(&self.base_url) {
            for (name, value) in cookies {
                self.jar.add_cookie_str(&format!("{name}={value}; Path=/"), &url);
            }
        }
    }

    pub async fn get_html(&self, url: &str) -> Result<String, String> {
        let response = self.http.get(url).timeout(Duration::from_secs(30)).send().await.map_err(describe)?;
        if !response.status().is_success() {
            return Err(format!("HTTP {} for {url}", response.status().as_u16()));
        }
        response.text().await.map_err(describe)
    }

    fn login_url(&self) -> String {
        format!("{}/webapps/login/", self.base_url)
    }

    pub async fn login(&self, username: &str, password: &str) -> LoginOutcome {
        let login_url = self.login_url();
        let page = match self.http.get(&login_url).timeout(Duration::from_secs(20)).send().await {
            Ok(response) => response,
            Err(error) => return LoginOutcome::NeedsBrowser(describe(error)),
        };
        let final_url = page.url().clone();
        let html = match page.text().await {
            Ok(text) => text,
            Err(error) => return LoginOutcome::NeedsBrowser(describe(error)),
        };
        let Some((action, mut fields)) = login_form(&html, &final_url) else {
            // No form: either already signed in or the page builds it with JavaScript.
            return if parse_courses(&html, &self.base_url).is_empty() { LoginOutcome::NeedsBrowser("The login form was not found.".into()) } else { LoginOutcome::LoggedIn(html) };
        };

        set_field(&mut fields, "user_id", username, true);
        set_field(&mut fields, "password", password, true);
        set_field(&mut fields, "login", "Login", true);
        set_field(&mut fields, "action", "login", false);
        set_field(&mut fields, "encoded_pw", &base64::engine::general_purpose::STANDARD.encode(password), false);
        set_field(&mut fields, "encoded_pw_unicode", ".", false);

        let response = match self.http.post(action).form(&fields).timeout(Duration::from_secs(30)).send().await {
            Ok(response) => response,
            Err(error) => return LoginOutcome::NeedsBrowser(describe(error)),
        };
        let result_url = response.url().clone();
        let result = match response.text().await {
            Ok(text) => text,
            Err(error) => return LoginOutcome::NeedsBrowser(describe(error)),
        };
        if !parse_courses(&result, &self.base_url).is_empty() {
            return LoginOutcome::LoggedIn(result);
        }
        // The portal may need one more request to render the course list.
        if let Ok(portal) = self.get_html(&format!("{}/", self.base_url)).await {
            if !parse_courses(&portal, &self.base_url).is_empty() {
                return LoginOutcome::LoggedIn(portal);
            }
        }
        if login_form(&result, &result_url).is_some() {
            LoginOutcome::Rejected
        } else {
            LoginOutcome::NeedsBrowser("Blackboard did not show the course list after signing in.".into())
        }
    }
}

/// A short, user-readable reason for a failed request.
pub fn describe(error: reqwest::Error) -> String {
    if error.is_timeout() {
        "Blackboard did not respond in time. Check your connection or VPN, then retry.".into()
    } else if error.is_connect() {
        "Blackboard could not be reached. Check your connection or VPN, then retry.".into()
    } else {
        error.to_string()
    }
}

#[cfg(test)]
pub mod mock {
    //! A tiny Blackboard look-alike for tests: login form, portal, one course with a file.
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    pub struct Server {
        pub base: String,
        stop: Arc<AtomicBool>,
    }

    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Relaxed);
        }
    }

    fn header(name: &str, value: &str) -> tiny_http::Header {
        tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
    }

    pub fn start(user: &'static str, password: &'static str) -> Server {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let origin = base.clone();
        thread::spawn(move || {
            while !flag.load(Ordering::Relaxed) {
                let Ok(Some(mut request)) = server.recv_timeout(std::time::Duration::from_millis(100)) else { continue };
                let url = request.url().to_string();
                let cookie = request.headers().iter().find(|h| h.field.equiv("Cookie")).map(|h| h.value.to_string()).unwrap_or_default();
                let signed_in = cookie.contains("session=ok");
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
                let method = if request.method().as_str() == "HEAD" { "GET" } else { request.method().as_str() };
                let (status, content_type, payload, extra): (u16, &str, Vec<u8>, Vec<tiny_http::Header>) = match (method, url.split('?').next().unwrap_or("")) {
                    ("GET", "/webapps/login/") => (200, "text/html", br#"<form action="/webapps/login/" method="post"><input type="hidden" name="blackboard.platform.security.NonceUtil.nonce" value="n123"><input id="user_id" name="user_id"><input type="password" name="password"><input type="hidden" name="encoded_pw" value=""><input type="hidden" name="action" value="login"><input type="submit" name="login" value="Login"></form>"#.to_vec(), vec![]),
                    ("POST", "/webapps/login/") => {
                        let ok = body.contains(&format!("user_id={user}")) && body.contains(&format!("password={password}")) && body.contains("nonce=n123");
                        if ok {
                            (302, "text/html", vec![], vec![header("Set-Cookie", "session=ok; Path=/"), header("Location", "/portal")])
                        } else {
                            (200, "text/html", br#"<form action="/webapps/login/" method="post"><input id="user_id" name="user_id"><input type="password" name="password"></form><p>Invalid</p>"#.to_vec(), vec![])
                        }
                    }
                    ("GET", "/portal") if signed_in => (200, "text/html", br#"<ul class="portletList-img courseListing coursefakeclass"><li><a href="/webapps/blackboard/execute/launcher?type=Course&id=_11_1&url=">Mock Course</a></li></ul>"#.to_vec(), vec![]),
                    ("GET", "/webapps/blackboard/execute/launcher") if signed_in => (200, "text/html", br#"<div id="courseMenuPalette_contents"><ul><li><a href="/content/list"><span title="Course Content">c</span></a></li></ul></div>"#.to_vec(), vec![]),
                    ("GET", "/content/list") if signed_in => (200, "text/html", br#"<div id="content_listContainer"><div class="item clearfix"><a href="/folder/1/listContent.jsp">Week 1</a><div class="details">Attached Files: <a href="/bbcswebdav/xid-1_1">Lecture.pdf</a></div></div></div>"#.to_vec(), vec![]),
                    ("GET", "/folder/1/listContent.jsp") if signed_in => (200, "text/html", br#"<div id="content_listContainer"><li class="liItem"><h3>Notes</h3><div class="details"><div class="vtbegenerated"><p>Read chapter 1.</p></div><a href="/bbcswebdav/xid-2_1">Slides.pptx</a></div></li></div>"#.to_vec(), vec![]),
                    ("GET", "/dup/1") if signed_in => (200, "application/pdf", b"week-1".to_vec(), vec![]),
                    ("GET", "/dup/2") if signed_in => (200, "application/pdf", b"week-2".to_vec(), vec![]),
                    (_, p) if p.starts_with("/bbcswebdav/") && signed_in => {
                        let (mime, name, data): (&str, &str, &[u8]) = if p.contains("xid-1") { ("application/pdf", "Lecture.pdf", b"%PDF-lecture") } else { ("application/vnd.openxmlformats-officedocument.presentationml.presentation", "Slides.pptx", b"pptx-bytes") };
                        let _ = name;
                        (200, mime, data.to_vec(), vec![header("Content-Disposition", &format!("attachment; filename=\"{name}\""))])
                    }
                    _ => (if signed_in { 404 } else { 302 }, "text/html", vec![], if signed_in { vec![] } else { vec![header("Location", "/webapps/login/")] }),
                };
                let mut response = tiny_http::Response::from_data(payload).with_status_code(status).with_header(header("Content-Type", content_type));
                for h in extra {
                    response = response.with_header(h);
                }
                let _ = request.respond(response);
                let _ = &origin;
            }
        });
        Server { base, stop }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn logs_in_through_the_form_and_keeps_the_session() {
        let server = mock::start("G123", "secretpw");
        let client = BbClient::new(&server.base).unwrap();
        let LoginOutcome::LoggedIn(portal) = client.login("G123", "secretpw").await else { panic!("expected a login") };
        let courses = parse_courses(&portal, client.base_url());
        assert_eq!(courses.len(), 1);
        assert_eq!(courses[0].id, "_11_1");
        // The cookie from the login is reused by later requests.
        assert!(client.get_html(&format!("{}/content/list", server.base)).await.unwrap().contains("Lecture.pdf"));
    }

    #[tokio::test]
    async fn reports_wrong_credentials_instead_of_asking_for_a_browser() {
        let server = mock::start("G123", "right");
        let client = BbClient::new(&server.base).unwrap();
        assert_eq!(client.login("G123", "wrong").await, LoginOutcome::Rejected);
    }

    #[tokio::test]
    async fn asks_for_a_browser_when_the_site_is_unreachable() {
        let client = BbClient::new("http://127.0.0.1:1").unwrap();
        assert!(matches!(client.login("a", "b").await, LoginOutcome::NeedsBrowser(_)));
    }
}
