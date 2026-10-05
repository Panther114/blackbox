import fs from 'fs';
import path from 'path';
import pLimit from 'p-limit';
import { BlackboxDownloader } from '../index';
import { Course, DiscoveredFile } from '../types';
import { log } from '../utils/logger';
import { writeManualInstructions } from '../instructions/exporter';
import {
  buildAutomationSessionConfig,
  clearAutomationDownloadDir,
  validateAutomationSettings,
  automationTempRoot,
} from './settings';
import { AutomationClaimLedger } from './claims';
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
 * are ignored. A course only counts as covered after its session actually
 * downloaded it — claims are released on failure/cancel so the state stays
 * fresh. Any login failure aborts only that G-number.
 *
 * Independence: every session gets an explicitly built config
 * (buildAutomationSessionConfig) with its own database, file-tree cache and
 * browser profile, and the shared download directory is wiped at the start of
 * every run. Nothing from the normal Blackbox settings (course filters,
 * blocked courses, download history) can leak in.
 */
export class AutomationRunner {
  private readonly settings: AutomationSettings;
  private readonly emitEvent: AutomationEventEmitter;
  private readonly runId = `run-${Date.now()}`;
  private readonly ledger = new AutomationClaimLedger();
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
      if ((status === 'failed' || status === 'done' || status === 'cancelled') && !entry.finishedAt) {
        entry.finishedAt = new Date().toISOString();
      }
    });
  }

  /**
   * Run the batch. Every run starts from a completely fresh state: previous
   * downloads and previous run logs in the automation directory are wiped
   * first. Cancelling never wipes — only a new run does.
   */
  async run(normalDownloadDir = ''): Promise<AutomationRunSummary> {
    const validation = validateAutomationSettings(this.settings, normalDownloadDir);
    if (!validation.ok) throw new Error(validation.error);

    let wiped = 0;
    try {
      wiped = clearAutomationDownloadDir(this.settings.downloadDir, normalDownloadDir).removed;
    } catch (error) {
      throw new Error(`Could not clear the automation download directory: ${error instanceof Error ? error.message : String(error)}`);
    }

    const parallel = Math.min(parallelSessionLimit(), this.settings.gnumbers.length) || 1;
    this.runLog = new AutomationRunLog(this.settings.downloadDir, this.settings, parallel);

    this.emitEvent({ type: 'automation:start', payload: { total: this.settings.gnumbers.length, parallelSessions: parallel } });
    this.runLog.debugLog('info', `Automation run started: ${this.settings.gnumbers.length} G-numbers, ${parallel} parallel sessions.`);
    this.runLog.debugLog('info', `Fresh state: wiped ${wiped} previous entr${wiped === 1 ? 'y' : 'ies'} (downloads + old logs) from ${this.settings.downloadDir}.`);
    this.runLog.debugLog(
      'info',
      `Session config: headless Edge/Chromium, 6 concurrent files per session, per-file limit ${Math.round(this.settings.maxFileSizeBytes / (1024 * 1024))} MB, ` +
        `excluded extensions [${this.settings.excludedExtensions.join(', ') || 'none'}]. Sessions use an isolated config (no normal-settings inheritance).`,
    );

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

    const cancelled = this.aborted;
    const state = this.runLog.getState();
    const paths = await this.runLog.finish(cancelled ? 'Cancelled by user' : undefined, cancelled);
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
      cancelled,
    };
    if (cancelled) {
      this.emitEvent({ type: 'automation:cancelled', payload: summary });
      this.runLog.debugLog('warn', `Automation run cancelled by user: ${summary.succeeded}/${summary.total} G-numbers finished, ${summary.filesDownloaded} files downloaded. Downloads on disk were kept.`);
    } else {
      this.emitEvent({ type: 'automation:done', payload: summary });
      this.runLog.debugLog('info', `Automation run finished: ${summary.succeeded}/${summary.total} G-numbers succeeded.`);
    }
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
      // Explicit per-session config: no environment inheritance, so the
      // normal downloader's filters/history can never leak into automation.
      const sessionConfig = buildAutomationSessionConfig(gnumber, this.settings, profileDir);
      this.runLog?.debugLog(
        'info',
        `Session starting: temp profile ${profileDir}, session DB + file-tree inside it, downloads -> ${sessionConfig.downloadDir}.`,
        gnumber,
      );

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
      this.runLog?.debugLog('info', 'Login succeeded; fetching the course list.', gnumber);

      if (this.aborted) {
        this.setStatus(gnumber, 'cancelled');
        this.emitEvent({ type: 'automation:gnumber:done', payload: { gnumber, status: 'cancelled' } });
        return;
      }

      this.emitEvent({ type: 'automation:gnumber:status', payload: { gnumber, status: 'discovering' } });
      let courses: Course[];
      try {
        courses = await downloader.getCourses();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.runLog?.debugLog('error', `Could not fetch the course list: ${message}`, gnumber);
        this.setStatus(gnumber, 'failed', message);
        this.emitEvent({ type: 'automation:gnumber:done', payload: { gnumber, status: 'failed', error: message } });
        return;
      }
      this.runLog?.update(state => {
        const entry = this.status(state, gnumber);
        if (entry) entry.courses = courses.map(course => course.name);
      });
      this.emitEvent({ type: 'automation:gnumber:courses', payload: { gnumber, courses: courses.map(course => course.name) } });
      this.runLog?.debugLog(
        'info',
        `Fetched ${courses.length} course(s)${courses.length > 0 ? `: ${courses.slice(0, 10).map(course => `"${course.name}"`).join(', ')}${courses.length > 10 ? ` (+${courses.length - 10} more)` : ''}` : ''}.`,
        gnumber,
      );

      if (courses.length === 0) {
        this.setStatus(gnumber, 'done');
        this.emitEvent({ type: 'automation:gnumber:done', payload: { gnumber, status: 'done' } });
        return;
      }

      const outcome = await this.downloadClaimedCourses(gnumber, downloader, courses, sessionFiles);
      this.runLog?.debugLog(
        'info',
        `Session result: ${outcome.confirmed} course(s) downloaded, ${outcome.covered} already covered by others, ${outcome.courseErrors} failed.`,
        gnumber,
      );

      if (this.aborted) {
        this.setStatus(gnumber, 'cancelled');
        this.emitEvent({ type: 'automation:gnumber:done', payload: { gnumber, status: 'cancelled' } });
        return;
      }
      if (outcome.confirmed === 0 && outcome.covered === 0) {
        const message = `No courses downloaded (${outcome.courseErrors} failed; see automation-debug.json)`;
        this.runLog?.debugLog('error', message, gnumber);
        this.setStatus(gnumber, 'failed', message);
        this.emitEvent({ type: 'automation:gnumber:done', payload: { gnumber, status: 'failed', error: message } });
        return;
      }

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
   * Reserve every course this session can own (first session to see it wins),
   * then download the owned courses one by one: discover -> metadata ->
   * download -> instructions -> confirm. A course only counts as covered once
   * its session actually downloaded it; failures release the claim so another
   * session can still pick the course up.
   */
  private async downloadClaimedCourses(
    gnumber: string,
    downloader: BlackboxDownloader,
    courses: Course[],
    sessionFiles: Map<string, DiscoveredFile>,
  ): Promise<{ confirmed: number; covered: number; courseErrors: number }> {
    const owned: Course[] = [];
    let covered = 0;
    for (const course of courses) {
      if (!this.ledger.reserve(course.id, gnumber)) {
        const owner = this.ledger.ownerOf(course.id) ?? 'another G-number';
        const state = this.ledger.isConfirmed(course.id) ? 'already downloaded' : 'reserved (in progress)';
        this.emitEvent({
          type: 'automation:course:skipped',
          payload: { gnumber, courseId: course.id, course: course.name, owner },
        });
        this.runLog?.update(entry => {
          const target = this.status(entry, gnumber);
          if (target && !target.skippedCourses.includes(course.name)) target.skippedCourses.push(course.name);
        });
        this.runLog?.debugLog('info', `Course "${course.name}" ${state} by ${owner}; skipped.`, gnumber);
        covered += 1;
        continue;
      }
      // Reserve is synchronous (no await in between) so parallel sessions can
      // never double-download the same course.
      this.courseNames.set(course.id, course.name);
      owned.push(course);
      this.emitEvent({
        type: 'automation:course:claimed',
        payload: { gnumber, courseId: course.id, course: course.name },
      });
      this.runLog?.debugLog('info', `Course "${course.name}" reserved for download.`, gnumber);
    }

    if (owned.length === 0) {
      this.runLog?.debugLog('info', 'No new courses to download; everything was already covered by other G-numbers.', gnumber);
      return { confirmed: 0, covered, courseErrors: 0 };
    }

    this.setStatus(gnumber, 'downloading');
    this.runLog?.debugLog('info', `Downloading ${owned.length} reserved course(s), one at a time.`, gnumber);

    let confirmed = 0;
    let courseErrors = 0;
    for (let index = 0; index < owned.length; index += 1) {
      const course = owned[index];
      if (this.aborted) {
        // Cancel releases the remaining claims but never wipes downloads.
        for (const remaining of owned.slice(index)) this.releaseClaim(gnumber, remaining, 'cancelled by user');
        break;
      }
      try {
        const result = await this.downloadCourse(gnumber, downloader, course, sessionFiles);
        this.confirmClaim(gnumber, course, result);
        confirmed += 1;
      } catch (error) {
        courseErrors += 1;
        const message = this.aborted ? 'cancelled by user' : error instanceof Error ? error.message : String(error);
        this.runLog?.debugLog(this.aborted ? 'warn' : 'error', `Course "${course.name}": FAILED — ${message}. Claim released so another session can retry it.`, gnumber);
        this.releaseClaim(gnumber, course, message);
      }
    }
    return { confirmed, covered, courseErrors };
  }

  /**
   * Full per-course pipeline: discover files, fetch HEAD metadata (real
   * filenames, sizes, MIME types — same as the normal downloader), apply the
   * automation filters, download, then discover + write instructions.
   */
  private async downloadCourse(
    gnumber: string,
    downloader: BlackboxDownloader,
    course: Course,
    sessionFiles: Map<string, DiscoveredFile>,
  ): Promise<{ files: number; instructions: number }> {
    const startedAt = Date.now();
    this.runLog?.debugLog('info', `Course "${course.name}": discovering files.`, gnumber);
    const discovered = await downloader.discoverAllFiles([course]);
    this.runLog?.debugLog('info', `Course "${course.name}": discovered ${discovered.length} file(s).`, gnumber);

    if (this.aborted) throw new Error('cancelled by user');

    const withMetadata = await downloader.fetchFileMetadata(discovered);
    const droppedByMetadata = discovered.length - withMetadata.length;
    this.runLog?.debugLog(
      'info',
      `Course "${course.name}": metadata accepted ${withMetadata.length}/${discovered.length} (media/non-document types dropped: ${droppedByMetadata}).`,
      gnumber,
    );
    const filtered = this.filterFiles(gnumber, withMetadata);
    this.runLog?.debugLog(
      'info',
      `Course "${course.name}": ${filtered.length} file(s) after automation filters (size limit, excluded extensions).`,
      gnumber,
    );

    sessionFiles.clear();
    for (const file of filtered) sessionFiles.set(file.url, file);

    let completed = 0;
    if (filtered.length === 0) {
      this.runLog?.debugLog('info', `Course "${course.name}": nothing to download after discovery + filters.`, gnumber);
    } else {
      if (this.aborted) throw new Error('cancelled by user');
      const outcomes = await downloader.downloadSelected(filtered);
      const tally = { completed: 0, skipped: 0, rejected: 0, failed: 0 };
      const failures: string[] = [];
      const rejectedExamples: string[] = [];
      for (const file of filtered) {
        const outcome = outcomes[file.url]?.status ?? 'failed';
        if (outcome === 'completed') tally.completed += 1;
        else if (outcome === 'skipped') tally.skipped += 1;
        else if (outcome === 'rejected') {
          tally.rejected += 1;
          if (rejectedExamples.length < 10) rejectedExamples.push(file.name);
        } else {
          tally.failed += 1;
          if (failures.length < 50) failures.push(`${file.name} (${outcomes[file.url]?.error || 'unknown error'})`);
        }
      }
      completed = tally.completed;
      this.runLog?.debugLog(
        tally.failed > 0 ? 'warn' : 'info',
        `Course "${course.name}": download outcomes — ${tally.completed} completed, ${tally.skipped} skipped (already on disk), ` +
          `${tally.rejected} rejected (unsupported type), ${tally.failed} failed.`,
        gnumber,
      );
      for (const failure of failures) this.runLog?.debugLog('error', `Course "${course.name}": download failed — ${failure}.`, gnumber);
      if (rejectedExamples.length > 0) {
        this.runLog?.debugLog('info', `Course "${course.name}": rejected examples — ${rejectedExamples.join(', ')}${tally.rejected > rejectedExamples.length ? ` (+${tally.rejected - rejectedExamples.length} more)` : ''}.`, gnumber);
      }
    }

    if (this.aborted) throw new Error('cancelled by user');

    // Instructions: one read-only scan, then write the markdown export.
    this.runLog?.debugLog('info', `Course "${course.name}": discovering instructions.`, gnumber);
    const instructionResult = await downloader.discoverInstructions([course]);
    let instructionsWritten = 0;
    if (instructionResult.items.length > 0) {
      const written = writeManualInstructions({
        outputDir: this.settings.downloadDir,
        courses: [course],
        items: instructionResult.items,
      });
      instructionsWritten = written.written;
      this.runLog?.update(state => {
        state.instructionsDownloaded += written.written;
        const entry = this.status(state, gnumber);
        if (entry) entry.instructionsDownloaded += written.written;
      });
    }
    for (const warning of instructionResult.warnings) {
      this.runLog?.debugLog('warn', `Course "${course.name}": instruction warning — ${warning}.`, gnumber);
    }
    this.runLog?.debugLog(
      'info',
      `Course "${course.name}": done in ${Math.round((Date.now() - startedAt) / 1000)}s — ${completed} file(s), ${instructionsWritten} instruction file(s).`,
      gnumber,
    );
    return { files: completed, instructions: instructionsWritten };
  }

  /** Mark a course as actually downloaded (only now does it count as covered). */
  private confirmClaim(gnumber: string, course: Course, result: { files: number; instructions: number }): void {
    this.ledger.confirm(course.id);
    this.emitEvent({
      type: 'automation:course:done',
      payload: { gnumber, course: course.name, files: result.files, instructions: result.instructions },
    });
    this.runLog?.update(state => {
      state.claimedCourses[course.id] = gnumber;
      const entry = this.status(state, gnumber);
      if (entry && !entry.downloadedCourses.includes(course.name)) entry.downloadedCourses.push(course.name);
    });
  }

  /** Release a reservation so another session can pick the course up. */
  private releaseClaim(gnumber: string, course: Course, reason: string): void {
    if (!this.ledger.release(course.id)) return;
    this.emitEvent({
      type: 'automation:course:released',
      payload: { gnumber, courseId: course.id, course: course.name, reason },
    });
    this.runLog?.debugLog('warn', `Course "${course.name}": claim released (${reason}).`, gnumber);
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

    downloader.on('download:skip', (data: { url?: string; filename?: string }) => {
      if (data?.filename) this.runLog?.debugLog('info', `Skipped (already on disk): ${data.filename}`, gnumber);
      this.bumpCounters(gnumber, 'filesSkipped');
    });
    downloader.on('download:rejected', (data: { url?: string; filename?: string; reason?: string }) => {
      if (data?.filename) this.runLog?.debugLog('info', `Rejected (unsupported type${data?.reason ? `: ${data.reason}` : ''}): ${data.filename}`, gnumber);
      this.bumpCounters(gnumber, 'filesSkipped');
    });
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
