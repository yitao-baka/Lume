# Lume

A lightweight launcher for Windows.

Lume is a fast, minimal and elegant productivity launcher inspired by Spotlight and uTools.

The goal of Lume is not to become a huge toolbox.

The goal is:

> Provide the fastest way to access applications, information and workflows.

---

# Status

**v0.2.17 — clipboard manager redesign (phases 1–3)** (current)

- ✅ Global shortcut — Alt+Space preferred, auto-fallback to a free combo
- ✅ Main menu — 最近使用 + 已固定 bars (expandable), pinyin search, arrow/mouse
  navigation, real icons
- ✅ Clipboard manager — text / image / file history, category tabs
  (全部/文本/图片/文件/收藏), source-app tracking, virtualized list, pin /
  per-entry delete with undo, clear with keep-pinned confirm, search + copy
  back, Space multi-select + Enter merged paste, auto-paste into the previous
  window, rich text + 「复制为纯文本」, ignored-apps list, pause-recording
  toggle, auto-merge (合并复制), a right-side preview pane (text/image/file,
  click to enlarge), native drag-out of images/files to Explorer, and a
  「剪贴板」 settings pane
- ✅ Auto-hide on focus loss
- ✅ i18n — Simplified Chinese / Traditional Chinese / English
- ✅ Pinyin search for Chinese app names
- ✅ System tray icon — left-click toggles, right-click Restart / Exit
- ✅ Auto-sizing window — height fits the results, stays centered (fixed
  height in clipboard mode)
- ✅ Settings window — interface / system / clipboard / plugins / about
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

- SQLite (planned — history / index persistence in a future version)

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

## Current (v0.2.17)

- Launcher — hidden at startup, Alt+Space toggles (auto-fallback to a free
  combo when Alt+Space is taken, e.g. by uTools); auto-hides on focus loss
- Navigate main menu — 最近使用 + 已固定 bars (both titled + expandable),
  arrow + mouse navigation, click to launch; typing shows the search grid
- Clipboard manager — text / image / file history (files stored as path
  lists), SQLite persistence; the Clipboard mode is a full page with category
  tabs (全部/文本/图片/文件/收藏), a virtualized list, a status bar, source-app
  tracking, and display-time URL / color detection; `Tab` switches between
  Navigate and Clipboard modes
- Clipboard auto-paste — Enter pastes an entry into the window that had focus
  before the launcher (the pasted entry stays on the system clipboard, like a
  normal copy); a per-row copy button copies without pasting
- Clipboard interactions — Space multi-select → Enter merged paste, delete
  with an undo toast (3s), clear-all with 保留固定记录 confirmation, hover
  copy / paste / delete buttons, pin badges
- Clipboard settings — a 「剪贴板」 pane (history limit 100/200/500/1000,
  record images / files, close-after-paste, show source app, relative /
  absolute time, ignored apps, auto-merge window)
- Settings window — interface / system / clipboard / plugins / about panes,
  import-export & restore, hotkey recording, system service & auto-start
- Window position presets — center / follow-mouse / four corners / custom
- i18n — Simplified Chinese / Traditional Chinese / English
- Real app icons — `IShellItemImageFactory`, in-memory cached, not in SQL
- Pinyin search — Chinese app names match by pinyin (`kuake`/`kk` → 夸克)

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

- **Development**: `npm run tauri dev` (loads the frontend from the vite dev
  server; run from a terminal — the debug exe needs `localhost:1420`).
- **Standalone**: `npm run tauri build -- --no-bundle`, then run
  `src-tauri/target/release/lume.exe` — it embeds the frontend and shows no
  console window.