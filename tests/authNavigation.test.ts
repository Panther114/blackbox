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
import { BlackboardAuth } from '../src/auth';
import { Config } from '../src/types';
import { BrowserContext, Page } from 'playwright-core';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('Blackboard login navigation errors', () => {
  const loginUrl = 'https://shs.blackboardchina.cn/webapps/login/';

  function testConfig(): Config {
    return {
      username: 'test-user',
      password: 'test-password',
      baseUrl: 'https://shs.blackboardchina.cn',
      loginUrl,
      downloadDir: './downloads',
      maxConcurrentDownloads: 1,
      downloadTimeout: 1000,
      browserType: 'chromium',
      headless: false,
      browserTimeout: 1000,
      databasePath: './blackbox.db',
      logLevel: 'error',
      logFile: './blackbox.log',
      maxRetries: 1,
      retryDelay: 0,
      fileTreePath: './file_tree.json',
      browserProfileDir: './browser-profile',
      useSystemEdge: false,
    };
  }

  function attachFakeBrowser(
    auth: BlackboardAuth,
    page: Record<string, jest.Mock>,
    context: Record<string, jest.Mock | (() => Page[])>,
  ): void {
    const authState = auth as unknown as { page: Page | null; context: BrowserContext | null };
    authState.page = page as unknown as Page;
    authState.context = context as unknown as BrowserContext;
  }

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

  it('clears a saved session before filling credentials in visible mode', async () => {
    const config = testConfig();
    const page = {
      url: jest.fn().mockReturnValue('https://shs.blackboardchina.cn/webapps/portal/'),
      evaluate: jest.fn().mockResolvedValue(undefined),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn().mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
      fill: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
    };
    const context = {
      clearCookies: jest.fn().mockResolvedValue(undefined),
      pages: jest.fn().mockReturnValue([page]),
    };
    const auth = new BlackboardAuth(config);
    attachFakeBrowser(auth, page, context);

    await auth.login();

    expect(context.clearCookies).toHaveBeenCalledTimes(1);
    expect(page.evaluate).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(loginUrl, expect.objectContaining({ waitUntil: 'commit' }));
    expect(page.fill).toHaveBeenNthCalledWith(1, '#user_id', config.username);
    expect(page.fill).toHaveBeenNthCalledWith(2, '#password', config.password);
  });

  it('retries the login URL if a saved session redirects to the portal', async () => {
    const config = testConfig();
    const page = {
      url: jest.fn().mockReturnValue('https://shs.blackboardchina.cn/webapps/portal/'),
      evaluate: jest.fn().mockResolvedValue(undefined),
      goto: jest.fn().mockResolvedValue(undefined),
      waitForSelector: jest.fn()
        .mockRejectedValueOnce(new Error('Timed out waiting for #user_id'))
        .mockResolvedValue(undefined),
      locator: jest.fn().mockReturnValue({ first: () => ({ isVisible: jest.fn().mockResolvedValue(false) }) }),
      fill: jest.fn().mockResolvedValue(undefined),
      click: jest.fn().mockResolvedValue(undefined),
      waitForLoadState: jest.fn().mockResolvedValue(undefined),
    };
    const context = {
      clearCookies: jest.fn().mockResolvedValue(undefined),
      pages: jest.fn().mockReturnValue([page]),
    };
    const auth = new BlackboardAuth(config);
    attachFakeBrowser(auth, page, context);

    await auth.login();

    expect(context.clearCookies).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenCalledTimes(2);
    expect(page.goto).toHaveBeenNthCalledWith(2, loginUrl, expect.objectContaining({ waitUntil: 'commit' }));
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
