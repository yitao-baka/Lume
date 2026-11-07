# WebView2 常驻资源诊断与优化记录

> 历史归档：本文保留 2026-11-07 的诊断证据与原始优化顺序，不再定义当前行为。
> 后续实现、踩坑与验收见 [ROADMAP_HISTORY.md](../ROADMAP_HISTORY.md) #99；
> 当前架构契约见 [ARCHITECTURE.md](../ARCHITECTURE.md)，发布记录见
> [CHANGELOG.md](../../CHANGELOG.md)。

诊断基于 2026-11-07 的工作区源码、隔离 CDP 会话和同机只读采样。

## 结论

持续 CPU 的首要原因是宿主窗口尺寸测量的 `requestAnimationFrame` 自反馈循环，
不是搜索框自绘光标，也不是 Rust 搜索索引。尺寸未变化时仍会安排下一帧，下一帧
又重新请求尺寸测量，因此窗口隐藏后仍会执行 DOM 测量与渲染器调度。

## 最终落地

诊断后的实现已按本文顺序落地：几何测量改为单向数据驱动；原生 HWND 与
WebView2 controller 可见性同步；设置页首次使用才创建并在长时间隐藏后销毁；
预览窗启动停在同源零脚本空白页；非活动页面按会话快照回收；空逻辑宿主闲置
关闭；剪贴板改为 `WM_CLIPBOARDUPDATE` 通知并在注册失败时低频兜底。实现细节、
踩坑和正式验收数据见 [ROADMAP_HISTORY.md](../ROADMAP_HISTORY.md) #99。

内存需要分开看：WebView2 的 browser、GPU、utility 和主页面 renderer 有固定成本；
设置、预览、插件逻辑宿主及保活页面又增加了可优化的常驻成本。当前
`MemoryUsageTargetLevel = Low` 主要换出闲置工作集，不会卸载页面，也不会停止其中的
脚本。降低任务管理器工作集数字不等于减少全部提交内存。

## 已确认的根因

### 尺寸测量循环

调用链如下：

```text
sizing.applyLatest()
  → requestAnimationFrame(deps.measureModeViewport)
  → App: activeMode().measureViewport()
  → Navigate / Page Runtime: services.scheduleResize()
  → sizing.resizeToContent()
  → sizing.applyLatest()
```

- `src/launcher/sizing.ts` 在目标尺寸与 `committed` 相同的提前返回路径仍安排
  `measureModeViewport`，实际提交尺寸后也无条件安排一次。
- `src/plugins/navigate/index.tsx` 把 `measureViewport` 实现为
  `services.scheduleResize()`；`src/plugins/pageRuntimeMode.tsx` 同样如此。
- `src/plugins/clipboard/store.ts` 的实现只是幂等读取视口高度，没有这条反向调度，
  说明 `measureViewport` 本身不需要重新请求窗口测量。
- 没有用户输入、窗口尺寸没有变化时，这条链仍继续执行。原生窗口隐藏不会终止
  JS 闭包中的 RAF 调度。

### 隔离 A/B 观察

诊断使用仓库 `scripts/test-harness/cdp.mjs` 的私有运行目录、空数据目录和独立
`WEBVIEW2_USER_DATA_FOLDER`，没有终止或重启用户正在使用的 Lume。

在原逻辑中注入 RAF 栈采样后，短时间即收集到 1000 条记录上限。主要调用栈为
`applyLatest` → `measureModeViewport` → `scheduleResize`，且在隐藏状态继续产生。
临时将 `App.tsx` 中提交尺寸后的 `measureModeViewport` 回调改为空操作，重新构建
内嵌 debug 可执行文件，再在隔离会话采样：

| 主 renderer CPU 增量 | 基线观察 | 临时断开后续测量 |
| --- | ---: | ---: |
| 采样区间 | 约 4–6 秒 | 6.505 秒 |
| CPU 时间 | 约 0.8–1.1 秒 | 0 秒 |

上述数据用于确认反馈环，不是整机 CPU 百分比或正式性能基准。测试进程处于诊断
会话，且只隔离了一个回调；临时源码随后已还原，不能把该实验当作交付修复。

同时进行的动画暂停实验没有让 CPU 回落，因此不支持把 1 秒循环的自绘光标当作
根因。光标可以在隐藏时停止绘制，但不能替代 RAF 环修复。

## 其它发现

### 顶层窗口隐藏没有同步页面可见性

隔离会话中，main/settings/preview 的原生顶层窗口已隐藏，但页面的
`document.visibilityState` 仍为 `"visible"`，`document.hidden` 为 `false`。

当前 `src-tauri/src/window.rs` 使用 `WebviewWindow::hide()`。Tauri 2.11.5 的
`WebviewWindow::hide()` 委托给顶层 `Window::hide()`，不同于 Wry 0.55.1 的
`WebView::set_visible(false)`；后者还调用
`ICoreWebView2Controller::SetIsVisible(false)`。

这是诊断时待修复的生命周期问题，但现有证据不把它认定为持续 CPU 的首要原因。即使页面
正确进入 hidden 状态，后台 timer、插件逻辑帧和网络任务也不能一概假定会停止。

### 启动即创建完整辅助页面

`src-tauri/src/lib.rs` 在启动时创建 main、settings 和 preview 三个 WebView。
设置页加载完整设置前端，预览页即使在空白状态也保有自己的 renderer。
`plugin-logic-host` 按需创建后常驻，并由
`src-tauri/src/window.rs::sync_aux_memory_targets` 设置为低内存水位。

主页面适合保活以维持热键体验；设置和预览不必为从未使用的功能支付完整页面成本。
现有注释提到运行时创建 WebView 曾有 GPU 卡死风险，改为懒创建或销毁重建前必须
做实机回归，而不是只检查进程数量。

### 页面与逻辑保活增加实际成本

`src/App.tsx` 的宿主栈最多保留 8 个页面，只有超出 LRU 上限或闲置重置等路径才
淘汰。启动挂载时还会预热各 mode 的数据，即使启动器尚未首次显示。分离插件窗口、
共享逻辑宿主及其 iframe 另有生命周期，不能把它们计入主窗口 DOM 之后就认为已释放。

闲置卸载需要遵循 `keep_session`、用户覆盖、快照、分离窗口单一权威以及 `onHide`
契约。它是按需优化，不应默认破坏会话恢复。

### 剪贴板监听仍在轮询

`src-tauri/src/clipboard.rs` 每 250 ms 调用一次
`GetClipboardSequenceNumber`，约每秒唤醒四次。它不是本次 WebView2 主 renderer
CPU 的来源，但可以用 Windows 通知取代无变化时的轮询。

## 当时的优化方案

### 先终止尺寸反馈环

建立单向测量约定：页面数据或布局变化可以请求窗口测量；窗口测量结束不能直接
请求同一个页面再次安排窗口测量。

- Navigate 与 Page Runtime 的 `measureViewport` 改为幂等读取/同步内部视口，不再
  调用 `services.scheduleResize()`。
- 页面内容高度由 Presenter 的布局上报、`ResizeObserver` 或数据变化路径通知 sizer。
  Navigate 自有页面使用现有数据驱动测量，不为简单适配器增加无意义观察器。
- `sizing.applyLatest()` 的尺寸未变化快速路径只返回；保留 show generation 必须
  提交握手的例外，避免相同尺寸导致窗口无法显示。
- 实际尺寸提交后的后续测量仅在确有内部视口同步需求时执行，不得再重新进入
  `scheduleResize()`。剪贴板这类幂等读取可以保留。
- 不采用全局禁止 RAF 的临时实验方式；它会让真正需要同步的插件视口失效。

这项修改应先独立交付，测量收益后再决定是否进行结构性懒加载。

### 统一原生窗口与 WebView 可见性

在 `window.rs` 提供统一的可见性/资源状态入口，同时处理
`ICoreWebView2Controller::SetIsVisible` 和 `MemoryUsageTargetLevel`，覆盖：

- main 的启动、显示、隐藏与销毁；
- settings 的首次打开、关闭与销毁；
- preview 的显示、隐藏，以及现有直接 `ShowWindow` 的隐藏路径；
- plugin-logic-host 的创建、隐藏和销毁；
- 分离插件窗口，避免只修主窗口。

先恢复 Normal、准备内容并完成几何握手，再显示窗口；隐藏时先完成页面可见性与
预览清理，再按现有延迟进入 Low。保留 `launcher_renderer_ready` 和 show generation
机制，不能用定时睡眠替代就绪确认。

通过 CDP 检查隐藏后 `document.visibilityState`，并回归焦点丢失自动隐藏、透明窗口、
DWM 边框与插件窗口。

### 辅助页面按需创建与有界保活

设置窗口首次打开时创建 WebView。关闭时保留草稿语义；没有未保存状态且长时间
未使用后可销毁，之后按需重建。设置窗口独立于启动器的显示/隐藏，不应因主窗口
失焦而销毁。

预览窗口启动时只保留 `about:blank`，首次出现内容时加载 `preview.html`。关闭时
销毁 WebView 或在实测确认有延迟收益后短时令其闲置销毁，解除图片、媒体、PDF
和 renderer 的驻留。保持 PDF.js 动态加载，不为预览额外预热完整文档运行时。

main 暂时保活。只有在预热和显示握手重新设计、热键延迟经过实机验收后，才考虑
主页面销毁重建。

### 限制插件后台工作

- 将启动时的全量 mode 数据预热改为召唤所需页面时加载，避免隐藏阶段生成无用
  DOM、模型和图标请求。
- 对非活动嵌入页面使用有界闲置回收；先取得页面快照，再卸载 DOM 和相关帧。
  `keep_session`、用户覆盖、分离窗口与有后台任务的插件按契约保留。
- 没有已加载逻辑帧且没有挂起 RPC 时销毁共享逻辑宿主；下次需要时重建并等待
  supervisor 就绪。卸载必须撤销令牌、拒绝旧请求并防止迟到结果复活页面。
- 通过 `onHide` 或明确的休眠契约要求插件停止 timer、动画与周期网络任务。
  不用隐藏 WebView 假装所有第三方代码都会自动暂停。

### 剪贴板改为事件通知

使用 message-only HWND、`AddClipboardFormatListener` 和 `WM_CLIPBOARDUPDATE`
驱动现有 `capture`。继续读取序号做去重，保留 `self_write_seq` 的写入抑制、暂停
状态、文件/图片/文本完整采集与 SQLite 写入顺序。

Windows 注册失败时记录错误并保留有界低频序号兜底；不能在监听失效时静默丢失
剪贴板历史。

## 不建议的方案

- **不再尝试 `--renderer-process-limit=1`**：历史实测会破坏多 WebView 创建。
- **不调用 `EmptyWorkingSet` 或定时强制清空工作集**：只转移成本并增加分页、
  再次呼出的延迟，不能证明内存真正释放。
- **不把 Low 水位当作 CPU 休眠**：它不会停止 RAF、插件 timer 或网络任务。
- **不默认缩短主窗口 Low 延迟或频繁销毁主页面**：热键响应优先于瞬时数字。
- **不以删除动画代替根因修复**：当前证据不支持光标是 CPU 主因。

## 验证与测量口径

先使用内嵌前端的 release 构建，隔离数据与 WebView2 用户目录。分别测量启动
稳定后、隐藏 30 秒、首次呼出、插件页、设置和预览打开再关闭后的状态，并比较
同一机器、同一构建配置下的增量。

CPU 使用进程树采样前后的 `TotalProcessorTime` 差值：

```text
整树逻辑处理器百分比 =
  Σ(进程 CPU 时间差) / 采样秒数 / 逻辑处理器数 × 100%
```

任务管理器百分比还受采样窗口影响，不能用累计 CPU 时间判断当前占用。
诊断脚本保存的 `oneCorePercent` 是单核口径，不是整机百分比。

内存同时记录：

- 任务管理器接近口径的 Private Working Set，便于与仓库历史比较；
- Private Bytes / committed memory，避免 Low 水位换出后漏算驻留成本；
- browser、GPU、utility、renderer 分项与 renderer 数量。

内存验收应同时给出固定运行时成本与页面功能增量，不宣称所有内存都能压缩到
任意固定数值。可复用 `scripts/measure-webview-mem.ps1`，但它目前按进程名取首个
Lume 实例；测量隔离会话前应先适配根 PID，避免混入用户实例。

### 功能回归

- 隐藏后无页面任务时，60 秒 RAF 增量为 0，无周期性几何 IPC。
- 连续呼出/隐藏 20 次，检查尺寸、位置、焦点、透明表面与首次渲染。
- Navigate 与 fit Page Runtime 的内容变化、空态、错误页和栏目展开均能正确测量；
  剪贴板固定高度与虚拟列表不回归。
- 设置与预览各打开/关闭 10 次，验证首次创建、未保存草稿、资源释放与再次打开。
- 插件页面覆盖 `keep_session`、快照恢复、分离窗口、共享逻辑宿主重建和后台任务。
- 剪贴板覆盖文本、HTML、图片、文件、自写回、暂停与快速连续复制。
- 按变更矩阵运行 `pnpm verify:fast` 和 `pnpm verify:ui:changed`；真实热键、
  原生窗口和运行时创建 WebView 按 `docs/MANUAL_TESTING.md` 补做实机检查。

## 本次诊断限制

本机安装版进程的只读采样中，WebView2 browser 与一个 renderer 的 12 秒 CPU
增量分别约为 1.92 和 1.86 秒，而 Rust 宿主未出现相应增长。该实例安装目录
`E:\Softwares\Lume` 显示版本 3.2.0，工作区为 3.5.0，因此不将其 renderer 数量或
绝对内存值直接归因于当前源码。

首次 UI 验证失败是旧 debug 可执行文件指向未启动的 Vite 地址，未运行到功能断言。
随后 `pnpm run tauri build --debug --no-bundle` 成功，隔离 CDP 才得到有效数据。
正式验收应重新运行 `pnpm verify:ui --suite smoke` 及变更矩阵，不把这次环境失败
记作产品回归。

临时诊断脚本与原始 JSON 位于 gitignore 的 `test/webview-resource-audit.mjs` 和
`test/webview-resource-audit/report.json`，仅作本机追溯；报告中的证据以本文为准。
