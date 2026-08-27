import fs from 'fs';
import path from 'path';
import { safeStorage } from 'electron';
import { AppPaths } from '../appPaths';
import { readEnvFile } from '../utils/envFile';

export interface DesktopSettings {
  username: string;
  downloadDir: string;
  headless: boolean;
  courseFilter: string;
  autoCheckUpdates: boolean;
}

const defaults: DesktopSettings = {
  username: '',
  downloadDir: path.join(process.env.USERPROFILE || '.', 'Downloads', 'Blackbox'),
  headless: true,
  courseFilter: '',
  autoCheckUpdates: true,
};

function legacyRoots(): string[] {
  const roaming = process.env.APPDATA || process.env.XDG_CONFIG_HOME || '.';
  const legacyBase = path.resolve(roaming, 'whiteboard-downloader');
  return [path.join(legacyBase, 'data'), legacyBase];
}

function firstExistingFile(roots: string[], filename: string): string | null {
  const root = roots.find(candidate => fs.existsSync(path.join(candidate, filename)));
  return root ? path.join(root, filename) : null;
}

function copyIfMissing(source: string | null, target: string): void {
  if (source && fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
}

function copyDirectoryIfMissing(source: string | null, target: string): void {
  if (!source || !fs.existsSync(source) || fs.existsSync(target)) return;
  fs.cpSync(source, target, { recursive: true, force: false, errorOnExist: false });
}

export class SecureDesktopStore {
  constructor(private readonly paths: AppPaths) {}

  loadSettings(): DesktopSettings {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.paths.configFile, 'utf8')) as Partial<DesktopSettings>;
      return { ...defaults, ...parsed };
    } catch {
      return { ...defaults };
    }
  }

  saveSettings(settings: Partial<DesktopSettings>): DesktopSettings {
    const next = { ...this.loadSettings(), ...settings };
    fs.mkdirSync(path.dirname(this.paths.configFile), { recursive: true });
    fs.writeFileSync(this.paths.configFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return next;
  }

  async getPassword(): Promise<string> {
    if (!fs.existsSync(this.paths.credentialsFile) || !safeStorage.isEncryptionAvailable()) return '';
    const encrypted = fs.readFileSync(this.paths.credentialsFile);
    const storage = safeStorage as typeof safeStorage & {
      decryptStringAsync?: (input: Buffer) => Promise<{ result: string }>;
    };
    if (storage.decryptStringAsync) return (await storage.decryptStringAsync(encrypted)).result;
    return safeStorage.decryptString(encrypted);
  }

  async setPassword(password: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Windows credential encryption is unavailable.');
    const storage = safeStorage as typeof safeStorage & { encryptStringAsync?: (value: string) => Promise<Buffer> };
    const encrypted = storage.encryptStringAsync ? await storage.encryptStringAsync(password) : safeStorage.encryptString(password);
    fs.writeFileSync(this.paths.credentialsFile, encrypted);
  }

  clearPassword(): void {
    if (fs.existsSync(this.paths.credentialsFile)) fs.rmSync(this.paths.credentialsFile, { force: true });
  }

  async migrateLegacySettings(): Promise<{ migrated: boolean }> {
    if (fs.existsSync(this.paths.configFile)) return { migrated: false };
    const roots = legacyRoots();
    const legacySettings = firstExistingFile(roots, 'settings.json');
    const legacyEnv = firstExistingFile(roots, '.env');
    const legacyCredentials = firstExistingFile(roots, 'credentials.bin');
    const legacyDatabase = firstExistingFile(roots, 'whiteboard.db');
    const legacyFileTree = firstExistingFile(roots, 'file_tree.json');
    const legacyExport = roots.map(root => path.join(root, 'agent-export')).find(candidate => fs.existsSync(candidate)) || null;
    const legacyBrowserProfile = roots.map(root => path.join(root, 'browser-profile')).find(candidate => fs.existsSync(candidate)) || null;

    if (!legacySettings && !legacyEnv && !legacyCredentials) return { migrated: false };

    if (legacySettings) {
      try {
        const parsed = JSON.parse(fs.readFileSync(legacySettings, 'utf8')) as Partial<DesktopSettings>;
        this.saveSettings({
          username: typeof parsed.username === 'string' ? parsed.username : '',
          downloadDir: typeof parsed.downloadDir === 'string' ? parsed.downloadDir : defaults.downloadDir,
          headless: parsed.headless !== false,
          courseFilter: typeof parsed.courseFilter === 'string' ? parsed.courseFilter : '',
          autoCheckUpdates: parsed.autoCheckUpdates !== false,
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
      });
      if (env.BB_PASSWORD && !legacyCredentials) await this.setPassword(env.BB_PASSWORD);
    }

    copyIfMissing(legacyCredentials, this.paths.credentialsFile);
    copyIfMissing(legacyDatabase, this.paths.databaseFile);
    copyIfMissing(legacyFileTree, this.paths.fileTreeFile);
    copyDirectoryIfMissing(legacyExport, this.paths.exportsDir);
    copyDirectoryIfMissing(legacyBrowserProfile, this.paths.browserProfileDir);
    if (legacyEnv && !fs.existsSync(this.paths.credentialsFile)) {
      const env = readEnvFile(legacyEnv);
      if (env.BB_PASSWORD) await this.setPassword(env.BB_PASSWORD);
    }
    // Preserve a non-secret migration marker; legacy data is never deleted.
    fs.writeFileSync(path.join(this.paths.root, 'migration-v1.json'), JSON.stringify({ migratedAt: new Date().toISOString(), source: legacySettings || legacyEnv || legacyCredentials }) + '\n');
    return { migrated: true };
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
      USE_SYSTEM_EDGE: 'true',
      BLACKBOX_APP_DATA_DIR: this.paths.root,
    });
    return settings;
  }
}
