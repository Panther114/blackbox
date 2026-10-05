import axios, { AxiosInstance } from 'axios';
import fs from 'fs';
import path from 'path';
import http from 'http';
import https from 'https';
import { EventEmitter } from 'events';
import pLimit from 'p-limit';
import pRetry, { AbortError } from 'p-retry';
import { Config, DiscoveredFile, DownloadableFile, DownloadLayout, ExistingFileState, FileTree } from '../types';
import { log } from '../utils/logger';
import {
  sanitizeFilename,
  getUniqueFilePath,
  isPathReserved,
  releaseReservedPath,
  getTmpFilePath,
  ensureDirectory,
  extractFilenameFromUrl,
  parseContentDisposition,
  formatBytes,
  sleep,
} from '../utils/helpers';
import {
  getAllowedExtFromName,
  hasBlockedExtension,
  isAllowedDocumentCandidate,
  isBlockedMimeType,
} from '../utils/fileValidation';
import { normalizeSupportedFilename } from '../utils/fileType';
import { DownloadDatabase } from '../database';
import { addFileToTree, flushFileTreeSave, scheduleFileTreeSave } from '../fileTree';
import {
  courseFolderForSavePath,
  isDownloadPresent,
  normalizeDownloadPath,
  preferredFlatFilename,
  resolveSavePathForLayout,
  scanDownloadDirectory,
} from '../downloadDirectory';
import { getFreeDiskSpace, LOW_DISK_SPACE_BYTES } from '../utils/helpers';
import { TransferTracker } from './transfer';

/** Milliseconds without data before a download stream is considered stalled. */
const INACTIVITY_TIMEOUT_MS = 30_000;

/** Timeout for HEAD requests used to fetch file metadata. */
const HEAD_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Minimum gap between two progress events for the same file. Keeps the
 * worker → main → renderer channel calm during fast transfers.
 */
const PROGRESS_THROTTLE_MS = 120;

/** Minimum gap between two metadata progress events. */
const METADATA_PROGRESS_THROTTLE_MS = 120;

/** Upper bound on concurrent HEAD requests (metadata is cheap, so beat the batch limit). */
const MAX_METADATA_CONCURRENCY = 12;

/** MIME type prefixes that indicate audio/video content (blocked). */
const BLOCKED_MEDIA_MIME_PREFIXES = ['video/', 'audio/'];

/** Shared empty set for URL lookups with no recorded path. */
const EMPTY_PATHS: Set<string> = new Set();

/** Final per-URL outcome reported back to callers of downloadFiles(). */
export type DownloadOutcome = 'completed' | 'skipped' | 'rejected' | 'failed' | 'cancelled';

/** Error message used to unwind a cancelled download without retrying it. */
export const DOWNLOAD_CANCELLED_MESSAGE = 'cancelled by user';

/**
 * Decide whether a failed download attempt is worth retrying. Permanent HTTP
 * failures (4xx other than 429) and a full disk must fail fast instead of
 * re-downloading `maxRetries` times.
 */
export function isRetryableDownloadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (message === DOWNLOAD_CANCELLED_MESSAGE) return false;
  if (/ENOSPC/i.test(message)) return false;
  const statusMatch = message.match(/HTTP (\d{3})/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    // Retry server errors and rate limiting; never retry permanent client errors.
    return status >= 500 || status === 429;
  }
  return true;
}

/**
 * Normalize Axios header values to a plain string.
 * Axios header entries can be string/number/boolean/array/object/null, but the
 * downloader metadata checks expect a simple string when possible.
 */
function getHeaderString(
  value:
    | string
    | number
    | boolean
    | string[]
    | import('axios').AxiosHeaders
    | null
    | undefined,
): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.join('; ');
  return undefined;
}

export class FileDownloader extends EventEmitter {
  private axios: AxiosInstance;
  private config: Config;
  private limiter: ReturnType<typeof pLimit>;
  private db: DownloadDatabase;
  private fileTree: FileTree;
  private indexedDownloadFiles: Set<string>;
  /** Set by cancel(); every queued and in-flight download stops immediately. */
  private cancelRequested = false;
  /** Live response streams, destroyed when the user cancels a download. */
  private activeStreams = new Set<{ destroy: (error?: Error) => void }>();
  /** Progress of the running batch; the UI shows its snapshots as they are. */
  private tracker: TransferTracker | null = null;
  /** Lazily built url -> local paths index of the file-tree cache (flat-layout dedupe). */
  private treePathsByUrl: Map<string, Set<string>> | null = null;

  constructor(config: Config, cookies: any[], db: DownloadDatabase, fileTree: FileTree) {
    super();
    this.config = config;
    this.db = db;
    this.fileTree = fileTree;
    this.indexedDownloadFiles = scanDownloadDirectory(config.downloadDir);
    this.limiter = pLimit(config.maxConcurrentDownloads);

    // Build cookie string from the authenticated Playwright session.
    const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    this.axios = axios.create({
      timeout: config.downloadTimeout,
      maxRedirects: 5,
      // Keep-alive reuses TCP connections across the many small file downloads.
      // Sockets are capped just above the concurrency limit so the limiter, not
      // the agent's queue, decides the parallelism.
      httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets: Math.max(4, config.maxConcurrentDownloads * 2),
        keepAliveMsecs: 15_000,
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        maxSockets: Math.max(4, config.maxConcurrentDownloads * 2),
        keepAliveMsecs: 15_000,
      }),
      headers: {
        Cookie: cookieString,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      // NOTE: do NOT include `auth` here — Blackboard uses cookie-based session
      // auth, not HTTP Basic Auth. Sending Basic credentials would add a
      // spurious Authorization header that can disrupt CSRF protections.
    });
  }

  // ---------------------------------------------------------------------------
  // Metadata
  // ---------------------------------------------------------------------------

  /**
   * Send HEAD requests for every file to populate size, mimeType, and the
   * real filename (from Content-Disposition) without downloading the file body.
   * Runs concurrently up to maxConcurrentDownloads.
   *
   * Media files (audio/video MIME types) are filtered out automatically.
   * Files where the server does not support HEAD are returned unchanged.
   */
  async fetchMetadata(files: DiscoveredFile[]): Promise<DiscoveredFile[]> {
    // HEAD requests are cheap and the batch limit is tuned for file bodies, so
    // metadata runs on its own, wider limiter.
    const headLimit = pLimit(Math.min(MAX_METADATA_CONCURRENCY, Math.max(this.config.maxConcurrentDownloads, 4)));
    let completed = 0;
    let lastProgressAt = 0;
    this.emit('files:metadata:progress', {
      phase: 'metadata',
      completed: 0,
      total: files.length,
      currentFile: '',
    });
    // Throttled like the download progress: the renderer only needs a pulse.
    const emitMetadataProgress = (force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressAt < METADATA_PROGRESS_THROTTLE_MS) return;
      lastProgressAt = now;
      this.emit('files:metadata:progress', {
        phase: 'metadata',
        completed,
        total: files.length,
        currentFile: '',
      });
    };

    const results = await Promise.all(
      files.map(file =>
        headLimit(async (): Promise<DiscoveredFile | null> => {
          try {
            const response = await this.axios.head(file.url, { timeout: HEAD_REQUEST_TIMEOUT_MS });
            const rawLength = getHeaderString(response.headers['content-length']);
            const size = rawLength ? parseInt(rawLength, 10) : undefined;
            const rawType = getHeaderString(response.headers['content-type']) ?? '';
            const mimeType = rawType.split(';')[0].trim().toLowerCase() || undefined;

            // Block media files by MIME type
            if (mimeType && BLOCKED_MEDIA_MIME_PREFIXES.some(p => mimeType.startsWith(p))) {
              log.debug(`Filtering media file (MIME: ${mimeType}): ${file.name} -> ${file.url}`);
              return null;
            }
            if (isBlockedMimeType(mimeType)) {
              log.debug(`Rejected metadata candidate (blocked MIME ${mimeType}): ${file.name} -> ${file.url}`);
              return null;
            }

            const extFromName = getAllowedExtFromName(file.name) ?? path.extname(file.name).slice(1);

            // Parse Content-Disposition to get the real server-side filename
            let resolvedName = file.name;
            const contentDisposition = response.headers['content-disposition'];
            if (contentDisposition) {
              const parsed = parseContentDisposition(contentDisposition);
              if (parsed) resolvedName = parsed;
            }

            const normalization = normalizeSupportedFilename(resolvedName, mimeType);
            resolvedName = normalization.normalizedName;
            const fileType = (normalization.extension ?? extFromName)?.toUpperCase();

            const allowedByNameOrMime = isAllowedDocumentCandidate({
              name: resolvedName,
              url: file.url,
              mimeType,
            });
            const blockedByExtension = hasBlockedExtension(resolvedName) || hasBlockedExtension(file.url);

            if (blockedByExtension) {
              log.debug(
                `Rejected metadata candidate (blocked extension): "${resolvedName}" -> ${file.url}`
              );
              return null;
            }

            if (!normalization.accepted || !allowedByNameOrMime) {
              log.debug(
                `Rejected metadata candidate (not in allowlist): ` +
                  `name="${resolvedName}", mime="${mimeType ?? '(none)'}", url="${file.url}"`
              );
              return null;
            }

            log.debug(
              `Metadata for "${file.name}": size=${size ?? '?'}, mime=${mimeType ?? '?'}, ` +
              `resolvedName="${resolvedName}", fileType=${fileType ?? '?'}`
            );

            return { ...file, name: resolvedName, size: size || undefined, mimeType, fileType };
          } catch {
            // HEAD not supported or network error — return file as-is.
            return file;
          } finally {
            completed += 1;
            emitMetadataProgress(completed === files.length);
          }
        })
      )
    );

    // Filter out null entries (blocked media files)
    const filtered = results.filter((f): f is DiscoveredFile => f !== null);
    this.emit('files:metadata:complete', {
      phase: 'metadata',
      completed: files.length,
      total: files.length,
      accepted: filtered.length,
    });
    return filtered;
  }

  // ---------------------------------------------------------------------------
  // Single-file download
  // ---------------------------------------------------------------------------

  /**
   * Stop the current batch: queued files are dropped and in-flight response
   * streams are destroyed so a cancelled download releases its connection at
   * once instead of finishing the file. Files already written to disk are
   * kept; partial downloads are still removed by the per-file cleanup.
   */
  cancel(): void {
    this.cancelRequested = true;
    for (const stream of this.activeStreams) {
      try {
        stream.destroy(new Error(DOWNLOAD_CANCELLED_MESSAGE));
      } catch {
        // A stream that is already closed throws here; nothing left to abort.
      }
    }
    this.activeStreams.clear();
  }

  /** True once cancel() was called for this downloader instance. */
  isCancelled(): boolean {
    return this.cancelRequested;
  }

  /**
   * Path of a copy of this URL that already sits directly inside `directory`,
   * or null when there is none. Both record sources are consulted (download
   * database and file-tree cache) so a copy written by an earlier run is still
   * recognized after another run recorded the same URL somewhere else.
   */
  private savedCopyInDirectory(url: string, directory: string): string | null {
    const targetDir = normalizeDownloadPath(directory);
    const candidates: string[] = [];

    const record = this.db.getDownload(url);
    if (record && record.status === 'completed' && record.path) candidates.push(record.path);
    for (const recorded of this.recordedPathsForUrl(url)) candidates.push(recorded);

    for (const candidate of candidates) {
      if (normalizeDownloadPath(path.dirname(candidate)) !== targetDir) continue;
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  /** Flat-layout equivalent of savedCopyInDirectory, for a download target. */
  private flatSavedPath(file: DownloadableFile): string | null {
    return this.savedCopyInDirectory(file.url, file.path);
  }

  /**
   * Target name inside a flat course folder: the plain filename while it is
   * free, otherwise qualified with the section so both sections keep their file.
   */
  private flatTargetName(directory: string, filename: string, sectionName?: string): string {
    return preferredFlatFilename(directory, filename, sectionName, candidate =>
      fs.existsSync(candidate) || isPathReserved(candidate),
    );
  }

  /**
   * Report, for every discovered file, which layouts already hold a copy of it.
   *
   * The two layouts keep separate bookkeeping because the copies live in
   * different places: a file saved by a folder-structure run is still pending
   * for a flat run, and a flat copy does not satisfy a folder-structure run.
   * Used by the selection screen, so the file list reflects the chosen layout
   * instead of one shared "already downloaded" flag.
   */
  inspectExisting(files: DiscoveredFile[]): Record<string, ExistingFileState> {
    // One disk index for the whole pass; refreshed here because discovery runs
    // before the first download batch.
    this.indexedDownloadFiles = scanDownloadDirectory(this.config.downloadDir);

    const state: Record<string, ExistingFileState> = {};
    for (const file of files) {
      const record = this.db.getDownload(file.url);
      state[file.url] = {
        hierarchy: this.hasSavedCopy(file, 'hierarchy'),
        flat: this.hasSavedCopy(file, 'flat'),
        size: record && record.status === 'completed' ? record.size : undefined,
      };
    }
    return state;
  }

  /** True when the layout already holds a copy of this discovered file on disk. */
  private hasSavedCopy(file: DiscoveredFile, layout: DownloadLayout): boolean {
    if (layout === 'flat') {
      const courseFolder = courseFolderForSavePath(this.config.downloadDir, file.savePath) ?? file.savePath;
      if (this.savedCopyInDirectory(file.url, courseFolder)) return true;
      const qualified = this.flatTargetName(courseFolder, file.name, file.sectionName);
      return (
        isDownloadPresent(this.indexedDownloadFiles, courseFolder, file.name) ||
        (qualified !== file.name && isDownloadPresent(this.indexedDownloadFiles, courseFolder, qualified))
      );
    }

    if (isDownloadPresent(this.indexedDownloadFiles, file.savePath, file.name)) return true;
    return this.savedCopyInDirectory(file.url, file.savePath) !== null;
  }

  /** Every local path the file-tree cache holds for one URL (built on first use). */
  private recordedPathsForUrl(url: string): Set<string> {
    if (!this.treePathsByUrl) {
      const index = new Map<string, Set<string>>();
      for (const course of Object.values(this.fileTree.courses)) {
        for (const section of Object.values(course.sections)) {
          for (const folder of Object.values(section.folders)) {
            for (const entry of Object.values(folder.files)) {
              if (!entry.url || !entry.localPath) continue;
              const paths = index.get(entry.url);
              if (paths) paths.add(entry.localPath);
              else index.set(entry.url, new Set([entry.localPath]));
            }
          }
        }
      }
      this.treePathsByUrl = index;
    }
    return this.treePathsByUrl.get(url) ?? EMPTY_PATHS;
  }

  /** Download a single file with retry logic.
   * Writes to a uniquely-named .tmp file first, then atomically renames to
   * the final path.  On any failure the .tmp file is deleted so partial
   * downloads never accumulate on disk.
   */
  private async downloadFile(file: DownloadableFile): Promise<DownloadOutcome> {
    if (this.cancelRequested) return 'cancelled';

    // Skip only when the current configured download directory already holds the
    // target. Hierarchy mode checks the file's own folder by name; flat mode
    // asks the recorded locations instead, because files from several sections
    // share one folder and names repeat there.
    const flat = file.layout === 'flat';
    const savedFlatPath = flat ? this.flatSavedPath(file) : null;
    if (savedFlatPath || (!flat && isDownloadPresent(this.indexedDownloadFiles, file.path, file.name))) {
      const skippedName = savedFlatPath ? path.basename(savedFlatPath) : file.name;
      log.debug(`Skipping already downloaded file: ${skippedName}`);
      this.emit('download:skip', { url: file.url, filename: skippedName });
      return 'skipped';
    }

    // Events are emitted exactly once per file: `download:start` before the
    // first attempt, `download:error` only after every retry is exhausted.
    // This keeps failure counts and byte progress truthful across retries.
    log.info(`Downloading: ${file.name}`);
    this.emit('download:start', file);

    let resolvedName = file.name;
    // Final outcome for the file, refined by whichever attempt resolves the
    // filename. Failed attempts throw and are handled by the retry tail.
    let attemptOutcome: DownloadOutcome = 'completed';

    const downloadFn = async (): Promise<void> => {
      this.tracker?.attempt(file.url);

      let finalPath: string | null = null;
      let tmpPath: string | null = null;

      try {
        const response = await this.axios.get(file.url, { responseType: 'stream' });

        // Axios rejects non-2xx by default; this guard accepts the whole 2xx
        // range (e.g. 206) instead of only 200.
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`HTTP ${response.status}`);
        }

        // Determine the final filename (prefer Content-Disposition, then URL).
        let filename = file.name;
        const contentDisposition = getHeaderString(response.headers['content-disposition']);
        const contentType = getHeaderString(response.headers['content-type']);
        const mimeType = contentType?.split(';')[0].trim().toLowerCase();

        // Log all relevant headers at debug level for troubleshooting
        log.debug(
          `Download headers for "${file.name}": ` +
          `Content-Disposition="${contentDisposition ?? '(none)'}",  ` +
          `Content-Type="${contentType ?? '(none)'}",  ` +
          `Content-Length="${response.headers['content-length'] ?? '(none)'}"`
        );

        if (contentDisposition) {
          const parsed = parseContentDisposition(contentDisposition);
          if (parsed) filename = parsed;
        }
        if (!filename) {
          filename = extractFilenameFromUrl(file.url);
        }

        const normalization = normalizeSupportedFilename(filename, mimeType);
        filename = normalization.normalizedName;
        if (!normalization.accepted) {
          log.warn(
            `Skipping file not in strict allowlist: name="${filename}", mime="${mimeType ?? '(none)'}", url="${file.url}"`
          );
          this.emit('download:rejected', { url: file.url, filename, reason: 'not-in-allowlist' });
          attemptOutcome = 'rejected';
          return;
        }

        const blockedByMime = isBlockedMimeType(mimeType);
        const blockedByExtension = hasBlockedExtension(filename) || hasBlockedExtension(file.url);
        const allowedFinal = isAllowedDocumentCandidate({ name: filename, url: file.url, mimeType });
        if (blockedByMime || blockedByExtension || !allowedFinal) {
          log.warn(
            `Skipping file not in strict allowlist: ` +
              `name="${filename}", mime="${mimeType ?? '(none)'}", url="${file.url}"`
          );
          this.emit('download:rejected', { url: file.url, filename, reason: 'blocked-type' });
          attemptOutcome = 'rejected';
          return;
        }

        filename = sanitizeFilename(filename);
        resolvedName = filename;

        // HEAD metadata may have exposed a server-side filename different from
        // the discovery label. Recheck the actual target after resolving it.
        // (Flat mode moved the decision to the recorded locations above, so a
        // server-side rename cannot double-download a file already saved.)
        if (!flat && isDownloadPresent(this.indexedDownloadFiles, file.path, filename)) {
          log.debug('Skipping already downloaded file on disk: ' + filename);
          this.emit('download:skip', { url: file.url, filename });
          attemptOutcome = 'skipped';
          return;
        }

        // Ensure the target directory exists.
        ensureDirectory(file.path);

        // Atomically reserve a unique final path (fixes TOCTOU race). In a flat
        // folder the section qualifies a repeated name before the running
        // "name (1)" counter does.
        const targetName = flat ? this.flatTargetName(file.path, filename, file.sectionName) : filename;
        finalPath = getUniqueFilePath(file.path, targetName);
        if (targetName !== filename) resolvedName = targetName;

        // Write to a randomly-named .tmp file; rename on success.
        tmpPath = getTmpFilePath(finalPath);

        // Track download progress with an inactivity watchdog.
        const totalSize = parseInt(getHeaderString(response.headers['content-length']) || '0', 10);
        const contentEncoding = getHeaderString(response.headers['content-encoding']);
        // When the response is compressed, Content-Length describes the wire
        // bytes, not the decompressed stream — skip verification in that case.
        const sizeIsTrustworthy = totalSize > 0 && !contentEncoding;
        let downloadedSize = 0;
        let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

        const resetInactivityTimer = () => {
          if (inactivityTimer) clearTimeout(inactivityTimer);
          inactivityTimer = setTimeout(() => {
            response.data.destroy(
              new Error(`Download stalled: no data received for ${INACTIVITY_TIMEOUT_MS / 1000}s`)
            );
          }, INACTIVITY_TIMEOUT_MS);
        };

        resetInactivityTimer();

        // Progress is throttled: a fast transfer produces thousands of chunks
        // and every event crosses the worker → main → renderer boundary. The
        // final sample is emitted when the stream finishes, so the UI still
        // lands on the true byte count.
        let lastProgressAt = 0;
        const emitProgress = (force = false) => {
          const now = Date.now();
          if (!force && now - lastProgressAt < PROGRESS_THROTTLE_MS) return;
          lastProgressAt = now;
          this.emit('download:progress', {
            url: file.url,
            filename,
            downloaded: downloadedSize,
            total: totalSize,
          });
        };

        response.data.on('data', (chunk: Buffer) => {
          resetInactivityTimer();
          downloadedSize += chunk.length;
          this.tracker?.progress(file.url, downloadedSize);
          emitProgress();
        });

        const writer = fs.createWriteStream(tmpPath);
        response.data.pipe(writer);

        // Track the live response stream so cancel() can abort it mid-file.
        const activeStream = response.data as { destroy: (error?: Error) => void };
        this.activeStreams.add(activeStream);

        await new Promise<void>((resolve, reject) => {
          writer.on('finish', () => {
            this.activeStreams.delete(activeStream);
            if (inactivityTimer) clearTimeout(inactivityTimer);
            emitProgress(true);
            resolve();
          });
          writer.on('error', (err: Error) => {
            this.activeStreams.delete(activeStream);
            if (inactivityTimer) clearTimeout(inactivityTimer);
            // Abort the HTTP stream so the connection is released immediately.
            response.data.destroy();
            reject(err);
          });
          response.data.on('error', (err: Error) => {
            this.activeStreams.delete(activeStream);
            if (inactivityTimer) clearTimeout(inactivityTimer);
            writer.destroy();
            reject(err);
          });
        });

        if (this.cancelRequested) {
          throw new AbortError(DOWNLOAD_CANCELLED_MESSAGE);
        }

        // A connection that closes cleanly mid-body still resolves the writer.
        // Verify the byte count so a truncated file is never saved as complete.
        if (sizeIsTrustworthy && downloadedSize !== totalSize) {
          throw new Error(
            `Download truncated: received ${downloadedSize} of ${totalSize} bytes for ${filename}`
          );
        }

        // Rename the finished .tmp file to the final path.
        fs.renameSync(tmpPath, finalPath);
        tmpPath = null; // no cleanup needed
        // The file now exists on disk, so the reservation is no longer needed.
        // Releasing it here keeps the reservation set clean for the lifetime of
        // the process (e.g. a GUI worker that serves many runs).
        releaseReservedPath(finalPath);

        const fileSize = fs.statSync(finalPath).size;
        this.tracker?.recordActualSize(file.url, fileSize);
        this.db.upsertDownload({
          url: file.url,
          path: finalPath,
          filename,
          status: 'completed',
          size: fileSize,
          downloadedAt: new Date(),
        });

        // Update the file tree cache.  We derive course/section/folder from the
        // DownloadableFile path (which follows the <course>/<section>/... layout).
        this.updateFileTree(file, finalPath, filename, fileSize);

        this.emit('download:complete', { url: file.url, filename, size: fileSize });
        log.info(`✓ Saved: ${filename} (${formatBytes(fileSize)})`);
      } catch (error: any) {
        // Clean up any partial .tmp file. Stream destruction is asynchronous,
        // so a plain unlinkSync can hit EPERM/EBUSY on Windows; retry briefly.
        if (tmpPath) {
          const doomedTmpPath = tmpPath;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              fs.unlinkSync(doomedTmpPath);
              break;
            } catch (unlinkError: any) {
              if (attempt === 2) {
                log.debug(`Could not remove temporary file ${doomedTmpPath}: ${unlinkError.message}`);
              } else {
                await sleep(100);
              }
            }
          }
        }
        // Release the path reservation so future retries can reclaim it.
        // (Deleting a non-existent reservation is harmless.)
        if (finalPath) {
          releaseReservedPath(finalPath);
        }

        // A cancelled download is not a failure: unwind without retrying and
        // without counting the file as failed in the run summary.
        if (this.cancelRequested) {
          log.info(`Cancelled while downloading ${file.name}; partial file removed.`);
          throw new AbortError(DOWNLOAD_CANCELLED_MESSAGE);
        }

        log.error(`Failed to download ${file.name}: ${error.message}`);
        // Permanent failures (4xx, disk full) must not be retried: wrapping in
        // AbortError stops pRetry immediately while keeping the message.
        if (!isRetryableDownloadError(error)) {
          throw new AbortError(error.message);
        }
        throw error;
      }
    };

    try {
      await pRetry(downloadFn, {
        retries: this.config.maxRetries,
        minTimeout: this.config.retryDelay,
        onFailedAttempt: error => {
          log.warn(
            `Download attempt ${error.attemptNumber} failed for ${file.name}. ` +
              `${error.retriesLeft} retries left.`
          );
        },
      });
    } catch (error: any) {
      if (this.cancelRequested) {
        return 'cancelled';
      }
      // Retry handling is complete: report the failure exactly once, using the
      // most specific name the attempts resolved to.
      this.emit('download:error', { url: file.url, filename: resolvedName, error: error.message });

      this.db.upsertDownload({
        url: file.url,
        path: file.path,
        filename: resolvedName,
        status: 'failed',
        error: error.message,
      });

      log.error(`Failed to download ${file.name} after ${this.config.maxRetries} retries`);
      return 'failed';
    }
    return attemptOutcome;
  }

  // ---------------------------------------------------------------------------
  // File tree cache
  // ---------------------------------------------------------------------------

  /**
   * Derive course/section/folder from the file path layout and update the
   * in-memory file tree.  The write is coalesced (see scheduleFileTreeSave) so
   * a large batch costs a handful of writes instead of one per file; the batch
   * flushes it when the downloads finish.
   */
  private updateFileTree(
    file: DownloadableFile,
    finalPath: string,
    filename: string,
    fileSize: number,
  ): void {
    try {
      // The file.path should follow <downloadDir>/<course>/<section>/[subfolder/].
      // A flat run drops the trailing segments, so fall back to the discovered
      // section name to keep the tree metadata accurate either way.
      const relPath = path.relative(this.config.downloadDir, file.path);
      const parts = relPath.split(path.sep).filter(Boolean);

      const courseName = parts[0] || file.courseName || 'Unknown Course';
      const sectionName = parts[1] || file.sectionName || 'Unknown Section';
      const folderPath = file.path;

      addFileToTree(this.fileTree, courseName, sectionName, folderPath, filename, {
        url: file.url,
        localPath: finalPath,
        size: fileSize,
        downloadedAt: new Date().toISOString(),
        mimeType: file.mimeType,
      });

      scheduleFileTreeSave(this.fileTree, this.config.fileTreePath);
    } catch (err: any) {
      log.debug(`Failed to update file tree: ${err.message}`);
    }
  }
  // ---------------------------------------------------------------------------
  // Batch download
  // ---------------------------------------------------------------------------

  /**
   * Download multiple files concurrently, honouring the global p-limit queue.
   * All files are submitted at once so the limiter can schedule them optimally
   * instead of being constrained to a single folder's batch.
   *
   * Returns a per-URL outcome map so callers (e.g. the agent sync) can report
   * accurate per-file statuses instead of assuming every file succeeded.
   */
  async downloadFiles(files: DownloadableFile[]): Promise<Record<string, { status: DownloadOutcome; error?: string }>> {
    const outcomes: Record<string, { status: DownloadOutcome; error?: string }> = {};
    if (files.length === 0) {
      log.debug('No files to download');
      return outcomes;
    }

    log.info(`Starting download of ${files.length} files...`);

    const freeBytes = getFreeDiskSpace(this.config.downloadDir);
    if (freeBytes !== null && freeBytes < LOW_DISK_SPACE_BYTES) {
      log.warn(
        `Low disk space before downloading: ${formatBytes(freeBytes)} free in ` +
          `${this.config.downloadDir}. Downloads may fail with ENOSPC.`
      );
    }

    // Refresh for every batch so a changed download directory or a manual
    // deletion is reflected immediately, even when this instance is reused.
    this.indexedDownloadFiles = scanDownloadDirectory(this.config.downloadDir);

    // One tracker per batch: every file reports its fate here, and the UI renders the snapshots.
    const tracker = new TransferTracker(files);
    this.tracker = tracker;
    const publish = () => this.emit('transfer:progress', tracker.snapshot());
    publish();
    const ticker = setInterval(publish, 200);

    let results: DownloadOutcome[];
    try {
      results = await Promise.all(
        files.map(file =>
          this.limiter(async () => {
            if (this.cancelRequested) {
              // Drain the queue instantly: a cancelled batch must not keep
              // starting new connections while the UI unwinds.
              outcomes[file.url] = { status: 'cancelled' };
              tracker.settle(file.url, 'cancelled');
              return 'cancelled' as DownloadOutcome;
            }
            const outcome = await this.downloadFile(file);
            outcomes[file.url] = { status: outcome };
            tracker.settle(file.url, outcome);
            return outcome;
          })
        )
      );
    } finally {
      clearInterval(ticker);
      publish();
      this.tracker = null;
    }

    const failedCount = results.filter(outcome => outcome === 'failed').length;
    const cancelledCount = results.filter(outcome => outcome === 'cancelled').length;
    // Persist the coalesced file-tree updates once for the whole batch.
    flushFileTreeSave();
    log.info(
      `Batch download completed: ${results.filter(o => o === 'completed').length} downloaded, ` +
        `${results.filter(o => o === 'skipped').length} skipped, ` +
        `${results.filter(o => o === 'rejected').length} rejected, ` +
        `${failedCount} failed` +
        (cancelledCount > 0 ? `, ${cancelledCount} cancelled by user` : '')
    );
    return outcomes;
  }

  /**
   * Download a list of DiscoveredFile objects (from the selection GUI).
   * Converts them to DownloadableFile and delegates to downloadFiles().
   *
   * `layout` selects the on-disk structure: `hierarchy` (default) keeps the
   * course / section / folder tree, `flat` writes every file into its course
   * folder. Both layouts can coexist in the same download directory.
   */
  async downloadSelected(
    files: DiscoveredFile[],
    layout: DownloadLayout = 'hierarchy',
  ): Promise<Record<string, { status: DownloadOutcome; error?: string }>> {
    const downloadable: DownloadableFile[] = files.map(f => ({
      name: f.name,
      url: f.url,
      path: resolveSavePathForLayout(this.config.downloadDir, f.savePath, layout),
      size: f.size,
      mimeType: f.mimeType,
      status: 'pending' as const,
      courseName: f.courseName,
      sectionName: f.sectionName,
      layout,
    }));
    return this.downloadFiles(downloadable);
  }

  // ---------------------------------------------------------------------------
  // Statistics
  // ---------------------------------------------------------------------------

  getStats() {
    return this.db.getStats();
  }
}
