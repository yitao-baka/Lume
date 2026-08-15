# Changelog

All notable changes to Lume are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versions follow
[semantic versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Clipboard image preview / enlarge via asset protocol** — `get_clipboard_image`
  returns the stored PNG's path instead of a base64 data URI; the frontend
  renders it with `convertFileSrc`, so WebView2 decodes the full-size image
  straight from disk (no base64 string through IPC, no second decode in JS).
  This removes the enlarge-preview memory/CPU spike; row thumbnails stay base64.
- **Preview pane shows thumbnails, not full-size images** — selecting an image
  row (or image file) no longer decodes the full-size bitmap into the webview;
  the preview shows the small 200px thumbnail (`item.thumb`, or a new
  `get_file_thumb` command that downscales image files server-side). The
  full-size image decodes only when the user clicks to enlarge. Fixes the
  decoded-bitmap memory spike that lingered in the renderer's image cache after
  closing the preview.

### Added

- **截图像素图捕获补齐（照搬 ZTools/Chromium readImage 模式）** — 图片捕获在
  `arboard::get_image()`（只读 CF_DIB/CF_DIBV5）失败时，依次回退：①
  `read_custom_png_image`（枚举剪贴板注册格式，读名字含 png/image/png 的自定义格式，
  已 PNG 直接用、否则重编码）；② `read_cf_bitmap_image`（读 CF_BITMAP 设备相关位图，
  复用 `icons::bitmap_to_png` 转 PNG）——ZTools 剪贴板插件用 Electron `readImage()`
  （Chromium）捕获，它同时接受 DIB/BITMAP/PNG，而 PixPin 等截图工具的「复制」按钮
  常只放 CF_BITMAP，arboard 会漏掉。文本优先于图片的判断（Office 复制带 TIFF 渲染）
  与 ZTools 一致（Lume 本就是文本优先）。单测 `read_custom_png_finds_png_format` +
  `read_cf_bitmap_returns_png` 验证两条回退。**待用户用真实 PixPin 复制实测**（自动化
  种子受剪贴板所有权竞态限制，无法完全模拟）。
- **视频预览封面（poster）** — 预览窗里的 `<video>`（`preload="none"`，播放前原本是
  纯黑）现在显示一帧封面：新命令 `get_video_thumb` 用 `IShellItemImageFactory` +
  `SIIGBF_THUMBNAILONLY` 从 Windows shell 提取视频帧（就是资源管理器显示的缩略图），
  在专用 STA 线程上跑（缩略图提供程序要求 STA；图标走 MTA 不变），返回 base64 PNG，
  前端设成 `<video poster>`。格式无 shell 提供程序时退回占位。CDP 实测 PNG/MKV 均
  返回有效帧。
- **卫星预览窗口（ROADMAP #15）** — 所有剪贴板预览（文本/文本文件/图片/音频/视频）
  移出主 renderer，进一个启动时创建的独立、无边框、非激活（WS_EX_NOACTIVATE）窗口，
  固定挂靠主窗口右缘（宽 320 / 高跟随，`GetClientRect`+`ClientToScreen` 贴齐客户区，
  `Moved`/`Resized` 跟随，右缘溢出贴左）。选中预览行 → 卫星出现；无选中/other 二进制
  → 隐藏并导航 `about:blank`（页面卸载；renderer 进程保留待复用，实测为部分回收）。
  主窗口从此恒为基础宽度、永不为预览变化。关闭经主窗 Esc 或卫星窗 × 按钮。CDP 实测：
  renderer×3、磁吸贴齐、主窗不加宽、图片 asset:// 渲染、Esc 回收全通过。见
  `docs/ROADMAP.md` #15。
- **`scripts/measure-webview-mem.ps1`** — memory-measurement harness that
  snapshots Lume's whole process tree (`lume.exe` + `msedgewebview2` children)
  by process type, reporting private working set / working set / commit, with a
  guided 4-stage run (baseline / clipboard / settings / big-image) and a
  comparison table. No app code involved.

### Fixed

- **Clicking the satellite preview keeps the launcher up AND focused** —
  interacting with the preview (video play, image, text) blurred the launcher
  and tripped its blur-to-hide. The blur-hide rule now checks whether the cursor
  is over the visible preview (`preview_has_cursor`): if so, it keeps the
  launcher up and hands focus back to it, so (a) keyboard navigation of the
  list keeps working while the preview is used, and (b) the launcher is left
  properly focused — a later click-away on a different app re-fires the
  blur-to-hide and closes both windows.
- **Preview window closes with the launcher again** — `teardown_preview` used
  Tauri's async `hide()`, which raced the `about:blank` navigation and could
  leave the window on screen. It now hides synchronously via Win32
  `ShowWindow(SW_HIDE)` after tearing the page down.
- **No close × on the preview window** — the satellite has no in-window close
  button; it closes via the launcher's Esc or when the launcher hides.
- **Preview only opens for content** — plain copied text rows never open the
  satellite; file rows with text/audio/video/image content preview everywhere,
  and clipboard image rows (captured screenshots) now preview in every category
  too (previously only inside the 图片 category).
- **Satellite preview font matches the launcher** — `font-size`, `line-height`
  and `-webkit-font-smoothing: antialiased` were missing, so CJK rendered
  differently; now inherited from the same stack as the main window.
- **Satellite preview no longer hides the launcher when shown** — showing the
  preview window with `preview.show()` (SW_SHOW) made the launcher lose focus
  and trip its blur-to-hide, so entering Clipboard mode with a previewable row
  selected made the whole window vanish. The preview is now revealed with Win32
  `ShowWindow(SW_SHOWNOACTIVATE)` — never activates, so the launcher keeps
  focus (it already carries `WS_EX_NOACTIVATE` for clicks).
- **Drag no longer switches back to Navigate** — the launcher reset its state on
  every `onFocusChanged(focused=true)`; dragging the frameless window briefly
  deactivates and refocuses it, so a drag mid-clipboard would wipe the mode.
  The reset now fires only on a real fresh show (a Rust `launcher-shown` event
  emitted in `window::show`), so drags keep the current mode/search intact.
- **Hotkey summon now auto-selects the first entry** — the empty-query main
  menu rested on `zone = "grid"`, and the bar highlight requires `zoneActive`,
  so nothing was highlighted on summon. After a show the zone now settles on
  the recent bar (or pinned) so its first item is selected.
- **Mouse selection persists after leaving the list** — the bars / apps grid /
  clipboard list cleared the selection on `mouseleave` when `selectionSource`
  was mouse, so a click-selected entry despawned the moment the cursor left the
  list. The mouse-leave deselection is removed; a selection stays until another
  one is made.
- **Video/audio preview no longer buffers on selection** — the preview media
  elements now use `preload="none"`, so picking a row doesn't fetch the file
  into the renderer's media cache (which lingered after the preview closed);
  the file loads only when the user presses play.

### Notes

- A lazy settings-window experiment (create on first open, destroy on close)
  cut the idle baseline from 115.4 to 88.1 MB, but was reverted after an
  `AppHangB1` (WebView2 GPU-compositing hang when creating a runtime webview)
  left the app unresponsive. Revisit via WebView2 `additional_browser_args`
  GPU flags when pursuing the idle-memory target again.

## [0.2.17] — 2026-08-13

Clipboard manager phase 3 — preview pane + native drag-out (ROADMAP item 13,
phase 3; completes #13).

### Added

- **Preview pane** — selecting a clipboard row opens a right-side preview
  (the window widens by 320 px, narrowing back when the selection clears).
  Text rows show the full content (scrollable); image rows show the full-size
  image and enlarge on click; file rows show name / size / path / modified
  time per file (`get_clipboard_image` / `get_file_info` commands).
- **Drag-out (native OLE)** — dragging an image or file row out of the launcher
  starts a real `DoDragDrop` with a CF_HDROP data object, so WebView2's
  in-webview-only HTML5 drag can carry files to Explorer. Images drop as a PNG
  copy; files copy to the target folder. Runs on a dedicated thread.

### Fixed

- **Image file path double prefix** (regression from 0.2.14) — reading an image
  row's PNG joined `PictureCache` twice, so copying or previewing an image
  failed with a "file not found" error.
- **Drag-out freeze** — the OLE `DoDragDrop` ran on the launcher's main thread,
  freezing the UI for the whole drag; the drag commands are now async (the
  drag runs on a background thread).
- **Preview pane scope** — the preview now opens for text / file (incl.
  audio/video) rows only; images preview in their own row thumbnail and
  clicking the thumbnail enlarges (no right-side pane, no window widening).
- **Content-type previews** — file rows preview by content kind: text files
  show their text content, audio/video get an in-pane player (via Tauri's
  asset protocol), image files show the image (click to enlarge), and
  arbitrary binaries (`.dll`, `.exe`, …) no longer open the preview pane at
  all. Tile icons distinguish text / audio / video / image / other.
- **Preview reactivity fix** — the preview branch was decided in the component
  body, so SolidJS never re-ran it on selection change (a video row could show
  the previous image). Branches now use reactive `<Switch>/<Match>`.
- **Mouse into preview doesn't close it** — the selection-clearing
  `mouseleave` moved from the list to the whole list+preview container, so
  moving the cursor from the list into the preview pane no longer collapses
  it. Preview scrollbars are hidden (wheel-scroll only).
- **Drag-out removed** — the native OLE drag-out of image/file rows was
  dropped (unused); rows are no longer draggable and the OLE code, commands
  and dependencies are gone.
- **Right-click never changes the window state** — the clipboard context menu
  no longer re-selects the row it opens on (the menu acts on that row's item
  directly), so right-clicking keeps the selection, the preview pane and the
  window width exactly as they were. The preview also stays visible for the
  whole time the menu is open.
- **Content categories** — the clipboard filter tabs are now 全部 / 文本 /
  文本文件 / 图片 / 视频 / 收藏 (the old generic 文件 tab became 视频, and a
  new 文本文件 tab was added). Each filters correctly by content kind (text
  files, images — both image rows and image-file rows — and videos).
- **Content categories keep the preview open** — in the 文本文件 / 图片 /
  视频 tabs the preview pane is always expanded (image rows show their full
  image with click-to-enlarge); the 文本 and 收藏 tabs never open it, and
  全部 opens it on demand.
- **Category switching with arrows** — in Clipboard mode, ← / → cycle the
  category tabs when the search box is empty.
- **Input modality is exclusive** — keyboard navigation disables mouse-hover
  selection (a click re-enables mouse mode), so the two never fight.
- **Text rows no longer open the preview** — the 全部 tab's preview is now
  file rows only; the text-content preview serves the 文本文件 tab.
- **Pin takes effect immediately** — right-clicking → 固定 updates the row's
  badge right away (optimistic), then the re-search moves it to the top.
- **Keyboard navigation auto-scrolls** — the virtual list keeps the selected
  row fully in view when navigating with the arrows (buffered; no longer
  overridden by `scrollIntoView`).
- **File-attributes preview removed** — the name / size / path / modified-time
  preview is gone (along with its `get_file_info` command); right-clicking no
  longer opens the preview either.
- **Click = select, click again = paste** — a first click on an entry selects
  it; clicking the already-selected entry pastes it.
- **No hover-darken on rows** — hovering an entry no longer changes its
  background (the selected state still highlights).
- **Hover-select is a setting** — 剪贴板 settings gains 「悬停选中条目」
  (default off): with it off, a click is the only way to select with the mouse.
- **Favorite / Unfavorite** — the context menu's 固定/取消固定 items are now
  收藏/取消收藏.
- **Favorites on top is a setting** — 「收藏的条目置顶显示」 (default off)
  controls whether favorited entries sort to the top (off = pure recency).

## [0.2.16] — 2026-08-13

Clipboard manager phase 2 — rich text, ignored apps, pause, auto-merge
(ROADMAP item 13, phase 2).

### Added

- **Rich text / plain-text copy** — text copies that carry CF_HTML store it
  (`html` column, 64 KB cap); copy / paste keeps the formatting (HTML + plain
  text), and a new 「复制为纯文本」 context-menu item copies without it.
  Search and the list still use plain text only.
- **Ignored apps** — a 剪贴板 settings list of app names (matched
  case-insensitively against the source app, e.g. "Chrome"); copies from an
  ignored app are never recorded — good for password managers and private
  chats.
- **Pause recording** — a runtime 「暂停记录 / 继续记录」 status-bar toggle
  (not persisted); while paused the recorder skips every change.
- **Auto-merge** — when 合并复制 is on, consecutive text copies within the
  merge window (default 1.5 s) fold into one entry joined by newlines, shown
  as 「合并复制 N 条」. A copy beyond the window, a non-text copy, or a paste
  closes the merge; re-copying the last piece bumps recency instead. Window is
  configurable (0.5–3 s) in the 剪贴板 settings pane.
- **Undo preserves rich text & merge state** — restoring a deleted entry keeps
  its HTML and merged-count.

### Changed

- Schema: `clipboard` gains `html` and `merged_count` columns (in-place
  migration; legacy rows normalized to `merged_count = 1`).
- `copy_clipboard` takes an optional `plain` flag; new
  `set_clipboard_paused` command.

## [0.2.15] — 2026-08-13

Clipboard manager redesign — layout, categories, multi-select merge, undo,
virtual scrolling (ROADMAP item 13, phase 1).

### Added

- **Clipboard page layout** — the clipboard mode is now a full page: category
  tabs (全部 / 文本 / 图片 / 文件 / 收藏), a virtualized history list with
  fixed window height, a status bar (条目计数 + 清空), and a proper empty
  state. The window height is fixed in clipboard mode (the list scrolls
  internally); the apps mode keeps auto-sizing.
- **Richer single rows** — each entry shows a type tile (text T / file icon /
  image thumbnail / link icon / color swatch), a two-line body
  (`来源应用 · 时间`), and hover actions (copy / paste / delete). URLs and
  color values are detected at display time (no network, no schema change).
- **Source-app tracking** — captures the foreground process at copy time and
  shows it on each row (`source_app` column); history is searchable by source
  app too.
- **Multi-select + merge paste** — Space toggles entries into a selection set;
  Enter pastes them merged (text joined by newlines) into the previous app.
- **Undo delete** — deleting plays a 120ms fade-out, shows
  「已删除 1 条 / 撤销」 (3s), and restoring re-inserts the entry (image files
  are kept until the undo window passes).
- **Clear confirmation** — 清空 asks for confirmation and offers 「保留固定
  记录」 (pinned rows and their images survive).
- **Toast + animation spec** — bottom-center toasts (150ms ease-out; 1.6s, 3s
  for undo); hover/focus/menu 100ms, delete 120ms, window open/close 150/120ms.
- **Virtual scrolling** — hand-rolled windowed list (~30 DOM rows + overscan)
  keeps 500+ history rows fluid.
- **Clipboard settings pane** — history limit (100/200/500/1000), record
  images / files, close-after-paste, show source app, relative/absolute time.
  The recorder reads live settings, so toggles take effect immediately.
- **Richer context menu** — link rows get 「打开链接」, file rows get
  「打开文件位置」.

### Changed

- `search_clipboard` takes a `kind` filter; `delete_clipboard` returns the
  deleted row (`DeletedClip`) for the undo buffer; `clear_clipboard` takes
  `keep_pinned`; new `paste_clipboard_multi` and `restore_clipboard`.
- Deleting a row no longer immediately deletes its picture file — orphans are
  swept by the next prune's garbage collection (differs from 0.2.14).

## [0.2.14] — 2026-08-05

Clipboard storage redesign + continuous bar navigation + expand-to-screen
(ROADMAP item 12).

### Changed

- **Clipboard storage** — the DB no longer stores copied data's original form.
  Image rows (screenshots / web bitmaps) now write a PNG into
  `data/PictureCache/<id>.png` and store the relative path; legacy image BLOBs
  are extracted to files on first launch. File/folder copies from Explorer (a
  CF_HDROP path list) are captured verbatim as one newline-joined `file` row —
  the files are never read or copied. Deleting an image row (or clearing all)
  removes its picture file too.
- **File entries work everywhere** — a `file` history row shows 「N 个文件」 (or
  the single file name), is searchable by path fragment, copies back by
  re-assembling a CF_HDROP, and auto-pastes by putting that list on the
  clipboard and sending Ctrl+V (pasting into Explorer copies the files in
  place — expected).
- **Continuous bar navigation** — on the empty-query main menu, ↑/↓ move across
  the 最近使用 / 已固定 bars as one grid, keeping the column when crossing the
  boundary; ←/→ stay within the current row. Works collapsed and expanded.
- **Expand fills the screen** — expanding a bar grows the window to show all of
  its content, capped at the monitor's work area (instead of the
  `window_height` setting) so it never runs off-screen.

## [0.2.13] — 2026-08-05

Clipboard auto-paste + copy button, follow-mouse position, interface extras
(ROADMAP item 11).

### Added

- **Clipboard auto-paste** — Enter on a clipboard entry (or 粘贴回 in the
  context menu) now writes the entry to the system clipboard, hides the
  launcher and sends `Ctrl+V` into the window that had focus **before** the
  launcher appeared (`paste_clipboard`). The previous clipboard content is
  saved first and restored after the paste, so the user's clipboard is never
  polluted. The target window is recorded on every show and validated before
  pasting; with no target it degrades to a plain copy.
- **Per-row copy button** — each clipboard row gains a copy button (next to the
  trash button) that writes the entry back without pasting.
- **Follow-mouse position** — a new window-position preset 「跟随鼠标」 centers
  the launcher at the cursor on show, clamped to the active monitor. While
  active, content-height resizes keep the window at its spot instead of
  re-anchoring it.
- **Expand-pinned setting** — the interface pane gains a 「默认展开已固定」
  toggle (default off); when on, the pinned bar starts expanded on every show.
- **Shift+Enter admin** — the interface pane gains a 「Shift+Enter 以管理员
  身份启动」 toggle (default on); Shift+Enter on a selected app launches it
  elevated.
- **Synchronous settings injection** — Rust serializes the effective settings
  into `window.__LUME_CONFIG__` via a WebView2 initialization script, so the
  very first render reads persisted values (language, sizes, toggles)
  synchronously instead of racing the async settings IPC.

### Fixed

- **Search-grid keyboard navigation** — with a query typed, the arrow keys now
  always navigate the results grid, even when a stale bar `zone` is active, so
  ↑/↓/←/→ and Enter work correctly after returning from the empty-query bars.

## [0.2.12] — 2026-08-05

Recently-used bar + reworked pinned bar + interface settings (ROADMAP item 10).

### Added

- **最近使用 (Recent) bar** — the main menu now has a 「最近使用」 bar above the
  pinned bar, recording the last launches (apps **and** files) via the single
  `launch_app` chokepoint. Opens are deduped by path (re-opening bumps to the
  top) and pruned to a configurable cap (default 20), persisted in SQLite
  (`recent_apps`). The bar shows only one row by default; 展开 reveals the rest
  and the expanded state is **not** persisted — each launcher show resets to
  collapsed.
- **Reworked 「已固定」 bar** — the pinned bar now has the same titled,
  expandable structure: label + 展开/收起 header, one row collapsed, all rows
  expanded. Both bars reuse the main grid's entry-box sizing and columns.
- **Removed the empty-query browse grid** — the main menu is now exactly the two
  bars; typing a query shows the results grid as before. An empty main menu
  (no recents, no pins) shows a blank results area.
- **Remove from recent** — right-clicking a 「最近使用」 entry (or selecting one
  and pressing `Del`) removes it from the list. A soft delete: reopening the
  entry re-adds it, and the file/app itself is untouched. Sits in the context
  menu just before 以管理员身份启动.
- **Single instance** — Lume enforces a single running instance with a named
  mutex; launching a second copy (double-clicking the exe again) exits silently
  instead of starting a second process.
- **Interface settings order** — 「显示最近使用」 moved below 「最近使用条数」.
- **Interface settings** — 「显示最近使用」 toggle (default on), 「最近使用条数」
  cap (10 / 20 / 30), and custom search-box placeholders for the apps and
  clipboard modes (empty = localized default). All `#[serde(default)]`, so old
  settings load unchanged.
- **Keyboard navigation** — on the empty-query main menu, ↑/↓ cycle between the
  two bars and ←/→ move within the active bar; typed search keeps the existing
  grid navigation.

### Tests

- `recent.rs` unit tests for upsert-bump ordering, dedupe-by-path and cap
  pruning (`cargo test`, 35 passing).

## [0.2.11] — 2026-08-04

Live environment-variable synchronization (ROADMAP item 9).

### Added

- **Environment sync** — Lume now listens for system environment changes
  (`WM_SETTINGCHANGE` broadcast + registry-change notification on
  `HKCU\Environment` and the HKLM session-manager environment key) and refreshes
  its own process environment block, so apps and commands launched afterwards
  inherit the **fresh** PATH / variables instead of the ones frozen at startup.
  Event-driven and zero-CPU when idle — there is no registry polling. `PATH` is
  rebuilt as system + user (Windows concatenation order); `REG_EXPAND_SZ`
  values are expanded. Only newly started processes are affected, as Windows
  never rewrites a live process's environment.

## [0.2.10] — 2026-08-02

Auto-sizing launcher window.

### Added

- **Auto-sizing window** — the launcher window height now fits its content:
  few results shrink it, the full app grid grows it to a cap (520px) where it
  scrolls internally, and it stays centered. Width stays 720. Requires the
  `core:window:allow-set-size` / `allow-center` capabilities. The padding
  budget accounts for the results area padding and borders, so content that
  fits is shown **without a scrollbar**.

## [0.2.9] — 2026-08-02

### Changed

- **Removed the `Ctrl+P` pin shortcut** — pinning is now done through the
  right-click context menu (「固定/取消固定」), which existed for both apps
  and clipboard entries. The clipboard shortcut hint now reads just `Del
  delete`.
- **Disabled WebView2 built-in shortcuts** — browser accelerators (Ctrl+F
  find, Ctrl+P print, Ctrl+S save, Ctrl+R/F5 reload, F12/Ctrl+Shift+I
  DevTools, Alt+←/→ history, …) no longer work in the launcher. Lume's own
  keys (Tab, arrows, Enter, Esc, Del) and text editing in the search box
  (Ctrl+C/V/X/A/Z) are unaffected.
- **Removed the default focus outline** from the mode-switch pills and other
  buttons, so no white focus ring appears when Tab lands on them.
- **Auto-scroll only follows the keyboard** — hovering a partially-clipped
  row with the mouse no longer yanks the scroll position; arrow-key navigation
  still scrolls the selection into view.

## [0.2.8] — 2026-08-02

System tray icon with Restart / Exit.

### Added

- **Tray icon** — Lume now lives in the system tray. Left-click toggles the
  launcher; right-click shows a menu with 「重启」/「关闭」 (Chinese systems) or
  Restart / Exit. Restart uses Tauri's built-in `request_restart`; Exit uses
  `app.exit(0)`.

## [0.2.7] — 2026-08-02

Pinyin search for Chinese app names (ROADMAP item 5).

### Added

- **Pinyin search** — Chinese app names are indexed with their full pinyin
  and pinyin initials at scan time. Typing `kuake` or `kk` finds 「夸克」;
  `wanmei` finds 「完美解码」. Pinyin matches are weighted slightly below
  exact name matches. The pinyin fields are search aids only and are not sent
  to the frontend. English search is unaffected.

## [0.2.6] — 2026-08-02

Custom right-click context menu.

### Added

- **Custom context menu** — right-clicking an app box shows 「固定/取消固定 ·
  启动」; right-clicking a clipboard entry shows 「复制回剪贴板 · 固定/取消固定 ·
  删除」. The menu follows the cursor, dismisses on `Esc` / click-outside /
  right-click-outside, and is styled to match the launcher.
- **Default WebView2 menu disabled** — the browser-style context menu no
  longer appears anywhere in the launcher.

## [0.2.5] — 2026-08-02

Navigate pinned bar (ROADMAP item 3) + smaller grid boxes.

### Added

- **Pinned bar** — a distinct strip of pinned apps sits above the Navigate
  main-menu grid. `Ctrl+P` pins/unpins the selected app; `↑` enters the bar
  from the grid's first row, `←`/`→` move within it, `↓` returns to the grid.
  Pins persist in `lume.db` (`pinned_apps` table, WAL-enabled), shown only on
  the empty-query main menu.
- **Smaller grid boxes** — the Navigate grid now uses 6 columns with 48px
  tiles (was 5 × 56px), and the box padding was tightened.

### Fixed

- **Blank Navigate on first launch** — the main-menu grid is now populated in
  `onMount` instead of relying solely on the window-focus event. If the window
  was shown before the webview finished loading (and the async focus listener
  wasn't registered yet), the grid used to stay empty until re-shown.

## [0.2.4] — 2026-08-02

Real application icons (ROADMAP item 2).

### Added

- **Real app icons** — the Navigate grid now shows each app's actual icon
  instead of a colored letter tile. Icons are extracted via the Windows shell
  (`IShellItemImageFactory`) at 64px for HiDPI crispness.
- **In-memory icon cache** — extracted icons live in a process-level cache
  keyed by path (backend `IconCache` + a frontend `Map`), so re-viewing a
  result set never re-extracts. **Icons are not persisted to SQL** (per
  project constraint).
- **Progressive loading** — letter tiles render immediately, then icons load
  in batches of 20 and swap in.
- **Path fix** — Start Menu paths now use consistent backslashes; mixed
  separators broke `SHCreateItemFromParsingName` (E_INVALIDARG) and
  `ShellExecuteW`.
- **Tests** — icon extraction against real Start Menu shortcuts (`cargo test`,
  20 passing).

## [0.2.3] — 2026-08-02

Internationalization (i18n).

### Added

- **i18n** — all UI strings now come from a centralized table in
  `src/i18n.ts` supporting **Simplified Chinese**, **Traditional Chinese** and
  **English**. The active locale is detected from the system language
  (`navigator.language`); `setLocale` is reserved for the future settings
  page. Covers the search placeholder, mode pills, hints, shortcut footer,
  settings/delete tooltips and the clipboard image label.

### Fixed

- **Mode-switch query cross-talk** — each mode now keeps its own independent
  search query, so clearing or typing in Clipboard no longer wipes Navigate's
  view (and vice-versa). Switching back to Navigate no longer shows the full
  main-menu grid when a filtered query was in effect.
- **App index pre-warm** — the Start Menu index is scanned on a background
  thread at startup, so the main-menu grid and first search appear instantly
  instead of after a slow one-time scan.

## [0.2.2] — 2026-08-02

Interaction fixes + Navigate grid + project roadmap.

### Fixed

- **Keyboard & mouse navigation** — results are now selectable with the mouse
  (hover selects, click activates) and keyboard arrows work reliably in both
  modes; the search input is re-focused on every launcher show. Navigation
  keys are handled at the window level, so a stray click that blurs the input
  no longer kills the arrow keys, and the selected result auto-scrolls into
  view.
- **Scrollbars** — the results containers now use a modern thin rounded
  scrollbar instead of the default chunky one.
- **Auto-hide on focus loss** — the launcher dismisses itself whenever it
  loses focus (clicking elsewhere), replacing the toggle-off behavior.
- **Per-entry delete** — the Clear button is gone; each clipboard row now has
  a trash button that deletes that entry.
- **Navigate label** — the first mode pill is now "Navigate".

### Added

- **Navigate grid** — the main menu renders apps as a 5-column grid of
  square boxes (letter tile + name). Empty query browses all apps; arrow keys
  navigate in four directions; hover selects; click launches. Long names are
  clipped, tracks use `minmax(0, 1fr)` so nothing overflows the right edge.
- **Visible selection** — the selected grid box / clipboard row gets an
  accent border and a stronger highlight.
- **Settings button** — a placeholder gear button sits next to the mode
  switch (page comes in a later iteration).
- **Roadmap** — `docs/ROADMAP.md` records upcoming work (i18n, real icons,
  Navigate pinned bar, plugin system).
- **Test** — `search_apps` empty query returns the full name-sorted index
  (`cargo test`, 18 passing).

## [0.2.1] — 2026-08-02

Clipboard enhancements: pin / delete / clear, and image history.

### Added

- **Images** — the listener captures images from the clipboard (RGBA → PNG
  blob stored in SQLite). Image rows show a downscaled thumbnail tile and
  `Enter` writes the original back to the clipboard. Consecutive duplicates
  are skipped via an in-memory hash.
- **Pin** — `Ctrl+P` toggles the pin flag on a clipboard entry. Pinned items
  sort to the top and are exempt from pruning.
- **Delete** — `Del` removes the selected clipboard entry.
- **Clear all** — a "Clear" button (two-step confirm) in clipboard mode wipes
  the history.
- **Schema migration** — the clipboard table gains `kind` / `data` / `pinned`
  columns; existing text history is migrated in place without data loss
  (`content` uniqueness now enforced by a partial index on text rows only).
- **Shortcut hint** — clipboard mode shows a footer with the active keys.
- **Tests** — migration, image round-trip/thumbnail, pin ordering & prune
  exemption, delete and clear (`cargo test`, 17 passing).

## [0.2.0] — 2026-08-02

Clipboard manager. Lume now captures, persists and re-copies clipboard history,
backed by SQLite — the database foundation declared in the README tech stack.

### Added

- **Clipboard capture** — a background thread polls the Windows clipboard
  sequence number (250 ms) and stores new text in SQLite
  (`src-tauri/src/clipboard.rs`). Own writes from `copy_clipboard` are skipped.
- **SQLite persistence** — history lives in `app_data_dir()/lume.db`
  (`rusqlite`, bundled). Re-copying existing text bumps it to the top instead
  of duplicating; the store is pruned to the 300 most recent entries.
- **Clipboard search mode** — `Tab` (or the pills in the search row) toggles
  between **Apps** and **Clipboard** modes. Clipboard mode searches history
  (case-insensitive substring, most recent first); an empty query browses the
  recent history.
- **Copy back** — `Enter` on a clipboard result writes it to the system
  clipboard and hides the launcher.
- **Clipboard UX** — muted clipboard-icon tiles and single-line content
  previews, per-mode placeholder and hint text.
- **Tests** — storage tests for upsert recency, pruning and substring search
  (`cargo test`, 11 passing).

## [0.1.0] — 2026-08-02

First working launcher. Core v0.1 delivers the launcher popup, the global
toggle shortcut and app search & launch — everything needed to use Lume as a
daily driver app launcher.

### Added

- **Global toggle shortcut** — `Alt+Space` preferred, auto-fallbacks to the
  next free combination (`Ctrl+Space`, `Ctrl+Alt+Space`) when another app owns
  the key. The active combo is shown in the launcher hint.
- **Application search** — walks the per-user and all-users Start Menu
  `Programs` folders for `.lnk` shortcuts, deduped by name and name-sorted.
- **Fuzzy matching** — case-insensitive subsequence scorer rewarding prefix,
  word-boundary and consecutive-run matches; returns the top 8 results.
- **Launch** — `.lnk` shortcuts opened via `ShellExecuteW`.
- **Keyboard navigation** — `↑`/`↓` select (wraps), `Enter` launches, `Esc`
  hides.
- **Window lifecycle** — hidden at startup, centered and focused on show,
  Acrylic frosted-glass backdrop, query cleared on each invocation.
- **Documentation** — `CLAUDE.md`, `docs/RULES.md`, `docs/ARCHITECTURE.md`,
  `docs/UI_GUIDELINES.md`, `docs/TESTING.md`.
- **Tests** — Rust unit tests for the fuzzy scorer and the Start Menu scan.
