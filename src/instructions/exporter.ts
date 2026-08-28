import fs from 'fs';
import path from 'path';
import { ContentItem, Course, InstructionWriteProgress } from '../types';
import { sanitizeFilename } from '../utils/helpers';

export interface WriteManualInstructionsInput {
  outputDir: string;
  courses: Course[];
  items: ContentItem[];
  onProgress?: (progress: InstructionWriteProgress) => void;
}

export interface ManualInstructionExportResult {
  written: number;
  warnings: string[];
  paths: string[];
}

function instructionFilename(item: ContentItem): string {
  const title = sanitizeFilename(item.title || 'Course content').slice(0, 110).replace(/[. ]+$/, '');
  return `${title || 'Course content'}-${item.id}.md`;
}

function instructionPath(outputDir: string, item: ContentItem, coursePath = item.courseName): string {
  return path.join(
    path.resolve(outputDir),
    sanitizeFilename(coursePath),
    'Instructions',
    sanitizeFilename(item.sectionName || 'Course content'),
    ...item.folderPath.map(folder => sanitizeFilename(folder)),
    instructionFilename(item),
  );
}

function markdownFor(item: ContentItem): string {
  const frontmatter = [
    '---',
    `id: ${item.id}`,
    `kind: ${item.kind}`,
    `course: ${JSON.stringify(item.courseName)}`,
    `section: ${JSON.stringify(item.sectionName)}`,
    `source: ${item.sourceUrl}`,
    item.folderPath.length > 0 ? `folder_path: ${JSON.stringify(item.folderPath)}` : '',
    item.availableAt ? `available_at: ${item.availableAt}` : '',
    item.dueAt ? `due_at: ${item.dueAt}` : '',
    item.points ? `points: ${JSON.stringify(item.points)}` : '',
    `content_hash: ${item.contentHash}`,
    '---',
    '',
    `# ${item.title}`,
    '',
    item.instructionsMarkdown || '_No instructional text was found on this item._',
    '',
  ].filter(Boolean).join('\n');
  return frontmatter;
}

/**
 * Write the complete read-only content scan as course-scoped Markdown files.
 * The target path is deterministic, so rerunning a scan updates the same item
 * without removing unrelated files from the user's download directory.
 */
export function writeManualInstructions(input: WriteManualInstructionsInput): ManualInstructionExportResult {
  const warnings: string[] = [];
  const paths: string[] = [];
  let written = 0;

  input.onProgress?.({ completed: 0, total: input.items.length, currentTitle: '', });

  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index];
    const course = input.courses.find(candidate => candidate.id === item.courseId);
    const target = instructionPath(input.outputDir, item, course?.path || item.courseName);
    input.onProgress?.({
      completed: index,
      total: input.items.length,
      currentCourse: item.courseName,
      currentSection: item.sectionName,
      currentTitle: item.title,
    });

    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, markdownFor(item), 'utf8');
      written += 1;
      paths.push(target);
    } catch (error) {
      warnings.push(`Could not save instruction "${item.title}" in ${item.courseName}: ${error instanceof Error ? error.message : String(error)}`);
    }

    input.onProgress?.({
      completed: index + 1,
      total: input.items.length,
      currentCourse: item.courseName,
      currentSection: item.sectionName,
      currentTitle: item.title,
    });
  }

  if (input.items.length === 0) {
    input.onProgress?.({ completed: 0, total: 0, currentTitle: '' });
  }

  return { written, warnings, paths };
}

export { instructionPath };
