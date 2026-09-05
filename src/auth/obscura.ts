import { spawn, execSync, ChildProcess } from 'child_process';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { chromium, Browser, BrowserContext, Page } from 'playwright-core';
import { Config } from '../types';
import { log } from '../utils/logger';
import { ensureDirectory } from '../utils/helpers';

/**
 * Obscura backend — a testing example.
 *
 * Obscura (https://github.com/h4ckf0r0day/obscura) is a Rust headless browser
 * engine that speaks the Chrome DevTools Protocol. It is used here as an
 * *optional* automation backend for read-only, headless workflows such as
 * course discovery and page extraction. It is not a replacement for the
 * packaged Chromium: Obscura is headless-only, so the visible Blackboard
 * login flow and persistent-profile semantics still require the default
 * Chromium backend.
 *
 * Features surfaced:
 *  - `obscura serve` over CDP with Playwright (page navigation, DOM extraction)
 *  - built-in stealth mode (--stealth)
 *  - HTTP/SOCKS5 proxy support (--proxy)
 *  - screenshots and PDF export from a live CDP session
 *  - single-page `obscura fetch` extraction without a persistent session
 */

export const DEFAULT_OBSCURA_PORT = 9223;

export interface ObscuraServeHandle {
  child: ChildProcess | null;
  endpoint: string;
  port: number;
  stderr: string;
}

export interface ObscuraSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  serve: ObscuraServeHandle;
  close: () => Promise<void>;
}

/**
 * Resolve the obscura executable: explicit config override, OBSCURA_BINARY,
 * or plain `obscura` resolved from PATH by the OS.
 */
export function resolveObscuraBinary(config: Pick<Config, 'obscuraBinary'>): string {
  return config.obscuraBinary || process.env.OBSCURA_BINARY || 'obscura';
}

function httpGet(url: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: timeoutMs }, response => {
      response.resume(); // drain so the socket is released
      resolve(response.statusCode || 0);
    });
    request.on('timeout', () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', reject);
  });
}

/**
 * Wait until the Obscura CDP endpoint answers on /json/version.
 */
export async function waitForCdpEndpoint(endpoint: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const status = await httpGet(`${endpoint}/json/version`, 2000);
      if (status >= 200 && status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(
    `Obscura did not expose a CDP endpoint at ${endpoint} within ${timeoutMs}ms` +
      (lastError instanceof Error ? ` (${lastError.message})` : '')
  );
}

/**
 * Build the argument list for `obscura serve`. Exposed for testing.
 */
export function buildServeArgs(options: { port: number; stealth: boolean; proxy?: string }): string[] {
  const args = ['serve', '--port', String(options.port)];
  if (options.stealth) args.push('--stealth');
  if (options.proxy) args.push('--proxy', options.proxy);
  return args;
}

/**
 * Start `obscura serve` and wait for its CDP endpoint.
 */
export async function startObscuraServe(
  config: Config,
  port = DEFAULT_OBSCURA_PORT,
): Promise<ObscuraServeHandle> {
  const binary = resolveObscuraBinary(config);
  const args = buildServeArgs({
    port,
    stealth: config.obscuraStealth !== false,
    proxy: config.obscuraProxy || undefined,
  });

  log.info(`Starting Obscura: ${binary} ${args.join(' ')}`);
  let stderr = '';
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stderr?.setEncoding('utf-8');
  child.stderr?.on('data', chunk => {
    stderr += String(chunk);
  });

  const endpoint = `http://127.0.0.1:${port}`;
  try {
    await waitForCdpEndpoint(endpoint, Math.max(config.browserTimeout, 30_000));
  } catch (error) {
    child.kill();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Obscura failed to start (${message}).` +
        (stderr.trim() ? ` Obscura said: ${stderr.trim().split(/\r?\n/).slice(-3).join(' | ')}` : '') +
        ' Install Obscura (https://docs.obscura.sh) or set OBSCURA_BINARY to its executable path.'
    );
  }
  return { child, endpoint, port, stderr };
}

/**
 * Launch a full Obscura session: serve process + Playwright CDP connection.
 * The returned `close()` tears everything down in the right order.
 */
export async function launchObscuraSession(
  config: Config,
  port = DEFAULT_OBSCURA_PORT,
): Promise<ObscuraSession> {
  const serve = await startObscuraServe(config, port);

  try {
    const browser = await chromium.connectOverCDP(serve.endpoint);
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    log.info(`Obscura session ready over CDP at ${serve.endpoint}`);

    const close = async (): Promise<void> => {
      try {
        await browser.close();
      } catch (error) {
        log.debug(`Obscura browser close did not complete: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (serve.child && !serve.child.killed) {
        serve.child.kill();
      }
    };

    return { browser, context, page, serve, close };
  } catch (error) {
    serve.child?.kill();
    throw error;
  }
}

/**
 * Capture a screenshot and a PDF of a page opened in the Obscura session.
 * Files are written under `outputDir/obscura/`. Demonstrates the native
 * rendering features Obscura provides without Chromium.
 */
export async function capturePageArtifacts(
  page: Page,
  outputDir: string,
  label = 'page',
): Promise<{ screenshotPath: string; pdfPath: string }> {
  const artifactDir = path.join(path.resolve(outputDir), 'obscura');
  ensureDirectory(artifactDir);
  const safeLabel = label.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'page';
  const screenshotPath = path.join(artifactDir, `${safeLabel}.png`);
  const pdfPath = path.join(artifactDir, `${safeLabel}.pdf`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await page.pdf({ path: pdfPath, printBackground: true });
  return { screenshotPath, pdfPath };
}

export interface ObscuraFetchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Single-page extraction through the `obscura fetch` CLI. This exercises the
 * engine without keeping a browser session alive — the fastest end-to-end
 * check that the binary works on this machine.
 */
export function obscuraFetch(
  config: Config,
  url: string,
  options?: { eval?: string; format?: 'json' | 'text'; timeoutMs?: number },
): Promise<ObscuraFetchResult> {
  const binary = resolveObscuraBinary(config);
  const args = ['fetch', url];
  if (options?.eval) args.push('--eval', options.eval);
  if (config.obscuraStealth) args.push('--stealth');
  if (config.obscuraProxy) args.push('--proxy', config.obscuraProxy);
  args.push('--format', options?.format || 'text');

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`obscura fetch timed out after ${options?.timeoutMs || 30_000}ms`));
    }, options?.timeoutMs || 30_000);

    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', chunk => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', chunk => {
      stderr += String(chunk);
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(new Error(
        `Could not run Obscura (${error.message}). Install Obscura or set OBSCURA_BINARY to its executable path.`
      ));
    });
    child.on('close', code => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Check whether the Obscura binary exists and is runnable. Used by the CLI
 * test command before attempting a full session.
 */
export function isObscuraBinaryRunnable(binary: string): boolean {
  try {
    execSync(`"${binary}" --version`, {
      stdio: 'ignore',
      timeout: 10_000,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Guardrail for using Obscura with Blackbox flows: it is headless-only, so a
 * visible login (headless=false) cannot run on this backend.
 */
export function assertObscuraUsable(config: Config): void {
  if (!config.headless) {
    throw new Error(
      'Obscura is headless-only. Use the Chromium backend (or enable Headless mode) for this run.'
    );
  }
  if (config.browserProfileDir && fs.existsSync(config.browserProfileDir)) {
    log.warn('Obscura does not consume the persistent Chromium profile; stored browser state is ignored.');
  }
}
