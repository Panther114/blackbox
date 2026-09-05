/**
 * Type definitions for Blackboard Downloader
 */

export interface Course {
  id: string;
  name: string;
  url: string;
  path: string;
}

export interface BlockedCourse {
  id: string;
  name: string;
}

export interface ContentFolder {
  name: string;
  url: string;
  path: string;
  parentPath: string;
}

export interface DownloadableFile {
  name: string;
  url: string;
  path: string;
  size?: number;
  mimeType?: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
  error?: string;
}

/**
 * A file discovered during the scrape phase, enriched with course/section
 * context for display in the selection GUI.
 */
export interface DiscoveredFile {
  name: string;
  url: string;
  courseName: string;
  sectionName: string;
  /** Absolute local directory where the file should be saved */
  savePath: string;
  size?: number;
  mimeType?: string;
  /** Upper-case extension label, e.g. "PDF", "PPTX" */
  fileType?: string;
  status: 'pending' | 'downloading' | 'completed' | 'failed';
}

export interface SidebarLink {
  title: string;
  url: string;
  path: string;
}

export interface Config {
  username: string;
  password: string;
  baseUrl: string;
  loginUrl: string;
  downloadDir: string;
  maxConcurrentDownloads: number;
  downloadTimeout: number;
  browserType: 'chromium' | 'firefox' | 'webkit';
  headless: boolean;
  browserTimeout: number;
  databasePath: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  logFile: string;
  courseFilter?: string;
  maxRetries: number;
  retryDelay: number;
  /** Path to the JSON file-tree cache. Defaults to <downloadDir>/file_tree.json. */
  fileTreePath: string;
  /** Optional persistent Playwright profile used by packaged desktop builds. */
  browserProfileDir?: string;
  /** Prefer the installed Microsoft Edge browser before bundled Playwright Chromium. */
  useSystemEdge?: boolean;
  /**
   * Automation backend for headless runs. `chromium` (default) is the packaged
   * Playwright browser; `obscura` drives the Rust Obscura engine over CDP and
   * is intended for testing headless discovery/extraction.
   */
  browserBackend?: 'chromium' | 'obscura';
  /** Path or name of the Obscura executable. Defaults to `obscura` on PATH. */
  obscuraBinary?: string;
  /** Enable Obscura's built-in stealth mode (default true). */
  obscuraStealth?: boolean;
  /** Optional HTTP/SOCKS5 proxy passed to Obscura. */
  obscuraProxy?: string;
  /** Port for the Obscura CDP endpoint (default 9223). */
  obscuraPort?: number;
}

export type ContentItemKind = 'content' | 'assignment' | 'announcement';

/** Read-only Blackboard content prepared for agent consumption. */
export interface ContentItem {
  id: string;
  kind: ContentItemKind;
  courseId: string;
  courseName: string;
  sectionName: string;
  folderPath: string[];
  title: string;
  instructionsMarkdown: string;
  sourceUrl: string;
  availableAt?: string;
  dueAt?: string;
  points?: string;
  attachmentIds: string[];
  contentHash: string;
}

/** Progress emitted while the manual downloader reads course instructions. */
export interface InstructionDiscoveryProgress {
  phase: 'courses' | 'sections';
  completed: number;
  total: number;
  currentCourse?: string;
  currentSection?: string;
  itemsFound: number;
}

/** Progress emitted while manual instruction Markdown files are written. */
export interface InstructionWriteProgress {
  completed: number;
  total: number;
  currentCourse?: string;
  currentSection?: string;
  currentTitle?: string;
}

export interface AgentAttachment {
  id: string;
  itemId?: string;
  name: string;
  url: string;
  courseName: string;
  sectionName: string;
  localPath?: string;
  relativePath?: string;
  size?: number;
  mimeType?: string;
  status: 'pending' | 'downloaded' | 'skipped' | 'failed';
}

export interface AgentExportManifest {
  schemaVersion: 1;
  generatedAt: string;
  source: { baseUrl: string; mode: 'read-only' };
  courses: Array<Pick<Course, 'id' | 'name' | 'url'>>;
  items: ContentItem[];
  attachments: AgentAttachment[];
  warnings: string[];
  summary: {
    courses: number;
    items: number;
    attachments: number;
    downloadedFiles: number;
  };
}

export interface DownloadProgress {
  total: number;
  completed: number;
  failed: number;
  current?: string;
}

export interface DatabaseRecord {
  id?: number;
  url: string;
  path: string;
  filename: string;
  status: string;
  size?: number;
  downloadedAt?: Date;
  error?: string;
}

// ---------------------------------------------------------------------------
// File-tree cache — mirrors Blackboard's course / section / folder hierarchy
// ---------------------------------------------------------------------------

export interface FileTreeEntry {
  url: string;
  localPath: string;
  size?: number;
  downloadedAt: string; // ISO-8601
  mimeType?: string;
}

export interface FileTreeFolder {
  files: Record<string, FileTreeEntry>;
}

export interface FileTreeSection {
  folders: Record<string, FileTreeFolder>;
}

export interface FileTreeCourse {
  sections: Record<string, FileTreeSection>;
}

export interface FileTree {
  /** Schema version for future migrations. */
  version: number;
  /** ISO-8601 timestamp of last update. */
  generatedAt: string;
  courses: Record<string, FileTreeCourse>;
}
