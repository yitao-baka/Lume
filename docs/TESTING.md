# Testing

How to verify Lume.

## Automated checks

Rust unit tests and frontend compile checks are the baseline:

```bash
pnpm install
pnpm exec tsc --noEmit
pnpm run build
cd src-tauri
cargo check
cargo test
```

Coverage includes the app fuzzy/pinyin scorer, clipboard store and migrations,
settings defaults/migrations, plugin manifests/permissions/storage, `.lupx`
inspection/installation/signatures, pipe/protocol helpers, USN index
primitives, automation helpers and the elevation-agent boundary. The Rust
suite intentionally does not register a service, show UAC, touch the real
registry or perform a real injection.

The Windows/WebView2 behavior is verified with `scripts/cdp_*.mjs`. Those
scripts launch an already built exe, so rebuild first:

```bash
pnpm run tauri build --debug --no-bundle
node scripts/cdp_plugin_verify.mjs
```

`tauri build` embeds `dist/` into the binary. A bare `cargo build` / `cargo run`
is a dev build that loads `http://localhost:1420`; it is not suitable for CDP
smoke tests unless the vite server is also running.

## Manual verification

Run the app:

```bash
pnpm run tauri dev                          # dev: vite + Tauri console
pnpm run tauri build --debug --no-bundle    # embedded debug exe for CDP
pnpm run tauri build --no-bundle            # standalone release exe
```

The standalone release exe (`src-tauri/target/release/lume.exe`) embeds the
frontend, shows no console window and does not need `localhost:1420` running —
that is what to double-click / distribute. The debug exe from
`tauri build --debug --no-bundle` also embeds the frontend and carries a console;
use it for CDP and manual debugging. A plain `cargo build` debug binary loads the
dev URL instead.

### Plugin file drop / pin reorder

1. **Real OS file drag** — the automated script simulates the `tauri://drag-drop`
   event, but the OLE drop target itself (where the real paths come from) can
   only be exercised by hand: drag a `.md` file from Explorer onto the launcher
   (summon it with the hotkey while holding the drag) — a
   「文件处理器：处理 N 个文件」 row should appear in the 「推荐使用」 bar
   (`files-img-demo` installed), with 最近使用 / 已固定 still rendered beside it.
2. **Pin reorder still works** — press a pinned box, move past ~6px, drop on
   another slot: the order persists (`reorder_pins`). With the Tauri drag-drop
   handler now enabled, in-page HTML5 drag is unavailable — reordering is
   pointer-event based, so a plain click must still launch the app.

### Launcher basics

1. **Shortcut registers** — the console logs the configured combo, e.g.
   `[hotkey] registered Alt+Space`. If another app already owns it (uTools,
   PowerToys Run), nothing is registered and the log says
   `[hotkey] Alt+Space unavailable: …` — no fallback: free the combo, or
   record a free one in 设置 → 快捷键 (tray → 设置 opens it).
2. **Toggle** — press the registered combo: the launcher appears centered with
   the search input focused; it should feel instant (< 50ms target).
3. **Auto-hide** — click any other window: the launcher dismisses itself.
4. **Navigate menu** — on show, the empty query renders the
   最近使用 / 已固定 / 推荐使用 (plugin context rows, when offered) / plugin /
   Explorer bars, not an all-apps browse grid.
   Type to switch to the results grid. Icons load progressively; keyboard and
   mouse selection both launch on click / `Enter`.
5. **Search** — type a fragment (e.g. `code`, `fire`, `note`); matching apps
   stay in the grid, best-ranked first. Plugin-appended rows (mode keywords /
   features / providers) collect under the 推荐使用 divider below the normal
   results; ↑/↓/Enter walk both blocks as one linear grid.
6. **Pinned bar** — right-click a selected app and choose 「固定」to pin it to
   the bar above the grid (a letter tile appears first, then its icon);
   「取消固定」unpins. `↑` from the grid's first row enters the bar,
   `←`/`→` move within it, `↓` returns, `Enter` launches a bar item. The bar
   shows only on the empty query; it survives a restart.
7. **Pinyin search** — on a system with Chinese-named apps, typing the full
   pinyin (`kuake`) or initials (`kk`) finds 「夸克」; `wanmei` finds
   「完美解码」. English queries still match by name.
8. **Tray** — the Lume icon sits in the system tray. Left-click toggles the
   launcher; right-click shows 「重启」/「关闭」(or Restart / Exit on English
   systems). 「关闭」exits the app; 「重启」starts a fresh instance.
9. **Esc** — pressing `Esc` hides without launching.
10. **Blocked shortcuts** — Ctrl+F, Ctrl+P, Ctrl+R, F12 and Alt+←/→ do nothing
    (no Find bar, no print, no reload, no DevTools). Ctrl+C/V/X/A still work
    for editing the search box, and the launcher's own keys (Tab, arrows,
    Enter, Esc, Del) are unaffected.
11. **Auto-sizing** — the window height fits the results: the full app grid
    caps at 520px (scrolls internally), a few results shrink it (e.g. "no" →
    ~300px), and it stays anchored (centered / cornered per the preset until
    you drag it — see 13); the clipboard list sizes to its items.
12. **Fresh state** — re-showing the launcher clears the previous query and
    returns to the Navigate grid.
13. **Position memory** — drag the launcher somewhere, then Esc + summon
    again: it reopens at the dragged spot instead of jumping back to the
    窗口位置 preset, and typing / clearing the query (content resizes) does
    not move it either. Picking another preset in 设置 → 导航页 positions it
    immediately and takes over again; 跟随鼠标 re-centers on the cursor on
    EVERY summon. Automated:
    `node scripts/cdp_window_position_verify.mjs`.

### Clipboard mode

1. **Capture** — copy a few pieces of text (e.g. a URL, a code snippet). Wait
   ~1s; the listener polls the clipboard every 250 ms.
2. **Browse** — show the launcher, press `Tab` (or click the Clipboard pill):
   the recent history appears even with an empty query, newest first.
3. **Search** — type a fragment; matching history entries are filtered
   (case-insensitive substring).
4. **Copy back** — `Enter` on an entry writes it to the system clipboard and
   hides the launcher. Paste somewhere to confirm.
5. **Recency** — re-copying an older entry moves it to the top without
   duplicating.
6. **Pin** — right-click a selected entry and choose 「固定」: it jumps to the
   top and a pin badge appears. Pinned entries survive pruning. 「取消固定」
   unpins.
7. **Delete** — `Del` on a selected entry, or the trash button on its row,
   removes it from history. Hovering a row selects it; clicking a row copies
   it back.
8. **Images** — copy an image (e.g. a screenshot via Win+Shift+S): it appears
   as a thumbnail tile labelled `Image · <time>`. `Enter` pastes the original
   image back.
9. **Migration** — after upgrading from v0.2, previously copied text is
   still present (schema rebuilt in place).
10. **Persistence** — restart the app; text and image history survive
    (`lume.db` in the app data dir).
11. **No self-echo** — the copy-back in step 4 is not re-inserted as a new
    entry (deduped against the most recent capture).
12. **i18n** — the UI language follows the system locale (Simplified Chinese,
    Traditional Chinese, English). On a zh-CN system the pills read "导航 /
    剪贴板" and the footer "Del 删除"; on English systems the
    original English strings appear.

### Settings window (设置迭代)

1. **Entry** — click the gear button in the launcher's search row, or
   「设置」 in the tray right-click menu: the settings window opens.
2. **Layout** — the left sidebar shows 外观 / 导航页 / 剪贴板 / 快捷键 /
   搜索 / 系统 / 自动化 / 插件 / 关于; clicking swaps the right pane.
   「保存并应用」 is disabled until a change is made.
3. **Save** — 「保存并应用」 writes `settings.toml`, applies immediately and
   closes the window. The previous file is copied to `backup.toml` first.
4. **Settings files** — live under the writable base dir: portable is the exe
   dir (dev: `src-tauri/target/debug/`), installed (exe under `Program Files`)
   is `%LOCALAPPDATA%\Lume\`; `settings/settings.toml` is created from
   `default.toml` on first run; `backup.toml` appears after the first
   Save/Apply/Import.
5. **DB migration** — `lume.db` lives in `<base>/data/` (portable:
   `<exe_dir>/data/`; installed: `%LOCALAPPDATA%\Lume\data\`); clipboard
   history survives the move from the old app-data location (auto-copied once).
6. **Idle reset (docs/ROADMAP_HISTORY.md #46)** — 设置 → 导航页：「闲置重置」默认开、阈值
   30 分钟。把启动器呼出再隐藏，超过阈值后下次呼出应回导航页、搜索框为空，
   未豁免插件页冷启动；清单 `keep_session = true` 或 设置 → 插件 打开豁免的
   插件应保留查询与页面状态（但落地仍是导航页）；总开关关闭后不重置。
   自动验证：`node scripts/cdp_idle_reset_verify.mjs`（需先构建 debug exe）。

### Service / run-as-admin / auto-start (Program Files iteration)

> Registering/unregistering the service pops a UAC prompt, so those steps are
> manual only. `cargo test` never touches the real service or registry.

1. **Data relocation** — copy the whole release folder into
   `C:\Program Files\Lume\`, first run: `%LOCALAPPDATA%\Lume\{data,settings,
   languages}` are created with content (the Program Files copies stay, copy-only).
   The portable folder (anywhere outside Program Files) still reads/writes next
   to the exe.
2. **Register service** — 设置→系统→「注册服务」→ accept UAC → `sc query
   LumeSVC` shows RUNNING with start type AUTO; the button flips to
   「卸载服务」 and the status line reads 服务运行中.
   `reg query HKLM\Software\Lume\DataDir` points at `%LOCALAPPDATA%\Lume`.
3. **UAC cancel** — click 注册服务 then choose 否 in the prompt → the UI shows
   操作已取消 and the state is unchanged.
4. **File-search service** — with the service running, query a file that is
   not in the local index. With Everything stopped, Lume should answer through
   `\\.\pipe\LumeSVC` (the self-hosted USN/MFT backend) and return the path.
   The launcher's own cache refresh remains independent of the service.
5. **Portable / no service** — without the service, while Lume runs, change a
   Desktop file and it appears after ~one interval (in-process loop). Behavior
   is identical with or without the service registered.
6. **Run as administrator** — right-click a grid or pinned-bar app →
   「以管理员身份启动」→ UAC → the target runs elevated (verify with `whoami`
   in a launched cmd.exe). Dismissing the UAC prompt neither crashes nor hides
   the launcher. Note the `.lnk` + runas behavior for each target type.
7. **Auto-start** — enable 「开机自启动」 → `reg query
   HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v Lume` shows the quoted
   exe path; after a reboot/logon Lume starts by itself. Disabling deletes the
   value.
8. **Dev loopback** — `lume-svc.exe --foreground` starts the service in a
   console (Ctrl+C quits) and exposes `\\.\pipe\LumeSVC` for `search`/`status`.
9. **Bundle** — `pnpm run package:zip` runs the release Tauri build and
   assembles `lume.exe` + `lume-svc.exe` + `lume-agent.exe` + `languages/` +
   `res/icons/` into the portable zip under
   `src-tauri/target/release/bundle/zip/`.

### Elevation agent (docs/ROADMAP_HISTORY.md #22)

> Registering/unregistering the agent pops a UAC prompt, so those steps are
> manual only. `cargo test` never registers the task.
> Two CDP scripts cover everything that does **not** need UAC:
> `node scripts/cdp_agent_smoke.mjs` (14 assertions: the settings UI, the
> status command, defaults) and `node scripts/cdp_agent_verify.mjs` (9
> assertions: it starts `lume-agent.exe --serve` unelevated itself and proves a
> real injection lands, by sending Alt+F4 to Notepad and checking it closed).
> The steps below are the ones that need a human at the UAC prompt.

1. **Register** — 设置→系统→「注册代理」→ accept UAC → the status line switches
   from 代理未注册 to 代理已注册，未运行 and the button to 「卸载代理」;
   `schtasks /query /tn Lume\LumeAgent` shows the task and its state is Ready.
2. **UAC cancel** — click 注册代理 then choose 否 → the UI shows 操作已取消 and
   the state is unchanged (still 代理未注册).
3. **On-demand start** — with the task registered, configure an auto action for a
   program, launch that program: the helper starts by itself (no prompt, no
   window), the log line reads `… via the agent (4 events)`, and the rule's
   shortcut arrives. Leave it alone ~1 minute: `lume-agent.exe` exits by itself
   (idle timeout) and the next injection starts it again on demand.
4. **Resident mode** — turn on 登录后常驻代理, then log off/on (or trigger the
   task): the helper is already running and `agent_status` reports
   `running:true`. Turn it off and it exits at the next idle check.
5. **An elevated target — the actual point of the feature** — launch the target
   as administrator (右键 → 以管理员身份运行) and press 测试 on its rule: the toast
   reads 已测试… and the key really arrives in the elevated window.
6. **The contrast case** — turn 使用提权代理 off and press 测试 again: with the
   target elevated it now reports 「…以管理员权限运行 —— 请开启提权代理才能送达」
   instead of claiming success, and with logging on the rule logs `needs_agent`.
7. **The ACL holds** — run the ignored live test while the helper is up:
   `cargo test -- --ignored live_agent`. It must answer `status` (proving the
   per-user DACL admits this user) and **refuse** the test harness with
   `denied_client` (proving only the sibling `lume.exe` may drive it).
8. **Unregister** — 「卸载代理」→ UAC → the task disappears
   (`schtasks /query /tn Lume\LumeAgent` → not found), any running helper quits,
   and the status line returns to 代理未注册.

### Environment sync (envwatch)

> Watcher logs `[envwatch] ...` to the console (dev). `cargo test` covers the
> PATH merge / case-insensitive registry-name logic; the Win32 watcher itself
> is manual-only.

1. **Dialog path** — with Lume running (dev console visible), open 设置→环境变量
   (Environment Variables dialog) and append a new entry to the user `Path`.
   Apply → the console logs `[envwatch] environment refreshed from registry`.
   Launch `cmd.exe` from Lume: `echo %PATH%` shows the new entry. The change
   also lands in the launcher process itself — `GetEnvironmentVariable` in the
   Rust core returns the new value without a restart.
2. **setx path** — in a terminal run `setx LUME_TEST 1` (no broadcast, registry
   notify path) → the same refresh log appears within a moment; a freshly
   launched `cmd.exe` from Lume sees `LUME_TEST=1`.
3. **Startup merge** — launch Lume with a deliberately incomplete `PATH`
   (user scope only): the startup refresh log appears, and a `cmd.exe` launched
   from Lume has both the machine and user PATH segments — including
   `C:\Windows\System32`.
4. **Already-running processes untouched** — an `cmd.exe` opened *before* the
   change keeps its old PATH until it is relaunched.
5. **Idle cost** — with the watcher armed, the `envwatch` thread's CPU time
   stays flat while the environment is untouched (no polling wakeups; thread
   suspended in `MsgWaitForMultipleObjectsEx`).

### Recent + pinned bars (docs/ROADMAP_HISTORY.md #10)

> `cargo test` covers the recent store (upsert / dedupe / pruning); the UI is
> manual-only. Use either `pnpm run tauri dev` or an embedded debug/release
> build.

1. **Recording** — launch a few apps/files from Lume (search, grid, context
   menu, 管理员). Re-open the main menu → 「最近使用」 shows them newest-first.
   Launch the same app again → it bumps to the front (dedupe by path).
2. **One row + 展开** — with >1 row of recents, the collapsed bar shows exactly
   one row and the header shows 展开. Click 展开 → all rows appear, the label
   flips to 收起; click again → one row. Hide the launcher and re-show → the bar
   is collapsed again (expand state is not persisted).
3. **展开 hidden when ≤ 1 row** — pin/launch so a bar fits in one row → no 展开
   button. A bar with 0 items (e.g. 显示最近使用 off, or no pins) hides entirely.
4. **Removed browse grid** — empty query shows only the two bars (no all-apps
   grid); typing a query shows the results grid; deleting back to empty returns
   to the bars.
5. **Keyboard** — on the empty main menu, ↑/↓ cycle 最近使用 ↔ 已固定, ←/→ move
   within the active bar, Enter launches. Typing switches to grid navigation.
6. **Settings** — 界面: 「显示最近使用」 off hides the bar (recording continues,
   so re-enabling shows history); 「最近使用条数」 10/20/30 caps stored + shown
   (lowering prunes immediately); two placeholder fields override the apps /
   clipboard search-box placeholders (empty = default text). Old `settings.toml`
   loads unchanged (`#[serde(default)]`).
7. **Context menu** — right-click a recent item → pin/launch/reveal /
   「从最近使用中删除」/ 以管理员身份启动 (remove-from-recent sits just before
   the admin item); pin moves it into 「已固定」; remove-from-recent (or `Del` on
   a selected recent entry) drops it from the list without touching the file.

### Plugin platform

> Rebuild before running these probes:
> `pnpm run tauri build --debug --no-bundle`. The scripts kill stale Lume
> processes, copy fixtures into `src-tauri/target/debug/plugins/`, launch the
> exe with a CDP port and print `PASS` / `FAIL`; any failure exits non-zero.

1. **Core plugin contract** — `node scripts/cdp_plugin_verify.mjs` (provider
   rows + sandboxed mode page + plugin pane), then
   `node scripts/cdp_plugin_v2_verify.mjs` for the expanded host API. The
   feature series (file drop / clipboard image / list template / tile reorder)
   plus the static ctx-surface parity checks (logic-frame ctx ≡ view bridge ≡
   rpc.ts cases) run as `node scripts/cdp_p2b_verify.mjs`; it enables its two
   fixture plugins itself.
2. **Sandbox and permissions** — `node scripts/cdp_sandbox_verify.mjs` proves
   opaque-origin isolation, bridge behavior and Rust-side command whitelisting.
   A plugin that calls an undeclared capability must fail with an explicit
   message.
3. **Logic isolation and circuit breaker** — `node
   scripts/cdp_circuit_verify.mjs`; verify three consecutive hook failures mark
   only that plugin offline, while pure-view modes never accumulate false
   timeouts.
4. **Detached windows & session continuity** — `node scripts/cdp_plugin_window_verify.mjs`,
   `node scripts/cdp_plugin_blank_verify.mjs` and `node scripts/cdp_plugin_state_verify.mjs`
   (fixture `examples/plugins/state-probe`): cover open/focus/state restore/close,
   geometry memory, the empty-`srcdoc` navigation watchdog, keep-alive across
   hide/show and mode switches, detach inheritance incl. the custom snapshot
   layer and a 600ms-late DOM node, enter fan-out to view+titlebar frames,
   user-close re-dock restore, the titlebar frame round-trip and the
   `lume.env.form` host-form constant in all three surfaces (launcher /
   detached view / detached titlebar). The file-search chain has a local
   probe at `test/_snapshot_probe.mjs` (gitignored scratch — other machines should
   exercise it through the file-search example plugin instead); LRU eviction semantics and the
   new-enter-beats-stale-snapshot rule (docs/ROADMAP_HISTORY.md #42) are
   `node scripts/cdp_plugin_lru_verify.mjs` (generates its own filler modes
   and asserts one victim per overflow, a stored snapshot, and that the new
   payload wins on remount). Search-box routing across modes (docs/ROADMAP_HISTORY.md #48) is
   `node scripts/cdp_mode_query_verify.mjs` (with its own keyword fixture):
   the default one shared value follows every mode switch + search, the real
   settings pane toggle restores independent per-mode queries (seeded at the
   moment of the flip), idle reset clears the shared value, keyword-row entry
   consumes it, and a restart proves both the `__LUME_CONFIG__` injection and
   that queries are never persisted. It restores the setting and removes its
   fixture on exit.
5. **Theme override** — `node scripts/cdp_plugin_theme_verify.mjs`; inspect the
   rendered canvas with the 1x1 screenshot sampler, not the sandbox DOM.
6. **Mode-bar hiding, icons-only and result icons** — `node
   scripts/cdp_plugin_mode_bar_verify.mjs`; a `hidden = true` mode renders no
   pill and the switch key skips it (the cycle restarts at home), while its
   Navigate rows (keyword / feature) and provider results without their own
   `icon` default to the plugin's manifest icon, and provider icons given as
   plugin-relative paths resolve through the asset protocol. The 仅图标
   setting (#47) is `node scripts/cdp_mode_bar_icons_verify.mjs`: default
   icon + name, icons-only toggled through the real settings pane (live
   apply + persistence), constant pill height with a narrower bar, the
   `unknow_universal.svg` fallback for icon-less modes, click + switch-key
   still working, and the first frame after a restart already icons-only
   (`__LUME_CONFIG__` injection). It restores the setting and removes its
   fixture on exit.
7. **`.lupx` packages** — `node scripts/cdp_lupx_verify.mjs`; cover inspect,
   install, overwrite relation (`upgrade` / `reinstall` / `downgrade`),
   uninstall and private-file preservation.
8. **HTTP and slow requests** — `node scripts/cdp_http_probe_verify.mjs`
   (offline local echo server) covers status/headers/text/json, non-2xx,
   request timeout and post-timeout bridge health.
9. **Themed plugin icons (#44)** — `node scripts/cdp_plugin_themed_icon_verify.mjs`
   (fixture `examples/plugins/themed-icons` + a self-built detachable window
   fixture): keyword rows, mode pill, list-template rows and feature rows pick
   the light/dark variant by the surface theme and swap live on a real
   settings flip; explicit variants opt out of `--icon-filter` while a legacy
   string row keeps `invert(1)`; the detached window's taskbar HICON is the
   raw uploaded variant per the plugin's effective mode. `--legacy` reruns
   only the legacy single-icon taskbar branch (dark still inverts).
9. **Manual item** — real OS file drag into the launcher, real UAC prompts,
   service/agent registration, taskbar AUMID pinning and actual drag of a
   detached-window titlebar cannot be fully automated; use the sections above
   plus `docs/PLUGIN_API.md` §10.

## Known hotkey conflicts

- **uTools / PowerToys Run** both register `Alt+Space` by default. If Lume
  cannot register its configured toggle combo it logs the failure and runs
  without a keyboard shortcut (no silent fallback). Free the combo in the
  other app, or record a free one in 设置 → 快捷键 (tray → 设置).
- **Chinese IME** may use `Ctrl+Space` to toggle the input method. Choosing
  it for Lume only works when the OS lets Lume register it — `validate_hotkey`
  reports `taken` otherwise; pick another combo.
