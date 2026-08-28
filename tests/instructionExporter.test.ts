import fs from 'fs';
import os from 'os';
import path from 'path';
import { contentHash, stableId } from '../src/agent/markdown';
import { instructionPath, writeManualInstructions } from '../src/instructions/exporter';

describe('manual course instruction export', () => {
  test('writes every selected course item as readable Markdown under its course', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-instructions-'));
    const course = { id: 'c1', name: 'Course One', url: 'https://example.test/course', path: 'course-one' };
    const first = {
      id: stableId('item', 'first'),
      kind: 'content' as const,
      courseId: course.id,
      courseName: course.name,
      sectionName: 'Course Materials',
      folderPath: ['Week One'],
      title: 'Read this first',
      instructionsMarkdown: 'Read the syllabus before class.',
      sourceUrl: 'https://example.test/item/first',
      attachmentIds: [],
      contentHash: contentHash('Read the syllabus before class.'),
    };
    const second = { ...first, id: stableId('item', 'second'), title: 'Assignment details', instructionsMarkdown: '' };
    const progress: Array<{ completed: number; total: number }> = [];

    const result = writeManualInstructions({
      outputDir: root,
      courses: [course],
      items: [first, second],
      onProgress: value => progress.push({ completed: value.completed, total: value.total }),
    });

    expect(result.written).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(progress.at(-1)).toEqual({ completed: 2, total: 2 });

    const firstPath = instructionPath(root, first, course.path);
    const secondPath = instructionPath(root, second, course.path);
    expect(firstPath).toContain(path.join('course-one', 'Instructions', 'Course Materials', 'Week One'));
    expect(fs.readFileSync(firstPath, 'utf8')).toContain('Read the syllabus before class.');
    expect(fs.readFileSync(firstPath, 'utf8')).toContain('# Read this first');
    expect(fs.readFileSync(secondPath, 'utf8')).toContain('_No instructional text was found on this item._');
    expect(path.relative(root, firstPath).startsWith('..')).toBe(false);

    fs.rmSync(root, { force: true, recursive: true });
  });
});
