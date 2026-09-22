# Lume 插件系统 vs uTools：差距分析与实现路线

> 对比基线：Lume 插件系统 v1 + 五轮迭代（ROADMAP #7，2026-09 现状，契约以
> `docs/PLUGIN_API.md` 与 `src/plugins/`、`src-tauri/src/plugins.rs` 为准）。
> uTools 数据来自官方开发者文档中心（u-tools.cn/docs，2026-09 现行版本）逐页核实。
> 本文是规划文档：§1–3 盘点差距，§4 给取舍原则，§5 是分阶段实现步骤，
> §6 是与 ROADMAP 的衔接。**每个阶段独立可交付，开始前须按 ROADMAP 惯例另行立项。**

---

## 0. TL;DR

uTools 的插件生态比 Lume 成熟一个量级，但差距不是均匀分布的。按「对 Lume
用户价值 ÷ 实现代价」排序，真正的差距集中在六处：

**进展（2026-09-21 P0–P3；2026-09-22 P2 余项）**：四个阶段与 P2 的三个余项
（文件拖入 / 剪贴板图片进入 / list 模板）均已实现并实机验收（详见文末各阶段
小节与 `docs/ROADMAP.md` #23–#27）。第 1–3、5、6 项差距已闭合；第 4 项只做了
热重载（`.lupx` 打包与市场属 P4）。**没有闭合的地方也要说清**：权限层是
前端关卡而非沙箱（§P3 小节与 `PLUGIN_API.md` §9）；文件拖入只支持扩展名
过滤（`fileType` 分类与文件夹未做，`PLUGIN_API.md` §6E.1.1），真实 OS 拖拽
的 OLE 路径链路只有手工验证；活动窗口匹配留待 P4。

1. **进入方式太窄**——Lume 只有「精确关键字」，uTools 有关键字（拼音/子序列）、
   正则文本、任意文本、图片、文件拖入、活动窗口六类声明式匹配，外加运行时动态增删指令。
2. **provider 结果模型太薄**——`{name, path}` 只能被 `launch_app` 打开；
   uTools 的列表项带描述/图标/自定义 enter，且「搜索结果 → 插件页」是一条完整的
   下钻链路（子输入框 + 二级列表）。
3. **宿主能力面缺网络与通知**——插件页面受 CORS 限制发不出跨域请求（做不了
   翻译/汇率/搜索类插件），也没有系统通知；这两项是 uTools 生态里数量最多的一类插件的基础。
4. **无热重载、无打包格式**——改一行插件代码要重启 Lume，分发靠手工拷目录。
5. **数据能力弱**——`storage.json` 是无结构的字符串 KV；uTools 是带
   `_rev` 乐观锁的文档库 + 附件 + 云同步。
6. **无权限强制**——`permissions` 字段预留了但 v1 不校验。这是 Lume **相对
   uTools 的反超机会**（uTools 没有运行时权限模型，靠人工审核兜底），而 Lume
   的「能力按需注入」架构天生适合做这个。

uTools 有而 Lume **明确不学**的：无沙箱 preload + 完整 Node.js 执行模型、
ubrowser/Sharp/FFmpeg/AI 这类重能力底座、账号与付费分发闭环。理由见 §4。

---

## 1. 对比基线：Lume 插件系统现状

三部分构成（契约源：`src/plugins/types.ts`、`src/plugins/registry.ts`、
`src-tauri/src/plugins.rs`）：

- **清单**：`<base>/plugins/<id>/plugin.toml`（id/name/version/kind/
  description/permissions[预留]/entry/view/keywords/height/icon）。
- **三类贡献**：`provider`（搜索追加 `{name, path}` 条目）、`mode`
  （`view.html` 渲染进 srcdoc iframe + `window.lume` Promise RPC 桥接，可选
  entry 逻辑钩子）、`service`（onShow/onHide/onQuery 无 UI 钩子）；任意 kind
  可选 `navBars()` 导航页栏目贡献。内置插件 clipboard/preview 走同一注册表。
- **宿主能力 API**（`hostApi.ts`，iframe 侧经 postMessage 桥接同名 RPC）：
  `app.hide/toast/setQuery/setPlaceholder/openPath/revealPath/trash/resize`、
  `clipboard.readText/writeText`、`storage.get/set/remove`（插件私有 KV，
  `storage.json`，Rust 侧 id 消毒防目录穿越）、`fs.readText(≤512KB)/thumb/
  videoPoster/icon`、`search.files`（全盘文件秒搜门面，分页/排序/扩展名过滤）、
  事件 `query/show/hide/key`。

信任模型 = 显式放置即信任；磁盘 JS 经 asset 协议 + blob `import()` 在启动器
webview 内执行（provider/entry），mode UI 在同源 iframe；`permissions` 不校验。
启停走 设置→插件（`settings.plugins.disabled`），禁用 provider 立即从合并中
消失但模块驻留内存；**改代码必须重启 Lume**（每会话只加载一次）。

## 2. uTools 能力全景（摘要）

uTools 基于 Electron（Chromium 91 + Node 14/16），插件 = `plugin.json` 清单 +
可选 `preload.js` + HTML 入口。完整能力清单见调研报告（u-tools.cn/docs 核实），
与本文相关的核心机制：

- **入口（features）**：六类声明式匹配——关键字 `cmds`（自动拼音/首字母）、
  `regex` 正则匹配输入、`over` 任意文本（可 exclude）、`img` 剪贴板图像、
  `files` 拖入/复制的文件（按类型/扩展名/数量过滤）、`window` 活动窗口
  （按进程名/标题/class）；另有 `mainPush`（向主搜索框推送实时结果）、
  `mainHide`（静默触发不弹窗）、运行时 `setFeature/removeFeature` 动态增删指令、
  指令级全局快捷键（用户配置）。
- **执行模型**：`preload.js` 无沙箱、完整 Node.js（fs/child_process/net）+
  Electron API，npm 模块随意用；安全完全靠上架人工审核（**禁混淆压缩、源码
  可读**）+ 发布版禁远程 JS。无运行时权限声明机制。
- **UI**：自由 HTML/任意框架；官方模板 UI（`mode: list/doc/none`，零 UI 代码）；
  `development.main` 指向 dev server 热更新；`setExpendHeight` 动态高度；
  `createBrowserWindow` 任意独立窗口；插件可分离为常驻窗口。
- **子输入框**：进入插件后主搜索框可被插件接管（setSubInput/removeSubInput/
  updateSubInput），插件内连续过滤搜索。
- **结果模型**：列表项 `{title, description, icon, url}`，选中/进入回调自由；
  `redirect(label, payload)` 插件互跳并携带数据；`onMainPush` 主框推送。
- **数据**：`utools.db` CouchDB 风格文档库（`_id/_rev` 乐观锁、附件 ≤10M、
  allDocs idStartsWith）、`dbStorage` KV、`dbCryptoStorage` 加密存储、会员云同步。
- **系统能力**：剪贴板文本/图片/文件复制 + 模拟粘贴（hideMainWindowPaste*）、
  模拟键鼠、系统通知（点击可进插件）、截图/取色、显示器/光标信息、
  `readCurrentBrowserUrl/readCurrentFolderPath`、shell（openPath/External/
  ShowItemInFolder/TrashItem/Beep）、文件对话框、从插件向外拖拽原生文件（startDrag）。
- **生态**：插件市场（审核上架、评分评论、版本记录）、`.upxs` 离线安装包、
  底座托管自动更新、付费插件（买断/按天/按量 + 服务端订单 API）、账号体系
  （getUser/临时 token 换 open_id）、AI 聚合调用（utools.ai + MCP tools）。

## 3. 逐域差距对比

### 3.1 总表

> 下表是**分析当时（P0 之前）**的快照，保留原样以便回看判断依据；「建议阶段」
> 里的 P0–P3 项均已实现（`docs/ROADMAP.md` #23–#26），未实现的是标 P3+ / 远期
> 与「不做」的行。

| 能力域 | uTools | Lume 现状 | 差距评估 | 建议阶段 |
|---|---|---|---|---|
| 关键字进入（拼音/模糊） | ✅ 自动拼音/首字母 | 精确等值匹配 | **中**——中文关键字体验差距明显 | P0 |
| 正则/任意文本进入 | ✅ regex/over | ❌ | **高**——翻译/编码/格式化类插件的命门 | P2 |
| 文件拖入/图片进入 | ✅ files/img | ❌ | 中（可与剪贴板模式联动做轻量版） | P2 |
| 活动窗口匹配 | ✅ window type | ❌ | 低优先（超级面板场景，依赖选区捕获，另立项） | P3+ |
| 运行时动态指令 | ✅ setFeature | ❌ | 低 | P3 |
| provider 结果项 | title/description/icon + 自由 enter 回调 | `{name,path}` 固定 launch_app | **高**——provider 只能"打开"，不能"做事" | P0 |
| 二级下钻（结果→插件页） | ✅ select 回调切列表 | ❌ | 高（与子输入框同属搜索链路） | P2 |
| 子输入框 | ✅ setSubInput | ❌（mode 页有 query 事件但接不走主搜索框） | 高 | P2 |
| 宿主网络请求 | ✅ 无 CORS（preload Node） | ❌ 页面 fetch 受 CORS | **高**——挡掉最大一类插件 | P1 |
| 系统通知 | ✅ showNotification | ❌（只有应用内 toast） | 中高 | P1 |
| 剪贴板图片/文件复制与粘贴 | ✅ copy/paste ×3 类 | 仅文本读写 | 中（Lume 原生有此能力，未暴露） | P1 |
| 文件对话框 | ✅ open/save dialog | ❌ | 中（tauri-plugin-dialog 已在依赖内） | P1 |
| 屏幕/光标/显示器信息 | ✅ | ❌（内部有 work_area） | 低中 | P1 |
| 当前浏览器 URL | ✅ readCurrentBrowserUrl | ❌（有 Explorer 路径的进程内实现） | 低中 | P2 |
| 模拟键鼠暴露给插件 | ✅ simulate* | ❌（内部有 input.rs + 提权代理） | **低**——安全面大，见 §4 | 不做/远期 |
| 文档数据库 | ✅ db + _rev + 附件 + 云同步 | storage.json 字符串 KV | 中（先做容量与结构化，云同步不做） | P3 |
| 加密存储 | ✅ dbCryptoStorage | ❌ | 低 | P3（跟随文档库） |
| 插件互跳（redirect） | ✅ 带 payload | ❌ | 中 | P2 |
| 主框推送 mainPush | ✅ | 部分——provider 结果已是追加了，但没有「静默处理选中」 | 低 | 已有等价物 |
| 独立/分离窗口 | ✅ createBrowserWindow/detach | ❌（mode 页固定在主窗 iframe） | 中低 | 远期 |
| 系统模板 UI（list/doc） | ✅ 零代码列表页 | ❌（mode 必须自带 view.html） | 中——可做官方 list 模板省掉大量样板 | P2 |
| 执行模型 | 无沙箱 preload + Node | iframe 沙箱 + 能力型 RPC | **设计差异，不追**（§4） | — |
| npm 生态 | ✅ CommonJS require | ❌（无解析根的单文件 ESM） | 中（支持多文件/打包产物即可覆盖大半） | P1 |
| 热重载/开发体验 | ✅ dev server HMR | ❌ 改代码要重启 | 中高（开发摩擦） | P0 |
| 打包/安装格式 | ✅ .upxs | ❌ 手工拷目录 | 中 | P3 |
| 插件市场/审核/更新/付费 | ✅ 全套 | ❌ | 生态工程，非单点 | 远期 |
| 插件自述设置 UI | ❌（uTools 也没有） | ❌ | 机会点（ROADMAP 已列） | P3 |
| 运行时权限模型 | ❌（人工审核） | 预留字段 | **反超机会** | P1 起 |
| 深色主题适配 | isDarkColors | 启动器是暗色单主题 | 无需求 | — |

### 3.2 关键差异详述

**① 入口方式（uTools 的核心生态位，Lume 最痛的差距）。** uTools 一个插件的
plugin.json 可以声明多类 feature，底座负责把「用户此刻的输入/剪贴板/拖入的
文件/活动窗口」与声明匹配后带着 payload 进入插件（`onPluginEnter` 拿到
`{code, type, payload, from}`）。Lume 的 `keywords` 是纯等值匹配、只有 mode
kind 能声明、进入不带任何 payload。后果：翻译插件（regex URL/英文句子）、
二维码插件（over 任意文本）、转换类插件（files 按扩展名）在 Lume 上根本无法
自然触发。且 uTools 对中文关键字自动做拼音/首字母匹配（底座能力），Lume 连
「mb」唤出「秒搜」都做不到——而拼音 scoring 在 `apps.rs` 里已有现成实现。

**② 结果模型（provider 的天花板）。** uTools 列表项可携带 icon/description
且 enter 回调完全自由（可以不打开任何东西，直接做事），列表可二级下钻、
select 后换一页列表继续搜。Lume provider 结果只有 `{name, path}`，激活固定走
`launch_app`——「天气预报 provider」只能给一个 weather.com 链接。加上无子
输入框，provider 与用户之间没有第二条交互通道。

**③ 执行模型是路线分歧，不是差距。** uTools preload = 完整 Node 无沙箱，
换来的是插件能力无限 + 安全靠人工审核（源码可读）+ 底座与插件同进程。Lume
选的是**能力型 API**（capability-based）：iframe 沙箱 + 白名单 RPC，每暴露
一个能力都是一次显式的产品决定。这个差异不应抹平——见 §4。

**④ 数据层。** uTools `db` 是文档模型（`_rev` 乐观锁、allDocs 前缀查询、
附件），配合云同步形成跨设备故事；`storage.json` 只能等价于 `dbStorage`
KV，且**每次写都整文件重写**（`plugins.rs::plugin_storage_set_for`），大
payload 会放大 IO。容量上限也未设。不需要追云同步，但结构化与容量该补。

## 4. 战略定位：学什么，不学什么

Lume 的既定架构约束（`docs/ARCHITECTURE.md`）：业务逻辑归 Rust、webview 只是
视图层、最小化（"Does this make users faster?"）、Windows 原生 API 优先。
据此：

**学的**（uTools 验证过、与 Lume 架构兼容的）：

- 声明式入口矩阵（regex/over/files + 拼音关键字）——匹配逻辑放前端很薄，
  payload 传递走现有 mode 进入路径。
- 结果项自由 enter + 二级列表 + 子输入框——这是把 provider 从「网址快捷方式」
  升级成「交互式插件」的全部前提，复用现有 ModeInstance 契约即可。
- 宿主能力面扩张——但**以 Rust 命令为出口**（`plugin_http`、通知、对话框、
  剪贴板扩展），不在 webview 里给插件开新原生面。
- 能力型安全模型 + `permissions` 强制——uTools 没做的运行时权限，是 Lume 的
  差异化卖点：插件声明权限 → 安装/启用时用户看到清单 → RPC 层按声明放行。
- list 模板模式——Lume 的网格 UI 已经是现成模板，disk provider 未来可以
  免 view.html 复用官方 UI（对应 uTools `window.exports mode:list`）。

**不学的**（及理由）：

- **无沙箱 preload / 完整 Node**：与「业务逻辑归 Rust」直接冲突，把任意代码
  执行面放进启动器进程，且要求配套人工审核生态（Lume 没有）。能力型 RPC +
  权限声明是这个模型的正面替代。
- **ubrowser / Sharp / FFmpeg / AI 底座**：重资产运营，与最小化原则冲突。
  AI 若做，宜走独立迭代（`utools.ai` 式的宿主聚合 API 是合理远期项）。
- **账号 / 云同步 / 付费分发闭环**：商业基建，当前无此需求；文档库设计时留
  出后续同步空间即可（`_rev` 字段）。
- **模拟键鼠暴露给插件**：Lume 内部有 `input.rs` + 提权代理，但把它们开放给
  第三方 JS 等于开放一个本地注入器；uTools 敢做是因为审核兜底，Lume 的权限
  层落地并默认拒绝 `input` 权限之前，不做。

## 5. 实现路线

> 分五个阶段（P0–P4）。每项标注涉及文件与验收方式；契约遵循「字段只增不改义」
> 的 v1 演进约定（`docs/PLUGIN_API.md` §11）。所有阶段开始前在 ROADMAP 立项编号。

### P0 开发体验与结果模型（最高性价比，无新原生面）

**P0.1 关键字拼音/模糊匹配**

- 现状：`registry.ts::modeKeywordMatches` 等值匹配 `keywords`。
- 改：匹配放宽为「精确 > 前缀 > 拼音首字母 > 拼音全拼」，拼音转换不在前端做
  （插件关键字可能含中文，前端无拼音库）——Rust 在 `get_plugins` 时为每个
  keyword 预计算 `pinyin_full/pinyin_initials`（复用 `apps.rs` 的 `pinyin`
  crate 管线），前端拿三组串做匹配。
- 涉及：`src-tauri/src/plugins.rs`（manifest 附带拼音字段）、
  `src/plugins/registry.ts`、`src-tauri/src/apps.rs`（抽出 pinyin 助手共享）。
- 验收：输入 `mb` 唤出关键字「秒搜」的 mode；cargo 单测覆盖拼音预计算。

**P0.2 provider 结果模型扩展（v2 条目）**

- 现状：`ProviderResult = {name, path}`，激活固定 `launch_app`。
- 改：条目新增可选字段 `{ description?: string; icon?: string; enter?:
  string }`——`description` 显示为副行（网格条目需要两行布局，`NavigateView`
  已有双行形态）；`icon` 走 `resolvePluginIcon` 同款解析（data:/http:/asset:/
  文件路径）；`enter` 存在时，激活不调 `launch_app` 而是回调 provider 的
  `onEnter(item)`（工厂里实现，拿到 `ctx`），由插件自行 toast/开模式/做动作。
- 兼容：字段全可选，旧 `{name, path}` 行为不变。
- 涉及：`src/plugins/types.ts`、`registry.ts`（provider 包装传透 onEnter）、
  `src/launcher/` 组合根 `runSearch` 合并与激活分支、`NavigateView` 副行渲染。
- 验收：examples 新增 `actions` 示例插件（条目带 icon + enter 回调弹 toast）；
  旧 web-search 示例不回归。

**P0.3 磁盘插件热重载**

- 现状：`loadedDiskIds` 每会话一次，改代码必须重启。
- 改（最小做法，不做文件监视）：① 设置→插件面板每行加「重载」按钮（调
  registry 新导出 `reloadPlugin(id)`：从 `plugins[]` 移除该 id 的磁盘插件、
  清出 `loadedDiskIds`、重跑 `loadDiskPlugins()`）；② 清单新增
  `development = true` 时，`lume.exe --dev-plugins` 或设置开关让每次
  settings-applied 全量重载全部磁盘插件。iframe mode 页因每次渲染重建 srcdoc，
  天然热。
- 不做：文件系统 watcher（v2 有内存驻留问题，见 PLUGIN_API §5.4，重载语义
  先以「手动触发」收敛）。
- 涉及：`registry.ts`（reload 导出 + PluginsPane 接线）、`plugins.rs`
  （manifest development 字段）、`src/settings/` PluginsPane。
- 验收：改 web-search 的 main.js → 点重载 → 下一次搜索出新文案，无需重启。

**P0.4 多文件入口（npm 生态的务实替代）**

- 现状：单 `entry` 文件，无模块解析根，`import` 第三方包不可能。
- 改：清单支持 `entry` 为目录（如 `entry = "dist/"`）时取 `dist/index.js`，
  加载器用 **ESM 裸导入重写**：把代码里的相对 `import './x.js'` 改写为
  blob URL（拉取同级文件递归打 blob），插件即可用 esbuild/vite 打包成多文件
  ESM 产物分发。不实现 node_modules 解析与裸包名（明确不支持，打包时内联）。
- 涉及：`registry.ts::importDiskModule`（重写器）、`plugins.rs`（清单注释 +
  目录校验）。
- 验收：示例插件改为 esbuild 产物（两个 chunk 相互 import）可加载运行。

### P1 宿主能力补齐（每个能力 = 一个 Rust 命令 + 一条权限）✅ 已实现（2026-09-21）

> **落地情况**：`plugin_net.rs`（HTTP / WinHTTP，零新增 crate）、`notify.rs`
> （隐藏通知图标 + NIF_INFO 气泡）、`clipboard.rs` 的 4 个插件命令、
> `plugin_host.rs`（对话框 + 光标/显示器）；前端 `hostApi.ts` / `iframeBridge.tsx`
> / `registry.ts` 三条路径同步。API 文档见 `docs/PLUGIN_API.md` §6D，示例
> `examples/plugins/host-tools/`，实机脚本 `scripts/cdp_p1_verify.mjs`（14 项）。
> **本机限制**：该脚本实测本机不显示任何通知气泡（PowerShell NotifyIcon 对照
> 实验同样不显示），注册与投递被 shell 接受已在实机验证，视觉确认待开启通知的环境。
>
> 权限台账：`docs/PLUGIN_API.md` §6D.6（P3.2 强制层的单一事实源）。

**P1.1 宿主 HTTP 代理（`plugin_http`）** —— 打掉 CORS，价值最高的一块

- Rust：新命令 `plugin_http_fetch { method, url, headers, body, timeout_ms }
  → { status, headers, body_base64 }`。实现走 `reqwest`（tauri v2 栈内常见，
  需新增依赖，加阻塞线程/async 均可；仓库网络约束：crates 走镜像源）。响应体
  上限（如 8MB）、超时默认 10s、每请求记 `[plugins]` 日志。二进制响应走
  base64，文本由前端按 content-type 解码。
- 前端：`ctx.http.request()` / 桥接 `lume.http.request()`；iframe 里同时给
  页面一个 `fetch` 兜底代理可选（不做，保持显式 API）。
- 涉及：`src-tauri/src/plugins.rs`（或新 `plugin_net.rs`）+ `lib.rs` 挂命令、
  `hostApi.ts`、`iframeBridge.tsx`（新 `http` 组）、`types.ts`。
- 验收：examples 新增 `translator`（调镜像可达的开放 API 翻译/查词）；
  CORS 阻断的场景在宿主代理下成功。

**P1.2 系统通知（`notify`）**

- Rust：`tauri-plugin-notification`（或直接 Win32/PowerShell Toast，避免新
  依赖则用 `shell` 式最小实现；先评估 tauri 官方插件体积）。命令
  `plugin_notify { title, body, plugin_id }`；点击通知聚焦 Lume（不带 feature
  级深链，uTools 的 clickFeatureCode 不做）。
- 前端：`ctx.app.notify()`。
- 验收：插件触发 Windows 通知中心出现带 Lume 图标的通知。

**P1.3 剪贴板扩展（图片/文件 + 粘贴）**

- 复用 `clipboard.rs` 现有 capture/paste 管线，新命令：
  `plugin_clipboard_write_image { data_uri }`（PNG → `arboard::set_image`）、
  `plugin_clipboard_write_files { paths }`（HDROP 组装，`paste_clipboard` 已有
  同款逻辑）、`plugin_clipboard_read_files → string[]`（`getCopyedFiles` 等价）。
  `hideMainWindowPasteText` 等价物 = 现有 `paste_clipboard`，开放为
  `ctx.clipboard.paste(text|image|files)`（隐藏启动器 + 粘贴，复用 FocusState）。
- 涉及：`clipboard.rs`、`window.rs`（暴露既有 FocusState 路径）、`hostApi.ts`、
  `iframeBridge.tsx`。
- 验收：示例插件「复制图片条目 → paste(image)」粘贴进画图。

**P1.4 文件对话框与 Shell 补齐**

- `plugin_show_save_dialog / show_open_dialog`（tauri-plugin-dialog 已在依赖，
  设置页在用）；`ctx.shell.openExternal(url)` = 现有 `launch_app` URL 分支
  包装；`shellBeep` 用 `MessageBeepW` 一行实现（可选）。
- 验收：示例插件选择文件并显示路径。

**P1.5 屏幕与光标**

- `plugin_get_cursor_screen_point`、`plugin_get_displays`（`window.rs` 已有
  work_area/monitor 查询，透出即可）。供「贴在光标旁的小窗」类插件用——配合
  现有 `app.resize`。
- 验收：单测 + CDP 脚本断言返回值在主屏范围内。

### P2 入口矩阵与搜索链路（对齐 uTools 核心体验）✅ 核心已实现（2026-09-21）

> **落地情况**：`[[features]]` 声明式进入（regex/over + payload 投递）、
> 子输入框（`app.setSubInput`）、provider 二级下钻（`drill`/`select`/`filter`）、
> 插件互跳（`app.redirect`）四项已实现并有实机脚本
> `scripts/cdp_p2_verify.mjs`（21 项）。API 文档 `docs/PLUGIN_API.md` §6E，
> 示例 `examples/plugins/text-tools/`。
> **顺带修掉一个真实竞态**：mode 页的 `enter`/`query` 曾在 iframe 文档加载完成
> 前投递而被丢弃——现在桥接在页面 `load` 后握手，宿主重放状态（§6E 文档已写明
> 「状态重放」语义）。
> **余项已补齐**（2026-09-22，见 ROADMAP #27 与 `scripts/cdp_p2b_verify.mjs`
> 17 项）：`type = "files"` 文件拖入、`img` 剪贴板图片进入、`template = "list"`
> 列表模板。活动窗口匹配仍留待 P4（窗口匹配/超级面板单独立项）。



**P2.1 regex/over 文本匹配进入**

- 清单：mode/provider 均可声明 `features: [{ code, cmds?, regex?, over?,
  label, icon? }]`（向 uTools feature 形状靠拢，`keywords` 保留为语法糖）。
- 运行时：组合根 `runSearch` 在原生+provider 合并后追加「进入类」命中——
  `regex`（前端 `new RegExp` 试输入，**长度钳制**：任意匹配正则忽略，同
  uTools）、`over`（非空输入即命中）。命中行样式复用 mode keyword 的
  「进入 <name>」行；激活 = 切 mode（或调 provider 的 onEnter）并把当前
  query 作为 `enterPayload` 传入 mode 的 `onShow({payload})` / 事件
  `enter`（桥接新增事件类型，载荷 `{code, type, payload}`）。
- 涉及：`plugins.rs`（清单 features 解析）、`registry.ts`（feature 匹配器）、
  组合根 `runSearch`/`activateApp`、`iframeBridge.tsx`（enter 事件）、
  `types.ts`、PLUGIN_API 文档。
- 验收：examples 新增 `regex-demo`（输入 URL 出现「用 XX 打开」行，进入后
  mode 页收到 URL）。

**P2.2 files/img 进入（轻量版）**

- `files`：拖拽到启动器窗口（`tauri onDragDropEvent`）或搜索框粘贴文件路径
  时，按清单 `files: { extensions?, fileType?, minLength? }` 匹配出「处理
  N 个文件」行，payload = 路径数组。`img`：剪贴板为图片时（250ms 轮询已有
  seq 感知，只读 `GetClipboardSequenceNumber` 判断，不落库）在空查询主菜单
  提供「处理剪贴板图片」行。
- 涉及：`lib.rs` 拖拽事件、`clipboard.rs`（seq 查询命令）、registry 匹配器。
- 验收：拖一个 `.md` 文件到 Lume，markdown 插件命中并进入。

**P2.3 子输入框（subInput）**

- 语义：mode 激活期间可接管主搜索框（`ctx.app.setSubInput({ placeholder })
  → 后续输入走 `lume.on.subInput` 事件而非 mode 的 query 路由；Esc/清空语义
  不变）；`removeSubInput()` 交还。provider 二级列表（P2.4）依赖它。
- 关键约束：与「搜索召回」「remember_last_page」「mode query 独立」三条既有
  语义交叉——接管状态必须随模式切换/呼出复位，先在 `types.ts` 写清
  ModeInstance 契约新增成员（`subInput?: boolean` 声明位 + 宿主信号）。
- 涉及：`types.ts`、组合根（输入路由分支）、`App.tsx` 输入框、桥接事件。
- 验收：file-search 示例改用 subInput 后输入过滤走主框，Esc 一层退模式一层清词。

**P2.4 provider 二级下钻（select）**

- provider 契约新增可选 `select(item) → ProviderResult[]`（返回新一批结果
  替换网格 + 自动进入 subInput）；Esc 回退到上一级（栈深 1 层即可，v2 不做
  多级栈）。激活仍走 P0.2 的 enter 语义。
- 验收：示例「翻译」provider：一级出「翻译为中文」行 → select 出多个目标
  语言行 → enter 复制结果。

**P2.5 插件互跳（redirect）与 list 模板**

- `ctx.app.redirect(pluginId, { code?, payload })`：目标存在 → 切模式/触发
  provider enter；不存在 → toast 提示（市场是远期，不跳转）。
- list 模板：清单 `kind = "mode"` 且声明 `template = "list"` 时免 `view`，
  宿主用内置 Solid 列表组件渲染 `lume.on.enter/search` 数据——省掉轻插件的
  UI 样板（uTools `mode:list` 等价）。
- 验收：两个示例插件互相 redirect；template:list 插件零 HTML 可运行。

### P3 数据层与权限强制 ✅ 已实现（2026-09-21）

> **落地情况**：四项全做（`docs/PLUGIN_API.md` §6F，ROADMAP #26，示例
> `examples/plugins/notes/`，实机脚本 `scripts/cdp_p3_verify.mjs` 45 项）。
> - **P3.1 文档库**：独立 `<base>/data/plugin_store.db`（不进 `lume.db`），
>   `get/put/remove/allDocs/bulkDocs` + `_rev` 乐观锁，单文档 512 KB / 每插件
>   2000 篇 / 单批 1000 篇；`__` 前缀是宿主内部文档，插件读写被拒。旧
>   `storage.json` 进程首次访问时迁入 `__storage` 文档并把文件改名
>   `.migrated`（只改名不删），`storage.*` 保留为垫片。
> - **P3.2 权限强制**：台账（§6D.6）成为强制输入；校验点在 `createHostApi`
>   返回的 API 上逐方法包一层，所以**插件逻辑（启动器窗口内直接持有 API）与
>   mode 桥接两条路径都被覆盖**——初版只在桥接入口校验，被实机脚本当场抓出
>   （provider 逻辑整层绕过）。fail-closed、拒绝文案带缺失能力词、设置页显示
>   权限 chips + 「全部授权」逃生门。
> - **P3.3 私有文件**：`<plugin>/files/`（无需权限，10 MiB/文件，文件名守卫含
>   Windows 保留设备名）；任意路径写入 = `fs.write` 能力。
> - **P3.4 声明式设置**：`[[settings]]` → 设置页自动渲染 → 存 `__settings`
>   文档 → `ctx.settings.get/all` + `onSettings`；**manifest 即 schema**。
>
> **与计划的差异（更保守的地方）**：① 权限校验放在前端 API 工厂而不是
> 「hostApi/桥接每个 RPC 入口」两处分别写——一处收口，逻辑与桥接同时覆盖；
> ② 「全部授权」落到 `settings.plugins.trusted`（而不是逐项开关），保持最小。
>
> **必须说清的边界**：这仍是**前端关卡**。mode 页是同源 iframe，蓄意代码可直接
> 触达 Tauri IPC，跳过整层；真正的隔离（沙箱 iframe + 命令侧白名单 + 签名）与
> `.lupx` 安装确认一起留到 P4。今天这一层的价值是**知情同意 + 明确失败**，文档
> 与设置页都照实写。

**P3.1 storage → SQLite 文档库**

- 现状：`storage.json` 全量重写、无容量约束。
- 改：`<base>/data/plugin_store.db`（独立 WAL 库，不进 lume.db，符合「插件
  数据可整库删除」语义）——表 `docs(plugin_id, id, rev INTEGER, json TEXT)`，
  契约升级为 `db.get/put/remove/allDocs(idStartsWith)/bulkDocs`（uTools 同形
  `_rev` 乐观锁；冲突返回错误由插件决定重读）。`storage.*` 保留为兼容垫片
  （内部映射到单 doc）。附件目录 `plugins/<id>/files/`（≤10MB，`postAttachment`
  形状）。不做云同步（§4）。
- 涉及：`plugins.rs` 拆出 `plugin_store.rs`（rusqlite）、hostApi/桥接、
  迁移（首启把 storage.json 搬进 db）。
- 验收：cargo 单测（乐观锁冲突/迁移幂等）；旧示例 storage 调用不回归。

**P3.2 权限强制层（消费预留的 `permissions`）**

- 权限词表（P1 起登记的能力逐个入表）：`clipboard`（读写）、`fs.read`、
  `fs.write`（新，P3.3）、`trash`、`network`、`notify`、`dialog`、`screen`、
  `search.files`、`storage`（默认授予，不入表）。
- 语义：① manifest 声明 → ② 启停面板按插件显示权限 chips（缺失声明的能力
  调用即 reject 并 plog，fail-closed——与现有 fail-open 的 enabled 语义区分，
  文档写明）→ ③ hostApi/桥接每个 RPC 入口先过 `assertPermission(id, method)`。
- 设置页：插件行展开权限列表 + 「信任此插件全部权限」快捷项（不做逐项开关，
  保持最小）。
- 涉及：`plugins.rs`（权限词表 + 校验命令）、`registry.ts::execHostRpc`
  统一入口拦截、`hostApi.ts`、PluginsPane、文档。
- 验收：未声明 `network` 的插件调 `http.request` 得到明确 reject 文案；
  声明后通过。

**P3.3 fs 写能力（谨慎）**

- `fs.writeFile(path, content)` 限定**插件私有目录内**（`plugins/<id>/files/`）
  默认放行；任意路径写需要 manifest 声明 `fs.write` 并在启用时明示。读能力
  （`fs.readText` 等）纳入 `fs.read` 权限（P3.2 起生效）。
- 验收：越界路径 reject。

**P3.4 插件级设置 UI**

- ROADMAP 已列方向：清单 `settings: [{ key, label, type: "toggle"|"select"|
  "text", default }]` → PluginsPane 自动渲染 → 存 `storage` 的
  `__settings` 键 → 插件经 `ctx.settings.get()` 读。uTools 也没有此能力，
  做出来是净差异优势。
- 验收：示例插件声明一个 toggle，面板可切换且 `applySettings` 时插件感知。

### P4 生态（远期，单独立项）

- **打包格式 `.lupx`**（zip：plugin.toml + assets，安装 = 解到 plugins/ +
  二次确认弹窗，等价 `.upxs` 的「装时确认」而非审核）。
- **市场源**：静态 JSON 索引（名称/版本/下载 URL/SHA-256）+ 应用内安装；
  受仓库网络约束须可配镜像。自动更新 = 启动时比对版本号提示。
- **窗口匹配 / 超级面板**：`window` feature 与选区捕获是独立的系统能力
  （可复用 `explorer.rs`/`input.rs` 的前台窗口探测），体量大，评估后单独立项。
- **AI 宿主 API**（`utools.ai` 形态）：视需求单独立项。

## 6. 与 ROADMAP / 文档的衔接

- 本文 §5 每阶段实施时，在 `docs/ROADMAP.md` 开新编号（建议 #23 起按 P0.x
  编子项），遵循「实机验证 + 截图/CDP 冒烟」的既有验收惯例。
- 契约变更同步三处：`docs/PLUGIN_API.md`（字段表 + §12 路线清账）、
  `src/plugins/types.ts`、`docs/PLUGINS.md`（上手指南新增示例链接）。
- 每个新能力在 `examples/plugins/` 落一个可运行示例（仓库惯例：示例即验收）。
- 权限词表以本文 §5.5（P3.2）为单一事实源，P1 阶段的新命令先手工登记。
