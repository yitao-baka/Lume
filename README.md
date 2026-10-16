# Lume

A lightweight launcher for Windows.

Lume is a fast, minimal and elegant productivity launcher inspired by Spotlight and uTools.

The goal of Lume is not to become a huge toolbox.

The goal is:

> Provide the fastest way to access applications, information and workflows.

---

# Status

**Pre-26.10 — plugin platform + whole-drive file search + system integration**
(current)

- Global shortcut — configurable (default Alt+Space); conflicts reported,
  never silently swapped
- Main menu — 最近使用 + 已固定 + 推荐使用 (plugin context rows) bars
  (expandable), pinyin search, arrow/mouse navigation, real icons,
  Explorer-folder context bar
- Clipboard manager — text / image / file / audio history, category tabs
  (全部/文本/图片/音乐/视频/收藏), source-app tracking, virtualized list, pin /
  per-entry delete with undo, clear with keep-pinned confirm, search + copy
  back, Space multi-select + Enter merged paste, auto-paste into the previous
  window, rich text + 「复制为纯文本」, ignored-apps list, pause-recording
  toggle, auto-merge (合并复制), content dedupe, multi-file entries (checkable
  file list + invalid-entry graying), and a 「剪贴板」 settings pane
- Satellite preview — text / text-file / image / audio / video / PDF previews
  render in a separate non-activating window docked to the launcher's right
  edge, so the main renderer never holds decoded bitmaps / media buffers
- WebView2 idle-memory trimming — hidden windows' renderers swap their memory
  out (`SetMemoryUsageTargetLevel(Low)`), cutting the idle baseline ~26%
- Auto-hide on focus loss
- i18n — Simplified Chinese / Traditional Chinese / English
- Pinyin search for Chinese app names
- System tray icon — left-click toggles, right-click Restart / Exit
- Auto-sizing window — height fits the results, stays centered (fixed
  height in clipboard mode)
- Settings window — appearance / navigation / clipboard / hotkeys / search
  / automation / plugins / about (grouped-card layout with a settings search
  box)
- Search-state recall — a search you didn't open is restored on the next
  summon; remember-last-page and remember-checks persist across shows
- Whole-drive file search — Everything IPC first, then the LumeSVC
  NTFS USN/MFT index, exposed through one async search facade
- Plugin platform — provider / mode / service contributions, sandboxed UI,
  Rust-side permission checks, `.lupx` install/signature support, detached
  windows, declarative settings, private storage, development hot reload, and
  light/dark plugin icon pairs picked per surface theme
- Automation + elevation agent — foreground-window rules can send a
  configured hotkey, including to elevated targets through the minimal
  `lume-agent.exe` helper

Version history in [CHANGELOG.md](CHANGELOG.md); shipped iterations in
[docs/ROADMAP_HISTORY.md](docs/ROADMAP_HISTORY.md); open work in
[docs/ROADMAP.md](docs/ROADMAP.md); how to run and verify in
[docs/TESTING.md](docs/TESTING.md).

---

# Philosophy

Lume stays **fast** (launcher popup < 50ms, search response < 20ms, idle
CPU < 0.2%), **minimal** (every feature must answer "does this make users
faster?"; prefer deleting a feature over maintaining it) and **elegant** (a
native, clean, focused UI). The non-negotiable development rules live in
[AGENTS.md](AGENTS.md); the visual contract in
[docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md).

---

# Tech Stack

SolidJS + TypeScript + Vite on the frontend; Rust + Tauri v2 on the backend;
SQLite via `rusqlite` (bundled) for clipboard history, recent opens, pinned
apps and plugin documents (`<base>` = the exe dir in portable mode, or
`%LOCALAPPDATA%\Lume` when installed under Program Files). Module-level
details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

# Architecture
SolidJS UI

↓

Tauri IPC

↓

Rust Core

↓

Windows API

Lume ships three binaries (`lume.exe`, `lume-svc.exe`, `lume-agent.exe`).
Business logic belongs to Rust; the webview only renders and invokes commands.

---

# Features

## Current (Pre-26.10)

- Launcher — hidden at startup, the configured toggle combo (default
  Alt+Space) summons it; a combo owned by another app (uTools, PowerToys) is
  reported instead of silently swapped; auto-hides on focus loss;
  single-instance mutex; auto-start at logon
- Navigate main menu — 最近使用 + 已固定 bars (both titled + expandable),
  continuous grid navigation, arrow + mouse navigation, click to launch; typing
  shows the search grid (settings 系统索引)
- Explorer-folder context bar — summoned while an Explorer window is focused,
  Lume resolves the folder it shows and adds 「CMD 中打开」/「PowerShell 中打开」/
  「复制路径」 (gated by the 显示资源管理器栏 setting)
- Clipboard capture — background 250 ms sequence poll → SQLite history of text,
  images and file/folder copies (stores references only; images write a PNG
  into `data/PictureCache/<id>.png`); ignored-apps list, pause-recording
  toggle, auto-merge (合并复制), source-app tracking
- Clipboard manager — the Clipboard mode is a full page with category tabs
  (全部/文本/图片/音乐/视频/收藏), a virtualized list, a status bar, display-time
  URL / color detection, pin / per-entry delete with undo, clear with 保留固定
  记录 confirm, content dedupe, and multi-file entries (checkable file list +
  invalid-entry graying); `Tab` switches between Navigate and Clipboard modes
- Clipboard auto-paste — Enter pastes an entry into the window that had focus
  before the launcher (the pasted entry stays on the system clipboard, like a
  normal copy); a per-row copy button copies without pasting; Space
  multi-select → Enter merged paste; file copies re-assemble an HDROP
- Clipboard settings — a 「剪贴板」 pane (history limit 100/200/500/1000,
  record images / files, close-after-paste, show source app, relative /
  absolute time, ignored apps, auto-merge window, 内容去重, 开启预览,
  记住勾选)
- Satellite preview — text / text-file / image / audio / video previews render
  in a separate non-activating window docked to the launcher's right edge (the
  main renderer never holds decoded bitmaps / media buffers); PDF preview via
  PDF.js
- Window position presets — center / follow-mouse / four corners / custom;
  the preset positions the window's first appearance in a run, later summons
  keep the last position (follow-mouse re-centers on the cursor every time)
- Auto-sizing window — height fits the results, anchored to the preset until
  the user drags the window (fixed height in clipboard mode); 展开 fills the
  monitor work area
- WebView2 idle-memory trimming — hidden windows' renderers swap their memory
  out (`SetMemoryUsageTargetLevel(Low)`), then restore before showing
- i18n — Simplified Chinese / Traditional Chinese / English
- Real app icons — `IShellItemImageFactory`, in-memory cached, not in SQL
- Pinyin search — Chinese app names match by pinyin (`kuake`/`kk` → 夸克)
- Run as administrator — app-entry right-click launches via the `runas` verb;
  Shift+Enter launches the selected app elevated
- Whole-drive file search — `file_search` prefers a running Everything
  instance, then falls back to the self-hosted USN/MFT index in
  `lume-svc.exe`; the service is registered through UAC and answers over a
  scoped named pipe
- Plugin platform — first-party pages and disk plugins share one registry:
  `provider` contributes search rows, `mode` contributes full pages (optional
  logic entry, detached windows, titlebar slot and list template), and
  `service` contributes lifecycle hooks. Mode pages run in opaque-origin
  sandboxes; plugin capabilities are checked in Rust by manifest permission;
  `.lupx` packages support install/uninstall, signature verification and
  private-file preservation across upgrades
- Plugin developer workflow — dev mode, reload, change watching,
  `plugin-api.d.ts`, source URLs and CDP probes; plugin logic runs outside the
  launcher window in per-plugin sandbox frames, with circuit breaking and
  failure reporting
- Elevation agent — the only privileged code is `lume-agent.exe`; Lume itself
  stays at medium integrity and can send a configured hotkey to an elevated
  foreground window through the agent
- Search-state recall — a search you didn't open is restored on the next
  summon; remember-last-page and remember-checks persist across shows
- Automation (自动动作) — when a configured program opens a new window and takes
  the foreground, Lume presses a configured hotkey once in it (shell-hook
  watcher + `SendInput`; Alt+Tabbing back to an already-running instance does
  not re-trigger; background/minimized launches not covered). Each rule carries
  its own 延迟触发 delay (0–60000 ms) so slow-starting apps can finish building
  their UI; if the foreground moves elsewhere during the delay the key is not
  sent (an off-by-default 抢回焦点 switch instead makes Lume best-effort pull
  the program's window back to the front first — Windows blocks background
  processes from stealing focus in some cases, and that is logged). Rules live
  in the settings 自动化 pane, and the program field has a
  选择 button that lists the programs currently running with windows
  (`EnumWindows`, deduped per executable, Lume excluded) so you can pick one
  instead of typing its name. Each rule also has a 测试 button that presses its
  shortcut on demand — bypassing the new-window trigger and the delay — so a
  rule can be checked against a program that is already running.

## Planned

Open work — plugin ecosystem follow-ups (`.lupx` market source, drag-package
install, browser URL and selection capture, super panel), file-search
hardening, workflow / OCR / AI commands, cross-platform exploration — is
tracked in [docs/ROADMAP.md](docs/ROADMAP.md).


---

# Development

Before making changes read [AGENTS.md](AGENTS.md), then the topic docs:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md),
[docs/TESTING.md](docs/TESTING.md); for plugins
[docs/PLUGIN_API.md](docs/PLUGIN_API.md) (reference) and
[docs/PLUGINS.md](docs/PLUGINS.md) (getting started); settings in
[docs/SETTINGS.md](docs/SETTINGS.md). Open work is listed in
[docs/ROADMAP.md](docs/ROADMAP.md); shipped iterations in
[CHANGELOG.md](CHANGELOG.md) and
[docs/ROADMAP_HISTORY.md](docs/ROADMAP_HISTORY.md).

Due to network problems, always use mirror sources to download required files.

## Run

The frontend is managed with **pnpm** (`pnpm install`; see `.npmrc`,
`pnpm-workspace.yaml`, `package.json` → `packageManager`). `pnpm run tauri dev`
runs the dev loop; `pnpm run tauri build --debug --no-bundle` produces the
embedded debug exe (CDP smoke tests use this); `pnpm run tauri build
--no-bundle` produces the standalone release exe
(`src-tauri/target/release/lume.exe`, no console). Full verification matrix in
[docs/TESTING.md](docs/TESTING.md).

## Package

The standard release is a **portable zip** (no MSI/NSIS): `pnpm run
package:zip` runs the release build and writes
`src-tauri/target/release/bundle/zip/Lume_<version>_x64_portable.zip` with
`lume.exe` + `lume-agent.exe` + `lume-svc.exe` + `languages/` + `res/icons/`,
so the elevation agent and service ship next to the main exe as the portable
model expects.
