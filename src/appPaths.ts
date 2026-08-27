import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Centralises writable paths so packaged builds never depend on their install
 * directory. CLI callers may set BLACKBOX_APP_DATA_DIR for portable runs.
 * The former WHITEBOARD_APP_DATA_DIR override remains a compatibility alias
 * for existing portable installations.
 */
export interface AppPaths {
  root: string;
  configFile: string;
  credentialsFile: string;
  databaseFile: string;
  fileTreeFile: string;
  logsDir: string;
  logFile: string;
  browserDir: string;
  browserProfileDir: string;
  exportsDir: string;
}

/**
 * Returns the conventional per-user configuration directory for the current
 * platform. Electron supplies the authoritative userData path when the GUI
 * is running; this fallback keeps the CLI and TUI launchers portable too.
 */
export function getUserConfigRoot(): string {
  if (process.env.APPDATA) return path.resolve(process.env.APPDATA);
  if (process.env.XDG_CONFIG_HOME) return path.resolve(process.env.XDG_CONFIG_HOME);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return path.join(os.homedir(), '.config');
}

export function getAppDataRoot(): string {
  const portableOverride = process.env.BLACKBOX_APP_DATA_DIR || process.env.WHITEBOARD_APP_DATA_DIR;
  if (portableOverride) return path.resolve(portableOverride);
  if (process.versions.electron) {
    try {
      // Loaded lazily so the CLI remains portable without Electron.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const electron = require('electron') as { app?: { getPath(name: string): string } };
      if (electron.app?.getPath) return path.join(electron.app.getPath('userData'), 'data');
    } catch {
      // Fall through to OS defaults.
    }
  }
  return path.join(getUserConfigRoot(), 'blackbox');
}

export function getAppPaths(): AppPaths {
  const root = getAppDataRoot();
  return {
    root,
    configFile: path.join(root, 'settings.json'),
    credentialsFile: path.join(root, 'credentials.bin'),
    databaseFile: path.join(root, 'blackbox.db'),
    fileTreeFile: path.join(root, 'file_tree.json'),
    logsDir: path.join(root, 'logs'),
    logFile: path.join(root, 'logs', 'blackbox.log'),
    browserDir: path.join(root, 'browsers'),
    browserProfileDir: path.join(root, 'browser-profile'),
    exportsDir: path.join(root, 'agent-export'),
  };
}

export function ensureAppPaths(): AppPaths {
  const paths = getAppPaths();
  for (const dir of [paths.root, paths.logsDir, paths.browserDir, paths.browserProfileDir, paths.exportsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}
