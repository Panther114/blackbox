# Blackbox — BlackboardChina Downloader (Student Quick Guide)

Blackbox is a desktop downloader for BlackboardChina course materials. It saves selected supported documents locally and does not submit coursework or modify Blackboard.

## First run

For the simplest setup, download the installer for your platform from [GitHub Releases](https://github.com/Panther114/blackbox/releases).

1. **Windows:** run the Blackbox `.exe` installer.
2. **macOS:** open the Blackbox `.dmg` for your Mac architecture and copy the app to Applications.
3. **Linux:** run the Blackbox `.AppImage` after making it executable, or install the `.deb` package.
4. Follow setup prompts in Blackbox:
   - Blackboard username / G-number
   - Blackboard password
   - Download folder
5. Select courses and files in the checkbox screens (TUI) or GUI screens.

> The packaged installers include the desktop runtime and automation browser. BlackboardChina itself must still be reachable when you run a real login or download.

### Source fallback

If you run from a source checkout, install Node.js **22.x or 24.x**, then use `start-gui.bat` / `start-gui.ps1` on Windows or `start-gui.sh` on macOS/Linux. The TUI launchers remain available as `start.bat`, `start.ps1`, and `start.sh`.

## Where files go

By default: `Downloads/Blackbox` inside your home folder.
You can change this in setup.

## Run again later

Use the same launcher file again. Setup is reused automatically. If install fails midway, rerun the launcher and bootstrap will repair incomplete dependencies.

During downloads, percentage is byte-based when sizes are known; file count remains visible as secondary progress.

## Reset setup

Run:

```bash
node dist/cli.js setup --reset
```

## Run health checks

```bash
node dist/cli.js doctor
node dist/cli.js doctor --login
```

## If something fails

Open `TROUBLESHOOTING.md` and share `logs/blackbox.log` + `logs/latest-summary.txt` when asking for help.
