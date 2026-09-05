import fs from 'fs';
import os from 'os';
import path from 'path';
import { clearDownloadDirectory } from '../src/downloadDirectory';
import { Course, DiscoveredFile } from '../src/types';
import { filterAlreadyDownloaded, filterCourses } from '../src/workflow/downloadWorkflow';

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
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('skips an existing file, then makes it selectable after manual deletion', () => {
    const savePath = path.join(tempRoot, 'Course A', 'Week 1');
    const file = discoveredFile(savePath, 'Lecture Notes.pdf');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, file.name), 'existing');

    expect(filterAlreadyDownloaded([file], tempRoot)).toEqual({ files: [], skippedOnDisk: 1 });

    fs.rmSync(path.join(savePath, file.name));

    expect(filterAlreadyDownloaded([file], tempRoot)).toEqual({ files: [file], skippedOnDisk: 0 });
  });

  it('does not use an old directory or cached history as the current directory state', () => {
    const oldDirectory = path.join(tempRoot, 'old-downloads');
    const currentDirectory = path.join(tempRoot, 'new-downloads');
    const oldFile = discoveredFile(path.join(oldDirectory, 'Course A'), 'Handout.pdf');
    const currentFile = discoveredFile(path.join(currentDirectory, 'Course A'), 'Handout.pdf');
    fs.mkdirSync(oldFile.savePath, { recursive: true });
    fs.writeFileSync(path.join(oldFile.savePath, oldFile.name), 'old');

    expect(filterAlreadyDownloaded([currentFile], currentDirectory)).toEqual({
      files: [currentFile],
      skippedOnDisk: 0,
    });
    expect(filterAlreadyDownloaded([oldFile], currentDirectory)).toEqual({
      files: [oldFile],
      skippedOnDisk: 0,
    });
  });

  it('recognizes the sanitized filename written by the downloader', () => {
    const savePath = path.join(tempRoot, 'Course A');
    const file = discoveredFile(savePath, 'Lecture: Notes?.pdf');
    fs.mkdirSync(savePath, { recursive: true });
    fs.writeFileSync(path.join(savePath, 'Lecture -  Notes.pdf'), 'existing');

    expect(filterAlreadyDownloaded([file], tempRoot)).toEqual({ files: [], skippedOnDisk: 1 });
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
