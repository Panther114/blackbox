import fs from 'fs';
import path from 'path';
import { DatabaseRecord } from '../types';
import { log } from '../utils/logger';

/** Delay that coalesces bursts of updates (one per downloaded file) into a single write. */
const SAVE_DEBOUNCE_MS = 400;

interface StoredRecord {
  url: string;
  path: string;
  filename: string;
  status: string;
  size?: number;
  downloadedAt?: string;
  error?: string;
}

/**
 * Download ledger kept as a small JSON file next to the configured database
 * path. It replaces the former SQLite database: the ledger is a few thousand
 * rows at most, so an in-memory map with atomic debounced writes is faster to
 * start, needs no native module and keeps the same public API.
 */
export class DownloadDatabase {
  private readonly file: string;
  private readonly records = new Map<string, StoredRecord>();
  private nextId = 1;
  private ids = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private dirty = false;

  constructor(dbPath: string) {
    // `blackbox.db` becomes `blackbox.json`; an old SQLite file is left untouched.
    this.file = dbPath.replace(/\.(db|sqlite3?)$/i, '') + '.json';
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.load();
    log.info(`Download ledger ready at ${this.file}`);
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { records?: StoredRecord[] };
      let interrupted = 0;
      for (const record of parsed.records ?? []) {
        if (!record?.url) continue;
        // Anything still pending belongs to a run that was interrupted.
        if (record.status === 'pending') {
          record.status = 'failed';
          record.error = 'Interrupted (pending at startup)';
          interrupted += 1;
        }
        this.records.set(record.url, record);
        this.ids.set(record.url, this.nextId++);
      }
      if (interrupted > 0) {
        log.info(`Reset ${interrupted} stale pending record(s) to failed`);
        this.markDirty();
      }
    } catch {
      // Missing or unreadable ledger: start empty.
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), SAVE_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify({ version: 1, records: [...this.records.values()] }), 'utf8');
      fs.renameSync(temp, this.file);
    } catch (error) {
      fs.rmSync(temp, { force: true });
      log.warn(`Could not save the download ledger: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private toRecord(stored: StoredRecord): DatabaseRecord {
    return {
      id: this.ids.get(stored.url),
      url: stored.url,
      path: stored.path,
      filename: stored.filename,
      status: stored.status,
      size: stored.size,
      downloadedAt: stored.downloadedAt ? new Date(stored.downloadedAt) : undefined,
      error: stored.error,
    };
  }

  isDownloaded(url: string): boolean {
    return this.records.get(url)?.status === 'completed';
  }

  upsertDownload(record: DatabaseRecord): void {
    if (!this.ids.has(record.url)) this.ids.set(record.url, this.nextId++);
    this.records.set(record.url, {
      url: record.url,
      path: record.path,
      filename: record.filename,
      status: record.status,
      size: record.size || undefined,
      downloadedAt: record.downloadedAt ? record.downloadedAt.toISOString() : undefined,
      error: record.error || undefined,
    });
    this.markDirty();
  }

  getDownload(url: string): DatabaseRecord | null {
    const stored = this.records.get(url);
    return stored ? this.toRecord(stored) : null;
  }

  getDownloadsByStatus(status: string): DatabaseRecord[] {
    return [...this.records.values()].filter(record => record.status === status).map(record => this.toRecord(record));
  }

  getStats(): { total: number; completed: number; failed: number; pending: number } {
    const stats = { total: this.records.size, completed: 0, failed: 0, pending: 0 };
    for (const record of this.records.values()) {
      if (record.status === 'completed') stats.completed += 1;
      else if (record.status === 'failed') stats.failed += 1;
      else if (record.status === 'pending') stats.pending += 1;
    }
    return stats;
  }

  clear(): void {
    this.records.clear();
    this.ids.clear();
    this.markDirty();
    this.flush();
    log.info('Database cleared');
  }

  close(): void {
    this.flush();
    log.info('Database connection closed');
  }
}
