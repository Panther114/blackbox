import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getHarnessSkillPath,
  getHarnessSkillStatus,
  installHarnessSkill,
  removeHarnessSkill,
} from '../src/agent/harnessSkill';

describe('Universal harness skill integration', () => {
  let tempHome = '';

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-harness-skill-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('installs and removes only its managed universal skill', () => {
    const downloadDir = path.join(tempHome, 'Downloads');
    const installed = installHarnessSkill(downloadDir, tempHome);
    const skillPath = getHarnessSkillPath(tempHome);
    const skillMarkdown = fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8');

    expect(installed).toEqual({ installed: true, path: skillPath, managed: true });
    expect(skillPath).toBe(path.join(tempHome, '.agents', 'skills', 'blackbox'));
    expect(skillMarkdown).toContain('name: blackbox');
    expect(skillMarkdown).toContain('BlackboardChina course-material downloader');
    expect(skillMarkdown).toContain('compatible coding harnesses');
    expect(skillMarkdown).not.toContain('.codex');
    expect(fs.existsSync(path.join(skillPath, 'agents'))).toBe(false);
    expect(getHarnessSkillStatus(tempHome).installed).toBe(true);

    const removed = removeHarnessSkill(tempHome);

    expect(removed).toEqual({ installed: false, path: skillPath, managed: false });
    expect(fs.existsSync(skillPath)).toBe(false);
  });

  it('does not overwrite an unrelated skill directory', () => {
    const skillPath = getHarnessSkillPath(tempHome);
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Existing skill\n', 'utf8');

    expect(() => installHarnessSkill(path.join(tempHome, 'Downloads'), tempHome)).toThrow(
      'already exists and is not managed',
    );
    expect(fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8')).toBe('# Existing skill\n');
  });
});
