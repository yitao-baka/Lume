# Architecture

```
SolidJS UI (src/App.tsx, src/i18n.ts)
        │  invoke("search_apps" | "search_clipboard" | "get_app_icons"
        │        | "launch_app" | "copy_clipboard" | "delete_clipboard"
        │        | "pin_clipboard" | "hide_launcher" | "get_hotkey")
        ▼
Tauri IPC
        ▼
Rust Core (src-tauri/src/)
  ├─ window.rs   — show / hide / toggle the launcher surface
  ├─ apps.rs     — file search from the index caches, fuzzy + pinyin scoring,
  │                ShellExecuteW launch (+ records recent-opens)
  ├─ cache.rs    — System32 / user / icons SQLite index caches
  ├─ clipboard.rs— clipboard capture → SQLite, search, copy back, pin/delete
  ├─ icons.rs    — IShellItemImageFactory icon extraction + in-memory cache
  ├─ pins.rs     — 已固定 bar (SQLite `pinned_apps`, WAL connection)
  ├─ recent.rs   — 最近使用 bar (SQLite `recent_apps`, WAL connection)
  ├─ settings.rs — settings.toml / default.toml / backup.toml three-file system
  ├─ tray.rs     — system tray icon, Restart/Exit menu, left-click toggle
  ├─ hotkey.rs   — toggle shortcut: Alt+Space preferred, fallback chain
  ├─ svc.rs      — LumeSVC SYSTEM-service skeleton (SCM + IPC pipe only)
  └─ envwatch.rs — keep the process env block in sync with system env changes
        ▼
Windows API (RegisterHotKey, ShellExecuteW, GetClipboardSequenceNumber,
             IShellItemImageFactory, Acrylic window effects, WM_SETTINGCHANGE)
```

## Modules

### `window.rs`
Owns the single frameless transparent webview window (label `main`, see
`tauri.conf.json`). `show()` centers the window on the current work area
before showing, so the popup always appears on the display under the cursor.
Called by the frontend (Esc) and by `hotkey.rs`. The launcher also **auto-hides
on focus loss**: `lib.rs` registers a `WindowEvent::Focused(false)` handler
that hides the window, so clicking elsewhere dismisses it.

### `apps.rs`
- **Index**: `AppIndex` state holds in-memory mirrors of the System32 and
  Desktop/user entries loaded from the `cache.rs` SQLite DBs (see Data
  management), refreshed at startup and hourly (rule: never block startup).
- **Search**: `search_apps(query)` scores each entry with a case-insensitive
  fuzzy subsequence matcher (`fuzzy_score`). Rewards prefix, word-boundary and
  consecutive-run matches; penalizes name length. Chinese names additionally
  carry **pinyin** search aids (`pinyin_full`, `pinyin_initials`, computed at
  scan time via the `pinyin` crate and not serialized to the frontend);
  `score_app` takes the best of name / pinyin / initials (pinyin weighted
  ×0.9). Returns the top 8; an empty query (browse) was removed in 0.2.12.
- **Launch**: `launch_app(path, elevated, name)` calls
  `ShellExecuteW(…, "open"/"runas", …)`. `std::process::Command` would use
  `CreateProcess`, which cannot resolve `.lnk` targets, so the shell is
  required. A successful launch is recorded into `recent_apps` (the single
  chokepoint for the 最近使用 bar).

### `icons.rs`
- **Extraction**: `extract_icon_png` calls `IShellItemImageFactory` (via
  `SHCreateItemFromParsingName`) to get a 64px icon for a `.lnk`, then
  converts the `HBITMAP` to PNG (`GetDIBits` → BGRA → RGBA → PNG).
- **Cache**: `IconCache` is an in-memory `path → data URI` map — **never
  written to SQL**. The frontend keeps a parallel `Map` and only requests
  icons it hasn't seen.
- **Loading**: the `get_app_icons` command runs extraction on a blocking
  thread (async command) and returns cached hits immediately; the frontend
  loads icons in batches of 20 so letter tiles render first and icons swap in
  progressively.

### `tray.rs`
Creates the system tray icon (`TrayIconBuilder`). Left-click toggles the
launcher (reuses `window::toggle_launcher`); the right-click menu has Restart
(`AppHandle::request_restart`) and Exit (`AppHandle::exit`). Menu labels follow
the system UI language (`GetUserDefaultUILanguage`).

### `pins.rs`
Persists the Navigate **已固定 bar** in a `pinned_apps` table (`path` unique,
ordered by pin time) inside `lume.db`. It uses its own WAL-mode connection so
it shares the file safely with the clipboard store. Right-clicking an app
pins/unpins it (via the custom context menu); the bar renders only on the
empty-query main menu, below 最近使用. Both bars are titled + expandable (one
row collapsed, all rows on 展开).

### `hotkey.rs`
Registers the toggle shortcut through `tauri-plugin-global-shortcut`. Other
apps own some combinations by default (uTools and PowerToys Run both claim
`Alt+Space`), so a candidate list is tried in order and the first one the OS
accepts wins:

`Alt+Space → Ctrl+Space → Ctrl+Alt+Space`

The winner is stored in the `ActiveHotkey` state and surfaced to the UI via
the `get_hotkey` command, so the hint line can tell the user what to press.
The plugin handler filters `ShortcutState::Pressed` for the active combo and
calls `window::toggle_launcher`. If no candidate registers, the failure is
logged and the launcher stays keyboard-less until a key frees up.

### `envwatch.rs`
Spawns one background thread (no polling) that keeps Lume's **own process
environment block** in sync with system changes, so everything Lume launches
afterwards (via `ShellExecuteW`, or future "run a command" features) inherits a
fresh PATH / variables instead of the ones frozen at startup.

The thread parks in `MsgWaitForMultipleObjectsEx` — a kernel wait — so it
consumes **zero CPU while idle**. It wakes on either:
- `WM_SETTINGCHANGE` broadcast with `lParam = "Environment"` (the Environment
  Variables dialog), caught by a hidden message-only window; and
- `RegNotifyChangeKeyValue` on `HKCU\Environment` + the HKLM session-manager
  environment key — this covers `setx` / direct registry edits, which never
  broadcast.

On a change it re-reads the registry and merges: `PATH` = system + user
(Windows concatenation order, replaced wholesale), other vars user-over-system,
`REG_EXPAND_SZ` expanded. Only **newly started** processes are affected;
already-running ones keep their original environment.

### `clipboard.rs`
- **Capture**: `spawn_listener` polls `GetClipboardSequenceNumber` every
  250 ms on a background thread. On change it prefers text via `arboard`, else
  reads an image (RGBA → PNG blob). The listener's own `copy_clipboard` writes
  are skipped (`last_text` / `last_image_hash`).
- **Store**: SQLite at `data_dir()/lume.db` (`rusqlite`, bundled).
  Text rows are deduplicated — a partial unique index on `content WHERE kind
  = 'text'` plus an explicit update-then-insert bumps recency instead of
  duplicating. Images are stored as PNG blobs. Recency timestamps are forced
  strictly monotonic so ordering never ties.
- **Pinning**: `pinned` column; search orders pinned first, and pruning only
  trims the newest 300 *unpinned* rows.
- **Migration**: `init_db` detects the v0.2 table (no `kind` column) and
  rebuilds it in place, preserving existing text history.
- **Search**: `search_clipboard(query)` runs a case-insensitive substring
  `LIKE` match, pinned-first then most recent, top 20; an empty query browses
  recent history. Image rows carry a downscaled base64 thumbnail.
- **Copy back**: `copy_clipboard(id)` looks up the row — text via
  `arboard::set_text`, images via PNG-decode → `set_image`.
- DB helpers take `&Connection`, which lets tests run against an in-memory DB.

### `recent.rs`
Persists the Navigate **最近使用 bar** in a `recent_apps` table (`path` unique,
`opened_at` recency) inside `lume.db`, on its own WAL connection. Opens are
recorded at the single `launch_app` chokepoint (`apps.rs`), deduped by path
(re-opening bumps the timestamp) and pruned to `appearance.recent_count`.
`delete_recent` soft-deletes a record (the file/app is untouched). The bar shows
only on the empty-query main menu, above the 已固定 bar.

## Data management

Everything Lume persists lives under a single writable **base dir**, decided in
`paths.rs` (`base_dir()`):

- **Portable** (exe not under `Program Files`): `<exe_dir>/` — the whole folder
  can be carried around.
- **Installed** (exe under `Program Files`, read-only for normal users):
  `%LOCALAPPDATA%\Lume\`. The SYSTEM service resolves the same dir from
  `HKLM\Software\Lume\DataDir` (its own `%LOCALAPPDATA%` is the system profile,
  which is wrong).

First run migrates the legacy `app_data_dir()/lume.db` into `data/`
(`paths::migrate_db`) and, in installed mode, copies any exe-adjacent `data/`,
`settings/`, `languages/` folders into the writable base
(`migrate_installed`). Both are copy-only — never delete.

```
<base>/
├── settings/   settings.toml (the only one read) · default.toml (factory, read-only) · backup.toml (pre-save snapshot)
├── data/       SQLite databases
├── languages/  runtime i18n overrides
└── res/        (read-only assets, stays next to the exe)
```

### SQLite databases (`data/`)

`lume.db` holds the **user data** (WAL mode, three independent connections
sharing the file safely):

| table | module | writes |
|---|---|---|
| `clipboard` | `clipboard.rs` | background 250 ms sequence poll; pruned to newest 300 |
| `pinned_apps` | `pins.rs` | pin/unpin commands (path unique) |
| `recent_apps` | `recent.rs` | recorded at the `launch_app` chokepoint (path unique, pruned to `recent_count`) |

Three rebuildable **index caches** (not user data — dropped and rebuilt freely):

| db | contents | refresh |
|---|---|---|
| `system32_cache.db` | System32 openable executables (excludes DLLs) | built once |
| `user_cache.db` | Desktop + user-dir files | startup + hourly differential (configurable) |
| `icons.db` | icon PNGs deduped by content hash | lazy on first display |

### Settings files

`settings.toml` is the only file read at runtime; `default.toml` is the factory
default copied on first run; `backup.toml` snapshots the previous file before
every save / apply / import / restore-default. All fields are
`#[serde(default)]`, so an older `settings.toml` loads unchanged and new fields
pick up their defaults.

### Rules

- **Business logic lives in Rust** — the webview only calls `invoke` commands;
  there is no frontend DB access.
- **Icons never enter `lume.db`** — extracted lazily into `icons.db`
  (hash-deduped) plus a process-level in-memory cache.
- **WAL lets three connections share `lume.db`** concurrently
  (`PRAGMA journal_mode=WAL`).
- The SYSTEM service (`lume-svc.exe`) is a **dormant skeleton**: it reads and
  writes no database — it only learns the data dir for future SYSTEM-level
  features (USN indexing).

## Frontend

- `App.tsx` holds query / mode / results / selection state. Two modes —
  **Navigate** and **Clipboard** — are toggled with `Tab` or the pills in the
  search row; switching keeps the current query and re-searches.
- Each keystroke invokes the active mode's search command and drops stale
  responses via a monotonic request id.
- **Navigate** — empty query shows the two bars (最近使用 above 已固定), each a
  titled, expandable grid of app boxes sized like the results grid; typing shows
  the search-results grid. ↑/↓ cycle the bars on the empty main menu, ←/→ move
  within the active bar; mouse hover selects, click launches. Context menus
  offer pin / launch / open location / (recent: remove-from-recent) / admin.
- **Clipboard** renders a list: text as muted clipboard-icon tiles with
  single-line previews, images as cover-cropped thumbnails, pinned rows with a
  pin badge and every row with a trash button (per-entry delete).
- Both modes support hover-select and click-activate; the search input is
  re-focused every time the window is shown.
- `Enter` launches an app or copies a clipboard entry back, then hides; `Esc`
  hides. In clipboard mode right-click pins and `Del` deletes the selected entry
  (both re-run the search). A shortcut-hint footer shows the keys.
- **i18n**: all user-facing strings go through `t()` from `src/i18n.ts`
  (en / zh-CN / zh-TW), keyed off the system language.

## State & lifecycle

- Window starts hidden (`"visible": false`), first shown by the hotkey, and
  auto-hides on focus loss (`lib.rs` window-event handler).
- The webview clears the query, results and mode on window-focus, then
  repopulates the Navigate bars (最近使用 / 已固定) — each invocation starts
  fresh (Spotlight-like), and the expanded-bar state is reset.
- `AppIndex` mirrors the `cache.rs` SQLite DBs; it is refreshed at startup and
  hourly (differential), so search reflects new files without a manual rescan.
- `ActiveHotkey` is set once at startup from the first successful
  registration and read by the frontend on mount.
- `ClipboardState` (SQLite connection + sequence tracking) is managed at
  startup; the listener thread shares it through `AppHandle`.

## Tests

Rust unit tests cover the app fuzzy scorer, the real Start Menu scan
(`src-tauri/src/apps.rs`) and the clipboard store: schema migration, text
upsert recency, image round-trip/thumbnail, pin ordering & prune exemption,
delete and clear (`src-tauri/src/clipboard.rs`). Run with `cargo test` — see
`docs/TESTING.md`.

## Future

Planned work is tracked in `docs/ROADMAP.md`: the plugin system (started only on
explicit instruction) and the clipboard-page redesign (design pending).
