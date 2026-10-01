import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { AddressInfo } from 'net';
import { Page } from 'playwright-core';
import { BlackboardScraper } from '../src/scraper';
import { BlackboxDownloader } from '../src/index';
import { FileDownloader, DownloadOutcome } from '../src/downloader';
import { DownloadDatabase } from '../src/database';
import { getConfig } from '../src/config';
import { loadFileTree } from '../src/fileTree';
import { Config, Course, DiscoveredFile, FileTree } from '../src/types';
import { shouldBlockRequest } from '../src/auth/resourcePolicy';

/**
 * Speed-related behaviour.
 *
 * Discovery used to pay for page loads it did not need (a browser "back"
 * between sibling folders, a portal page between courses) and downloaded with
 * a conservative concurrency. Downloads also flooded the worker → main →
 * renderer channel with one progress message per received chunk. These tests
 * pin the behaviour that replaced it.
 */

const BASE_URL = 'https://shs.blackboardchina.cn';

function anchor(href: string, text: string) {
  return {
    getAttribute: (name: string) => (name === 'href' ? href : null),
    textContent: text,
    innerHTML: text,
    closest: () => null,
    parentElement: { textContent: text },
    querySelector: (selector: string) => (selector === 'span' ? { getAttribute: () => text } : null),
    querySelectorAll: () => [],
  };
}

/** Minimal Playwright page that serves canned anchor sets per selector. */
function fakePage(routes: Record<string, { files?: Array<[string, string]>; folders?: Array<[string, string]> }>, sidebarHref: string) {
  let currentUrl = `${BASE_URL}/webapps/portal/`;
  const visited: string[] = [];
  let goBackCalls = 0;

  const page = {
    url: () => currentUrl,
    title: async () => 'Blackboard',
    waitForTimeout: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForSelector: async () => undefined,
    click: async () => undefined,
    goBack: async () => {
      goBackCalls += 1;
      currentUrl = `${BASE_URL}/webapps/portal/`;
    },
    goto: async (url: string) => {
      visited.push(url);
      currentUrl = url;
      return null;
    },
    $$eval: async (selector: string, callback: (elements: unknown[]) => unknown) => {
      const route = routes[currentUrl] || {};
      if (selector === '#courseMenuPalette_contents li a') {
        return callback([anchor(sidebarHref, 'Course Content')]);
      }
      if (selector === 'div.item.clearfix a') {
        return callback((route.folders || []).map(([href, text]) => anchor(href, text)));
      }
      if (selector === '#content_listContainer a[href]') {
        return callback((route.files || []).map(([href, text]) => anchor(href, text)));
      }
      if (selector === '#content_listContainer .liItem, #content_listContainer .item') {
        return callback([]);
      }
      return callback([]);
    },
  };

  return {
    page,
    visited,
    goBackCalls: () => goBackCalls,
  };
}

function scraperConfig(root: string): Config {
  return getConfig({
    downloadDir: path.join(root, 'downloads'),
    databasePath: path.join(root, 'blackbox.db'),
    fileTreePath: path.join(root, 'file_tree.json'),
    logLevel: 'error',
    courseFilter: undefined,
  });
}

describe('fast discovery navigation', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-fast-'));
    // The config schema requires credentials even though discovery never logs in.
    process.env.BB_USERNAME = 'test-user';
    process.env.BB_PASSWORD = 'test-password';
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('walks folders without a browser "back" and without re-loading a page', async () => {
    const nested = `${BASE_URL}/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_2_1`;
    const section = `${BASE_URL}/webapps/blackboard/content/listContent.jsp?course_id=_1_1&content_id=_3_1`;
    const courseUrl = `${BASE_URL}/webapps/blackboard/execute/launcher?type=Course&id=_1_1`;

    const fake = fakePage({
      [courseUrl]: { files: [], folders: [[section, 'Course Materials']] },
      [section]: {
        files: [['/bbcswebdav/pid-1-dt-content-rid-1_1/xid-1_1/Handout.pdf', 'Handout.pdf']],
        folders: [[nested, 'Week 1']],
      },
      [nested]: {
        files: [['/bbcswebdav/pid-2-dt-content-rid-2_1/xid-2_1/Slides.pdf', 'Slides.pdf']],
        folders: [],
      },
    }, section);

    const config = scraperConfig(tempRoot);
    const scraper = new BlackboardScraper(fake.page as unknown as Page, config);
    const downloader = new BlackboxDownloader(config);
    (downloader as unknown as { scraper: BlackboardScraper }).scraper = scraper;

    const courses: Course[] = [
      { id: '_1_1', name: 'Math', url: courseUrl, path: 'Math' },
    ];

    try {
      const files: DiscoveredFile[] = await downloader.discoverAllFiles(courses);

      expect(files.map(file => file.name).sort()).toEqual(['Handout.pdf', 'Slides.pdf']);
      // No browser "back" between sibling folders: every folder URL is known
      // before the recursion, so going back is a wasted page load.
      expect(fake.goBackCalls()).toBe(0);
      // Each page is loaded exactly once.
      const duplicates = fake.visited.filter((url, index) => fake.visited.indexOf(url) !== index);
      expect(duplicates).toEqual([]);
    } finally {
      await downloader.cleanup();
    }
  });

  it('does not navigate again when the browser already shows the wanted page', async () => {
    const config = scraperConfig(tempRoot);
    const fake = fakePage({}, `${BASE_URL}/webapps/blackboard/content/listContent.jsp?course_id=_1_1`);
    const scraper = new BlackboardScraper(fake.page as unknown as Page, config);

    const target = `${BASE_URL}/webapps/blackboard/content/listContent.jsp?course_id=_1_1`;
    await scraper.navigateTo(target);
    await scraper.navigateTo(target);

    expect(fake.visited).toEqual([target]);
  });
});

describe('resource policy', () => {
  it('blocks images, media, fonts and analytics but never documents or stylesheets', () => {
    expect(shouldBlockRequest({ url: `${BASE_URL}/images/logo.png`, resourceType: 'image' })).toContain('type:image');
    expect(shouldBlockRequest({ url: 'https://video.example/lecture.mp4', resourceType: 'media' })).not.toBeNull();
    expect(shouldBlockRequest({ url: 'https://fonts.gstatic.com/x.woff2', resourceType: 'font' })).not.toBeNull();
    expect(shouldBlockRequest({ url: 'https://www.google-analytics.com/collect', resourceType: 'script' })).toContain('host:');
    expect(shouldBlockRequest({ url: `${BASE_URL}/webapps/blackboard/content/listContent.jsp`, resourceType: 'document' })).toBeNull();
    expect(shouldBlockRequest({ url: `${BASE_URL}/styles/bb.css`, resourceType: 'stylesheet' })).toBeNull();
    expect(shouldBlockRequest({ url: `${BASE_URL}/scripts/menu.js`, resourceType: 'script' })).toBeNull();
  });
});

describe('download throughput behaviour', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-throughput-'));
    process.env.BB_USERNAME = 'test-user';
    process.env.BB_PASSWORD = 'test-password';
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /** Streams `totalBytes` in small chunks as fast as the socket accepts them. */
  function startFastServer(totalBytes: number): Promise<{ url: string; close: () => Promise<void> }> {
    const chunk = Buffer.alloc(64 * 1024, 0x41);
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(totalBytes) });
      let sent = 0;
      const push = () => {
        if (sent >= totalBytes) {
          res.end();
          return;
        }
        sent += chunk.length;
        if (res.write(chunk)) setImmediate(push);
        else res.once('drain', push);
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

  it('throttles progress events while still reporting the final byte count', async () => {
    const totalBytes = 6 * 1024 * 1024;
    const server = await startFastServer(totalBytes);
    const config = getConfig({
      downloadDir: path.join(tempRoot, 'downloads'),
      databasePath: path.join(tempRoot, 'blackbox.db'),
      fileTreePath: path.join(tempRoot, 'file_tree.json'),
      logLevel: 'error',
      maxConcurrentDownloads: 2,
      maxRetries: 1,
      retryDelay: 10,
    });
    const fileTree: FileTree = { version: 1, generatedAt: new Date().toISOString(), courses: {} };
    const database = new DownloadDatabase(config.databasePath);
    const downloader = new FileDownloader(config, [], database, fileTree);

    const progress: Array<{ downloaded: number; total: number }> = [];
    downloader.on('download:progress', payload => progress.push(payload));

    try {
      const outcomes = await downloader.downloadSelected([
        {
          name: 'handout.pdf',
          url: server.url,
          courseName: 'Math',
          sectionName: 'Content',
          savePath: path.join(config.downloadDir, 'Math', 'Content'),
          status: 'pending',
        },
      ]);

      expect((outcomes[server.url] as { status: DownloadOutcome }).status).toBe('completed');
      // 96 chunks arrive at the socket, but the UI only needs a pulse.
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.length).toBeLessThan(24);
      expect(progress[progress.length - 1].downloaded).toBe(totalBytes);
    } finally {
      database.close();
      await server.close();
    }
  }, 30000);

  it('downloads with a wider default concurrency than the old five', () => {
    const config = getConfig({
      downloadDir: path.join(tempRoot, 'downloads'),
      databasePath: path.join(tempRoot, 'blackbox.db'),
      fileTreePath: path.join(tempRoot, 'file_tree.json'),
      logLevel: 'error',
    });
    expect(config.maxConcurrentDownloads).toBe(8);
  });
});
