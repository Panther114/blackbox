import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { FileDownloader, isRetryableDownloadError, DownloadOutcome } from '../src/downloader';
import { DownloadDatabase } from '../src/database';
import { getConfig } from '../src/config';
import { FileTree } from '../src/types';

/**
 * Regression tests for cancelling a running download.
 *
 * The GUI had no way to stop a transfer: the download stage offered only
 * "Open downloads" and "Open logs". Cancelling must abort in-flight transfers,
 * drop the queued files, keep whatever already finished and never fail the
 * cancelled files (they are not download errors).
 */

/** Streams `totalBytes` slowly enough that a cancel lands mid-transfer. */
function startSlowServer(totalBytes: number, chunkDelayMs: number): Promise<{ url: string; close: () => Promise<void> }> {
  const chunkSize = 64 * 1024;
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(totalBytes),
    });
    let sent = 0;
    const push = () => {
      if (sent >= totalBytes) {
        res.end();
        return;
      }
      const size = Math.min(chunkSize, totalBytes - sent);
      sent += size;
      res.write(Buffer.alloc(size, 0x41));
      setTimeout(push, chunkDelayMs);
    };
    push();
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/handout.pdf`,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

describe('download cancellation', () => {
  const cleanup: string[] = [];
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-cancel-'));
    cleanup.push(tempRoot);
    process.env.BB_USERNAME = 'test-user';
    process.env.BB_PASSWORD = 'test-password';
  });

  afterAll(() => {
    for (const dir of cleanup) {
      try {
        // Windows may still hold the SQLite WAL file briefly; the temp folder
        // is disposable either way.
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore: the OS temp cleaner removes what cannot be deleted now.
      }
    }
  });

  it('treats a cancelled transfer as a stop, not a retryable failure', () => {
    expect(isRetryableDownloadError(new Error('cancelled by user'))).toBe(false);
  });

  it('aborts the in-flight file and drops the queued ones', async () => {
    const downloadDir = path.join(tempRoot, 'downloads');
    const server = await startSlowServer(4 * 1024 * 1024, 60);
    const config = getConfig({
      downloadDir,
      databasePath: path.join(tempRoot, 'blackbox.db'),
      fileTreePath: path.join(tempRoot, 'file_tree.json'),
      logLevel: 'error',
      maxConcurrentDownloads: 1,
      maxRetries: 2,
      retryDelay: 10,
    });
    const fileTree: FileTree = { version: 1, generatedAt: new Date().toISOString(), courses: {} };
    const database = new DownloadDatabase(config.databasePath);
    const downloader = new FileDownloader(config, [], database, fileTree);

    const running = downloader.downloadSelected([
      { name: 'handout.pdf', url: server.url, courseName: 'Math', sectionName: 'Content', savePath: path.join(downloadDir, 'Math', 'Content'), status: 'pending' },
      { name: 'second.pdf', url: `${server.url}?second=1`, courseName: 'Math', sectionName: 'Content', savePath: path.join(downloadDir, 'Math', 'Content'), status: 'pending' },
    ]);

    setTimeout(() => downloader.cancel(), 120);
    const outcomes: Record<string, { status: DownloadOutcome }> = await running;
    await server.close();
    database.close();

    expect(downloader.isCancelled()).toBe(true);
    expect(Object.values(outcomes).map(outcome => outcome.status)).toEqual(['cancelled', 'cancelled']);

    // Nothing was written: no partial .tmp file and no finished file survive.
    const written = fs.existsSync(downloadDir)
      ? fs.readdirSync(downloadDir, { recursive: true }).map(String).filter(name => !name.endsWith('Math') && !name.endsWith('Content'))
      : [];
    expect(written).toEqual([]);
  }, 20000);
});
