import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';import {
  automationSettingsPath,
  isValidGnumber,
  loadAutomationSettings,
  parseGnumbers,
  saveAutomationSettings,
  validateAutomationSettings,
} from '../src/automation/settings';
import { AutomationRunLog } from '../src/automation/runLog';
import { automationFileExtension } from '../src/automation';
import { AutomationSettings } from '../src/automation/types';

function baseSettings(): AutomationSettings {
  return {
    gnumbers: ['g12345678'],
    downloadDir: 'D:/Blackbox-Automation',
    maxFileSizeBytes: 100 * 1024 * 1024,
    excludedExtensions: ['.mp3', '.mp4'],
  };
}

describe('automation g-numbers', () => {
  it('normalizes, dedupes and rejects malformed numbers', () => {
    const parsed = parseGnumbers('G12345678\ng12345678, 87654321\nnot-a-number\n  g_00998877  \n12');
    expect(parsed.valid).toEqual(['g12345678', 'g87654321', 'g00998877']);
    expect(parsed.invalid).toEqual(['not-a-number', '12']);
    expect(isValidGnumber('g12345678')).toBe(true);
    expect(isValidGnumber('12345')).toBe(false);
  });
});

describe('automation settings', () => {
  it('rejects a directory equal to the normal download directory (case-insensitive)', () => {
    const result = validateAutomationSettings(baseSettings(), 'd:/blackbox-automation');
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/different from the normal download directory/);
  });

  it('accepts an independent directory', () => {
    expect(validateAutomationSettings(baseSettings(), 'C:/Users/someone/Downloads/Blackbox').ok).toBe(true);
  });

  it('rejects missing g-numbers and filesystem roots', () => {
    expect(validateAutomationSettings({ ...baseSettings(), gnumbers: [] }, '').ok).toBe(false);
    expect(validateAutomationSettings({ ...baseSettings(), downloadDir: path.parse(os.homedir()).root }, '').ok).toBe(false);
  });

  it('saves and reloads independently of the normal settings store', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-automation-home-'));
    const homedirSpy = jest.spyOn(os, 'homedir').mockReturnValue(tempHome);
    try {
      const saved = saveAutomationSettings(
        { ...baseSettings(), downloadDir: path.join(tempHome, 'auto-downloads') },
        path.join(tempHome, 'normal-downloads'),
      );
      expect(saved.gnumbers).toEqual(['g12345678']);
      expect(fs.existsSync(automationSettingsPath())).toBe(true);

      const loaded = loadAutomationSettings();
      expect(loaded.gnumbers).toEqual(['g12345678']);
      expect(loaded.maxFileSizeBytes).toBe(100 * 1024 * 1024);
      expect(loaded.excludedExtensions).toEqual(['.mp3', '.mp4']);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('automation file extension filter helper', () => {
  it('reads extensions from names and URLs without query strings', () => {
    expect(automationFileExtension('Week 1 slides.PDF')).toBe('.pdf');
    expect(automationFileExtension('https://bb.example.com/f/video.mp4?download=1')).toBe('.mp4');
    expect(automationFileExtension('no-extension')).toBe('');
  });
});

describe('automation run log', () => {
  it('writes json, xlsx and debug logs in real time and finalizes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-automation-runlog-'));
    const settings: AutomationSettings = {
      gnumbers: ['g11111111', 'g22222222'],
      downloadDir: dir,
      maxFileSizeBytes: 1024,
      excludedExtensions: ['.mp3'],
    };
    const runLog = new AutomationRunLog(dir, settings, 2);

    runLog.update(state => {
      const first = state.gnumbers.find(entry => entry.gnumber === 'g11111111');
      if (first) {
        first.status = 'downloading';
        first.courses = ['Math 101'];
        first.downloadedCourses = ['Math 101'];
        first.filesDownloaded = 3;
      }
      state.claimedCourses['c1'] = 'g11111111';
      state.failedLogins.push({ gnumber: 'g22222222', error: 'wrong password', at: new Date().toISOString() });
      const second = state.gnumbers.find(entry => entry.gnumber === 'g22222222');
      if (second) second.status = 'failed';
    });
    runLog.debugLog('info', 'course claimed', 'g11111111');

    const json = JSON.parse(fs.readFileSync(path.join(dir, 'automation-runlog.json'), 'utf8'));
    expect(json.gnumbers[0].filesDownloaded).toBe(3);
    expect(json.failedLogins).toHaveLength(1);
    expect(json.claimedCourses.c1).toBe('g11111111');

    const debug = JSON.parse(fs.readFileSync(path.join(dir, 'automation-debug.json'), 'utf8'));
    expect(debug.parallelSessions).toBe(2);
    expect(debug.timeline).toHaveLength(1);
    expect(debug.settings.gnumberCount).toBe(2);

    const paths = await runLog.finish();
    const state = JSON.parse(fs.readFileSync(paths.runlogJsonPath, 'utf8'));
    expect(state.running).toBe(false);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(paths.runlogXlsxPath);
    const failedSheet = workbook.getWorksheet('Failed logins');
    expect(failedSheet).toBeDefined();
    expect(failedSheet!.getRow(2).getCell(1).value).toBe('g22222222');
    const coursesSheet = workbook.getWorksheet('Courses');
    expect(coursesSheet!.rowCount).toBeGreaterThanOrEqual(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
