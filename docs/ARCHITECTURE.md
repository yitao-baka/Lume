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
  │                staging swap, private-file preservation, ed25519 signatures
  ├─ plugin_logic.rs / plugin_devwatch.rs — logic-host protocol and dev reload
  ├─ apps.rs     — file search from the index caches, fuzzy + pinyin scoring,
  │                ShellExecuteW launch (+ records recent-opens)
  ├─ cache.rs    — System32 / user / icons SQLite index caches
  ├─ clipboard.rs— clipboard capture → SQLite, search, copy back, pin/delete
  ├─ icons.rs    — IShellItemImageFactory icon extraction + in-memory cache
  ├─ pins.rs     — 已固定 bar (SQLite `pinned_apps`, WAL connection)
  ├─ recent.rs   — 最近使用 bar (SQLite `recent_apps`, WAL connection)
  ├─ settings.rs — settings.toml / default.toml / backup.toml three-file system
  ├─ tray.rs     — system tray icon, Restart/Exit menu, left-click toggle
  ├─ hotkey.rs   — toggle shortcut: the configured combo (default Alt+Space)
  ├─ svc.rs      — LumeSVC SYSTEM service (SCM + IPC pipe + index dormancy)
  ├─ agent.rs    — elevation-agent client, `\\.\pipe\LumeAgent` server, task
  ├─ input.rs    — synthetic keys (SendInput) + window/process/token probes
  ├─ pipe.rs     — length-prefixed JSON pipe client (svc + agent share it)
  ├─ everything.rs— Everything voidtools WM_COPYDATA IPC client (no DLL)
  ├─ filesearch.rs— unified file-search facade (Everything / LumeSVC backends)
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
Owns the single frameless transparent webview window (label `main`, see
`tauri.conf.json`). `show()` applies the configured width and placement
policy: the 窗口位置 setting (center / corners / follow-mouse / custom)
only positions the window on its FIRST appearance in a run — later shows
inherit the spot the launcher was last closed at, and a manual drag stops
automatic anchoring altogether (session-scoped `PlacementState`,
docs/ROADMAP_HISTORY.md); `follow-mouse` is the exception and re-centers on the cursor
on every show.
Called by the frontend (Esc) and by `hotkey.rs`. The launcher also **auto-hides
on focus loss**: `lib.rs` registers a `WindowEvent::Focused(false)` handler
that hides the window, so clicking elsewhere dismisses it. Elevated launches
(`launch_app` / `open_terminal_in_folder` with `runas`) arm a temporary
blur-hide suppression while the UAC prompt owns the foreground, so cancelling
UAC leaves the launcher visible with its error toast.

Window frame: the launcher panel is opaque (src/App.css `.launcher`, solid
`--surface`) — the window has **no Acrylic backdrop** (deliberately removed;
see docs/ROADMAP_HISTORY.md). DWM's visible frame border strip (the ~2px non-client ring
around the client area) is **painted in that same panel color** —
`set_panel_frame_border()` → `DWMWA_BORDER_COLOR` with the `--surface` value
for the current 颜色模式 (re-painted from `apply_settings` and on
`WindowEvent::ThemeChanged` in system mode); left at the default or
`DWMWA_COLOR_NONE` the strip shows the desktop through the transparent window
as a light-gray ring. Panel, strip and the default plugin-page canvas then
read as one uniform surface, corners included (Win11 rounding is DWM's).
`clear_dwm_border()` (COLOR_NONE) is what the settings/preview/detached-plugin
windows use. `DwmGetWindowAttribute(DWMWA_VISIBLE_FRAME_BORDER_THICKNESS)`
reports the strip; see docs/ROADMAP_HISTORY.md for the pixel measurements.

### `apps.rs`
- **Index**: `AppIndex` state holds in-memory mirrors of the System32 and
  Desktop/user entries loaded from the `cache.rs` SQLite DBs (see Data
  management), refreshed at startup and hourly (rule: never block startup).
  Manual `refresh_index` is an async command using `spawn_blocking`; it
  resolves only after the scan/cache write and returns the real error, so the
  settings button cannot report success at task start.
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

### `filesearch.rs` / `everything.rs` / `usnidx.rs`
The whole-drive file-search stack (docs/ROADMAP_HISTORY.md), surfaced as one command —
`file_search(query)` (async: sync commands run on the main thread and the
backends have timeouts).

- **Backend selection** (`filesearch.rs`): a running Everything first (its
  index is live and free), then the LumeSVC pipe, else `unavailable`. A failed
  backend enters a process-wide 10s cooldown so per-keystroke typing never
  pays repeated timeouts. Returns `{backend, status, entries}` in `AppEntry`
  shape.
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
- **Failure honesty**: an injection reports the events `SendInput` actually
  inserted (`sent`), so zero is a real, visible failure — `uipi`/`blocked`/
  `not_elevated`/`needs_agent` instead of a silent no-op. See docs/ROADMAP_HISTORY.md for the
  full reason set and the known ceiling (kernel-level anti-cheat filtering is
  out of reach).

### `icons.rs`
- **Extraction**: `extract_icon_png` calls `IShellItemImageFactory` (via
  `SHCreateItemFromParsingName`) to get a 64px icon for a `.lnk`, then
  converts the `HBITMAP` to PNG (`GetDIBits` → BGRA → RGBA → PNG).
- **Cache**: `IconCache` is an in-memory `path → data URI` map — **never
  written to SQL**. The frontend keeps a parallel `Map` and only requests
  icons it hasn't seen.
- **Loading**: the `get_app_icons` command runs extraction on a blocking
  thread (async command) and returns cached hits immediately; the frontend
  loads icons in batches of 20. Missing/failed artwork uses the shared
  `unknow_universal.svg` fallback until a real icon arrives.

### `tray.rs`
Creates the system tray icon (`TrayIconBuilder`). Left-click toggles the
launcher (reuses `window::toggle_launcher`); the right-click menu has Restart
(`AppHandle::request_restart`) and Exit (`AppHandle::exit`). Menu labels follow
`appearance.language` (`zh-CN` / `zh-TW` / `en`); `"system"` falls back to
`GetUserDefaultUILanguage`, including the Traditional Chinese sublanguage. The
menu is rebuilt on every settings apply so a language change is immediate.

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
different combo; the user frees the combo or records a free one in
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
  **Async on purpose**: Tauri runs *sync* commands on the main (UI) thread —
  a full-history load blocked every other IPC for seconds in a debug build,
  stalling the frontend's window resizes (the loading gate's collapse among
  them). Same rationale as `get_file_thumb` / `get_file_bytes` /
  `get_video_thumb`; anything that reads files, decodes images or queries a
  big table belongs off the main thread (see docs/ROADMAP_HISTORY.md).
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

The settings window autosaves a **minimal patch** (`save_settings_patch`): only
fields that differ from the last server-confirmed baseline. A single-writer
frontend queue debounces text and sliders, serializes writes, and merges later
edits before the next patch. The Rust side merges that patch into the current
`SettingsState` under its lock, so autosave cannot roll back plugin
enable/disable, plugin geometry / theme preferences, last-page bookmarks or
remember-checks writes made in the meantime. A failed write restores the
affected controls plus the settings-window skin and accent DOM to the confirmed
snapshot, then exposes retry in the footer. Import,
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
  top and the active page widget (`ModeInstance.View`) spliced below it,
  plus the shared overlays (toast, context menu).
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
- **Bridge host-form constant（docs/ROADMAP_HISTORY.md）**：`injectBridge` /
  `injectTitlebarBridge` pin a synchronous `lume.env.form` on every plugin
  frame — `"launcher"` (inside the launcher window) or `"window"` (a
  detached plugin window; logic frames are always `"launcher"`). Pages must
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
  `res/icons/unknow_universal.svg`). The strip is capped at about three named
  pills (`320px`), or about three icons (`104px`) in the icon-only
  presentation. Below 640px it also falls back to icons-only so labels cannot
  consume the search input; if the icons still overflow, the strip clips
  without edge controls, wheel/trackpad scrolling remains available, and the
  active pill is scrolled into view on mode changes; the input swaps to the
  short localized placeholder below 160px.
- **Navigate result artwork** — `NavigateView` renders extracted icons without
  a mask by default and uses `unknow_universal.svg` when no icon exists.
  `appearance.round_app_icons` (default off) toggles the launcher's
  `circle-app-icons` class; only that class applies the `50%` circular crop.
- **拼接几何 (the seam)**: the surface is one continuous panel — literally
  one color: the panel fill, the DWM frame strip and the default plugin-page
  canvas are all `--surface` (see Surface in docs/UI_GUIDELINES.md; do not
  give `.launcher` a border, CSS radius or translucent fill). The search row
  carries no bottom border and `.results` has no inset, so the page area
  starts exactly at the search row's bottom edge and runs to the panel edge
  on the left, right and bottom. Each page brings its own inner padding
  (`.result-grid` 8px, bar grids 10px, `.plugin-list` 10px, `.clip-list`
  `0 6px 4px`) — a page that wants an inset owns it. `WINDOW_PAD`
  (`src/launcher/types.ts`) is the fit-height slop for this geometry: changing
  one without the other leaves an empty strip under the content or clips the
  page. Two states have **no page area at all** — the window is the search row
  alone: an empty home menu (no bar sections) and a page that is still
  loading (`ModeInstance.ready`; the pill carries the spinner meanwhile).
- **Page canvas (disk plugin pages)**: a mode page is an opaque-origin iframe.
  With a dark `color-scheme` — every mirrored-palette plugin sets one —
  Chromium paints an **opaque #121212 canvas** for a transparent root
  background, and host-painted backgrounds are invisible under such a frame
  (`background` on the iframe element does nothing); the splice then shows a
  near-black page inside the panel. The host therefore injects the page's
  default canvas in `injectBridge` — the same `--surface` the panel itself
  paints, so the page is literally the panel at the splice:
  `html{background:var(--lume-page-bg,<the theme's --surface>)}`, and the
  bridge keeps `--lume-page-bg` in step with theme flips (the `theme` event).
  A plugin that paints its own `html`/`body` background still wins (its rule
  comes later in the document).
  Both the default and the pushed value are the **plugin's effective** mode:
  since docs/ROADMAP_HISTORY.md a plugin can pin its own light/dark through
  `lume.theme.set` (`settings.plugins.color_modes`), and then only that
  plugin's canvas, `theme` events, detached-window chrome and taskbar icon
  follow the override — the launcher keeps its own `data-theme`, and other
  plugins' pages are untouched (`src/plugins/themePrefs.ts`).
- `src/plugins/` — **every page below the search box is a plugin**
  implementing the `ModeInstance` page contract (`src/plugins/types.ts`):
  - `navigate/` — the built-in **home page** (id `"apps"`, `home: true`, the
    only `heightPolicy: "fit"` page): `store.ts` (the bars 栏目 registry —
    最近使用 / 已固定 / 推荐使用 / plugin bars / Explorer — plus app actions
    and the continuous bar-grid navigation + pinned drag reorder), `search.ts` (the
    merged search pipeline: native index → 全局关键字 rows → declarative
    feature rows → file-search hits → plugin providers; provider drill-down;
    the summon-scoped file-drop / clipboard-image / foreground-window feature
    rows), `NavigateView.tsx` (bars + results grid), `index.tsx`
    (`createNavigatePlugin(services, host)`).
  - `clipboard/` — the clipboard-history page (store + view + keys + search
    + the settings slice it renders live).
  - `preview/` — a service contribution (satellite-preview routing shared by
    every page that exposes previewable rows).
  - `registry.ts` + `types.ts` — the registry all plugins plug into
    (`definePlugin` for built-ins, disk discovery + `createDiskModeInstance`
    for on-disk plugins); the Rust side discovers manifests
    (`<base>/plugins/<id>/plugin.toml`) in `plugins.rs` and carries the
    enabled set in `settings.plugins.disabled`. Adding a launcher page no
    longer touches the shell. The registry also owns the mode-pill data:
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
    virtual-list viewport measurement. Two special cases: a **loading** page
    (`ModeInstance.ready` false) collapses the window to the search row alone,
    and an **empty fit page** (no bar sections at all) is that same search-row
    state — no reserved "empty-state" strip and no `WINDOW_PAD` below a page
    that has no content.
  - `menu.ts` — `buildMenuItems()`: right-click menu construction for
    app / folder / clipboard targets, over the narrow structural
    `NavMenuActions` / `ClipMenuActions` interfaces each page supplies via
    `ModeInstance.menuActions()`. The composition root measures the rendered
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
- The settings window reuses the same build via the window label
  (`src/settings/` — grouped navigation, shared semantic rows, command search,
  autosave, and the Quiet / Chromatic skin runtime; see `docs/SETTINGS.md`).
  Its catalog indexes localized labels, summaries/details, keywords, current
  values, and live plugin manifest/setting metadata; result jumps focus the
  exact row. The confirm dialog owns a focus trap with inert background, all
  shared switches/radios expose accessible names and selected state, and
  `setLocale()` synchronizes `documentElement.lang`. `src/settings/skin.ts` is
  the single writer for `data-settings-skin`, while
  `src/settings/accent.ts` is the single writer for `data-settings-accent` and
  the three `--settings-user-*` variables. Both are applied from the injected
  config before `render()`; the launcher never sets either property. The accent
  module normalizes untrusted input, derives separate 3:1 structure and 4.5:1
  text tokens from conservative mode anchors, and recomputes them when
  `themeMode()` flips. `skins/accent.css` overrides the five tinted semantic
  surfaces under `html[data-settings-accent]` for both `.settings` and the
  settings document's `body.settings-window`, so Portal-rendered help surfaces
  inherit the same tokens. An empty value removes the attribute and inline
  variables so the skin's native tokens and geometry remain unchanged.
  The
  satellite preview is its own entry (`src/preview.tsx`). Its compact header
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
  selects, click launches. Context menus offer pin / launch / open location
  / (recent: remove-from-recent) / admin.
- **Clipboard** renders a virtualized list (fixed row height, ~30 DOM rows)
  with category tabs, multi-select merge paste and delete-with-undo.
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
- **i18n**: all user-facing strings go through `t()` from `src/i18n.ts`
  (en / zh-CN / zh-TW), keyed off the system language.

## State & lifecycle

- Window starts hidden (`"visible": false`), first shown by the hotkey, and
  auto-hides on focus loss (`lib.rs` window-event handler).
- 会话续存：隐藏 / 呼出 / 模式切换都不再清 query / results / mode，
  热键重呼出恢复上次页面与状态；只有「打开首页条目后的下次呼出」（首次打开条目后的下次呼出）
  与闲置重置清空查询并回导航页。搜索框默认是一份全局共享值（共享单值，
  见上），设置「各模式使用独立搜索词」开启后恢复逐页独立。
- `AppIndex` mirrors the `cache.rs` SQLite DBs; it is refreshed at startup and
  hourly (differential), so search reflects new files without a manual rescan.
- `ActiveHotkey` is set at startup from registering the configured toggle
  combo (empty when another app owns it) and read by the frontend on mount.
- `ClipboardState` (SQLite connection + sequence tracking) is managed at
  startup; the listener thread shares it through `AppHandle`.

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
