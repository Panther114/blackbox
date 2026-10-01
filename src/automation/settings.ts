import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AUTOMATION_DEFAULT_EXCLUDED_EXTENSIONS,
  AUTOMATION_DEFAULT_MAX_FILE_SIZE_BYTES,
  AutomationSettings,
  DEFAULT_AUTOMATION_SETTINGS,
} from './types';
import { Config } from '../types';

/**
 * Automation settings are deliberately stored in their own directory with
 * their own file so they can never collide with, leak into, or be overwritten
 * by the normal Blackbox settings (which live in the main app-data root).
 */
export function automationRoot(): string {
  return path.join(os.homedir(), '.blackbox', 'automation');
}

export function automationSettingsPath(): string {
  return path.join(automationRoot(), 'settings.json');
}

export function automationTempRoot(): string {
  return path.join(os.tmpdir(), 'blackbox-automation');
}

function normalizeGnumber(value: string): string | null {
  // Accept G12345678, g12345678, 12345678 — always stored with a leading
  // uppercase G. Blackboard China usernames AND passwords are case-sensitive:
  // the account is 'G' plus digits and the lowercase form is rejected as
  // "incorrect username or password" (observed on shs.blackboardchina.cn).
  const trimmed = value.trim().replace(/^G/i, '').replace(/[^\d]/g, '');
  if (!/^\d{6,10}$/.test(trimmed)) return null;
  return `G${trimmed}`;
}

/**
 * Parse a pasted G-number list. Accepts newlines, commas, semicolons,
 * whitespace and mixed casing. Invalid entries are returned separately so the
 * UI can tell the user exactly which lines were rejected instead of silently
 * dropping numbers.
 */
export function parseGnumbers(input: string): { valid: string[]; invalid: string[] } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(/[\r\n,;]+/)) {
    const token = raw.trim();
    if (!token) continue;
    const normalized = normalizeGnumber(token);
    if (!normalized) {
      invalid.push(token);
      continue;
    }
    if (seen.has(normalized)) continue; // dedupe silently
    seen.add(normalized);
    valid.push(normalized);
  }
  return { valid, invalid };
}

export function isValidGnumber(value: string): boolean {
  return normalizeGnumber(value) !== null;
}

function normalizeExcludedExtensions(value: unknown): string[] {
  if (!Array.isArray(value)) return [...AUTOMATION_DEFAULT_EXCLUDED_EXTENSIONS];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim().toLowerCase();
    if (!trimmed) continue;
    seen.add(trimmed.startsWith('.') ? trimmed : `.${trimmed}`);
  }
  return [...seen].sort();
}

export interface AutomationSettingsValidationResult {
  ok: boolean;
  error?: string;
}

/**
 * Validate automation settings. The download directory must differ from the
 * normal Blackbox download directory (case-insensitive, both directions), and
 * must be a real writable-looking path.
 */
export function validateAutomationSettings(
  settings: AutomationSettings,
  normalDownloadDir: string,
): AutomationSettingsValidationResult {
  if (!Array.isArray(settings.gnumbers)) return { ok: false, error: 'The G-number list is malformed.' };
  if (settings.gnumbers.length === 0) return { ok: false, error: 'Add at least one G-number before running.' };
  for (const gnumber of settings.gnumbers) {
    if (!isValidGnumber(gnumber)) return { ok: false, error: `Invalid G-number: ${gnumber}` };
  }

  const dir = String(settings.downloadDir || '').trim();
  if (!dir) return { ok: false, error: 'Choose an automation download directory first.' };

  const automationDir = path.resolve(dir);
  const root = path.parse(automationDir).root;
  const home = path.resolve(os.homedir());
  if (automationDir === root || automationDir === home) {
    return { ok: false, error: 'Refusing to use a filesystem or home-directory root as the automation download directory.' };
  }

  const key = (p: string): string => path.resolve(p).toLowerCase();
  const normalDir = String(normalDownloadDir || '').trim();
  if (normalDir && key(automationDir) === key(normalDir)) {
    return { ok: false, error: 'The automation download directory must be different from the normal download directory.' };
  }

  if (!(settings.maxFileSizeBytes > 0) || !Number.isFinite(settings.maxFileSizeBytes)) {
    return { ok: false, error: 'The maximum file size must be a positive number.' };
  }

  return { ok: true };
}

export function loadAutomationSettings(): AutomationSettings {
  try {
    const file = automationSettingsPath();
    if (!fs.existsSync(file)) return { ...DEFAULT_AUTOMATION_SETTINGS, downloadDir: path.join(os.homedir(), 'Downloads', 'Blackbox-Automation') };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AutomationSettings>;
    const fallbackDownloadDir = path.join(os.homedir(), 'Downloads', 'Blackbox-Automation');
    return {
      gnumbers: Array.isArray(parsed.gnumbers)
        ? [
            ...new Set(
              parsed.gnumbers
                .filter((value): value is string => typeof value === 'string')
                .map(value => normalizeGnumber(value))
                .filter((value): value is string => value !== null),
            ),
          ]
        : [],
      downloadDir: typeof parsed.downloadDir === 'string' && parsed.downloadDir.trim() !== ''
        ? parsed.downloadDir
        : fallbackDownloadDir,
      maxFileSizeBytes: Number.isFinite(parsed.maxFileSizeBytes) && Number(parsed.maxFileSizeBytes) > 0
        ? Number(parsed.maxFileSizeBytes)
        : AUTOMATION_DEFAULT_MAX_FILE_SIZE_BYTES,
      excludedExtensions: normalizeExcludedExtensions(parsed.excludedExtensions),
    };
  } catch {
    return { ...DEFAULT_AUTOMATION_SETTINGS, downloadDir: path.join(os.homedir(), 'Downloads', 'Blackbox-Automation') };
  }
}

export function saveAutomationSettings(settings: AutomationSettings, normalDownloadDir: string): AutomationSettings {
  const validation = validateAutomationSettings(settings, normalDownloadDir);
  if (!validation.ok) throw new Error(validation.error);

  fs.mkdirSync(automationRoot(), { recursive: true });
  const normalized: AutomationSettings = {
    gnumbers: [...new Set(settings.gnumbers.map(g => normalizeGnumber(g)).filter((g): g is string => g !== null))],
    downloadDir: path.resolve(settings.downloadDir),
    maxFileSizeBytes: settings.maxFileSizeBytes,
    excludedExtensions: normalizeExcludedExtensions(settings.excludedExtensions),
  };
  const temp = `${automationSettingsPath()}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, automationSettingsPath());
  return normalized;
}

/**
 * Build one automation session's downloader config WITHOUT inheriting
 * anything from the process environment or the normal Blackbox settings.
 *
 * Background: the desktop app exports the main settings into the worker
 * process environment (COURSE_FILTER, DATABASE_PATH, FILE_TREE_PATH, ...).
 * Using getConfig() here would silently adopt those values, so e.g. a course
 * filter or download history from the normal downloader would leak into
 * automation. Every field below is set explicitly so automation course
 * selection, skip decisions and storage are fully independent:
 * - no course filter, no blocked-course list (both live outside core config
 *   and are never consulted here);
 * - a fresh per-session database + file-tree cache under the session profile
 *   dir (removed when the session ends);
 * - the shared automation download directory, which is wiped at the start of
 *   every run, so "already downloaded" can only ever refer to the current run.
 */
export function buildAutomationSessionConfig(
  gnumber: string,
  settings: AutomationSettings,
  profileDir: string,
): Config {
  return {
    username: gnumber,
    password: gnumber,
    baseUrl: 'https://shs.blackboardchina.cn',
    loginUrl: 'https://shs.blackboardchina.cn/webapps/login/',
    downloadDir: settings.downloadDir,
    maxConcurrentDownloads: 6,
    downloadTimeout: 60000,
    browserType: 'chromium',
    headless: true,
    browserTimeout: 30000,
    databasePath: path.join(profileDir, 'automation.db'),
    logLevel: 'info',
    logFile: path.join(settings.downloadDir, 'automation-app.log'),
    // Deliberately no courseFilter: automation downloads every visible course.
    maxRetries: 3,
    retryDelay: 2000,
    fileTreePath: path.join(profileDir, 'file_tree.json'),
    browserProfileDir: profileDir,
    useSystemEdge: process.platform === 'win32',
    browserBackend: 'chromium',
  };
}

/**
 * Wipe an automation download directory completely (downloads + previous run
 * logs) so every run starts from a fresh state. The directory itself is kept.
 *
 * Safety: refuses empty paths, filesystem roots, the home directory and —
 * most importantly — the normal Blackbox download directory, so a
 * misconfigured automation directory can never delete the user's main
 * downloads.
 */
export function clearAutomationDownloadDir(
  downloadDir: string,
  normalDownloadDir: string,
): { removed: number; directory: string } {
  const dir = String(downloadDir || '').trim();
  if (!dir) throw new Error('No automation download directory configured.');
  const resolved = path.resolve(dir);
  const root = path.parse(resolved).root;
  const home = path.resolve(os.homedir());
  if (resolved === root || resolved === home) {
    throw new Error('Refusing to wipe a filesystem or home-directory root.');
  }
  const key = (p: string): string => path.resolve(p).toLowerCase();
  const normal = String(normalDownloadDir || '').trim();
  if (normal && key(resolved) === key(normal)) {
    throw new Error('Refusing to wipe the normal Blackbox download directory.');
  }

  fs.mkdirSync(resolved, { recursive: true });
  let removed = 0;
  for (const entry of fs.readdirSync(resolved)) {
    fs.rmSync(path.join(resolved, entry), { recursive: true, force: true });
    removed += 1;
  }
  return { removed, directory: resolved };
}
