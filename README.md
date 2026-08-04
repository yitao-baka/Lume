# Lume

A lightweight launcher for Windows.

Lume is a fast, minimal and elegant productivity launcher inspired by Spotlight and uTools.

The goal of Lume is not to become a huge toolbox.

The goal is:

> Provide the fastest way to access applications, information and workflows.

---

# Status

**v0.2.10 — auto-sizing window** (current)

- ✅ Global shortcut — Alt+Space preferred, auto-fallback to a free combo
- ✅ Navigate grid — apps as a box grid with real icons, pinned bar, pinyin
  search, arrow/mouse navigation
- ✅ Clipboard manager — text + image history, pin / per-entry delete, SQLite
  persistence, search + copy back
- ✅ Auto-hide on focus loss
- ✅ i18n — Simplified Chinese / Traditional Chinese / English
- ✅ Pinyin search for Chinese app names
- ✅ System tray icon — left-click toggles, right-click Restart / Exit
- ✅ Auto-sizing window — height fits the results, stays centered
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

## Current (v0.2.10)

- Launcher — hidden at startup, Alt+Space toggles (auto-fallback to a free
  combo when Alt+Space is taken, e.g. by uTools); auto-hides on focus loss
- Navigate main menu — apps as a box grid, arrow + mouse navigation, click to
  launch; empty query browses all apps
- Clipboard manager — text and image history, SQLite persistence, search and
  copy-back; `Tab` switches between Navigate and Clipboard modes
- Clipboard enhancements — right-click pin, `Del` / per-entry trash button
- Settings button (placeholder, page in a later iteration)
- i18n — Simplified Chinese / Traditional Chinese / English
- Real app icons — `IShellItemImageFactory`, in-memory cached, not in SQL
- Navigate pinned bar — right-click to pin apps to a bar above the grid,
  SQLite persisted
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