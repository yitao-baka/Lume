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
  of text, images **and file/folder copies**, search + copy back; `Tab`
  switches Navigate / Clipboard modes. The Clipboard mode is a full page:
  category tabs (全部/文本/图片/文件/收藏), virtualized list, status bar with
  clear+confirm **and a pause-recording toggle**, source-app tracking, rich
  text (HTML) + 「复制为纯文本」, ignored-apps list, auto-merge (合并复制),
  Space multi-select → Enter merged paste, delete with undo toast, a
  「剪贴板」 settings pane, a right-side preview pane, and native OLE drag-out
  of images/files to Explorer (`src-tauri/src/clipboard.rs`,
  `src-tauri/src/dragdrop.rs`, `src/App.tsx`)
- Clipboard auto-paste — Enter on a history entry writes it to the clipboard,
  hides the launcher and sends `Ctrl+V` into the window that had focus before
  the launcher appeared (`paste_clipboard`; the original clipboard is saved
  and restored, so it's never polluted); a per-row copy button copies without
  pasting (`src-tauri/src/clipboard.rs`, `src-tauri/src/window.rs` `FocusState`)
- Clipboard storage — the DB stores only *references*, never the copied data's
  original form: images write a PNG into `data/PictureCache/<id>.png` and store
  the relative `path`; file/folder copies from Explorer (CF_HDROP) are captured
  verbatim as a newline-joined `file` row (`content`); legacy image BLOBs are
  extracted to files on launch; deleting a row/clearing removes the PNG too
  (`clipboard.rs` `insert_*_history`/`migrate_blobs_to_files`/`gc_picture_cache`)
- Continuous bar navigation — the empty-query 最近使用/已固定 bars are one
  grid: `↑`/`↓` keep the column across the boundary, `←`/`→` stay in the row
  (`App.tsx` `moveBarSelection`)
- Expand fills the screen — expanding a bar grows the window to show all its
  content, capped at the monitor work area instead of `window_height`
  (`window.rs` `get_work_area`, `App.tsx` `resizeToContent`)
- Window position presets — center / follow-mouse / four corners / custom;
  follow-mouse anchors to the cursor on show, clamped to the monitor
  (`window.rs` `position_at_mouse`)
- Interface extras — 「默认展开已固定」 (`expand_pinned`) and 「Shift+Enter
  以管理员身份启动」 (`shift_enter_admin`) toggles; settings are injected into
  the webview as `window.__LUME_CONFIG__` via an initialization script so the
  first render never races the async settings IPC (`lib.rs`, `src/App.tsx`)
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

**剪贴板管理器重构 — 阶段 1 + 2 + 3 (ROADMAP #13, complete) — as of 2026-08-13**:
阶段 2 adds rich text (`html` column, copy/paste keeps formatting, 「复制为
纯文本」 strips it), ignored apps (`ignore_apps` list, case-insensitive match on
`source_app`, skipped copies don't touch last_*), pause recording (runtime
status-bar toggle, not persisted), and auto-merge (`merge_copy` +
`merge_window_ms`, consecutive in-window text copies fold into one row shown as
「合并复制 N 条」; paste closes the merge; undo preserves html/merged_count).
阶段 3 adds a right-side preview pane that opens for text rows and for file
rows whose **content kind** (by extension) is text/audio/video/image —
arbitrary binaries (`.dll` etc.) and image-kind rows never open it. Text files
show their content (`get_file_text`), audio/video get an in-pane player
(Tauri asset protocol + `convertFileSrc`), image files show the image
(click to enlarge). **Image-kind rows preview in their own thumbnail** — click
to enlarge — and never widen the window. The window resizes only when the
preview opens/closes, and stays frozen while the context menu is open
(right-clicking never resizes). 阶段 1 was: the
clipboard mode is now a full page — category tabs (全部/文本/图片/文件/收藏),
a virtualized list at a fixed window height (the apps mode still auto-sizes),
a status bar (count + 清空 with 保留固定记录 confirm), a proper empty state,
and richer rows (type tile: text T / file / image thumb / link icon / color
swatch; two-line body `来源应用 · 时间`; hover copy/paste/delete; pin badge;
multi-select brand tint). New behavior: source-app tracking
(`source_app` column, captured via the foreground process), display-time
URL/color detection (regex, no network), Space multi-select + Enter merged
paste (`paste_clipboard_multi`, newline-joined), delete → 120ms fade → toast
「已删除 1 条 / 撤销」3s → `restore_clipboard` (image PNGs are kept until the
undo window passes, then swept by prune's gc — this differs from #12's
delete-with-file), clear confirmation, bottom toasts + the animation spec
(hover/focus/menu 100ms, delete 120ms, window 150/120ms, ease-out), and a
hand-rolled virtual list (~30 DOM rows). Settings: new 剪贴板 pane
(history cap 100/200/500/1000, record images/files, close-after-paste, show
source app, relative/absolute time, ignored apps, merge copy + window); the
recorder reads live settings. A right-side preview pane shows the selected
row's content (window widens by 320 px on selection). Details + known edge
cases in `docs/ROADMAP.md` #13. `cargo test` 54 passing.

**Prior: 两栏连续导航 + 剪贴板存储重构 + 展开撑满窗口 (ROADMAP #12) — complete as
of 2026-08-05**: the empty-query 最近使用/已固定 bars navigate as one
continuous grid (`moveBarSelection`, column-kept across the boundary); the
clipboard DB stores only references — images live in `data/PictureCache` as
PNG files (legacy BLOBs migrated out), file/folder copies are captured as
newline-joined path lists (CF_HDROP) and auto-paste by re-assembling an HDROP;
expanding a bar grows the window to the monitor work area. Details + known
edge cases in `docs/ROADMAP.md` #12.

**Prior: 剪贴板自动粘贴 + 复制按钮 + 界面体验项 (ROADMAP #11) — merged from
remote as of 2026-08-05**: clipboard-mode Enter now auto-pastes into the window
that had focus before the launcher (`paste_clipboard`, original clipboard saved
& restored), with a per-row copy button; new follow-mouse window position;
「默认展开已固定」 + 「Shift+Enter 以管理员身份启动」 interface toggles;
settings injected via `window.__LUME_CONFIG__` (initialization_script) so the
first render reads persisted values synchronously; a search-grid keyboard-nav
fix. Details + known edge cases in `docs/ROADMAP.md` #11. Note: these commits
landed on GitHub before the local docs were updated — the docs were brought up
to date on 2026-08-05.

**Prior: 最近使用栏 + 固定栏改造 + 界面设置项 (ROADMAP #10) — complete as of
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
