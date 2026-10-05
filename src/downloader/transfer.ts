/**
 * Single source of truth for transfer progress. The downloader reports what
 * happens to each file; this turns it into one snapshot the UI can show as is.
 *
 * Rules that keep the numbers honest:
 *  - A file is "settled" once it is saved, skipped, rejected, failed or cancelled.
 *    Settled files count as processed, so the bar can reach 100% when the queue
 *    is done even if some files were skipped or failed (the counters say which).
 *  - Percent is by size only when nearly every file has a known size; otherwise it
 *    is by file count, and `basis` says which.
 *  - It never shows 100% while any file is still queued or in flight.
 *  - Speed is the real network rate over the last few seconds (retried bytes count,
 *    because they really crossed the wire); ETA appears only once it is trustworthy.
 */

export type TransferKind = 'completed' | 'skipped' | 'rejected' | 'failed' | 'cancelled';

export interface TransferSnapshot {
  total: number;
  settled: number;
  completed: number;
  skipped: number;
  rejected: number;
  failed: number;
  cancelled: number;
  /** Files currently being retried after a failed attempt. */
  retrying: number;
  /** Bytes represented by the bar: settled files plus in-flight progress. */
  bytes: number;
  totalBytes: number;
  unknownSize: number;
  percent: number;
  basis: 'bytes' | 'files';
  /** Bytes per second over the last few seconds. */
  speed: number;
  etaSeconds: number | null;
  elapsedMs: number;
  /** Names of the files being saved right now (most recent first, at most three). */
  active: string[];
}

interface FileState {
  name: string;
  expected: number;
  partial: number;
  attempts: number;
  active: boolean;
  settled: TransferKind | null;
  actual?: number;
}

const SPEED_WINDOW_MS = 4000;
/** Size-based percent needs at least this share of files to have a known size. */
const MIN_KNOWN_SHARE = 0.8;

export class TransferTracker {
  private readonly files = new Map<string, FileState>();
  private readonly startedAt: number;
  private readonly samples: Array<{ at: number; bytes: number }> = [];
  private transferred = 0;
  private activeOrder: string[] = [];

  constructor(files: Array<{ url: string; name: string; size?: number }>, now = Date.now()) {
    this.startedAt = now;
    for (const file of files) {
      this.files.set(file.url, { name: file.name, expected: file.size && file.size > 0 ? file.size : 0, partial: 0, attempts: 0, active: false, settled: null });
    }
  }

  /** A download attempt (the first or a retry) begins. Partial progress of a failed attempt is discarded. */
  attempt(url: string): void {
    const file = this.files.get(url);
    if (!file || file.settled) return;
    file.attempts += 1;
    file.partial = 0;
    file.active = true;
    this.activeOrder = [url, ...this.activeOrder.filter(candidate => candidate !== url)];
  }

  /** Total bytes received so far for this attempt. */
  progress(url: string, bytes: number, now = Date.now()): void {
    const file = this.files.get(url);
    if (!file || file.settled || bytes <= file.partial) return;
    this.transferred += bytes - file.partial;
    file.partial = bytes;
    this.sample(now);
  }

  /** The final size of a saved file, when the server's size estimate was wrong or missing. */
  recordActualSize(url: string, size: number): void {
    const file = this.files.get(url);
    if (file) file.actual = size;
  }

  settle(url: string, kind: TransferKind): void {
    const file = this.files.get(url);
    if (!file || file.settled) return;
    file.settled = kind;
    file.active = false;
    this.activeOrder = this.activeOrder.filter(candidate => candidate !== url);
  }

  private sample(now: number): void {
    this.samples.push({ at: now, bytes: this.transferred });
    while (this.samples.length > 1 && now - this.samples[0].at > SPEED_WINDOW_MS) this.samples.shift();
  }

  private speed(now: number): number {
    // Drop old samples even when nothing arrived, so a stalled transfer shows 0, not its last rate.
    while (this.samples.length > 0 && now - this.samples[0].at > SPEED_WINDOW_MS) this.samples.shift();
    if (this.samples.length < 2) return 0;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const seconds = (now - first.at) / 1000;
    return seconds >= 0.5 ? Math.max(0, (last.bytes - first.bytes) / seconds) : 0;
  }

  snapshot(now = Date.now()): TransferSnapshot {
    const counts = { completed: 0, skipped: 0, rejected: 0, failed: 0, cancelled: 0 };
    let settled = 0;
    let totalBytes = 0;
    let knownFiles = 0;
    let settledBytes = 0;
    let inFlightBytes = 0;
    let retrying = 0;
    for (const file of this.files.values()) {
      totalBytes += file.expected;
      if (file.expected > 0) knownFiles += 1;
      if (file.settled) {
        settled += 1;
        counts[file.settled] += 1;
        settledBytes += file.expected;
      } else if (file.active) {
        inFlightBytes += file.expected > 0 ? Math.min(file.partial, file.expected) : 0;
        if (file.attempts > 1) retrying += 1;
      }
    }
    const total = this.files.size;
    const basis: 'bytes' | 'files' = total > 0 && totalBytes > 0 && knownFiles / total >= MIN_KNOWN_SHARE ? 'bytes' : 'files';
    const done = settled === total && total > 0;
    let percent = 0;
    if (total > 0) {
      percent = basis === 'bytes' ? ((settledBytes + inFlightBytes) / totalBytes) * 100 : (settled / total) * 100;
      percent = done ? 100 : Math.min(percent, 99.9);
    }
    const speed = this.speed(now);
    const elapsedMs = Math.max(0, now - this.startedAt);
    const remaining = Math.max(0, totalBytes - settledBytes - inFlightBytes);
    const etaSeconds = !done && basis === 'bytes' && speed > 2048 && elapsedMs > 3000 ? Math.round(remaining / speed) : null;
    return {
      total,
      settled,
      ...counts,
      retrying,
      bytes: settledBytes + inFlightBytes,
      totalBytes,
      unknownSize: total - knownFiles,
      percent,
      basis,
      speed,
      etaSeconds,
      elapsedMs,
      active: this.activeOrder.slice(0, 3).map(url => this.files.get(url)?.name ?? ''),
    };
  }
}
