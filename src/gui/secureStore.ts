import fs from 'fs';
import os from 'os';
import path from 'path';
import { safeStorage } from 'electron';
import { AppPaths, getUserConfigRoot } from '../appPaths';
import { BlockedCourse } from '../types';
import { readEnvFile } from '../utils/envFile';

export interface DesktopSettings {
  username: string;
  downloadDir: string;
  headless: boolean;
  courseFilter: string;
  autoCheckUpdates: boolean;
  blockedCourses: BlockedCourse[];
}

const defaults: DesktopSettings = {
  username: '',
  downloadDir: path.join(os.homedir(), 'Downloads', 'Blackbox'),
  headless: true,
  courseFilter: '',
  autoCheckUpdates: true,
  blockedCourses: [],
};

export function normalizeBlockedCourses(value: unknown): BlockedCourse[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized: BlockedCourse[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    normalized.push({ id, name });
  }
  return normalized;
}

function legacyRoots(): string[] {
  const legacyBase = path.join(getUserConfigRoot(), 'whiteboard-downloader');
  return [path.join(legacyBase, 'data'), legacyBase];
}

function firstExistingFile(roots: string[], filename: string): string | null {
  const root = roots.find(candidate => fs.existsSync(path.join(candidate, filename)));
  return root ? path.join(root, filename) : null;
}

function copyIfMissing(source: string | null, target: string): void {
  if (!source || !fs.existsSync(source) || fs.existsSync(target)) return;
  try {
    fs.copyFileSync(source, target);
  } catch {
    // Legacy data is optional. Keep the source in place and let the UI offer
    // a repair path instead of preventing the desktop window from opening.
  }
}

function copyDirectoryIfMissing(source: string | null, target: string): void {
  if (!source || !fs.existsSync(source)) return;
  if (fs.existsSync(target)) {
    try {
      if (fs.readdirSync(target).length > 0) return;
    } catch {
      return;
    }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, {
      recursive: true,
      force: false,
      errorOnExist: false,
      filter: candidate => {
        const name = path.basename(candidate);
        return name !== 'LOCK' && !name.startsWith('Singleton');
      },
    });
  } catch {
    // Chromium profile files can be locked by the previous app instance.
    // Failing to copy an optional cache must never block Blackbox startup.
  }
}

export interface PasswordStatus {
  stored: boolean;
  readable: boolean;
  error?: string;
}

export interface LegacyMigrationResult {
  migrated: boolean;
  browserProfileSource?: string;
}

export class SecureDesktopStore {
  private passwordReadable = false;
  private passwordReadError = '';

  constructor(private readonly paths: AppPaths) {}

  loadSettings(): DesktopSettings {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.paths.configFile, 'utf8')) as Partial<DesktopSettings>;
      return { ...defaults, ...parsed, blockedCourses: normalizeBlockedCourses(parsed.blockedCourses) };
    } catch {
      return { ...defaults };
    }
  }

  saveSettings(settings: Partial<DesktopSettings>): DesktopSettings {
    const current = this.loadSettings();
    const next = {
      ...current,
      ...settings,
      blockedCourses:
        settings.blockedCourses === undefined
          ? current.blockedCourses
          : normalizeBlockedCourses(settings.blockedCourses),
    };
    fs.mkdirSync(path.dirname(this.paths.configFile), { recursive: true });
    fs.writeFileSync(this.paths.configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  async getPassword(): Promise<string> {
    this.passwordReadable = false;
    this.passwordReadError = '';
    if (!fs.existsSync(this.paths.credentialsFile)) return '';

    try {
      if (!safeStorage.isEncryptionAvailable()) {
        this.passwordReadError = this.secureStorageUnavailableMessage();
        return '';
      }

      const encrypted = fs.readFileSync(this.paths.credentialsFile);
      const storage = safeStorage as typeof safeStorage & {
        decryptStringAsync?: (input: Buffer) => Promise<{ result: string; shouldReEncrypt?: boolean }>;
      };
      if (storage.decryptStringAsync) {
        const decrypted = await storage.decryptStringAsync(encrypted);
        this.passwordReadable = true;
        if (decrypted.shouldReEncrypt) {
          void this.setPassword(decrypted.result).catch(() => undefined);
        }
        return decrypted.result;
      }

      const password = safeStorage.decryptString(encrypted);
      this.passwordReadable = true;
      return password;
    } catch (error) {
      this.passwordReadError = `The saved password could not be unlocked. Re-enter it in Settings to repair secure storage (${error instanceof Error ? error.message : String(error)}).`;
      return '';
    }
  }

  async setPassword(password: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error(this.secureStorageUnavailableMessage());
    const storage = safeStorage as typeof safeStorage & { encryptStringAsync?: (value: string) => Promise<Buffer> };
    const encrypted = storage.encryptStringAsync ? await storage.encryptStringAsync(password) : safeStorage.encryptString(password);
    fs.writeFileSync(this.paths.credentialsFile, encrypted);
    this.passwordReadable = true;
    this.passwordReadError = '';
  }

  clearPassword(): void {
    if (fs.existsSync(this.paths.credentialsFile)) fs.rmSync(this.paths.credentialsFile, { force: true });
    this.passwordReadable = false;
    this.passwordReadError = '';
  }

  getPasswordStatus(): PasswordStatus {
    const stored = fs.existsSync(this.paths.credentialsFile);
    return {
      stored,
      readable: stored && this.passwordReadable,
      ...(this.passwordReadError ? { error: this.passwordReadError } : {}),
    };
  }

  private secureStorageUnavailableMessage(): string {
    if (process.platform === 'linux') {
      return 'Linux secure credential storage is unavailable. Start GNOME Keyring, KWallet, or another Secret Service provider, then retry.';
    }
    if (process.platform === 'darwin') {
      return 'macOS Keychain is unavailable. Unlock Keychain Access, then retry.';
    }
    return 'The operating system secure credential store is unavailable. Repair the installation or re-enter the password after it becomes available.';
  }

  async migrateLegacySettings(): Promise<LegacyMigrationResult> {
    if (fs.existsSync(this.paths.configFile)) return { migrated: false };
    const roots = legacyRoots();
    const legacySettings = firstExistingFile(roots, 'settings.json');
    const legacyEnv = firstExistingFile(roots, '.env');
    const legacyCredentials = firstExistingFile(roots, 'credentials.bin');
    const legacyDatabase = firstExistingFile(roots, 'whiteboard.db');
    const legacyFileTree = firstExistingFile(roots, 'file_tree.json');
    const legacyExport = roots.map(root => path.join(root, 'agent-export')).find(candidate => fs.existsSync(candidate)) || null;
    const legacyBrowserProfile = roots.map(root => path.join(root, 'browser-profile')).find(candidate => fs.existsSync(candidate)) || null;

    if (!legacySettings && !legacyEnv && !legacyCredentials && !legacyDatabase && !legacyFileTree && !legacyExport && !legacyBrowserProfile) {
      return { migrated: false };
    }

    if (legacySettings) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacySettings, 'utf8')) as Partial<DesktopSettings>;
        this.saveSettings({
          username: typeof parsed.username === 'string' ? parsed.username : '',
          downloadDir: typeof parsed.downloadDir === 'string' ? parsed.downloadDir : defaults.downloadDir,
          headless: parsed.headless !== false,
          courseFilter: typeof parsed.courseFilter === 'string' ? parsed.courseFilter : '',
          autoCheckUpdates: parsed.autoCheckUpdates !== false,
          blockedCourses: normalizeBlockedCourses(parsed.blockedCourses),
        });
      } catch {
        // Fall back to the legacy .env file below when settings.json is invalid.
      }
    }

    if (!fs.existsSync(this.paths.configFile) && legacyEnv) {
      const env = readEnvFile(legacyEnv);
      this.saveSettings({
        username: env.BB_USERNAME || '',
        downloadDir: env.DOWNLOAD_DIR || defaults.downloadDir,
        headless: env.HEADLESS !== 'false',
        courseFilter: env.COURSE_FILTER || '',
        blockedCourses: [],
      });
      if (env.BB_PASSWORD && !legacyCredentials) await this.setPassword(env.BB_PASSWORD);
    }

    copyIfMissing(legacyCredentials, this.paths.credentialsFile);
    copyIfMissing(legacyDatabase, this.paths.databaseFile);
    copyIfMissing(legacyFileTree, this.paths.fileTreeFile);
    copyDirectoryIfMissing(legacyExport, this.paths.exportsDir);
    if (legacyEnv && !fs.existsSync(this.paths.credentialsFile)) {
      const env = readEnvFile(legacyEnv);
      if (env.BB_PASSWORD) await this.setPassword(env.BB_PASSWORD);
    }
    // Preserve a non-secret migration marker; legacy data is never deleted.
    fs.writeFileSync(path.join(this.paths.root, 'migration-v1.json'), JSON.stringify({ migratedAt: new Date().toISOString(), source: legacySettings || legacyEnv || legacyCredentials }) + '\n');
    return { migrated: true, browserProfileSource: legacyBrowserProfile || undefined };
  }

  async migrateLegacyBrowserProfile(source?: string): Promise<void> {
    if (!source || !fs.existsSync(source) || fs.existsSync(path.join(this.paths.browserProfileDir, 'Preferences'))) return;
    try {
      await fs.promises.cp(source, this.paths.browserProfileDir, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: candidate => {
          const name = path.basename(candidate);
          return name !== 'LOCK' && !name.startsWith('Singleton');
        },
      });
    } catch {
      // Browser profile state is optional and may contain files locked by the
      // previous app instance. Credentials and settings already migrated.
    }
  }

  async applyToEnvironment(): Promise<DesktopSettings> {
    const settings = this.loadSettings();
    const password = await this.getPassword();
    Object.assign(process.env, {
      BB_USERNAME: settings.username,
      BB_PASSWORD: password,
      DOWNLOAD_DIR: settings.downloadDir,
      HEADLESS: String(settings.headless),
      COURSE_FILTER: settings.courseFilter,
      DATABASE_PATH: this.paths.databaseFile,
      FILE_TREE_PATH: this.paths.fileTreeFile,
      LOG_FILE: this.paths.logFile,
      BROWSER_PROFILE_DIR: this.paths.browserProfileDir,
      USE_SYSTEM_EDGE: String(process.platform === 'win32'),
      BLACKBOX_APP_DATA_DIR: this.paths.root,
    });
    return settings;
  }
}
