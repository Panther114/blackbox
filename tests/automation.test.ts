import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';import {
  automationSettingsPath,
  buildAutomationSessionConfig,
  clearAutomationDownloadDir,
  isValidGnumber,
  loadAutomationSettings,
  parseGnumbers,
  saveAutomationSettings,
  validateAutomationSettings,
} from '../src/automation/settings';
import { AutomationClaimLedger } from '../src/automation/claims';
import { AutomationRunLog } from '../src/automation/runLog';
import { automationFileExtension } from '../src/automation';
import { AutomationSettings } from '../src/automation/types';

function baseSettings(): AutomationSettings {
  return {
    gnumbers: ['G12345678'],
    downloadDir: 'D:/Blackbox-Automation',
    maxFileSizeBytes: 100 * 1024 * 1024,
    excludedExtensions: ['.mp3', '.mp4'],
  };
}

describe('automation g-numbers', () => {
  it('normalizes, dedupes and rejects malformed numbers', () => {
    const parsed = parseGnumbers('G12345678\ng12345678, 87654321\nnot-a-number\n  g_00998877  \n12');
    expect(parsed.valid).toEqual(['G12345678', 'G87654321', 'G00998877']);
    expect(parsed.invalid).toEqual(['not-a-number', '12']);
    expect(isValidGnumber('G12345678')).toBe(true);
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
      expect(saved.gnumbers).toEqual(['G12345678']);
      expect(fs.existsSync(automationSettingsPath())).toBe(true);

      const loaded = loadAutomationSettings();
      expect(loaded.gnumbers).toEqual(['G12345678']);
      expect(loaded.maxFileSizeBytes).toBe(100 * 1024 * 1024);
      expect(loaded.excludedExtensions).toEqual(['.mp3', '.mp4']);
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('automation session config isolation', () => {
  it('ignores normal-downloader environment values entirely', () => {
    const previous = { ...process.env };
    process.env.BB_USERNAME = 'normal-user';
    process.env.BB_PASSWORD = 'normal-pass';
    process.env.COURSE_FILTER = 'exclude-me';
    process.env.DOWNLOAD_DIR = 'D:/Normal-Downloads';
    process.env.DATABASE_PATH = 'D:/normal.db';
    process.env.FILE_TREE_PATH = 'D:/normal-tree.json';
    process.env.BROWSER_PROFILE_DIR = 'D:/normal-profile';
    process.env.LOG_FILE = 'D:/normal.log';
    try {
      const settings = baseSettings();
      const config = buildAutomationSessionConfig('G12345678', settings, 'D:/temp-profile');
      expect(config.username).toBe('G12345678');
      expect(config.password).toBe('G12345678');
      expect(config.courseFilter).toBeUndefined();
      expect(config.downloadDir).toBe(settings.downloadDir);
      expect(config.databasePath).toBe(path.join('D:/temp-profile', 'automation.db'));
      expect(config.fileTreePath).toBe(path.join('D:/temp-profile', 'file_tree.json'));
      expect(config.browserProfileDir).toBe('D:/temp-profile');
      expect(config.headless).toBe(true);
    } finally {
      process.env = previous;
    }
  });
});

describe('automation download directory wipe', () => {
  it('removes previous downloads and logs but keeps the directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-automation-wipe-'));
    fs.mkdirSync(path.join(dir, 'Course A', 'Section 1'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'Course A', 'Section 1', 'file.pdf'), 'x');
    fs.writeFileSync(path.join(dir, 'automation-runlog.json'), '{}');
    const result = clearAutomationDownloadDir(dir, 'D:/Somewhere-Else');
    expect(result.removed).toBe(2);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.readdirSync(dir)).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses dangerous targets', () => {
    expect(() => clearAutomationDownloadDir('', '')).toThrow();
    expect(() => clearAutomationDownloadDir(path.parse(os.homedir()).root, '')).toThrow();
    expect(() => clearAutomationDownloadDir(os.homedir(), '')).toThrow();
    expect(() => clearAutomationDownloadDir('D:/Normal-Downloads', 'd:/normal-downloads')).toThrow(/normal Blackbox download/);
  });
});

describe('automation claim ledger', () => {
  it('reserves once, confirms on success and releases on failure', () => {
    const ledger = new AutomationClaimLedger();
    expect(ledger.reserve('c1', 'G1')).toBe(true);
    expect(ledger.reserve('c1', 'G2')).toBe(false);
    expect(ledger.ownerOf('c1')).toBe('G1');
    expect(ledger.isConfirmed('c1')).toBe(false);

    ledger.confirm('c1');
    expect(ledger.isConfirmed('c1')).toBe(true);
    expect(ledger.confirmedCount()).toBe(1);

    // A failed session releases its unconfirmed claims for others to retry.
    expect(ledger.reserve('c2', 'G2')).toBe(true);
    expect(ledger.releaseByOwner('G2')).toEqual(['c2']);
    expect(ledger.reserve('c2', 'G3')).toBe(true);
    // Confirmed claims are never released.
    expect(ledger.releaseByOwner('G1')).toEqual([]);
    expect(ledger.isConfirmed('c1')).toBe(true);
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

  it('marks in-flight sessions cancelled instead of failed on cancel', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-automation-cancel-'));
    const settings: AutomationSettings = {
      gnumbers: ['G11111111'],
      downloadDir: dir,
      maxFileSizeBytes: 1024,
      excludedExtensions: [],
    };
    const runLog = new AutomationRunLog(dir, settings, 1);
    runLog.update(state => {
      const entry = state.gnumbers.find(item => item.gnumber === 'G11111111');
      if (entry) entry.status = 'downloading';
    });
    await runLog.finish('Cancelled by user', true);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'automation-runlog.json'), 'utf8'));
    expect(state.gnumbers[0].status).toBe('cancelled');
    expect(state.error).toBe('Cancelled by user');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
