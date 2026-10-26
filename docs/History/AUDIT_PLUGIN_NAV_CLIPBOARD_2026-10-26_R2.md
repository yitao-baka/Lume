# 插件系统、导航页与剪贴板页专项审计报告

> 审计基线：`refactor/plugin-system`，HEAD `c3c798f`（2026-10-26）。
>
> 审计范围：磁盘插件发现与加载、逻辑宿主、权限台账、Page Service / Presenter
> 运行时、导航栏目与 Provider 搜索、剪贴板 Page Service、两个剪贴板
> Presenter、Rust 剪贴板命令与现有 CDP 回归。
>
> 方法：阅读 `docs/ARCHITECTURE.md`、`docs/UI_GUIDELINES.md`、
> `docs/PLUGIN_API.md`、`docs/PLUGINS.md`、`docs/SETTINGS.md` 与
> `docs/TESTING.md`；对当前源码做静态走查；运行前端、Rust、单元测试和 CDP
> 回归；最后用 `test/` 下的隔离夹具构造冷启动、异步、键盘和剪贴板边界。
> `test/` 是本机 scratch，不属于业务源码或交付物。本轮不需要 UAC，所有测试
> 都在普通用户权限下运行。

## 结论摘要

本轮确认 11 项可操作的实现缺陷，另有资源边界和验证质量事项。未发现新的
跨进程提权链路；插件 iframe、Rust 权限门和网络 CSP 的既有正常路径仍然通过
专项回归。风险最高的是 Page Runtime 冷启动生命周期丢失、Presenter 自动快照
捕获密码输入、剪贴板 HTML 截断可能 panic，以及导航把插件合成行当作普通应用
处理。

| 编号 | 严重度 | 区域 | 结论 |
|---|---|---|---|
| F-01 | 高 | Page Runtime | 冷启动时 `onShow` 等生命周期没有可靠排队；嵌入 Presenter 的 `show`/`hide`/首次 `query` 也没有完整重放 |
| F-02 | 高 | Presenter 快照 | 自动快照和帧状态会读取 `input[type=password]` 的值，违反文档隐私契约 |
| F-03 | 高 | 剪贴板采集 | HTML 超过 64 KiB 时按字节截断，可能落在 UTF-8 字符中间并使监听线程 panic |
| F-04 | 中 | 剪贴板采集 | `last_text`/`last_files`/`last_image_hash` 跨载荷种类残留，导致重复复制不记录，`dedup = false` 也不能保证每次复制入历史 |
| F-05 | 中 | 剪贴板采集 | 捕获文本先 `trim()`，复制/粘贴会丢失首尾空格 |
| F-06 | 中高 | 剪贴板粘贴 | `paste_close = false` 时只抑制自动隐藏，没有把焦点交回目标窗口，Ctrl+V 会发给启动器 |
| F-07 | 中 | 剪贴板状态 | 暂停失败不回收 UI 状态；清空在后台命令完成前就查询历史，可能显示旧行且没有失败提示 |
| F-08 | 中 | 导航页 | Provider/feature 合成路径仍获得 Pin、打开位置、管理员启动等普通应用菜单；无 `select` 的 `drill` 行还会退化成合成路径启动 |
| F-09 | 中 | 插件私有文件 | 私有目录固定按 manifest `id` 拼接，manifest `id` 与目录名不同的合法插件会写入错误目录 |
| F-10 | 中 | Presenter 生命周期 | Presenter 切换后 `modal`/`layout` 状态不复位，旧 Presenter 的模态或高度会污染新 Presenter |
| F-11 | 中 | 列表模板 | `template = "list"` 适配器没有搜索代际保护、行预算，首次激活也缺少 `onShow` |
| F-12 | 中低 | 插件/host 资源边界 | 多个读取路径先分配后检查大小；图片只限制压缩字节，没有限制解码尺寸；manifest 的 feature/keyword 数组没有上限 |
| F-13 | 低 | 验证质量 | 现有 `cdp_plugin_mode_bar_verify` 仍使用无 `path` 的 Provider 行，和新预算门不一致，导致 4 个失败断言 |

## F-01 Page Runtime 冷启动生命周期与页面事件重放不完整

**严重度：高**

**位置**

- `src/plugins/pageRuntimeMode.tsx:175-192`：`ensureStarted()` 只补投
  `pendingQuery`，没有 `pendingShow`、`pendingSettings` 或
  `pendingFilesDropped`。
- `src/plugins/pageRuntimeMode.tsx:473-479`：`onShow()` 先判断
  `serviceStarted`，服务尚未启动就直接返回；`onHide()` 也没有向 Presenter
  发 `hide`。
- `src/plugins/pageRuntimeMode.tsx:485-486`：首次设置和文件拖入直接调用
  `session.settings/filesDropped`，在 `session.start()` 尚未完成时不会排队。
- `src/page-runtime/presenterBridge.tsx:394-409`：Presenter ready 回调重放
  `model`、`settings`、`theme`、`skin`，没有重放当前 `query` 或 `show`。
- `src/plugins/pageRuntimeMode.tsx:482-483`：`onEnter` 直接发页面事件，
  首次挂载时事件可能早于 iframe bridge 的 ready 状态。

**复现**

使用 `examples/plugins/hidden-mode` 的隔离副本，在 Page Service 中加入：

```js
let shown = false;
function snapshot() {
  return {
    // ...
    data: { showObserved: shown },
  };
}
return {
  async getModel() {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return snapshot();
  },
  onShow() {
    shown = true;
    ctx.page.publish(snapshot());
  },
  // ...
};
```

从导航 feature 行首次进入该模式，等待 Page Model 发布后读取
`window.__pageRuntimeLatestModel("hidden-mode")`。结果为：

```json
{
  "enter": { "code": "note", "payload": "hush:audit-cold", "type": "regex" },
  "shown": false
}
```

`enter` 载荷能够到达，是因为 `session.start()` 在等待 `getModel()` 前已经把
`remoteService` 写入 `session.service`；但 `onShow()` 明确受
`serviceStarted` 门控，等待中的服务启动没有补投。慢 `getModel()` 只是把原本
存在的竞态窗口放大，不是复现夹具特有的行为。

**影响**

- 依赖 `onShow()` 初始化缓存、监听器、索引状态的插件在首次进入时不会初始化。
- 首次声明式设置可能没有落到 Page Service；当前 `applyPluginSettings()` 在
  registry 加载插件后立即调用，而 `PageRuntimeMode.session.service` 此时仍可能
  是 `null`。
- 嵌入启动器的 Presenter 收不到 `lume.on.show` / `lume.on.hide`；依赖事件重置
  输入、暂停动画或开始/停止轮询的插件会出现状态错位。
- 首次 `lume.on.query` 可能在 iframe 尚未 ready 时丢失；虽然大多数插件可以从
  Page Model 读取 `query`，但 bridge 的事件契约并不等价。

**建议**

1. 在 `PageRuntimeMode` 内维护按顺序的生命周期队列，至少在
   `ensureStarted()` 后补投 `show`、`settings`、`filesDropped` 和最新的
   `query`；队列要按代际丢弃已卸载页面的旧事件。
2. `PresenterBridge` 的 ready 回调应重放当前 `query` 和当前 `show` 状态；恢复
   snapshot/enter 时保持文档规定的 `query -> show -> enter` 顺序。
3. `PageRuntimeMode.onShow`/`onHide` 同步调用 `postBoth("show"|"hide")`，并
   让 `onShow` 在服务尚未启动时等待一次启动完成。
4. 增加从全新进程直接点击 feature/redirect 进入一个慢 Page Service 的回归，
   断言 `onShow`、`onSettings`、`onQuery`、`on.show` 和 `on.query` 都到达。

## F-02 Presenter 自动快照捕获密码输入

**严重度：高**

**位置**

- `docs/PLUGIN_API.md:543` 明确规定
  “`password` 字段只保存 checked 等状态，不读取值”。
- `src/page-runtime/presenterBridge.tsx:76-80` 的 `fieldValue()` 对所有非
  checkbox/radio 输入返回 `el.value`，没有 password 分支。
- `src/page-runtime/presenterBridge.tsx:82-86` 的 `captureState()` 把值直接放进
  `__lumeFrameState`。
- `src/page-runtime/presenterBridge.tsx:95-103` 的 `captureSnapshot()` 把同样的
  值放进自动快照。

**现象**

任何 Presenter 只要使用标准密码输入，例如：

```html
<input id="api-key" type="password" value="sk-live-..." />
```

用户输入后，`input` 或 `change` 事件会触发 `scheduleReport()`；主窗口的
`__frameStates` 环形缓冲会收到明文值。切换 Presenter、detach、关闭回流或
keep-alive LRU 淘汰时，自动快照也会包含该值。快照虽然只在内存中流转，但会经
Tauri 事件、窗口桥和调试探针暴露给宿主代码和 CDP。

**影响**

- 违反 API 的隐私契约，插件作者有合理理由把密码输入视为不会进入宿主持久化/
  诊断状态的内容。
- 插件设置页或独立窗口的 CDP 日志、`__frameStates` 和会话快照会留下密钥；
  这对使用 `lume.page` 自建密码输入或 API Key 输入的插件尤其敏感。
- 如果旧快照被恢复，密码框的值可能被覆盖或重新注入。

**建议**

在页面侧同时修复 `captureState()` 与 `captureSnapshot()`：

```js
if (el.type === "password") {
  value = "";
  // 只保留 checked 等非秘密状态
}
```

宿主侧不要把“字段类型”作为信任前提；可以在 bridge 协议中附带 `secret` 标记，
或在宿主再执行一次保守脱敏。增加一个真实密码输入输入-快照-恢复回归，断言自动层
的 value 为空而 checked 仍保留。

## F-03 剪贴板 HTML 截断可能 panic

**严重度：高**

**位置**

- `src-tauri/src/clipboard.rs:71`：`HTML_CAP` 为 64 KiB。
- `src-tauri/src/clipboard.rs:1015-1021`：`cb.get().html()` 后直接调用
  `h.truncate(HTML_CAP)`。

`String::truncate` 要求新长度落在 UTF-8 字符边界；富文本里出现中文、emoji 或
其他多字节字符时，64 KiB 字节位置很可能落在字符内部。监听线程中的 panic 不只
会让当前这次复制丢失，还会让后续剪贴板采集停止。

**复现**

独立 Rust 最小验证：

```rust
fn main() {
    let mut s = String::from("a".repeat(65535));
    s.push('中');
    s.truncate(65536);
}
```

运行结果：

```text
thread 'main' panicked at ...
assertion failed: self.is_char_boundary(new_len)
```

业务路径位于 `spawn_listener` 调用的 `capture()` 中，因此 panic 会发生在剪贴板
监听线程，而不是可被当前命令错误处理的 Promise 中。

**建议**

使用字符边界安全的截断方式，例如：

```rust
let cut = h
    .char_indices()
    .take_while(|(index, _)| *index <= HTML_CAP)
    .map(|(index, _)| index)
    .last()
    .unwrap_or(0);
h.truncate(cut);
```

同时增加包含多字节字符且长度刚好跨过 64 KiB 的回归，并在截断后尽量闭合 HTML
标签或明确标记 HTML 不可用。

## F-04 剪贴板重复复制被旧 `last_*` 状态吞掉

**严重度：中**

**位置**

- `src-tauri/src/clipboard.rs:1023-1034`：只有文本内容与 `last_text` 不同才写入。
- `src-tauri/src/clipboard.rs:1048-1057`：文件列表只在 `last_files` 不同才写入。
- `src-tauri/src/clipboard.rs:1075-1081`：图片只在 `last_image_hash` 不同才写入。
- 这三处都没有在切换载荷种类或检测到自己的剪贴板写入时更新其他 `last_*` 状态。

**复现**

用 CDP 在调试版启动器中执行下面的序列：

1. 将设置 `clipboard.dedup` 设为 `false`。
2. 写入文本 `STALE-SKIP-...`。
3. 写入一次 1×1 PNG。
4. 再次写入完全相同的文本。

查询剪贴板历史得到：

```json
{
  "firstCount": 1,
  "secondCount": 1,
  "firstCreated": 1793019969695,
  "secondCreated": 1793019969695
}
```

第二次文本没有新增历史行，也没有 bump 时间；即使 `dedup = false`，重复复制仍然
被跳过。连续两次复制同一文本也有同样的问题。

**影响**

- “关闭内容去重”在真实采集路径中不可用；用户复制同一段代码或同一文件列表时
  无法在历史里得到两次使用记录。
- 文本 → 图片 → 文本、文件 → 文本 → 文件等混合序列会错误复用旧状态。
- 与“每次复制都应记录”的剪贴板语义不一致，也让排障很难解释。

**建议**

把“跳过自己的写回”从内容比较改成序列号/写回标记：

- 在 `copy_clipboard`/`paste_clipboard` 写回后记录本次 `GetClipboardSequenceNumber`，
  监听器只跳过该明确序列；
- 或者每种载荷种类被检测到时清空其他种类的内容守卫；
- 新增文本→图片→文本、文件→文本→文件、`dedup = false` 连续相同内容三类回归。

## F-05 文本首尾空格被 `trim()` 丢弃

**严重度：中**

**位置**

- `src-tauri/src/clipboard.rs:1013`

```rust
let text = text.trim().to_string();
```

**复现**

通过主窗口写入：

```text
"  AUDIT-WS-...  "
```

等待监听器轮询后查询历史，返回的 `content` 只有：

```text
"AUDIT-WS-..."
```

**影响**

复制代码缩进、Markdown 片段、命令行参数、SQL/JSON 模板或需要保留首尾空白的
文本时，复制回目标应用会得到不同内容。即便空白只在头部，也可能破坏脚本语法。

**建议**

只使用 `trim()` 判断是否为空，不改变实际保存值：

```rust
if text.trim().is_empty() {
    return;
}
let stored = text.to_string();
```

如果产品确实希望去除首尾空白，应在设置或文档中明确说明，并同步修改历史/去重/
回归预期。

## F-06 `paste_close = false` 时 Ctrl+V 发给启动器

**严重度：中高**

**位置**

- `src-tauri/src/clipboard.rs:2127-2131`：只有 `paste_close` 为真才调用
  `hide_launcher()`；关闭时为假，只调用 `suppress_hide(focus, 1500)`。
- `src-tauri/src/clipboard.rs:2138`：随后直接执行 `send_ctrl_v()`。
- `auto_paste()` 在进入这里之前没有调用 `SetForegroundWindow` 或等价的焦点切换。

**现象**

启动器显示时会 `show()` 并 `set_focus()`，当前前台窗口是主窗口。`paste_close`
为假的分支只是抑制自动隐藏，因此 `SendInput` 的 Ctrl+V 仍发送给启动器；目标
窗口没有重新获得焦点。结果可能是启动器搜索框被粘贴、目标应用没有收到内容，
而前端仍收到 `outcome = "pasted"` 并显示成功提示。

**建议**

- 在发送 Ctrl+V 前显式把焦点交回已记录的 `last_hwnd`，等待焦点切换后再执行
  SendInput；失败时返回结构化 `copied`/失败，不要报告 `pasted`。
- 发送后如果仍要保持启动器可见，再以不抢走目标的方式重新显示/聚焦启动器，
  或延长并正确管理 `suppress_hide`。
- 增加“关闭粘贴后自动隐藏”开关为假时的真实 WinForms 文本框回归：目标
  TextBox 得到内容，启动器搜索框保持原文，前端显示真实结果。

## F-07 剪贴板清空/暂停的失败与顺序问题

**严重度：中**

**位置**

- `src/plugins/clipboard/store.ts:296-301`：先 `setClipPaused(next)`，再异步调用
  `set_clipboard_paused`；失败只 `console.error`，不恢复 UI，也不提示用户。
- `src/plugins/clipboard/store.ts:305-315`：`clear_clipboard` 是 fire-and-forget，
  当时立即清空多选并调用 `services.runSearch()`；没有等待清空命令完成。
- 同文件 `deleteItem()` 与 `undoDelete()` 也只把失败写 console，没有 toast。

**验证**

用 mock IPC 注入两个失败条件：

- `set_clipboard_paused` 必定 reject；
- `clear_clipboard` 延迟 40 ms 完成。

在 `createClipboardStore()` 上调用 `toggleClipPause()` 和 `doClear()`，观察到：

```json
{
  "pauseStillVisible": true,
  "searchBeforeClear": true,
  "events": [
    { "cmd": "load_language_files" },
    { "cmd": "set_clipboard_paused" },
    { "cmd": "clear_clipboard" }
  ],
  "searches": [""]
}
```

暂停 UI 仍显示暂停，实际后端没有确认；清空尚未完成时搜索已经启动，慢数据库上会
读到旧历史并重新渲染，随后没有成功后的第二次刷新。

**影响**

- 隐私相关开关显示“已暂停”，实际可能仍在采集。
- 清空后列表可能暂时甚至持续显示旧数据；失败时用户没有反馈。
- `delete`/`undo` 失败只留在控制台，页面行为与用户操作不一致。

**建议**

1. `toggleClipPause` 改为 async：等待 Rust 确认后更新信号；失败回滚并 toast。
2. `doClear` 返回 `Promise<void>`，先等待 `clear_clipboard`，成功后再清多选、
   刷新查询并提示；失败保持对话框或给出明确错误。
3. 删除/撤销失败统一走本地化 toast，并让列表只在后端确认后改变。
4. 增加 mock IPC 失败和延迟测试，覆盖 UI 状态、列表顺序和提示。

## F-08 导航把插件合成行当作普通应用处理

**严重度：中**

**位置**

- `src/plugins/navigate/search.ts:87-111`：没有 `path` 的 Provider 行会得到
  `lume-plugin://...` 合成路径；`drill: true` 但 Provider 没有 `select` 时不会
  生成 `providerDrill`，却仍保留合成路径。
- `src/plugins/navigate/search.ts:117-133`：feature/keyword 行使用
  `lume-feature://...` / `lume-mode://...` 合成路径。
- `src/presenters/navigate-grid/NavigateGridPresenter.tsx` 的右键处理把结果行
  作为 `kind: "app"` 交给共享菜单。
- `src/launcher/menu.ts` 的 `buildMenuItems()` 对 `kind: "app"` 无条件提供
  Pin、启动、打开位置和管理员启动；它不知道 `featureEnter` /
  `providerEnter` / `providerDrill`。
- `src/plugins/navigate/store.ts` 的 Pin 动作把传入 path 写进 `pinned_apps`，
  没有校验是否为真实文件或 URL。

**复现**

在全新调试进程中打开 Home，输入 `hush:audit-cold`，右键点击
`Hidden Mode：进入并带这段文字` feature 行。菜单文本为：

```text
收藏启动打开文件位置以管理员身份启动
```

点击第一个（Pin）动作后，`get_pinned_apps()` 返回：

```json
{
  "id": 306,
  "name": "Hidden Mode：进入并带这段文字",
  "path": "lume-feature://hidden-mode/note"
}
```

这是一个可见的“假固定项”：后续从已固定栏点击不会进入 Hidden Mode，而会尝试
把 `lume-feature://...` 交给 ShellExecute。Provider 的 `enter`/`drill` 行和
`lume-mode://` 关键字行有同类风险。

**影响**

- 用户可以把不可启动的合成条目固定到首页，污染持久化 `pinned_apps`。
- 右键的“启动”/“打开位置”/“管理员启动”对 feature/provider 行语义错误。
- Provider 返回 `drill: true` 但忘写 `select` 时会得到一条可见但激活失败的合成
  结果，而不是可解释的错误或丢弃。

**建议**

给结果行保留 `rowKind`/`MenuState` 语义，至少区分：

```text
plain-app | provider-enter | provider-drill | feature | mode-keyword
```

- 合成行只允许“激活”（走 `activateEntry`），不显示 Pin/打开位置/管理员启动。
- `drill: true` 且没有 `select` 的行在 `providerRowToEntry()` 中丢弃或降级为
  普通行；不要留下没有处理器的合成路径。
- `pin_app` 等服务端命令增加 scheme/存在性防护，不能把 `lume-*` 内部 scheme
  写进用户 pin 集合。
- 增加右键 feature/provider 行、点击 Pin、查看 `get_pinned_apps()` 的回归。

## F-09 manifest `id` 与目录名不同时私有文件写错位置

**严重度：中**

**位置**

- `src-tauri/src/plugin_fs.rs` 的 `private_dir()`：
  `base.join("plugins").join(id).join("files")`。
- `src-tauri/src/plugins.rs` 明确允许 manifest `id` 与目录名不同，并把真实
  目录保存在 `manifest.dir`；但私有文件命令只拿到 `id`，没有使用该目录。

**复现**

把 Provider 放在 `plugins/mismatch-dir/`，manifest 写：

```toml
id = "real-id"
kind = "provider"
api = 2
entry = "main.js"
```

`main.js` 的 `search("privateprobe")` 调用
`ctx.fs.writeText("probe.txt", "ok")`。实际观察：

```json
{
  "expected": "src-tauri/target/debug/plugins/mismatch-dir/files/probe.txt",
  "actual": "src-tauri/target/debug/plugins/real-id/files/probe.txt",
  "expectedExists": false,
  "actualExists": true
}
```

**影响**

- 合法的手工安装插件无法找回自己的私有文件；升级、备份或卸载时数据看起来
  丢失。
- 如果之后安装了真正以 `real-id` 命名的另一个目录，两个插件可能共享/覆盖同一
  私有目录，破坏插件数据隔离。
- 与 `manifest.dir` 已成为 canonical 事实源的架构注释相矛盾。

**建议**

私有目录解析必须使用 canonical manifest 的真实 `dir`（或由 Rust 在令牌中携带
已 canonicalize 的插件目录），并再次做路径归属校验；不要从 `plugin_id` 重新
拼目录。增加 `id != dir` 的写、读、列表、删除、升级保留回归。

## F-10 Presenter 切换后状态没有复位

**严重度：中**

**位置**

- `src/page-runtime/presenterHost.ts:245-250`：`releaseCurrent()` 只清
  `current`/`currentPresenter`，不重置 `modal` 或 `layout`。
- `src/page-runtime/presenterHost.ts:112-116`：新 mount 只重置 presenter 相关
  字段，没有把 layout/modal 恢复为空。
- `src/plugins/pageRuntimeMode.tsx` 的 `onPresenterState` 在 `report` 为空时也
  不会清空 `layout` 信号。

**复现**

使用 PresenterHost 直接挂载两个 Presenter：

- Presenter A ready 时调用 `reportLayout({sizing:"fixed", height:555})` 和
  `setModal(true)`；
- 切换到 Presenter B，B 不报告 layout/modal。

观察到切换前后：

```json
{
  "before": {
    "presenterId": "a",
    "modal": true,
    "layout": { "sizing": "fixed", "height": 555 }
  },
  "after": {
    "presenterId": "b",
    "modal": true,
    "layout": { "sizing": "fixed", "height": 555 }
  }
}
```

**影响**

- 旧 Presenter 打开模态框后切换 Presenter，根路由仍认为页面处于 modal，可能
  吞掉切换键/全局按键。
- 新 Presenter 使用旧高度，窗口尺寸与 Presenter 报告不一致，直到新 Presenter
  再次主动报 layout。
- 在并发切换时，旧的 layout/modal 事件还可能继续污染新页面。

**建议**

`releaseCurrent()` 或 mount 初始化时显式发送一次
`{ modal: false, layout: null }`；PresenterHost 只让当前 generation 的 layout/
modal 写入状态。PageRuntimeMode 的 `onPresenterState` 应在 `report == null` 时
把本地 layout 信号恢复为默认值。增加切换 Presenter 时 modal/layout 的单元回归。

## F-11 `template = "list"` 适配器缺少生命周期、代际和预算

**严重度：中**

**位置**

- `src/plugins/listTemplate.tsx:128-145`：`search(q)` 直接 await 插件逻辑并
  `setRows()`，没有比较 `services.searchToken()` 或本地 generation。
- `src/plugins/listTemplate.tsx:136-137`：只过滤 `name` 是字符串，没有调用
  Provider 的 `sanitizeProviderRows`，行数、字段长度和总字节都没有上限。
- `src/plugins/listTemplate.tsx:147-150`：只有 `reset()` 调 `hook("onShow")`；
  返回的 ModeInstance 没有 `onShow` 属性，首次从模式栏或 feature 进入时不会走
  `reset()`。
- `src/plugins/listTemplate.tsx:169` 只有 `onHide`，没有对应的 `onShow`。

**影响**

- 慢的第一次搜索可以在新查询后把旧行写回列表，和 Provider 下钻已经修复的
  stale-result 问题相同。
- 一个有 bug 的 list 插件可用大行/长字符串占满主窗口列表，绕过 Provider 的
  64 行/192 KiB 预算。
- 依赖 `onShow()` 播种数据或刷新状态的 list 模板首次进入时不会执行。

**建议**

- 在 `search` 开头记录 `services.searchToken()` 和一个本地 generation，写入
  rows 前双重校验；新 query、切换模式、隐藏/重置都要使旧结果失效。
- 复用 `sanitizeProviderRows` 或抽出行预算函数，至少限制行数、单字段和总字节。
- 为 ModeInstance 实现 `onShow`（或在首次 search 前调用一次 `onShow`），并
  确保 `reset()` 不重复触发导致播种/刷新两次。
- 用延迟不同的 list fixture 构造 query1/query2 乱序回归。

## F-12 资源上限的在途分配与 manifest 数组

**严重度：中低（多个子项合并）**

这些子项的共同问题是“限制发生在昂贵操作之后”，或者只限制输出而不限制输入规模。
它们不一定在普通用户路径上立即触发，但插件和剪贴板都是不可信输入边界，值得在后续
加固中一并处理。

### F-12.1 文件读取先读后检查

- `src-tauri/src/clipboard.rs:1911-1931`：`get_file_text` 是同步 command，先
  `fs::read(&path)`，再检查 512 KiB 上限。
- `src-tauri/src/clipboard.rs:1940-1969`：`get_file_bytes` 在
  `spawn_blocking` 中先读完整文件，再检查 32 MiB。
- `src-tauri/src/clipboard.rs:1980-1999`：`get_file_thumb` 先读完整文件，再检查
  50 MiB，然后才解码缩略图。

即使权限门正确拒绝未声明插件，有 `fs.read` 权限的插件仍可让 host 先分配大文件
内存。`get_file_text` 还是同步 command，会直接占用 Tauri 主线程；这与项目
“文件读取必须 async / spawn_blocking”的规则不一致。

**建议**：先 `metadata()` 检查长度，再读取；`get_file_text` 迁到
`spawn_blocking`；所有返回给插件的路径读取都要有统一的字节上限。

### F-12.2 Base64 先解码后检查

- `src-tauri/src/plugin_fs.rs` 的 `plugin_fs_private_write_b64`：先
  `base64::decode(payload)`，之后 `write_private()` 才检查 10 MiB。
- `src-tauri/src/clipboard.rs:1585-1596` 的 `decode_image_payload`：先解码，
  之后才检查 32 MiB。

一个长 base64 字符串会在检查前分配相应内存。建议按编码长度先做保守上限
（例如 `encoded.len() <= max * 4 / 3 + 4`），再解码，并保留最终字节检查。

### F-12.3 图片只限制压缩字节，不限制解码尺寸

- `src-tauri/src/clipboard.rs:1620-1628`、`1820-1828`、`2260-2268` 均调用
  `image::load_from_memory()`；`get_file_thumb` 也先加载完整图片。
- 代码只限制 PNG/文件字节数，没有限制 `width * height` 或分配后的 RGBA 大小。

压缩比很高的图片可以让解码器分配远大于输入的内存。建议使用 image crate 的
解码限制/自定义 allocator，或在解码前解析图片头并拒绝超过像素/边长上限的图片；
对用户剪贴板图片和插件提交的图片使用同一套限制。

### F-12.4 manifest 的 feature/keyword 数组没有上限

- `src-tauri/src/plugins.rs` 的 `validate_manifest()` 对 Presenter 有数量上限，
  但 `features`、`keywords`、`settings`、`secrets` 没有统一长度上限。
- `src/plugins/registry.ts:1475` 附近的 `featureMatches()` 每次输入都会遍历所有
  启用插件的所有 feature；`compileFeatureRegex()` 还会执行插件提供的正则。

一个几万条 `over = true` 的 feature，或多个灾难性回溯正则，可以在每次按键时
冻结主窗口。建议在 manifest 门限制数组长度、字符串长度和正则长度；正则执行
不能只依赖 JS 正则的同步 `test()`，至少应加入延迟/超时或改用可中止的匹配方案。

## F-13 现有验证脚本与新的 Provider 门不一致

**严重度：低（验证质量）**

运行：

```text
node scripts/cdp_plugin_mode_bar_verify.mjs
```

结果为 11 个断言通过、4 个失败：

```text
FAIL ④a provider row present (explicit icon) — null
FAIL ④b explicit icon (relative path) resolves to the fixture asset — null
FAIL ④c provider row without icon present — null
FAIL ④d default row icon = plugin manifest icon (custom.svg) — null
```

脚本里的 `icon-demo` 返回：

```js
{ name: "自定义图标行", icon: "row.svg" }
{ name: "默认图标行" }
```

两行都没有 `path`，也没有 `enter`/`drill`。`sanitizeProviderRows()` 现在会按
无路径的 Provider 行丢弃它们。API 文档的 Provider 表把无 `path` 限定为动作行，
因此这更像脚本没有随预算门更新，而不是运行时新缺陷；但结果是当前验证脚本不能
作为交付门。建议二选一：

- 给 fixture 补上真实 `path`，保留“图标展示”测试目标；
- 或明确把无路径纯图标 Provider 行列为不支持，并同步更新脚本和兼容性说明。

## 验证矩阵

### 编译与单元测试

| 命令 | 结果 |
|---|---|
| `pnpm run build` | 通过（包含 `check_plugin_contract` 与 Vite 生产构建） |
| `pnpm exec tsc --noEmit` | 通过，无输出 |
| `cargo check` | 通过 |
| `cargo test` | 258 passed；9 ignored；0 failed |
| `cargo clippy --all-targets --message-format=short` | 通过，无 warning |
| `pnpm run test:page-runtime` | 17/17 通过 |
| `pnpm run test:clipboard-model` | 10/10 通过 |
| `node scripts/check_i18n.mjs` | 583 keys × 3 languages；65 组关键词配对 |

### CDP 与专项回归

| 命令 | 结果 |
|---|---|
| `node scripts/cdp_plugin_nav_clipboard_fix_verify.mjs` | 全部通过 |
| `node scripts/cdp_page_runtime_verify.mjs` | 全部通过 |
| `node scripts/cdp_clipboard_smoke.mjs` | 未出现 FAIL；最终 `leaving app running` |
| `node scripts/cdp_plugin_state_verify.mjs` | 61/61 |
| `node scripts/cdp_sandbox_verify.mjs` | 19/19 |
| `node scripts/cdp_presenter_network_verify.mjs` | 通过 |
| `node scripts/cdp_plugins_pane_verify.mjs` | ALL PASS |
| `node scripts/cdp_lupx_verify.mjs` | ALL PASS |
| `node scripts/cdp_plugin_audit_runtime_verify.mjs` | 通过 |
| `node scripts/cdp_circuit_verify.mjs` | 通过 |
| `node scripts/cdp_plugin_mode_bar_verify.mjs` | 11 通过，4 失败；原因见 F-13 |

### 本轮隔离复现

- `test/audit_repro.mjs`：冷 feature 进入慢 Page Service；
  `onEnter` 到达，`showObserved = false`。
- `test/audit_private_fs.mjs`：`mismatch-dir` + manifest `id = "real-id"`；
  实际写入 `plugins/real-id/files/probe.txt`。
- `test/audit_clip_sequence.mjs`：文本→PNG→相同文本，`dedup = false` 时只留下
  一行，创建时间未变化。
- `test/audit_store_unit.mjs`：暂停 IPC 失败后 `clipPaused` 仍为 `true`，清空
  命令完成前已经调用 `runSearch()`。
- `test/audit_presenter_state.mjs`：Presenter A → B 后 modal/layout 仍为 A 的值。
- `test/html_truncate.rs`：64 KiB 边界的多字节字符串触发
  `is_char_boundary` panic。

这些文件位于 `.gitignore` 覆盖的 `test/` scratch 目录，不纳入提交；报告保留了
最小复现形态。

## 工程改进建议

### 1. 把 Page Runtime 的“启动中”状态变成可证明的状态机

`PageRuntimeMode` 当前用 `serviceStarted` 布尔值和零散的 `pendingQuery` 管理
启动。建议把一个页面的生命周期事件统一进队列：

```text
pending = { query, show, settings, filesDropped }
```

只有服务 ready 后按事件产生顺序 flush；卸载/重载用 generation 清空旧队列。这样
`onShow`、`onSettings`、`onFilesDropped` 不需要各自判断 `serviceStarted`，也不会
再次出现“某个布尔门漏掉一类事件”的问题。

### 2. 统一 Presenter 的脱敏、重放和切换清理

- 自动快照字段要带 `secret` 语义，password 永不进入值层。
- ready 回调要重放 query/show，并保留 query → show → enter 顺序。
- `PresenterHost.mount()` 开始前清空 modal/layout，只允许当前 generation 写入。
- 旧 factory 的 bridge、titlebar bridge 和 signal 副作用要被 generation 隔离，
  不能只依赖 PresenterHost 丢弃旧 handle。

### 3. 把剪贴板采集做成“序列 + 载荷种类”状态机

当前多个 `last_*` 守卫没有一个统一的 clipboard sequence。建议记录：

```text
{ sequence, kind, selfWriteSequence }
```

只在 `sequence == selfWriteSequence` 时跳过自己的写回；载荷种类变化时清理不再
适用的守卫。这样同时解决重复复制、跨类型残留和自写回识别。

### 4. 让导航菜单理解“行类型”，而不是复用 AppEntry

共享菜单的窄接口应扩展到 `rowKind`/`specialAction`。对所有 `lume-*` scheme
和 Provider 动作行，菜单只提供语义激活，不允许 Pin、打开位置或管理员启动。
服务端 `pin_app` 也应对内部 scheme 做拒绝式防御。

### 5. 插件私有路径以 canonical directory 为准

插件身份使用 manifest `id`，文件访问使用 canonical `manifest.dir`。不要把二者
混在同一个字符串拼接函数里；`id != dir` 是文档允许的合法状态，应有独立回归。

### 6. 把资源限制放到分配之前

建议建立统一的 `bounded_read` / `bounded_decode` 工具：

- 先 metadata/编码长度检查；
- 图片先解析尺寸，再分配 RGBA；
- 所有插件输入经过同一个 byte/pixel/node 预算；
- manifest 数组、正则模式和字符串长度在清单门限制；
- 任何超限都返回可本地化的错误，不 panic、不阻塞主线程。

## 限制与边界

- 本轮没有执行服务注册、代理注册、真实 UAC 或真实拖拽手工项；这些不属于本次
  报告的证据范围。
- F-06 是根据 `auto_paste()` 的焦点路径和 `SendInput` 语义定位的静态缺陷；
  当前测试夹具未能稳定把 WinForms 目标窗口置为前台，因此没有把“目标 TextBox
  实际收到/未收到内容”写成已验证结果。仍建议按给出的真实窗口回归完成实机确认。
- F-02 的密码泄露由 bridge 代码路径直接证明；没有在报告目录保留真实密钥或
  CDP 日志。
- F-12 的资源上限属于防御纵深评估，未用超大文件/解压炸弹在普通用户会话中制造
  内存压力。
- 既有 `docs/BUG_REPORT.md` 中的调用窗口 label 校验、逻辑帧路径前缀比较等加固
  建议仍然有效；本报告不重复把它们当作新发现。
