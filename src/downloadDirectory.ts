import fs from 'fs';
import os from 'os';
import path from 'path';
import { DownloadLayout } from './types';
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
 * Map a discovered save path to the directory the file is written into for the
 * requested layout. `hierarchy` keeps the path Blackboard produced
 * (<downloadDir>/<course>/<section>/<subfolder>); `flat` collapses every file
 * into its course folder, so a flat run and a hierarchy run share the course
 * directory without overwriting each other (name clashes are still resolved by
 * getUniqueFilePath).
 *
 * A path that already sits at the course root, or outside the download
 * directory, is returned unchanged.
 */
export function resolveSavePathForLayout(
  downloadDir: string,
  savePath: string,
  layout: DownloadLayout = 'hierarchy',
): string {
  if (layout !== 'flat') return savePath;

  const root = path.resolve(downloadDir);
  const resolved = path.resolve(savePath);
  const relative = path.relative(root, resolved);
  const segments =
    relative && !relative.startsWith('..') && !path.isAbsolute(relative)
      ? relative.split(path.sep).filter(Boolean)
      : [];

  if (segments.length <= 1) return savePath;
  return path.join(root, segments[0]);
}

/** The course folder a discovered file belongs to (first path segment under downloadDir). */
export function courseFolderForSavePath(downloadDir: string, savePath: string): string | null {
  const root = path.resolve(downloadDir);
  const relative = path.relative(root, path.resolve(savePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep).filter(Boolean);
  if (segments.length === 0) return null;
  return path.join(root, segments[0]);
}

/**
 * Name to use inside a flat course folder. The plain name is kept while it is
 * free; once some other file occupies it, the name is qualified with the
 * section ("Lecture.pdf" -> "Lecture (Week 2).pdf") so two sections never lose
 * a file to a name clash. The downloader uniquifies any remaining clash.
 */
export function preferredFlatFilename(
  directory: string,
  filename: string,
  sectionName?: string,
  isTaken: (candidate: string) => boolean = candidate => fs.existsSync(candidate),
): string {
  if (!isTaken(path.join(directory, filename))) return filename;

  // Guard the raw section: sanitizeFilename substitutes a placeholder for an
  // empty string, which would turn "Lecture.pdf" into "Lecture (file).pdf".
  const rawSection = (sectionName || '').trim();
  if (!rawSection) return filename;

  const section = sanitizeFilename(rawSection).trim();
  if (!section) return filename;

  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const candidate = `${base} (${section})${ext}`;
  if (candidate.length > 180) return filename;

  return candidate;
}

/**
 * Remove empty directories below `rootDir` (never the root itself, never files,
 * never symlinks). Used after a flat download so the folder shells created
 * during discovery do not survive as an empty hierarchy next to the flat files.
 */
export function pruneEmptyDirectories(rootDir: string): number {
  const root = path.resolve(rootDir);
  let removed = 0;

  const pruneChildren = (directory: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      // Unreadable directory: treat it as non-empty and keep it.
      return false;
    }

    let empty = true;
    for (const entry of entries) {
      // a symlink reports isDirectory() === false, so links are never followed.
      if (!entry.isDirectory()) {
        empty = false;
        continue;
      }
      const child = path.join(directory, entry.name);
      if (pruneChildren(child)) {
        try {
          fs.rmdirSync(child);
          removed += 1;
        } catch {
          empty = false;
        }
      } else {
        empty = false;
      }
    }
    return empty;
  };

  if (!fs.existsSync(root)) return 0;
  pruneChildren(root);
  return removed;
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

  // Compare case-insensitively on Windows: path.resolve does not normalize
  // casing, so "c:\users\admin" must still be recognized as the home
  // directory. Also refuse any ancestor of home (e.g. C:\Users), because
  // clearing those would wipe other users' data including home itself.
  const key = (p: string): string => normalizeDownloadPath(p);
  const isHomeOrAncestorOfHome = (candidate: string): boolean => {
    const rel = path.relative(candidate, home);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };

  if (key(resolved) === key(root) || key(resolved) === key(home) || isHomeOrAncestorOfHome(resolved)) {
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
