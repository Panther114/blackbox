#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const browserDir = path.join(root, 'build', 'playwright-browsers');
fs.rmSync(browserDir, { recursive: true, force: true });
fs.mkdirSync(browserDir, { recursive: true });

const browserManifestPath = path.join(root, 'node_modules', 'playwright-core', 'browsers.json');
const browserManifest = JSON.parse(fs.readFileSync(browserManifestPath, 'utf8'));
const chromiumRevision = browserManifest.browsers.find((browser) => browser.name === 'chromium')?.revision;

function defaultPlaywrightCache() {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }

  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  }

  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright');
}

function platformExecutableCandidates(browserDirectory) {
  if (process.platform === 'win32') {
    return [
      path.join(browserDirectory, 'chrome-win64', 'chrome.exe'),
      path.join(browserDirectory, 'chrome-win', 'chrome.exe'),
    ];
  }

  if (process.platform === 'darwin') {
    return [
      path.join(browserDirectory, `chrome-mac-${process.arch}`, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(browserDirectory, `chrome-mac-${process.arch}`, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      path.join(browserDirectory, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
      path.join(browserDirectory, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
    ];
  }

  return [
    path.join(browserDirectory, 'chrome-linux64', 'chrome'),
    path.join(browserDirectory, 'chrome-linux', 'chrome'),
  ];
}

function isUsableCacheDir(source) {
  const completeMarker = path.join(source, 'INSTALLATION_COMPLETE');
  return (
    fs.existsSync(completeMarker) &&
    path.resolve(source) !== path.resolve(browserDir) &&
    platformExecutableCandidates(source).some((candidate) => fs.existsSync(candidate))
  );
}

/** Every Chromium build the local Playwright cache holds, newest first. */
function cachedChromiumBuilds() {
  const cacheRoot = defaultPlaywrightCache();
  let entries = [];
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      revision: Number(entry.name.split('-')[1]),
      directory: path.join(cacheRoot, entry.name),
    }))
    .sort((a, b) => b.revision - a.revision);
}

function stageFromExistingCache() {
  const builds = cachedChromiumBuilds();
  const expected = Number(chromiumRevision);
  // Prefer the revision playwright-core pins; any other cached Chromium build
  // is still a valid bundled browser, which keeps packaging possible on
  // machines that cannot reach the Playwright CDN.
  const ordered = [
    ...builds.filter((build) => build.revision === expected),
    ...builds.filter((build) => build.revision !== expected),
  ];

  const source = ordered.find((build) => isUsableCacheDir(build.directory));
  if (!source) return false;

  fs.cpSync(source.directory, path.join(browserDir, source.name), { recursive: true });
  if (expected && source.revision !== expected) {
    console.warn(
      `[prepare-browser] Warning: playwright-core expects chromium-${expected} but only chromium-${source.revision} is cached; bundling the cached build.`
    );
  }
  console.log(`[prepare-browser] Reused Chromium ${source.revision} from ${source.directory}`);
  return true;
}

if (stageFromExistingCache()) {
  console.log(`[prepare-browser] Chromium staged at ${browserDir}`);
  process.exit(0);
}

const localCli = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright-core.cmd' : 'playwright-core');
const result = spawnSync(localCli, ['install', 'chromium'], {
  cwd: root,
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserDir },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status !== 0) {
  process.exit(result.status || 1);
}

console.log(`[prepare-browser] Chromium staged at ${browserDir}`);
