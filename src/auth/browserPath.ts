import fs from 'fs';
import path from 'path';

/**
 * Resolve Chromium shipped beside the packaged app. The browser is placed in
 * resources/playwright-browsers by the platform release jobs so installed
 * macOS and Linux builds do not depend on a browser-specific system package.
 */
export function getBundledChromiumRelativeCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: NodeJS.Architecture = process.arch,
): string[] {
  if (platform === 'win32') return ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe'];
  if (platform === 'darwin') {
    return [
      `chrome-mac-${arch}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `chrome-mac-${arch}/Chromium.app/Contents/MacOS/Chromium`,
      'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
      'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return ['chrome-linux64/chrome', 'chrome-linux/chrome'];
}

export function getBundledChromiumExecutable(): string | undefined {
  const resourcesRoot = typeof process.resourcesPath === 'string' ? process.resourcesPath : '';
  const roots = [
    resourcesRoot ? path.join(resourcesRoot, 'playwright-browsers') : '',
    path.resolve(__dirname, '../../build/playwright-browsers'),
  ].filter(Boolean);

  const relativeCandidates = getBundledChromiumRelativeCandidates();

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let browserDirectories: string[];
    try {
      browserDirectories = fs
        .readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('chromium-'))
        .map(entry => path.join(root, entry.name));
    } catch {
      continue;
    }

    for (const browserDirectory of browserDirectories) {
      for (const relativePath of relativeCandidates) {
        const executable = path.join(browserDirectory, relativePath);
        if (fs.existsSync(executable)) return executable;
      }
    }
  }

  return undefined;
}
