import { Course, DiscoveredFile, ExistingFileState } from '../types';

export interface DiscoverFilesResult {
  discovered: DiscoveredFile[];
  enriched: DiscoveredFile[];
  /** Every discovered file; the selection screen filters per layout itself. */
  files: DiscoveredFile[];
  skippedOnDisk: number;
  /**
   * Per-URL, per-layout "already on disk" state. The folder-structure and flat
   * layouts are tracked separately, so switching layout in the UI re-marks the
   * list without another scan.
   */
  existing: Record<string, ExistingFileState>;
}

export interface InstructionDownloadResult {
  instructionCoursesSelected: number;
  instructionsDiscovered: number;
  instructionsDownloaded: number;
  instructionWarnings: string[];
}

export interface WorkflowSummary {
  coursesDiscovered: number;
  coursesSelected: number;
  filesDiscovered: number;
  filesSelected: number;
  filesDownloaded: number;
  /** Files skipped during this run (already on disk when the transfer started). */
  filesSkipped: number;
  /** Files the chosen layout already held before this run started. */
  alreadySaved?: number;
  filesRejected: number;
  filesFailed: number;
  failedFiles: Array<{ name: string; reason: string }>;
  instructionCoursesSelected: number;
  instructionsDiscovered: number;
  instructionsDownloaded: number;
  instructionWarnings: string[];
  /** True when the user stopped the run before it finished on its own. */
  cancelled?: boolean;
}

export interface DiscoverCoursesOptions {
  filterPattern?: string;
  excludeCourseIds?: string[];
}

export interface DownloadPreparation {
  selectedCourses: Course[];
  selectedFiles: DiscoveredFile[];
}

