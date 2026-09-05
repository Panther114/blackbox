import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import {
  AutomationDebugInfo,
  AutomationRunState,
  AutomationSettings,
} from './types';

export interface AutomationRunLogPaths {
  runlogJsonPath: string;
  runlogXlsxPath: string;
  debugJsonPath: string;
}

/**
 * Real-time run log writer.
 *
 * - `automation-runlog.json` — full run state, rewritten on every update.
 * - `automation-runlog.xlsx` — Excel workbook with the failed logins, the
 *   course list per G-number and a summary. Rewritten on a short debounce
 *   because workbook generation is comparatively heavy.
 * - `automation-debug.json` — verbose debug timeline in a separate file.
 */
export class AutomationRunLog {
  private state: AutomationRunState;
  private debug: AutomationDebugInfo;
  private paths: AutomationRunLogPaths;
  private xlsxTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(downloadDir: string, settings: AutomationSettings, parallelSessions: number) {
    fs.mkdirSync(downloadDir, { recursive: true });
    this.paths = {
      runlogJsonPath: path.join(downloadDir, 'automation-runlog.json'),
      runlogXlsxPath: path.join(downloadDir, 'automation-runlog.xlsx'),
      debugJsonPath: path.join(downloadDir, 'automation-debug.json'),
    };
    const now = new Date().toISOString();
    this.state = {
      startedAt: now,
      updatedAt: now,
      running: true,
      gnumbers: settings.gnumbers.map(gnumber => ({
        gnumber,
        status: 'pending',
        courses: [],
        downloadedCourses: [],
        skippedCourses: [],
        filesDownloaded: 0,
        filesFailed: 0,
        filesSkipped: 0,
        instructionsDownloaded: 0,
      })),
      failedLogins: [],
      claimedCourses: {},
      filesDownloaded: 0,
      filesFailed: 0,
      filesSkipped: 0,
      instructionsDownloaded: 0,
    };
    this.debug = {
      startedAt: now,
      updatedAt: now,
      parallelSessions,
      settings: {
        gnumberCount: settings.gnumbers.length,
        downloadDir,
        maxFileSizeBytes: settings.maxFileSizeBytes,
        excludedExtensions: settings.excludedExtensions,
      },
      timeline: [],
    };
    this.flushJson();
  }

  get pathsOf(): AutomationRunLogPaths {
    return this.paths;
  }

  getState(): AutomationRunState {
    return this.state;
  }

  update(mutate: (state: AutomationRunState) => void): void {
    mutate(this.state);
    this.state.updatedAt = new Date().toISOString();
    this.flushJson();
    this.scheduleXlsx();
  }

  debugLog(level: 'info' | 'warn' | 'error', message: string, gnumber?: string): void {
    this.debug.timeline.push({ at: new Date().toISOString(), level, gnumber, message });
    // Keep the debug timeline bounded so a huge run cannot exhaust memory.
    if (this.debug.timeline.length > 5000) {
      this.debug.timeline = this.debug.timeline.slice(-4000);
    }
    this.debug.updatedAt = new Date().toISOString();
    this.flushDebug();
  }

  private flushJson(): void {
    try {
      fs.writeFileSync(this.paths.runlogJsonPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    } catch {
      // A busy/locked file (user has it open in Excel) must not kill the run.
    }
  }

  private flushDebug(): void {
    try {
      fs.writeFileSync(this.paths.debugJsonPath, `${JSON.stringify(this.debug, null, 2)}\n`, 'utf8');
    } catch {
      // Non-fatal.
    }
  }

  private scheduleXlsx(): void {
    if (this.closed || this.xlsxTimer) return;
    this.xlsxTimer = setTimeout(() => {
      this.xlsxTimer = null;
      void this.writeXlsx();
    }, 1500);
  }

  private async writeXlsx(): Promise<void> {
    try {
      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Blackbox Automation';

      const summary = workbook.addWorksheet('Summary');
      summary.addRow(['Started at', this.state.startedAt]);
      summary.addRow(['Updated at', this.state.updatedAt]);
      summary.addRow(['G-numbers', this.state.gnumbers.length]);
      summary.addRow(['Failed logins', this.state.failedLogins.length]);
      summary.addRow(['Unique courses downloaded', Object.keys(this.state.claimedCourses).length]);
      summary.addRow(['Files downloaded', this.state.filesDownloaded]);
      summary.addRow(['Files failed', this.state.filesFailed]);
      summary.addRow(['Files skipped', this.state.filesSkipped]);
      summary.addRow(['Instructions downloaded', this.state.instructionsDownloaded]);
      summary.addRow(['Run error', this.state.error || '']);

      const failed = workbook.addWorksheet('Failed logins');
      failed.addRow(['G-number', 'Error', 'Time']);
      failed.getRow(1).font = { bold: true };
      for (const entry of this.state.failedLogins) {
        failed.addRow([entry.gnumber, entry.error, entry.at]);
      }

      const courses = workbook.addWorksheet('Courses');
      courses.addRow(['G-number', 'Course', 'Status', 'Files', 'Instructions', 'Notes']);
      courses.getRow(1).font = { bold: true };
      for (const entry of this.state.gnumbers) {
        for (const course of entry.courses) {
          const downloaded = entry.downloadedCourses.includes(course);
          const skipped = entry.skippedCourses.includes(course);
          courses.addRow([
            entry.gnumber,
            course,
            downloaded ? 'downloaded' : skipped ? 'skipped (already covered)' : entry.status,
            downloaded ? entry.filesDownloaded : '',
            downloaded ? entry.instructionsDownloaded : '',
            downloaded ? '' : skipped ? `covered by another G-number` : '',
          ]);
        }
        if (entry.courses.length === 0) {
          courses.addRow([entry.gnumber, '', entry.status === 'failed' ? 'login failed' : 'no courses found']);
        }
      }

      await workbook.xlsx.writeFile(this.paths.runlogXlsxPath);
    } catch {
      // Excel is a convenience export; JSON is the source of truth. If the
      // workbook is locked (e.g. open in Excel) we simply retry on the next
      // scheduled update.
    }
  }

  async finish(error?: string): Promise<AutomationRunLogPaths> {
    this.update(state => {
      state.running = false;
      if (error) state.error = error;
      for (const entry of state.gnumbers) {
        if (entry.status === 'pending' || entry.status === 'logging-in' || entry.status === 'discovering' || entry.status === 'downloading') {
          entry.status = error ? 'failed' : 'done';
          entry.finishedAt = entry.finishedAt || new Date().toISOString();
        }
      }
    });
    this.flushDebug();
    // Drop any pending debounced write; the final workbook is written below.
    if (this.xlsxTimer) {
      clearTimeout(this.xlsxTimer);
      this.xlsxTimer = null;
    }
    await this.writeXlsx();
    this.closed = true;
    return this.paths;
  }
}
