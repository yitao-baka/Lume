# 启动器窗口几何与尺寸时序专项审计（2026-10-29）

> 历史专项审计。本文保留修复前的复现证据、源码判断与建议，不定义当前行为；
> 实现与验证记录见 `docs/ROADMAP_HISTORY.md` #90，现状契约见
> `docs/ARCHITECTURE.md` 与 `docs/UI_GUIDELINES.md`。

## 范围与基线

- 仓库：LumeLauncher
- 分支：`refactor/plugin-system`
- 基线提交：`5ea91f2`
- 审查对象：主窗口创建、显示、宽度应用、内容高度调整、位置锚定、工作区限制和
  相关回归脚本。
- 运行环境：Windows 11、WebView2 `156.0.4314.50`、150% 显示缩放；
  `src-tauri/target/debug/lume.exe`（2026-10-29 03:01:54，内嵌当前 `dist/`）。
- 方法：源码走查；当前 debug exe 的 CDP/DOM 尺寸采样；独立 PowerShell 探针约
  1 ms 轮询真实 HWND 的 `GetWindowRect`、`GetClientRect`、`ClientToScreen` 和
  可见性；`Alt+Space` 真实热键呼出；导航页与剪贴板页之间切换。
- 现场脚本位于 gitignored 的 `test/`：`window_resize_connected.mjs`、
  `window_resize_monitor.ps1`、`window_resize_live.py`。原生尺寸轨迹见
  `test/window_resize_native.txt`。

## 结论摘要

| 编号 | 严重度 | 结论 | 证据类型 |
| --- | --- | --- | --- |
| F-01 | 高 | 主窗口显示时只更新宽度，高度沿用上一次关闭前的值；最终高度靠显示后的前端异步重排 | 源码 + HWND 采样 |
| F-02 | 高 | 加载门控先于固定高度模型执行，固定高度页面也会短暂缩成搜索栏高度，再突然展开 | 源码 + HWND/DOM 同时采样 |
| F-03 | 高 | 尺寸与位置分两次操作，窗口可见时会出现“尺寸已变、位置未变”的中间帧 | 源码 + 16 ms 原生轨迹 |
| F-04 | 高 | 主窗口仍启用透明，而 UI 契约和不透明面板已经不需要透明；WebView2 重绘未完成时暴露透明客户区 | 源码；视觉后果为结构判断 |
| F-05 | 中 | resize 请求没有串行化或 latest-wins 代际，多个异步测量可重叠，后完成的不一定是最后请求 | 源码 |
| F-06 | 中 | `lastWindowH` 与 `runtimeSize` 在 `setSize()` 成功前更新；失败后去重基线失真 | 源码 |
| F-07 | 中 | 固定高度只在插件声明 `desiredHeight` 时限制到工作区；全局 `window_height`、`window_width` 和导入值没有统一上限 | 源码 |
| F-08 | 中 | 工作区高度缓存只在栏目展开/收起时失效，跨显示器、DPI 或任务栏布局变化后可能继续使用旧值 | 源码 |
| F-09 | 中 | 四角定位和跟随鼠标都使用整块显示器尺寸而不是工作区；底部预设会压到任务栏下方 | 源码 + 现有测试断言 |
| F-10 | 低 | `app.resize` 的屏幕限制来自渲染进程 `screen.avail*`，与 Rust 的当前显示器工作区不是同一个权威源 | 源码 |
| F-11 | 低 | 位置回归脚本用 `screen.height` 验证右下角，天然接受“压到任务栏下面”的结果 | 测试脚本 |
| F-12 | 低 | 当前没有覆盖可见中间态、原子几何和多 DPI 的原生窗口回归 | 测试覆盖缺口 |

## 详细发现

### F-01 显示时沿用旧高度，最终尺寸发生在显示之后

`src-tauri/src/window.rs` 的 `apply_geometry()` 只把宽度改成设置值，高度直接读取
当前内区高度并写回：

```rust
let cur = window.inner_size()?.to_logical::<f64>(sf);
window.set_size(LogicalSize::new(
    appearance.window_width as f64,
    cur.height,
))?;
```

`show()` 随即显示窗口并发出 `launcher-shown`：

```rust
apply_geometry(window)?;
window.show()?;
window.set_focus()?;
let _ = window.emit("launcher-shown", ());
```

前端在 `src/App.tsx` 收到 `launcher-shown` 后重新搜索、唤醒页面、调用
`sizer.invalidate()`，再由 `src/launcher/sizing.ts` 异步测量并 `setSize()`。
因此从隐藏状态显示出来后，窗口首先采用的是“上次使用的高度”，不是本次页面
的最终高度。

当前采样中，首页在反复显示后高度已经稳定，所以只看到同尺寸显示；但代码路径
决定：如果上次停留在剪贴板或固定高度插件页，下一次先显示导航/短页面时会先露出
旧高度，随后才收缩。

影响：

- 短内容页可能先显示成上一次的高窗口，再向下收缩。
- 高内容页可能先显示成上一次的短窗口，再向下展开。
- 显示后的 WebView2 重排、搜索和页面 `onShow()` 都可能延长这个中间态。

### F-02 固定高度页面被加载门控先缩成搜索栏

`src/launcher/sizing.ts` 的 `resizeToContent()` 先检查 `deps.loading()`，之后才
检查 `deps.fixedHeight()`：

```ts
if (deps.loading()) {
  const searchH = document.querySelector(".search")?.offsetHeight ?? 0;
  await getCurrentWindow().setSize(new LogicalSize(deps.windowWidth(), searchH));
  ...
  return;
}

if (deps.fixedHeight()) {
  ...
}
```

`.results` 的加载门控只是 `visibility: hidden`，见 `src/App.css`：

```css
.results-loading {
  visibility: hidden;
}
```

剪贴板页首次进入时 `ready()` 为 false，因此整个窗口先变成搜索栏高度；页面模型
就绪后，同一位置再拉高到设置高度。当前源码构建的实测轨迹：

```text
05:32:45.727 vis=False outer=735x286  client=720x278
05:32:46.339 vis=True  outer=735x286  client=720x278   // 显示首页
05:32:48.189 vis=True  outer=735x69   client=720x60    // 切到剪贴板，loading
05:32:49.030 vis=True  outer=735x529  client=720x520   // 页面就绪，先长高
05:32:49.046 vis=True  outer=735x529  client=720x520   // 16 ms 后才重新居中
```

DOM 同步采样确认：

```text
loading=true   inner=720x60
loading=false  inner=720x520
```

这里是约 840 ms 的可见收缩期，不是单个合成帧。慢磁盘、首次数据库加载或帧桥
握手会让它进一步变长。

影响：

- 固定高度页面不应该改变窗口高度，却会先收缩再展开。
- 用户会看到整块面板突然只剩搜索栏，再迅速弹回。
- 周围桌面会通过透明窗口区域显现，放大“透明超长/闪动”的观感。

### F-03 尺寸和位置不是原子操作

所有 resize 分支都采用同一种两段式顺序，例如：

```ts
await getCurrentWindow().setSize(new LogicalSize(deps.windowWidth(), h));
await invoke("apply_position");
```

固定高度、Presenter 上报高度和 DOM 测量分支重复了这段逻辑。`apply_position`
再从 Rust 读取当前窗口位置、当前显示器并重新计算锚点。

实测从剪贴板切回首页时：

```text
05:32:50.479 vis=True outer=735x286  y=269
05:32:50.495 vis=True outer=735x286  y=390
```

尺寸不变，但位置在 16 ms 后才更新。剪贴板展开时也有同样的两段式：

```text
位置先保持 y=499，高度从 69 变到 529，下一帧才移动到 y=269。
```

影响：

- 居中窗口在增大时会先向下展开，再整体跳回中心。
- 四角窗口会先向屏幕内侧长，再贴回角点。
- 跟随鼠标窗口会先以旧位置长高，再重新居中。
- 用户感知为“闪一下”“抽动”“超长窗口”。

### F-04 主窗口仍启用透明，透明区域直接暴露桌面

主窗口构建仍启用：

```rust
.transparent(true)
```

而 `src/App.css` 的 `html`、`body`、`#root` 仍是透明：

```css
html, body, #root {
  background: transparent;
}
```

只有 `.launcher` 是不透明 `--surface`：

```css
.launcher {
  background: var(--surface);
}
```

当前视觉契约明确要求一块连续的不透明面板，且 Acrylic 已撤除。主窗口继续透明
只保留了“WebView2 尚未绘满客户区时露出桌面”的窗口。尺寸增长、页面切换、
WebView2 合成或强制重绘期间，新区域可能先透明后着色。

本次验证没有做逐帧屏幕像素捕获，因此“用户看到的具体透明帧”属于源码结构和
原生几何轨迹的强关联判断，不是像素级证据。透明窗口本身由源码直接确认。

影响：

- F-01、F-02、F-03 的任何尺寸中间态都会同时呈现为透明区域。
- 即使最终尺寸正确，重绘竞态也可能产生一闪而过的透明条。
- 透明窗口与当前“不透明单色面板、无 Acrylic、DWM 负责圆角”的契约冲突。

### F-05 resize 请求没有串行化或 latest-wins 代际

`sizing.ts` 的调度器只是每个调用投递一个 `requestAnimationFrame`：

```ts
function scheduleResize() {
  requestAnimationFrame(() => void resizeToContent());
}
```

`resizeToContent()` 内部有多个 `await`（`ensureWorkArea()`、`setSize()`、
`apply_position()`），但没有互斥、队列或请求编号。当前可能的触发源包括：

- 加载门控翻转：`src/App.tsx` 的 `pageLoading()` effect。
- 搜索完成：导航页与插件页的 `search()`。
- 显示事件后 `beginSummon()` 和页面 `onShow()`。
- 栏目数据刷新、展开/收起、图标完成和栏列数变化。
- 皮肤/尺寸设置变化。
- 插件 `app.resize`。

这些请求可以重叠。代码没有保证“最后发起的测量最后落地”，也没有在页面或显示器
变化后丢弃旧响应。当前采样尚未捕获旧请求覆盖新请求的具体一帧，但调用结构允许
它发生。

影响：

- 快速切页、收展栏目或调整设置时，窗口可能落回旧尺寸。
- 慢 IPC 或慢剪贴板首载后会加重尺寸抖动。
- 仅靠 `lastWindowH` 去重无法区分两次目标相同但上下文已经变化的应用。

### F-06 去重基线和运行时尺寸在成功前更新

每个分支都先写 `lastWindowH` 和 `runtimeSize`，再等待系统调用：

```ts
lastWindowH = targetH;
deps.setRuntimeSize(deps.windowWidth(), targetH);
await getCurrentWindow().setSize(...);
await invoke("apply_position");
```

如果 `setSize()` 或 `apply_position()` 失败：

- `lastWindowH` 认为目标已经应用，下一次相同目标会被提前跳过。
- `runtimeSize` 已经反映请求值，但实际窗口没有到该尺寸。
- 插件后续省略轴的 `app.resize` 会以错误基线补齐另一轴。

这不是当前透明闪烁的主因，但会留下“某次失败后再也不纠正”的持久偏差。

### F-07 高度、宽度没有在工作区边界统一钳制

固定高度分支只在页面声明了 `desiredHeight` 时读取工作区：

```ts
let h = declared != null && Number.isFinite(declared) ? declared : configured;
if (declared != null) {
  await ensureWorkArea();
  const screen = deps.workAreaH();
  if (screen) h = Math.min(h, screen - SCREEN_MARGIN);
}
```

使用全局 `window_height` 时不读取工作区，也没有上限。宽度在以下路径同样没有统一
钳制：

- `window::apply_geometry()`：显示时应用 `window_width`。
- `window::apply_settings()`：保存/应用时再次应用 `window_width`。
- `Settings::normalize()`：只规范化皮肤和主题色，没有限制尺寸。
- 设置 GUI 的宽度/高度目前只有预设按钮，没有自由输入，但导入、备份恢复和手改
  `settings.toml` 可以写入任意 `u32`。

影响：

- 超高配置会让固定高度页面越过任务栏甚至屏幕边缘。
- 超宽配置可能越过当前显示器工作区。
- 不同入口（内容测量、插件 resize、设置保存、显示恢复）采用不同限制，行为不一致。

### F-08 工作区缓存不会随显示器或 DPI 变化自动失效

`workAreaH` 的注释是“缓存到下一次展开切换清空”，实际清空入口在导航页栏目的
`invalidateWorkArea()`。显示、切页、窗口移动到另一台显示器、系统 DPI 变化和任务栏
布局变化都没有清除该缓存。

`get_work_area` 每次调用会读取当前显示器的 `work_area()`，但一旦前端缓存，后续
高度计算不再请求 Rust。把窗口从 100% 显示器拖到 150% 显示器，或改变任务栏尺寸
后，展开高度可能继续按旧工作区计算。

影响：

- 跨显示器后展开栏可能过高或过矮。
- 混合 DPI 下可能出现错误居中、越界或额外滚动。
- 缓存值无法代表“当前显示器”，与本命令的语义不一致。

### F-09 四角定位与跟随鼠标使用整块显示器，而不是工作区

`place_initial_position()` 对四角使用：

```rust
let area = monitor.size();
```

而不是 `monitor.work_area()`。`position_at_mouse()` 的鼠标点限制同样使用
`monitor.size()`。因此右下、左下和跟随鼠标的底部限制都包含任务栏区域。

现有 `scripts/cdp_window_position_verify.mjs` 对右下角的断言是：

```js
r6.bottom >= sh - 20
```

其中 `sh = screen.height`。这会接受窗口底边贴住整块屏幕底部，即使窗口内容被
任务栏遮住。该脚本因此无法发现这个相邻问题。

影响：

- 底部两个位置预设可能与任务栏重叠。
- 跟随鼠标在屏幕底部附近会把窗口底边放进口任务栏区域。
- 高窗口 + 底部预设时，实际可见内容比 Windows 工作区少。

### F-10 `app.resize` 使用渲染进程屏幕值作为上限

`src/App.tsx` 的 `resizeWindow()` 使用：

```ts
const maxW = Math.floor(window.screen.availWidth || 4096);
const maxH = Math.floor((window.screen.availHeight || 4096) - SCREEN_MARGIN);
```

这是第二套与 Rust `get_work_area()` 不同的限制来源。`window.screen` 的语义取决于
WebView2 当前 target/monitor 状态，跨屏或混合 DPI 时不一定与 Rust
`WebviewWindow::current_monitor().work_area()` 同步。

影响：

- 同一个插件 resize 在普通高度、跨屏和混合 DPI 下会得到不同上限。
- 渲染进程刚跨屏、显示器热插拔或窗口仍在旧位置时，上限可能短暂过时。
- 几何真值同时存在于前端和 Rust，后续修复容易再次分叉。

### F-11 现有位置回归对任务栏边界存在假通过

除了 F-09 的断言上限，现有测试主要验证“最终位置接近预设”，没有验证：

- 最终 outer rect 是否完全位于当前显示器工作区内。
- 窗口是否覆盖任务栏。
- 尺寸变化和位置变化是否发生在不同的可见帧。
- 固定高度页面加载时是否出现搜索栏高度的中间帧。

因此现有脚本可以在“最终中心/角点大致正确”的情况下继续通过。

### F-12 当前缺少原生可见中间态回归

现有的页面运行时、视觉审计和位置脚本都在尺寸稳定后读取 DOM 或 HWND。没有脚本
以毫秒级轮询真实 HWND，并断言：

- 窗口可见期间不出现非最终尺寸。
- 尺寸和位置不会跨帧变化。
- 所有可见矩形都在工作区内。
- 固定高度页面不会出现 `60` 高度的可见帧。

本次审计使用的原生探针只是临时 scratch，尚不是仓库回归套件的一部分。

## 实测轨迹与解释

### 剪贴板首次进入

```text
05:32:48.189  vis=True  outer 735x69   client 720x60    loading
05:32:49.030  vis=True  outer 735x529  client 720x520   page ready，位置仍旧
05:32:49.046  vis=True  outer 735x529  client 720x520   apply_position 完成
```

这段同时证明：

- 固定高度页确实经过了搜索栏高度。
- `setSize()` 和 `apply_position()` 不是同一帧的原子操作。
- 加载期间 `.results` 隐藏，但窗口本身仍然可见。

### 从剪贴板返回首页

```text
05:32:50.479  vis=True  outer 735x286  y=269
05:32:50.495  vis=True  outer 735x286  y=390
```

尺寸已经变为首页高度，但位置在 16 ms 后才更新。即使没有“超长”尺寸变化，
居中也存在可见跳动。

### 热键首次显示

```text
05:32:46.339  vis=True  outer 735x286  client 720x278
```

本次首页高度与上次高度恰好相同，因此没有看到旧高度差；但源码路径显示高度并不是
在 show 前按本次页面计算的。

## 建议

### 1. 主窗口改为不透明

- 主窗口构建改为 `.transparent(false)`。
- 设置原生窗口背景为当前 `--surface`，避免首帧未绘制时露出系统默认底色。
- 保留 `shadow(true)`、`decorations(false)` 和 DWM 圆角。
- 系统中暗模式变化时同步原生背景色。
- `.launcher` 继续作为客户区的不透明最终表面。

这是消除“透明超长窗口”最直接、风险最低的一步。

### 2. 提供 Rust 侧原子几何命令

不要让前端连续调用 `setSize()` 和 `apply_position()`。建议增加一个命令，例如
`apply_launcher_geometry`：

1. 接收目标客户区宽高和锚点意图。
2. 在 Rust 读取当前显示器 `work_area()`。
3. 将目标客户区尺寸限制到工作区。
4. 计算最终 outer rect 和目标位置。
5. 用一次 `SetWindowPos` 同时提交尺寸与位置。

前端只等待一次结果。显示路径、内容测量、设置应用和插件 resize 都走同一入口。

### 3. 固定高度页面不要在加载时收缩

- 固定高度页面在首次 `ready()` 前继续隐藏 `.results`，但窗口保持目标固定高度。
- 只有 `heightPolicy() === "fit"` 的页面才按搜索栏 + 内容高度调整。
- 固定高度插件清单 `height` 与全局 `window_height` 使用相同的上限逻辑。
- 如果需要“首帧绝不显示半加载内容”，优先控制页面可见性，不要控制整个窗口高度。

### 4. 使用 latest-wins 的串行 resize 状态机

- 一次只允许一个几何请求执行。
- 排队时只保留最后一个目标。
- 每个请求带 generation；旧 generation 不得提交结果或覆盖 `runtimeSize`。
- `lastWindowH` 只在 `setSize()`/原子几何命令成功后更新。
- 页面切换、显示器切换和设置变化时使旧 generation 失效。

### 5. 统一工作区权威源

- 宽度、高度、四角定位和跟随鼠标全部使用当前显示器 `work_area()`。
- `Settings::normalize()` 或几何边界统一限制导入值。
- `window_width`、`window_height`、插件 `desiredHeight` 和 `app.resize` 不再各自
  维护不同的上下限。
- `app.resize` 最终也调用同一个 Rust 几何入口。

### 6. 让工作区缓存可失效

- 在显示、切页、`Moved`、`ScaleChanged`、显示器变化和任务栏工作区变化时清除缓存。
- 或者取消前端长期缓存，由原子几何命令每次读取当前工作区。

### 7. 修正底部定位

- `place_initial_position()` 改用 `monitor.work_area()` 的原点和尺寸。
- `position_at_mouse()` 的 clamp 同样使用工作区。
- 四角定位以工作区四边为基准。
- 更新位置回归断言：右下/左下和跟随鼠标都必须完全落在工作区内，窗口底边不得进入
  任务栏。

### 8. 增加原生几何回归

建议新增脚本，按约 1 ms 轮询真实 HWND：

- 固定高度页面首次进入时，任何可见帧都不得出现搜索栏高度。
- 尺寸和位置必须在同一可见帧完成变化，或允许列表为空。
- 所有可见 outer rect 必须位于当前显示器工作区内。
- 至少覆盖 100%、150%、200% DPI 和跨显示器场景。
- 用真实 `Alt+Space` 呼出，不只通过 `toggle_launcher` 命令。
- 同轮比较透明关闭前后的屏幕像素；若仍有透明像素，直接失败。

## 未覆盖

- 未对“透明客户区”做逐帧屏幕像素捕获；F-04 的具体视觉范围是结构判断。
- 未在 200% DPI 和真实双显示器混合缩放环境中重复本轮轨迹。
- 未触发显示器热插拔、任务栏位置变化和系统 DPI 在线变化。
- 未把临时原生探针提交为正式脚本。
- 未改动生产代码、设置文件或当前窗口行为。
