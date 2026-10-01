import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AddressInfo } from 'net';
import { FileDownloader, DownloadOutcome } from '../src/downloader';
import { DownloadDatabase } from '../src/database';
import { getConfig } from '../src/config';
import { loadFileTree } from '../src/fileTree';
import { Config, DiscoveredFile, DownloadLayout } from '../src/types';

/**
 * Layout tests for the manual download flow.
 *
 * A flat download writes every file of a course into the course folder, while a
 * folder-structure download keeps the course / section / folder tree. Both must
 * be able to run over the same course without overwriting each other, and a
 * repeated flat run must not pile up copies of files it already saved.
 */

function startFileServer(files: Record<string, string>): Promise<{
  url: (route: string) => string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const body = files[req.url || ''];
    if (body === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(Buffer.byteLength(body)),
    });
    res.end(body);
  });

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: route => `http://127.0.0.1:${port}${route}`,
        close: () => new Promise<void>(done => server.close(() => done())),
      });
    });
  });
}

describe('download layout', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-layout-run-'));
    process.env.BB_USERNAME = 'test-user';
    process.env.BB_PASSWORD = 'test-password';
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      // Windows may hold the SQLite WAL file briefly; the temp folder is disposable.
    }
  });

  function layoutConfig(downloadDir: string): Config {
    return getConfig({
      downloadDir,
      databasePath: path.join(tempRoot, 'blackbox.db'),
      fileTreePath: path.join(tempRoot, 'file_tree.json'),
      logLevel: 'error',
      maxConcurrentDownloads: 2,
      maxRetries: 1,
      retryDelay: 10,
    });
  }

  /** One download run: fresh database and reloaded file tree, like a new session. */
  async function runLayout(
    config: Config,
    files: DiscoveredFile[],
    layout: DownloadLayout,
  ): Promise<Record<string, { status: DownloadOutcome }>> {
    const database = new DownloadDatabase(config.databasePath);
    const downloader = new FileDownloader(config, [], database, loadFileTree(config.fileTreePath));
    const outcomes = await downloader.downloadSelected(files, layout);
    database.close();
    return outcomes;
  }

  function fileContentNames(directory: string): string[] {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name);
  }

  it('keeps every section file in a flat course folder and stays idempotent', async () => {
    const server = await startFileServer({
      '/w1/Lecture.pdf': 'week-1',
      '/w2/Lecture.pdf': 'week-2',
    });
    const downloadDir = path.join(tempRoot, 'downloads');
    const config = layoutConfig(downloadDir);
    const courseRoot = path.join(downloadDir, 'Math');
    const discovered: DiscoveredFile[] = [
      {
        name: 'Lecture.pdf',
        url: server.url('/w1/Lecture.pdf'),
        courseName: 'Math',
        sectionName: 'Week 1',
        savePath: path.join(courseRoot, 'Week 1'),
        status: 'pending',
      },
      {
        name: 'Lecture.pdf',
        url: server.url('/w2/Lecture.pdf'),
        courseName: 'Math',
        sectionName: 'Week 2',
        savePath: path.join(courseRoot, 'Week 2'),
        status: 'pending',
      },
    ];

    try {
      const flat = await runLayout(config, discovered, 'flat');
      expect(Object.values(flat).map(outcome => outcome.status)).toEqual(['completed', 'completed']);

      // Both files survive the name clash: one keeps the plain name, the other
      // is qualified with its section instead of being skipped.
      const names = fileContentNames(courseRoot);
      expect(names).toHaveLength(2);
      expect(names).toContain('Lecture.pdf');
      const bodies = names.map(name => fs.readFileSync(path.join(courseRoot, name), 'utf8')).sort();
      expect(bodies).toEqual(['week-1', 'week-2']);

      // A second flat run saves nothing new: already saved files are skipped.
      const again = await runLayout(config, discovered, 'flat');
      expect(Object.values(again).map(outcome => outcome.status)).toEqual(['skipped', 'skipped']);
      expect(fileContentNames(courseRoot).sort()).toEqual(names.sort());
    } finally {
      await server.close();
    }
  }, 20000);

  it('lets a folder-structure run and a flat run share one course folder', async () => {
    const server = await startFileServer({
      '/w1/Lecture.pdf': 'week-1',
      '/w2/Lecture.pdf': 'week-2',
    });
    const downloadDir = path.join(tempRoot, 'downloads');
    const config = layoutConfig(downloadDir);
    const courseRoot = path.join(downloadDir, 'Math');
    const discovered: DiscoveredFile[] = [
      {
        name: 'Lecture.pdf',
        url: server.url('/w1/Lecture.pdf'),
        courseName: 'Math',
        sectionName: 'Week 1',
        savePath: path.join(courseRoot, 'Week 1'),
        status: 'pending',
      },
      {
        name: 'Lecture.pdf',
        url: server.url('/w2/Lecture.pdf'),
        courseName: 'Math',
        sectionName: 'Week 2',
        savePath: path.join(courseRoot, 'Week 2'),
        status: 'pending',
      },
    ];

    try {
      // Folder-structure first: the files land in their section folders.
      await runLayout(config, discovered, 'hierarchy');
      expect(fs.readFileSync(path.join(courseRoot, 'Week 1', 'Lecture.pdf'), 'utf8')).toBe('week-1');
      expect(fs.readFileSync(path.join(courseRoot, 'Week 2', 'Lecture.pdf'), 'utf8')).toBe('week-2');

      // Then a flat run: copies appear in the course folder, the nested tree stays.
      const flat = await runLayout(config, discovered, 'flat');
      expect(Object.values(flat).map(outcome => outcome.status)).toEqual(['completed', 'completed']);
      const flatNames = fileContentNames(courseRoot);
      expect(flatNames).toHaveLength(2);
      expect(flatNames).toContain('Lecture.pdf');
      expect(fs.readFileSync(path.join(courseRoot, 'Week 1', 'Lecture.pdf'), 'utf8')).toBe('week-1');
      expect(fs.readFileSync(path.join(courseRoot, 'Week 2', 'Lecture.pdf'), 'utf8')).toBe('week-2');

      // A folder-structure run afterwards must not re-download into section
      // folders that already hold the files, and a flat run stays idempotent.
      const hierarchyAgain = await runLayout(config, discovered, 'hierarchy');
      expect(Object.values(hierarchyAgain).map(outcome => outcome.status)).toEqual(['skipped', 'skipped']);
      const flatAgain = await runLayout(config, discovered, 'flat');
      expect(Object.values(flatAgain).map(outcome => outcome.status)).toEqual(['skipped', 'skipped']);
      expect(fileContentNames(courseRoot).sort()).toEqual(flatNames.sort());
    } finally {
      await server.close();
    }
  }, 30000);
});
