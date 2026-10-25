# Lume 插件 / 页面运行时重构审计

> 审计对象：`refactor/plugin-system`，HEAD `8566542`，相对 `main` 的 9 个提交。
>
> 审计日期：2026-10-24。
>
> 范围：页面运行时契约、Page Service / Presenter 角色隔离、API 版本门、权限链路、内置导航与剪贴板迁移、独立窗口、设置持久化、快照回流、键盘路由、资源与网络边界，以及仓库内的构建与 CDP 回归。
>
> 方法：阅读 `ARCHITECTURE.md`、`UI_GUIDELINES.md`、`PLUGIN_API.md`、`PAGE_MODEL_PRESENTER.md` 与 `TESTING.md`；对重构 diff 和运行时实现做静态核对；用当前源码构建 debug / release exe；运行编译、单测与 CDP 回归；在 `test/` 与本机临时插件目录构造隔离夹具复现失败路径。临时插件和生成物均位于 gitignored 目录。

## 结论摘要

当前重构的主干链路已经能工作：导航、剪贴板、文件搜索、翻译、Presenter 切换、独立窗口、titlebar、快照回流、主题、图标、LRU 与查询路由均有完整回归覆盖。与此同时，仍存在几处会破坏安全契约、版本契约或故障恢复语义的接线缺口。

| 编号 | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 审计-01 | 严重 | Presenter / Page Service 可绕过宿主网络权限直接联网，SSRF 白名单失效 | 运行复现 |
| 审计-02 | 高 | 前端加载器忽略 Rust 返回的 `apiError`，API 1 / 缺失版本插件仍会执行 | 运行复现 |
| 审计-03 | 高 | Page Service 首次启动失败会永久停留在 loading，且切换页面后不再重试 | 运行复现 |
| 审计-04 | 高 | 所有 Presenter 加载失败时仍被标记为 ready，页面显示为空而非错误 | 运行复现 |
| 审计-05 | 中 | Page Runtime 的 Esc / 页面按键消费链路没有接通 | 代码确认 |
| 审计-06 | 中 | Presenter 的 `sizing = "fit"` 与 `contentHeight` 没有接入窗口 sizer | 代码确认 |
| 审计-07 | 中 | 自动快照无法正确恢复 `name` 字段和多选控件 | 代码确认 |
| 审计-08 | 中 | 快照上限在跨窗口 IPC 之后才执行，关闭窗口前可传输超大对象 | 代码确认 |
| 审计-09 | 中 | 剪贴板每次键入会执行两次数据库搜索 | 代码确认 |
| 审计-10 | 中 | 部分跨窗口命令和 Presenter 外壳参数缺少调用方 / 数值边界校验 | 代码确认 |
| 审计-11 | 低 | Credential Manager 的非“未找到”错误被当作成功或空值 | 代码确认 |
| 审计-12 | 低 | Presenter 在 ready 回调失败时，已创建的句柄没有释放 | 代码确认 |

## 关键发现

### 审计-01：插件帧可直接联网，绕过宿主权限与 SSRF 防护

**严重度：严重。该问题直接推翻“Presenter 不能访问网络”和“网络请求由宿主代理”的当前契约。**

相关位置：

- `src-tauri/tauri.conf.json:15`：主 CSP 为 `null`。
- `src/plugins/iframeBridge.tsx:12`：Presenter 沙箱只限 `allow-scripts allow-forms allow-popups allow-modals`。
- `src/pluginLogic.tsx:45`：Page Service 的逻辑 iframe 使用同一组 sandbox 能力。
- `src/page-runtime/presenterBridge.tsx:179-193`：Presenter HTML 只注入 bridge 脚本与背景样式，没有为 `srcdoc` 注入 CSP。
- `pluginLogicFrame.html`：逻辑帧 HTML 同样没有 CSP。

`lume.http` 的 Rust 权限、私网拒绝、重定向复检只覆盖宿主代理调用；浏览器原生的 `fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、表单提交和资源加载不经过这条链路。

运行复现使用了一个未声明 `permissions = ["network"]` 的临时 API 2 mode。Presenter 在 `lume.page.ready()` 后执行：

```js
fetch("http://127.0.0.1:18766/presenter-network", {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: "bypass-network-permission"
});
```

本机 HTTP 探针收到：

```json
{
  "method": "POST",
  "url": "/presenter-network",
  "origin": "null",
  "body": "bypass-network-permission"
}
```

Presenter 同时进入 `ready`。这说明插件无需网络权限即可访问回环地址，也能用 `no-cors` 请求或表单提交访问私网目标；不依赖 CORS 的写请求尤其危险。Page Service iframe 与 Presenter 共用“无 CSP + 可运行脚本”的模型，因此同样可以用原生 Web API 绕过 Rust 网络层。能够读取声明 secret 的 Service 还可以绕过允许列表把值直接发出。

**影响**

- 清单中的 `network` 权限不再代表实际网络访问能力。
- `network_allow`、私网拒绝、逐跳重定向检查均可绕过。
- 插件可以探测、触发或向 localhost、局域网服务发送请求。
- 文档中的 Presenter 网络隔离不成立。

**建议**

- 给 Presenter `srcdoc` 和逻辑帧分别注入严格 CSP，至少关闭 `connect-src`、`form-action`、`frame-src` 和 `object-src`；仅放行 bridge 所需的 inline script、inline style 与受控资源协议。
- 若插件确实需要远程图片或媒体，应由宿主在权限检查后代理或生成受控 URL，不能给插件任意 `https:` 资源能力。
- 为网络负向测试增加 `fetch`、`no-cors` POST、表单提交、WebSocket、`<img>` 信标和 `EventSource` 用例，断言请求不会离开 WebView。
- 同时收紧 `assetProtocol.scope = ["**"]`，并校验 Presenter `entry` / `titlebar` 路径仍位于插件目录内。

### 审计-02：API 版本门没有接到实际加载路径

**严重度：高。旧插件仍会执行，和当前文档中的“API 2 是唯一接受版本”冲突。**

Rust 的 `validate_manifest` 已正确设置 `apiError`：

- `src-tauri/src/plugins.rs:569-573`：只接受 `HOST_PLUGIN_API`。
- `src-tauri/src/plugins.rs:893-924`：把拒绝原因写入 `apiError` 并返回给前端。

但前端加载器仍使用旧的“只拒绝更高版本”逻辑：

- `src/plugins/registry.ts:733`：仅判断 `m.api > HOST_PLUGIN_API`。
- `src/pluginLogic.tsx:160`：逻辑宿主二次门同样只判断 `>`。
- `src/plugins/types.ts:46-48`：类型注释还写着“lower/missing versions load as-is”。
- `src-tauri/src/plugin_window.rs:149-152` 与 `:358-372`：独立窗口打开和元数据查询没有检查 `api_error`。

用临时 `api` 缺失的 provider 复现，`get_plugins` 返回：

```json
{
  "api": 1,
  "apiError": "unsupported plugin api 1: this host accepts api 2; upgrade the plugin",
  "enabled": true
}
```

随后同一插件的声明式 feature 和 provider 搜索都实际执行，结果中同时出现 `API1-FEATURE-LOADED` 与 `API1-PROVIDER-LOADED`。Rust 命令侧仍会拒绝未声明能力，但插件 JS 仍被加载；叠加审计-01 后，旧插件还能直接联网。

**影响**

- 用户升级后，磁盘里的旧 API 插件不会按设计被停用。
- 设置页一边显示 `apiError`，一边让插件继续贡献搜索结果，状态自相矛盾。
- API 1 与 API 2 的破坏性契约混用，后续迁移无法可靠判定插件是否兼容。

**建议**

- `loadDiskPlugins` 在任何 `apiError != null` 时直接跳过注册，并保留设置页里的拒绝说明。
- 逻辑宿主的兜底门改为 `meta.api !== HOST_PLUGIN_API`。
- `plugin_window_open` / `plugin_window_meta` 同样拒绝被清单门拒绝的插件。
- 增加一个端到端负向夹具：旧 API provider 的 feature、provider 和 mode 均不得产生行或页面。

### 审计-03：Page Service 启动失败后永久 loading，且不会重试

**严重度：高。**

`src/plugins/pageRuntimeMode.tsx:165-170` 在等待逻辑宿主和读取首个模型之前就设置 `started = true`。如果 `waitForService()`、`getModel()` 或后续启动步骤抛错：

- `boot` 会在 `:265-269` 被清空；
- 但 `started` 不会复位；
- 下一次 `ensureStarted()` 直接返回；
- `ready` 一直为 false，模式胶囊保持 loading。

临时 Page Service 在模块顶层抛出异常后，运行观察结果：

```json
{
  "active": "Audit Service Failure",
  "activeClass": "mode-switch-item active loading",
  "host": true,
  "frame": false,
  "model": null,
  "presenterStates": []
}
```

进入后等待 14.5 秒仍是该状态；切回首页再进入同一模式，也没有再次尝试。没有任何用户可见错误或重试入口。

**影响**

- 一次瞬时的逻辑宿主就绪超时会把插件锁死到重启或手动重载。
- 用户只看到永久转圈，无法判断是插件损坏、权限失败还是宿主失败。
- 与“Page Service 崩溃后熔断、重载和可见错误处理”的契约不一致。

**建议**

- 不要把布尔值作为唯一的启动锁；保存可等待、可失败的启动 Promise，并在失败后清零。
- 保存最后一次启动错误，在模式页显示错误与“重试 / 重载插件”动作。
- 允许页面再次激活或显式重试时重新执行启动流程；连续失败可进入退避。

### 审计-04：Presenter 全部加载失败仍被当成 ready，页面为空

**严重度：高。**

`PresenterHost.mount()` 在所有候选都失败后返回 `status: "error"`：

- `src/page-runtime/presenterHost.ts:120-128`：没有兼容 Presenter。
- `src/page-runtime/presenterHost.ts:175-180`：所有 Presenter 重试后失败。

但 shell adapter 忽略返回值：

- `src/plugins/pageRuntimeMode.tsx:258-264`：`await session.mount(...)` 后无条件 `setReady(true)` 与 `onReady()`。
- `src/plugins/pageRuntimeMode.tsx:138-144`：模型状态不是 loading 时也提前置 ready。
- `src/plugins/pageRuntimeMode.tsx:274-287`：没有错误视图或重试 UI。

临时 mode 的 Page Service 正常，但 Presenter `entry` 指向不存在的文件。运行结果：

```json
{
  "active": "Audit Presenter Failure",
  "activeClass": "mode-switch-item active",
  "host": true,
  "hostText": "",
  "frame": false,
  "presenterStates": [
    {
      "presenterId": null,
      "status": "error",
      "attempts": 2,
      "error": "all Presenters failed after 2 attempts"
    }
  ]
}
```

页面已经不再显示 loading，却没有任何内容或错误提示。独立窗口也会在同样情况下上报 `plugin_window_ready`，形成一个空白窗口。

**影响**

- Presenter 路径错误、HTML 损坏或桥接未启动会表现为“空白页”，排障信息只在诊断数组和控制台里。
- ready 门只看模型，不看 Presenter 是否成功挂载，因此慢加载时也会提前展示空页面。
- detached 窗口会把失败当成可交互状态。

**建议**

- `ready` 应由“服务模型可用、当前 Presenter 已 ready”共同决定。
- `mount()` 返回 error 时设置可见错误态，不调用 `onReady`，并显示重试或切换 Presenter。
- 给慢 Presenter 和全部失败两种场景增加端到端测试，断言用户可见文本，而不只断言 `__presenterStates`。

### 审计-05：Page Runtime 的 Esc 与按键消费链路不完整

**严重度：中。**

- `src/plugins/pageRuntimeMode.tsx:327-340`：`onKey` 把按键 post 给 Presenter 后固定返回 false；`onEscape` 固定返回 false。
- `src/launcher/keyboard.ts:91-103`：Esc 在处理 `onKey` 之前就调用 `onEscape()`，随后隐藏或关闭预览。
- `src/pluginWindow.tsx:512-515`：独立窗口直接在宿主收到 Esc 时关闭，不等待当前 Presenter 或 Page Service 消费。
- `src/plugins/iframeBridge.tsx:295-313`：宿主发送 `__lumeKeyConsumed` 回执，但 Presenter bridge 没有处理该消息。
- `src/page-runtime/contracts.ts:149-157`：协议本身声明了 `page.escape`，但适配器没有用它。

结果是 API 2 mode 无法通过 `ModeInstance.onEscape()` 消费 Esc，也无法同步阻止根路由随后执行箭头 / Enter 兜底。页面自己的异步 `lume.on.key` 处理器在时序上晚于根路由。

冒泡路径中的 `preventDefault()` 也不能可靠阻止转发：bridge 的 document keydown 监听先注册、先执行，检查 `defaultPrevented` 后立即 post；页面后注册的冒泡监听来不及改变这次决定。文档要求用冒泡监听消费 Esc，实际只有 capture 监听或可编辑控件内的按键较可靠。

**影响**

- 插件内的下拉层、上下文菜单、确认态或多选态不能可靠用 Esc 先关闭。
- 自定义 Presenter 无法从 Page Model 语义层声明“这个键已处理”。
- 独立窗口中的 Esc 行为与启动器页面不一致。

**建议**

- 延迟到事件分发结束后再决定是否转发按键，确保页面冒泡监听已经执行。
- 把 Presenter 的按键 / Esc 结果通过明确的同步或可等待回执返回宿主；若无法同步，重新设计为“页面明确调用 page.escape / page.cancel”。
- 独立窗口关闭前先向当前 Presenter 发出 Esc，并由 IntentResult 决定是否关闭。
- 增加 Esc 分层、箭头键消费和输入框内按键的跨窗口测试。

### 审计-06：Presenter 的 fit / contentHeight 尺寸协议没有接通

**严重度：中。**

契约允许：

- `src/page-runtime/contracts.ts:85-90`：`sizing: "fit"`、`contentHeight`、`height`、`expanded`。

运行时：

- `src/plugins/pageRuntimeMode.tsx:129-135` 只保留 `sizing`、`height`、`expanded`，丢弃 `contentHeight`。
- `src/plugins/pageRuntimeMode.tsx:346-348` 返回 `heightPolicy` 与 `desiredHeight`。
- `src/launcher/sizing.ts:109-125` 只支持 fixed + `height`。
- `src/launcher/sizing.ts:127-135` 的 fit 分支只查找宿主 DOM 中已知的导航容器；Presenter 是 iframe，这些选择器无法进入沙箱文档。

因此 Presenter 上报 `{ sizing: "fit", contentHeight: 320 }` 时，窗口不会按 320 调整；同时 fixed 的单行提示等场景才不会触发。公开类型与真实能力不一致。

**建议**

- fit 分支直接使用 `contentHeight`，或在协议中删除 Presenter 的 fit / contentHeight 能力并明确只支持 fixed。
- 若继续支持 fit，对 contentHeight、height、expanded 做类型、有限数和工作区上限校验。
- 增加一个 Presenter 从 fixed 切到 fit 再切回的窗口尺寸回归。

### 审计-07：自动快照无法恢复 name 字段和多选控件

**严重度：中。**

`src/page-runtime/presenterBridge.tsx:42-50` 生成快照键：

- 有 `id`：使用 `id`；
- 没有 `id` 但有 `name`：保存为 `"name:" + name`；
- 都没有：保存为 `"path:" + index`。

`src/page-runtime/presenterBridge.tsx:73-89` 恢复时：

- 先按 `getElementById(saved.key)` 查找；
- 再按 `[name="saved.key"]` 查找；
- 不会剥掉 `name:` 前缀。

所以只有 `name` 的输入框永远查不到。`path:` 键同样不是合法选择器，且索引会随 DOM 顺序变化。

多选控件的值在 `fieldValue()` 中被拼成逗号字符串；恢复逻辑却只有 `Array.isArray(saved.value)` 分支。实际保存值永远是字符串，因此多选 select 只能被赋一个不匹配的字符串，无法恢复原选择。

**影响**

- detach、LRU 卸载、关闭回流后的表单状态会部分丢失。
- 当前测试夹具主要使用 `id` 与单值控件，所以没有暴露该问题。

**建议**

- 使用可逆的字段键编码，例如 `id:`、`name:`、稳定 `path:`，恢复前按前缀解析并转义 selector。
- 多选值按数组保存；恢复后派发必要的 `input` / `change` 事件。
- 增加 name-only、多选、contenteditable 和重复字段名的回流测试。

### 审计-08：快照大小上限在跨窗口 IPC 之后才执行

**严重度：中。**

`capSnapshot` 存在于 `src/plugins/iframeBridge.tsx:58-79`，但页面运行时快照的生成与跨窗口传递没有先调用它：

- `src/plugins/pageRuntimeMode.tsx:376`：直接返回 `bridge?.snapshot()`。
- `src/plugins/pageRuntimeMode.tsx:449`：直接返回 titlebar snapshot。
- `src/pluginWindow.tsx:313-328`：把两个原始快照打包后直接调用 `plugin_window_close_report`。
- `src-tauri/src/plugin_window.rs:527-546`：Rust 侧没有 snapshot 大小限制。
- `src/launcher/session.ts:40-55`：只有在快照已经回到启动器并写入 session frame 时才调用 `capSnapshot`。

`captureSnapshot()` 最多读取 200 个字段，每字段可到 64 KiB；单是自动层理论上就超过 13 MiB，custom 层还未计。关闭窗口时可先通过 iframe postMessage 和 Tauri IPC 传输这些数据，再在启动器侧被丢弃。

**影响**

- 超大表单或恶意 Presenter 可造成关闭卡顿、内存峰值和 IPC 压力。
- 快照被丢弃发生在传输之后，无法保护跨窗口链路。

**建议**

- 在 `createIframeView.snapshot()` 或 `PageRuntimeMode.snapshot/snapshotTitlebar` 返回前立即执行 cap。
- Rust 的 `plugin_window_close_report` 增加独立的 snapshot 字节上限，超限时降级为无快照关闭而不是拒关。
- 让 `capSnapshot` 同时限制 custom 层、字段数量和总字符数。

### 审计-09：剪贴板每次键入执行两次搜索

**严重度：中。**

当前输入链：

1. `src/App.tsx:730-743` 的 `handleInput` 先调用 `setQuery(text)`。
2. 剪贴板模式 `src/plugins/clipboard/index.tsx:40` 的 `setQuery` 立即执行 `session.setQuery(query)`。
3. `handleInput` 随后调用 `runSearch`。
4. `src/App.tsx:414-418` 的 `runSearch` 再次调用 `activeMode.search(q)`。
5. `src/plugins/clipboard/index.tsx:41` 的 `search` 又执行一次 `session.setQuery(query)`。

导航与 Page Runtime 的 `setQuery` 都是纯镜像，只有剪贴板额外触发搜索。因此每次键入会发送两次 `search_clipboard`，第一次结果通常因 token 过期被丢弃。

**影响**

- 每次按键多一次 SQLite 查询和 Tauri IPC。
- 在长历史或低配设备上增加输入延迟，也扩大竞态窗口。

**建议**

- 将剪贴板 `setQuery` 改为只更新镜像；搜索只保留在 `search(q)`。
- 在探针中统计 `search_clipboard` 调用次数，断言一次键入只触发一次。

### 审计-10：跨窗口命令和外壳参数缺少统一校验

**严重度：中。**

代码确认的缺口：

- `src-tauri/src/plugin_window.rs:494-500`：`plugin_window_push_state` 不校验调用窗口，也没有 state 大小上限。
- `src-tauri/src/plugin_window.rs:509-518`：`plugin_window_close` 不校验调用窗口，任意可调用 Tauri 命令的 webview 都能按 id 关闭其它窗口。
- `src/plugin_window.tsx:262-284`：独立窗口元数据与 Presenter 清单没有再次核对 `apiError`。
- `src/page-runtime/presenterBridge.tsx:237-256`：`page.reportLayout` 与 `app.resize` 原样接受 Presenter 参数。
- `src/App.tsx:494-505`：`app.resize` 只设置下限，没有宽度 / 高度上限或工作区限制。
- `src/launcher/sizing.ts:109-117`：NaN 或极大高度会进入 `setSize`；NaN 还会让 `lastWindowH` 的比较失效，形成重复 resize 尝试。

虽然当前 sandbox 阻止 Presenter 直接访问 `__TAURI_INTERNALS__`，这些命令仍应按“任何 webview 都不可信”做服务端调用方校验。Presenter 也应被当作不可信输入源，而不是用 TypeScript 断言直接信任 `args`。

**建议**

- 跨窗口命令统一校验调用窗口：状态推送与程序化关闭仅允许 `main`，元数据仅允许对应 `plugin-<id>`。
- 对所有跨窗口值设定大小上限，并对目标窗口存在性 fail-closed。
- 在 bridge 层校验 `sizing`、`height`、`contentHeight`、`width` 为有限数并限制到工作区范围。
- 把 Presenter 参数验证下沉到 Rust 或共享 schema，避免只依赖类型断言。

## 其他风险

### Credential Manager 错误被吞掉

`src-tauri/src/plugin_secret.rs:145-154` 对任何 `CredReadW` 失败都返回 `Ok(None)`；`:198-207` 对任何 `CredDeleteW` 失败都返回成功。只有 `ERROR_NOT_FOUND` 应被当成“未设置”；访问拒绝、凭据损坏等错误应显式上报，否则设置页会显示“未设置”或“清除成功”，但真实状态并未变化。

### Presenter ready 失败时句柄泄漏

`src/page-runtime/presenterHost.ts:157-171` 在 `handle.ready()` 抛错时没有调用 `handle.dispose()`。如果 Presenter 在 ready 前已经创建订阅、计时器或 iframe 资源，两次重试与回退会留下未被回收的实例。建议在 catch 中保存已创建的 handle 并统一 dispose。

### Manifest 路径与 asset scope

`src-tauri/src/plugins.rs:610-630` 只检查 Presenter `entry` 非空，没有规范化路径；`src/plugins/page-runtime` 与 `src/pluginWindow.tsx` 使用 `dir + "\\" + entry` 读取。加上 `assetProtocol.scope = ["**"]`，恶意或损坏的清单可以指向插件目录外的本地 HTML。建议对 `entry`、`titlebar`、图标和模块路径做规范化，并拒绝绝对路径、盘符、UNC、`..` 与符号链接逃逸。

## 验证记录

### 构建与静态检查

- `pnpm exec tsc --noEmit`：通过，无报错。
- `pnpm run build`：通过。
- `pnpm exec tsc -p examples/tsconfig.json`：通过。
- `pnpm run test:page-runtime`：10/10。
- `node scripts/check_i18n.mjs`：577 个键 × 3 语言，64 组搜索词配对，通过。
- `cd src-tauri && cargo test`：247 passed，0 failed，9 ignored；有一条 `explorer.rs` 未使用 import 警告。
- `pnpm run tauri build --debug --no-bundle`：通过。
- `pnpm run tauri build --no-bundle`：通过。

### CDP 与端到端回归

在临时恢复默认 Presenter 后：

- 页面运行时：24/24，覆盖导航 / 剪贴板双 Presenter、窗口化列表、选择保持、输入焦点、持久化与重启恢复。
- 文件搜索 Presenter：5/5。
- 翻译 Page Service / Presenter：全部检查项无失败，覆盖 secret、缓存、取消、超时、网络失败与二套 Presenter。
- Presenter 控制：全部检查项无失败，覆盖兼容列表、实时设置、切换与重启恢复。
- 独立窗口 Page Runtime：除“刚 ready 立即读取 scoped layout”一项外，其余检查项无失败；额外等待 1.2 秒后可读到密度设置对应的 320px 状态。
- 状态快照与回流：54/54。
- 独立窗口生命周期：16/16。
- LRU：22/22。
- 查询路由：47/47。
- 沙箱：14/14。
- 主题：28/28。
- 主题图标：21/21。
- 空帧恢复：20/20（使用当前源码重建的 release exe）。
- 帧加载：5/5（使用当前源码重建的 release exe）。
- 视觉审计：28/28。
- 插件管理页、`.lupx` 安装与卸载：全部检查项无失败。
- HTTP 代理、窗口特性、闲置重置与逻辑熔断：全部检查项无失败。

### 隔离复现夹具

- 临时网络 Presenter：本机 HTTP 收到来自 opaque origin 的未授权 POST。
- 临时 API 1 provider：`apiError` 非空，但 feature 与 provider 搜索结果仍然执行。
- 临时坏 Page Service：14.5 秒后仍为 loading，切走再回来不再尝试。
- 临时缺失 Presenter：页面进入 active 非 loading 状态，host 为空，诊断状态为 `all Presenters failed`。
- 临时坏服务 / API 旧版 / 网络 / Presenter 缺失夹具均在验证后删除。

## 自动化测试自身的问题

这些不是产品功能缺陷，但会降低回归信号的可信度：

1. `scripts/cdp_page_runtime_verify.mjs` 假定启动时是 grid / list 默认 Presenter。若 debug 设置保留了 `navigate-list` 或 `clipboard-compact`，前两项会失败，即使产品行为正常。测试应在开始时写入并保存默认 Presenter，再在结束时恢复。
2. `scripts/cdp_detached_page_runtime_verify.mjs` 在 `presenterStatus === "ready"` 后立即读取 layout，没有等待 scoped setting 回灌。加入 1.2 秒等待后，状态确实变为 320px；测试应等待条件而不是读取瞬时值。
3. 剪贴板暂停/恢复脚本 假定历史条数未达到上限。release 历史已是 200 条时，暂停/恢复检查打印 `FAIL`，但脚本仍以 0 退出。需要先清空或降低上限，并把失败计入退出码。
4. `scripts/cdp_plugin_v2_verify.mjs` 仍按旧模式尝试读取 opaque-origin iframe 的 DOM，只打印 `false` 而不做断言并以 0 退出；它不能作为当前 Page Runtime 的有效回归。
5. debug 插件目录中保留了多份旧 API 1 夹具，`cdp_plugin_verify` 的绿色结果并未排除这些插件被执行。版本门负向用例应成为正式回归的一部分。
6. 测试脚本混用 `target/debug` 与 `target/release`。使用 release 前必须重建 release；否则可能测到旧内嵌 bundle。报告中的 release 结果均以本次重建后的 exe 为准。

## 建议处理顺序

1. 先关闭插件帧的原生网络出口，并收紧 asset / Presenter 路径。
2. 接通 `apiError` 与严格 API 版本门，确保旧插件不会执行。
3. 修正 Page Service / Presenter 的启动、失败和 ready 状态机。
4. 接通 Esc / 按键消费与 fit 尺寸协议。
5. 修复快照恢复、快照上限、重复剪贴板搜索和跨窗口参数校验。
6. 修复测试环境依赖、错误退出码与旧脚本，再补负向用例。

## 未覆盖项

- 真实 UAC 注册、注销与取消流程。
- 服务 / 提权代理的真实安装状态变更。
- 实机全局快捷键冲突。
- 从 Explorer 真实拖入文件、任务栏固定、真实 DPI 多屏拖拽。
- 音频 / 视频 / PDF 的真实媒体解码质量与长时播放。

这些项目依赖系统级交互，适合按 `docs/TESTING.md` 的手工清单执行；本次代码与 CDP 审计没有修改生产代码。
