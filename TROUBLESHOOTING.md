# Troubleshooting

## Packaged app does not open

**Symptom:** the installed Blackbox process appears briefly or no window is visible.

**Fix:** install the latest platform installer from [GitHub Releases](https://github.com/Panther114/blackbox/releases). If the problem persists, open the Blackbox log from Settings and keep the existing user data; reinstalling does not delete saved data.

## Node not installed (source launcher)

**Symptom:** launcher says Node.js is missing.

**Fix:** install Node.js 22.x or 24.x from https://nodejs.org/, then run the launcher again.

## Node too old

**Symptom:** Node.js is below the supported 22.x baseline.

**Fix:** upgrade to Node.js 22.x or 24.x.

## Node too new (v24 unsupported)

**Symptom:** Node.js is outside the supported 22.x or 24.x range.

**Fix:** switch to Node.js 22.x or 24.x and rerun launcher.

## npm install failed

**Symptom:** bootstrap fails during dependency install.

**Fix:** run:

```bash
npm install
```

Then run launcher again.

If a previous install failed part-way, just rerun the launcher. Bootstrap now detects incomplete `node_modules` and reinstalls automatically.

## GUI/Electron install failed (ECONNRESET / network reset)

**Symptom:** `start-gui` fails during Electron postinstall with errors like `RequestError: read ECONNRESET`.

**Why:** Electron binary download is network/CDN-sensitive.

**Fix:**
1. Enable VPN or switch to a more stable network.
2. Delete `node_modules` (if present) and rerun `start-gui`.
3. Optionally set `ELECTRON_MIRROR` if your environment documents a reachable mirror.
4. Use TUI launcher (`start.bat` / `start.ps1` / `start.sh`) as a lighter fallback path.

## First run feels slow

**Symptom:** first launch takes noticeably longer.

**Why:** dependencies, TypeScript build output, and Playwright Chromium may need to install.

**Fix:** wait for first run to finish; later runs are faster.

TUI mode is lighter because GUI/Electron dependencies are skipped unless you use `start-gui`.

## Playwright install failed

**Symptom:** bootstrap fails at browser install.

**Fix:** run:

```bash
npx playwright install chromium
```

Then rerun launcher.

## Login failed

**Symptom:** setup test login or download login fails.

**Fix:**
1. Run `node dist/cli.js setup --reset`
2. Re-enter Blackboard credentials
3. Try visible mode (`HEADLESS=false`) for debugging

## Linux secure credential storage unavailable

**Symptom:** saving credentials reports that Linux secure credential storage is unavailable.

**Fix:** start GNOME Keyring, KWallet, or another Secret Service provider for the desktop session, then reopen Blackbox. The password is intentionally not written as plain text.

## macOS Keychain unavailable

**Symptom:** saving credentials reports that macOS Keychain is unavailable.

**Fix:** unlock Keychain Access and reopen Blackbox. Unsigned local builds may prompt for Keychain permission more often than signed releases.

## BlackboardChina unreachable

**Symptom:** network/timeout errors, doctor reachability warnings.

**Fix:** verify internet, VPN/firewall/proxy, and BlackboardChina site availability. Retry later if BlackboardChina is down.

## No courses found

**Symptom:** downloader shows no courses.

**Fix:**
1. Check Blackboard account access in browser.
2. Re-run setup and confirm credentials.
3. Use `node dist/cli.js doctor --login`.

## No files found

**Symptom:** courses load but no downloadable files.

**Fix:** selected sections may not contain allowed document types (pdf/ppt/pptx/doc/docx/xls/xlsx).

## Progress percentage looks different from file count

**Symptom:** percent does not match completed-files ratio exactly.

**Why:** when file sizes are known, progress percentage is byte-based; file count is shown separately.

**Fallback:** if sizes are unknown, progress switches to labeled file-count mode.

## Permission denied for download folder

**Symptom:** EACCES/permission denied on download/log/db paths.

**Fix:** choose a writable folder in setup and rerun.

## How to find logs

- Main log: `logs/blackbox.log`
- Latest run summary: `logs/latest-summary.txt`
- JSON run report: `<DOWNLOAD_DIR>/blackbox-run-report.json`
