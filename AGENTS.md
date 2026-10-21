# AGENTS.md

本文件是 ZCode agent 在本仓库（Lume 启动器）的工作守则。
改代码前至少过一遍 `docs/ARCHITECTURE.md`、`docs/UI_GUIDELINES.md`；
插件相关再加 `docs/PLUGIN_API.md`（API 参考）与 `docs/PLUGINS.md`（上手）；
设置相关看 `docs/SETTINGS.md`。功能现状见 `README.md` 的 Status；
开放事项见 `docs/ROADMAP.md`，进度与历史见 `CHANGELOG.md` / `docs/ROADMAP_HISTORY.md`。

## 项目速览

Windows 轻量启动器（Spotlight / uTools 式）。前端 SolidJS + TypeScript + Vite（`src/`），
后端 Rust + Tauri v2（`src-tauri/`），数据 SQLite（`rusqlite` bundled）。

- **三个二进制**（便携布局，都在 exe 同级）：`lume.exe`（启动器，中完整性）、
  `lume-svc.exe`（SYSTEM 文件索引服务）、`lume-agent.exe`（提权按键注入代理）。
- **双版本号**：对外标签 `src/appVersion.ts` 的 `APP_VERSION_LABEL`（About 页渲染，
  如 `Pre-26.10.1`）；内部 semver 在 `package.json` / `src-tauri/tauri.conf.json` /
  `src-tauri/Cargo.toml`（当前 `3.2.0`，tauri 构建强校验 semver）。发布时两处手动同步。

## 目录

- `src/` 前端：`App.tsx` 是组合根（勿再膨胀）；页面全是插件（`src/plugins/`，内置
  navigate/clipboard/preview）；共享模块在 `src/launcher/`；设置窗 `src/settings/`。
- `src-tauri/src/` Rust 核心：一模块一职责（`window` / `apps` / `clipboard` / `hotkey` …
  插件相关 `plugins*` / `plugin_*`）。新命令统一在 `lib.rs` 的 `generate_handler!` 注册，
  暴露给 webview 的还要进 `src-tauri/capabilities/*.json`。
- `docs/`（见上）、`languages/*.json`（en / zh-CN / zh-TW）、`res/`（只读资源）、
  `examples/plugins/`（插件示例，其 `dist/` 是源码的一部分，勿 gitignore）。
- `scripts/`：`cdp_*.mjs` = CDP 冒烟/验证脚本；`package-portable.mjs`、`package-zip.sh` = 打包。
- `test/` = 本机 scratch（截图/日志，已 gitignore），临时产物都丢这里。

## 命令

```bash
pnpm install                       # 前端依赖（.npmrc 已指 npmmirror 镜像）
pnpm run build                     # 前端生产构建 → dist/（含 TS/SolidJS 报错）
pnpm exec tsc --noEmit             # 单独类型检查
cd src-tauri && cargo check        # Rust 类型检查
cd src-tauri && cargo test         # Rust 单测（不碰注册表/服务/真实 UAC）
pnpm run tauri dev                 # 开发（页面走 vite dev server :1420，需先启动；有控制台窗口）
pnpm run tauri build --debug --no-bundle   # 独立 debug exe（内嵌 dist，CDP 冒烟用这个）
pnpm run tauri build --no-bundle           # 独立 release exe（无控制台，可分发的形态）
pnpm run package:zip               # 便携 zip 发行包（现阶段唯一分发格式；无 MSI/NSIS）
```

- **pnpm 传参**：额外参数直接跟在脚本名后（`pnpm run tauri build --no-bundle`），
  **不要加 `--` 分隔符**——pnpm 会把它原样转发给 tauri 导致 `cargo: unexpected argument`。
- **CDP 冒烟**：`node scripts/cdp_*.mjs`。脚本自己 `taskkill` 旧进程、拷贝示例插件到
  `src-tauri/target/{debug,release}/plugins/`、以
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=NNNN` 拉起**已构建的 exe**
  （不启动 vite），逐项打印 `PASS/FAIL`，有任何失败 `exit 1`。所以跑之前必须先构建（见「验证」）。

## 硬性约定

1. **业务逻辑属于 Rust**，webview 只是视图层：只 `invoke` + 渲染，**前端不碰数据库**。
2. 所有 UI 字符串走 `t()`（`src/i18n.ts` + `languages/*.json`）；三语键必须同步，
   `Messages` 类型以 en.json 为准，缺键会导致 `tsc` 报错。
3. Windows-only：优先原生 API（`ShellExecuteW`、`RegisterHotKey`…），不要绕 shell。
4. 最小化：每个新功能都要能回答「是否让用户更快」；能删的功能不维护。
5. 网络不可靠：**一律用镜像源**（npm → `.npmrc`；crates 同理），不要引入需直连被墙端点的依赖。
6. UI 视觉契约见 `docs/UI_GUIDELINES.md`：面板 / DWM 边框 / 插件页画布同为 `--surface`
   （一块连续面板，uTools 式拼接）——不给 `.launcher` 加 border / radius / 半透明。
7. WebView2 内建快捷键（Find / Print / Reload / DevTools / 历史导航）在
   `src/launcher/keyboard.ts` 统一屏蔽；只有 Lume 自己的键与搜索框文本编辑放行。
8. **文档规范**：任何文档（docs/、README、代码注释中的文档性引用）**不得出现阶段性
   分期编号**（P0/P1/P2/P3/P4/P5/P6、Phase 1、阶段名）与完成状态标志
   （✅、"已实现"、"已完成"）；文档只描述当前契约或开放事项，历史进度一律归
   `CHANGELOG.md` 与 `docs/ROADMAP_HISTORY.md`。

## 插件系统（改动前必读 `docs/PLUGIN_API.md`）

- 插件 = `<base>/plugins/<id>/plugin.toml` 清单 + 贡献：`kind = provider | mode | service`；
  内置插件（apps / clipboard / preview）走**同一注册表与启停路径**。
- 权限是三层防线：沙箱 iframe（mode 页）+ Rust 命令侧按 plugin_id 白名单
  （`plugin_perm.rs`，直连 `invoke` 也拦）+ 前端 `src/plugins/permissions.ts`（fail-closed）。
  未在清单 `permissions` 声明的能力调用即失败。
- 新增宿主能力要同时改：`hostApi.ts` 的 RPC、`permissions.ts` 的 `RPC_PERMISSION` 台账、
  Rust 侧校验；跨 postMessage 的结果必须是可结构化克隆的（函数会炸）。
- 改前端后必须重建 exe 才在冒烟里生效（`frontendDist` 是**编译期**嵌进二进制的）。

## 数据与路径（便携 / 安装双模式）

- `paths::base_dir()` 判定：便携 = exe 同级目录；exe 在 Program Files 下 = `%LOCALAPPDATA%\Lume`
  （只拷不删地迁移）。`lume-svc` 从 `HKLM\Software\Lume\DataDir` 读同一目录。
- **dev / 测试时 base = `src-tauri/target/{debug,release}/`**：`settings/settings.toml`、
  `data/lume.db`、`plugins/` 都在那里——找设置/DB/插件不要去仓库根找。
- `settings/` 三文件：`settings.toml` 唯一生效、`default.toml` 出厂只读、`backup.toml`
  每次保存/应用/导入前快照。`data/lume.db` 存用户数据（clipboard / pinned_apps /
  recent_apps），另有可随时重建的索引缓存 db；插件文档库在 `data/plugin_store.db`（独立文件）。
- **新增 settings 字段**一律 `#[serde(default = "…")]`；注意「整张表缺失」会走字段自身
  `Default`——派生 `Default` 会把 bool 全关掉，需要就手写 `impl Default`（有回归测试钉住）。

## 验证与交付（每次改动必编译）

- 前端：`pnpm run build`（必要时 `pnpm exec tsc --noEmit`）；Rust：`cd src-tauri && cargo check`
  + `cargo test`。**编译或测试失败不允许声称完成**——如实报告失败输出，修复后再交付。
- 改前端后跑 CDP 冒烟前：`pnpm run build` + `pnpm run tauri build --debug --no-bundle`
  （或 release 版）重建 exe，否则测到的是上一版内嵌 bundle。
- 手工项不要自动化：注册服务/代理、UAC、真实拖拽、实机快捷键等按 `docs/TESTING.md`
  手工清单验证；`cargo test` 有意不碰这些。
- 每轮收尾同步文档：`docs/ROADMAP.md`（新功能先在此立项为开放事项；完成后从开放
  事项删除，实现/踩坑/验证写入 `docs/ROADMAP_HISTORY.md` 新条目——**迭代详情以
  归档为准**）+ `CHANGELOG.md` 的 `[Unreleased]`（按仓库条目风格带验证数据）+
  相关 docs（PLUGIN_API / SETTINGS / ARCHITECTURE / TESTING）。**禁止在活跃文档
  写进度标记或分期编号**（见硬性约定 8）。
- CDP 观测 tap：`window.__frameStates` / `__rpcLog` / `__logicCircuit` / `__snapPending` 等
  是既有探针（见 PLUGIN_API §15），诊断帧/桥问题时先用它们。

## 踩坑清单（实测固化，改动时别踩回去）

- **Tauri 同步命令跑在主线程**：读文件、解码图片、查大表这类重活必须 `async` /
  `spawn_blocking`，否则会卡住所有 IPC（含窗口 `set_size`），表现为 UI 假死。
- **首屏设置注入**：生效设置由 `lib.rs` 用 initialization script 注入
  `window.__LUME_CONFIG__`，前端首帧同步读取（不等异步 IPC）——新增设置项要同时
  接线注入与读取，否则首次渲染只能拿到默认值。
- **SolidJS 响应式**：`<For>` 回调里跨普通函数边界传计算值会丢响应式（classList 冻结初值）
  ——在 JSX 属性位置以访问器求值。
- **剪贴板 probe 与 reader 必须同链**：`plugin_clipboard_has_image` 的格式判定与
  `plugin_clipboard_read_image` 的采集链是同一逻辑的镜像，改一边必须改另一边。
- **hook 转发按 entry 门控**：mode 实例（`createDiskModeInstance`）对无 `entry`
  的纯视图插件也存在，`clearSearch` 每次呼出/隐藏广播 `setQuery("")` 会经过它
  ——转发进逻辑中继的调用注定无人应答（宿主无帧、supervisor 静默丢弃 → 8s
  超时），必须用 `hasLogic` 拦下；`logicCall` 对 `logicLoadedIds` 之外的 id
  快速失败且不计熔断，别把这个豁免改回去（否则每次呼出给纯视图 mode 计一次
  失败，3 轮呼出就弹「连续调用失败」，插件从未被打开，#32.12）。
- **磁贴重排是 pointer events 版**：主窗口的 Tauri drag-drop handler 必须保持启用（真实
  拖入路径只有 OLE drop target 拿得到）；改回 HTML5 DnD 会同时废掉拖入与重排。
- **提权边界**：`lume.exe` 永远保持中完整性（`Nothing higher-integrity runs in the launcher
  process`）；唯一提权代码在 `lume-agent.exe`，能力只有「向指定前台窗口发一次配置好的热键」。
  `SendInput` 受 UIPI 限制且失败不可读——失败要如实上报 reason，不许假报成功。
- **分离窗口的事件监听必须带 `target`**：Tauri 的 JS `listen()` 默认目标是
  `EventTarget::Any`，而 `emit_to` 的过滤器只看**监听器**目标（每个 webview 都会被遍历）
  —— 不带 `target` 的监听器会收到**所有**其它插件的 `emit_to` 流量。单窗口时看不出
  （载荷相同），一旦载荷带插件私有值就串台（docs/ROADMAP_HISTORY.md #36 实测：hello-mode 的窗口按
  file-search 的 `themePref` 重刷了自己）；两个独立窗口并存时，关闭请求也是广播的，
  会「关一个连带关另一个」。插件私有事件一律
  `listen(ev, fn, { target: getCurrentWindow().label })`，应用级事件（`settings-applied`）
  保持全局。
- **沙箱帧探测不了，验证要看渲染结果**：srcdoc 视图帧的 CDP execution context 对宿主
  target 不可见，`DOM.getDocument({pierce:true})` 也查不到它的节点（`querySelector`
  返回 0），host→页面的 `postMessage` 也无法从探针伪造（`__lumeRpc` 是页面→宿主方向）。
  要断言页面真的变样了，用 1×1 `Page.captureScreenshot` clip + `zlib` 解 PNG 采像素
  （`scripts/cdp_plugin_theme_verify.mjs`），页面动作由示例页的 `on.query` 钩子驱动。
- **CDP 冒烟必须用 `pnpm run tauri build --debug --no-bundle`**：直接 `cargo build`
  出的是 dev 模式 exe（页面指 `http://localhost:1420`，无 vite 时白屏，探针找不到
  `#search-input` 只会报「launcher window missing」）。
- **CDP 调试**：对隐藏窗口（内存裁剪态）`evaluate` 可能挂起（先 `toggle_launcher` 再查）；
  多轮 kill/spawn 后的僵尸 `msedgewebview2.exe` 会造成「数据加载不出」假象，对比前先
  `taskkill /F /IM msedgewebview2.exe`。
