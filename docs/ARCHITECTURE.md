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
  ├─ apps.rs     — Start Menu scan, fuzzy search, ShellExecuteW launch
  ├─ clipboard.rs— clipboard capture → SQLite, search, copy back, pin/delete
  ├─ icons.rs    — IShellItemImageFactory icon extraction + in-memory cache
  ├─ pins.rs     — pinned-apps bar (SQLite `pinned_apps`, WAL connection)
  ├─ tray.rs     — system tray icon, Restart/Exit menu, left-click toggle
  └─ hotkey.rs   — toggle shortcut: Alt+Space preferred, fallback chain
        ▼
Windows API (RegisterHotKey, ShellExecuteW, GetClipboardSequenceNumber,
             IShellItemImageFactory, Acrylic window effects)
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
- **Discovery**: walks the all-users and per-user Start Menu `Programs`
  folders recursively for `*.lnk` files. Deduped by name (per-user wins),
  sorted by name.
- **Index**: `AppIndex` state holds a lazily-built `Vec<AppEntry>` inside a
  `Mutex`. First search scans the disk; the result is cached for the process
  lifetime (rule: never block startup).
- **Search**: `search_apps(query)` scores each entry with a case-insensitive
  fuzzy subsequence matcher (`fuzzy_score`). Rewards prefix, word-boundary and
  consecutive-run matches; penalizes name length. Chinese names additionally
  carry **pinyin** search aids (`pinyin_full`, `pinyin_initials`, computed at
  scan time via the `pinyin` crate and not serialized to the frontend);
  `score_app` takes the best of name / pinyin / initials (pinyin weighted
  ×0.9). Returns the top 8.
- **Launch**: `launch_app(path)` calls `ShellExecuteW(…, "open", …)`.
  `std::process::Command` would use `CreateProcess`, which cannot resolve
  `.lnk` targets, so the shell is required.

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
Persists the Navigate **pinned bar** in a `pinned_apps` table (`path` unique,
ordered by pin time) inside `lume.db`. It uses its own WAL-mode connection so
it shares the file safely with the clipboard store. Right-clicking an app
pins/unpins it (via the custom context menu); the bar renders only on the
empty-query main menu.

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

### `clipboard.rs`
- **Capture**: `spawn_listener` polls `GetClipboardSequenceNumber` every
  250 ms on a background thread. On change it prefers text via `arboard`, else
  reads an image (RGBA → PNG blob). The listener's own `copy_clipboard` writes
  are skipped (`last_text` / `last_image_hash`).
- **Store**: SQLite at `app_data_dir()/lume.db` (`rusqlite`, bundled).
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

## Frontend

- `App.tsx` holds query / mode / results / selection state. Two modes —
  **Navigate** and **Clipboard** — are toggled with `Tab` or the pills in the
  search row; switching keeps the current query and re-searches.
- Each keystroke invokes the active mode's search command and drops stale
  responses via a monotonic request id.
- **Navigate** renders apps as a 5-column box grid (letter tile + name). Empty
  query browses all apps. Arrow keys navigate in four directions, mouse hover
  selects, click launches.
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
  repopulates the Navigate grid — each invocation starts fresh (Spotlight-like).
- `AppIndex` is built once on first search and never invalidated in v0.1;
  a rescan or SQLite-backed index is future work.
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

Planned work is tracked in `docs/ROADMAP.md`: the Navigate pinned bar and the
plugin system (not started until the user signals the groundwork is ready).
