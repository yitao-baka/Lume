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
  「剪贴板」 settings pane, and a **satellite preview window** (ROADMAP #15 —
  text / text-file / image / audio / video previews render in a separate
  non-activating window docked to the launcher's right edge, so the main
  renderer never holds decoded bitmaps / media buffers)
  (`src-tauri/src/clipboard.rs`, `src-tauri/src/window.rs`, `src/App.tsx`)
- Clipboard auto-paste — Enter on a history entry writes it to the clipboard,
  hides the launcher and sends `Ctrl+V` into the window that had focus before
  the launcher appeared (`paste_clipboard`; the pasted entry **stays** on the
  system clipboard afterwards, like a normal copy); a per-row copy button
  copies without pasting (`src-tauri/src/clipboard.rs`,
  `src-tauri/src/window.rs` `FocusState`)
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
- Explorer-folder context bar — when summoned while an Explorer window has
  focus, Lume resolves the folder it shows (COM `IShellWindows` →
  `IPersistFolder2` → `SHGetPathFromIDListW`, `src-tauri/src/explorer.rs`) and
  adds a 「Windows 资源管理器」 bar to the bottom of the empty-query main menu:
  「CMD 中打开」/「PowerShell 中打开」 (cwd = that folder, `ShellExecuteW`
  `lpDirectory`), 「复制路径」, right-click 启动 / 以管理员身份启动
  (`runas`); gated by the `show_explorer_bar` setting (设置/界面). The
  foreground HWND was already captured for clipboard auto-paste
  (`window.rs` `FocusState`); the path resolves lazily on a dedicated STA
  thread (`explorer.rs`, mirroring `icons.rs`)
- Clipboard enhancements — right-click pin, `Del` / per-entry trash button; the
  SQLite table is migrated in place (see `docs/ARCHITECTURE.md`)
- Window lifecycle: hidden at start, centered on show, auto-hides on focus
  loss; hidden webviews' idle memory is swapped out via WebView2
  `SetMemoryUsageTargetLevel(Low)` — settings/preview immediately, main after
  10 s hidden (`window.rs` `sync_aux_memory_targets` / `trim_main_when_idle`,
  restored to Normal before show; ROADMAP #18)
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

**WebView2 闲置内存裁剪 (ROADMAP #18, complete) — as of 2026-08-21**: 三个常驻 webview
（main/settings/preview）即使全隐藏也各保有一个 renderer（实测基线 priv-WS **138.1 MB**，
renderer ×3 = 58.1）。接入 WebView2 官方 `SetMemoryUsageTargetLevel(Low)`：隐藏窗口闲置内存
换出到分页文件（页面保活不卸载），**重新激活必须手动设回 Normal**。策略——settings/preview
**隐藏立即 Low**（`sync_aux_memory_targets` 按可见性）；main **隐藏满 10s 才 Low**
（`trim_main_when_idle`，频繁开关不触发换出），热键呼出前 `restore_main` 先 Normal 预热。
实现：新增 `webview2-com` 依赖（与 tauri 0.38.2 统一），`Webview::with_webview` 取 COM
controller → `cast<ICoreWebView2_19>` → `SetMemoryUsageTargetLevel`（tauri 未透出该 API；
`Manager::get_webview` 在 `unstable` feature 后走 `AsRef<Webview>`）。挂接点：启动 setup
全 Low、`show()` 先 Normal、各 show/hide 路径 `sync_aux_memory_targets`、`teardown_preview`
末尾 `sync_aux`。实测：隐藏基线 **138.1 → ~102 MB**（renderer 58.1 → 23，省 ~36 MB / 26%）、
全 Low 状态呼出 **87ms**、settings 开关内存恢复/回落正常、预览 dock 正常、73 测试过。**实验
被否**：`--renderer-process-limit=1` 合并 renderer ×3→×1 虽省 ~18 MB，但 WebView2 不支持多
webview + 该开关——settings/preview 窗口创建静默失败（HWND 消失、CDP 剩 1 target）→ 回退。
Details in `docs/ROADMAP.md` #18。

**多文件勾选 + 失效判定 + 去重开关 + 记住页面 (ROADMAP #17, complete) — as of
2026-08-17**: grill-me 定稿七项全落地。① 修复「旧条目复制/粘贴无反应」——根因是
`copyOnly` 失败只 `console.error`（图片 PNG 丢失）与文件行失效但 HDROP 不查存在性；
现在**所有**复制/粘贴错误都弹 toast（`CLIP_INVALID`/`CLIP_NO_FILES` 有专属文案）。②
**失效条目**（file 全缺失 / image PNG 丢失）→ `ClipboardItem.valid` 划线变灰、不展开
预览、复制/粘贴拦截。③ **多文件列表预览**：≥2 文件条目卫星窗显示文件列表（`filelist`
kind）+ 复选框 + 逐文件存在性（`check_file_exists`），复制/粘贴只对**勾选子集**生效
（`effective_file_paths`，后端读 DB 最新 `checked`）；「记住勾选」开关（
`clipboard.remember_checks`）持久化到新 `checked` 列（撤销携带）。④ **内容去重开关**
（`clipboard.dedup`，默认开）：关 = 相同内容也新增（文本唯一索引 DROP/重建）。⑤
**记住上次所在页面**（`appearance.remember_last_page`，默认关）：记住模式+分类
（`save_last_page` 轻量写盘不碰 backup），搜索词仅会话内。⑥ 混合类型多文件行 →
`multifiles.svg`。⑦ 删剪贴板底部快捷键提示。`cargo test` 71 通过。Details in
`docs/ROADMAP.md` #17。**Follow-up（同日，未开新 ROADMAP）**：开启该开关时关闭
Lume（托盘「关闭」/「重启」）会清除已记住页面 —— `RunEvent::ExitRequested` →
`settings::clear_last_page`（轻量写盘、不碰 backup），重启回到初始页，记忆仅会话内
生效；单实例第二进程在进入 Tauri 生命周期前即退出，不会误清。`cargo test` 73 通过。

**Prior: PDF 预览 + 源码/歌词归文本 + 音乐分类 + 预览开关 + 左磁吸重叠修复 (ROADMAP #16,
complete) — as of 2026-08-15**: PDF preview via frontend PDF.js (`pdfjs-dist` v6,
lazy-`import` so the ~480KB chunk + 1.26MB worker only load into the satellite
renderer on first PDF; hand-rolled mini viewer renders **only the visible page**,
page-flip/zoom toolbar, asset:// fetch, worker via `new URL(...pdf.worker.min.mjs,
import.meta.url)`); Office + 压缩包 preview dropped by decision (grill-me). Text
extensions extended (`TEXT_EXTS` + `file_content_kind` keep both copies in sync):
common source langs (`kt swift php rb dart scala cs fs fsx r pl hs zig nim ex exs
erl clj vue svelte jsx tsx mjs cjs groovy gradle proto gql tex`), lyrics `.lrc`,
subtitles `.srt .vtt .ass`. New 音乐 category between 图片 and 视频
(`ClipKind "music"` → `search_history` filters `file_content_kind == "audio"`;
audio rows already had the music-note tile). New 开启预览 toggle
(`clipboard.preview`, default **on**, in 设置/剪贴板) — frontend `previewEnabled`
gates the satellite sync and backend `show_preview` gates too (teardown); only the
satellite is disabled, inline row thumbnails stay. Left-dock overlap bug fixed —
**two root causes**: ① `dock_position`'s left branch clamped into the work area
(overlapped when main sat near the left edge + right overflowed); now returns the
desired **client** origin and `Option<Position>` (None → `redock` hides), and
② even `decorations(false)` the preview keeps a ~11px invisible non-client frame
(measured via `GetClientRect`+`ClientToScreen` on the preview HWND) while
`set_position` sets the **outer** origin — `redock` now measures the
client→outer inset and calls `set_position(client_target - inset)`, so BOTH sides
align; a `PREVIEW_GAP_LOGICAL` (8 logical px) breathing room is kept on both
sides (CDP-verified 8.0 CSS px). `show_preview` now also gates on the main
window being visible — re-enabling 开启预览 in settings (which blurs/hides the
launcher) no longer pops a lone satellite window. Also added `custom-protocol` to
the tauri crate features — without it a bare `cargo build --release` builds a DEV
binary (`cfg(dev) = !custom_protocol`, loads localhost:1420 instead of the
embedded frontend); with it cargo builds are production. Details + trade-offs in
`docs/ROADMAP.md` #16.

**Prior: 独立磁吸预览窗口 (ROADMAP #15, complete) — as of 2026-08-15**: all clipboard
previews (text / text files / images / audio / video) moved out of the main
renderer into a separate satellite window (`preview`, created at startup,
frameless, `WS_EX_NOACTIVATE` non-activating, docked flush to the launcher's
right edge — width 320, height follows main via `GetClientRect`+`ClientToScreen`,
re-docks on `Moved`/`Resized`, flips left on right-edge overflow). Selection →
satellite shows; no selection / "other" binaries → hide + navigate `about:blank`
(page unload; renderer stays resident ~15MB — measured as **partial reclaim**,
~7MB lingers in the preview renderer, accepted). Main window never widens for
previews anymore. Close via main-window Esc (the satellite can't take keys) or
the × button. The old inline `ClipPreview` pane, `PREVIEW_W` widening, and
`.clip-enlarge` overlay are deleted; `preview.html` is a new vite multi-entry
page (`src/preview.tsx`). New commands `show_preview`/`close_preview`/
`get_preview_request`; capabilities/preview.json; dock_position unit-tested.
CDP-verified: renderer×3, flush dock, main-not-widened, image via asset://,
Esc teardown. Details + measurement in `docs/ROADMAP.md` #15.

**Prior: 剪贴板管理器重构 — 阶段 1 + 2 + 3 (ROADMAP #13, complete) — as of 2026-08-13**:
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
