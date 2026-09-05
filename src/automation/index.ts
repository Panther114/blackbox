import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import { BlackboxDownloader } from '../index';
import { getConfig } from '../config';
import { Course, DiscoveredFile } from '../types';
import { log } from '../utils/logger';
import { writeManualInstructions } from '../instructions/exporter';
import { validateAutomationSettings, automationTempRoot } from './settings';
import { AutomationRunLog } from './runLog';
import {
  AutomationEvent,
  AutomationGnumberStatus,
  AutomationRunSummary,
  AutomationSettings,
} from './types';

/** Parallel Blackboard sessions. Speed is essential; 4 is a safe default. */
function parallelSessionLimit(): number {
  const parsed = parseInt(process.env.AUTOMATION_PARALLEL_SESSIONS || '', 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 8);
  return 4;
}

function fileExtension(nameOrUrl: string): string {
  const clean = nameOrUrl.split(/[?#]/)[0];
  return path.extname(clean).toLowerCase();
}

export { fileExtension as automationFileExtension };

export type AutomationEventEmitter = (event: AutomationEvent) => void;

/**
 * Batch automation downloader.
 *
 * For every configured G-number a fresh, headless Blackboard session is
 * opened (username = password = G-number). The course list is kept in memory
 * only. Courses are claimed across all sessions with a shared ledger so every
 * unique course is downloaded exactly once; duplicates seen by later sessions
 * are ignored. Any login failure aborts only that G-number.
 */
export class AutomationRunner {
  private readonly settings: AutomationSettings;
  private readonly emitEvent: AutomationEventEmitter;
  private readonly runId = `run-${Date.now()}`;
  private readonly claimedCourses = new Map<string, string>();
  private readonly courseNames = new Map<string, string>();
  private runLog: AutomationRunLog | null = null;
  private aborted = false;

  constructor(settings: AutomationSettings, emitEvent: AutomationEventEmitter) {
    this.settings = { ...settings };
    this.emitEvent = emitEvent;
  }

  private status(state: import('./types').AutomationRunState, gnumber: string): import('./types').AutomationGnumberState | undefined {
    return state.gnumbers.find(entry => entry.gnumber === gnumber);
  }

  private setStatus(gnumber: string, status: AutomationGnumberStatus, error?: string): void {
    this.emitEvent({ type: 'automation:gnumber:status', payload: { gnumber, status, error } });
    this.runLog?.update(state => {
      const entry = this.status(state, gnumber);
      if (!entry) return;
      entry.status = status;
      if (error !== undefined) entry.error = error;
      if (status === 'failed' && !entry.finishedAt) entry.finishedAt = new Date().toISOString();
      if (status === 'done') entry.finishedAt = new Date().toISOString();
    });
  }

  async run(): Promise<AutomationRunSummary> {
    const validation = validateAutomationSettings(this.settings, '');
    if (!validation.ok) throw new Error(validation.error);

    const parallel = Math.min(parallelSessionLimit(), this.settings.gnumbers.length) || 1;
    this.runLog = new AutomationRunLog(this.settings.downloadDir, this.settings, parallel);

    this.emitEvent({ type: 'automation:start', payload: { total: this.settings.gnumbers.length, parallelSessions: parallel } });
    this.runLog.debugLog('info', `Automation run started: ${this.settings.gnumbers.length} G-numbers, ${parallel} parallel sessions.`);

    const limit = pLimit(parallel);
    const tasks = this.settings.gnumbers.map(gnumber =>
      limit(async () => {
        if (this.aborted) return;
        try {
          await this.runForGnumber(gnumber);
        } catch (error) {
          // runForGnumber handles its own failures; this is a safety net.
          const message = error instanceof Error ? error.message : String(error);
          log.error(`Automation session ${gnumber} crashed: ${message}`);
          this.runLog?.debugLog('error', `Session crashed: ${message}`, gnumber);
          this.setStatus(gnumber, 'failed', message);
        }
      }),
    );
    await Promise.all(tasks);

    const state = this.runLog.getState();
    const paths = await this.runLog.finish();
    const summary: AutomationRunSummary = {
      total: this.settings.gnumbers.length,
      succeeded: state.gnumbers.filter(entry => entry.status === 'done').length,
      failedLogins: state.failedLogins.length,
      uniqueCourses: Object.keys(state.claimedCourses).length,
      filesDownloaded: state.filesDownloaded,
      filesFailed: state.filesFailed,
      filesSkipped: state.filesSkipped,
      instructionsDownloaded: state.instructionsDownloaded,
      runlogPath: paths.runlogJsonPath,
      xlsxPath: paths.runlogXlsxPath,
      debugPath: paths.debugJsonPath,
    };
    this.emitEvent({ type: 'automation:done', payload: summary });
    this.runLog.debugLog('info', `Automation run finished: ${summary.succeeded}/${summary.total} G-numbers succeeded.`);
    return summary;
  }

  /** Abort remaining sessions as soon as possible (sessions finish their current step). */
  abort(): void {
    this.aborted = true;
    this.runLog?.debugLog('warn', 'Abort requested; remaining sessions will not start new work.');
  }

  private async runForGnumber(gnumber: string): Promise<void> {
    this.emitEvent({ type: 'automation:gnumber:start', payload: { gnumber, index: this.settings.gnumbers.indexOf(gnumber), total: this.settings.gnumbers.length } });
    this.setStatus(gnumber, 'logging-in');

    // Session-only scratch space: unique browser profile, database and file
    // tree per G-number so parallel sessions never contend. Removed on exit.
    const profileDir = path.join(automationTempRoot(), this.runId, gnumber);
    fs.mkdirSync(profileDir, { recursive: true });

    let downloader: BlackboxDownloader | null = null;
    try {
      const sessionConfig = getConfig({
        username: gnumber,
        password: gnumber,
        downloadDir: this.settings.downloadDir,
        headless: true,
        browserProfileDir: profileDir,
        databasePath: path.join(profileDir, 'automation.db'),
        fileTreePath: path.join(profileDir, 'file_tree.json'),
        maxConcurrentDownloads: 6,
        courseFilter: undefined,
      });

      const sessionFiles = new Map<string, DiscoveredFile>();
      downloader = new BlackboxDownloader(sessionConfig);
      this.attachSessionListeners(gnumber, downloader, sessionFiles);
      try {
        await downloader.initialize();
      } catch (error) {
        // Login failed for this G-number: abort this session only.
        const message = error instanceof Error ? error.message : String(error);
        this.runLog?.update(state => {
          state.failedLogins.push({ gnumber, error: message, at: new Date().toISOString() });
          const entry = this.status(state, gnumber);
          if (entry) entry.status = 'failed';
        });
        this.runLog?.debugLog('error', `Login failed: ${message}`, gnumber);
        this.setStatus(gnumber, 'failed', message);
        this.emitEvent({ type: 'automation:gnumber:done', payload: { gnumber, status: 'failed', error: message } });
        return;
      }

      this.emitEvent({ type: 'automation:gnumber:status', payload: { gnumber, status: 'discovering' } });
      const courses = await downloader.getCourses();
      this.runLog?.update(state => {
        const entry = this.status(state, gnumber);
        if (entry) entry.courses = courses.map(course => course.name);
      });
      this.emitEvent({ type: 'automation:gnumber:courses', payload: { gnumber, courses: courses.map(course => course.name) } });
      this.runLog?.debugLog('info', `Fetched ${courses.length} courses.`, gnumber);

      if (courses.length === 0) {
        this.setStatus(gnumber, 'done');
        this.emitEvent({ type: 'automation:gnumber:done', payload: { gnumber, status: 'done' } });
        return;
      }

      await this.downloadClaimedCourses(gnumber, downloader, courses, sessionFiles);

      this.setStatus(gnumber, 'done');
      this.emitEvent({ type: 'automation:gnumber:done', payload: { gnumber, status: 'done' } });
    } finally {
      try {
        await downloader?.cleanup();
      } catch (error) {
        this.runLog?.debugLog('warn', `Cleanup warning: ${error instanceof Error ? error.message : String(error)}`, gnumber);
      }
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
      } catch (error) {
        this.runLog?.debugLog('warn', `Could not remove session temp dir: ${error instanceof Error ? error.message : String(error)}`, gnumber);
      }
    }
  }

  /**
   * Claim every course this session can own (first session to see it wins),
   * then download files + instructions for the claimed ones.
   */
  private async downloadClaimedCourses(
    gnumber: string,
    downloader: BlackboxDownloader,
    courses: Course[],
    sessionFiles: Map<string, DiscoveredFile>,
  ): Promise<void> {
    const claimed: Course[] = [];
    for (const course of courses) {
      if (this.claimedCourses.has(course.id)) {
        const owner = this.claimedCourses.get(course.id)!;
        this.emitEvent({
          type: 'automation:course:skipped',
          payload: { gnumber, courseId: course.id, course: course.name, owner },
        });
        this.runLog?.update(state => {
          const entry = this.status(state, gnumber);
          if (entry && !entry.skippedCourses.includes(course.name)) entry.skippedCourses.push(course.name);
        });
        this.runLog?.debugLog('info', `Course "${course.name}" already claimed by ${owner}; skipped.`, gnumber);
        continue;
      }
      // Check-and-claim is synchronous (no await in between) so parallel
      // sessions can never double-download the same course.
      this.claimedCourses.set(course.id, gnumber);
      this.courseNames.set(course.id, course.name);
      claimed.push(course);
      this.emitEvent({
        type: 'automation:course:claimed',
        payload: { gnumber, courseId: course.id, course: course.name },
      });
      this.runLog?.update(state => {
        state.claimedCourses[course.id] = gnumber;
        const entry = this.status(state, gnumber);
        if (entry && !entry.downloadedCourses.includes(course.name)) entry.downloadedCourses.push(course.name);
      });
    }

    if (claimed.length === 0) {
      this.runLog?.debugLog('info', 'All courses were already covered by other G-numbers.', gnumber);
      return;
    }

    this.setStatus(gnumber, 'downloading');

    // Files: discover once, filter, then download concurrently (the downloader
    // applies its own concurrency limit internally).
    this.runLog?.debugLog('info', `Downloading ${claimed.length} claimed courses.`, gnumber);
    const files = await downloader.discoverAllFiles(claimed);
    const filtered = this.filterFiles(gnumber, files);
    sessionFiles.clear();
    for (const file of filtered) sessionFiles.set(file.url, file);
    if (filtered.length > 0) {
      await downloader.downloadSelected(filtered);
    }

    // Instructions: one read-only scan, then write the markdown export.
    this.setStatus(gnumber, 'downloading');
    const instructionResult = await downloader.discoverInstructions(claimed);
    if (instructionResult.items.length > 0) {
      const written = writeManualInstructions({
        outputDir: this.settings.downloadDir,
        courses: claimed,
        items: instructionResult.items,
      });
      this.runLog?.update(state => {
        state.instructionsDownloaded += written.written;
        const entry = this.status(state, gnumber);
        if (entry) entry.instructionsDownloaded += written.written;
      });
    }
    for (const warning of instructionResult.warnings) {
      this.runLog?.debugLog('warn', warning, gnumber);
    }

    const perCourseFiles = new Map<string, number>();
    for (const file of filtered) {
      const course = claimed.find(candidate => candidate.name === file.courseName);
      if (course) perCourseFiles.set(course.name, (perCourseFiles.get(course.name) || 0) + 1);
    }
    for (const course of claimed) {
      this.emitEvent({
        type: 'automation:course:done',
        payload: {
          gnumber,
          course: course.name,
          files: perCourseFiles.get(course.name) || 0,
          instructions: instructionResult.items.filter(item => item.courseId === course.id).length,
        },
      });
    }
  }

  /**
   * Apply the user-configurable automation filters: excluded extensions and
   * the per-file maximum size (known from HEAD metadata at this point).
   */
  private filterFiles(gnumber: string, files: DiscoveredFile[]): DiscoveredFile[] {
    const excluded = new Set(this.settings.excludedExtensions.map(ext => ext.toLowerCase()));
    return files.filter(file => {
      const ext = fileExtension(file.name) || fileExtension(file.url);
      if (ext && excluded.has(ext)) {
        this.runLog?.debugLog('info', `Skipped ${file.name}: excluded extension ${ext}`, gnumber);
        this.runLog?.update(state => {
          state.filesSkipped += 1;
          const entry = this.status(state, gnumber);
          if (entry) entry.filesSkipped += 1;
        });
        return false;
      }
      if (typeof file.size === 'number' && file.size > this.settings.maxFileSizeBytes) {
        this.runLog?.debugLog('info', `Skipped ${file.name}: ${Math.round(file.size / (1024 * 1024))} MB exceeds the per-file limit`, gnumber);
        this.runLog?.update(state => {
          state.filesSkipped += 1;
          const entry = this.status(state, gnumber);
          if (entry) entry.filesSkipped += 1;
        });
        return false;
      }
      return true;
    });
  }

  /**
   * Live per-file progress, accurate counters and the post-download
   * maximum-size guard for one session. Files that turn out larger than the
   * limit despite unknown HEAD size are removed from disk immediately and
   * counted as skipped.
   */
  private attachSessionListeners(
    gnumber: string,
    downloader: BlackboxDownloader,
    sessionFiles: Map<string, DiscoveredFile>,
  ): void {
    downloader.on('download:progress', (data: { url: string; filename: string; downloaded: number; total: number }) => {
      this.emitEvent({
        type: 'automation:file:progress',
        payload: { gnumber, name: data.filename, downloaded: data.downloaded, total: data.total },
      });
    });

    downloader.on('download:complete', (data: { url: string; filename: string; size: number }) => {
      if (data.size > this.settings.maxFileSizeBytes) {
        // The size was unknown at discovery time; enforce the limit now.
        const discovered = sessionFiles.get(data.url);
        const suspect = discovered ? path.join(discovered.savePath, data.filename) : null;
        if (suspect) {
          try {
            fs.rmSync(suspect, { force: true });
          } catch {
            // The file is locked or already gone; the JSON log records it.
          }
        }
        this.runLog?.debugLog('info', `Removed ${data.filename}: ${Math.round(data.size / (1024 * 1024))} MB exceeds the per-file limit`, gnumber);
        this.bumpCounters(gnumber, 'filesSkipped');
        return;
      }
      this.emitEvent({
        type: 'automation:file:done',
        payload: { gnumber, name: data.filename, size: data.size },
      });
      this.bumpCounters(gnumber, 'filesDownloaded');
    });

    downloader.on('download:skip', () => this.bumpCounters(gnumber, 'filesSkipped'));
    downloader.on('download:rejected', () => this.bumpCounters(gnumber, 'filesSkipped'));
    downloader.on('download:error', (data: { filename: string; error: string }) => {
      this.runLog?.debugLog('warn', `Download failed: ${data.filename} (${data.error})`, gnumber);
      this.bumpCounters(gnumber, 'filesFailed');
    });
  }

  private bumpCounters(gnumber: string, counter: 'filesDownloaded' | 'filesFailed' | 'filesSkipped'): void {
    this.runLog?.update(state => {
      state[counter] += 1;
      const entry = this.status(state, gnumber);
      if (entry) entry[counter] += 1;
    });
  }
}
