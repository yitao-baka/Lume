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

The frontend uses **pnpm** (not npm). Config: `.npmrc` pins the registry to a
mirror, `pnpm-workspace.yaml` allows the esbuild build script, and
`package.json`'s `packageManager` pins the pnpm version. The lockfile is
`pnpm-lock.yaml` (no `package-lock.json`); install with `pnpm install`.

```bash
pnpm run dev          # vite dev server (used by tauri dev)
pnpm run build        # frontend production build → dist/
pnpm exec tsc --noEmit    # (or pnpm run build covers type-checking)
pnpm run tauri dev    # run the desktop app (dev, needs the vite dev server)
pnpm run tauri build  # release bundle (installers)
pnpm run tauri build --no-bundle  # standalone release exe only
cargo check          # (in src-tauri/) type-check the Rust core
cargo test           # (in src-tauri/) run the Rust unit tests
```

**pnpm arg forwarding**: pass extra flags directly after the script name
(`pnpm run tauri build --no-bundle`); unlike npm, do **not** add a `--`
separator — pnpm forwards a literal `--` to the underlying command, which
breaks tauri (`cargo: error: unexpected argument '--no-bundle'`).

**Dev vs standalone**: `pnpm run tauri dev` loads the frontend from
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
  blocked in `src/launcher/keyboard.ts`; only Lume's own keys and text editing
  in the search box pass through.
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
  results grid; the empty-query browse grid was removed in 0.2.12. Typing
  shows the file-search results grid (settings 系统索引) merged with the
  unified file-search backends (Everything IPC / LumeSVC USN index, ROADMAP
  #20). Launches are recorded at the single `launch_app` chokepoint
  (`src-tauri/src/apps.rs`, `src-tauri/src/recent.rs`, `src-tauri/src/pins.rs`,
  `src/App.tsx`)
- Whole-drive file search — `file_search` facade picks a backend per query:
  a running Everything (pure-Rust WM_COPYDATA IPC, ~7ms) or the LumeSVC
  self-hosted USN/MFT index over `\\.\pipe\LumeSVC` (the service sleeps while
  Everything runs, builds lazily when it disappears); failed backends cool
  down 10s; hits merge into the Navigate grid after the native index
  (`src-tauri/src/filesearch.rs`, `everything.rs`, `usnidx.rs`, `svc.rs`)
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
  (`runas`); gated by the `show_explorer_bar` setting (设置/导航页). The
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
- Theme-aware app icon — the `res/icons/` dark/light artwork pair
  (`application_dark_mode.png` white dove / `application_white_mode.png` black
  dove; `software.png` retired) is applied at runtime to every window's
  taskbar icon and the tray, resolving the color mode the same way as the DWM
  frame strip (`src-tauri/src/appicon.rs`; hooks in lib.rs setup +
  `WindowEvent::ThemeChanged`, `window::apply_settings`, plugin-window
  creation). tauri's `set_icon` only feeds ICON_SMALL — the taskbar icon is
  ICON_BIG, set here via `WM_SETICON`. The static exe icon (`src-tauri/icons/*`)
  cannot follow the theme and is regenerated from the light variant.
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
- Elevation agent — companion `lume-agent.exe` (ROADMAP #22): a **minimal**
  elevated helper whose only capability is "send one configured hotkey to the
  foreground window it was named", needed because `SendInput` is subject to UIPI
  so an administrator-run target is otherwise unreachable. Started silently by
  the scheduled task `Lume\LumeAgent` (`RunLevel=HighestAvailable`, one UAC to
  register), triggered on demand via `schtasks /Run`, exits when idle unless a
  client sent `stay`. Owns `\\.\pipe\LumeAgent` scoped to **the installing
  user's SID** + SYSTEM (never `AU`) and additionally requires the sibling
  `lume.exe`, same session, and a currently-foreground target
  (`src-tauri/src/agent.rs`, `input.rs`, `pipe.rs`,
  `src-tauri/src/bin/lume-agent.rs`)
- Auto-start at logon — settings toggle writes/removes the
  `HKCU\...\CurrentVersion\Run` `Lume` value (registry is the source of truth)
- Plugin system — `<base>/plugins/<id>/plugin.toml` + contributions
  (`provider` / `mode` / `service` / `navBars` / `[[features]]` / `[[settings]]`);
  the built-ins (clipboard, preview) go through the same registry + enabled set.
  Host capabilities (`src/plugins/hostApi.ts`) reach plugins by three paths —
  built-in factory `ctx`, disk factory `ctx`, mode-page `window.lume` bridge —
  and every capability on the ledger is gated by the manifest's `permissions`
  (P3.2; `src/plugins/permissions.ts` + the §6D.6 table, 「全部授权」 escape
  hatch). Plugin data lives in `<base>/data/plugin_store.db`
  (`src-tauri/src/plugin_store.rs`: `_rev` documents, `__`-prefixed host docs),
  private files in `<plugin>/files/` (`src-tauri/src/plugin_fs.rs`). Docs:
  `docs/PLUGIN_API.md` (reference), `docs/PLUGINS.md` (guide), examples
  `examples/plugins/*`, smokes `scripts/cdp_p0..p3_verify.mjs`
- Single instance — a named mutex (`lib.rs` `acquire_single_instance`) held for
  the process lifetime; a second launch of `lume.exe` exits immediately

## Current iteration

**独立窗口视图帧导航丢失修复（ROADMAP #33，P6.7, complete） — as of
2026-10-05**: release 构建下打开插件独立窗口 1/3–5/6 概率整页空白（只剩宿主
chrome，视图 + titlebar 槽两个 iframe 全空）。根因：`createIframeView` 挂载时
把信号初值 `""` 写进 `srcdoc`——帧先按空 srcdoc 导航一次（含一次 renderer
进程交换），真实页面到达后再导航一次；独立窗口有两个这样的沙箱帧，两次进程
交换挤在几十毫秒内时 WebView2 **丢掉后一个导航**，帧永久停在 39 字节的空
srcdoc 文档上（CDP 实证：只有 `frameRequestedNavigation` +
`frameDetached(swap)`、没有 `frameNavigated`；事后 remove+set 重设 srcdoc
每次都能救回；逻辑宿主帧因 `src` 在插入前赋值 = 单次导航，从不失败）。
修复两半：①**预防**——HTML 未就绪前不导航帧（`srcdoc={undefined}` → Solid 走
`removeAttribute`，帧停在 about:blank），每帧恰好一次导航；②**兜底**——桥首个
语句上报 `__lumeFrameBoot`，宿主 boot 看门狗（700/1500/2800ms）没等到就
remove+set 重放导航（每次重试重启 ready 宽限），三次失败 `plog.error` 放弃；
只盯含桥的页面（自建错误页跳过）、未挂载帧（启动器非活动模式页的预取）不
重试而是由挂载时 ref 重新武装。**验证**：`scripts/cdp_plugin_blank_verify.mjs`
修复前 **10/12 空白** → 修复后 **0/58**（file-search）+ **0/10**（hello-mode）；
`scripts/cdp_plugin_frame_load_verify.mjs --mode=empty` 4/4（零次空 srcdoc
写入）、`--mode=dropfirst` 4/4（吞掉首次大写入后看门狗救回）；
`cdp_plugin_window_verify` 12/12、`cdp_sandbox_verify` 14/14；
`cdp_p3_verify` 36/9 与修复前基线逐项一致（9 项既有失败，与本轮无关）。

**插件系统加固（ROADMAP #32，P6.6, complete） — as of 2026-10-05**: 契约/安全/
健壮性/DX 四组。① **契约**：清单 `api` 版本（`HOST_PLUGIN_API = 1`，超版
拒绝加载 + 逻辑宿主二次校验）；`.lupx` ed25519 签名（`plugin_sign.rs`：包内
`LUME.SIGN` 覆盖清单+全部文件哈希，信任根 = 内置发行公钥 +
`<base>/settings/trust-keys/*.pub`，无效硬拒，未签名展示 SHA-256；CLI 与宿主
同源 `lume --gen-key`/`--sign-lupx`）。② **安全**：`plugin_net.rs` 内网防护
（回环/私网/链路本地/CGNAT 默认拒绝，实测防 SSRF；`network_allow` 白名单
放行；重定向手动逐跳 ≤5 重新校验）。③ **健壮性**：插件熔断（registry
`logicFailCounts`/`logicOffline`，连续 3 次失败离线 + toast + 快速失败；
`logicPendingReady` 让首载/重载窗口的调用按"未就绪"快速失败不计熔断；
supervisor hook 6s / load 15s 兜底回执）；onQuery/onSubInput 120ms trailing
节流。④ **DX**：`plugin_devwatch.rs`（dev_mode 下 plugins 目录内核事件监听
→ 800ms 静默 → `plugin-dev-changed` → 自动热重载）；`examples/plugins/
plugin-api.d.ts` + list-demo `@ts-check` + `examples/tsconfig.json`；blob
模块 `//# sourceURL`。**同轮修复 P6.5 回归**：hostApi 28 处裸 invoke 漏
token（逻辑宿主下 clipboard/http/dialog/screen/fs 被 fail-closed 拒）；
内网防护按原始参数判身份（对逻辑宿主完全失效）；帧侧与视图桥的 rpc 吞错成
`resolve(undefined)`（权限拒绝不可感知）；http 成功结果带函数跨 postMessage
DataCloneError 被降级成假失败。**另修构建语义**（#16 遗留）：`custom-protocol`
移入 `[features]`（模板惯例）——`tauri build` 自动 embedded、`tauri dev`/
`cargo run` 走 devUrl（此前 dev 也强制 embedded，改前端必须手工重嵌）。
**验证**：cargo test **198**；`test/_harden_probe.mjs` 8/8、
`test/_logic_host_probe.mjs` 12/12、`test/_snapshot_probe.mjs` 16/16、
`test/_sign_probe.mjs` 5/5；dev 监听实测 V1→V2 自动生效。**CDP 观测变化**：
新 WebView2 不再向宿主 target 暴露 srcdoc 帧的 execution context——probe 改用
宿主侧 tap（`__frameStates`/`__logicCircuit`/`__snapPending`/`__rpcLog`，
见 PLUGIN_API §10）。

**插件逻辑进程级隔离 + 独立窗口双向状态快照（P6.5, complete） — as of
2026-10-05**: 两条主线。① **逻辑隔离**（ROADMAP #28/#29 遗留项清账）：
entry 插件逻辑不再 blob-`import()` 进启动器窗口——共享隐藏窗口
`plugin-logic-host`（`pluginLogic.html` → `src/pluginLogic.tsx` supervisor）
每插件一个 opaque-origin 沙箱 iframe（`public/pluginLogicFrame.js`，
**必须 classic script**——opaque origin 下 module 脚本按 CORS 取数被自定义
协议拒，实测 "Origin header is not a valid URL"；ESM 加载器在帧内自含，
文件文本经 `__readPluginFile` RPC 由 supervisor 代理、限本插件目录）。
registry 注册**代理贡献**（`logicProxy`：任意 hook 名 = 跨窗口 RPC，8s
超时，帧内未实现安全 undefined；`loadDiskPlugins` 四分支全部代理化），
通信经 `plugin_logic_push`/`plugin_logic_result`/`plugin_logic_action`
三命令 + `plugin-logic-event/-result/-action` 三事件，全部由 Rust
`plugin_perm::resolve_plugin_caller` 做 **label+令牌归属强制**（逻辑宿主
必须带 `host_token`，令牌不进帧——帧内裸 invoke 双重死亡：WebView2 对
opaque origin 直接拒 + Rust 缺令牌 fail-closed；`plugin-<id>` 视图窗强制
label 后缀；策略命令 `deny_from_plugin_windows`）。**15 处门控调用点 +
plugin_store 9 命令 + plugin_fs 7 命令全部过 resolve**（数据落点一律用
解析后 id）。supervisor 就绪通告 `plugin-logic-host-ready` 驱动 load 重发
（建窗竞态 + 崩溃恢复），`Destroyed` → `plugin-logic-host-closed` → 重建
重载（10s 冷却）；声明式设置首投早于逻辑就绪 → `pendingLogicSettings`
暂存、`logic-loaded` 动作补投。② **双向状态快照**（本迭代第一条提交）：
detach 时启动器先快照（`ModeInstance.snapshot?()`），关闭独立窗口时 Rust
拦截 `CloseRequested`（3s 看门狗）→ `plugin_window_close_report` 上报 →
快照+最终 query 回启动器（活 iframe 直投 / `attachSnapshots` ready 握手
消费；判定用 `viewLive()` **不是** `viewReady`——后者是取回即置的一次性
标志）。**坑**：① `plugin_window_open` 建窗瞬间即 emit `plugin-window-shown`
→ shown 推送绝不能消费 `pendingSnapshots`（只在 ready 握手带）；② 隐藏
窗口里 CDP `Runtime.enable` 只重放一次 contexts——probe 侧要累积监听；
③ WebView2 站点隔离把沙箱 iframe 变成宿主 target 的独立 execution
context（不出现在 /json/list）。**验证**：cargo test **185**、
`test/_snapshot_probe.mjs` **12 项**、`test/_logic_host_probe.mjs` **12 项**
（含四类裸 invoke 拒绝、provider 搜索往返、ctx.db 令牌链路）全过。
性能实测：逻辑宿主窗 ~110ms 建窗、空闲 CPU ≈0、每插件约一个独立 renderer
进程（OOPIF，空闲可修剪）；详见 CHANGELOG P6.5。

**主窗口部件化：搜索框部件 + 页面部件插件化（ROADMAP #30, complete) — as of
2026-09-27**: 主窗口收敛为 uTools 式拼接壳 —— `src/shell/SearchBox.tsx` 部件
（放大镜 + 输入框 + 页面 pills + 齿轮；受控纯展示）在顶，页面插槽
`<Dynamic component={activeMode().View}>` 在下；导航页照剪贴板形态改造为内置
插件 `src/plugins/navigate/`（id `"apps"`、`home: true`、`heightPolicy:
"fit"`；store = 栏目条 / search = 合并搜索管线 + feature 行 + 下钻 /
NavigateView / index 工厂），**所有页面（导航首页、剪贴板、磁盘 mode）统一
实现 `ModeInstance` 契约**，`APPS_MODE` 特判清零。契约只增不改义：`rows`
泛化为 `PageRow`（`AppEntry | ClipboardItem`）、`activate(opts?: {elevated})`、
`handleQuery?`（输入拦截——下钻过滤）、`onShow?`/`onFilesDropped?`（呼出刷新 /
文件拖入转发）、`heightPolicy?`/`anyExpanded?`（拼接尺寸）、`home?`（主页切
模式不复位）、`placeholder?`/`menuActions?`；`ModeKeyContext` 增
`gridCols`/`markKeyboard`；`PluginServices` 增 `nextSearchToken()`。键盘分层：
壳只留 Esc 链（菜单 → 页面 `onEscape`（下钻/多选）→ 卫星预览 → 隐藏）+ 切换键
+ ↑↓/Enter 通用兜底，方向键整体委托页面 `onKey`（`keyboard.ts` 不再依赖
`NavigateStore`，`menu.ts` 改结构性 `NavMenuActions`/`ClipMenuActions`，动作经
`ModeInstance.menuActions()` 供给）。搜索合并管线（原生索引 → 关键字行 →
feature 行 → 文件命中 → provider）与拖入/剪贴板图片/前台窗口 feature 行状态、
下钻、`lume-mode://`/`featureEnter`/`providerDrill` 激活分支全部归导航页；
搜索召回 / 记住上次页面（`last_page = "apps"` 值不变）/ subInput / 防抖持久化
留壳。导航首页**不进 设置→插件 启停列表**（默认页不可关）。**拼接缝（同日补做，
uTools 式无缝）**：搜索行去掉下边框、`.results` 去掉 6px 内衬（页面内衬改由各页
自给：`.result-grid` 8 / 栏网格 10 / `.plugin-list` 10 / `.clip-list` `0 6px 4px`），
`WINDOW_PAD` 20→8 与几何同步；磁盘插件页 iframe 改 flex 填充（原 `100vh - 60px`
在搜索行高度不吻合时会溢出错位），画布默认由 `injectBridge` 注入
`html{background:var(--lume-page-bg,<主题 --surface>)}` 并经 `theme` 事件随主题
翻转（`currentThemeMode`/`PANEL_SURFACE_BG` 移入 `src/theme.ts`）。**坑**：① 页面
`activate` 与壳的 Enter 路径都要 `markEntryOpened`（点击路径不经壳）；②
`onShow` 在召唤搜索**之后**调用——空菜单自动选中依赖 `search` 先把 zone 归
grid 的顺序；③ `.result-selected` 是跨页共用类名，页面内的滚动跟随 effect 必须
按 `services.mode()` 门控；④ **暗色 `color-scheme` + 透明根背景的插件页会被
Chromium 画成不透明 #121212 画布**（宿主元素背景对 sandbox iframe 不可见，
`.plugin-frame` 上写 background 无效）——这是拼接处「页面比面板黑一截」的根因，
只能给插件页 html 一个背景兜底；⑤ `.results` 无内衬后，新页面/新部件的内衬必须
自己给，且 `WINDOW_PAD` 必须与 `.results` 的垂直内衬保持同步（fit 高度）；
⑥ **窗口外缘环带**（同日二次补做）：主窗口是唯一 透明+Acrylic 的窗口，外缘有
三层可见——DWM 可见帧边框条（`shadow(true)` 无边框窗口由 DWM 画 2px，主窗口原缺
`clear_dwm_border`）、该条清成 `NONE` 后露出的 Acrylic 背景、`#root` 的 1px 透明
内衬。现主窗口用 `window::set_panel_frame_border` 把边框条画成主题实体面板色
（`--surface`；`window::apply_settings` 与 `ThemeChanged` 里重画），`#root` 内衬
去掉（面板直贴客户区），`WINDOW_PAD` 8 → 6（其保留的 1px hairline 与 CSS 圆角
于 ⑦ 去净）。排查工具：`test/_window_diag.ps1`（DWM 属性 + 屏幕级裁剪抓图）+
`test/_outer_probe.mjs`。验证：
cargo test 185 无回归、`cdp_p2b_verify` 22 项 / `cdp_clipboard_smoke` /
`test/_shell_nav_check` 10 项 / `test/_seam_probe` 10 项全过、`cdp_p2_verify`
17/21（余 4 项为 P5 前的 `iframe.contentDocument` 陈旧探针，enter 载荷经插件
日志证实已投递）；拼接处像素采样：搜索行与页面同色（暗色 29,29,32 vs
30,30,32；浅色 248,248,250 vs 251,251,253）、四缘无亮线、插件页无溢出；窗口
外缘采样：边框条为面板色（暗 30,30,32 / 浅 251,251,253）、无亮环。行为逐项
对照旧实现（合并顺序、forceGrid、Esc 分层、Shift+Enter、搜索召回 TTL、记住页面、
placeholder 三级解析、切模式 reset 语义）。改前端后须 `cargo build` 再实机冒烟
（前端编译期嵌入 exe）。

⑦ **面板不透明化**（同日三次补做；用户反馈「四个角落颜色还是不对劲 + 1px
hairline 不需要」）：四角亮弧 = `.launcher` 的 1px `--border` hairline 沿 12px
CSS 圆角描边（四角实测 61,61,61）+ CSS 圆角(12px) 大于 DWM 圆角（约 8 DIP）在弧
外露出的 Acrylic 新月带（36→55 渐变，随壁纸漂移）；直边 1px 亮线 = 同一
hairline；搜索行与页面的 8 级阶差 = 半透明面板合成（该用户桌面处 38,38,40）vs
页面画布 / 边框条实体色（30,30,32）。现 `.launcher` = 不透明 `var(--surface)`、
无 border、无 border-radius（圆角交给 DWM 裁剪）、无 shadow；主窗口 Acrylic 撤除
（对不透明面板不可见，且其半透明合成永远无法被不透明边框条复刻——环带根源）；
`.detach-btn` 填充改 `--surface-raised`（面板同色后会隐形）。**不要**再给
`.launcher` 加 border / CSS 圆角 / 半透明填充 / 背景效果——任一再引入环带或角部
色差（`test/_corner_variants.mjs` 圆角矩阵实测：≤7px 与无圆角等同、≥8px 反而新增
未覆盖像素）。验证：暗色四缘 / 四角 / 拼接缝全 30,30,32（缝列 45 连续像素同色）、
浅色全 251,251,253（余 1–2px DWM 圆角抗锯齿为任何圆角窗口皆有的正常现象）；
detach 按钮实测 38,38,40 + 描边 55,55,57 可读；cargo test 185 / `_seam_probe`
10 / `_shell_nav_check` 10 / `cdp_p2b_verify` 22 全过。

⑧ **加载门控 + 空导航页收缩**（同日四次补做；用户三点：空导航页只留搜索框 /
未加载完不显示 / pill 变色转圈）：空 fit 容器不再预留 56px 空态位（无内容不加
`WINDOW_PAD`），`MIN_WINDOW_H` 90 → 60；「无结果」提示移入自带内衬的
`.page-hint` 行（sizer 新增该测量容器）。新契约 `ModeInstance.ready()`：false
时 `.results` 加 `.results-loading`（visibility: hidden）、窗口收拢到搜索行、
活动 pill 加 `.loading`（`#5ac8fa` 着色 + 图标转圈环）；磁盘 view 页用
`createIframeView` 的 `live` 信号（挂载/换文档/卸载复位 + 3s 宽限兜底），
模板/剪贴板页用「首次取数落定（错误也放行）」的信号。**坑**：收拢一开始不生效
的根因是 **Tauri 同步命令跑在主线程**——剪贴板首载（debug ~4s）把 `set_size`
等所有 IPC 卡在队列里（实测琐碎 IPC 3895ms）；页面路径上的重活必须
async/spawn_blocking（`search_clipboard` 已 async 化；`search_apps` 仍同步，
见 ROADMAP #30.7 后续）。验证：`test/_loading_gate_check.mjs` 18 项全过（空菜单
60px / 无结果 107px / 加载期收拢 60 且 hidden / pill rgb(90,200,250) + 转圈环
动画中 / 就绪 520 与 610）+ cargo test 185 / `_seam_probe` 10 /
`_shell_nav_check` 10 / `_clip_seam_check` OK / `cdp_p2b_verify` 22。

**Prior: 插件全局开发者模式 + 全部授权并入全局（complete) — as of 2026-09-22**: 设置 → 插件
工具栏新增「开发者模式」总开关（`plugins.dev_mode`，默认关，`set_plugin_dev_mode`
轻量写即时生效）。关闭时**插件页隐藏全部开发者选项**（重载按钮 / 「开发」徽章），
且 **trusted 门控在 `get_plugins`**——所有插件上报 `trusted=false`，权限层
fail-closed 到声明能力（`permissions.ts` 零改动）。用户反馈后**逐插件「全部授权」
行已删除**（含 `.plg-trust` 样式与 `pluginTrustHint` 等键）：改为工具栏里的**全局
「全部授权」**（`plugins.trust_all`，`set_plugin_trust_all`，橙色警示文案，仅
dev_mode 开时显示；`list_plugins` 新增 `trust_all` 参数把全部磁盘插件上报
trusted）。不变量：**任何逃生门生效必须 dev_mode 开**（`get_plugins` 是唯一
上报路径，绕过 = 权限层失守）；旧 `trusted` 列表仍被尊重但设置页不再写入
（`set_plugin_trusted` 命令保留）。测试 `plugin_dev_mode_defaults_off_and_
round_trips` / `plugin_trust_all_defaults_off_and_round_trips`；文档
PLUGIN_API §6F.4 / SETTINGS §8 同步。

**Prior: 设置 → 插件页重设计（卡片式插件管理器, complete) — as of 2026-09-22**:
`src/settings/PluginsPane.tsx` 全量重写 —— 工具栏（概要 + 全部/已启用/
已停用/磁盘插件 分段筛选 + 关键词筛选输入）+ 每插件一张卡片（40px 图标块，
manifest `icon` 走 asset 协议、无图标按 kind 着色首字母；名称 + 版本 +
内置/磁盘/开发徽章 + 描述 + 类型/关键词预览；重载 + 启停 toggle）+ 点击
展开的详情面板（关键词 chips、`[[features]]` 进入规则、`permissions` 映射
成本地化能力 chips + 强制说明 + 橙色警示「全部授权」行、`[[settings]]`
声明式设置（≠默认时显示「默认 {value}」）、ID/位置等宽信息）。启停/授权/
重载语义与命令不变，仅 UI；已停用卡片整卡降透明度。i18n +~45 键 ×3，
`SECTION_SEARCH_KEYS.plugins` 补齐；样式 = `App.css` 的 `plg-*` 块（旧
`settings-plugin-*` 删除）。验证：tsc/vite/cargo build 干净、
`scripts/cdp_plugins_pane_verify.mjs` 6 项全过、双主题截图目检
（`test/plg_dark_list.png`、`test/plg_light_detail.png`）。Spec:
`docs/SETTINGS.md` §8。

**Prior: 插件系统 P2 余项 · 文件拖入 / 剪贴板图片进入 / 内置列表模板（complete) —
as of 2026-09-22**: 差距分析 P2.2 / P2.5b（`docs/PLUGIN_GAP_ANALYSIS.md`），
ROADMAP #27、API 文档 `docs/PLUGIN_API.md` §6E.1.1 / §6E.5，示例
`examples/plugins/files-img-demo/`、`examples/plugins/list-demo/`。三条**新
不变量**：

1. **主窗口的 Tauri drag-drop handler 现在是启用的**（`lib.rs`；此前因磁贴
   重排禁用）。原因：WebView2 的 HTML5 drop 拿不到真实路径，只有 wry 的 OLE
   drop target 能给出 `paths` —— 这是 `type = "files"` 的数据来源。**代价**：
   handler 吞掉非文件 HTML5 拖拽，所以**磁贴重排必须是 pointer events 版**
   （`navigate.ts`：按下 → 6px 阈值 → 行列插入点；拖后吞一次 click；改回
   HTML5 DnD = 重排失灵 + 拖拽行失效）。settings/preview 窗口保持禁用。
   `fileType` 分类与文件夹匹配明确未做（见 §6E.1.1 未支持项）。
2. **剪贴板 probe 与 reader 必须同链**：`plugin_clipboard_has_image` 的格式
   判定（CF_DIB / CF_BITMAP / 名称含 png 的自定义格式、HDROP 优先排除）与
   `plugin_clipboard_read_image` 的采集链（arboard → 自定义 PNG → CF_BITMAP）
   是同一份逻辑的镜像 —— 改一边必须改另一边，否则空查询菜单的 img 行会与
   `clipboard.readImage()` 的结果矛盾。`clipboard.readImage` 是新宿主能力，
   权限 `clipboard`（`RPC_PERMISSION` 两处登记）。
3. **`template = "list"` 的 mode 免 `view`**（`registry.ts` 专属分支 +
   `listTemplate.tsx`）：`entry` 逻辑跑在启动器窗口（provider 信任模型），
   内置列表渲染 `search(q)` 行；**声明式 feature 投递后宿主重跑一次该模式的
   搜索**（`enterPlugin` mode 分支）—— 改行源的钩子（quick-add）必须靠它
   反映到列表。`ModeInstance.rows()` 的行形状已泛化为 `PageRow`
   （`AppEntry | ClipboardItem`，#30）。

**验证**：cargo test **169**、tsc/vite build/cargo build 干净、
`scripts/cdp_p2b_verify.mjs` **17 项全过**（img 行出现/消失/readImage 真读、
拖入 3 文件出行 2 个命中文本 + fs.readText 真读、hide/summon 清空、list-demo
内置列表渲染 + quick-add + 指针重排持久化）、P0/P1/P2/P3 回归 **8/14/21/45
全过**；截图 `test/p2b_files.png`、`test/p2b_list.png`。**边界**：自动化不能
合成真实 OS 拖拽 —— `tauri://drag-drop` 用 `plugin:event|emit_to` 投回同一
事件验证逻辑链，OLE 真实路径链路只有手工步骤（`docs/TESTING.md`）。

**Prior: 插件系统 P3 数据层 · 权限强制层 · 私有文件 · 声明式设置（complete) —
as of 2026-09-21**: 差距分析（`docs/PLUGIN_GAP_ANALYSIS.md`）第四阶段，
ROADMAP #26、API 文档 `docs/PLUGIN_API.md` §6F、示例 `examples/plugins/notes/`。
四条**新不变量**，后续改动必须守住：

1. **插件数据的落点是 `<base>/data/plugin_store.db`**（`plugin_store.rs`），
   **独立于 `lume.db`**——卸载 = 删一个文件，插件写坏也波及不到剪贴板/固定项。
   单表 `docs(plugin_id, id, rev, json)`；`_rev` 乐观锁（无 `_rev` = 新建，撞已有
   即 `conflict:`；删除要 rev 匹配；无 tombstone）；上限 512 KB/文档、
   2000 篇/插件（= `allDocs` 上限）、1000/`bulkDocs` 批。**`__` 前缀是宿主内部
   文档**（`__settings` / `__storage`），`db.*` 读不到、写被拒。v1 的
   `storage.json` 在**进程首次访问 store 时**迁进 `__storage`（文件改名
   `storage.json.migrated`，只改名不删），`storage.*` 是垫片（IMMEDIATE 事务）。
2. **权限强制层在 `src/plugins/permissions.ts`**：台账 `RPC_PERMISSION`
   （`app.notify→notify`、`clipboard.*→clipboard`、`http.request→network`、
   `dialog.*→dialog`、`screen.*→screen`、`search.files→search.files`、
   `fs.read*→fs.read`、`fs.writeFile→fs.write`、`app.trash→trash`）是
   `PLUGIN_API.md` §6D.6 的实现，**新增宿主命令必须两边同时登记**。
   校验点是 `createHostApi` 里的 `guardHostApi`（逐方法包一层），所以**插件逻辑
   （启动器窗口内直接持有 API）与 mode 桥接两条路径都覆盖**——初版只在桥接入口
   校验，provider 逻辑整层绕过，被 `cdp_p3_verify` 当场抓出。fail-closed（未知
   插件也拒），拒绝文案带缺失能力词；「全部授权」= `settings.plugins.trusted`。
   **边界**：这是**前端**关卡，mode 页同源可绕过 IPC —— 真正的沙箱留 P4，文档与
   设置页不得暗示已经隔离。
3. **插件私有目录是 `<plugin>/files/`**（`plugin_fs.rs`，无需权限，10 MiB/文件）：
   文件名只能是名字——拒绝分隔符、`.`/`..`、结尾空格/点，以及 `NUL`/`CON`/`COM1`
   等保留设备名（`<dir>\NUL` 是设备不是文件）。任意路径写入是 `fs.writeFile`
   （`fs.write` 能力），不自动造父目录。
4. **声明式设置（`[[settings]]`）以 manifest 为 schema**：`plugin_settings_put`
   拒绝未声明的键（否则作者改键名后老值阴魂不散）；生效值 = 默认值 ⊕ 存储值；
   改动经 Rust `plugin-settings` 事件从设置窗送到启动器 → mode `onSettings` /
   provider / service 钩子 + 页面 `lume.on.settings`（页面 `load` 握手会重放）。

**验证**：cargo test **168**（+17：store rev 契约/上限/内部前缀/allDocs 过滤/
bulk 逐条/迁移幂等/settings 默认值合并、fs 越界与设备名守卫、manifest settings
与 trusted 上报）、tsc/vite build 干净、`scripts/cdp_p3_verify.mjs` **45 项全过**、
P0/P1/P2 三套冒烟无回归（8/14/21）；截图 `test/p3_notes.png`、
`test/p3_plugin_pane.png`。

**踩坑（务必记住）**：debug/release exe 的 `frontendDist` 资源**在编译期嵌进
二进制**——改完前端只跑 `vite build` 时，exe 仍在服务上一版 bundle。跑 CDP 冒烟
前必须 `cargo build`（本轮「权限层不生效」排查了半天的真凶）。

**Prior: 插件系统 P2 入口矩阵与搜索链路（complete) — as of 2026-09-21**: 差距分析
（`docs/PLUGIN_GAP_ANALYSIS.md`）第三阶段核心，ROADMAP #25、API 文档
`docs/PLUGIN_API.md` §6E。四项：① **声明式进入 `[[features]]`**（任意 kind）——
`code`/`label`/`regex`/`over`/`min_length`/`max_length`/`icon`，命中在导航结果
追加「<label>」行（与关键字行同级），激活把查询作为 payload 投递给 mode 的
`onEnter` 或 provider/service 的 `onFeature`；正则在**前端**编译缓存，**匹配空串
的规则被忽略**（`.*` 之类，否则每次按键出行），非法正则记 error 跳过；Rust 用
serde 定向 rename 保持 TOML snake_case / JSON camelCase。② **子输入框**——
`app.setSubInput({placeholder,value})` 接管主搜索框（按键进 `onSubInput`，不再触发
常规搜索），单拥有者、切模式/呼出/重载自动释放。③ **provider 二级下钻**——
行标 `drill: true` → `select(item)` 的行替换网格，Esc 回上一级（新增根级
`onGridEscape` 分层，先于模式 Esc），实现 `filter` 则层内输入过滤。④ **插件互跳
`app.redirect`**——mode 切页 + `onEnter({type:"redirect"})`，目标不可用 toast。
**顺带修掉 P0/P1 遗留的真实竞态**：mode 页 `query`/`show`/`enter` 曾在 iframe 文档
就绪前投递而静默丢失（根因：桥接脚本在 `<head>` 而页面 `lume.on.*` 赋值在
`</body>`；`viewReady` 只表示 HTML 已取回）——现在桥接在页面 `load` 后发
`__lumeReady` 握手，宿主重放 `query`→`show`→本次进入载荷，`enter` 载荷保留到
`reset()` 以便新文档重放（文档已写明「状态重放 / 处理器需幂等」）。验证：cargo
test **151**（+2）、tsc/build 干净、`scripts/cdp_p2_verify.mjs` **21 项全过**、
P0/P1 冒烟无回归；示例 `examples/plugins/text-tools/`（features+下钻+filter+
redirect）与 hello-mode 新增 subInput/enter 演示按钮。

**Prior: 插件系统 P1 宿主能力面（HTTP / 通知 / 剪贴板 / 对话框 / 屏幕，complete)
— as of 2026-09-21**: 差距分析（`docs/PLUGIN_GAP_ANALYSIS.md`）第二阶段，
ROADMAP #24、API 文档 `docs/PLUGIN_API.md` §6D。**零新增 crate**：HTTP 用
`windows` crate 的 WinHTTP（新增 feature `Win32_Networking_WinHttp`），通知用
`Shell_NotifyIconW`。① **`plugin_net.rs`**——宿主 HTTP（Schannel TLS + 系统代理
+ 跟随重定向 + gzip 解压；`spawn_blocking`；http/https 限定、超时 1–60s、4MiB
截断上报），打掉页面 `fetch` 的 CORS 限制（翻译/查词类插件的命门）；4 个单测用
本地 `TcpListener` 起服务器验证 GET/POST/协议拒绝/截断。② **`notify.rs`**——
自注册**隐藏**通知图标（`NIS_HIDDEN`，不占托盘）+ `NIF_INFO` 气泡；**刻意不用
WinRT toast**（非打包/便携应用需要 AUMID + 开始菜单快捷方式）。③ **剪贴板
扩展**（`clipboard.rs`）——`writeImage`（PNG，32MB 上限）/`writeFiles`（CF_HDROP）/
`readFiles`/`paste`（复用 `auto_paste`：隐藏→还焦点→Ctrl+V），并给 auto_paste
的两条静默回退分支补了日志。④ **`plugin_host.rs`**——原生文件对话框
（`tauri-plugin-dialog` blocking API + `spawn_blocking`，取消 = `[]`/`null`，
走 Rust 命令以免给启动器窗口加 `dialog:default` 能力）与光标/显示器几何
（物理像素）。前端三路径（内置/磁盘工厂 `ctx`、iframe `window.lume`）同步，
`http.request` 附 `text()`/`json()`；示例 `examples/plugins/host-tools/`（`h:`
出动作面板）。验证：cargo test **149**（+8）、tsc/build 干净、
`scripts/cdp_p1_verify.mjs` **14 项全过**（页面对比 CORS 直连失败 vs 宿主成功、
图片/文件剪贴板往返、对话框 ESC 取消、屏幕几何、paste 隐藏启动器 + 日志证据）。
**实测结论**：① WebView2 隐藏窗口时 `document.visibilityState` 仍是 "visible"
→ 窗口可见性只能从 OS 侧探测，已产出 `scripts/ps_lume_windows.ps1`（并排除
Tao 内部事件窗口——它的 `MainWindowHandle` 会误导）；② **本机不显示任何通知
气泡**（PowerShell `NotifyIcon.ShowBalloonTip` 对照实验同样不显示 → 系统级抑制），
脚本如实报告该差异而非假装通过。

**Prior: 插件系统 P0（拼音关键字 + provider 动作条目 + 热重载 + 多文件入口，complete)
— as of 2026-09-21**: 对齐 uTools 差距分析（`docs/PLUGIN_GAP_ANALYSIS.md`）的
第一阶段，ROADMAP #23。① **关键字拼音匹配**——`plugins.rs` 扫描时为
`keywords` 预计算拼音（复用 `cache::pinyin_for`，`keywordsPinyin` 字段 serde
camelCase 下发；**坑**：mode 插件注册时漏拷该字段到 `LauncherPlugin` 会导致
前端匹配静默失效），`modeKeywordMatches` 分级匹配：精确 → 前缀 → 首字母 →
全拼（`ms`/`miao` 唤出「秒搜」）。② **provider 动作条目**——`ProviderResult`
新增可选 `description`（网格副行 `.result-box-desc`）/`icon`（data:/URL 直通、
路径走 asset；显式图标行跳过图标管线）/`enter`（激活回调 `onEnter(item)` 而非
`launch_app`，启动器不隐藏；`path` 可省，宿主生成 `lume-plugin://` 合成去重键）。
③ **热重载**——清单 `development` 字段（每次 settings-applied 自动重载）+
设置 → 插件 磁盘行「↻ 重载」按钮（`reload_plugin` 命令 → `plugin-reload`
事件 → `reloadDiskPlugin`：卸载 + 清模块缓存 + 重读清单；`registeredDiskIds`
保证卸载不误伤内置）。④ **多文件 ESM 入口**——清单 `entry` 可为目录（Rust
解析为 `index.js`），前端 `compileDiskModule` 递归把相对 import 改写为 blob
URL（按路径缓存；裸包名不支持）。示例 `examples/plugins/actions/`（即多文件
形态）。验证：cargo test 141（+2）、tsc/build 干净、
`scripts/cdp_p0_verify.mjs` 8 项全过（截图 `test/p0_provider_rows.png`、
`test/p0_settings_plugins.png`）。顺手修存量 tsc 错误（hostApi.ts 缺类型导入）。

**Prior: 提权代理后续修理与生命周期（ROADMAP #22 follow-up, complete) — as of 2026-09-20**:
四个问题的实机修复与一个生命周期改动。
① **注册失败的根因**：`schtasks /Create /XML` 拒绝带 `encoding=` 属性的 XML 声明
（`<?xml… encoding="UTF-8"?>`），报 `错误: 任务 XML 格式错误 (1,40) 无法切换编码`；
`task_xml` 去掉 XML 声明后同一内容即可正常注册（实测带声明一律失败、不带一律成功，
与文件编码无关）。
② **注册失败的原因可见**：提权代理经 `ShellExecuteW(runas)` 分离运行、无控制台，
出错时错误被吞、设置页只显示笼统「注册失败」。现在 `--install-task` / `--uninstall-task`
把结果写 `%TEMP%\lume-agent-install.result`，主进程等回传并展示**真实错误**；
`agent_install`/`agent_uninstall` 改 async + `spawn_blocking` 不卡 UI。
③ **debug 版代理弹黑窗口抢焦点**：只有 release 是 Windows 子系统；改**所有构建**都用
`windows_subsystem="windows"`（GUI 子系统进程不获得控制台）。
④ **更详细的日志**：`agent::ensure_reason` 返回 `AgentUnavailable{NotInstalled,RunFailed,TimedOut}`，
回退到进程内发送时打印具体原因；armed 日志带目标完整性；进程内发送标注目标是否提权。
⑤ **代理用完即灭活（非驻留）**：规则经代理发送完成后立即 `agent::shutdown()`；`shutdown`
改为优雅退出（置 `should_exit`，等 `active==0` 才走），在途注入绝不会被掐断；「登录后
常驻代理」仍保持存活。**权衡**：非驻留每次触发多一轮冷启动（~100–300ms），且与常驻互斥。
验证：cargo test **125 通过（+3）** 全 target 编译干净；实机 UAC 复现并确认修复
（原样 XML 失败 → 去声明后 `Lume\LumeAgent` 注册成功、pe 子系统 = GUI）。
**遗留**：`clipboard::tests::merge_skips_duplicate_last_piece` 是既有 flaky
（1500ms 合并窗口计时，偶发），没碰。

**Prior: 提权注入代理（ROADMAP #22, complete) — as of 2026-09-19**: 自动动作对**以管理员
权限运行的目标程序**永远不生效，根因是 UIPI（`SendInput` 只投递给同级或更低完整性
级别的窗口，且微软文档明确**失败无法从 `GetLastError`/返回值读出**）。完整性级别是
**进程级**属性（线程 impersonation 无法升 IL，UIAccess 文档亦写明无法穿越 IL 边界），
故唯一正确形态是**拆进程**：新增第三个二进制 `lume-agent.exe`（高 IL、无 UI、
只做「向指定前台窗口发一次组合键」），主进程保持中 IL。**零新增依赖/feature**
（`GetNamedPipeClientProcessId`/`MapVirtualKeyW`/`ConvertSidToStringSidW`/
`TOKEN_USER` 所需 feature 全部已在 `Cargo.toml`）。启动靠预先注册的计划任务
`Lume\LumeAgent`（`RunLevel=HighestAvailable`，注册时一次 UAC，之后 `schtasks /Run`
静默，**用 XML 而非 `/SC`** 才能表达 `ExecutionTimeLimit=PT0S`（否则 72 小时杀常驻）与
`MultipleInstancesPolicy=IgnoreNew`）。**安全边界是功能本身**：管道 DACL 只给安装者
SID + SYSTEM（**绝不照抄 `svc.rs` 的 `AU`**，那等于把高 IL 注入器开放给本机所有用户；
SID 取不到就 fail closed）+ 同会话 + 客户端必须是同目录 `lume.exe` + 目标必须是当前
前台且属主 pid 匹配；能力面只有"一次一个组合键"。协议与 LumeSVC 同线格式
（`hello`/`inject`/`stay`/`status`/`shutdown`），失败返回机器 reason
（`uipi`/`blocked`/`not_elevated`/`focus_moved`/`focus_failed`/`no_window`/
`bad_combo`/`unsupported`/`denied_session`/`denied_client`；`needs_agent` 由 Lume 侧产生）。
**顺带修掉两个真实缺陷**：`send_combo` 过去丢弃 `SendInput` 返回值并无条件报成功
（`let _ = …; true`），现在如实记录插入事件数；发送前比较令牌，目标更高 IL 时记
`needs_agent` 而**不再假报成功**；并补 `KEYEVENTF_EXTENDEDKEY`（0xE0 集合；**刻意不加
`KEYEVENTF_SCANCODE`** —— 实机可在原神工作的参照实现并不设该标志）。设置页：自动化页
两个开关（`use_agent` 默认开 / `agent_resident` 默认关，走脏状态）+ 系统页「提权代理」
组（照「系统服务」：OS 为唯一事实源、即时执行、UAC 取消提示、2s 复查；`agent_status`
**只报告不启动**）。**实机抓到的坑**：`Automation` 原为 `#[derive(Default)]`，**整张
`[automation]` 表缺失**（功能上线前写的 settings.toml，本机 dev 文件正是此形态）时走
派生 Default → `enabled` 与新的 `use_agent` 被静默关掉；`#[serde(default = "…")]` 只在
"表存在但缺键"时生效 → 改手写 `impl Default for Automation` + 回归测试。验证：
`cargo test` **122 通过（+16）**、`tsc --noEmit` + `vite build` 干净、
`scripts/cdp_agent_smoke.mjs` **14 项全过**（截图 `test/agent_{automation,system}.png`）、
`scripts/cdp_agent_verify.mjs` **端到端 9 项全过**（自行拉起非提权代理，用
`test_automation_rule` 发 **Alt+F4**，断言 **Notepad3 真的被关掉** +
`sent_total` 0→4）、`cargo test -- --ignored live_agent` 实测过（同用户 DACL 放行 +
非姊妹 exe 被 `denied_client` 拒绝）、并实测到**空闲自杀**（最后一次请求后 >60s 进程自行
退出）。`lume-svc` 代拉与 UIAccess/驱动级方案均记录为明确不做（见 ROADMAP #22.10）。

**Prior: 自研引擎实机修复（ROADMAP #20.1, complete) — as of 2026-08-30**: 用户实测
「Everything UI 关闭后 SVC 引擎无结果」暴露五个连环 bug，全部修复并实机验证：
① 休眠探针被 Everything 无头服务实例（会话 0，无 UI 不响应 IPC）骗成「在
用」→ 改 `ProcessIdToSessionId` 只认交互会话（会话查询失败也偏向建索引）；
② `READ_USN_JOURNAL_DATA_V0` 字段序/大小写错 → 1784，按 MSDN 实布局 40 字节
重写（教训：Win32 结构体必须查文档，"大致知道"必错）；③ 索引静默截断成
USN=0 子集 → `MFT_ENUM_DATA_V0` 的 `LowUsn/HighUsn` 是按记录最后 USN 的过滤
区间，正确值 `[0, NextUsn]`（0/0 = 只要从未 journaled 的文件；MAX = 超范围
返回空）；④ 路径解析全灭 → FRN 高 16 位是 MFT 序列号（根目录引用 =
0x0005_0000_0000_0005 ≠ 5），解析前统一掩码低 48 位；⑤ rename 循环（remove→
upsert 同 FRN）重复 order 条目 → `ordered: HashSet` 成员判定。实机：82.1 万
文件索引秒级构建、门面端到端 110–141ms（管道 + 全表扫描排序）、新建文件
6s 内可搜。**诊断基建**：管道 `debug` 动词（每卷计数/样本/扫描遥测批次/记录
/终止原因）+ `status` 携带失败原因——SCM 下 stderr 不可见，错误必须走管道
回传。验证：cargo test 95（+2）、release lume-svc 实装运行。


**文件秒搜 mode 插件 + 宿主 search 能力 (complete) — as of 2026-08-30**：
统一 API 以宿主能力开放给插件 —— `PluginHostApi.search.files(q, max?)`
（types/hostApi/registry RPC 三处接线，`file_search` 命令加 `max` 参数钳制
1..=100）；磁盘 mode 新增 `lume.on.key` 桥接事件（`createDiskModeInstance
.onKey` 把 window keydown 转发进 iframe——磁盘 mode `rows()` 为空、根网格
键位不生效，模式页自实现 ↑↓/Enter；Esc 仍走根分层不转发）。示例
`examples/plugins/file-search/`（kind=mode：keywords「秒搜/file」进入 +
`lume.search.files(q, 50)` 列表页 + ↑↓/Enter 打开/Ctrl+Enter 复制路径 +
building/backend 状态徽标）。**坑**：`custom-protocol` 在 Cargo.toml 无条件
启用 → **debug exe 也内嵌构建时的 dist/（页面 URL = tauri.localhost）**，
改前端后必须重跑 `pnpm run build` 再 `cargo build`，否则跑的是旧前端
（冒烟表现为 iframe 里桥接缺新方法）。验证：cargo test 93、tsc/build 干净、
`scripts/cdp_filesearch_mode_smoke.mjs`（关键字「秒搜」进入 → iframe 50 行
（meta `everything · 50 项`）→ 窗口 ArrowDown 驱动 iframe 选中 → 截图）。

**Prior: 文件秒搜：统一门面 + Everything IPC + LumeSVC 自研索引 (ROADMAP #20, complete) —
as of 2026-08-30**: `file_search` 命令 = 双后端统一门面（`src-tauri/src/
filesearch.rs`）：**Everything 分支** —— `everything.rs` 纯 Rust 直连
Everything 1.4 的 WM_COPYDATA 协议（官方 SDK 头文件对照，无 DLL 依赖；
worker 线程持 message-only 回复窗口 + 串行化；等待循环必须「泵消息→查槽→
等待」，顺序反了回复会被睡过——实测 3s→7ms）；回复 `path` 是父目录，须拼
文件名成完整路径，否则前端 path 去重误杀同目录命中。**SVC 分支** ——
`usnidx.rs` USN/MFT 全盘索引（`FSCTL_ENUM_USN_DATA` 全量 + 每卷阻塞式
journal watcher 零空闲 CPU；小写 arena + Horspool 查询；FRN 父链路径解析）；
svc.rs 管道升级为长度前缀 JSON 多动词（hello/search/status），**写完回复须
再阻塞读等客户端挂断再 Disconnect**（否则回复被丢弃，lost-reply 竞态）；
休眠策略 = 每 60s toolhelp 探测 Everything 进程（SYSTEM 会话不能
FindWindow 跨会话窗口），在跑则弃索引、消失则懒建（generation 防过期落地）。
门面：Everything 窗口探测 → IPC 查询(600ms) → SVC 管道(800ms, 独立线程 +
recv_timeout) → unavailable；失败后端 10s 冷却；async 命令 + spawn_blocking
（同步命令跑主线程会卡 UI）。前端 `runSearch`：search_apps 与 file_search
Promise.all 并行，合并序 = 原生 → 关键字行（不能后移，20 封顶会挤掉）→
文件命中(12) → provider，合计 20 + path 去重 + requestSeq 令牌。验证：
cargo test 93（+13）、tsc/build 干净、ignored live_query 7–8ms/次、
`--foreground` 管道双动词（state:"off" 实证休眠）、`scripts/
cdp_filesearch_smoke.mjs` 网格 15 行 = 3 原生 + 12 文件；`live_scan`
（MFT 实扫）需管理员，留提权环境。

**Prior: 插件系统 v1 + 剪贴板/预览插件化（ROADMAP #7, complete) — as of 2026-08-30**:
插件 = 清单（`<base>/plugins/<id>/plugin.toml`）+ 前端贡献；Rust `plugins.rs`
（扫描/`get_plugins`/`set_plugin_enabled` + `settings.plugins.disabled`，单测 ×3）；
前端 `src/plugins/`（registry + 契约）。**剪贴板** = 首个 mode 贡献
（`src/plugins/clipboard/`：store/view/键处理/搜索/记住页面/设置切片全内聚，
`ModeInstance` 契约含 `onKey`/`onEscape`/`previewTarget`/`pageKind`/
`applySettings`）；**预览** = 独立 service 贡献（`src/plugins/preview/`：防抖
show/close + `currentPreview` Esc 优先级；窗口生命周期留核心）。App 以
`PluginServices` 开放组合根能力（toast/搜索管线+`searchToken`/`markMouse`/
`openMenu`/`requestMode`），模式 pill 与页面从注册表渲染（`<Dynamic
component={activeMode().View}>`）。**新约定**：新增模式 = 写一个
`create*Plugin(services)` 并 `definePlugin`，壳零改动；右键菜单的剪贴板
动作经 `clipMenuActions()` 窄接口供给；ModeInstance 的 `search` 自带
stale-token 守卫（根 `requestSeq` 即令牌）。验证：cargo test 77、截图 5 组
judge 等价、三套 CDP 冒烟全过。**第二轮（同日）**：provider 搜索贡献
（`ProviderInstance.search` → 结果追加原生后，path 去重封顶 20）、第三方
JS 动态加载（磁盘清单 `kind=provider` + `entry` → asset 协议 + blob
`import()`，默认导出 `{search}`；每插件只加载一次；信任模型=显式放置即
信任，`permissions` 预留）、设置第 8 分区「插件」（PluginsPane，启停经
`set_plugin_enabled`，关闭活动模式自动回导航页）。示例
`examples/plugins/web-search/` + `docs/PLUGINS.md`。settings 冒烟断言
更新为 8 分区。**第三轮（同日）**：mode/service 磁盘加载 + 宿主能力 API
（uTools 式）——磁盘 mode = `view` HTML 桥接 iframe（`src/plugins/
iframeBridge.tsx`：`window.lume` Promise RPC + `lume.on.query/show/hide`
事件，同源 srcdoc 注入桥）+ 可选 entry 钩子 + `keywords` 全局关键字进入
（`lume-mode://<id>` 合成行在 activateApp 拦截切模式）；磁盘 service =
`lifecycle` 钩子（onShow/onHide/onQuery）；宿主 API `PluginHostApi`
（`hostApi.ts`：app.hide/toast/setQuery/openPath + clipboard 读写（新命令
`get/set_clipboard_text`）+ 插件私有 KV 存储（新命令 `plugin_storage_get/
set` + storage.json + id 消毒））。main.js 默认导出 = 工厂 `create(ctx)`
（v1 纯对象向后兼容）。**坑**：`import()` 返回命名空间必须取 `.default`；
`plugins` 注册数组是普通的——disk 加载后须 clone manifests 信号触发
响应式（否则 pill 不出现）。示例 `examples/plugins/hello-mode/`。**第四轮（同日）**：导航页栏目注册表
重构 + 插件 `navBars` 钩子 —— 三个原生栏（最近使用/已固定/资源管理器）与
插件栏统一为 `NavSection` 契约（`navigate.ts` 的 `sections()` 是唯一注册
表，顺序 = recent → pinned → 插件栏 → explorer **结构性固定最下层**），
`NavigateView` 单一 `SectionView` 渲染（条目级图标覆盖/mono/wrap），连续
网格键盘导航、拖拽排序、Delete 软删、sizer 的 work-area cap（`anyExpanded`）
全走注册表；拖拽 dragover 按 `data-bar-id` 限定到被拖栏（顺手修了跨栏拖拽
误算插入位的隐患）。任意 kind 的磁盘插件可在工厂逻辑实现 `navBars()` 贡献
栏目（`NavBarContribution`：`{id,title,items:[{name,path,icon?}]}`；id 加
插件前缀、每栏 50 条封顶、icon data:/URL 直通/本地路径转 asset；调用时机 =
组合/每次呼出/settings-applied；条目激活 = `launch_app`、右键 = 共享 app
菜单）。示例 `examples/plugins/nav-bar/`。**第五轮（同日）**：① 修**磁盘
mode 尺寸继承** —— `createDiskModeInstance` 的 `search`/`reset` 补调
`services.scheduleResize()`（对齐 ModeInstance 契约；此前切入 iframe 页窗口
停在上一页面尺寸）。② **插件自定窗口尺寸** —— 清单新增 `height` 字段
（Rust manifest/PluginInfo 透传），sizer fixed 分支经 ModeInstance 可选
`desiredHeight()` 取值（钳制 90px…工作区-32px，未声明回退全局设置高度）；
桥接 RPC `app.resize`（`PluginServices.resizeWindow`；`runtimeSize` 信号 =
sizer 每次 setSize 上报的"当前尺寸"基线，省略轴保持当前值，尺寸保持到下一
次内容驱动的 resize）。hello-mode 示例加 `height = 560` + resize 按钮。
③ 修**导航页 ↓ 不换栏** —— `moveBarSelection` 的「低位行不达当前列 → 跳到
本栏末尾条目」回退改为 `commitGrid(下一行)`（列钳进下一栏；同栏部分行仍落
栏尾，与旧行为一致）。④ 修**剪贴板键盘导航失效** —— 根
`moveSelection`/`runSearch`/`clearSearch` 的选中读写原来只动根 `selected`
信号，而剪贴板 store 持有自己的 `selected`（视图高亮/激活读它）→ 两个信号
漂移、↑↓ 表现为无反应；新增 `activeSelected`/`setActiveSelected` 按模式
路由（插件模式走 ModeInstance accessors）。⑤ 修**导航页选中反馈消失** ——
NavigateView 重构把 `zoneActive() && i() === selected` 以普通布尔传入
itemBox，而 `<For>` 回调非追踪作用域 → classList 冻结初值；选中态改访问器
传入、classList 属性位求值（网格从整体重建变细粒度 class 更新）。**Solid
教训**：For 回调内跨普通函数边界传计算值会丢响应式——必须在 JSX 属性位置
以访问器求值。验证：tsc/build 干净、cargo
test 79（+height 断言）。

**Prior: 拆分 App.tsx 为 launcher 模块（零行为变化 refactor, complete) — as of
2026-08-30**: 2510 行的单文件拆为 `src/launcher/` 11 个模块（types/clipData/
icons/sizing/navigate/clipboard/menu/keyboard/previewSync/NavigateView/
ClipboardView），`App.tsx` 收敛为组合根（787 行：搜索召回/模式切换/挂载监听
+ 接线）。**约定**：跨模块依赖走 deps 对象后绑定（App 按序创建各工厂并补齐
deps；动作只在挂载后执行所以安全）；`selectionSource`/`entryOpened`/`requestSeq`
三个跨域可变量留在组合根经 deps 共享；视图组件以 props 接收 store（信号访问器
跨模块天然响应式）。`lastWindowH` 全局移入 sizer 工厂。为 ROADMAP #7 插件系统
预备模式边界。验证：tsc/build 干净、前后截图 5 组 judge 等价验收、
`cdp_feature_smoke`（修了设置页重排前的过时断言：剪贴板面板首个组标题现为
「历史记录条数上限」）+ `cdp_launcher_shots.mjs`。**经验教训**：CDP 调试脚本
对隐藏窗口 evaluate 可能挂起（内存裁剪态的 settings/preview 页）——先
`toggle_launcher` 再查询；多轮 kill/spawn 后的 WebView2 僵尸进程会让截图
出现「数据加载不出」的假象——对比前先 `taskkill msedgewebview2.exe`。
Details in `docs/ARCHITECTURE.md` Frontend 一节。

**Prior: 设置页分组卡片重排（对齐 Flutter 设置，complete) — as of 2026-08-30**: main 的
设置窗口（仍为 SolidJS WebView2）信息架构对齐 `feat/flutter-settings` 的 Flutter
独立设置 exe：顶栏（Lume + 「搜索设置」框，`SECTION_SEARCH_KEYS` 按分区 i18n 键
清单过滤、匹配分区堆叠显示）+ 7 分区导航（外观/导航页/剪贴板/快捷键/搜索/系统/
关于，删除「插件」占位）+ 居中 720px 分组卡片列（`--surface-raised` 卡片、
accent 组标题、标签左控件右）+ 底栏「恢复默认设置 + 保存并应用」；窗口
720×560 → 940×660。**恢复默认 = 两步语义**（重置 `DEFAULT_SETTINGS` 工作副本
并标脏，需再点保存落盘；`restore_default` 命令保留但 UI 不再调用）。
**档位对齐 Flutter**：宽度 540/720/900、高度 420/520/620、条目框 70/110/150、
最近使用 10/20/30/50、合并窗口 500–5000ms 连续滑块（旧非默认值仍生效仅 chip
不高亮）。**schema 迁移**：`index.user_dirs`/`user_dirs_no_files` →
`index.user_index: [{name, path, no_files}]`（`Index::migrate()` 读取时一次性
转换，name=basename；`cache.rs::live_dirs`/`dirwatch.rs` 改读；与 Flutter 版
settings.toml 互通）。**main 独有项保留**：窗口位置「自定义」、快捷键预设
chips（WebView2 录不到 Alt+Space）+ `validate_hotkey` 实时校验、用户索引每行
「索引文件」开关、刷新索引按钮 + toast、恢复备份设置、系统索引中文标签；
**新增**：「记住勾选」进入设置页（预览组）。实现：`Settings.tsx` 壳 +
`AppearancePane`/`LauncherPane`/`ClipboardPane`/`HotkeysPane`/`SearchPane`/
`SystemPane`/`AboutPane` + `controls.tsx` 共享控件（`InterfacePane.tsx` 删除）。
注意 SectionBody 分支必须用 `<Switch>/<Match>`（函数体 switch 会在首挂载僵死，
ROADMAP #13.5 同款陷阱）；`.settings-body` 居中必须带 `width: 100%`
（纯 `margin: 0 auto` 会禁用列 flex 交叉轴 stretch 导致收缩）。i18n +20 键
三语言。验证：`cargo test` 74（+`legacy_user_dirs_migrate_to_key_value_index`）、
`tsc --noEmit`、`vite build`、`scripts/cdp_settings_smoke.mjs` 9 项 + judge
6 截图全过。Details in `docs/SETTINGS.md`。

**Prior: WebView2 闲置内存裁剪 (ROADMAP #18, complete) — as of 2026-08-21**: 三个常驻 webview
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
**Follow-up（2026-08-21，搜索状态召回，见 ROADMAP #17.5 补充）**：搜索词在**未打开条目**时
保留到下次呼出（`clearSearch` 的 `recall` = 未打开 + 5 min TTL 内 + 当前模式有活跃查询 → 保留
mode/query 不动）；**打开条目**（启动/回车/粘贴/开链接/开终端，置 `entryOpened`）即清空、下次呼出
回导航页；**超过 5 分钟未再次呼出**也回导航页。`remember_last_page` 的 mode/category 页面恢复
**不受 TTL 限制**，仅被「打开条目」覆盖。前端 `tsc --noEmit` + `vite build` 通过。

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

Not yet implemented (future): plugin system follow-ups (permissions layer,
plugin-level settings UI); SVC USN index hardening (non-NTFS volumes, orphan
GC, index persistence across service restarts, file-search settings UI);
clipboard page redesign (ROADMAP #10.4, design pending) — see
`docs/ROADMAP.md`.
