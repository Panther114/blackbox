# Troubleshooting

## The app does not open

Install the latest `Blackbox-<version>-x64.exe` from [GitHub Releases](https://github.com/Panther114/blackbox/releases). Reinstalling keeps your saved settings and files. If the problem persists, open the log from the footer (**Logs**) and share it.

## Login fails or Blackboard is unreachable

Run **Settings → Diagnostics** (with the login test) to see which step fails. Check your connection or VPN. Use **Visible** browser mode in Settings → Credentials to watch the sign-in, and confirm Microsoft Edge is installed (it ships with Windows).

## "A saved password cannot be unlocked"

The Windows secure store could not decrypt the saved password (for example after a profile change). Re-enter it in Settings → Credentials and save.

## Nothing new is downloaded

Files the selected layout already holds are marked *Saved* and skipped. Use **Show saved** in the file list, switch layout, or clear the download folder from Downloads.

## Where is my data?

Settings, logs and run summaries live in `%APPDATA%\blackbox\data`. Downloaded files go to the folder chosen in Settings (default `Downloads\Blackbox`).
