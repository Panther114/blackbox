import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  getCodexSkillPath,
  getCodexSkillStatus,
  installCodexSkill,
  removeCodexSkill,
} from '../src/agent/codexSkill';

describe('Codex skill integration', () => {
  let tempHome = '';

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blackboard-codex-skill-'));
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('installs and removes only its managed skill', () => {
    const downloadDir = path.join(tempHome, 'Downloads');
    const installed = installCodexSkill(downloadDir, tempHome);
    const skillPath = getCodexSkillPath(tempHome);

    expect(installed).toEqual({ installed: true, path: skillPath, managed: true });
    expect(fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8')).toContain('Blackbox course export');
    expect(fs.readFileSync(path.join(skillPath, 'agents', 'openai.yaml'), 'utf8')).toContain('allow_implicit_invocation: true');
    expect(getCodexSkillStatus(tempHome).installed).toBe(true);

    const removed = removeCodexSkill(tempHome);
    expect(removed).toEqual({ installed: false, path: skillPath, managed: false });
    expect(fs.existsSync(skillPath)).toBe(false);
  });

  it('does not overwrite an unrelated skill directory', () => {
    const skillPath = getCodexSkillPath(tempHome);
    fs.mkdirSync(skillPath, { recursive: true });
    fs.writeFileSync(path.join(skillPath, 'SKILL.md'), '# Existing skill\n', 'utf8');

    expect(() => installCodexSkill(path.join(tempHome, 'Downloads'), tempHome)).toThrow('already exists and is not managed');
    expect(fs.readFileSync(path.join(skillPath, 'SKILL.md'), 'utf8')).toBe('# Existing skill\n');
  });
});
