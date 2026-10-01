import { EventEmitter } from 'events';
import { BlackboxDownloader } from '../index';
import { Config, Course, DiscoveredFile, DownloadLayout, ExistingFileState } from '../types';
import { courseFolderForSavePath, pruneEmptyDirectories } from '../downloadDirectory';
import { writeManualInstructions } from '../instructions/exporter';
import { log } from '../utils/logger';
import {
  WorkflowSummary,
  DiscoverCoursesOptions,
  DiscoverFilesResult,
  InstructionDownloadResult,
} from './types';

/** Count the files each layout already holds, for the selection screen. */
function alreadySavedCounts(
  files: DiscoveredFile[],
  existing: Record<string, ExistingFileState>,
): { hierarchy: number; flat: number; any: number } {
  let hierarchy = 0;
  let flat = 0;
  let any = 0;
  for (const file of files) {
    const state = existing[file.url];
    if (!state) continue;
    if (state.hierarchy) hierarchy += 1;
    if (state.flat) flat += 1;
    if (state.hierarchy || state.flat) any += 1;
  }
  return { hierarchy, flat, any };
}

export class DownloadWorkflow extends EventEmitter {
  private readonly config: Config;
  private blackboxDownloader: BlackboxDownloader | null = null;
  private cancelled = false;

  constructor(config: Config) {
    super();
    this.config = config;
  }

  /**
   * Stop the running workflow: in-flight downloads are aborted and every
   * remaining step (instructions, queued files) is skipped. Anything already
   * written to the download directory is kept.
   */
  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    log.warn('Download cancelled by user.');
    this.blackboxDownloader?.cancel();
    this.emit('download:cancel', {});
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  async initialize(): Promise<void> {
    this.emit('login:start', {});
    this.blackboxDownloader = new BlackboxDownloader(this.config);

    this.blackboxDownloader.on('download:start', data => this.emit('download:start', data));
    this.blackboxDownloader.on('download:progress', data => this.emit('download:progress', data));
    this.blackboxDownloader.on('download:complete', data => this.emit('download:complete', data));
    this.blackboxDownloader.on('download:error', data => this.emit('download:error', data));
    this.blackboxDownloader.on('download:skip', data => this.emit('download:skip', data));
    this.blackboxDownloader.on('download:rejected', data => this.emit('download:rejected', data));
    this.blackboxDownloader.on('files:discovery:progress', data => this.emit('files:discovery:progress', data));
    this.blackboxDownloader.on('files:metadata:progress', data => this.emit('files:metadata:progress', data));
    this.blackboxDownloader.on('files:metadata:complete', data => this.emit('files:metadata:complete', data));

    try {
      await this.blackboxDownloader.initialize();
      this.emit('login:success', {});
    } catch (error) {
      this.emit('login:failure', {
        message: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.cleanup();
      } catch (cleanupError) {
        log.warn(`Login failure cleanup did not complete: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
      }
      throw error;
    }
  }

  async discoverCourses(options?: DiscoverCoursesOptions): Promise<Course[]> {
    if (!this.blackboxDownloader) {
      throw new Error('Workflow not initialized. Call initialize() first.');
    }

    const courses = await this.blackboxDownloader.getCourses();
    const filtered = this.filterCourses(courses, options);
    this.emit('courses:discovered', { total: courses.length, visible: filtered.length });
    return filtered;
  }

  async discoverFiles(selectedCourses: Course[]): Promise<DiscoverFilesResult> {
    if (!this.blackboxDownloader) {
      throw new Error('Workflow not initialized. Call initialize() first.');
    }

    this.emit('files:discovery:start', { courseCount: selectedCourses.length });
    const discovered = await this.blackboxDownloader.discoverAllFiles(selectedCourses);
    this.emit('files:discovery:complete', { filesDiscovered: discovered.length });

    // Ask the disk first and only then spend a HEAD request per file: a course
    // that is already fully saved needs no metadata at all, which is what makes
    // re-scanning a downloaded course fast.
    const diskState = this.blackboxDownloader.inspectExisting(discovered);
    const pending = discovered.filter(
      file => !diskState[file.url]?.hierarchy && !diskState[file.url]?.flat,
    );
    const enrichedPending = await this.blackboxDownloader.fetchFileMetadata(pending);
    const enrichedByUrl = new Map(enrichedPending.map(file => [file.url, file]));
    const enriched = discovered
      .map(file => enrichedByUrl.get(file.url))
      .filter((file): file is DiscoveredFile => file !== undefined);

    // Per-layout "already saved" state instead of one shared skip filter: the
    // selection screen decides what to hide for the layout the user picked.
    const existing = { ...diskState, ...this.blackboxDownloader.inspectExisting(enriched) };
    const counts = alreadySavedCounts(discovered, existing);
    this.emit('files:ready', {
      filesDiscovered: discovered.length,
      filesSelectable: discovered.length - counts.any,
      skippedOnDisk: counts.any,
      alreadySavedHierarchy: counts.hierarchy,
      alreadySavedFlat: counts.flat,
    });

    return {
      discovered,
      enriched,
      files: enriched,
      skippedOnDisk: counts.any,
      existing,
    };
  }

  async downloadSelected(
    files: DiscoveredFile[],
    instructionCourses: Course[] = [],
    layout: DownloadLayout = 'hierarchy',
  ): Promise<InstructionDownloadResult> {
    if (!this.blackboxDownloader) {
      throw new Error('Workflow not initialized. Call initialize() first.');
    }

    const instructionResult: InstructionDownloadResult = {
      instructionCoursesSelected: instructionCourses.length,
      instructionsDiscovered: 0,
      instructionsDownloaded: 0,
      instructionWarnings: [],
    };

    if (instructionCourses.length > 0 && !this.cancelled) {
      this.emit('instructions:discovery:start', { courseCount: instructionCourses.length });
      const discovered = await this.blackboxDownloader.discoverInstructions(instructionCourses, progress => {
        this.emit('instructions:discovery:progress', progress);
      });
      instructionResult.instructionsDiscovered = discovered.items.length;
      instructionResult.instructionWarnings.push(...discovered.warnings);
      this.emit('instructions:discovery:complete', {
        instructionsDiscovered: discovered.items.length,
        warnings: discovered.warnings,
      });

      if (this.cancelled) {
        log.warn('Cancelled before saving course instructions; nothing was written.');
        return instructionResult;
      }

      this.emit('instructions:write:start', { instructionsDiscovered: discovered.items.length });
      const written = writeManualInstructions({
        outputDir: this.config.downloadDir,
        courses: instructionCourses,
        items: discovered.items,
        onProgress: progress => this.emit('instructions:write:progress', progress),
      });
      instructionResult.instructionsDownloaded = written.written;
      instructionResult.instructionWarnings.push(...written.warnings);
      this.emit('instructions:write:complete', {
        instructionsDownloaded: written.written,
        warnings: written.warnings,
      });
    }

    if (this.cancelled) {
      log.warn('Download cancelled: skipping the remaining files.');
      return instructionResult;
    }

    if (files.length > 0) {
      log.info(
        layout === 'flat'
          ? `Saving ${files.length} files flat inside their course folders.`
          : `Saving ${files.length} files with the course folder structure.`,
      );
      await this.blackboxDownloader.downloadSelected(files, layout);
      if (layout === 'flat') this.pruneEmptyHierarchyFolders(files);
    } else if (instructionCourses.length === 0) {
      log.warn('No files or course instructions selected');
    } else {
      log.info(`Saved ${instructionResult.instructionsDownloaded} course instruction files`);
    }

    return instructionResult;
  }

  getDownloader(): BlackboxDownloader {
    if (!this.blackboxDownloader) {
      throw new Error('Workflow not initialized. Call initialize() first.');
    }
    return this.blackboxDownloader;
  }

  /**
   * A flat run writes every file into its course folder, but discovery still
   * created the course / section / subfolder shells. Remove the ones that ended
   * up empty so the course folder holds the flat files and nothing else — the
   * populated folders of a hierarchy run are never touched, and only empty
   * directories are deleted.
   */
  private pruneEmptyHierarchyFolders(files: DiscoveredFile[]): void {
    const courseFolders = new Set<string>();
    for (const file of files) {
      const courseFolder = courseFolderForSavePath(this.config.downloadDir, file.savePath);
      if (courseFolder) courseFolders.add(courseFolder);
    }

    let removed = 0;
    for (const courseFolder of courseFolders) {
      removed += pruneEmptyDirectories(courseFolder);
    }

    if (removed > 0) {
      log.info(
        `Flat layout: removed ${removed} empty folder${removed === 1 ? '' : 's'} left over from the folder structure.`,
      );
    }
  }

  emitSummary(summary: WorkflowSummary): void {
    this.emit('summary:ready', summary);
  }

  async cleanup(): Promise<void> {
    if (this.blackboxDownloader) {
      await this.blackboxDownloader.cleanup();
      this.blackboxDownloader = null;
    }
  }

  private filterCourses(courses: Course[], options?: DiscoverCoursesOptions): Course[] {
    return filterCourses(courses, options);
  }
}

function filterCourses(courses: Course[], options?: DiscoverCoursesOptions): Course[] {
  const pattern = options?.filterPattern?.trim();
  const excluded = new Set(options?.excludeCourseIds || []);
  const available = excluded.size > 0 ? courses.filter(course => !excluded.has(course.id)) : courses;
  if (!pattern) return available;

  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    // Tolerated by design (see tests): a malformed pattern keeps every course
    // visible rather than hiding the list. Warn loudly so a typo'd pattern is
    // obvious in the run output before anything is downloaded.
    log.warn(`Course filter "${pattern}" is not a valid regular expression; ignoring it.`);
    return available;
  }
  return available.filter(course => regex.test(course.name));
}

export { alreadySavedCounts, filterCourses };

