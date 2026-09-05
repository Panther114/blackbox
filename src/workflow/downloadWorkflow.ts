import { EventEmitter } from 'events';
import { BlackboxDownloader } from '../index';
import { Config, Course, DiscoveredFile } from '../types';
import { isDownloadPresent, scanDownloadDirectory } from '../downloadDirectory';
import { writeManualInstructions } from '../instructions/exporter';
import { log } from '../utils/logger';
import {
  WorkflowSummary,
  DiscoverCoursesOptions,
  DiscoverFilesResult,
  InstructionDownloadResult,
} from './types';

function filterAlreadyDownloaded(
  files: DiscoveredFile[],
  downloadDir: string,
): { files: DiscoveredFile[]; skippedOnDisk: number } {
  const result: DiscoveredFile[] = [];
  let skippedOnDisk = 0;
  const indexedFiles = scanDownloadDirectory(downloadDir);

  for (const file of files) {
    if (isDownloadPresent(indexedFiles, file.savePath, file.name)) {
      skippedOnDisk++;
    } else {
      result.push(file);
    }
  }

  return { files: result, skippedOnDisk };
}

export class DownloadWorkflow extends EventEmitter {
  private readonly config: Config;
  private blackboxDownloader: BlackboxDownloader | null = null;

  constructor(config: Config) {
    super();
    this.config = config;
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

    const enriched = await this.blackboxDownloader.fetchFileMetadata(discovered);
    const filtered = filterAlreadyDownloaded(enriched, this.config.downloadDir);
    this.emit('files:ready', {
      filesDiscovered: discovered.length,
      filesSelectable: filtered.files.length,
      skippedOnDisk: filtered.skippedOnDisk,
    });

    return {
      discovered,
      enriched,
      files: filtered.files,
      skippedOnDisk: filtered.skippedOnDisk,
    };
  }

  async downloadSelected(
    files: DiscoveredFile[],
    instructionCourses: Course[] = [],
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

    if (instructionCourses.length > 0) {
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

    if (files.length > 0) {
      await this.blackboxDownloader.downloadSelected(files);
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

export { filterAlreadyDownloaded, filterCourses };

