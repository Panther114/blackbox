# AGENTS.md

Guidance for coding agents working in this repository.

## Release notes policy (mandatory when publishing a release)

When publishing a product release, the release notes must:

- Be written as **concise bullet points**, one bullet per user-visible change.
- Be written in the language of the product documentation: use **Chinese** for
  a Chinese-language product build, or **English** otherwise. Never mix the two
  languages in one release.
- Sound **natural, clear, and concise** — plain user-facing language, no
  internal jargon, no commit hashes, no issue numbers.
- Contain **only the notes for the version being published**. The full
  changelog must **never** be pasted into release notes; the complete history
  stays in `CHANGELOG.md`.

Example shape (Chinese build):

```
- 新增自动化批量下载功能，支持多个学号并行下载
- 修复登录时弹窗遮挡按钮导致登录失败的问题
- 现在会实时导出运行日志（JSON 与 Excel）
```

## Renderer UI

- Keep visual-only changes in `src/gui/renderer/**`; preserve the Electron
  main/preload/worker interfaces, the `window.blackboxGui` bridge, existing
  `data-testid` selectors, product copy and downloader behavior.
- Design: dark, compact, native Mica glass (see `DESIGN.md`). No left sidebar,
  no photographic background, no `backdrop-filter`. Satoshi only, bundled with its
  license under `src/gui/renderer/src/assets/fonts/`; never request fonts or
  imagery at runtime. Lucide icons are vendored with their license.
- Check layouts at the supported 980x680 minimum, 1120x760 and 1440x900 before
  packaging. Capture with the hidden-window flag
  (`electron dist/gui/main.js --demo --screen=<name> --no-material --capture=<png> --size=WxH`);
  extra flags: `--capture-after=<ms>` (second timestamp), `--dots=off`, `--forcefocus`
  (measure the focused animation path). Do not take desktop screenshots or show test windows.
- Packaging is Windows-only through the canonical electron-builder pipeline and
  must pass the packaged dependency-closure check (`scripts/after-pack.cjs`).
  Never repair an archive by copying a single missing module. Preserve existing
  user settings and files.
- Windows uses the installed Microsoft Edge through Playwright; no browser is
  bundled. The download ledger is a JSON file (no native modules).
- Folder metadata and folder-opening actions must work before credentials are
  saved; authentication validation belongs to login and download actions.
- Do not modify `src/automation/**` unless the task is about Automation.
