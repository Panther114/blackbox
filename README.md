# Blackbox — BlackboardChina Downloader

Blackbox is a Windows desktop app that discovers your BlackboardChina courses and supported documents, then saves the ones you select locally. It does not submit coursework or change Blackboard data.

This application is provided solely for educational, personal, and technical purposes. By using this application, you acknowledge and agree that you are solely responsible for ensuring that your use complies with all applicable SHSID policies, platform terms, laws, and regulations.

The developer does not endorse, encourage, or authorize any misuse of this application, including any use that violates school policies, platform rules, or legal requirements. To the maximum extent permitted by applicable law, the developer disclaims all responsibility and liability for any misuse of the application, any violation committed by users, and any direct or indirect consequences resulting from such use.

## Install

Download `Blackbox-<version>-x64.exe` from [GitHub Releases](https://github.com/Panther114/blackbox/releases), run it, then save your BlackboardChina credentials in **Settings**. Blackbox drives the Microsoft Edge that ships with Windows, so no separate browser is bundled. Windows 11 gets a native Mica window material; earlier builds fall back to a solid dark surface.

## Using the app

- **Downloads** — pick courses, review files, optionally include each course's readable instructions and text, then save. Choose *Course folders* (Blackboard's structure) or *Flat files* (everything in the course folder); both can coexist and never overwrite each other. Files the chosen layout already holds are marked *Saved* and skipped.
- **Automation** — batch downloading with its own settings, folder and run log.
- **Agent Skills** — read-only export of course instructions and attachments for coding agents, plus an optional harness skill in `~/.agents/skills`.
- **Settings** — credentials (the password is kept in the Windows secure store), course filters, diagnostics and updates.

Only these document types are saved: `pdf`, `ppt`, `pptx`, `doc`, `docx`, `xls`, `xlsx`. Archives, images, media, text and data files are rejected even when the server claims a document MIME type.

After each run:

- `logs/latest-summary.txt` and `logs/blackbox.log` in the app data folder (open them from the footer).
- `<download folder>/blackbox-run-report.json`.

## Development

Requires Node.js 22 or 24.

```bash
npm install
npm run build:gui      # compile the main process and renderer
npm run gui            # launch the built app
npm run gui:demo       # renderer dev server with offline demo data (http://127.0.0.1:5173/?demo=1)
npm test               # unit tests
npm run build:app      # Windows installer in release/
```

The demo accepts `screen=` states (`courses`, `scan`, `metadata`, `files`, `download`, `summary`, `credentials`, `diagnostics`, `blocked-courses`, `updates`, `agent`, `automation`) that use local fixture data only. For a hidden-window screenshot of the real app, run `electron dist/gui/main.js --demo --screen=files --no-material --capture=out.png --size=1120x760`.

See [TROUBLESHOOTING.md](TROUBLESHOOTING.md) for common problems.
