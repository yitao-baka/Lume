# Lume

A lightweight launcher for Windows.

Lume is a fast, minimal and elegant productivity launcher inspired by Spotlight and uTools.

The goal of Lume is not to become a huge toolbox.

The goal is:

> Provide the fastest way to access applications, information and workflows.

---

# Status

**Pre-26.8 — clipboard manager + satellite preview + memory optimization**
(current)

- ✅ Global shortcut — Alt+Space preferred, auto-fallback to a free combo
- ✅ Main menu — 最近使用 + 已固定 bars (expandable), pinyin search, arrow/mouse
  navigation, real icons, Explorer-folder context bar
- ✅ Clipboard manager — text / image / file / audio history, category tabs
  (全部/文本/图片/音乐/视频/收藏), source-app tracking, virtualized list, pin /
  per-entry delete with undo, clear with keep-pinned confirm, search + copy
  back, Space multi-select + Enter merged paste, auto-paste into the previous
  window, rich text + 「复制为纯文本」, ignored-apps list, pause-recording
  toggle, auto-merge (合并复制), content dedupe, multi-file entries (checkable
  file list + invalid-entry graying), and a 「剪贴板」 settings pane
- ✅ Satellite preview — text / text-file / image / audio / video / PDF previews
  render in a separate non-activating window docked to the launcher's right
  edge, so the main renderer never holds decoded bitmaps / media buffers
- ✅ WebView2 idle-memory trimming — hidden windows' renderers swap their memory
  out (`SetMemoryUsageTargetLevel(Low)`), cutting the idle baseline ~26%
- ✅ Auto-hide on focus loss
- ✅ i18n — Simplified Chinese / Traditional Chinese / English
- ✅ Pinyin search for Chinese app names
- ✅ System tray icon — left-click toggles, right-click Restart / Exit
- ✅ Auto-sizing window — height fits the results, stays centered (fixed
  height in clipboard mode)
- ✅ Settings window — appearance / navigation / clipboard / hotkeys / search
  / system / about (grouped-card layout with a settings search box, matching
  the Flutter settings edition)
- ✅ Search-state recall — a search you didn't open is restored on the next
  summon; remember-last-page and remember-checks persist across shows
- 🔲 Plugin system — planned (see [docs/ROADMAP.md](docs/ROADMAP.md))

Version history in [CHANGELOG.md](CHANGELOG.md); how to run and verify in
[docs/TESTING.md](docs/TESTING.md).

---

# Philosophy

## Fast

Everything should feel instant.

Target:

- Launcher popup < 50ms
- Search response < 20ms
- Idle CPU < 0.2%

---

## Minimal

Avoid unnecessary features.

Every feature must answer:

"Does this make users faster?"

---

## Elegant

The UI should feel native, clean and focused.

---

# Tech Stack

## Frontend

- SolidJS
- TypeScript
- Vite

## Backend

- Rust
- Tauri v2

## Database

- SQLite via `rusqlite` (bundled) — clipboard history, recent opens and pinned
  apps live in `<base>/data/lume.db` (`<base>` = the exe dir in portable mode,
  or `%LOCALAPPDATA%\Lume` when installed under Program Files)

---

# Architecture
SolidJS UI

↓

Tauri IPC

↓

Rust Core

↓

Windows API


Business logic belongs to Rust.

---

# Features

## Current (Pre-26.8)

- Launcher — hidden at startup, Alt+Space toggles (auto-fallback to a free
  combo when Alt+Space is taken, e.g. by uTools); auto-hides on focus loss;
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
- Window position presets — center / follow-mouse / four corners / custom
- Auto-sizing window — height fits the results, stays centered (fixed height
  in clipboard mode); 展开 fills the monitor work area
- WebView2 idle-memory trimming — hidden windows' renderers swap their memory
  out (`SetMemoryUsageTargetLevel(Low)`), then restore before showing
- i18n — Simplified Chinese / Traditional Chinese / English
- Real app icons — `IShellItemImageFactory`, in-memory cached, not in SQL
- Pinyin search — Chinese app names match by pinyin (`kuake`/`kk` → 夸克)
- Run as administrator — app-entry right-click launches via the `runas` verb;
  Shift+Enter launches the selected app elevated
- LumeSVC SYSTEM service — a companion `lume-svc.exe` (dormant skeleton)
  registered via a settings button + UAC, holding the SCM lifecycle and a
  named pipe as a bridge for future SYSTEM features
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

- Plugin system
- Workflow
- OCR
- AI commands
- Cross platform support


---

# Development

Read:

- CLAUDE.md
- docs/RULES.md
- docs/ARCHITECTURE.md

before making changes.

And remember:
Due to network problems, You should always use mirror sources to download the required files.

## Run

The frontend is managed with **pnpm** (`pnpm install`; see `.npmrc`,
`pnpm-workspace.yaml`, `package.json` → `packageManager`). Commands:

- **Development**: `pnpm run tauri dev` (loads the frontend from the vite dev
  server; run from a terminal — the debug exe needs `localhost:1420`).
- **Standalone**: `pnpm run tauri build --no-bundle`, then run
  `src-tauri/target/release/lume.exe` — it embeds the frontend and shows no
  console window.