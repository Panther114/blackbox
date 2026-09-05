import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  AUTOMATION_DEFAULT_EXCLUDED_EXTENSIONS,
  AUTOMATION_DEFAULT_MAX_FILE_SIZE_BYTES,
  AutomationSettings,
  DEFAULT_AUTOMATION_SETTINGS,
} from './types';

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
  // Accept G12345678, g12345678, 12345678 — always stored lowercase with a
  // leading g. Blackboard China G-numbers are 'g' plus 6-10 digits.
  const trimmed = value.trim().replace(/^G/i, '').replace(/[^\d]/g, '');
  if (!/^\d{6,10}$/.test(trimmed)) return null;
  return `g${trimmed}`;
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
        ? parsed.gnumbers.filter((value): value is string => typeof value === 'string' && isValidGnumber(value))
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
    gnumbers: [...new Set(settings.gnumbers.map(g => g.toLowerCase()))],
    downloadDir: path.resolve(settings.downloadDir),
    maxFileSizeBytes: settings.maxFileSizeBytes,
    excludedExtensions: normalizeExcludedExtensions(settings.excludedExtensions),
  };
  const temp = `${automationSettingsPath()}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, automationSettingsPath());
  return normalized;
}
