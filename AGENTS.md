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
  main/preload/worker interfaces and downloader behavior.
- Keep the renderer self-contained: Bai Jamjuree for the interface, with its
  font file and license bundled under
  `src/gui/renderer/src/assets/fonts/`. Do not request fonts at runtime.
- Use the mineral canvas, obsidian rail, cobalt actions, and restrained lime
  status signals. Keep course/file tables legible and retain existing product
  copy. Preserve the `window.blackboxGui` bridge and `data-testid` selectors
  when restructuring presentation.
- Check desktop layouts at the supported 980×680 minimum window size before
  packaging.
