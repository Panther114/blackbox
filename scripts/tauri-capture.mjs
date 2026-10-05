// Hidden-window screenshot of the Tauri build via WebView2's DevTools port.
//   node scripts/tauri-capture.mjs <exe> <screen> <out.png> [WxH]
// The window is never shown (BLACKBOX_HIDDEN) and never focused.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const [exe, screen = 'files', out = 'capture.png', size = '1120x760'] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const port = 9333;

const child = spawn(exe, [], {
  env: { ...process.env, BLACKBOX_HIDDEN: '1', BLACKBOX_CDP_PORT: String(port) },
  stdio: 'ignore',
  windowsHide: true,
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(500);
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch {
      /* the app is still starting */
    }
  }
  if (!browser) throw new Error('Could not reach the WebView2 DevTools port.');
  const page = browser.contexts()[0].pages()[0];
  await page.setViewportSize({ width, height });
  // With Mica the page is transparent; paint a Mica-like dark so the screenshot is readable.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 28, g: 29, b: 34, a: 1 } });
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/index.html?demo=1&material=none&screen=${screen}`);
  await sleep(2200);
  await page.screenshot({ path: out });
  console.log(`saved ${out} (${width}x${height}) from ${page.url()}`);
} finally {
  await browser?.close().catch(() => undefined);
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}
