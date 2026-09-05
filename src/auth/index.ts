import fs from 'fs';
import { chromium, firefox, webkit, Browser, BrowserContext, Page } from 'playwright-core';
import { Config } from '../types';
import { log } from '../utils/logger';
import { getBundledChromiumExecutable } from './browserPath';
import { launchObscuraSession, assertObscuraUsable, ObscuraSession } from './obscura';
import {
  archiveCorruptCrashpad,
  archiveFailedBrowserProfile,
  isCorruptCrashpadStartupError,
  isBrowserProfileInUse,
  isPersistentContextStartupError,
} from './browserProfile';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const AUTOMATION_BROWSER_MISSING_ERROR =
  'No automation browser is available. Install Microsoft Edge or Playwright Chromium, then retry.';

function managedChromiumExecutable(): string | undefined {
  const bundled = getBundledChromiumExecutable();
  if (bundled) return bundled;
  try {
    const executable = chromium.executablePath();
    return executable && fs.existsSync(executable) ? executable : undefined;
  } catch {
    return undefined;
  }
}

export { getBundledChromiumExecutable } from './browserPath';

export function isNavigationTimeoutError(error: unknown): boolean {
  return /page\.goto: Timeout \d+ms exceeded|navigation timeout/i.test(errorMessage(error));
}

export function isTransientNavigationError(error: unknown): boolean {
  const message = errorMessage(error);
  return /ERR_ABORTED|frame was detached|target page, context or browser has been closed|ERR_CONNECTION_(REFUSED|TIMED_OUT|RESET)|ERR_NAME_NOT_RESOLVED|ENETUNREACH|ECONNREFUSED|ETIMEDOUT/i.test(message) ||
    isNavigationTimeoutError(error);
}

export function formatLoginNavigationError(error: unknown, loginUrl: string): string {
  const message = errorMessage(error);
  if (isNavigationTimeoutError(error)) {
    return `Blackboard did not respond while opening the login page (${loginUrl}). The site may be unavailable or blocked by your network/VPN. Check your connection and retry.`;
  }
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ENETUNREACH|ECONNREFUSED|ETIMEDOUT/i.test(message)) {
    return `Blackboard could not be reached at ${loginUrl}. Check your connection and VPN, then retry.`;
  }
  if (/ERR_ABORTED|frame was detached|target page, context or browser has been closed/i.test(message)) {
    return `The Blackboard login page changed before it finished loading. Retry the download.`;
  }
  return `Could not open the Blackboard login page at ${loginUrl}. Check your connection and retry.`;
}

const LOGIN_NAVIGATION_TIMEOUT = 15000;
const LOGIN_FORM_TIMEOUT = 6000;
const LOGIN_CONSENT_WAIT_TIMEOUT = 2000;
const LOGIN_CLICK_TIMEOUT = 15000;
// Blackboard shows a cookie/privacy consent lightbox (div.lb-wrapper) that can
// appear before or after the login form renders and intercepts clicks on the
// login button. These selectors cover its accept button plus common cookie
// banner implementations.
const CONSENT_DIALOG_SELECTOR =
  '#agree_button, #onetrust-accept-btn-handler, .lb-wrapper[role="dialog"], .lb-wrapper';
const CONSENT_ACCEPT_SELECTORS = [
  '#agree_button',
  '#onetrust-accept-btn-handler',
  '.lb-wrapper button:has-text("我同意")',
  '.lb-wrapper button:has-text("I Agree")',
  '.lb-wrapper button:has-text("Agree")',
  '.lb-wrapper button:has-text("Accept")',
  '.lb-wrapper button:has-text("确定")',
  '.lb-wrapper button:has-text("OK")',
  '[role="dialog"] button:has-text("我同意")',
  '[role="dialog"] button:has-text("I Agree")',
  '[role="dialog"] button:has-text("Agree")',
  '[role="dialog"] button:has-text("Accept")',
];
const BROWSER_PROFILE_IN_USE_ERROR =
  'The Blackboard browser is already running. Finish or close the other Blackbox operation, then retry.';
const BROWSER_PROFILE_RECOVERY_ERROR =
  'The local browser could not start. Close other Blackbox or Chromium windows and retry. If the problem persists, run Diagnostics.';

function isHttpPage(page: Page): boolean {
  return /^https?:\/\//i.test(page.url());
}

function isAuthenticatedRedirect(currentUrl: string, loginUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const login = new URL(loginUrl);
    return current.origin === login.origin && current.pathname !== login.pathname;
  } catch {
    return false;
  }
}

export class BlackboardAuth {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private config: Config;
  private obscuraSession: ObscuraSession | null = null;

  constructor(config: Config) {
    this.config = config;
  }

  private async launchPersistentContext(
    profileDir: string,
    options: Parameters<typeof chromium.launchPersistentContext>[1],
  ): Promise<BrowserContext> {
    try {
      return await chromium.launchPersistentContext(profileDir, options);
    } catch (error) {
      if (!isPersistentContextStartupError(error)) throw error;
      if (await isBrowserProfileInUse(profileDir)) {
        throw new Error(BROWSER_PROFILE_IN_USE_ERROR);
      }

      if (isCorruptCrashpadStartupError(error)) {
        const crashpadBackupDir = await archiveCorruptCrashpad(profileDir);
        if (crashpadBackupDir) {
          log.warn(`Archived disposable Crashpad state at ${crashpadBackupDir}; retrying without changing the saved session.`);
          try {
            const context = await chromium.launchPersistentContext(profileDir, options);
            log.info('Browser profile recovered after Crashpad cleanup.');
            return context;
          } catch (retryError) {
            if (!isPersistentContextStartupError(retryError)) throw retryError;
            log.warn('Crashpad cleanup did not resolve the persistent browser startup failure; quarantining the full profile.');
          }
        }
      }

      log.warn('The persistent browser profile failed during startup; preserving it and retrying with a clean profile.');
      const backupDir = await archiveFailedBrowserProfile(profileDir);
      if (!backupDir) {
        throw new Error(BROWSER_PROFILE_RECOVERY_ERROR);
      }

      log.warn(`Archived the failed browser profile at ${backupDir}.`);
      try {
        const context = await chromium.launchPersistentContext(profileDir, options);
        log.info('Browser profile recovered successfully.');
        return context;
      } catch {
        throw new Error(BROWSER_PROFILE_RECOVERY_ERROR);
      }
    }
  }

  private async clearLaunchState(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      // The failed launch may already have closed its context.
    }
    try {
      await this.browser?.close();
    } catch {
      // The failed launch may already have closed its browser.
    }
    if (this.obscuraSession) {
      const session = this.obscuraSession;
      this.obscuraSession = null;
      try {
        if (session.serve.child && !session.serve.child.killed) session.serve.child.kill();
      } catch {
        // The serve process may already have exited.
      }
    }
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  /**
   * Blackbox owns its browser profile, but a previous run may have left an
   * authenticated Blackboard session in it. Clear that session before every
   * login so a visible run always presents the login form and credentials are
   * never reused accidentally.
   */
  private async clearPersistedSessionState(context: BrowserContext | null = this.context): Promise<void> {
    if (!context) return;

    try {
      await context.clearCookies();
    } catch (error) {
      log.debug(`Could not clear persisted browser cookies before login: ${errorMessage(error)}`);
    }

    for (const page of context.pages()) {
      if (!isHttpPage(page)) continue;
      try {
        await page.evaluate(async () => {
          const browserGlobal = globalThis as unknown as {
            localStorage?: { clear: () => void };
            sessionStorage?: { clear: () => void };
            indexedDB?: {
              databases?: () => Promise<Array<{ name?: string }>>;
              deleteDatabase: (name: string) => {
                onsuccess?: () => void;
                onerror?: () => void;
                onblocked?: () => void;
              };
            };
            caches?: {
              keys: () => Promise<string[]>;
              delete: (cacheName: string) => Promise<boolean>;
            };
            navigator?: {
              serviceWorker?: {
                getRegistrations: () => Promise<Array<{ unregister: () => Promise<boolean> }>>;
              };
            };
          };

          try {
            browserGlobal.localStorage?.clear();
            browserGlobal.sessionStorage?.clear();
          } catch {
            // Some pages expose storage through a restricted origin.
          }

          try {
            const indexedDb = browserGlobal.indexedDB;
            if (indexedDb?.databases) {
              const databases = await indexedDb.databases();
              await Promise.all(
                databases.map(database => {
                  if (!database.name) return Promise.resolve();
                  return new Promise<void>(resolve => {
                    const request = indexedDb.deleteDatabase(database.name as string);
                    request.onsuccess = resolve;
                    request.onerror = resolve;
                    request.onblocked = resolve;
                  });
                }),
              );
            }
          } catch {
            // IndexedDB is optional; cookie and Web Storage cleanup is enough
            // for the normal Blackboard authentication flow.
          }

          try {
            const cacheStorage = browserGlobal.caches;
            if (cacheStorage) {
              const cacheNames = await cacheStorage.keys();
              await Promise.all(cacheNames.map(cacheName => cacheStorage.delete(cacheName)));
            }
          } catch {
            // Cache Storage is optional and may be unavailable in old pages.
          }

          try {
            const registrations = await browserGlobal.navigator?.serviceWorker?.getRegistrations();
            await Promise.all((registrations || []).map(registration => registration.unregister()));
          } catch {
            // Service workers are optional; ignore unsupported browser APIs.
          }
        });
      } catch (error) {
        log.debug(`Could not clear persisted browser storage before login: ${errorMessage(error)}`);
      }
    }
  }

  private async navigateToLogin(): Promise<void> {
    if (!this.page) throw new Error('Browser page is unavailable.');

    await this.clearPersistedSessionState();

    let navigationError: unknown;
    try {
      // Commit is enough to establish the document. Waiting for the login form
      // below avoids failing when Blackboard replaces the document during a
      // redirect, which can surface as net::ERR_ABORTED in Playwright.
      await this.page.goto(this.config.loginUrl, {
        waitUntil: 'commit',
        timeout: Math.min(this.config.browserTimeout, LOGIN_NAVIGATION_TIMEOUT),
      });
    } catch (error) {
      if (!isTransientNavigationError(error)) throw error;
      navigationError = error;
      log.warn(
        isNavigationTimeoutError(error)
          ? 'Blackboard login navigation timed out; checking whether the login form loaded anyway.'
          : 'Blackboard replaced the login document during navigation; waiting for the resulting page.',
      );
    }

    try {
      await this.page.waitForSelector('#user_id', {
        state: 'visible',
        timeout: Math.min(this.config.browserTimeout, LOGIN_FORM_TIMEOUT),
      });
    } catch (error) {
      // A previously saved auth state can still redirect the first request to
      // the portal. Clear it once more after that redirect and retry the
      // login URL so visible mode cannot silently continue from a home page.
      if (!navigationError && isAuthenticatedRedirect(this.page.url(), this.config.loginUrl)) {
        log.warn('Blackboard redirected to an authenticated page; clearing the saved session and retrying the login page.');
        await this.clearPersistedSessionState();
        await this.page.goto(this.config.loginUrl, {
          waitUntil: 'commit',
          timeout: Math.min(this.config.browserTimeout, LOGIN_NAVIGATION_TIMEOUT),
        });
        await this.page.waitForSelector('#user_id', {
          state: 'visible',
          timeout: Math.min(this.config.browserTimeout, LOGIN_FORM_TIMEOUT),
        });
        return;
      }
      if (navigationError) throw new Error(formatLoginNavigationError(navigationError, this.config.loginUrl));
      throw error;
    }
  }

  /**
   * Launch browser and create context
   */
  async launchBrowser(): Promise<void> {
    log.info(`Launching ${this.config.browserType} browser...`);
    log.debug(`Browser options: headless=${this.config.headless}, timeout=${this.config.browserTimeout}ms`);

    // Obscura is an optional Rust headless engine driven over CDP. It is a
    // testing backend for headless discovery/extraction; visible logins and
    // persistent-profile flows must use the Chromium backends below.
    if (this.config.browserBackend === 'obscura') {
      if (this.config.browserType !== 'chromium') {
        throw new Error('The Obscura backend only supports the chromium browser type.');
      }
      assertObscuraUsable(this.config);
      const session = await launchObscuraSession(this.config, this.config.obscuraPort || 9223);
      this.obscuraSession = session;
      this.browser = session.browser;
      this.context = session.context;
      this.page = session.page;
      log.info('Browser launched successfully (Obscura backend)');
      return;
    }

    const browserType = {
      chromium,
      firefox,
      webkit,
    }[this.config.browserType];

    const chromiumExecutable = this.config.browserType === 'chromium' ? managedChromiumExecutable() : undefined;
    if (this.config.browserType === 'chromium' && !this.config.useSystemEdge && !chromiumExecutable) {
      throw new Error(AUTOMATION_BROWSER_MISSING_ERROR);
    }

    const launchOptions = {
      headless: this.config.headless,
      timeout: this.config.browserTimeout,
      ...(this.config.browserType === 'chromium' && this.config.useSystemEdge
        ? { channel: 'msedge' }
        : chromiumExecutable
          ? { executablePath: chromiumExecutable }
          : {}),
    };
    const contextOptions = {
      viewport: { width: 1920, height: 1080 } as const,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };

    try {
      if (this.config.browserType === 'chromium' && this.config.browserProfileDir) {
        this.context = await this.launchPersistentContext(this.config.browserProfileDir, {
          ...launchOptions,
          ...contextOptions,
        });
        this.page = this.context.pages()[0] || await this.context.newPage();
      } else {
        this.browser = await browserType.launch(launchOptions);
        this.context = await this.browser.newContext(contextOptions);
        this.page = await this.context.newPage();
      }
    } catch (error) {
      if (this.config.browserType !== 'chromium' || !this.config.useSystemEdge) throw error;
      if (error instanceof Error && error.message === BROWSER_PROFILE_IN_USE_ERROR) throw error;
      await this.clearLaunchState();
      log.warn('Microsoft Edge could not be launched; falling back to the managed Playwright Chromium.');
      const fallbackExecutable = managedChromiumExecutable();
      if (!fallbackExecutable) throw new Error(AUTOMATION_BROWSER_MISSING_ERROR);
      if (this.config.browserProfileDir) {
        this.context = await this.launchPersistentContext(this.config.browserProfileDir, {
          ...contextOptions,
          headless: this.config.headless,
          executablePath: fallbackExecutable,
        });
        this.page = this.context.pages()[0] || await this.context.newPage();
      } else {
        this.browser = await chromium.launch({
          headless: this.config.headless,
          timeout: this.config.browserTimeout,
          executablePath: fallbackExecutable,
        });
        this.context = await this.browser.newContext(contextOptions);
        this.page = await this.context.newPage();
      }
    }
    log.info('Browser launched successfully');
  }

  /**
   * Waits briefly for a consent/permission dialog to appear. Unlike the old
   * isVisible() probe, this actually waits, so a dialog rendered after the
   * login form is still detected.
   */
  private async waitForConsentDialog(timeoutMs: number): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.waitForSelector(CONSENT_DIALOG_SELECTOR, {
        state: 'visible',
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Clicks the accept/agree control of a visible consent dialog. Returns
   * whether a dialog was dismissed.
   */
  private async dismissConsentDialog(): Promise<boolean> {
    if (!this.page) return false;
    for (const selector of CONSENT_ACCEPT_SELECTORS) {
      try {
        const button = this.page.locator(selector).first();
        if (await button.isVisible()) {
          await button.click({ timeout: 5000 });
          log.debug(`Dismissed the Blackboard consent dialog using ${selector}.`);
          return true;
        }
      } catch {
        // The dialog may have closed on its own or the candidate may not be
        // clickable; try the next selector.
      }
    }
    return false;
  }

  /**
   * Clicks the login button, dismissing any consent dialog that intercepts
   * the click. The dialog is optional and can appear at any moment, so both
   * scenarios (present and absent) must succeed.
   */
  private async clickLoginButton(): Promise<void> {
    if (!this.page) throw new Error('Browser page is unavailable.');
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.page.click('#entry-login', { timeout: LOGIN_CLICK_TIMEOUT });
        return;
      } catch (error) {
        const dismissed = await this.dismissConsentDialog();
        if (!dismissed || attempt === maxAttempts) throw error;
        log.warn('A Blackboard consent dialog was blocking the login button; dismissing it and retrying.');
      }
    }
  }

  /**
   * Login to Blackboard
   */
  async login(): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not launched. Call launchBrowser() first.');
    }

    log.info('Navigating to login page...');
    log.debug(`Login URL: ${this.config.loginUrl}`);
    await this.navigateToLogin();
    log.debug(`Current URL after navigation: ${this.page.url()}`);

    // Handle the cookie/privacy consent dialog if it appears. It renders
    // after the login form on BlackboardChina deployments and intercepts
    // clicks on #entry-login, so wait for it instead of probing once.
    if (await this.waitForConsentDialog(LOGIN_CONSENT_WAIT_TIMEOUT)) {
      await this.dismissConsentDialog();
    }

    // Fill in credentials
    log.info('Entering credentials...');
    log.debug(`Username: ${this.config.username.substring(0, 3)}***`);
    await this.page.fill('#user_id', this.config.username);
    await this.page.fill('#password', this.config.password);

    // Click login button
    log.debug('Clicking login button');
    await this.clickLoginButton();

    // Blackboard keeps background requests alive, so network idle is not a
    // useful completion signal. The course selector below is the success
    // signal; wait briefly for the document to settle when it does navigate.
    try {
      await this.page.waitForLoadState('domcontentloaded', { timeout: this.config.browserTimeout });
    } catch (error) {
      if (isTransientNavigationError(error)) {
        log.debug('Login document was replaced while waiting for the next page.');
      } else {
        // A slow Blackboard response is not a failed login. The course
        // selector check below is the authoritative success signal.
        log.debug('Login document did not finish loading before the timeout; validating the course selector.');
      }
    }
    log.debug(`URL after login: ${this.page.url()}`);

    // Verify login success by checking for course list
    try {
      await this.page.waitForSelector('ul.portletList-img.courseListing.coursefakeclass li a', {
        timeout: 5000,
      });
      log.info('Login successful');
    } catch {
      log.error('Login verification failed - course list not found');
      throw new Error('Login failed - could not find course list');
    }
  }

  /**
   * Get cookies for authenticated session
   */
  async getCookies(): Promise<any[]> {
    if (!this.context) {
      throw new Error('Browser context not available');
    }
    const cookies = await this.context.cookies();
    log.debug(`Retrieved ${cookies.length} cookies from session`);
    return cookies;
  }

  /**
   * Get page instance
   */
  getPage(): Page {
    if (!this.page) {
      throw new Error('Browser not launched');
    }
    return this.page;
  }

  /**
   * Get browser context
   */
  getContext(): BrowserContext {
    if (!this.context) {
      throw new Error('Browser context not available');
    }
    return this.context;
  }

  /**
   * Close browser
   */
  async close(): Promise<void> {
    const obscura = this.obscuraSession;
    this.obscuraSession = null;
    const browser = this.browser;
    const context = this.context;

    try {
      // Do not persist an authenticated Blackboard session in the dedicated
      // profile. This also makes the next visible run start at login.
      await this.clearPersistedSessionState(context);
    } catch (error) {
      log.debug(`Session cleanup before browser close did not complete: ${errorMessage(error)}`);
    }

    try {
      if (obscura) {
        // Closing the Obscura session also terminates the serve process.
        await obscura.close();
        log.info('Browser closed (Obscura backend)');
      } else if (browser) await browser.close();
      else if (context) await context.close();
      if (!obscura && (browser || context)) log.info('Browser closed');
    } catch (error) {
      log.warn(`Browser cleanup did not complete: ${errorMessage(error)}`);
    } finally {
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}
