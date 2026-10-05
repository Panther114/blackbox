//! Blackboard page parsing: HTML in, structured data out. These are the pure
//! parts of src/scraper/index.ts, so they can be tested with fixtures and need
//! no browser.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use scraper::{ElementRef, Html, Selector};
use url::Url;

use crate::files::{
    allowed_doc_ext_re, allowed_ext_from_name, extract_filename_from_url, has_blocked_extension, is_allowed_document_candidate, safely_decode,
    sanitize_filename,
};
use crate::markdown::{content_hash, html_to_markdown, stable_id};
use crate::model::{ContentItem, ContentItemKind, Course, RawFile, SidebarLink};

/// URL fragments that identify navigation or tool pages, never downloadable files.
const NAV_HREF_PATTERNS: &[&str] = &[
    "listContent.jsp",
    "displayContent.jsp",
    "courseMenuPalette",
    "javascript:",
    "execute/courseMain",
    "execute/announcement",
    "execute/blti",
    "execute/modulepage",
    "execute/viewSurvey",
    "execute/take_test_student",
    "execute/overview",
    "execute/gradebook",
    "execute/discussionboard",
    "execute/calendar",
    "webapps/calendar",
    "webapps/discussionboard",
    "webapps/blackboard/execute/announcement",
];
const SAFE_EXECUTE_PATTERNS: &[&str] = &["execute/content"];

fn selector(css: &str) -> Selector {
    Selector::parse(css).unwrap_or_else(|_| panic!("invalid selector: {css}"))
}

fn text_of(element: ElementRef) -> String {
    element.text().collect()
}

fn has_class(element: ElementRef, class: &str) -> bool {
    element.value().classes().any(|c| c == class)
}

/// The element itself or the nearest ancestor satisfying `test`.
fn closest<'a>(element: ElementRef<'a>, test: impl Fn(ElementRef<'a>) -> bool) -> Option<ElementRef<'a>> {
    if test(element) {
        return Some(element);
    }
    element.ancestors().filter_map(ElementRef::wrap).find(|candidate| test(*candidate))
}

pub fn absolute_url(href: &str, base: &str) -> Option<String> {
    if href.is_empty() {
        return None;
    }
    Url::parse(base).ok()?.join(href).ok().map(|url| url.to_string())
}

/// Join a link the way Blackboard pages write them: absolute links stay, others hang off the site root.
fn resolve_href(href: &str, base: &str) -> String {
    let clean = href.trim();
    if clean.starts_with("http") {
        clean.to_string()
    } else {
        format!("{base}{clean}")
    }
}

fn safe_name(text: &str) -> String {
    text.trim().replace(['/', '\\'], "_")
}

// ---------------------------------------------------------------------------
// Course identity
// ---------------------------------------------------------------------------

fn clean_course_id(raw: Option<&str>) -> String {
    let Some(raw) = raw else { return String::new() };
    let decoded = safely_decode(raw);
    decoded.split(['&', '?', '#']).next().unwrap_or("").trim().to_string()
}

/// Normalise a stored course id (older releases saved `_7247_1&url=`).
pub fn normalize_course_id(raw: &str) -> String {
    clean_course_id(Some(raw.trim()))
}

/// The Blackboard course id (e.g. `_123456_1`) behind any of the URL shapes Blackboard uses; empty when there is none.
pub fn extract_course_id(course_url: &str) -> String {
    static CANONICAL: OnceLock<Regex> = OnceLock::new();
    static LOOSE: OnceLock<Regex> = OnceLock::new();
    static COURSE_PARAM: OnceLock<Regex> = OnceLock::new();
    static ID_PARAM: OnceLock<Regex> = OnceLock::new();
    static PATH: OnceLock<Regex> = OnceLock::new();
    if course_url.is_empty() {
        return String::new();
    }
    let canonical = CANONICAL.get_or_init(|| Regex::new(r"^_?\d{2,}_\d+$").unwrap());
    let loose = LOOSE.get_or_init(|| Regex::new(r"^_[\w.-]+_\d+$").unwrap());

    let mut candidates: Vec<Option<String>> = Vec::new();
    let mut parsed_path = String::new();
    if let Ok(parsed) = Url::parse(course_url) {
        let query: Vec<(String, String)> = parsed.query_pairs().map(|(k, v)| (k.into_owned(), v.into_owned())).collect();
        let get = |key: &str| query.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
        candidates.push(get("course_id"));
        candidates.push(get("courseId"));
        candidates.push(get("id"));
        parsed_path = parsed.path().to_string();
    }
    let decoded = safely_decode(course_url);
    let course_param = COURSE_PARAM.get_or_init(|| Regex::new(r"[?&](?:course_id|courseId)=([^&]+)").unwrap());
    let id_param = ID_PARAM.get_or_init(|| Regex::new(r"[?&]id=([^&]+)").unwrap());
    candidates.push(course_param.captures(&decoded).map(|c| c[1].to_string()));
    candidates.push(id_param.captures(&decoded).map(|c| c[1].to_string()));

    for candidate in candidates {
        let id = clean_course_id(candidate.as_deref());
        if canonical.is_match(&id) {
            return id;
        }
        if !id.is_empty() && loose.is_match(&id) && !id.contains(['=', '&', '?']) {
            return id;
        }
    }
    let path_re = PATH.get_or_init(|| Regex::new(r"(?i)/(?:courses?|courseMain)/(_?[\w.-]+_\d+)").unwrap());
    path_re.captures(&parsed_path).map(|c| clean_course_id(Some(&c[1]))).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Course list, sidebar, folders
// ---------------------------------------------------------------------------

/// The user's courses from the portal page. Every course gets a unique, non-empty id.
pub fn parse_courses(html: &str, base_url: &str) -> Vec<Course> {
    let document = Html::parse_document(html);
    let primary = selector("ul.portletList-img.courseListing.coursefakeclass > li > a");
    let fallback = selector("ul.courseListing > li > a");
    let mut anchors: Vec<ElementRef> = document.select(&primary).collect();
    if anchors.is_empty() {
        anchors = document.select(&fallback).collect();
    }

    let mut used = HashSet::new();
    let mut courses = Vec::new();
    for anchor in anchors {
        let href = anchor.value().attr("href").unwrap_or("");
        let text = text_of(anchor);
        if href.is_empty() || text.is_empty() {
            continue;
        }
        let name = safe_name(&text);
        let url = resolve_href(href, base_url);
        let mut base_id = extract_course_id(&url);
        if base_id.is_empty() {
            base_id = format!("url-{}", &content_hash(&url)[..12]);
        }
        let mut id = base_id.clone();
        let mut suffix = 2;
        while used.contains(&id) {
            id = format!("{base_id}-{suffix}");
            suffix += 1;
        }
        used.insert(id.clone());
        courses.push(Course { id, name: name.clone(), url, path: sanitize_filename(&name) });
    }
    courses
}

/// Content sections from a course's menu. Tools (discussions, grades, ...) are skipped.
pub fn parse_sidebar_links(html: &str, base_url: &str, include_announcements: bool) -> Vec<SidebarLink> {
    static EXCLUDED: &[&str] = &["home page", "discussions", "groups", "tools", "help"];
    static TOOL_LIKE: OnceLock<Regex> = OnceLock::new();
    static CONTENT_LIKE: OnceLock<Regex> = OnceLock::new();
    static ANNOUNCEMENT: OnceLock<Regex> = OnceLock::new();
    let tool_like = TOOL_LIKE.get_or_init(|| Regex::new(r"(?i)discussion|group|tool|help|announcement|calendar|grade").unwrap());
    let content_like = CONTENT_LIKE.get_or_init(|| Regex::new(r"(?i)\bcontent\b").unwrap());
    let announcement = ANNOUNCEMENT.get_or_init(|| Regex::new(r"(?i)announcement").unwrap());

    let document = Html::parse_document(html);
    let anchors = selector("#courseMenuPalette_contents li a");
    let span = selector("span");
    let mut candidates = Vec::new();
    for anchor in document.select(&anchors) {
        let href = anchor.value().attr("href").unwrap_or("");
        let title = anchor.select(&span).next().and_then(|s| s.value().attr("title")).unwrap_or("");
        let raw_title = if title.is_empty() { text_of(anchor) } else { title.to_string() };
        let raw_title = raw_title.trim().to_string();
        if href.is_empty() || raw_title.is_empty() {
            continue;
        }
        let keep_announcement = include_announcements && announcement.is_match(&raw_title);
        if EXCLUDED.contains(&raw_title.to_lowercase().as_str()) || (tool_like.is_match(&raw_title) && !keep_announcement) {
            continue;
        }
        let title = safe_name(&raw_title);
        candidates.push(SidebarLink { title: title.clone(), url: resolve_href(href, base_url), path: sanitize_filename(&title) });
    }

    let content: Vec<SidebarLink> = candidates.iter().filter(|link| content_like.is_match(&link.title)).cloned().collect();
    let announcements: Vec<SidebarLink> =
        if include_announcements { candidates.iter().filter(|link| announcement.is_match(&link.title)).cloned().collect() } else { Vec::new() };
    let prioritized = if content.is_empty() { candidates } else { content.into_iter().chain(announcements).collect() };
    let mut seen = HashSet::new();
    prioritized.into_iter().filter(|link| seen.insert(link.url.clone())).collect()
}

/// Sub-folders listed on the current page, de-duplicated by URL.
pub fn parse_subfolders(html: &str, base_url: &str) -> Vec<SidebarLink> {
    let document = Html::parse_document(html);
    let anchors = selector("div.item.clearfix a");
    let mut seen = HashSet::new();
    let mut folders = Vec::new();
    for anchor in document.select(&anchors) {
        let href = anchor.value().attr("href").unwrap_or("");
        let text = text_of(anchor);
        if href.is_empty() || text.is_empty() || !href.contains("listContent.jsp") {
            continue;
        }
        let url = resolve_href(href, base_url);
        if !seen.insert(url.clone()) {
            continue;
        }
        let name = safe_name(&text);
        folders.push(SidebarLink { title: name.clone(), url, path: sanitize_filename(&name) });
    }
    folders
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
pub struct RawContentLink {
    pub href: String,
    pub text: String,
    pub in_attachments: bool,
    pub in_details: bool,
    pub near_attached_files: bool,
}

/// Every link inside the content list, with the context needed to judge it. `None` when the page has no content list.
pub fn parse_content_links(html: &str) -> Option<Vec<RawContentLink>> {
    static ATTACHED: OnceLock<Regex> = OnceLock::new();
    let attached = ATTACHED.get_or_init(|| Regex::new(r"(?i)attached files?").unwrap());
    let document = Html::parse_document(html);
    if document.select(&selector("#content_listContainer")).next().is_none() {
        return None;
    }
    let anchors = selector("#content_listContainer a[href]");
    let links = document
        .select(&anchors)
        .map(|anchor| {
            let parent_text = anchor.parent().and_then(ElementRef::wrap).map(text_of).unwrap_or_default();
            let item_text = closest(anchor, |e| has_class(e, "item")).map(text_of).unwrap_or_default();
            RawContentLink {
                href: anchor.value().attr("href").unwrap_or("").to_string(),
                text: text_of(anchor),
                in_attachments: closest(anchor, |e| has_class(e, "attachments")).is_some(),
                in_details: closest(anchor, |e| has_class(e, "details")).is_some(),
                near_attached_files: attached.is_match(&format!("{parent_text} {item_text}")),
            }
        })
        .collect();
    Some(links)
}

/// Keep the links that are downloadable documents, de-duplicated by absolute URL.
pub fn collect_download_candidates(raw_links: &[RawContentLink], base_url: &str, save_path: &str) -> Vec<RawFile> {
    let Ok(base) = Url::parse(base_url) else { return Vec::new() };
    let mut seen = HashSet::new();
    let mut files = Vec::new();

    for raw in raw_links {
        let href = raw.href.trim();
        let text = safely_decode(raw.text.trim());
        if href.is_empty() || NAV_HREF_PATTERNS.iter().any(|pattern| href.contains(pattern)) {
            continue;
        }
        let Some(full_url) = absolute_url(href, base_url) else { continue };
        let Ok(parsed) = Url::parse(&full_url) else { continue };
        if parsed.origin() != base.origin() || seen.contains(&full_url) {
            continue;
        }

        let is_bbcs = href.contains("/bbcswebdav/");
        let is_content_file = href.contains("content/file");
        let is_execute_content = href.contains("execute/content");
        let url_has_ext = allowed_doc_ext_re().is_match(parsed.path());
        let positive = is_bbcs
            || is_content_file
            || is_execute_content
            || raw.in_attachments
            || raw.near_attached_files
            || raw.in_details
            || allowed_ext_from_name(&text).is_some()
            || url_has_ext;
        if !positive {
            continue;
        }
        if href.contains("execute/") && !SAFE_EXECUTE_PATTERNS.iter().any(|pattern| href.contains(pattern)) {
            continue;
        }
        if has_blocked_extension(&text) || has_blocked_extension(&full_url) {
            continue;
        }
        if !is_allowed_document_candidate(Some(&text), Some(&full_url), None) && !is_bbcs && !is_content_file && !is_execute_content {
            continue;
        }

        seen.insert(full_url.clone());
        let name = if text.is_empty() { extract_filename_from_url(&full_url) } else { text };
        files.push(RawFile { name, url: full_url, path: save_path.to_string() });
    }
    files
}

// ---------------------------------------------------------------------------
// Readable content (instructions, assignments, announcements)
// ---------------------------------------------------------------------------

/// Items of the current content page, read-only. `None` when the page has neither a content list nor an announcement list.
pub fn parse_content_items(html: &str, course: &Course, section: &str, folder_path: &[String], page_url: &str, base_url: &str) -> Option<Vec<ContentItem>> {
    static DUE: OnceLock<Regex> = OnceLock::new();
    static POINTS: OnceLock<Regex> = OnceLock::new();
    static ANNOUNCEMENT: OnceLock<Regex> = OnceLock::new();
    static ASSIGNMENT_TEXT: OnceLock<Regex> = OnceLock::new();
    static ASSIGNMENT_URL: OnceLock<Regex> = OnceLock::new();
    let due = DUE.get_or_init(|| Regex::new(r"(?i)due[\s:]*([^\n]{1,80})").unwrap());
    let points = POINTS.get_or_init(|| Regex::new(r"(?i)points?[\s:]*([\d.]+)").unwrap());
    let announcement = ANNOUNCEMENT.get_or_init(|| Regex::new(r"(?i)announcement").unwrap());
    let assignment_text = ASSIGNMENT_TEXT.get_or_init(|| Regex::new(r"assignment|homework").unwrap());
    let assignment_url = ASSIGNMENT_URL.get_or_init(|| Regex::new(r"(?i)uploadassignment|assignment").unwrap());

    let document = Html::parse_document(html);
    let item_selector = if document.select(&selector("#content_listContainer")).next().is_some() {
        selector("#content_listContainer .liItem, #content_listContainer .item")
    } else if document.select(&selector("#announcementList, .announcementList")).next().is_some() {
        selector("#announcementList .announcement, #announcementList li, .announcementList .announcement, .announcementList li")
    } else {
        return None;
    };
    let title_selector = selector("h3, h2, .item h3, .itemTitle, a");
    let body_selector = selector(".details, .vtbegenerated, .itemDetails");
    let attachment_selector = selector(".attachments a[href], a[href*=\"bbcswebdav\"], a[href*=\"execute/content\"]");

    let is_announcement = announcement.is_match(&format!("{section} {page_url}"));
    let mut items = Vec::new();
    for (index, node) in document.select(&item_selector).enumerate() {
        let title_node = node.select(&title_selector).next();
        let raw_title = title_node.map(|t| text_of(t).trim().to_string()).unwrap_or_default();
        let title = if raw_title.is_empty() { format!("Course content {}", index + 1) } else { raw_title };
        let body_html = node.select(&body_selector).next().map(|b| b.inner_html()).unwrap_or_else(|| node.inner_html());
        let href = title_node.and_then(|t| t.value().attr("href")).unwrap_or("");
        let text = text_of(node);
        let source_url = absolute_url(href, base_url).unwrap_or_else(|| page_url.to_string());
        let lowered = text.to_lowercase();
        let is_assignment = !is_announcement && (assignment_text.is_match(&format!("{title} {lowered}")) || assignment_url.is_match(&source_url));
        let markdown = html_to_markdown(&body_html);
        if markdown.is_empty() && !is_assignment {
            continue;
        }
        let attachment_ids = node
            .select(&attachment_selector)
            .filter_map(|a| a.value().attr("href"))
            .filter(|href| !href.is_empty())
            .map(|href| stable_id("attachment", &absolute_url(href, base_url).unwrap_or_else(|| href.to_string())))
            .collect();
        items.push(ContentItem {
            id: stable_id("item", &format!("{}|{}|{}|{}", course.id, source_url, title, folder_path.join("/"))),
            kind: if is_announcement {
                ContentItemKind::Announcement
            } else if is_assignment {
                ContentItemKind::Assignment
            } else {
                ContentItemKind::Content
            },
            course_id: course.id.clone(),
            course_name: course.name.clone(),
            section_name: section.to_string(),
            folder_path: folder_path.to_vec(),
            title,
            instructions_markdown: markdown.clone(),
            source_url,
            available_at: None,
            due_at: due.captures(&text).map(|c| c[1].trim().to_string()),
            points: points.captures(&text).map(|c| c[1].to_string()),
            attachment_ids,
            content_hash: content_hash(&markdown),
        });
    }
    Some(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BASE: &str = "https://shs.blackboardchina.cn";

    fn link(href: &str, text: &str) -> RawContentLink {
        RawContentLink { href: href.into(), text: text.into(), ..Default::default() }
    }

    #[test]
    fn deduplicates_urls_and_keeps_valid_document_candidates() {
        let mut first = link("/webapps/blackboard/execute/content/file?cmd=view&content_id=_1_1", "Week 1 Slides.pptx");
        first.in_attachments = true;
        let results = collect_download_candidates(&[first.clone(), first], BASE, "/tmp/downloads");
        assert_eq!(results.len(), 1);
        assert!(results[0].name.contains(".pptx"));
    }

    #[test]
    fn uses_the_visible_text_extension_when_the_url_has_none() {
        let mut entry = link("/webapps/blackboard/content/listContentEditable.jsp?content_id=_2_1", "Syllabus.pdf");
        entry.in_details = true;
        assert_eq!(collect_download_candidates(&[entry], BASE, "/tmp").len(), 1);
    }

    #[test]
    fn rejects_navigation_tool_and_external_links() {
        let results = collect_download_candidates(
            &[
                link("/webapps/blackboard/content/listContent.jsp?course_id=_1_1", "Folder"),
                link("/webapps/discussionboard/do/forum?action=list_threads", "Discussion"),
                link("/webapps/blackboard/execute/take_test_student?course_id=_1_1", "Quiz"),
                link("https://example.com/file.pdf", "External PDF"),
            ],
            BASE,
            "/tmp",
        );
        assert!(results.is_empty());
    }

    #[test]
    fn rejects_unsupported_attachment_extensions() {
        let mut zip = link("/bbcswebdav/xid-1_1", "archive.zip");
        zip.in_attachments = true;
        let mut png = link("/bbcswebdav/xid-2_1", "photo.png");
        png.in_attachments = true;
        assert!(collect_download_candidates(&[zip, png], BASE, "/tmp").is_empty());
    }

    #[test]
    fn extracts_course_ids_from_every_url_shape() {
        assert_eq!(extract_course_id("https://bb.example.com/webapps/course?course_id=_123_1&mode=cpview"), "_123_1");
        assert_eq!(extract_course_id("https://shs.blackboardchina.cn/webapps/blackboard/execute/launcher?type=Course&id=_7247_1&url="), "_7247_1");
        assert!(!extract_course_id("https://bb.example.com/webapps/blackboard/execute/launcher?type=Course&id=_6999_1&url=").contains('&'));
        assert_eq!(extract_course_id("https://bb.example.com/ultra/courses/_5646_1/outline"), "_5646_1");
        assert_eq!(extract_course_id("https://bb.example.com/nope"), "");
        assert_eq!(extract_course_id(""), "");
    }

    #[test]
    fn repairs_ids_saved_by_older_releases() {
        assert_eq!(normalize_course_id("_7247_1&url="), "_7247_1");
        assert_eq!(normalize_course_id("  _44_1&url=%2Fwebapps  "), "_44_1");
        assert_eq!(normalize_course_id("_1454_1"), "_1454_1");
    }

    #[test]
    fn gives_every_course_a_unique_id() {
        let html = r#"<ul class="portletList-img courseListing coursefakeclass">
            <li><a href="/webapps/blackboard/execute/launcher?type=Course&id=_7247_1&url=">Math / 101</a></li>
            <li><a href="/webapps/blackboard/execute/launcher?type=Course&id=_7248_1&url=">Physics</a></li>
            <li><a href="/webapps/blackboard/execute/launcher?type=Course&id=_7247_1&url=">Math Duplicate</a></li>
            <li><a href="/some/page">No id</a></li></ul>"#;
        let courses = parse_courses(html, BASE);
        let ids: Vec<&str> = courses.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids[0], "_7247_1");
        assert_eq!(ids[1], "_7248_1");
        assert_eq!(ids[2], "_7247_1-2");
        assert!(ids[3].starts_with("url-"));
        assert_eq!(courses[0].name, "Math _ 101");
        assert!(courses[0].url.starts_with(BASE));
    }

    #[test]
    fn keeps_announcements_next_to_content_links_when_asked() {
        let html = r#"<div id="courseMenuPalette_contents"><ul>
            <li><a href="/webapps/blackboard/content/listContent.jsp?course_id=1"><span title="Course Content">x</span></a></li>
            <li><a href="/webapps/blackboard/execute/announcement?course_id=1"><span title="Announcements">x</span></a></li>
            <li><a href="/webapps/discussionboard/x"><span title="Discussions">x</span></a></li></ul></div>"#;
        let with: Vec<String> = parse_sidebar_links(html, BASE, true).into_iter().map(|l| l.title).collect();
        assert_eq!(with, vec!["Course Content", "Announcements"]);
        let without: Vec<String> = parse_sidebar_links(html, BASE, false).into_iter().map(|l| l.title).collect();
        assert_eq!(without, vec!["Course Content"]);
    }

    #[test]
    fn reads_content_links_with_their_context() {
        let html = r#"<div id="content_listContainer"><div class="item clearfix">
            <a href="/webapps/blackboard/content/listContent.jsp?content_id=_9_1">Week 1 folder</a>
            <div class="details"><p>Attached Files: <a href="/bbcswebdav/xid-1_1">notes.pdf</a></p></div></div></div>"#;
        let links = parse_content_links(html).unwrap();
        assert_eq!(links.len(), 2);
        let files = collect_download_candidates(&links, BASE, "/tmp");
        assert_eq!(files.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), vec!["notes.pdf"]);
        assert!(links[1].in_details);
        assert!(parse_content_links("<p>nothing</p>").is_none());
        let folders = parse_subfolders(html, BASE);
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].title, "Week 1 folder");
    }

    #[test]
    fn reads_instructions_and_flags_assignments() {
        let html = r#"<div id="content_listContainer"><ul>
            <li class="liItem"><h3>Read this first</h3><div class="details"><div class="vtbegenerated"><p>Read the syllabus.</p></div></div></li>
            <li class="liItem"><h3>Homework 1</h3><div class="details">
<p>Due: Friday</p>
<p>Points: 10</p>
</div></li></ul></div>"#;
        let course = Course { id: "_1_1".into(), name: "Math".into(), url: "u".into(), path: "Math".into() };
        let items = parse_content_items(html, &course, "Content", &[], "https://shs.blackboardchina.cn/p", BASE).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].kind, ContentItemKind::Content);
        assert!(items[0].instructions_markdown.contains("Read the syllabus."));
        assert_eq!(items[1].kind, ContentItemKind::Assignment);
        assert_eq!(items[1].due_at.as_deref(), Some("Friday"));
        assert_eq!(items[1].points.as_deref(), Some("10"));
        assert!(parse_content_items("<p>x</p>", &course, "Content", &[], "p", BASE).is_none());
    }
}
