# Testing

How to verify Lume.

## Automated checks

Rust unit tests cover the app fuzzy scorer, the real Start Menu scan and the
clipboard store (upsert recency, pruning, substring search):

```bash
cd src-tauri
cargo test
```

The frontend build catches TypeScript / SolidJS errors:

```bash
npm run build
```

## Manual verification

Run the app:

```bash
npm run tauri dev          # dev (needs the vite dev server)
npm run tauri build -- --no-bundle   # standalone release exe
```

The standalone release exe (`src-tauri/target/release/lume.exe`) embeds the
frontend, shows no console window and does not need `localhost:1420` running —
that is what to double-click / distribute. The debug exe only works with the
dev server.

### Launcher basics

1. **Shortcut registers** — the console logs which combo won, e.g.
   `[hotkey] registered Ctrl+Space`. If `Alt+Space` is preferred but taken by
   another app (uTools, PowerToys Run), the fallback chain picks the next free
   combo automatically.
2. **Toggle** — press the registered combo: the launcher appears centered with
   the search input focused; it should feel instant (< 50ms target).
3. **Auto-hide** — click any other window: the launcher dismisses itself.
4. **Navigate grid** — on show, the main menu is a grid of app boxes (empty
   query browses all apps). Letter tiles appear first, then each box's **real
   icon** loads in and replaces the letter. `←` / `→` / `↑` / `↓` move the
   selection; hover selects; click or `Enter` launches the app and hides.
   Re-opening or re-searching the same apps shows their icons instantly from
   the in-memory cache.
5. **Search** — type a fragment (e.g. `code`, `fire`, `note`); matching apps
   stay in the grid, best-ranked first.
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
    ~300px), and it stays centered; the clipboard list sizes to its items.
12. **Fresh state** — re-showing the launcher clears the previous query and
    returns to the Navigate grid.

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
2. **Layout** — the left sidebar shows 界面 / 系统 / 插件 / 关于; clicking
   swaps the right pane. 「保存」/「应用」 are disabled until a change is made.
3. **Save vs Apply** — 「应用」writes `settings.toml` and applies immediately,
   staying in the window; 「保存」does the same and closes it. Both write a
   backup of the previous file to `backup.toml` first.
4. **Settings files** — live under the writable base dir: portable is the exe
   dir (dev: `src-tauri/target/debug/`), installed (exe under `Program Files`)
   is `%LOCALAPPDATA%\Lume\`; `settings/settings.toml` is created from
   `default.toml` on first run; `backup.toml` appears after the first
   Save/Apply/Import.
5. **DB migration** — `lume.db` lives in `<base>/data/` (portable:
   `<exe_dir>/data/`; installed: `%LOCALAPPDATA%\Lume\data\`); clipboard
   history survives the move from the old app-data location (auto-copied once).

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
4. **The service is dormant** — with it running, close Lume, add/remove a file
   on the Desktop, wait past one cache-refresh interval (set it low, e.g. 5
   minutes, in 设置→系统 first): `user_cache.db` mtime is **unchanged** (the
   service never scans). Re-open Lume — it refreshes at startup and finds the
   new file; with Lume left open, the hourly in-process refresh finds it within
   one interval.
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
8. **Dev loopback** — `lume-svc.exe --foreground` runs dormant (Ctrl+C quits);
   the service holds `\\.\pipe\LumeSVC` ready for a future client.
9. **Bundle** — `npm run tauri build` puts `lume-svc.exe` next to `lume.exe`
   in the installer (`externalBin` + `scripts/copy-lume-svc.mjs`).

### Environment sync (envwatch)

> Watcher logs `[envwatch] ...` to the console (dev). `cargo test` covers the
> PATH merge logic; the Win32 watcher itself is manual-only.

1. **Dialog path** — with Lume running (dev console visible), open 设置→环境变量
   (Environment Variables dialog) and append a new entry to the user `Path`.
   Apply → the console logs `[envwatch] environment refreshed from registry`.
   Launch `cmd.exe` from Lume: `echo %PATH%` shows the new entry. The change
   also lands in the launcher process itself — `GetEnvironmentVariable` in the
   Rust core returns the new value without a restart.
2. **setx path** — in a terminal run `setx LUME_TEST 1` (no broadcast, registry
   notify path) → the same refresh log appears within a moment; a freshly
   launched `cmd.exe` from Lume sees `LUME_TEST=1`.
3. **Startup snapshot** — restart Lume *without* changing anything: no refresh
   logs; PATH still includes whatever the parent shell had.
4. **Already-running processes untouched** — an `cmd.exe` opened *before* the
   change keeps its old PATH until it is relaunched.
5. **Idle cost** — with the watcher armed, the `envwatch` thread's CPU time
   stays flat while the environment is untouched (no polling wakeups; thread
   suspended in `MsgWaitForMultipleObjectsEx`).

### Recent + pinned bars (ROADMAP #10)

> `cargo test` covers the recent store (upsert / dedupe / pruning); the UI is
> manual-only. Requires a dev build (`npm run tauri dev`).

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

## Known hotkey conflicts

- **uTools / PowerToys Run** both register `Alt+Space` by default. Lume skips
  the combination if it cannot register it. To restore `Alt+Space` as the
  Lume shortcut, change or disable the conflicting app's hotkey.
- **Chinese IME** may use `Ctrl+Space` to toggle input method; Lume still
  registers it at the OS level (RegisterHotKey), so both can coexist.
