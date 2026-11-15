# AGENTS.md

本文件是本仓库（Lume 启动器）的工作守则。
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
  如 `26.11.2`）；内部 semver 在 `package.json` / `src-tauri/tauri.conf.json` /
  `src-tauri/Cargo.toml`（当前 `3.5.2`，tauri 构建强校验 semver）。发布时两处手动同步。

## 目录

- `src/` 前端：`App.tsx` 是组合根（勿再膨胀）；页面全是插件（`src/plugins/`，内置
  navigate/clipboard/preview）；共享模块在 `src/launcher/`；设置窗 `src/settings/`。
- `src-tauri/src/` Rust 核心：一模块一职责（`window` / `apps` / `clipboard` / `hotkey` …
  插件相关 `plugins*` / `plugin_*`）。新命令统一在 `lib.rs` 的 `generate_handler!` 注册，
  暴露给 webview 的还要进 `src-tauri/capabilities/*.json`。
- `docs/`（见上）、`languages/*.json`（en / zh-CN / zh-TW）、`res/`（只读资源）、
  `examples/plugins/`（插件示例，其 `dist/` 是源码的一部分，勿 gitignore）。
- `docs/History/`：退出活跃文档集合的报告、审计与被取代方案；索引与归档规则见 `docs/History/README.md`。
- `scripts/`：`test-harness/` = 分层 CDP 套件与隔离运行器；`cdp_*.mjs` = 尚未迁移的专项回归；
  `verify.mjs` = 统一验证入口；`package-portable.mjs`、`package-installer.mjs`、
  `package-zip.sh` = 便携包/安装包构建。
- `test/` = 本机 scratch（截图/日志，已 gitignore），临时产物都丢这里。

## 命令

```bash
pnpm install                       # 前端依赖（.npmrc 已指 npmmirror 镜像）
pnpm run build                     # 前端生产构建 → dist/（含 TS/SolidJS 报错）
pnpm exec tsc --noEmit             # 单独类型检查
pnpm verify:docs                   # 活跃文档链接、UTF-8 与测试清单
pnpm verify:fast                   # 静态检查、前端单测/构建、Rust 单测
pnpm verify:ui                     # 按需构建一次 debug exe，再跑隔离 UI 套件
pnpm verify:ui:changed             # 按当前 diff 选择 UI 套件
pnpm verify:release                # 发布前自动门禁
cd src-tauri && cargo check        # Rust 类型检查
cd src-tauri && cargo test         # Rust 单测（不碰注册表/服务/真实 UAC）
pnpm run tauri dev                 # 开发（页面走 vite dev server :1420，需先启动；有控制台窗口）
pnpm run tauri build --debug --no-bundle   # 独立 debug exe（内嵌 dist，CDP 冒烟用这个）
pnpm run tauri build --no-bundle           # 独立 release exe（无控制台，可分发的形态）
pnpm run package:zip               # 便携 zip 发行包
pnpm run package:installer         # MicaSetup EXE 安装包（需 .NET SDK + VS MSBuild；无 MSI/NSIS）
```

- **pnpm 传参**：额外参数直接跟在脚本名后（`pnpm run tauri build --no-bundle`），
  **不要加 `--` 分隔符**——pnpm 会把它原样转发给 tauri 导致 `cargo: unexpected argument`。
- **CDP 冒烟**：优先 `pnpm verify:ui --suite ...`。新 harness 会把 exe、语言、资源和 fixture
  复制到 `test/verify/<run>/<suite>/runtime/`，使用空数据目录、动态端口和 debug-only
  `LUME_INSTANCE_ID`，只终止自己的进程树。源码比嵌入式 exe 新时自动构建一次；Tauri 的
  `beforeBuildCommand` 已负责前端构建，不要再手工先跑 `pnpm run build`。
- **旧 CDP 脚本**：`node scripts/cdp_*.mjs` 仍可用于专项回归，但它们可能全局 `taskkill`、
  固定端口并改写 `src-tauri/target/*` 下的测试数据。通过 `pnpm verify:legacy --group ...`
  显式运行，不要和用户正在使用的 Lume 并行。

## 硬性约定

1. **业务逻辑属于 Rust**，webview 只是视图层：只 `invoke` + 渲染，**前端不碰数据库**。

2. 所有 UI 字符串走 `t()`（`src/i18n.ts` + `languages/*.json`）；三语键必须同步，
   `Messages` 类型以 en.json 为准，缺键会导致 `tsc` 报错。

3. Windows-only：优先原生 API（`ShellExecuteW`、`RegisterHotKey`…），不要绕 shell。

4. 最小化：每个新功能都要能回答「是否让用户更快」；能删的功能不维护。

5. 网络不可靠：**一律用镜像源**（npm → `.npmrc`；crates / NuGet 同理），不要引入需直连被墙端点的依赖。安装包工具固定 MicaSetup 2.5.7，走华为云 NuGet 并校验 SHA-512。

6. UI 视觉契约见 `docs/UI_GUIDELINES.md`：面板 / DWM 边框 / 插件页画布同为 `--surface`
   （一块连续面板，uTools 式拼接）——不给 `.launcher` 加 border / radius / 半透明。

7. WebView2 内建快捷键（Find / Print / Reload / DevTools / 历史导航）在
   `src/launcher/keyboard.ts` 统一屏蔽；只有 Lume 自己的键与搜索框文本编辑放行。

8. **文档规范**：任何文档（docs/、README、代码注释中的文档性引用）**不得出现阶段性
   分期编号**（P0/P1/P2/P3/P4/P5/P6、Phase 1、阶段名）与完成状态标志
   （✅、"已实现"、"已完成"）；文档只描述当前契约或开放事项，历史进度一律归
   `CHANGELOG.md` 与 `docs/ROADMAP_HISTORY.md`。

9. **文档归档**：报告、审计或被取代方案不再承担现行约束后，移入 `docs/History/`；
   仍有开放发现时先转入 `docs/ROADMAP.md` 或现行契约，不随报告静默丢失。归档时
   更新所有入链、图片路径和代码注释，并在 `docs/History/README.md` 登记；历史档案
   只供追溯，不反向定义现状。

10. **测试生命周期**：新回归优先加入现有 `scripts/test-harness/suites/`；只有生命周期、
    fixture 或隔离边界确实不同才新增套件。临时 repro 留在 `test/`。永久套件必须登记
    `scripts/test-manifest.json`，旧脚本在等价覆盖迁入后合并或删除。不要在每次改动时
    默认全跑所有历史 CDP 脚本。

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
- **旧脚本的 dev / 测试 base = `src-tauri/target/{debug,release}/`**：`settings/settings.toml`、
  `data/lume.db`、`plugins/` 都在那里。新 harness 的 base 是
  `test/verify/<run>/<suite>/runtime/`，每次从空设置、空数据库、空插件目录开始。
- `settings/` 三文件：`settings.toml` 唯一生效、`default.toml` 出厂只读、`backup.toml`
  每次保存/应用/导入前快照。`data/lume.db` 存用户数据（clipboard / pinned_apps /
  recent_apps），另有可随时重建的索引缓存 db；插件文档库在 `data/plugin_store.db`（独立文件）。
- **新增 settings 字段**一律 `#[serde(default = "…")]`；注意「整张表缺失」会走字段自身
  `Default`——派生 `Default` 会把 bool 全关掉，需要就手写 `impl Default`（有回归测试钉住）。

## 验证与交付

- 日常代码改动先跑 `pnpm verify:fast`；失败时如实报告输出，修复后再交付。
  `pnpm verify:fast` 已包含 TypeScript、i18n、前端单测、前端构建和 Rust 单测。
- UI/插件改动按 [docs/TESTING.md](docs/TESTING.md) 的变更矩阵跑对应
  `pnpm verify:ui --suite ...`；`pnpm verify:ui:changed` 可用于按 diff 选套件。
  旧的 `pnpm verify:legacy --group ...` 只在专项边界需要时运行。
- 发布前跑 `pnpm verify:release`，再按 `docs/MANUAL_TESTING.md` 完成真实 UAC、服务注册、
  真实拖拽、实机快捷键与原生窗口检查。`cargo test` 有意不碰这些。
- 不要用“脚本数量”衡量覆盖。记录实际套件、断言数、耗时和产物路径；新测试必须能说明
  它保护的契约和维护成本。
- 每轮收尾同步文档：`docs/ROADMAP.md`（新功能先在此立项为开放事项；完成后从开放
  事项删除，实现/踩坑/验证写入 `docs/ROADMAP_HISTORY.md` 新条目——**迭代详情以
  归档为准**）+ `CHANGELOG.md` 的 `[Unreleased]`（按仓库条目风格带验证数据）+
  相关 docs（PLUGIN_API / SETTINGS / ARCHITECTURE / TESTING）。**禁止在活跃文档
  写进度标记或分期编号**（见硬性约定 8）。
- CDP 观测 tap：`window.__frameStates` / `__rpcLog` / `__logicCircuit` / `__snapPending` 等
  是既有探针（见 PLUGIN_API §15），诊断帧/桥问题时先用它们。
- **安装包构建**：MicaSetup 模板是 net472/WPF，只有 .NET Runtime 不够；`package:installer`
  会把已发现的 .NET SDK 路径传给 VS MSBuild，并关闭 workload resolver。Mica 配置不会改
  AssemblyCompany/Product/Description，Lume 品牌由 `scripts/installer/` 的模板补丁注入。
- **安装包许可证**：MicaSetup 2.5.7 配置自定义 LicenseFile 后会删除按语言拆分的许可证资源，
  但 WPF 项目仍引用它们；安装器许可证页保持关闭，`LICENSE` 与第三方 notices 随 payload 安装。

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
- **CDP 冒烟必须使用嵌入式 build**：`pnpm verify:ui` 会在需要时执行
  `pnpm run tauri build --debug --no-bundle`。直接 `cargo build` 出的是 dev 模式 exe
  （页面指 `http://localhost:1420`，无 vite 时白屏）。
- **CDP 调试**：对隐藏窗口（内存裁剪态）`evaluate` 可能挂起（先 `toggle_launcher` 再查）；
  旧脚本多轮 kill/spawn 后的僵尸 `msedgewebview2.exe` 会造成「数据加载不出」假象。
  新 harness 通过独立运行目录和自有进程树避免这种污染；排查旧脚本时优先关闭对应测试实例，
  不要默认全局清理所有 WebView2 进程。
