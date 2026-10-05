import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearDownloadDirectory, courseFolderForSavePath, preferredFlatFilename, pruneEmptyDirectories, resolveSavePathForLayout } from '../src/downloadDirectory';
import { Course, DiscoveredFile, ExistingFileState } from '../src/types';
import { filterCourses } from '../src/workflow/downloadWorkflow';
import { FileDownloader } from '../src/downloader';
import { DownloadDatabase } from '../src/database';
import { getConfig } from '../src/config';
import { loadFileTree } from '../src/fileTree';

function discoveredFile(savePath: string, name: string): DiscoveredFile {
  return {
    name,
    url: 'https://blackboard.example/file/' + encodeURIComponent(name),
    courseName: 'Course A',
    sectionName: 'Week 1',
    savePath,
    status: 'pending',
  };
}

function course(id: string, name: string): Course {
  return { id, name, url: 'https://blackboard.example/course/' + id, path: id };
}

describe('download directory source of truth', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-downloads-'));
    process.env.BB_USERNAME = 'test-user';
    process.env.BB_PASSWORD = 'test-password';
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  /** Inspect the disk through the downloader, the way the selection screen does. */
  function inspect(downloadDir: string, files: DiscoveredFile[]): Record<string, ExistingFileState> {
    const config = getConfig({
      downloadDir,
      databasePath: path.join(tempRoot, 'blackbox.db'),
      fileTreePath: path.join(tempRoot, 'file_tree.json'),
      logLevel: 'error',
    });
    const database = new DownloadDatabase(config.databasePath);
    try {
      const downloader = new FileDownloader(config, [], database, loadFileTree(config.fileTreePath));
      return downloader.inspectExisting(files);
    } finally {
      database.close();
    }
  }

  it('marks an existing file as saved, then as pending after manual deletion', () => {
    const savePath = path.join(tempRoot, 'Course A', 'Week 1');
    const file = discoveredFile(savePath, 'Lecture Notes.pdf');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, file.name), 'existing');

    expect(inspect(tempRoot, [file])[file.url]).toEqual({ hierarchy: true, flat: false, size: undefined });

    fs.rmSync(path.join(savePath, file.name));

    expect(inspect(tempRoot, [file])[file.url]).toEqual({ hierarchy: false, flat: false, size: undefined });
  });

  it('does not use an old directory or cached history as the current directory state', () => {
    const oldDirectory = path.join(tempRoot, 'old-downloads');
    const currentDirectory = path.join(tempRoot, 'new-downloads');
    const oldFile = discoveredFile(path.join(oldDirectory, 'Course A'), 'Handout.pdf');
    const currentFile = discoveredFile(path.join(currentDirectory, 'Course A'), 'Handout.pdf');
    fs.mkdirSync(oldFile.savePath, { recursive: true });
    fs.writeFileSync(path.join(oldFile.savePath, oldFile.name), 'old');

    expect(inspect(currentDirectory, [currentFile])[currentFile.url].hierarchy).toBe(false);
    expect(inspect(currentDirectory, [oldFile])[oldFile.url].hierarchy).toBe(false);
  });

  it('recognizes the sanitized filename written by the downloader', () => {
    const savePath = path.join(tempRoot, 'Course A');
    const file = discoveredFile(savePath, 'Lecture: Notes?.pdf');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, 'Lecture -  Notes.pdf'), 'existing');

    expect(inspect(tempRoot, [file])[file.url].hierarchy).toBe(true);
  });

  it('tracks the folder-structure and flat layouts as separate states', () => {
    const courseRoot = path.join(tempRoot, 'Course A');
    const sectionPath = path.join(courseRoot, 'Week 1');
    fs.mkdirSync(sectionPath, { recursive: true });

    // Nested copy only: saved for the folder structure, still pending flat.
    const nestedOnly = discoveredFile(sectionPath, 'Nested.pdf');
    fs.writeFileSync(path.join(sectionPath, 'Nested.pdf'), 'nested');

    // Flat copy only: pending for the folder structure, saved flat.
    const flatOnly = discoveredFile(sectionPath, 'Flat.pdf');
    fs.writeFileSync(path.join(courseRoot, 'Flat.pdf'), 'flat');

    // Both copies: saved for either layout.
    const both = discoveredFile(sectionPath, 'Both.pdf');
    fs.writeFileSync(path.join(sectionPath, 'Both.pdf'), 'nested');
    fs.writeFileSync(path.join(courseRoot, 'Both.pdf'), 'flat');

    const state = inspect(tempRoot, [nestedOnly, flatOnly, both]);

    expect(state[nestedOnly.url]).toMatchObject({ hierarchy: true, flat: false });
    expect(state[flatOnly.url]).toMatchObject({ hierarchy: false, flat: true });
    expect(state[both.url]).toMatchObject({ hierarchy: true, flat: true });
  });

  it('clears directory contents but keeps the configured directory', () => {
    const nested = path.join(tempRoot, 'Course A', 'Week 1');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(nested, 'Lecture.pdf'), 'content');
    fs.writeFileSync(path.join(tempRoot, '.partial'), 'partial');

    expect(clearDownloadDirectory(tempRoot)).toBe(2);
    expect(fs.existsSync(tempRoot)).toBe(true);
    expect(fs.readdirSync(tempRoot)).toEqual([]);
  });

  it('refuses to clear a filesystem or home-directory root', () => {
    expect(() => clearDownloadDirectory(path.parse(tempRoot).root)).toThrow('Refusing to clear');
    expect(() => clearDownloadDirectory(os.homedir())).toThrow('Refusing to clear');
  });

  it('refuses home roots even when the casing differs (Windows-style paths)', () => {
    const home = os.homedir();
    // path.resolve does not normalize casing, so a differently-cased home
    // path must still be caught by the guard.
    const flipped = home
      .split(/[\\/]/)
      .map((segment, index) => (index === 0 || segment === '' ? segment : flipCase(segment)))
      .join(path.sep);
    if (flipCase(home) !== home) {
      expect(() => clearDownloadDirectory(flipped)).toThrow('Refusing to clear');
    }
    // An ancestor of home (e.g. C:\Users) must also be refused.
    const parent = path.dirname(home);
    if (parent !== path.parse(parent).root && parent !== home) {
      expect(() => clearDownloadDirectory(parent)).toThrow('Refusing to clear');
    }
  });
});

function flipCase(value: string): string {
  return value === value.toLowerCase() ? value.toUpperCase() : value.toLowerCase();
}

describe('download layout (folder structure vs flat)', () => {
  let tempRoot = '';

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-layout-'));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('keeps the discovered path for the hierarchy layout', () => {
    const savePath = path.join(tempRoot, 'Course A', 'Week 1', 'Slides');
    expect(resolveSavePathForLayout(tempRoot, savePath, 'hierarchy')).toBe(savePath);
    expect(resolveSavePathForLayout(tempRoot, savePath)).toBe(savePath);
  });

  it('collapses a flat path to the course folder', () => {
    const savePath = path.join(tempRoot, 'Course A', 'Week 1', 'Slides');
    expect(resolveSavePathForLayout(tempRoot, savePath, 'flat')).toBe(path.join(tempRoot, 'Course A'));
    expect(resolveSavePathForLayout(tempRoot, path.join(tempRoot, 'Course A'), 'flat')).toBe(
      path.join(tempRoot, 'Course A'),
    );
  });

  it('never moves a file that lives outside the download directory', () => {
    const outside = path.join(path.parse(tempRoot).root, 'elsewhere', 'Course A', 'Week 1');
    expect(resolveSavePathForLayout(tempRoot, outside, 'flat')).toBe(outside);
  });

  it('reports the course folder behind a save path', () => {
    const savePath = path.join(tempRoot, 'Course A', 'Week 1', 'Slides');
    expect(courseFolderForSavePath(tempRoot, savePath)).toBe(path.join(tempRoot, 'Course A'));
    const outside = path.join(path.parse(tempRoot).root, 'elsewhere', 'Course A');
    expect(courseFolderForSavePath(tempRoot, outside)).toBeNull();
  });

  it('lets a flat run and a hierarchy run share one course folder without collisions', () => {
    const courseRoot = path.join(tempRoot, 'Course A');
    const hierarchyPath = resolveSavePathForLayout(tempRoot, path.join(courseRoot, 'Week 1'), 'flat');
    const flatPath = resolveSavePathForLayout(tempRoot, path.join(courseRoot, 'Flat'), 'flat');
    expect(hierarchyPath).toBe(courseRoot);
    expect(flatPath).toBe(courseRoot);

    // Hierarchy run first, then a flat run of the same file name.
    fs.mkdirSync(path.join(courseRoot, 'Week 1'), { recursive: true });
    fs.writeFileSync(path.join(courseRoot, 'Week 1', 'Lecture.pdf'), 'nested');
    fs.mkdirSync(flatPath, { recursive: true });
    fs.writeFileSync(path.join(flatPath, 'Lecture.pdf'), 'flat');

    expect(fs.readFileSync(path.join(courseRoot, 'Week 1', 'Lecture.pdf'), 'utf8')).toBe('nested');
    expect(fs.readFileSync(path.join(courseRoot, 'Lecture.pdf'), 'utf8')).toBe('flat');
  });

  it('prunes only the empty folder shells and keeps every folder holding a file', () => {
    const courseRoot = path.join(tempRoot, 'Course A');
    fs.mkdirSync(path.join(courseRoot, 'Week 1', 'Slides'), { recursive: true });
    fs.mkdirSync(path.join(courseRoot, 'Week 2'), { recursive: true });
    fs.writeFileSync(path.join(courseRoot, 'Week 1', 'Slides', 'Lecture.pdf'), 'nested');
    fs.writeFileSync(path.join(courseRoot, 'flat.pdf'), 'flat');

    expect(pruneEmptyDirectories(courseRoot)).toBe(1);
    expect(fs.existsSync(path.join(courseRoot, 'Week 2'))).toBe(false);
    expect(fs.existsSync(path.join(courseRoot, 'Week 1', 'Slides', 'Lecture.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(courseRoot, 'flat.pdf'))).toBe(true);
    expect(fs.existsSync(courseRoot)).toBe(true);
  });

  it('qualifies a taken flat name with the section instead of dropping the file', () => {
    const courseRoot = path.join(tempRoot, 'Course A');
    fs.mkdirSync(courseRoot, { recursive: true });

    expect(preferredFlatFilename(courseRoot, 'Lecture.pdf', 'Week 1')).toBe('Lecture.pdf');

    fs.writeFileSync(path.join(courseRoot, 'Lecture.pdf'), 'week 1');
    expect(preferredFlatFilename(courseRoot, 'Lecture.pdf', 'Week 2')).toBe('Lecture (Week 2).pdf');
    // Stable across runs: a repeated flat run resolves to the same qualified
    // path, so the recorded URL matches and the file is skipped, not copied.
    expect(preferredFlatFilename(courseRoot, 'Lecture.pdf', 'Week 2')).toBe('Lecture (Week 2).pdf');
    // No section information: fall back to the plain name (uniquified later).
    expect(preferredFlatFilename(courseRoot, 'Lecture.pdf')).toBe('Lecture.pdf');
  });
});

describe('blocked course filtering', () => {
  it('removes blocked courses before applying the optional search filter', () => {
    const courses = [course('a', 'Algorithms'), course('b', 'Databases'), course('c', 'Algorithms Lab')];

    expect(filterCourses(courses, { excludeCourseIds: ['a', 'c'] })).toEqual([courses[1]]);
    expect(filterCourses(courses, { excludeCourseIds: ['a'], filterPattern: 'Algorithms' })).toEqual([courses[2]]);
  });

  it('keeps all courses when a malformed search pattern is supplied', () => {
    const courses = [course('a', 'Algorithms'), course('b', 'Databases')];

    expect(filterCourses(courses, { filterPattern: '[' })).toEqual(courses);
  });
});
