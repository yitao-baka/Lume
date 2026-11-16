# Manual Verification

These checks require a real desktop, a human at a UAC prompt, or native Windows
interaction. Run the automated release gate first:

```powershell
pnpm verify:release
```

Use `pnpm run tauri build --debug --no-bundle` when an isolated embedded debug
executable is needed. Tauri runs the frontend build through
`beforeBuildCommand`; do not run `pnpm run build` immediately before it.

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

### First-run onboarding

1. **New data root** — launch a staged portable copy with no `settings/` or
   `data/onboarding.json`. The compact welcome window appears, the main launcher
   stays hidden, and the configured summon shortcut is rendered as keycaps.
2. **Shortcut handoff** — press the real global shortcut. The welcome window
   disappears, the launcher appears with the mode-switch coach, and the search
   box owns focus. Repeat after denying the shortcut to another app and verify
   the conflict warning plus the “continue” fallback.
3. **Mode lesson** — press `Tab` while the search box is focused. The active mode
   changes and the coach advances to the Settings lesson. Verify the mouse
   fallback also advances without trapping keyboard focus.
4. **Settings handoff** — click the highlighted gear or press `Ctrl+,`. Settings
   opens on 系统 with the autostart card above `system.autostart`; closing it
   without a choice leaves the launcher on the final lesson.
5. **Autostart choice** — choose 暂不启用 and confirm the card disappears, no HKCU
   Run value is written, and `data/onboarding.json` records the decision. Repeat
   on a disposable profile with 启用开机自启 and verify the HKCU Run path. Test a
   denied registry write and confirm the card stays with an inline alert.
6. **Restart and replay** — restart: the welcome window must not auto-open and
   the launcher remains hidden until summoned. Use 设置 → 关于 → 重新观看新手引导,
   then close/skip the welcome: the durable completed state must remain unchanged.
7. **Visual matrices** — repeat the welcome, launcher coach and settings card at
   100% / 150% / 200% scaling in Quiet/Chromatic, dark/light and a custom accent.
   No native titlebar/menu, clipped copy, focus-ring overlap or horizontal scroll
   may appear.

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
   the bar above the grid (the unknown fallback appears first, then the real
   icon replaces it);
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
10. **Re-launch activation** — with the launcher hidden, double-click
    `lume.exe` or its desktop shortcut. The second process exits, the existing
    instance reveals the main window and focuses the search box. Repeat while
    the launcher is visible: it must focus without hiding or creating another
    tray icon/process.
11. **Focus and keyboard commands** — click a mode pill / clipboard category /
    bar 展开; typing immediately continues in the search box. With focus in
    the search box, `Tab` still switches modes; move focus to a pill or page
    control and `Tab` / `Shift+Tab` traverse normally. `Ctrl+Tab` switches
    modes from anywhere, `F6` / `Shift+F6` cycle search box → mode bar → page
    control → settings gear, `Ctrl+,` opens settings, and `Shift+F10` (or the
    Menu key) opens the context menu for the selected tile / row.
12. **Blocked shortcuts** — Ctrl+F, Ctrl+P, Ctrl+R, F12 and Alt+←/→ do nothing
    (no Find bar, no print, no reload, no DevTools). Ctrl+C/V/X/A still work
    for editing the search box, and the launcher's own keys (Tab, arrows,
    Enter, Esc, Del) are unaffected.
13. **Auto-sizing** — the window height fits the results: the full app grid
    caps at 520px (scrolls internally), a few results shrink it (e.g. "no" →
    ~300px), and it stays anchored (centered / cornered per the preset until
    you drag it — see 15). A fixed-height page keeps that height through its
    loading gate; only fit pages may temporarily collapse to the search row.
    Width/height submitted through settings, content measurement or
    `app.resize` are clamped to the current monitor work area.
14. **Fresh state** — re-showing the launcher clears the previous query and
    returns to the Navigate grid.
15. **Position memory** — drag the launcher somewhere, then Esc + summon
    again: it reopens at the dragged spot instead of jumping back to the
    窗口位置 preset, and typing / clearing the query (content resizes) does
    not move it either. Picking another preset in 设置 → 导航页 positions it
    immediately and takes over again; 跟随鼠标 re-centers on the cursor on
    EVERY summon. Automated:
    `node scripts/cdp_window_position_verify.mjs`（位置记忆/预设/跟随鼠标）与
    `node scripts/cdp_window_geometry_verify.mjs`（1 ms HWND 轨迹、固定页
    无搜索栏中间态、尺寸与锚点同帧、工作区边界、透明像素）。Native probes:
    `scripts/ps_lume_geometry_probe.ps1` / `scripts/ps_lume_pixel_probe.ps1`.
    DPI/多显示器验收：几何脚本用 DPI-aware 探针枚举各显示器，并把真实 HWND 移到每屏检查工作区；实际份额覆盖仍需在 100% / 150% / 200% 与混合缩放桌面分别运行。
16. **Navigate IME** — switch Windows to a Chinese IME, then enable
    设置 → 启动器 → 「导航页禁用输入法」. On Navigate, typing pinyin must insert
    raw Latin letters with no candidate window; switch to Clipboard or a plugin
    page and the same typing must show the normal IME candidates. Turn the
    setting off or open the settings window: IME input is available again. While
    enabled, the search field must show a blinking accent caret that follows
    arrow keys, Home/End, mouse selection and horizontal scrolling; rapid typing
    must update the text immediately without running a backend search for every
    key. The system IME selection must not change, and other applications must
    keep working normally.

### Clipboard mode

1. **Capture** — copy a few pieces of text (e.g. a URL, a code snippet). The
   `WM_CLIPBOARDUPDATE` listener records each change without a background polling
   cadence; copy several values quickly and confirm all are preserved in order.
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
   While the search input is focused, `Space` inserts a space and `Del`
   edits the query instead of touching history. To multi-select with the
   keyboard, leave the input (for example by clicking a row) and press
   `Space`; deleting a selected row must immediately clear its selection
   badge/count.
   With the clipboard page focused, `Tab` traverses the category buttons, the
   three actions of the currently selected row, then the status-bar controls.
   Actions on unselected rows are not Tab stops; focus must never disappear
   into an `opacity: 0` action cluster.
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
13. **Paste outcome** — with no live target window (or after the target is
    gone), Enter copies the entry and keeps the launcher open with
    「已复制 — 没有可粘贴的目标窗口」; a paste failure keeps it open with an
    error toast instead of hiding.
14. **Native row icons** — copy one file/folder and one `http(s)` URL. The
    single-file row shows that file's Shell icon and the URL row shows the
    default browser's icon; a multi-file row keeps the aggregate file glyph.

### Satellite preview

1. **Title** — select an image/file/video preview: the 36px header shows the
   filename, or the content type for clipboard-image rows.
2. **Close** — click the header ×: the satellite disappears immediately, the
   launcher stays visible, and the next selection can open a preview again.
   The click must not activate the satellite or steal focus from the launcher.
   Repeat open/close ten times and verify the renderer is still visible after
   each reopen.
3. **No close button without content** — the window is hidden, never a bare
   header floating beside the launcher. At startup its page is the zero-script
   blank document; `preview.html` loads only when the first content preview
   appears.
4. **PDF** — open a PDF preview, page through it and close. Reopen another
   preview immediately; the blank-page teardown must not leave a hidden WebView
   or break the asset-protocol read path.

### Settings window

1. **Entry** — click the gear button in the launcher's search row, or
   「设置」 in the tray right-click menu: the settings window opens.
2. **Layout** — the grouped sidebar shows 个性化（外观 / 启动器 / 剪贴板）、
   效率（搜索 / 快捷键 / 自动化）与管理（插件 / 系统 / 关于）；clicking swaps
   the right pane. The footer shows autosave status instead of a global save
   button, and Chromatic additionally shows the current page number.
3. **Autosave** — change a color mode, skin, accent preset, or switch without
   pressing save: the footer reports saving then saved. Quit and reopen: the
   value persists. While a text field or the color input is focused, a light
   write from the launcher/plugin manager must not replace the current edit.
4. **Settings files** — live under the writable base dir: portable is the exe
   dir (dev: `src-tauri/target/debug/`), installed (exe under `Program Files`)
   is `%LOCALAPPDATA%\Lume\`; `settings/settings.toml` is created from
   `default.toml` on first run; `backup.toml` appears after the first
   Save/Apply/Import.
5. **DB migration** — `lume.db` lives in `<base>/data/` (portable:
   `<exe_dir>/data/`; installed: `%LOCALAPPDATA%\Lume\data\`); clipboard
   history survives the move from the old app-data location (auto-copied once).
6. **Close / replacement operations** — close during a pending text edit: the
   queue flushes before hiding. Make `settings.toml` read-only, change a
   setting, then close: the window stays open, the control rolls back, and the
   footer offers retry. Import, backup restore, default restore, service
   uninstall, agent unregister, plugin uninstall, and trust-all enable use the
   in-window confirmation dialog rather than “click twice”. Open and close the
   window ten times: the first open creates the WebView, recent reopens retain
   the current page while warm, and each reopen restores focus and visibility.
7. **Idle reset ()** — 设置 → 启动器：「闲置重置」默认开、阈值
   30 分钟。把启动器呼出再隐藏，超过阈值后下次呼出应回导航页、搜索框为空，
   未豁免插件页冷启动；清单 `keep_session = true` 或 设置 → 插件 打开豁免的
   插件应保留查询与页面状态（但落地仍是导航页）；总开关关闭后不重置。
   自动验证：`node scripts/cdp_idle_reset_verify.mjs`（需先构建 debug exe）。
8. **Search** — `Ctrl+F`, then search 「主窗口皮肤」「设置窗口皮肤」「闲置重置」 or
   a disk plugin's declarative label (e.g. 「列表前缀」): each row-level setting
   appears once; Enter jumps to the exact row and focuses its container. A
   nonsense query shows the localized no-match suggestions. Esc clears the overlay.
9. **Index scope and maintenance** — 搜索 shows text buttons 「刷新索引」 /
   「重建索引」 and a standalone 「全盘索引」 group below 用户索引 whose switch
   defaults off and whose hint stays on one line. With the switch off, typing in
   Navigate must not append whole-drive files even while Everything or LumeSVC is
   running. With the service unregistered, turning the switch on must show the
   registration modal and leave it off. Rebuild asks for confirmation, then
   recreates the local index/icon databases and resumes indexed searches.
9. **Skins and accent** — in 外观, choose Quiet ↔ Chromatic separately for the
   launcher and settings window. Focus stays on the active skin radio and scroll
   position is preserved; changing either window's skin leaves the other
   unchanged. The launcher skin covers navigation, clipboard, embedded plugin
   canvas and detached plugin window, while Chromatic must not add a CSS
   border/radius to the launcher's outer window. Repeat with light/dark mode:
   both skins use their own palette, and a plugin's own light/dark override
   remains orthogonal. Select each accent
   preset and a custom color with the native color picker; focus, selected rows,
   switches and small accent text update immediately, values survive restart,
   **默认** restores the native skin, and clicking the custom entry's name
   applies the stored color (pure white before one is stored) without opening
   the picker. The launcher surface must remain its skin color. With system
   color mode active, flip Windows app light/dark mode and confirm surfaces and
   derived accent update without reopening the window. Repeat at 200% scaling
   and check the 32×32px picker hit area plus keyboard traversal.
10. **Minimum window** — resize to 560×420. The sidebar collapses to icons with
    tooltips; all nine pages remain reachable, rows stack label over control,
    plugin detail uses list → detail → back, and no page has horizontal overflow.
11. **Result icon shape** — 设置 → 启动器 → 条目：「应用图标圆形显示」默认关，
    the Navigate grid shows the extracted artwork without a circular crop. Turn
    it on: only the result artwork becomes circular; turn it off to restore the
    original outline.
12. **Help and switches** — every `i` button shows its explanation beside the
    label on hover/focus without moving the row; clicking opens a modal, Esc
    closes it, and focus returns to the button. 设置 → 自动化：all switches use
    the same 44×36px track with the knob fully inside it in both states.
13. **Search index copy** — 设置 → 搜索：桌面、System32、开始菜单三行分别显示
    不同的范围说明。
14. **Plugin pane scrolling** — at 1040×720 open 设置 → 插件: scroll the left
    list to its end; the right detail stays fixed. Select a plugin and scroll its
    detail; the left list does not move.

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
   「启动服务 / 重启服务 / 卸载服务」 and the status line reads 服务运行中.
   `reg query HKLM\Software\Lume\DataDir` points at `%LOCALAPPDATA%\Lume`.
3. **Stopped recovery** — stop LumeSVC in `services.msc`, reopen 设置→系统:
   the status reads 服务已安装，未运行 and 「启动服务」 appears. Accept UAC and
   verify the status changes to 服务运行中 only after SCM reports RUNNING.
   Repeat with 「重启服务」; the status must settle back to RUNNING.
4. **UAC cancel** — click 注册服务 then choose 否 in the prompt → the UI shows
   操作已取消 and the state is unchanged.
5. **File-search service** — with the service running, query a file that is
   not in the local index. With Everything stopped, Lume should answer through
   `\\.\pipe\LumeSVC` (the self-hosted USN/MFT backend) and return the path.
   The launcher's own cache refresh remains independent of the service.
6. **Portable / no service** — without the service, while Lume runs, change a
   Desktop file and it appears after ~one interval (in-process loop). Behavior
   is identical with or without the service registered.
7. **Run as administrator** — right-click a grid or pinned-bar app →
   「以管理员身份启动」→ UAC → the target runs elevated (verify with `whoami`
   in a launched cmd.exe). Dismissing the UAC prompt neither crashes nor hides
   the launcher. Note the `.lnk` + runas behavior for each target type.
8. **Auto-start** — enable 「开机自启动」 → `reg query
   HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v Lume` shows the quoted
   exe path; after a reboot/logon Lume starts by itself. Disabling deletes the
   value.
9. **Dev loopback** — `lume-svc.exe --foreground` starts the service in a
   console (Ctrl+C quits) and exposes `\\.\pipe\LumeSVC` for `search`/`status`.
10. **Packaging** — `pnpm run package:zip` assembles the portable zip under
   `src-tauri/target/release/bundle/zip/`. `pnpm run package:installer` builds
   the MicaSetup EXE under `src-tauri/target/release/bundle/installer/`.
   Both artifacts must contain `lume.exe`, `lume-svc.exe`, `lume-agent.exe`,
   `languages/`, and `res/icons/`. The installer payload additionally contains
   `LICENSE` and `THIRD_PARTY_NOTICES.md`.

### MicaSetup installer

> The setup requests administrator rights and writes under `Program Files`.
> Run these checks only on a disposable Windows profile or VM.

1. **Identity** — open the setup's file properties: description is `Lume Setup`,
   product/company is `Lume`, and the version matches the internal release
   version. The window and shortcut icons use Lume artwork, not upstream
   MicaSetup branding.
2. **Fresh install** — run the setup, accept UAC, keep the default
   `C:\Program Files\Lume` path, and finish the wizard. Desktop and Start Menu
   shortcuts open `lume.exe`; Add/Remove Programs lists `Lume` with the correct
   version and publisher.
3. **No hidden system changes** — a fresh install does not add a Run-key
   auto-start entry, firewall rule, environment variable, LumeSVC service, or
   `Lume\LumeAgent` scheduled task.
4. **Installed data location** — launch from the shortcut and change a setting.
   User data is written under `%LOCALAPPDATA%\Lume\`, while the Program Files
   tree remains read-only to the running launcher.
5. **Upgrade with integrations** — register LumeSVC and the elevation agent
   from Settings, then run the same setup again. The installer stops both
   before replacing files and restores both registrations afterwards; their
   configured executable paths point at the installation directory.
6. **Uninstall** — uninstall from Add/Remove Programs. The installer removes
   its files, shortcuts, uninstall registry entry, owned LumeSVC service, and
   owned LumeAgent scheduled task. `%LOCALAPPDATA%\Lume\` remains intact.
7. **Release signature** — a public release artifact must have a valid
   Authenticode signature and timestamp. A local unsigned build is expected to
   show an Unknown Publisher prompt and is not release-ready.

### Elevation agent ()

> Registering/unregistering the agent pops a UAC prompt, so those steps are
> manual only. `cargo test` never registers the task.
> Two CDP scripts cover everything that does **not** need UAC:
> `node scripts/cdp_agent_smoke.mjs` (14 assertions: the settings UI, the
> status command, defaults) and `node scripts/cdp_agent_verify.mjs` (9
> assertions: it starts `lume-agent.exe --serve` unelevated itself and proves a
> real injection lands, by sending Alt+F4 to Notepad and checking it closed).
> Verify registration through the app (设置→系统→「注册代理」), not by hand-running
> `schtasks /Create /XML` from a terminal: schtasks decodes the XML file with the
> **calling console's code page**, so a UTF-8 console (65001) hides failures that
> the agent hits under `CREATE_NO_WINDOW` (fresh CP936 console) — that is how the
> localized-description rejection of  stayed invisible.
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

### Recent + pinned bars ()

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
> All repository CDP scripts target the debug build by default; release-only
> manual checks must explicitly rebuild the release exe before launch.

1. **Core plugin contract** — `node scripts/cdp_plugin_verify.mjs` (provider
   rows + sandboxed mode page + plugin pane), then
   `node scripts/cdp_plugin_v2_verify.mjs` for the current api-2 Page Runtime
   smoke (keyword entry, ready state, opaque sandbox and CSP). The
   `node scripts/cdp_api_gate_verify.mjs` negative fixture proves api-1
   provider/feature/mode code never executes and cannot open a detached
   window; `node scripts/cdp_presenter_network_verify.mjs` proves fetch,
   no-cors, forms, WebSocket, EventSource, image beacons, logic-frame fetches and
   `location` / meta refresh / anchor / `window.open` self-navigation never reach
   a loopback HTTP probe in both the embedded and detached Presenter, with the
   deny-only WebView2 proxy as the last outlet.
   `node
   scripts/cdp_runtime_recovery_verify.mjs` covers Page Service retry,
   all-Presenter failure visibility and fit/fixed sizer handoff. The
   feature series (file drop / clipboard image / list template / tile reorder)
   plus the static ctx-surface parity checks (logic-frame ctx ≡ Presenter bridge ≡
   rpc.ts cases) run as `node scripts/cdp_p2b_verify.mjs`; it enables its two
   fixture plugins itself.
2. **Sandbox and permissions** — `node scripts/cdp_sandbox_verify.mjs` proves
   opaque-origin isolation, bridge behavior and Rust-side command whitelisting
   for clipboard/file/icon commands. A plugin that calls an undeclared capability
   must fail with an explicit message. The audit runtime probe also verifies that
   only Page Service mode receives the `service` role and provider logic cannot
   reach `page/secrets`.
3. **Logic isolation and circuit breaker** — `node
   scripts/cdp_circuit_verify.mjs`; verify three consecutive hook failures mark
   only that plugin offline, while pure-view modes never accumulate false
   timeouts. The script explicitly enters hello-mode and confirms entry hooks
   still dispatch with no pending call slots.
   `node scripts/cdp_plugin_audit_runtime_verify.mjs` covers manifest permission
   hot refresh, async disk `navBars`, long provider result IDs, detached query
   replay, and listener/timer cleanup across repeated reloads.
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
   new-enter-beats-stale-snapshot rule () are
   `node scripts/cdp_plugin_lru_verify.mjs` (generates its own filler modes
   and asserts one victim per overflow, a stored snapshot, and that the new
   payload wins on remount). Search-box routing across modes () is
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
   setting is `node scripts/cdp_mode_bar_icons_verify.mjs`: default
   icon + name, natural content width for a fitting trio, max-width shrinking
   and ellipsis only when that trio overflows, later modes clipped, icons-only
   toggled through the real settings pane (live
   apply + persistence), constant pill height with a narrower bar, the
   `unknow_universal.svg` fallback for icon-less modes, click + switch-key
   still working, and the first frame after a restart already icons-only
   (`__LUME_CONFIG__` injection). It restores the setting and removes its
   fixture on exit.
7. **`.lupx` packages** — `node scripts/cdp_lupx_verify.mjs`; cover inspect,
   inspect-then-replace rejection through the staged SHA-256 binding, install,
   overwrite relation (`upgrade` / `reinstall` / `downgrade`), uninstall and
   private-file preservation. The install confirmation dialog runs
   end to end by stubbing the native file dialog at the Windows IPC `fetch`
   seam: fact block, `aria-modal` + overlay, background `inert`, focus on the
   safe cancel action, Esc / cancel leaving nothing on disk, and confirm writing
   through to `plugins/` with the list and toast updating.
8. **HTTP and slow requests** — `node scripts/cdp_http_probe_verify.mjs`
   (offline local echo server) covers status/headers/text/json, non-2xx,
   request timeout and post-timeout bridge health.
9. **Themed plugin icons** — `node scripts/cdp_plugin_themed_icon_verify.mjs`
   (fixture `examples/plugins/themed-icons` + a self-built detachable window
   fixture): keyword rows, mode pill, list-template rows and feature rows pick
   the light/dark variant by the surface theme and swap live on a real
   settings flip; explicit variants opt out of `--icon-filter` while a legacy
   string row keeps `invert(1)`; the detached window's taskbar HICON is the
   raw uploaded variant per the plugin's effective mode. `--legacy` reruns
   only the legacy single-icon taskbar branch (dark still inverts).
10. **Manual item** — real OS file drag into the launcher, real UAC prompts,
    service/agent registration, taskbar AUMID pinning and actual drag of a
    detached-window titlebar cannot be fully automated; use the sections above
    plus `docs/PLUGIN_API.md` §10. Real paste-target focus is exercised with a
    WinForms text box and `paste_close = false`; the target must receive the
    payload while the launcher search box remains unchanged.

## Known hotkey conflicts

- **uTools / PowerToys Run** both register `Alt+Space` by default. If Lume
  cannot register its configured toggle combo it logs the failure and runs
  without a keyboard shortcut (no silent fallback). Free the combo in the
  other app, or record a free one in 设置 → 快捷键 (tray → 设置).
- **Chinese IME** may use `Ctrl+Space` to toggle the input method. Choosing
  it for Lume only works when the OS lets Lume register it — `validate_hotkey`
  reports `taken` otherwise; pick another combo.
