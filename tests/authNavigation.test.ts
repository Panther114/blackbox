import {
  formatLoginNavigationError,
  isNavigationTimeoutError,
  isTransientNavigationError,
} from '../src/auth';
import {
  archiveCorruptCrashpad,
  archiveFailedBrowserProfile,
  isBrowserProfileInUse,
  isCorruptCrashpadStartupError,
  isPersistentContextStartupError,
} from '../src/auth/browserProfile';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('Blackboard login navigation errors', () => {
  const loginUrl = 'https://shs.blackboardchina.cn/webapps/login/';

  it('treats a goto timeout as recoverable and user-facing', () => {
    const error = new Error('page.goto: Timeout 30000ms exceeded. waiting until "commit"');

    expect(isNavigationTimeoutError(error)).toBe(true);
    expect(isTransientNavigationError(error)).toBe(true);
    expect(formatLoginNavigationError(error, loginUrl)).toContain('did not respond');
  });

  it('explains interrupted Blackboard redirects without exposing Playwright internals', () => {
    const error = new Error('net::ERR_ABORTED; maybe frame was detached');

    expect(isTransientNavigationError(error)).toBe(true);
    expect(formatLoginNavigationError(error, loginUrl)).toContain('changed before it finished loading');
  });

  it('recognizes the packaged Chromium persistent-profile startup failure', () => {
    expect(isPersistentContextStartupError(new Error(
      'browserType.launchPersistentContext: Target page, context or browser has been closed ... exitCode=21 ... crashpad Settings version is not 1',
    ))).toBe(true);
    expect(isPersistentContextStartupError(new Error('page.goto: Timeout 30000ms exceeded'))).toBe(false);
    expect(isPersistentContextStartupError(new Error("browserType.launchPersistentContext: Executable doesn't exist"))).toBe(false);
    expect(isCorruptCrashpadStartupError(new Error('crashpad Settings version is not 1'))).toBe(true);
  });

  it('archives only disposable Crashpad state before a full profile reset', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-crashpad-test-'));
    const profileDir = path.join(root, 'browser-profile');
    const crashpadDir = path.join(profileDir, 'Crashpad');
    fs.mkdirSync(crashpadDir, { recursive: true });
    fs.writeFileSync(path.join(crashpadDir, 'settings.dat'), 'invalid');
    fs.writeFileSync(path.join(profileDir, 'Cookies'), 'keep-session');

    try {
      const backupDir = await archiveCorruptCrashpad(profileDir, new Date('2026-08-28T12:19:23.000Z'));
      expect(backupDir).toBe(path.join(root, 'browser-profile-crashpad-recovery-20260828121923'));
      expect(fs.existsSync(path.join(backupDir || '', 'settings.dat'))).toBe(true);
      expect(fs.readFileSync(path.join(profileDir, 'Cookies'), 'utf8')).toBe('keep-session');
      expect(fs.existsSync(crashpadDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mark an unlocked profile as active', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-profile-lock-test-'));
    const profileDir = path.join(root, 'browser-profile');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'lockfile'), '');

    try {
      expect(await isBrowserProfileInUse(profileDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('archives a failed profile without deleting it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blackbox-profile-test-'));
    const profileDir = path.join(root, 'browser-profile');
    fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), '{}');

    try {
      const backupDir = await archiveFailedBrowserProfile(profileDir, new Date('2026-08-28T12:19:23.000Z'));
      expect(backupDir).toBe(path.join(root, 'browser-profile-recovery-20260828121923'));
      expect(fs.existsSync(path.join(backupDir || '', 'Default', 'Preferences'))).toBe(true);
      expect(fs.existsSync(profileDir)).toBe(true);
      expect(fs.readdirSync(profileDir)).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
