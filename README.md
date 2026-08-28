# Blackbox — BlackboardChina Downloader

Blackbox is the brand for a desktop BlackboardChina course-material downloader. It discovers courses and supported documents from BlackboardChina, then saves the selected files locally. It does not submit coursework or change Blackboard data.

This application is provided solely for educational, personal, and technical purposes. By using this application, you acknowledge and agree that you are solely responsible for ensuring that your use complies with all applicable SHSID policies, platform terms, laws, and regulations.

The developer does not endorse, encourage, or authorize any misuse of this application, including any use that violates school policies, platform rules, or legal requirements. To the maximum extent permitted by applicable law, the developer disclaims all responsibility and liability for any misuse of the application, any violation committed by users, and any direct or indirect consequences resulting from such use.

## Normal user path (GitHub Releases)

Download the installer for your platform from [GitHub Releases](https://github.com/Panther114/blackbox/releases):

1. **Windows:** run `Blackbox-1.0.2-x64.exe`.
2. **macOS:** open the `Blackbox-1.0.2-*.dmg` for your Mac architecture and drag Blackbox to Applications.
3. **Linux:** run the `Blackbox-1.0.2-*.AppImage` (make it executable first), or install the matching `.deb` on Debian/Ubuntu/Mint.
4. Launch Blackbox and save your BlackboardChina credentials in Settings.

### Source fallback

If you prefer to run from source, install Node.js **22.x or 24.x** manually, then:

1. Clone or download this repository.
2. Double-click or run the launcher for your platform:
   - `start-gui.bat` / `start-gui.ps1` (Windows)
   - `start-gui.sh` (macOS/Linux)
3. The launcher automatically:
   - checks Node/npm compatibility,
   - installs dependencies (TUI launchers use lightweight bootstrap without GUI/Electron packages),
   - builds if needed,
   - installs Playwright Chromium,
   - runs setup if config is missing/invalid,
   - launches Blackbox.
   - (first run may take longer while dependencies/build/Playwright install complete)
   - if install is interrupted, rerunning launcher repairs incomplete `node_modules`
4. Enter BlackboardChina credentials once in setup.
5. Select courses/files in TUI/GUI checkboxes. After the file scan, optionally include all readable instructions and text for each selected course.
6. On future runs, double-click the same launcher again.

See [README-USER.md](README-USER.md) for short student instructions.

## Developer path

```bash
git clone https://github.com/Panther114/blackbox.git
cd blackbox
npm install
npm run build
npm start download
```

## Commands

- `npm run bootstrap` – TUI bootstrap (installs required non-GUI dependencies, builds CLI, installs Playwright Chromium)
- `npm run bootstrap:gui` – GUI bootstrap (installs full GUI stack including Electron, builds CLI+GUI, installs Playwright Chromium)
- `npm run setup` or `node dist/cli.js setup` – setup wizard
- `node dist/cli.js setup --reset` – recreate config from scratch
- `node dist/cli.js setup --test-login` – save config then test Blackboard login (blank password keeps existing saved password)
- `node dist/cli.js config-check` – launcher-focused setup validity check
- `node dist/cli.js download` – interactive download flow
- `node dist/cli.js doctor` – environment and config checks
- `node dist/cli.js doctor --login` – includes a real login test
- `node dist/cli.js config` – print current effective config
- `npm run gui` – launch desktop GUI (no rebuild)
- `npm run gui:dev` – GUI development mode
- `npm run build:gui` – build CLI + GUI bundles

### Platform build commands

- `npm run build:app:windows` – build the Windows installer on Windows.
- `npm run build:app:mac` – build the macOS DMG and ZIP on macOS.
- `npm run build:app:linux` – build Linux AppImage and Debian packages on Linux for x64.

The platform packaging scripts intentionally require a matching host OS. This keeps the bundled Chromium runtime and native SQLite module aligned with the package being produced; the release workflow builds each platform on its native GitHub Actions runner.

## Offline GUI screenshots

Run `npm run gui:demo` to launch a local renderer demo that never contacts Blackboard. The renderer also accepts seeded `screen` states for screenshot and layout QA:

```text
http://127.0.0.1:5173/?demo=1&screen=course-list
http://127.0.0.1:5173/?demo=1&screen=scan
http://127.0.0.1:5173/?demo=1&screen=metadata
http://127.0.0.1:5173/?demo=1&screen=files
http://127.0.0.1:5173/?demo=1&screen=download
http://127.0.0.1:5173/?demo=1&screen=diagnostics
```

The seeded states use local fixture data only. The normal download path remains network-backed and is not invoked by the demo.

## Manual course instructions

The GUI manual downloader keeps file attachment selection and course text selection separate. After files are scanned, enable the checkbox for each course whose readable instructions, assignment details, announcements, and other text should be saved. There are no individual instruction toggles: an included course is scraped completely. The text is written as Markdown under `<DOWNLOAD_DIR>/<course>/Instructions/`, while selected document files keep their normal download paths. Instruction-only runs are supported.

## Agent and MCP integration

The installed Blackbox application can use credentials saved in Settings. Configure an MCP client to start its installed executable with `--mcp`:

```json
{
  "mcpServers": {
    "blackbox": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Blackbox\\Blackbox.exe",
      "args": ["--mcp"]
    }
  }
}
```

For a portable CLI integration on any supported platform, configure `BB_USERNAME`, `BB_PASSWORD`, and `DOWNLOAD_DIR` in the MCP process environment (or a `.env` in its working directory), then use one of:

```bash
npx --yes blackbox@1.0.2 mcp
bunx --bun blackbox@1.0.2 mcp
```

The MCP tools are read-only: `blackboard_status`, `blackboard_list_courses`, `blackboard_sync`, and `blackboard_get_item`. `blackboard_sync` exports Markdown plus a manifest; set `include_files` only when attachments are needed.

## Strict document allowlist

Only these file types are accepted:
- `pdf`, `ppt`, `pptx`, `doc`, `docx`, `xls`, `xlsx`

Extension normalization behavior:
- Keeps valid supported extension if already present.
- Appends extension from MIME when name has no supported extension (example: `download` + `application/pdf` -> `download.pdf`).
- Rejects blocked extensions (archive/image/media/text/data) even when MIME claims a supported document.
- Replaces Blackboard-ish unknown extensions with MIME-derived supported extensions when MIME is supported (example: `download.aspx` + PDF MIME -> `download.pdf`).

## Progress display

- Download progress percentage is byte-based when file sizes are known.
- File count remains visible as secondary progress.
- If no known sizes are available, progress falls back to clearly labeled file-count mode.
- Manual course-text runs show separate discovery and Markdown-write progress, including items found and items saved.

## Reports and logs

After each run:
- Text summary: `logs/latest-summary.txt`
- JSON summary: `<DOWNLOAD_DIR>/blackbox-run-report.json`
- Main logs: `logs/blackbox.log`

## Troubleshooting

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
