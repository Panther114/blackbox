//! Data shapes shared with the web UI. Field names are camelCase on the wire,
//! matching what the renderer already sends and expects.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Course {
    pub id: String,
    pub name: String,
    pub url: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedCourse {
    pub id: String,
    pub name: String,
}

/// A downloadable document found while walking a course.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredFile {
    pub name: String,
    pub url: String,
    pub course_name: String,
    pub section_name: String,
    /// Absolute local directory the file is saved into.
    pub save_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(default = "pending")]
    pub status: String,
}

fn pending() -> String {
    "pending".into()
}

/// Which layouts already hold a copy of a discovered file.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExistingFileState {
    pub hierarchy: bool,
    pub flat: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContentItemKind {
    Content,
    Assignment,
    Announcement,
}

impl ContentItemKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Content => "content",
            Self::Assignment => "assignment",
            Self::Announcement => "announcement",
        }
    }
}

/// Read-only Blackboard content prepared for agent consumption.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentItem {
    pub id: String,
    pub kind: ContentItemKind,
    pub course_id: String,
    pub course_name: String,
    pub section_name: String,
    pub folder_path: Vec<String>,
    pub title: String,
    pub instructions_markdown: String,
    pub source_url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub points: Option<String>,
    pub attachment_ids: Vec<String>,
    pub content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAttachment {
    pub id: String,
    pub name: String,
    pub url: String,
    pub course_name: String,
    pub section_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relative_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    /// pending | downloaded | skipped | failed
    pub status: String,
}

/// A link on a content page before course and section context are attached.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawFile {
    pub name: String,
    pub url: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidebarLink {
    pub title: String,
    pub url: String,
    pub path: String,
}
