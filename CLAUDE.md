# CLAUDE.md

Guidance for AI agents and contributors working on **Lume**, a lightweight
Windows productivity launcher.

Read `README.md`, `docs/RULES.md`, `docs/ARCHITECTURE.md`,
`docs/UI_GUIDELINES.md`, `docs/TESTING.md`, `docs/ROADMAP.md`,
`docs/NORMS.md` and `docs/SETTINGS.md` before making changes.

## Stack

- **Frontend**: SolidJS + TypeScript + Vite (`src/`)
- **Backend**: Rust + Tauri v2 (`src-tauri/`)
- **Database**: SQLite via `rusqlite` (bundled) — clipboard history in
  `<base>/data/lume.db`, where `<base>` is `<exe_dir>` (portable, exe-adjacent)
  or `%LOCALAPPDATA%\Lume` when the exe is under Program Files (installed mode
  — `docs/NORMS.md`; `paths::base_dir()` decides; migrated from `app_data_dir()`
  in the settings iteration)

## Commands

```bash
npm run dev          # vite dev server (used by tauri dev)
npm run build        # frontend production build → dist/
npm run tauri dev    # run the desktop app (dev, needs the vite dev server)
npm run tauri build  # release bundle (installers)
npm run tauri build -- --no-bundle  # standalone release exe only
cargo check          # (in src-tauri/) type-check the Rust core
cargo test           # (in src-tauri/) run the Rust unit tests
```

**Dev vs standalone**: `npm run tauri dev` loads the frontend from
`http://localhost:1420` and shows a console window — run it from a terminal,
not by double-clicking. The **release** binary
(`src-tauri/target/release/lume.exe`) embeds the frontend and has no console;
use `--no-bundle` to get just the exe without needing WiX/NSIS installers.

## Conventions

- **Business logic belongs to Rust.** The webview is a thin view layer; it
  calls `invoke` and renders results. See `docs/ARCHITECTURE.md`.
- Keep it **minimal**. Every feature must answer: "Does this make users
  faster?" — when in doubt, leave it out.
- **All UI strings go through `t()` in `src/i18n.ts`** (en / zh-CN / zh-TW).
  Never hardcode user-facing text.
- WebView2 built-in shortcuts (Find, Print, Reload, DevTools, history nav) are
  blocked in `src/App.tsx`; only Lume's own keys and text editing in the
  search box pass through.
- Windows is the target platform. Use Windows-native APIs where appropriate
  (e.g. `ShellExecuteW` for launching `.lnk`, `RegisterHotKey` for globals).
- Network is unreliable here — **always use mirror sources** when downloading
  dependencies (crates/npm). Do not add resources that require direct access
  to blocked endpoints.

## Current feature set

- Toggle hotkey — `Alt+Space` preferred, auto-falls back to the next free
  combo (`Ctrl+Space`, `Ctrl+Alt+Space`) when taken; the active combo is shown
  in the launcher hint (`src-tauri/src/hotkey.rs`)
- Navigate main menu — the empty-query main menu is the two bars: 「最近使用」
  (recent opens, SQLite `recent_apps`, deduped by path, capped by
  `appearance.recent_count`) above 「已固定」 (SQLite `pinned_apps`). Both are
  titled + expandable (one row collapsed / all rows on 展开), sized like the
  results grid; the empty-query browse grid was removed in 0.2.12. Typing shows
  the file-search results grid (settings 系统索引). Launches are recorded at the
  single `launch_app` chokepoint (`src-tauri/src/apps.rs`,
  `src-tauri/src/recent.rs`, `src-tauri/src/pins.rs`, `src/App.tsx`)
- Clipboard manager — background capture (250 ms seq poll) → SQLite history
  of text **and images**, search + copy back; `Tab` switches Navigate /
  Clipboard modes (`src-tauri/src/clipboard.rs`, `src/App.tsx`)
- Clipboard enhancements — right-click pin, `Del` / per-entry trash button; the
  SQLite table is migrated in place (see `docs/ARCHITECTURE.md`)
- Window lifecycle: hidden at start, centered on show, auto-hides on focus
  loss (`src-tauri/src/window.rs`, `src-tauri/src/lib.rs`)
- System tray icon — left-click toggles the launcher, right-click menu has
  Restart / Exit (`src-tauri/src/tray.rs`)
- Auto-sizing window — `resizeToContent()` in `src/App.tsx` fits the window
  height to the results, capped by the settings 窗口大小 → 高度 (default
  520px); width follows the settings value
- i18n — Simplified Chinese / Traditional Chinese / English via
  `languages/*.json` + i18next, following the system language (switchable in
  settings)
- LumeSVC SYSTEM service — companion `lume-svc.exe` (no UI) registered via a
  settings button that triggers UAC (`runas`); a **dormant skeleton** that does
  not manage DB refresh (the launcher is the sole refresher) — it holds the SCM
  lifecycle + a named pipe (`\\.\pipe\LumeSVC`, DACL-protected) and a data-dir
  handoff via `HKLM\Software\Lume\DataDir`, as a bridge for future SYSTEM
  features (`src-tauri/src/svc.rs`, `src-tauri/src/bin/lume-svc.rs`)
- Run as administrator — app-entry right-click menu launches via the `runas`
  verb (`apps.rs::launch_app`); the launcher itself stays non-elevated
- Auto-start at logon — settings toggle writes/removes the
  `HKCU\...\CurrentVersion\Run` `Lume` value (registry is the source of truth)
- Single instance — a named mutex (`lib.rs` `acquire_single_instance`) held for
  the process lifetime; a second launch of `lume.exe` exits immediately

## Current iteration

**最近使用栏 + 固定栏改造 + 界面设置项 (ROADMAP #10) — complete as of
2026-08-05**: the empty-query main menu is now the two expandable bars
「最近使用」 (new, SQLite `recent_apps`, recorded at the single `launch_app`
chokepoint, deduped by path, capped by `appearance.recent_count`) and
「已固定」 (reworked with title + 展开/收起); the browse grid was removed. New
interface settings: 「显示最近使用」 toggle, 「最近使用条数」 cap, and custom
search-box placeholders per mode. Details + known edge cases in
`docs/ROADMAP.md` #10.

**Prior: Environment sync (ROADMAP #9) — complete as of 2026-08-04**
(`envwatch.rs`, zero-polling WM_SETTINGCHANGE + registry notify).
**Prior: Program Files install + LumeSVC + admin launch + auto-start
(ROADMAP #8) — complete as of 2026-08-04**. **Prior: Settings (ROADMAP #6) —
complete as of 2026-08-03** (6.1–6.6).
Next up: ROADMAP #7 plugin system (started only on explicit instruction).

Not yet implemented (future): plugin system; the file search is basic (lists
the settings 索引目录 top-level files, non-recursive); USN / whole-drive
SYSTEM indexing (LumeSVC is the skeleton for it); clipboard page redesign
(ROADMAP #10.4, design pending) — see `docs/ROADMAP.md`.
