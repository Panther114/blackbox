//! Stable ids and a small HTML-to-Markdown normalizer for Blackboard content
//! (port of src/agent/markdown.ts).

use std::cell::RefCell;
use std::sync::OnceLock;

use regex::{Captures, Regex};
use sha2::{Digest, Sha256};
use url::Url;

fn hex_sha256(input: &str) -> String {
    Sha256::digest(input.as_bytes()).iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn stable_id(prefix: &str, input: &str) -> String {
    format!("{prefix}_{}", &hex_sha256(input)[..16])
}

pub fn content_hash(markdown: &str) -> String {
    hex_sha256(markdown.replace("\r\n", "\n").trim())
}

const CODE_TOKEN: &str = "\u{0}BLACKBOXCODE";

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).unwrap())
}

fn strip_tags(value: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    re(&RE, r"<[^>]+>").replace_all(value, " ").into_owned()
}

fn decode_html(value: &str) -> String {
    static NBSP: OnceLock<Regex> = OnceLock::new();
    static AMP: OnceLock<Regex> = OnceLock::new();
    static LT: OnceLock<Regex> = OnceLock::new();
    static GT: OnceLock<Regex> = OnceLock::new();
    static QUOT: OnceLock<Regex> = OnceLock::new();
    static APOS: OnceLock<Regex> = OnceLock::new();
    static NUMERIC: OnceLock<Regex> = OnceLock::new();
    let out = re(&NBSP, r"(?i)&nbsp;").replace_all(value, " ");
    let out = re(&AMP, r"(?i)&amp;").replace_all(&out, "&");
    let out = re(&LT, r"(?i)&lt;").replace_all(&out, "<");
    let out = re(&GT, r"(?i)&gt;").replace_all(&out, ">");
    let out = re(&QUOT, r"(?i)&quot;").replace_all(&out, "\"");
    let out = re(&APOS, r"(?i)&#39;").replace_all(&out, "'");
    // Invalid numeric entities (surrogates, out of range) are dropped rather than failing the conversion.
    re(&NUMERIC, r"&#(\d+);")
        .replace_all(&out, |caps: &Captures| caps[1].parse::<u32>().ok().and_then(char::from_u32).map(String::from).unwrap_or_default())
        .into_owned()
}

fn is_safe_link(href: &str) -> bool {
    let Ok(base) = Url::parse("https://example.invalid") else { return false };
    base.join(href).map(|url| matches!(url.scheme(), "https" | "http" | "mailto")).unwrap_or(false)
}

pub fn html_to_markdown(html: &str) -> String {
    static SCRIPT: OnceLock<Regex> = OnceLock::new();
    static STYLE: OnceLock<Regex> = OnceLock::new();
    static PRE_CODE: OnceLock<Regex> = OnceLock::new();
    static PRE: OnceLock<Regex> = OnceLock::new();
    static CODE: OnceLock<Regex> = OnceLock::new();
    static HEADING: OnceLock<Regex> = OnceLock::new();
    static ITEM: OnceLock<Regex> = OnceLock::new();
    static BREAK: OnceLock<Regex> = OnceLock::new();
    static BLOCK_END: OnceLock<Regex> = OnceLock::new();
    static ANCHOR: OnceLock<Regex> = OnceLock::new();
    static AFTER_NL: OnceLock<Regex> = OnceLock::new();
    static BEFORE_NL: OnceLock<Regex> = OnceLock::new();
    static MANY_NL: OnceLock<Regex> = OnceLock::new();
    static RESTORE: OnceLock<Regex> = OnceLock::new();

    // Code survives the final tag-strip: it is swapped for a token, then restored verbatim.
    let protected: RefCell<Vec<String>> = RefCell::new(Vec::new());
    let protect = |value: String| -> String {
        let mut segments = protected.borrow_mut();
        segments.push(value);
        format!("{CODE_TOKEN}{}\u{0}", segments.len() - 1)
    };

    let out = re(&SCRIPT, r"(?is)<script.*?</script>").replace_all(html, "").into_owned();
    let out = re(&STYLE, r"(?is)<style.*?</style>").replace_all(&out, "").into_owned();
    let out = re(&PRE_CODE, r"(?is)<pre[^>]*>\s*<code[^>]*>(.*?)</code>\s*</pre>")
        .replace_all(&out, |caps: &Captures| format!("\n\n{}\n\n", protect(format!("```\n{}\n```", decode_html(&caps[1]).trim()))))
        .into_owned();
    let out = re(&PRE, r"(?is)<pre[^>]*>(.*?)</pre>")
        .replace_all(&out, |caps: &Captures| format!("\n\n{}\n\n", protect(format!("```\n{}\n```", decode_html(&caps[1]).trim()))))
        .into_owned();
    let out = re(&CODE, r"(?is)<code[^>]*>(.*?)</code>")
        .replace_all(&out, |caps: &Captures| protect(format!("`{}`", decode_html(&caps[1]).trim())))
        .into_owned();
    let out = re(&HEADING, r"(?is)<h([1-6])[^>]*>(.*?)</h[1-6]>")
        .replace_all(&out, |caps: &Captures| {
            let level: usize = caps[1].parse().unwrap_or(1);
            format!("\n\n{} {}\n\n", "#".repeat(level), decode_html(&strip_tags(&caps[2])).trim())
        })
        .into_owned();
    let out = re(&ITEM, r"(?is)<li[^>]*>(.*?)</li>")
        .replace_all(&out, |caps: &Captures| format!("\n- {}", decode_html(&strip_tags(&caps[1])).trim()))
        .into_owned();
    let out = re(&BREAK, r"(?i)<br\s*/?>").replace_all(&out, "\n").into_owned();
    let out = re(&BLOCK_END, r"(?i)</(?:p|div|section|article|tr|table|ul|ol)>").replace_all(&out, "\n").into_owned();
    let out = re(&ANCHOR, r#"(?is)<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)</a>"#)
        .replace_all(&out, |caps: &Captures| {
            let href = &caps[1];
            let text = decode_html(&strip_tags(&caps[2])).trim().to_string();
            let label = if text.is_empty() { href.to_string() } else { text };
            if is_safe_link(href) {
                format!("[{label}]({href})")
            } else {
                label
            }
        })
        .into_owned();

    let out = decode_html(&strip_tags(&out));
    let out = re(&AFTER_NL, r"\n[ \t]+").replace_all(&out, "\n").into_owned();
    let out = re(&BEFORE_NL, r"[ \t]+\n").replace_all(&out, "\n").into_owned();
    let out = re(&MANY_NL, r"\n{3,}").replace_all(&out, "\n\n").into_owned();
    let out = out.trim().to_string();

    let segments = protected.borrow();
    re(&RESTORE, "\u{0}BLACKBOXCODE(\\d+)\u{0}")
        .replace_all(&out, |caps: &Captures| caps[1].parse::<usize>().ok().and_then(|index| segments.get(index).cloned()).unwrap_or_default())
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_headings_links_and_code_without_unsafe_markup() {
        let md = html_to_markdown(r#"<h2>Task</h2><p>Read <a href="https://example.com/a">this</a>.</p><pre><code>const x = 1;</code></pre><script>alert(1)</script>"#);
        assert!(md.contains("## Task"));
        assert!(md.contains("[this](https://example.com/a)"));
        assert!(md.contains("```\nconst x = 1;\n```"));
        assert!(!md.contains("alert"));
    }

    #[test]
    fn keeps_escaped_code_inside_fences_and_inequality_prose() {
        let md = html_to_markdown(r#"<pre><code>&lt;div class="x"&gt;text&lt;/div&gt;</code></pre><p>a &lt; b and c &gt; d</p>"#);
        assert!(md.contains("```"));
        assert!(md.contains(r#"<div class="x">text</div>"#));
        assert!(md.contains("a < b and c > d"));
    }

    #[test]
    fn survives_invalid_numeric_entities() {
        let md = html_to_markdown("<p>bad &#55296; entity &#99999999; end</p>");
        assert!(md.contains("bad") && md.contains("entity") && md.contains("end"));
    }

    #[test]
    fn drops_unsafe_link_targets_but_keeps_their_text() {
        let md = html_to_markdown(r#"<a href="javascript:alert(1)">click</a>"#);
        assert_eq!(md, "click");
    }

    #[test]
    fn ids_and_hashes_are_stable() {
        assert_eq!(stable_id("item", "one"), stable_id("item", "one"));
        assert!(stable_id("item", "one").starts_with("item_"));
        assert_eq!(stable_id("item", "one").len(), 5 + 16);
        assert_eq!(content_hash("a\r\nb "), content_hash("a\nb"));
    }
}
