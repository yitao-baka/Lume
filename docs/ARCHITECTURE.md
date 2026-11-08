# Architecture

```
SolidJS UI (src/App.tsx, src/i18n.ts)
  ├─ src/skins/ — shared skin metadata + data-skin / --surface / accent runtime
        │  invoke("search_apps" | "search_clipboard" | "get_clipboard_thumbnails"
        │        | "get_app_icons"
        │        | "launch_app" | "open_path" | "copy_clipboard" | "delete_clipboard"
        │        | "pin_clipboard" | "hide_launcher" | "get_hotkey")
        ▼
Tauri IPC
        ▼
Rust Core (src-tauri/src/)
  ├─ window.rs   — show / hide / toggle the launcher surface
  ├─ window_geometry.rs — work-area clamp + atomic size/position transaction
  ├─ webview_guard.rs — native WebView2 frame navigation / new-window guard
  │                and the shared deny-only HTTP proxy
  ├─ plugins.rs  — plugin discovery (`<base>/plugins/*/plugin.toml`) +
  │                manifest registry (`get_plugins`, reload, pinyin keywords)
  ├─ plugin_perm.rs — Rust-side permission whitelist: every host-capability
  │                plugin command re-checks the caller's plugin id against
  │                its manifest `permissions` (fail-closed; native paths are
  │                main-window only)
  ├─ plugin_window.rs — detached mode-plugin windows (`plugin-<id>`, first
  │                runtime-created windows): open/focus/close, ready
  │                handshake, state push, geometry remembered per plugin
  ├─ plugin_host.rs / plugin_net.rs — host capabilities behind plugin RPC
  │                (HTTP, dialogs, screen, file metadata) + SSRF guards
  ├─ plugin_store.rs / plugin_fs.rs — document DB, declarative settings and
  │                plugin-private files
  ├─ plugin_install.rs / plugin_sign.rs — `.lupx` inspect/install/uninstall,
  │                inspect-bound source staging, swap, private-file preservation,
  │                ed25519 signatures
  ├─ plugin_logic.rs / plugin_devwatch.rs — logic-host protocol and dev reload
  ├─ plugin_page.rs — service-role Page Model/event channel (role token + 1 MiB gate)
  ├─ plugin_secret.rs — service-only Windows Credential Manager secret slots
  ├─ apps.rs     — file search from the index caches, fuzzy + pinyin scoring,
  │                ShellExecuteW opens (Navigate launches record recent-opens)
  ├─ cache.rs    — System32 / user / icons SQLite index caches
  ├─ clipboard.rs— WM_CLIPBOARDUPDATE capture → SQLite, search, copy back,
  │                pin/delete, ignored-app name + icon resolution
  ├─ icons.rs    — IShellItemImageFactory icon extraction + in-memory cache
  ├─ pins.rs     — 已固定 bar (SQLite `pinned_apps`, WAL connection)
  ├─ recent.rs   — 最近使用 bar (SQLite `recent_apps`, WAL connection)
  ├─ settings.rs — settings.toml / default.toml / backup.toml three-file system
  ├─ i18n.rs     — languages/*.json runtime overrides + key lookup for Rust text
  ├─ texts.rs    — tray / notification / service / task / window-title wording
  ├─ tray.rs     — system tray icon, Restart/Exit menu, left-click toggle
  ├─ hotkey.rs   — toggle shortcut: the configured combo (default Alt+Space)
  ├─ svc.rs      — LumeSVC SYSTEM service (SCM + IPC pipe + index dormancy)
  ├─ agent.rs    — elevation-agent client, `\\.\pipe\LumeAgent` server, task
  ├─ input.rs    — synthetic keys (SendInput) + window/process/token probes
  ├─ pipe.rs     — length-prefixed JSON pipe client (svc + agent share it)
  ├─ everything.rs— Everything voidtools WM_COPYDATA IPC client (no DLL)
  ├─ filesearch.rs— unified file-search facade (Everything / LumeSVC backends,
  │                plus the plugin-facing readiness probe)
  ├─ usnidx.rs   — self-hosted NTFS USN/MFT full-drive index (runs in lume-svc)
  ├─ automation.rs / dirwatch.rs — foreground-window rules and index watching
  ├─ explorer.rs / appicon.rs / notify.rs — Explorer context, themed icons,
  │                and notifications
  └─ envwatch.rs — keep the process env block in sync with system env changes
        ▼
Windows API (RegisterHotKey, ShellExecuteW, GetClipboardSequenceNumber,
             IShellItemImageFactory, DWM window attributes, WM_SETTINGCHANGE,
             SendInput, Task Scheduler via schtasks)
```

There are **three binaries**, all sitting side by side in the exe directory and
reaching each other by path rather than by name: `lume.exe` (the launcher,
medium integrity), `lume-svc.exe` (the SYSTEM file-index service) and
`lume-agent.exe` (the elevated input-injection helper, docs/ROADMAP_HISTORY.md).

## Modules

### `window.rs`
Owns the single frameless webview window (label `main`, see
`tauri.conf.json`). A shown window is revealed only after the hidden renderer
has reset the destination page and submitted its measured geometry; the
hotkey then waits for that matching generation (bounded fallback) before
`window_geometry.rs` commits the client size and anchor in one `SetWindowPos`.
The 窗口位置 setting (center / corners / follow-mouse / custom) positions the
window on its first appearance in a run — later shows inherit the spot the
launcher was last closed at, and a manual drag stops automatic anchoring
altogether (session-scoped `PlacementState`, docs/ROADMAP_HISTORY.md);
`follow-mouse` is the exception and re-centers on the cursor on every show.
An explicit preset change clears the manual-spot identity and takes over.
Called by the frontend (Esc) and by `hotkey.rs`. The launcher also **auto-hides
on focus loss**: `lib.rs` registers a `WindowEvent::Focused(false)` handler
that hides the window, so clicking elsewhere dismisses it. Elevated launches
(`launch_app` / `open_terminal_in_folder` with `runas`) arm a temporary
blur-hide suppression while the UAC prompt owns the foreground, so cancelling
UAC leaves the launcher visible with its error toast.

Native `Window::{show,hide}` only changes the top-level HWND. `window.rs` also
sets `ICoreWebView2Controller::SetIsVisible` and the WebView2 memory target, so
a hidden launcher reports `document.visibilityState === "hidden"` instead of
continuing RAF/timer work. The same resource state applies to preview, settings,
detached plugin windows and the hidden logic host. The launcher stays resident;
settings, preview and the shared logic host are created on demand. A hidden
settings webview is destroyed after five idle minutes, a hidden preview after
ten, and idle per-plugin logic iframes after five minutes before the empty host
closes. A newly created settings webview stays hidden until it has loaded the
current settings, preloaded the plugin manifest list and completed the renderer
generation handshake; all settings panes are already part of that entry. Its
native builder background uses the active settings skin surface as a
no-white-flash fallback.

User-preview assets use a narrow capability boundary: the static asset scope
covers only Lume's own trees, while `plugin_allow_asset_path` checks the
caller's `fs.read` declaration and adds exactly one canonical file selected by
a plugin. The trusted main/preview renderer keeps its native `allow_asset_path`
entry point for core previews.

Window frame: the main WebView is transparent and CSS paints its effective
`--surface`; there is **no Acrylic backdrop or blur**. `appearance.window_color`
can override the skin surface, and `appearance.window_opacity` applies one
uniform opacity to the whole window (including embedded plugin pages). At
`100%`, `window::apply_launcher_chrome()` paints DWM's visible frame border
strip (`DWMWA_BORDER_COLOR`) in the same effective surface color; below `100%`
the strip is cleared because DWM colors cannot carry alpha. The effective
surface is repainted from `apply_settings` and on `WindowEvent::ThemeChanged`
in system mode. `clear_dwm_border()` (COLOR_NONE) is also what the
settings/preview/detached-plugin windows use. `DwmGetWindowAttribute(
DWMWA_VISIBLE_FRAME_BORDER_THICKNESS)` reports the strip; see
docs/ROADMAP_HISTORY.md for the pixel measurements.

### Satellite preview host

The satellite preview is a core capability rather than a plugin contribution.
`src/launcher/previewHost.ts` owns the explicit show/close state, the 100 ms
selection-follow debounce and the Esc-priority signal; the renderer lives in
`src/preview.tsx`. `window.rs` creates the non-activating, always-on-top native
window only when content first appears, with `focused(false)` and
`focusable(false)` applied in the builder. Rust stores the pending request and
waits for the explicit renderer-ready handshake before revealing the window.
The window docks flush to the launcher's client edge and tears its page down to
`about:blank` on close; after ten hidden minutes the webview itself is destroyed
and the next request recreates it. Built-in pages call the host directly;
external plugins reach the same commands through `ctx.preview.show/close` (and
Presenters through `lume.app.preview/closePreview`). Rust re-checks the
caller's `preview` permission and accepts only renderable content kinds,
never arbitrary HTML. The clipboard setting remains the automatic-follow gate.

### `webview_guard.rs`
Every launcher-owned host window (`main`, `plugin-logic-host` and each
`plugin-<id>` detached window) installs the native WebView2 boundary after the
webview is created. Top-level navigation stays on the app origin or
`about:blank` / `about:srcdoc`; child frames may additionally load the
host-authored `pluginLogicFrame.html`. The guard subscribes to
`NavigationStarting`, `FrameNavigationStarting`, per-frame
`ICoreWebView2Frame2::NavigationStarting` and `NewWindowRequested`, so
`location`, meta refresh, anchor navigation and `window.open` cannot turn a
network-denied plugin frame into an outbound request.

The shared WebView2 environment also points HTTP(S) traffic at a deny-only
loopback listener; requests are accepted and dropped rather than forwarded.
The application's real network path is Rust/WinHTTP and is unaffected. The
proxy and CDP flags are appended to
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` instead of replacing Wry's default
browser arguments.

### `apps.rs`
- **Index**: `AppIndex` state holds in-memory mirrors of the System32 and
  Desktop/user entries loaded from the `cache.rs` SQLite DBs (see Data
  management), refreshed at startup and hourly (rule: never block startup).
  Manual `refresh_index` is an async command using `spawn_blocking`; it
  resolves only after the scan/cache write and returns the real error, so the
  settings button cannot report success at task start.
  `rebuild_index` is the destructive counterpart: it clears both in-memory
  mirrors, removes `user_cache.db`, `system32_cache.db`, `icons.db` and their
  SQLite sidecars, recreates the schemas, then scans and reloads from scratch.
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
  required. A successful Navigate launch is recorded into `recent_apps` (the
  single chokepoint for the 最近使用 bar). `open_path(path)` shares the shell
  path for plugin `app.openPath`, clipboard links and the About homepage, and
  deliberately never writes `recent_apps`.

### `filesearch.rs` / `everything.rs` / `usnidx.rs`
The whole-drive file-search stack (docs/ROADMAP_HISTORY.md), surfaced as one command —
`file_search(query)` (async: sync commands run on the main thread and the
backends have timeouts).

- **Backend selection** (`filesearch.rs`): a running Everything first (its
  index is live and free), then the LumeSVC pipe, else `unavailable`. A failed
  backend enters a process-wide 10s cooldown so per-keystroke typing never
  pays repeated timeouts. Returns `{backend, status, entries}` in `AppEntry`
  shape.
- **Navigate scope**: the native Navigate call (no `plugin_id`) is gated by
  `index.full_drive_search`, which defaults off, and by an actual LumeSVC
  registration checked through SCM. With either condition false, Navigate only
  receives `search_apps` results from the configured index DBs; plugin
  `search.files` callers keep their separate opt-in capability path. Turning
  the setting on after service registration lets Navigate merge Everything /
  LumeSVC hits.
- **Readiness probe** (`file_search_status`, plugin RPC `search.status`): "is
  Everything running / is the LumeSVC index ready" without running a query —
  Everything by its cheap IPC-window probe, the service by one `status` round
  trip (engine state `ready`/`building`/`off`/`failed` + indexed file count).
  The failure cooldown is deliberately not applied: the probe reports what is
  available, not what the next keystroke would skip. Same permission word as
  `search.files`.
- **Everything IPC** (`everything.rs`): Everything 1.4's documented
  WM_COPYDATA protocol, no SDK DLL — query = packed `EVERYTHING_IPC_QUERYW`,
  reply = `EVERYTHING_IPC_LISTW`. One worker thread owns a message-only reply
  window and serializes queries; the wait loop pumps sent messages before
  checking the reply slot (replies answered reentrantly inside the blocking
  send are already in the slot; pumping in the wrong order sleeps past them).
  Everything's reply `path` is the parent directory — joined with the
  filename so hits carry full openable paths. Measured 7–8ms per query.
- **USN engine** (`usnidx.rs`, runs only inside lume-svc): per fixed NTFS
  volume a FRN→node tree (parent FRN + original/lowercased UTF-8 name arenas)
  built by a full MFT enumeration (`FSCTL_ENUM_USN_DATA`, journal position
  captured first, journal created at Everything's default sizing when
  missing), kept fresh by one blocking `FSCTL_READ_USN_JOURNAL` watcher per
  volume (zero idle CPU). Queries are Horspool substring scans over the
  lowercased arena (prefix matches ranked first); paths resolve by walking
  the parent chain (FRN 5 = volume root). v1 limits: fixed NTFS volumes only,
  no persistence (rebuild at service start), deleted directories leave
  orphans until a rebuild.
- **Dormancy** (`svc.rs`): while an Everything process exists the engine holds
  no index (no duplicate full-drive index on the machine); when it disappears
  the watcher builds lazily. The service cannot see user-session windows, so
  the probe is a toolhelp process-name check, not FindWindow.

### `agent.rs` / `input.rs` / `pipe.rs` (docs/ROADMAP_HISTORY.md)

- **The problem**: `SendInput` is subject to UIPI — only same-or-lower integrity
  windows receive synthetic input, and MSDN is explicit that a UIPI block cannot
  be read from `GetLastError` or the return value. An integrity level belongs to
  a *process*, so "partially elevate" is impossible: the only fix is to inject
  from a process that already holds the right token.
- **The split**: `input.rs` owns the primitives (`send_combo`, extended-key
  flags, `pid_of_hwnd`, `exe_of_pid`, `is_process_elevated`, `force_foreground`)
  and `agent.rs` owns the protocol, the pipe server, the client and the
  scheduled-task plumbing. Both injection paths — the in-process fallback in
  `automation.rs` and the elevated helper — call the same primitives; only the
  token differs.
- **The helper** is a third binary (`bin/lume-agent.rs`). It answers
  `hello`/`inject`/`stay`/`status`/`shutdown` on `\\.\pipe\LumeAgent` using the
  same wire framing as LumeSVC, and its whole capability is one combo into one
  foreground window (see the pipe-ownership rule above for the ACL).
- **How it starts**: a registered Task Scheduler task (`Lume\LumeAgent`,
  `RunLevel=HighestAvailable`) — one UAC prompt when registering, silent
  afterwards. Lume triggers it on demand with `schtasks /Run`; the helper exits
  by itself once idle unless a client sent `stay`. `lume-agent.exe --serve` also
  runs fine by hand for testing, and `agent_status` never starts it as a side
  effect.
- **The task XML is pure ASCII** — `texts::xml_escape` writes every code point
  outside `0x20..=0x7E` as a numeric character reference. `schtasks /Create
  /XML` decodes the file with the *caller's console code page* (not with the
  encoding the bytes are), so a localized description would otherwise be
  mis-decoded, lose markup bytes on a DBCS console and be rejected outright;
  the agent spawns schtasks with `CREATE_NO_WINDOW`, i.e. a fresh console the
  caller cannot assume is UTF-8 (docs/ROADMAP_HISTORY.md #70).
- **Failure honesty**: an injection reports the events `SendInput` actually
  inserted (`sent`), so zero is a real, visible failure — `uipi`/`blocked`/
  `not_elevated`/`needs_agent` instead of a silent no-op. See docs/ROADMAP_HISTORY.md for the
  full reason set and the known ceiling (kernel-level anti-cheat filtering is
  out of reach).

### `icons.rs`
- **Extraction**: `extract_icon_png` calls `IShellItemImageFactory` (via
  `SHCreateItemFromParsingName`) to get a 64px icon for a `.lnk`, then
  converts the `HBITMAP` to PNG (`GetDIBits` → BGRA → RGBA → PNG).
- **URL artwork**: URL clipboard rows resolve the default HTTP handler through
  `AssocQueryStringW` and extract that browser executable's Shell icon. This
  keeps links visually tied to the browser instead of using a decorative arrow.
- **Cache**: resolved icons use a bounded in-memory `path → data URI` map.
  Extracted PNGs also share the rebuildable `data/icons.db` blob store; the
  path cache covers file-search hits that are absent from the app index, so
  repeated previews do not invoke the Shell again.
- **Loading**: the `get_app_icons` command runs extraction on a blocking
  thread (async command) and returns memory/DB hits immediately; the frontend
  loads icons in batches of 20. Missing/failed artwork uses the shared
  `unknow_universal.svg` fallback until a real icon arrives.
- **Thumbnails**: `get_file_thumb` requests a real Shell thumbnail on an STA
  worker (`SIIGBF_THUMBNAILONLY`, so a file icon is never treated as content).
  It retains the bounded PNG decoder as a fallback; providers may be absent
  for formats such as Office or PDF.

### `tray.rs`
Creates the system tray icon (`TrayIconBuilder`). Left-click toggles the
launcher (reuses `window::toggle_launcher`); the right-click menu has Restart
(`AppHandle::request_restart`) and Exit (`AppHandle::exit`). Menu labels follow
`appearance.language` (`zh-CN` / `zh-TW` / `en`); `"system"` falls back to
`GetUserDefaultUILanguage`, including the Traditional Chinese sublanguage. The
wording itself comes from `languages/*.json` through `texts::tray` (compiled
fallbacks in `texts.rs`), so a language-file override reaches the tray too. The
menu is rebuilt on every settings apply so a language change is immediate.
The restart path releases the process-lifetime single-instance mutex before
Tauri spawns the replacement process; otherwise the new instance can see the
old guard and exit silently.

### `pins.rs`
Persists the Navigate **已固定 bar** in a `pinned_apps` table (`path` unique,
ordered by pin time) inside `lume.db`. It uses its own WAL-mode connection so
it shares the file safely with the clipboard store. Right-clicking an app
pins/unpins it (via the custom context menu); the bar renders only on the
empty-query main menu, below 最近使用. Both bars are titled + expandable (one
row collapsed, all rows on 展开).

### `hotkey.rs`
Registers exactly one toggle shortcut through `tauri-plugin-global-shortcut`:
the configured `hotkeys.toggle` combo (default `Alt+Space`). A conflict with
another app (uTools and PowerToys Run both claim `Alt+Space` by default) is
reported in the log and left as-is — there is no automatic switch to a
different combo; a release build has no console, so the conflict also raises a
shell notification in the configured language (`texts::hotkey_conflict`, with a
distinct zh-TW wording). The user frees the combo or records a free one in the user frees the combo or records a free one in
设置 → 快捷键, where `validate_hotkey` checks availability live (the tray's
设置 item keeps that page reachable when no shortcut registered at all).

The active combo is stored in the `ActiveHotkey` state and surfaced to the UI
via the `get_hotkey` command, so the hint line can tell the user what to
press. The plugin handler filters `ShortcutState::Pressed` for the active
combo and calls `window::toggle_launcher`; if the combo could not be
registered, `ActiveHotkey` stays empty and nothing toggles.

### `envwatch.rs`
Spawns one background thread (no polling) that keeps Lume's **own process
environment block** in sync with the registry. It rebuilds the block once at
startup (healing an incomplete environment inherited from the parent process)
and again on every system change, so everything Lume launches afterwards (via
`ShellExecuteW`, or future "run a command" features) inherits a fresh PATH /
variables instead of the ones frozen at startup.

The thread parks in `MsgWaitForMultipleObjectsEx` — a kernel wait — so it
consumes **zero CPU while idle**. It wakes on either:
- `WM_SETTINGCHANGE` broadcast with `lParam = "Environment"` (the Environment
  Variables dialog), caught by a hidden message-only window; and
- `RegNotifyChangeKeyValue` on `HKCU\Environment` + the HKLM session-manager
  environment key — this covers `setx` / direct registry edits, which never
  broadcast.

At startup and on each change it re-reads the registry and merges: `PATH` =
system + user (Windows concatenation order, replaced wholesale), other vars
user-over-system, `REG_EXPAND_SZ` expanded. Registry value names are matched
case-insensitively (the default spelling is `Path`, not `PATH`). Only **newly
started** processes are affected; already-running ones keep their original
environment.

### `clipboard.rs`
- **Capture**: a message-only HWND listens for `WM_CLIPBOARDUPDATE` and then
  reads `GetClipboardSequenceNumber` for dedupe. If registration fails, a
  two-second sequence check is the bounded fallback. On change it prefers text
  via `arboard`, then file lists, then images (RGBA → PNG blob). Lume's own
  history-copy/paste
  writes are skipped by exact clipboard sequence number, never by content, so
  two external copies of identical content still create two events (or bump a
  deduped row). Captured text keeps leading/trailing whitespace; rich HTML is
  truncated only at a UTF-8 boundary.
- **Store**: SQLite at `data_dir()/lume.db` (`rusqlite`, bundled).
  Text rows are deduplicated — a partial unique index on `content WHERE kind
  = 'text'` plus an explicit update-then-insert bumps recency instead of
  duplicating. Re-enabling dedup collapses historical duplicates to the newest row (carrying any pin) before recreating the unique index, so an off-period history can never prevent startup. Auto-merged text rows are always downgraded to plain text
  (`html = NULL`); concatenated pieces never keep stale rich-text markup.
  Images are stored as PNG blobs. Recency timestamps are forced
  strictly monotonic so ordering never ties.
- **Pinning**: `pinned` column; search orders pinned first, and pruning only
  trims the newest 300 *unpinned* rows.
- **Migration**: `init_db` detects the v0.2 table (no `kind` column) and
  rebuilds it in place, preserving existing text history.
- **Search**: `search_clipboard(query, kind)` runs a case-insensitive
  **literal** substring match (`instr(lower(...))`, not SQL `LIKE` wildcards).
  The reply is `{ items, total, categories }`: one query supplies both the active
  category and every count. Content type is resolved from the row (file rows use
  their first path) before `history_cap` is applied, and each category caps its
  own unpinned rows. Pinned rows stay outside that cap, so an old favorite
  remains visible even when newer unpinned rows exceed the cap. Counts aggregate
  the same query independently of the active category, so tab badges do not
  shrink when the user switches tabs. Search rows never decode image files;
  `get_clipboard_thumbnails(ids)` resolves at most 32 thumbnails for the
  currently visible image rows and returns them as base64 PNG data URIs.
  **Async on purpose**: Tauri runs *sync* commands on the main (UI) thread —
  a full-history load blocked every other IPC for seconds in a debug build,
  stalling the frontend's window resizes (the loading gate's collapse among
  them). Same rationale as `get_file_thumb` / `get_file_bytes` /
  `get_video_thumb`; anything that reads files, decodes images or queries a
  big table belongs off the main thread (see docs/ROADMAP_HISTORY.md). The
  copy/paste/delete/clear/exists commands and every plugin-facing clipboard
  read/write/probe follow the same rule; image decode, file probes and cache
  cleanup never run on Tauri's main thread.
- **Row artwork**: single-file rows request the file/folder's own Shell icon;
  URL rows request the default browser icon; multi-file rows keep the aggregate
  multi-file glyph. The Page Model passes the resolved image as a `file-icon`
  resource so both built-in Presenters render the same artwork.

- **Copy back**: `copy_clipboard(id)` looks up the row — text via
  `arboard::set_text`, images via PNG-decode → `set_image`. Auto-paste writes
  the payload, hides or suppresses auto-hide according to `paste_close`, then
  explicitly restores the recorded target HWND as foreground before SendInput;
  focus failure is reported instead of claiming a paste.
- **Ignored apps**: names use the same process-stem normalization as capture;
  `clipboard_ignore_app_icons` resolves icon paths from running windows, App
  Paths, Start Menu shortcuts and PATH off the IPC thread, then reuses the
  shared `get_app_icons` cache. Unresolved names fall back to the standard
  unknown-app glyph in the settings UI.
- DB helpers take `&Connection`, which lets tests run against an in-memory DB.

### `recent.rs`
Persists the Navigate **最近使用 bar** in a `recent_apps` table (`path` unique,
`opened_at` recency) inside `lume.db`, on its own WAL connection. Opens are
recorded at the single `launch_app` chokepoint used by Navigate (`apps.rs`),
deduped by path (re-opening bumps the timestamp) and pruned to
`appearance.recent_count`. Non-Navigate opens use `open_path` and never enter
this table.
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
| `clipboard` | `clipboard.rs` | `WM_CLIPBOARDUPDATE` listener (sequence dedupe); pruned to newest 300 |
| `pinned_apps` | `pins.rs` | pin/unpin commands (path unique) |
| `recent_apps` | `recent.rs` | recorded only by Navigate's `launch_app` chokepoint (path unique, pruned to `recent_count`) |

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

The settings window autosaves a **minimal patch** (`save_settings_patch`): only
fields that differ from the last server-confirmed baseline. A single-writer
frontend queue debounces text and sliders, serializes writes, and merges later
edits before the next patch. The Rust side merges that patch into the current
`SettingsState` under its lock, so autosave cannot roll back plugin
enable/disable, plugin geometry / theme preferences, last-page bookmarks or
remember-checks writes made in the meantime. A failed write restores the
affected controls plus the active window's skin and the accent DOM to the
confirmed snapshot, then exposes retry in the footer. Import,
restore-default and restore-backup call the same runtime-apply helper as a
normal save (window geometry, hotkey, dedup index, index refresh + watcher,
plugin dev watcher, `settings-applied`), so file replacement is never
persist-only.

Reversible preferences save automatically and expose a six-second undo in the
status bar; there is no global Save button or unsaved-draft prompt. The last
successful change stores its before/after snapshots so undo submits the inverse
minimal patch through the same queue. Plugin enable/disable, developer/trust
switches, declarative plugin settings, autostart and service/agent/import
operations remain explicit commands with real status feedback; destructive
ones use the shared confirmation dialog. `set_plugin_dev_mode` clears
`trust_all` on every transition, requiring a fresh acknowledgement after
developer mode is turned back on.

Two distinct "missing" cases, and they resolve differently — worth knowing
before adding a field:

- **the table exists but a key is missing** → the key's
  `#[serde(default = "…")]` function runs;
- **the whole table is missing** (a file written before the feature landed) →
  the field's own `Default` runs, so a *derived* `Default` silently turns every
  bool off regardless of the per-key defaults. `Automation` therefore writes its
  `Default` out by hand, and
  `automation_defaults_apply_when_the_table_is_absent` pins it.

### Rules

- **Business logic lives in Rust** — the webview only calls `invoke` commands;
  there is no frontend DB access.
- **Icons never enter `lume.db`** — extracted lazily into `icons.db`
  (hash-deduped) plus a process-level in-memory cache.
- **WAL lets three connections share `lume.db`** concurrently
  (`PRAGMA journal_mode=WAL`).
- The SYSTEM service (`lume-svc.exe`) owns the **self-hosted USN index**
  (`usnidx.rs`, in memory only — rebuilt from the MFT on service start, no
  database) and answers `search`/`status` over `\\.\pipe\LumeSVC`.
- **Pipe ownership and ACLs** — each pipe is owned by the process that can
  actually serve it, and its DACL is scoped to the smallest audience that
  works. `\\.\pipe\LumeSVC` grants `Authenticated Users` + SYSTEM (any local
  process may ask for file-search results). `\\.\pipe\LumeAgent` grants **the
  installing user's SID** + SYSTEM only: it is a high-integrity key injector, so
  widening it would make it a local privilege-escalation primitive. The agent
  additionally refuses callers from another session or from any image other than
  the sibling `lume.exe` (docs/ROADMAP_HISTORY.md).
- **Nothing higher-integrity runs in the launcher process.** `lume.exe` stays at
  medium integrity; the only privileged code lives in `lume-agent.exe`, whose
  entire capability is "send one configured hotkey to the foreground window it
  was told about".

## Frontend

- The launcher frontend is modular. `src/App.tsx` is the **shell /
  composition root** (2026-09-27 主窗口部件化, docs/ROADMAP_HISTORY.md): it owns the
  session lifecycle (session continuation + keep-alive host stack, mode
  switching, mount-time listeners),
  wires the `PluginServices` every page receives via a late-bound deps
  object, and composes the uTools-style surface — the `SearchBox` widget on
  top and the active Page Session's Presenter spliced below it through the
  internal shell adapter, plus the shared overlays (toast, context menu).
- **Session continuation / keep-alive（docs/ROADMAP_HISTORY.md）**：已访问页面挂载后只
  隐藏不卸载（`src/launcher/session.ts` 的主机栈，LRU 8 + 淘汰前 view 帧
  快照，一次溢出只淘汰应淘汰的页数）；hide/show 与模式切换不重置
  mode/query/页面状态。跨窗口（分离/回流）走 `sessionFrames` 帧存储 + 快照
  v2（键控 auto 层 + custom 钩子），分离期间启动器不留活副本（单一权威），
  用户关窗（payload `user:true`）回流到该插件页恢复。收到**新的 `enter`**
  时该插件尚在等待重放的会话帧直接作废（新进入优先于旧快照）。对标
  zTools 的 WebContentsView 保活/搬移；Tauri 不能搬 webview，页面自有 JS
  状态需 `lume.on.snapshot/restore`（§6C）。
- **Idle reset（docs/ROADMAP_HISTORY.md）**：Rust `window::hide_main` 是唯一隐藏收口
  （blur / 热键 / Esc / `hide_launcher`），隐藏时广播 `launcher-hidden`；
  前端在 `beginSummon` 里比较挂钟间隔（无后台定时器，睡眠/休眠照常计时），
  超阈值即 `applyIdleReset()`：回导航页、清 home 查询、逐实例
  `setQuery("")` + `restorePage("all")` + `reset()`、卸载非豁免保活宿主并
  丢弃会话帧。豁免 = 清单 `keep_session` 或用户覆盖
  （`settings.plugins.keep_session_overrides`，用户值优先）；分离窗口不参与；
  `lastHiddenAt` 仅内存，跨重启恢复仍由 `remember_last_page` 决定。
- **搜索框路由（docs/ROADMAP_HISTORY.md）**：搜索框默认是**全局单值**（`App.tsx` 的
  `sharedQuery`，以最新输入为准）——模式切换 / 切换键把该值推入目标页的
  query 镜像并按其 `search`；插件 `app.setQuery`、输入框占用（subInput）回填
  写同一份值；打开首页条目后的下次呼出、闲置重置清空它，分离窗口回流把窗口
  最后查询并入。设置「各模式使用独立搜索词」`appearance.per_mode_query`
  （默认关）开启后恢复逐页独立 query（仍仅会话内存）。经关键字 /
  feature 行**进入**某模式会消耗共享值——入口触发词不是目标页的过滤条件。
- **Bridge host-form constant（docs/ROADMAP_HISTORY.md）**：the Presenter
  bridges pin a synchronous `lume.env.form` on every Presenter iframe —
  `"launcher"` (inside the launcher window) or `"window"` (a detached plugin
  window; logic frames are always `"launcher"`). Pages must
  use it instead of counting parent-document iframes: keep-alive (docs/ROADMAP_HISTORY.md) keeps
  several mode pages mounted at once, so frame counting misjudges the form
  (translator lost its detach button this way). §6C/§6G.3.
- `src/shell/SearchBox.tsx` — the search-row widget (magnifier + query input
  + page pills + settings gear). Controlled/pure: the shell owns query
  routing (page `handleQuery` interception → `subInput` ownership → search)
  and placeholder resolution (`subInput` → page `placeholder()` → plugin
  `setPlaceholder` map). The default route is the one shared query
  (docs/ROADMAP_HISTORY.md — see above); `appearance.per_mode_query` restores per-page
  queries. Pill presentation is setting-driven: icon +
  name by default, icons-only with `appearance.mode_switch_icons_only` on
  (`title`/`aria-label` carry the name; a mode without an icon falls back to
  `res/icons/unknow_universal.svg`). The visible viewport is measured from the
  natural width of the first three pills and capped at `min(44%, 320px)` for
  named pills or `104px` for icons-only. A fitting trio keeps its content width;
  only overflow shrinks the three pills and ellipsizes names. Later pills remain
  in the hidden-scrollbar strip, and the active pill scrolls into view on mode
  changes. Below 640px it also falls back to icons-only so labels cannot consume
  the search input; wheel/trackpad scrolling remains available without edge
  controls, and the input swaps to the short localized placeholder below
  160px.
- **Navigate direct input mode** — `appearance.disable_ime_on_navigate` (default
  off) makes `SearchBox` render the search field `readOnly` only while Navigate
  is active. A read-only field does not start a Windows TSF editing session, so
  IME candidate windows cannot enter composition. `SearchBox` then owns the
  standard single-line edit operations: printable key insertion,
  selection/backspace/delete, Ctrl/Shift+Insert paste, Ctrl+X cut and
  newline-to-space normalization. Because read-only native inputs do not paint
  a caret, a theme-colored overlay follows the collapsed selection, mouse and
  keyboard navigation, and scroll offset. Keystroke-driven search dispatches
  are debounced for 80ms by `App.tsx`; direct lifecycle searches cancel the
  pending debounce. Plugin pages and the setting-off state return to the
  ordinary editable input and native IME path. System input-method selection
  and other windows are untouched.
- **Navigate result artwork** — `NavigateView` renders extracted icons without
  a mask by default and uses `unknow_universal.svg` when no icon exists.
  `appearance.round_app_icons` (default off) toggles the launcher's
  `circle-app-icons` class; only that class applies the `50%` circular crop.
- **拼接几何 (the seam)**: the surface is one continuous panel — literally
  one color: the panel fill, the DWM frame strip and the default plugin-page
  canvas are all `--surface` (see Surface in docs/UI_GUIDELINES.md; do not
  give `.launcher` a border or CSS radius; only the explicit whole-window opacity setting may make it translucent). The search row
  carries no bottom border and `.results` has no inset, so the page area
  starts exactly at the search row's bottom edge and runs to the panel edge
  on the left, right and bottom. Each page brings its own inner padding
  (`.result-grid` 8px, bar grids 10px, `.plugin-list` 10px, `.clip-list`
  `0 6px 4px`) — a page that wants an inset owns it. `WINDOW_PAD`
  (`src/launcher/types.ts`) is the fit-height slop for this geometry: changing
  one without the other leaves an empty strip under the content or clips the
  page. Two states have **no page area at all** — the window is the search row
  alone: an empty home menu (no bar sections) and a **fit page** that is still
  loading (the internal shell adapter's ready gate; the pill carries the
  spinner meanwhile). A fixed page keeps its target height while loading and
  only hides `.results`.
- **Page canvas (disk plugin pages)**: a mode page is an opaque-origin iframe.
  With a dark `color-scheme` — every mirrored-palette plugin sets one —
  Chromium paints an **opaque #121212 canvas** for a transparent root
  background, and host-painted backgrounds are invisible under such a frame
  (`background` on the iframe element does nothing); the splice then shows a
  near-black page inside the panel. The host therefore injects the page's
  default canvas in the Presenter bridge — the same `--surface` the panel itself
  paints, so the page is literally the panel at the splice:
  `html{background:var(--lume-page-bg,<the skin's --surface>)}`, and the
  bridge keeps `--lume-page-bg` plus `data-lume-skin` in step with the
  `theme`/`skin` events. The iframe also receives `--lume-page-accent`.
  A plugin that paints its own `html`/`body` background still wins (its rule
  comes later in the document).
  Both the default and the pushed value are the **plugin's effective** mode:
  since docs/ROADMAP_HISTORY.md a plugin can pin its own light/dark through
  `lume.theme.set` (`settings.plugins.color_modes`), and then only that
  plugin's canvas, `theme` events, detached-window chrome and taskbar icon
  follow the override — the launcher keeps its own `data-theme`, and other
  plugins' pages are untouched (`src/plugins/themePrefs.ts`).
- `src/page-runtime/` — the framework-independent page contract and host
  runtime: serializable `PageModel`, revisioned model store, Page Intent
  routing, Presenter compatibility/fallback and built-in model schemas.
  `PageSession.publish` validates every service snapshot; a malformed or
  oversized model becomes a visible `model.invalid` page error instead of an
  empty/crashed Presenter. Resource refs must use a WebView-safe image URL
  (`http(s):`, `asset:`, `lume-resource:` or an image `data:` URL, including
  Vite's parameterless `data:image/svg+xml,...` form); another scheme rejects
  the whole snapshot. Page Service lifecycle events queue across slow
  startup and replay as query → settings → files → show/hide → enter.
  Presenter mounts reset modal/layout ownership, buffer events until ready,
  then replay model/query/show before enter. Auto snapshots never read
  password values (fields carry `secret`; the host clears them again).
  Presenter bridges expose only `fs.readText` / `fs.bytes` as an optional file
  exception; the manifest must declare `fs.read`, `assertPermission` checks the
  frontend ledger, and the Rust command resolves the caller again. The CSP keeps
  network/frame/object disabled while allowing blob scripts and the embedded
  PDF.js worker (`worker-src blob:`).
- `src/page-services/` — built-in pages' logic layer. `navigate/service.ts`
  owns the bar registry, merged search pipeline, actions and drag-reorder;
  `clipboard/service.ts` wraps the Rust-backed clipboard store, publishes the
  visible row window before any image decode, then requests thumbnails only for
  the visible image ids (max 32 per batch, 64 cached). `clipboard/modelBudget.ts`
  keeps that window under the 1 MiB Page Model limit: text rows carry a
  4,096-character display preview, oversized thumbnails are dropped before rows,
  multi-file previews stop at 256 entries and shrink further to their
  serialized-byte budget, and the longest contiguous row window that fits is
  published. Full values remain addressable through Page Intents instead of
  riding in the model.
- `src/presenters/` — replaceable page renderers. Navigation has the default
  grid and a compact list; clipboard has the full history list and a compact
  history. Each Presenter consumes only the model plus a `dispatch` function.
- Detached page windows mirror the launcher-owned Page Session: their Presenter
  calls a bounded, window-label-checked bridge for model/intent/service
  lifecycle operations, while model and Presenter-setting pushes travel back
  over the existing plugin-window state channel. A Presenter's declared
  `titlebar` mounts as a second restricted Presenter iframe in the window
  chrome and dispatches through the same session.
- Presenter and logic iframes receive a strict CSP (`connect-src`,
  `form-action`, `frame-src`, `object-src`, `worker-src` closed) and run in an
  opaque sandbox without `allow-same-origin`, forms or popups. Manifest file
  fields are plugin-relative; Rust validates both the lexical path and the
  canonical target, and logic modules are read through a token-scoped Rust
  command. Snapshot caps run in-frame, at the bridge and again on Rust's
  cross-window close report. Feature/window regexes execute in a dedicated
  Worker with a 50 ms timeout; manifest arrays, strings and pattern lengths are
  bounded before they reach the per-keystroke matcher.
- `src/plugins/` — **every page below the search box is a plugin**.
  Built-in navigation and clipboard expose a thin internal `ModeInstance`
  shell adapter over `PageSession`; disk page modes enter the shared registry
  through `createPageRuntimeMode`:
  - `navigate/` — the built-in **home page** (id `"apps"`, `home: true`, the
    only `heightPolicy: "fit"` page). Its `index.tsx` joins the navigation
    Page Service to the grid/list Presenters while preserving bar expansion,
    keyboard/mouse selection, context menus and pinned drag reorder. The list
    Presenter uses linear ↑/↓ movement and clamps a collapsed section to its
    one visible row; the grid keeps two-dimensional arrow movement.
  - `clipboard/` — the clipboard-history contribution. Its `index.tsx`
    joins the clipboard Page Service to the history/compact Presenters and
    retains the settings, modal and keyboard lifecycle exposed by
    `ModeInstance`; the core PreviewHost reads its first-party follow source. Each Presenter reports its painted row height with the
    viewport intent, so the Page Service can window the same authoritative
    list at either 52px or 44px rows.
  - `registry.ts` + `types.ts` — the registry all plugins plug into
    (`definePlugin` for built-ins, disk discovery + `createPageRuntimeMode`
    for on-disk page modes, plus list-template/provider/service adapters); the
    Rust side discovers manifests
    (`<base>/plugins/<id>/plugin.toml`) in `plugins.rs` and carries the
    enabled set in `settings.plugins.disabled`. Adding a launcher page no
    longer touches the shell. Logic manifests travel with every `load` push and
    are refreshed on `settings-applied` / `plugin-reload`; per-plugin
    lifecycle work is serialized so an old `unload` cannot revoke a new
    token. `navBars` waits for the logic-ready signal and its declared hook set,
    then awaits the real RPC result; navigation refreshes use a generation so
    stale asynchronous columns cannot overwrite newer ones. Disabling a plugin
    runs the same unload path as reload and revokes its logic tokens. Provider
    and navBars fan-in pass through shared per-plugin/page budgets; providers
    search concurrently and publish incrementally. HTTP(S) row icons are
    refused so the deny-only WebView proxy cannot bypass `network`. The registry
    also owns the mode-pill data:
    a manifest `hidden = true` mode is filtered out of the pill bar and the
    switch-key cycle (its entry is the Navigate search row), and every
    Navigate row a plugin contributes defaults to the plugin's own icon set
    when the row carries no explicit `icon` (provider results, feature rows,
    keyword-entry rows). The set is the manifest `icon_light`/`icon_dark`
    pair with the legacy single `icon` as fallback; `pickIcon` chooses
    per the **surface's** current mode through the reactive
    `themeMode()` signal (`src/theme.ts`), so a theme flip re-renders rows,
    pills and settings cards without re-running a search. Explicit variants
    render as-is; only legacy picks keep the historical `--icon-filter`
    inversion. A detached plugin window's taskbar icon goes through the same
    rule Rust-side (`appicon.rs`), keyed to the plugin's effective mode.
- `src/launcher/` shared modules:
  - `types.ts` — shared types + pure constants (mode/entry types, key sets,
    sizing constants, category tables).
  - `clipData.ts` — pure clipboard-data helpers (text subtype detection,
    row title/meta formatting, content-kind classification, satellite
    preview-target decision).
  - `icons.ts` — `createIconStore()`: the in-memory icon cache mirroring the
    backend `IconCache` (batched `get_app_icons` fetches).
  - `iconSpec.ts` — plugin icon specs: `resolveIconInput` /
    `resolveThemedIcon` / `pickIcon` (surface-theme choice, legacy flag for
    the `--icon-filter` exemption) / `resolveIconUrl` (URI pass-through +
    plugin-relative asset URLs). Shared by the registry and the settings pane.
  - `sizing.ts` — `createWindowSizer()`: the "拼接" height model (fit pages
    auto-size to content; fixed pages splice in under the search box at the
    manifest/`window_height` height), bar column measurement, work-area cap,
    virtual-list viewport measurement. Requests are serialized with
    latest-wins coalescing and a renderer generation; only a successful
    `apply_launcher_geometry` advances the runtime-size baseline. Two special
    cases: a **loading fixed page** keeps its target height and only the
    `.results` visibility gate hides content, while a **loading fit page**
    collapses to the search row; an **empty fit page** (no bar sections at all)
    is that same search-row state — no reserved "empty-state" strip and no
    `WINDOW_PAD` below a page that has no content.
  - `menu.ts` — `buildMenuItems()`: right-click menu construction for
    app / folder / clipboard targets, over the narrow structural
    `NavMenuActions` / `ClipMenuActions` interfaces each page supplies through
    its internal shell adapter. The composition root measures the rendered
    menu and flips/clamps it on both axes; while it is open the menu owns
    Arrow/Home/End/Tab/Enter/Escape, so page selection behind the overlay
    cannot move.
  - `keyboard.ts` — `createKeyRouter()`: the window-level keydown routing
    (Esc layering, mode switch, shared ↑/↓/Enter fallback — per-page keys
    delegate to the active page's `onKey`) and the WebView2 accelerator
    blocker. IME composition (`isComposing` / legacy `keyCode 229`) is passed
    through untouched; text-editing targets are exposed to pages through
    `ModeKeyContext.editing`, and a page's `modal()` scope suppresses all
    mode-switch/shared bindings while its dialog is open. The accelerator
    blocker allows the native Windows edit set (Ctrl+Backspace, Ctrl+Home/End,
    word navigation, …) inside text fields.
- The settings window has its own `settings.html` / `src/settings-entry.tsx`
  entry and keeps the launcher bundle out of the settings renderer. The nine
  settings panes ship in the settings entry rather than cold-loading on first
  click (`src/settings/` — grouped navigation, shared semantic rows, command
  search, autosave, and a Quiet / Chromatic skin independent from the launcher;
  see `docs/SETTINGS.md`).
  Its catalog indexes localized labels, summaries/details, keywords, current
  values, and live plugin manifest/setting metadata; result jumps focus the
  exact row. The confirm dialog owns a focus trap with inert background, all
  shared switches/radios expose accessible names and selected state, and
  `setLocale()` synchronizes `documentElement.lang`.
- `src/skins/` is the visual runtime shared by both webviews. `skins.json` is
  the single machine-readable source for skin ids, surfaces and accent contrast
  anchors; Rust embeds it with `include_str!` and derives DWM/detached-window
  colors from the same values. Each window's `runtime.ts` writes its own
  `data-skin` and `--surface`: the launcher family uses `appearance.skin`, while
  settings uses `appearance.settings_skin`. `accent.ts` owns `data-accent`, the
  five `--ui-accent*` tiers and `--ui-focus-ring`; it derives against that
  window's skin. Both run before `render()` from `__LUME_CONFIG__` and recompute
  on resolved light/dark changes. The settings surface may mix the custom accent
  into its own canvas/rail/panel/control tokens; the launcher outer surface
  never receives that tint.
- The accent palette's first preset is the only skin-dependent swatch and
  follows the settings-window skin: Quiet leads with Aqua, Chromatic with its
  original `#ac8e97` (whose dark default is Aqua). The picker shows
  `appearance.accent_custom` — the remembered color, written together with the
  accent on commit — or pure white while it is empty; the 默认 swatch reads that
  skin's native accent metadata, so it stays the skin default instead of
  following the accent in use.
  The
  satellite preview is its own entry (`src/preview.tsx`) owned by the core
`PreviewHost` (`src/launcher/previewHost.ts`), not a plugin contribution. Its compact header
  names the current file/content type and owns the in-window `close_preview`
  action; the window itself stays non-activating.
- Each keystroke invokes the active page's search command and drops stale
  responses via a monotonic request id (`searchToken` / `nextSearchToken`).
- **Navigate (home)** — empty query shows the bars (最近使用 above 已固定
  above the 推荐使用 plugin-context section above plugin bars above the
  Explorer bar), each a titled, expandable grid
  of app boxes sized like the results grid; typing shows the results grid
  with plugin-appended rows (mode keywords / features / providers) split
  below the normal results under a 推荐使用 divider. ↑/↓ cycle the
  bars on the empty main menu, ←/→ move within the active bar; on a query
  the arrows walk the one linear grid across the divider; mouse hover
  selects, click launches. Plain app rows expose pin / launch / open location
  / (recent: remove-from-recent) / admin; plugin synthetic rows (`enter`,
  `drill`, feature, mode keyword) expose activation only, and Rust rejects
  internal `lume-*` schemes from the pin store.
- **Clipboard** renders a virtualized list (~30 DOM rows) with category tabs,
  multi-select merge paste and delete-with-undo. Row height comes from
  `clipboardRowHeight(skin, presenterId)`; the Presenter reports it through
  `viewport.request`, and spacer/windowing/scroll math follows that value.
- All pages support hover-select and click-activate; the search input is
  re-focused every time the window is shown.
- `Enter` launches an app or pastes a clipboard entry after the backend
  reports success (Shift+Enter = admin launch); a failed launch / paste keeps
  the launcher open with a toast. Clipboard paste hides from Rust only when a
  target window exists; the copy-only fallback returns a structured outcome
  and keeps the launcher up. `Esc` layers: close menu → page `onEscape` (pop a
  drill level / clear multi-select) → close satellite preview → hide.
- Keyboard focus: a bare `Tab` switch key only toggles modes while the search
  box is focused; elsewhere `Tab` / `Shift+Tab` traverse natively and
  `Ctrl+Tab` switches modes. `F6` / `Shift+F6` cycles search box → mode bar →
  active page control → settings gear, `Ctrl+,` opens settings, and
  `Shift+F10` / the Menu key opens the context menu for the selected bar tile
  or result row. The `.results` shell can receive focus from a blank-area click
  or as the `F6` fallback on a page without controls, but it paints no
  container-wide focus ring; the selected row/tile border carries the
  page-level cue. Command-button clicks hand focus back to the search box;
  inputs and modal scopes keep their own focus.
- **i18n**: all user-facing strings go through `t()` from `src/i18n.ts`. English
  is the compiled fallback; the current Chinese bundle is loaded on demand before
  the first render rather than embedding all locale tables in every entry.
  (en / zh-CN / zh-TW), keyed off the system language. A numeric `count` also
  selects the `_one` / `_other` variant — English needs it ("1 item" /
  "2 items"), the Chinese bundles carry one form in both slots. Text Rust has to
  render without the webview (tray menu, hotkey-conflict notification,
  services.msc / Task Scheduler descriptions, settings / preview window titles)
  is read from the same `languages/*.json` files through `i18n::text` with the
  compiled fallbacks in `texts.rs`; `node scripts/check_i18n.mjs` keeps the
  three bundles, the key references and the settings-search keyword pairs in
  step.

## State & lifecycle

- The main webview starts hidden with `focused(false)`; settings, preview and
  the shared plugin-logic host are absent until first use. Every show/hide pairs
  the native HWND transition with WebView controller visibility and memory
  residency. The launcher is first shown by the hotkey, focused explicitly on
  every show, and auto-hides on focus loss (`lib.rs` window-event handler).
- Hidden launcher mode pages stop through the central `launcher-hidden` event.
  The evictable live-host budget is four. Inactive visited hosts are snapshotted and
  unmounted after two hidden minutes; a selected non-home plugin page is also
  cold-reclaimed after fifteen hidden minutes. Home, detached windows,
  `keep_session` pages and explicit user retention overrides stay exempt. A
  loaded plugin logic iframe with no active page, detached window or pending RPC
  is unloaded after five idle minutes; the empty shared host then closes after
  its short grace period.
- 会话续存：隐藏 / 呼出 / 模式切换都不再清 query / results / mode，
  热键重呼出恢复上次页面与状态；只有「打开首页条目后的下次呼出」（首次打开条目后的下次呼出）
  与闲置重置清空查询并回导航页。搜索框默认是一份全局共享值（共享单值，
  见上），设置「各模式使用独立搜索词」开启后恢复逐页独立。
- `AppIndex` mirrors the `cache.rs` SQLite DBs; it is refreshed at startup and
  hourly (differential), so search reflects new files without a manual rescan.
- `ActiveHotkey` is set at startup from registering the configured toggle
  combo (empty when another app owns it) and read by the frontend on mount.
- `ClipboardState` (SQLite connection + sequence tracking) is initialized
  before any webview is created; recent/pins state follows the same startup
  order. Its message-only clipboard listener shares the state through
  `AppHandle`; registration failure falls back to a bounded low-frequency
  sequence check.

## Tests

Rust unit tests cover the app fuzzy/pinyin scorer, clipboard store and
migrations, settings defaults/migrations, plugin manifests/permissions/storage,
`.lupx` installation and signatures, pipe/protocol helpers, filesystem
indexing primitives, automation and agent helpers. Run with `cargo test` — see
`docs/TESTING.md`. Frontend behavior and the Windows/WebView2 integration
surface are verified with the `scripts/cdp_*.mjs` probes.

## Future

Planned work is tracked in `docs/ROADMAP.md`: plugin ecosystem follow-ups
(market, drag-package install, browser/selection capture), file-search
hardening, workflow/OCR/AI commands and cross-platform exploration.
The page-model / replaceable-presenter design history is archived in
`docs/History/PAGE_MODEL_PRESENTER.md`.
