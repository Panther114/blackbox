import fs from 'fs';
import os from 'os';
import path from 'path';
import { sanitizeFilename } from './utils/helpers';

/**
 * Return a stable absolute path key for the current platform.
 * Windows paths are case-insensitive; normalising them here keeps the disk
 * index accurate when Blackboard or a user changes filename casing.
 */
export function normalizeDownloadPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Scan the configured download directory once and index every regular file.
 * Directory entries and symlinks are not followed, which prevents a malformed
 * download tree from causing recursive traversal outside the chosen folder.
 */
export function scanDownloadDirectory(downloadDir: string): Set<string> {
  const files = new Set<string>();
  const root = path.resolve(downloadDir);

  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        files.add(normalizeDownloadPath(fullPath));
      }
    }
  };

  if (fs.existsSync(root)) visit(root);
  return files;
}

/**
 * Return the names the downloader can use before it receives a server-side
 * Content-Disposition filename. Both the displayed and sanitized names are
 * checked because older runs may have written either form.
 */
export function downloadPathCandidates(directory: string, filename: string): string[] {
  const names = [filename, sanitizeFilename(filename)];
  return Array.from(new Set(names.filter(Boolean).map(name => path.join(directory, name))));
}

/**
 * Check only the scan for the current configured directory. Keeping this
 * lookup scoped to the index prevents a stale file path from an earlier
 * download-directory setting from suppressing a new download.
 */
export function isDownloadPresent(
  indexedFiles: Set<string>,
  directory: string,
  filename: string,
): boolean {
  return downloadPathCandidates(directory, filename).some(candidate => indexedFiles.has(normalizeDownloadPath(candidate)));
}

/**
 * Safely remove the contents of a configured download directory while keeping
 * the directory itself available for the next run.
 */
export function clearDownloadDirectory(downloadDir: string): number {
  const resolved = path.resolve(downloadDir);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());

  if (resolved === root || resolved === home) {
    throw new Error('Refusing to clear a filesystem or home-directory root. Choose a dedicated download folder.');
  }

  if (!fs.existsSync(resolved)) {
    fs.mkdirSync(resolved, { recursive: true });
    return 0;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(resolved, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      'Could not read the download directory: ' +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  let removed = 0;
  for (const entry of entries) {
    const target = path.join(resolved, entry.name);
    try {
      fs.rmSync(target, { recursive: true, force: true });
      removed += 1;
    } catch (error) {
      throw new Error(
        'Could not remove "' +
          entry.name +
          '": ' +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return removed;
}
