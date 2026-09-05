import fs from 'fs';
import os from 'os';
import path from 'path';
import { contentHash, htmlToMarkdown, stableId } from '../src/agent/markdown';
import { writeAgentExport } from '../src/agent/exporter';

describe('agent content export', () => {
  test('preserves headings, links and code without unsafe markup', () => {
    const markdown = htmlToMarkdown('<h2>Task</h2><p>Read <a href="https://example.com/a">this</a>.</p><pre><code>const x = 1;</code></pre><script>alert(1)</script>');
    expect(markdown).toContain('## Task');
    expect(markdown).toContain('[this](https://example.com/a)');
    expect(markdown).toContain('```\nconst x = 1;\n```');
    expect(markdown).not.toContain('alert');
  });

  test('writes a versioned manifest and markdown item atomically', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-agent-'));
    const item = {
      id: stableId('item', 'one'), kind: 'assignment' as const, courseId: 'c1', courseName: 'Course One', sectionName: 'Assignments', folderPath: [], title: 'Build it', instructionsMarkdown: '```ts\nconsole.log(1)\n```', sourceUrl: 'https://example.com/item', attachmentIds: [], contentHash: contentHash('x'),
    };
    const written = writeAgentExport({ outputDir: root, baseUrl: 'https://example.com', courses: [{ id: 'c1', name: 'Course One', url: 'https://example.com/course', path: 'course-one' }], items: [item], attachments: [], warnings: [] });
    expect(fs.existsSync(written.manifestPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(written.manifestPath, 'utf8')).schemaVersion).toBe(1);
    expect(fs.readFileSync(path.join(root, 'agent-export', 'courses', 'Course One', 'Assignments', `${item.id}.md`), 'utf8')).toContain('console.log(1)');
    fs.rmSync(root, { force: true, recursive: true });
  });

  test('keeps HTML-escaped code inside fenced blocks and inequality prose', () => {
    const markdown = htmlToMarkdown(
      '<pre><code>&lt;div class="x"&gt;text&lt;/div&gt;</code></pre><p>a &lt; b and c &gt; d</p>',
    );
    expect(markdown).toContain('```');
    expect(markdown).toContain('<div class="x">text</div>');
    expect(markdown).toContain('a < b and c > d');
  });

  test('survives invalid numeric HTML entities', () => {
    const markdown = htmlToMarkdown('<p>bad &#55296; entity &#99999999; end</p>');
    expect(markdown).toContain('bad');
    expect(markdown).toContain('entity');
    expect(markdown).toContain('end');
  });

  test('quotes source URLs and keeps zero-point items in frontmatter', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-agent-'));
    const item = {
      id: stableId('item', 'two'), kind: 'content' as const, courseId: 'c1', courseName: 'Course One', sectionName: 'Notes', folderPath: [], title: 'Zero points', instructionsMarkdown: 'note', sourceUrl: 'https://example.com/a b#frag', points: '0', attachmentIds: [], contentHash: contentHash('x'),
    };
    writeAgentExport({ outputDir: root, baseUrl: 'https://example.com', courses: [{ id: 'c1', name: 'Course One', url: 'https://example.com/course', path: 'course-one' }], items: [item], attachments: [], warnings: [] });
    const written = fs.readFileSync(
      path.join(root, 'agent-export', 'courses', 'Course One', 'Notes', `${item.id}.md`),
      'utf8',
    );
    expect(written).toContain('source: "https://example.com/a b#frag"');
    expect(written).toContain('points: "0"');
    fs.rmSync(root, { force: true, recursive: true });
  });
});
