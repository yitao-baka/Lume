# WebView2 常驻内存优化方案

> 历史归档：本文保留本轮的边界、取舍与验收设计，不再定义当前行为。落地实现、
> 踩坑与验证见 [ROADMAP_HISTORY.md](../ROADMAP_HISTORY.md) #100；当前契约见
> [ARCHITECTURE.md](../ARCHITECTURE.md) 与 [TESTING.md](../TESTING.md)。

本报告定义 Lume 下一轮 WebView2 常驻内存治理的目标、边界与验收口径。
它描述拟采用的方案，不替代 `CHANGELOG.md` / `ROADMAP_HISTORY.md` 的进度记录。

## 目标与边界

目标是降低应用在隐藏、闲置、插件页面保活和辅助窗口关闭后的长期内存占用，
同时保持启动器的首击响应、插件安全边界和会话恢复能力。

衡量口径不能只看任务管理器中的单一工作集数字。每个场景同时记录：

- Private Working Set；
- Private Bytes / committed memory；
- 主窗口和各 iframe target 的 JavaScript heap；
- WebView2 process 数量及 browser / renderer / GPU / utility 分类；
- 热键呼出、首次预览、设置重开和插件重新挂载的延迟。

现有隐藏基线约为 162 MiB 工作集、199 MiB 私有内存和 7 个 WebView2 进程。
这是隔离会话的参考值，不是固定上限，也不是本方案的唯一验收目标。

### 不在本次范围

- 不接入 WebView2 `TrySuspend` / `Resume`。本轮以 renderer 生命周期和堆内存治理为主。
- 不重新尝试 `--renderer-process-limit=1`。历史实测会破坏多 WebView 创建。
- 不通过关闭站点隔离、取消 sandbox 或合并插件逻辑帧来降低进程数。
- 不以 `EmptyWorkingSet`、频繁清空工作集或盲目删除动画作为内存优化手段。

## 现状判断

当前行为包含隐藏窗口的 controller 可见性、几何测量反馈环和 Low 内存水位，
但以下成本仍然存在：

- 预览窗口在启动时创建，即使从未使用也保留一个空白 renderer；
- 设置窗口首次使用才创建，但关闭后默认保留 renderer 15 分钟；
- 插件 entry 在注册时加载逻辑宿主和逻辑 iframe；
- 每个插件逻辑 iframe 和 Page Runtime Presenter iframe 都可能占用独立 renderer；
- 页面保活栈允许同时挂载最多 8 个 mode，非活动宿主隐藏 5 分钟后才回收；
- Page Model、会话快照、诊断探针和前端缓存存在重复副本或无全局预算的累积风险。

`MemoryUsageTargetLevel = Low` 主要换出闲置工作集，不会卸载页面，也不会停止脚本。
因此本轮优先减少同时存活的 renderer 数量和长寿命 JavaScript 对象，再微调资源参数。

## 设计原则

- **先减少 renderer 数量，再调低单个 renderer 的资源水位。**
- **逻辑、页面和预览按需创建；长期闲置后按快照或持久化状态重建。**
- **所有长期存活缓存必须同时有数量上限和字节上限。**
- **非活动页面不应持续接收完整 Page Model；恢复时重放当前快照。**
- **不改变插件权限、sandbox、origin 隔离和 Rust 侧 fail-closed 边界。**
- **保留 `keep_session`、分离窗口、未保存草稿和用户明确保留的页面状态。**

## 方案

### 预览窗口按需创建并按空闲销毁

当前预览窗口在 `src-tauri/src/lib.rs` 启动时创建，并加载同源
`blank.html`。关闭预览后导航到 `about:blank`，但 renderer 仍保留。
相关位置：

- `src-tauri/src/lib.rs`：启动时创建 `preview`；
- `src-tauri/src/window.rs`：`teardown_preview` 和 renderer 保留说明。

实施要求：

- 从未使用预览的用户不创建预览 WebView；
- `show_preview` 首次需要内容时才创建 `preview` window；
- 使用独立的创建锁和 activity epoch，处理并发 `show_preview`、关闭和空闲销毁；
- 首次创建后必须等待 `preview_renderer_ready` 握手，再显示 HWND；
- 预览隐藏后先保留热页，默认空闲 10 分钟后销毁；
- 下次预览重新创建，并从当前请求恢复内容；
- 预览内容为图片、PDF、音视频时，关闭仍先导航到 `about:blank`，让页面资源先释放；
- 不改变 plugin preview 的权限判断、请求结构和 Esc 关闭优先级。

收益是移除未使用预览的固定 renderer 成本，并在预览关闭后的空闲期回收页面堆。
风险是首次预览延迟和运行时创建 WebView 的 GPU 兼容性，必须覆盖重复创建、
PDF、媒体、图片和预览焦点回归。相关代码位于：

- `src-tauri/src/lib.rs`
- `src-tauri/src/window.rs`
- `src/launcher/previewHost.ts`
- `src/preview.tsx`

### 设置窗口隐藏 5 分钟后销毁

设置窗口已经在首次打开时创建，关闭时保留热页。将
`SETTINGS_IDLE_DESTROY_SECS` 从 15 分钟调整为 5 分钟。

实施要求：

- 保留现有 activity epoch 和创建锁；
- 隐藏时立即切换到 controller-invisible + Low；
- 5 分钟内重新打开复用现有窗口；
- 5 分钟后且仍不可见时才销毁；
- 未保存草稿仍由设置页的关闭确认和可见窗口状态承担，不因隐藏销毁静默丢失；
- 重新打开时从当前设置重建，不依赖已销毁的页面内存状态。

该改动只影响已经打开过设置窗口的实例。验收需要覆盖连续开关、保存/重置、
插件设置和设置搜索。相关代码位于：

- `src-tauri/src/window.rs`
- `src/settings/Settings.tsx`

### 插件逻辑宿主按需加载并空闲卸载

插件注册时不应为所有 entry 插件立即创建逻辑宿主和逻辑 iframe。当前
`registry` 在 provider、Page Runtime mode、list mode 和 service 注册时调用
`pushLogicLoad`；只有没有已加载插件时逻辑宿主才会在 30 秒后关闭。

实施要求：

- manifest 注册只建立代理贡献，不启动逻辑运行时；
- provider 第一次搜索时再加载对应逻辑，原生结果先返回，插件结果就绪后增量合并；
- Page Runtime mode 第一次 `ensureHost` / mount 时再加载逻辑；
- service 在第一次收到声明的生命周期事件时加载；
- 没有活动页面、没有 pending RPC、没有 detached 窗口时，逻辑 iframe 空闲 5 分钟后卸载；
- 逻辑宿主在 `logicLoadedIds` 和 `logicPending` 都为空时继续使用现有 idle close；
- 卸载顺序必须先撤销令牌和 pending call，再移除 iframe，禁止迟到结果复活页面；
- 插件重新加载、设置保存和首次使用都走同一套 ready 握手。

收益是避免“安装但从未使用”的插件产生常驻 renderer，并让 provider / service
的空闲实例回到零页面成本。风险是首次搜索或首次打开插件时出现可感知的冷启动，
需要保留 provider 原生结果的即时呈现和页面 loading gate。相关代码位于：

- `src/plugins/registry.ts`
- `src/pluginLogic.tsx`
- `src/plugins/pageRuntimeMode.tsx`
- `src-tauri/src/plugin_logic.rs`

### 插件页面 host 预算

当前 `App.tsx` 的宿主栈最多保留 8 个页面，启动器隐藏 5 分钟后只回收非活动、
非 home、非 detached 且未被 `keep_session` 豁免的页面。

建议默认调整为：

- `maxLive` 从 8 降为 4；
- 启动器隐藏后，非活动页面回收等待时间从 5 分钟降为 2 分钟；
- 启动器隐藏 15 分钟后，当前 active 的非 home 插件页也进入冷回收；
- home、detached、`keep_session` 和用户覆盖仍保持豁免；
- 当前 active 的 home 页面不回收；
- 所有冷回收都先抓取会话帧，再卸载 Presenter iframe；
- 重新进入页面时通过现有 ready 握手恢复 view/titlebar 帧。

`keep_session` 的语义不变：它保护的是会话状态和用户明确要求保留的页面，
不是永久 renderer 进程。相关代码位于：

- `src/App.tsx`
- `src/launcher/session.ts`
- `src/plugins/pageRuntimeMode.tsx`
- `src/plugins/iframeBridge.tsx`

### 拆掉 Page Model 的重复副本

`PageModelStore` 已经维护当前 Page Model，但主窗口还会通过
`latestPageModels` 为每个插件保留一份完整模型。建议改成一次性 early model：

- 只在页面尚未完成注册时保留临时模型；
- runtime 首次 `publishModel` 成功后立即删除临时副本；
- `__pageRuntimeLatestModel` 调试探针改为读取当前 runtime 的 `currentModel()`；
- 不再为每个已加载插件永久维护第二份最大 1 MiB 的模型。

同时检查 Presenter HTML 缓存。`pageRuntimeMode` 的 `htmlCache` 可以继续服务
热页和 Presenter 切换，但页面进入冷回收后应清理不再需要的 HTML 字符串。
相关代码位于：

- `src/plugins/registry.ts`
- `src/plugins/pageRuntimeMode.tsx`

### 会话帧和 Presenter 事件设置总预算

会话帧当前按单条 1 MiB 限制，但没有全局总字节预算和过期时间。Presenter
事件队列最多 128 条，也没有字节上限。建议增加：

- 会话帧总字节预算，例如 4 MiB；
- 按最近使用时间淘汰或设置空闲 TTL；
- Presenter 队列总字节上限；
- `model`、`query`、`settings` 同类事件合并，只保留最新值；
- Page Model 更新在非活动页面只标记 dirty，页面恢复时再投递当前模型；
- 队列超预算时优先丢弃旧的非关键事件，不阻塞页面关闭和切换。

相关代码位于：

- `src/launcher/session.ts`
- `src/page-runtime/presenterBridge.tsx`
- `src/plugins/pageRuntimeMode.tsx`

### 诊断探针只在调试构建启用

当前多个 CDP 诊断探针常驻生产代码，其中部分会保留完整模型、snapshot 或表单值：

- `src/pluginWindow.tsx` 的 `__pluginStates` 没有条数上限；
- `src/pluginLogic.tsx` 的 `hookLog` 保留完整 hook result；
- `src/plugins/iframeBridge.tsx` 的 `__frameStates` 保留完整表单状态；
- `App.tsx`、`pageRuntimeMode.tsx`、`launcher/session.ts` 和 `registry.ts` 还有若干
  CDP tap。

实施要求：

- 由 Rust 初始化脚本注入调试构建标记，正式 release 默认关闭完整诊断数组；
- 测试构建保留必要的探针，避免破坏现有 CDP 测试；
- 所有保留的 ring 使用统一实现，同时限制条数和序列化字节总量；
- `hookLog` 只保留类型、字段数量、序列化大小和截断摘要；
- `__pluginStates` 不保存完整 Page Model 或 snapshot；
- 队列满时优先留下最近的状态变化摘要，不保留可无限增长的对象图。

相关代码位于：

- `src/pluginWindow.tsx`
- `src/pluginLogic.tsx`
- `src/plugins/iframeBridge.tsx`
- `src/App.tsx`
- `src/plugins/pageRuntimeMode.tsx`
- `src/launcher/session.ts`
- `src/plugins/registry.ts`

### 前端缓存设置上限

启动器图标缓存 `src/launcher/icons.ts` 目前没有上限。图标以 data URI 保存，
长时间搜索大量不同路径后会持续增长。建议：

- 使用 LRU 或按最近访问时间淘汰；
- 默认上限 256–512 项或 8–16 MiB，以先到者为准；
- 长期隐藏时清空非当前可见图标；
- `src/plugins/windowIcon.ts` 的插件图标缓存在 detached 窗口关闭后清理；
- `htmlCache` 与页面冷回收生命周期联动。

该类优化通常只节省数 MiB，但属于确定性收益，且不依赖 Chromium 参数。

### 拆分启动器和设置窗口 bundle

当前 `src/index.tsx` 同时静态导入 `App` 和 `SettingsApp`，主窗口也要加载设置页
代码，设置窗口也要加载启动器代码。建议：

- 新增独立 `settings.html` / settings 入口；
- 启动器入口只加载 launcher bundle；
- 设置入口只加载 settings bundle；
- 设置页 pane 按当前 section 动态加载；
- `src/i18n.ts` 只加载当前 locale 和英文 fallback，其余语言按需导入。

这是低风险、低收益的补充项，主要降低每个窗口的代码解析和常量数据内存。

### 透明合成路径的受控实验

主窗口当前为支持 CSS 不透明度而使用透明 WebView。该路径可能增加 GPU 合成和
表面缓存成本。可以做一个独立 A/B：

- 100% 不透明度时使用不透明窗口；
- 低于 100% 时再启用透明合成，或使用原生 layered-window alpha；
- 比较 GPU、browser 和主 renderer 的私有内存、透明度切换和 DWM 边框表现。

该实验涉及 DWM、焦点、拖拽和视觉边界，不应先改默认值。只有实机内存和视觉
回归都通过后，才考虑合入。

### Chromium 参数的边界实验

可以在隔离构建中验证 `--enable-low-end-device-mode` 或更小的 V8 heap 参数，
但必须同时观察 GC 次数、动画流畅度、视频播放、PDF 预览和插件兼容性。

不把以下方案纳入候选实现：

- `--renderer-process-limit=1`；
- 通过 `--disable-site-isolation-trials` 或类似开关合并插件 renderer；
- 在隐藏窗口上反复调用 `EmptyWorkingSet`；
- 未经验证就修改 WebView2 GPU 进程参数。

## 实施顺序

建议按以下顺序推进，以便每一步都能独立测量和回滚：

- 先做预览窗口、设置窗口和插件逻辑宿主的生命周期治理；
- 再做页面 host 预算和 Page Model / 会话帧预算；
- 随后关闭正式诊断数据并给前端缓存设上限；
- 最后评估 bundle 拆分、透明合成和 Chromium 低端模式实验。

每一步都必须保留旧路径的回退开关或运行时降级路径。旧 runtime、旧插件或
WebView2 能力缺失时，不能因为新生命周期逻辑导致窗口无法打开。

## 验收场景

优先扩展现有 `hidden-resource-audit`，不新增生命周期相同的永久套件。至少覆盖：

- 冷启动后隐藏 60 秒，确认没有预览、设置或插件页面产生额外 renderer；
- 从未使用预览、使用预览后关闭、关闭 10 分钟后；
- 设置页打开、关闭、5 分钟后销毁、重新打开；
- 访问 4、8、12 个插件页面后的 host 数量、renderer 数量和 JS heap；
- 安装 3 个和 10 个 entry 插件后的隐藏基线；
- 长时间保持 detached 插件窗口后的模型、snapshot 和诊断内存；
- 连续呼出/隐藏 20 次后的焦点、尺寸、透明表面和首次帧；
- 插件页面冷回收后 `keep_session`、普通页面和 detached 页面的恢复差异；
- 剪贴板文本、HTML、图片、文件和多选操作；
- PDF、图片、音频和视频预览。

每个场景同时记录：

- Private Working Set；
- Private Bytes / commit；
- renderer 数量和角色；
- `Runtime.getHeapUsage`（或等价 CDP 指标）；
- 主窗口热键恢复耗时；
- 首次预览、设置重开和插件 remount 耗时。

除了内存数字，验收还必须检查：

- 隐藏页面没有 RAF / 几何 IPC 自反馈；
- 插件逻辑 token、pending RPC 和迟到结果不会复活已卸载页面；
- `keep_session`、用户覆盖、分离窗口和未保存草稿语义不回归；
- sandbox、origin 隔离、Rust 权限检查和导航边界不弱化；
- 前台焦点、透明表面、DWM 边框和窗口位置不回归。

## 验证入口

实现完成后按改动范围运行：

- `pnpm verify:docs`
- `pnpm verify:fast`
- `pnpm verify:ui:changed`
- 涉及预览、设置、插件生命周期和剪贴板时，按 `docs/TESTING.md` 的变更矩阵
  补跑对应套件；
- 需要真实 UAC、服务注册、真实拖拽和原生窗口检查时，按
  `docs/MANUAL_TESTING.md` 执行。

## 涉及文件

| 范围 | 主要文件 |
| --- | --- |
| 预览窗口 | `src-tauri/src/lib.rs`、`src-tauri/src/window.rs`、`src/launcher/previewHost.ts`、`src/preview.tsx` |
| 设置窗口 | `src-tauri/src/window.rs`、`src/settings/Settings.tsx` |
| 逻辑宿主 | `src/plugins/registry.ts`、`src/pluginLogic.tsx`、`src-tauri/src/plugin_logic.rs` |
| 页面 host | `src/App.tsx`、`src/launcher/session.ts`、`src/plugins/pageRuntimeMode.tsx` |
| Page Model / queue | `src/plugins/registry.ts`、`src/page-runtime/presenterBridge.tsx`、`src/page-runtime/modelStore.ts` |
| 诊断探针 | `src/pluginWindow.tsx`、`src/pluginLogic.tsx`、`src/plugins/iframeBridge.tsx`、`src/page-runtime/diagnostics.ts` |
| 前端缓存 | `src/launcher/icons.ts`、`src/plugins/windowIcon.ts`、`src/plugins/pageRuntimeMode.tsx` |
| bundle / i18n | `src/index.tsx`、`src/i18n.ts`、Vite multi-page 配置 |
| 验证 | `test/hidden-resource-audit.mjs`、`scripts/test-harness/suites/`、`scripts/test-manifest.json` |

## 最终取舍

本轮不以“把任务管理器数字降到某个固定值”为目标。可复用的优化优先级是：

- 减少同时存活的 renderer；
- 让页面和逻辑宿主按需启动、按空闲销毁；
- 给模型、快照、事件和诊断数据设置硬上限；
- 用可恢复的快照替代长期保活；
- 只在低风险且可测量的场景调整合成或 Chromium 参数。

`TrySuspend` 不进入本轮实现。后续若重新评估，必须单独验证 resume 延迟、
隐藏状态恢复顺序和私有内存收益，不能直接混入本轮生命周期改动。
