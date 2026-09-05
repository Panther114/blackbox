/** Automation batch-downloader types. Fully independent from normal settings. */

export interface AutomationSettings {
  /** BlackboardChina G-numbers used as both username and password. */
  gnumbers: string[];
  /** Independent download directory; must differ from the normal download dir. */
  downloadDir: string;
  /** Maximum size of a single downloadable file in bytes. Default 100 MB. */
  maxFileSizeBytes: number;
  /** File extensions that are never downloaded (lowercase, with dot). Default .mp3/.mp4. */
  excludedExtensions: string[];
}

export const DEFAULT_AUTOMATION_SETTINGS: AutomationSettings = {
  gnumbers: [],
  downloadDir: '',
  maxFileSizeBytes: 100 * 1024 * 1024,
  excludedExtensions: ['.mp3', '.mp4'],
};

export const AUTOMATION_DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
export const AUTOMATION_DEFAULT_EXCLUDED_EXTENSIONS = ['.mp3', '.mp4'];

/** Status of a single G-number inside a run. */
export type AutomationGnumberStatus = 'pending' | 'logging-in' | 'discovering' | 'downloading' | 'done' | 'failed';

export interface AutomationGnumberState {
  gnumber: string;
  status: AutomationGnumberStatus;
  error?: string;
  /** Course names fetched by this G-number's session. */
  courses: string[];
  /** Courses this G-number downloaded (claimed, unique across the run). */
  downloadedCourses: string[];
  /** Courses seen by this G-number but already downloaded by another G-number. */
  skippedCourses: string[];
  filesDownloaded: number;
  filesFailed: number;
  filesSkipped: number;
  instructionsDownloaded: number;
  startedAt?: string;
  finishedAt?: string;
}

export interface AutomationRunState {
  startedAt: string;
  updatedAt: string;
  running: boolean;
  gnumbers: AutomationGnumberState[];
  failedLogins: Array<{ gnumber: string; error: string; at: string }>;
  /** Global course ledger: courseId -> owning G-number. */
  claimedCourses: Record<string, string>;
  filesDownloaded: number;
  filesFailed: number;
  filesSkipped: number;
  instructionsDownloaded: number;
  error?: string;
}

export interface AutomationDebugInfo {
  startedAt: string;
  updatedAt: string;
  parallelSessions: number;
  settings: Omit<AutomationSettings, 'gnumbers'> & { gnumberCount: number };
  timeline: Array<{ at: string; level: 'info' | 'warn' | 'error'; gnumber?: string; message: string }>;
}

export interface AutomationRunSummary {
  total: number;
  succeeded: number;
  failedLogins: number;
  uniqueCourses: number;
  filesDownloaded: number;
  filesFailed: number;
  filesSkipped: number;
  instructionsDownloaded: number;
  runlogPath: string;
  xlsxPath: string;
  debugPath: string;
}

/** Automation events forwarded to the renderer. */
export type AutomationEvent =
  | { type: 'automation:start'; payload: { total: number; parallelSessions: number } }
  | { type: 'automation:gnumber:start'; payload: { gnumber: string; index: number; total: number } }
  | { type: 'automation:gnumber:status'; payload: { gnumber: string; status: AutomationGnumberStatus; error?: string } }
  | { type: 'automation:gnumber:courses'; payload: { gnumber: string; courses: string[] } }
  | { type: 'automation:course:claimed'; payload: { gnumber: string; courseId: string; course: string } }
  | { type: 'automation:course:skipped'; payload: { gnumber: string; courseId: string; course: string; owner: string } }
  | { type: 'automation:file:progress'; payload: { gnumber: string; name: string; downloaded: number; total: number } }
  | { type: 'automation:file:done'; payload: { gnumber: string; name: string; size: number } }
  | { type: 'automation:course:done'; payload: { gnumber: string; course: string; files: number; instructions: number } }
  | { type: 'automation:gnumber:done'; payload: { gnumber: string; status: AutomationGnumberStatus; error?: string } }
  | { type: 'automation:done'; payload: AutomationRunSummary };
