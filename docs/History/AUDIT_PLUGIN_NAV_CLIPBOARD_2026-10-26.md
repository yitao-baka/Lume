# 插件系统、导航页与剪贴板页专项审计

> 审计基线：`refactor/plugin-system`，HEAD `450d58e`（2026-10-26）。
>
> 审计范围：磁盘插件发现、逻辑宿主、权限台账、Page Service / Presenter 运行时、
> 导航页栏目与 Provider 搜索、剪贴板 Page Service、两个剪贴板 Presenter、Rust
> 剪贴板命令与现有 CDP 回归。
>
> 方法：先阅读 `docs/ARCHITECTURE.md`、`docs/UI_GUIDELINES.md`、
> `docs/PLUGIN_API.md`、`docs/PLUGINS.md`、`docs/SETTINGS.md` 与
> `docs/TESTING.md`；再对当前实现做静态走查，运行 TypeScript、Rust 与 CDP 基线，
> 最后用 `test/` 下的隔离插件和临时数据构造边界复现。`test/` 是本机 scratch，
> 不修改业务源码。

## 结论摘要

本轮得到 9 项可行动结论，另有 6 项工程改进建议。未发现可直接跨进程的提权链路；
风险最高的是“禁用不是停用”和“导航贡献没有总预算”两项。

| 编号 | 严重度 | 结论 | 主要影响 |
|---|---|---|---|
| F-01 | 高 | 禁用磁盘插件后，逻辑 iframe、生命周期回调和已发放权限令牌仍存活 | 用户关闭插件后，插件仍能收到查询、读取剪贴板并继续后台执行 |
| F-02 | 高 | 导航贡献只有单栏条目上限，没有插件级或页面级总预算；超大 `navBars` 会让整个首页变成不可渲染的错误模型 | 一个插件可让导航页空白，直接影响核心启动流程 |
| F-03 | 中高 | Provider 二级下钻 `select()` 没有请求代际保护，旧下钻结果可覆盖新查询 | 搜索框显示新查询，结果区却显示旧下钻行，甚至重新占用搜索框 |
| F-04 | 中 | Presenter 并发切换没有取消/代际保护，先发后到的旧挂载可覆盖最新选择 | Presenter 状态与当前句柄可能错位，模型更新被送到错误的 Presenter |
| F-05 | 中 | 自动合并只追加纯文本，不更新或清空旧的 HTML 快照 | 合并后的富文本行内容包含两段，复制回去时 HTML 仍只表示第一段 |
| F-06 | 中 | 剪贴板 SQL 把搜索词中的 `%`、`_` 当作 LIKE 通配符 | 搜索 `%` 或 `_` 会返回几乎全部历史，不能做字面搜索 |
| F-07 | 中 | 剪贴板页在焦点位于分类、暂停、清空等按钮时仍拦截 Space | Space 被解释为多选，按钮无法通过键盘空格触发 |
| F-08 | 中低 | 手动安装的磁盘清单没有在清单门校验 `id` 字符集 | 带空格等非法 id 的插件会部分加载，随后存储/能力调用才失败 |
| F-09 | 中低 | API 文档允许 HTTP(S) 插件图标，但 WebView2 的 deny proxy 会丢弃这些请求 | 远程图标显示为破图；网络权限也不会改变该结果 |

## 验证环境与基线

- Windows / WebView2；debug exe 为
  `src-tauri/target/debug/lume.exe`，由
  `pnpm run tauri build --debug --no-bundle` 生成。
- `pnpm exec tsc --noEmit`：无输出并返回 0。
- `pnpm run build`：Vite 生产构建返回 0。
- `pnpm run test:page-runtime`：14 项。
- `pnpm run test:clipboard-model`：9 项。
- `pnpm run test:skin-system`：11 项。
- `node scripts/check_i18n.mjs`：580 个键 × 3 种语言，65 组关键词配对。
- `cargo check`、`cargo test`、`cargo clippy --all-targets --message-format=short`：
  返回 0；Rust 单测 253 项通过、9 项 ignored。
- CDP：
  - `cdp_page_runtime_verify`：PAGE RUNTIME VERIFY OK。
  - `cdp_plugin_audit_runtime_verify`：PLUGIN AUDIT RUNTIME VERIFY OK。
  - `cdp_presenter_network_verify`：PRESENTER NETWORK VERIFY OK。
  - `cdp_sandbox_verify`：SANDBOX VERIFY OK（19 个断言）。
  - `cdp_plugin_state_verify`：61/61。
  - `cdp_plugin_window_verify`：16/16。
  - `cdp_detached_page_runtime_verify`：无失败。
  - `cdp_lupx_verify`、`cdp_plugins_pane_verify`：ALL PASS。

这些基线说明问题不在编译、基础单元测试或既有正常路径；下列结论来自专门构造的
异步、超大输入、禁用状态和键盘焦点组合。

## F-01 禁用插件后，插件仍执行生命周期并保留能力

**严重度：高**

**位置**

- `src/plugins/registry.ts:760-790`：`loadDiskPlugins()` 对 `m.enabled === false`
  直接 `continue`，没有卸载此前加载的实例。
- `src/plugins/registry.ts:137-139`：`allPlugins()` 返回所有注册项，不区分启用状态。
- `src/App.tsx:335`、`src/App.tsx:774`、`src/App.tsx:1203`：
  `onHide`、`onQuery`、`onShow` 均遍历 `allPlugins()`。
- `src-tauri/src/plugin_perm.rs:252-275`：能力检查只检查清单声明和 trusted 状态，
  没有检查插件当前是否 enabled。
- `src-tauri/src/settings.rs:1164-1183`：`set_plugin_enabled()` 只写设置并广播
  `settings-applied`，没有撤销逻辑宿主令牌。

**现象**

用户从设置 → 插件关闭一个 service 插件后：

1. `get_plugins` 返回 `enabled: false`。
2. 逻辑宿主中的 `disable-probe` iframe 仍为 `loaded: true`，`calls`、
   `messageHandler` 和 frame 都还在。
3. 继续输入查询时，该插件的 `onQuery()` 仍被调用。
4. 该插件已声明的 `clipboard` 能力仍可成功读取系统剪贴板。

**复现**

在 `test/disable-base` 使用独立便携基目录，放入一个 service 插件：

```toml
id = "disable-probe"
kind = "service"
api = 2
permissions = ["clipboard"]
entry = "main.js"
```

```js
export default function create(ctx) {
  return {
    async onQuery(query) {
      await ctx.storage.set("lastQuery", String(query));
      const clip = await ctx.clipboard.readText();
      await ctx.storage.set("clipboardAfterQuery", clip);
      await ctx.storage.set("clipboardOk", true);
    },
  };
}
```

然后：

```js
invoke("set_plugin_enabled", { id: "disable-probe", enabled: false });
window.__lumeHandleInput("after-disable-cap-...");
invoke("plugin_storage_get", { id: "disable-probe", key: "lastQuery" });
invoke("plugin_storage_get", { id: "disable-probe", key: "clipboardAfterQuery" });
```

观测结果：

```json
{
  "enabled": false,
  "storage": {
    "lastQuery": "after-disable-cap-...",
    "queryCount": 4,
    "clipboardOk": true,
    "clipboardAfterQuery": "disabled-plugin-clipboard-sentinel-..."
  },
  "logicEntry": {
    "loaded": true,
    "hasFrame": true,
    "hasHandler": true
  }
}
```

**为什么不是单纯的“模块驻留”**

`docs/PLUGIN_API.md:203-205` 确实说明了 disabled 后模块仍驻留内存以支持快速重新启用。
但驻留内存不应等于继续接收用户输入、继续执行用户不可见的生命周期回调，或继续保留
已授予的外部能力。当前行为把“禁用”降级成了“从菜单隐藏”，用户无法据此建立隐私预期。

**建议**

1. 当清单从 enabled 变为 disabled 时，先执行与重载相同的 `unloadDiskPlugin(id)`，
   断开 message listener、结束未完成调用、移除 frame，并撤销 host tokens。
2. 所有生命周期广播统一经过 `isEnabled(id) && !apiError` 过滤，而不只是 provider /
   mode / navBars 的读取路径。
3. Rust `assert_capability()` 增加当前 enabled 状态检查；即使旧 frame 暂时未销毁，
   也不能继续调用能力。
4. 为“加载 → 禁用 → 输入查询 → 重新启用”增加 CDP 回归，断言禁用期间没有新
   hook 调用、storage 不变、能力调用被拒绝。

## F-02 导航贡献没有总预算，单个插件可清空首页

**严重度：高**

**位置**

- `src/plugins/registry.ts:631-666`：`normalizeNavBarContributions()` 对每个
  bar 的 items 做 `slice(0, 50)`，但没有 bar 数量、总条目数、字段长度或总字节上限。
- `src/page-services/navigate/service.ts:139-218`：`snapshot()` 把全部 bars 和
  items 一次性放进 Page Model。
- `src/page-runtime/modelStore.ts:96-111`：Page Model 超过 1 MiB 时抛错。
- `src/page-runtime/session.ts:119-151`：错误被转换成 `status: "error"` 的替代模型。
- `src/presenters/navigate-grid/NavigateGridPresenter.tsx:160-183`：首页 Presenter
  没有根据 model error 渲染错误状态；数据为空时直接显示空首页。

**现象**

一个插件返回 400 个 bar、每 bar 50 个 item，模型序列化大小为 **6,240,406 bytes**，
超过 1,048,576 bytes 上限。导航页最终没有栏目、没有结果，只有搜索框，用户看不到
具体错误，也无法从页面内判断是哪一个插件导致。

**复现**

隔离 `navBars()`：

```js
navBars() {
  return Array.from({ length: 400 }, (_, i) => ({
    id: "bar-" + i,
    title: "Navbar flood " + i,
    items: Array.from({ length: 50 }, (_, j) => ({
      name: `Flood item ${i}-${j}`,
      path: "https://example.com/flood/" + i + "/" + j + "/" + "x".repeat(120),
    })),
  }));
}
```

观测：

```text
pageId: apps
status: error
error: serialized size 6240406 exceeds 1048576 bytes
barSections: 0
results: 0
```

**同一类缺口**

- Provider 的 `select()` / `filter()` 结果走 `rowsToEntries()`，没有 20 行之外的
  总行数上限，也没有字段形状校验。
- `providerRowToEntry()` 只检查 `name` 是否为真，未要求 `path` 为字符串；对象/数组
  `path` 会进入模型，直到点击时由 `launch_app` 拒绝。
- `navBars` item 的 `title`、`name`、`path` 没有长度预算。

**影响**

导航页是启动器的默认入口。任何插件只要生成大数组或长字符串，就能使首页变为空白
错误模型；如果它是自动加载的，用户下次启动也可能直接看到空白首页。

**建议**

1. 在 registry 对每个插件的 navBars 做总量预算：bar 数、总条目数、单字段长度、
   单插件序列化字节数；超限时只丢弃该插件的栏目或逐条截断，不让整个 Page Model
   失败。
2. 对 provider 搜索结果、`select()`、`filter()` 使用同一套行数/字节/形状校验；
   非字符串 `path`、非字符串 `icon`、非有限数值等条目直接丢弃并记录插件日志。
3. Presenter 渲染 `status: "error"` 的 Page Model 时显示可恢复错误和“打开设置”
   路径，不能继续把它当成空结果页。
4. 增加超大 `navBars`、超大 `select()`、坏 `path` 类型、长标题四组 CDP 用例。

## F-03 Provider 下钻的异步结果可覆盖更新查询

**严重度：中高**

**位置**

- `src/plugins/navigate/search.ts:349-376`：`providerDrill` 分支等待
  `p.instance.select()` 后直接 `setApps`、`setDrill`、`setSubInput`。
- `src/plugins/navigate/search.ts:307-329`：同类 `filter()` 路径有 token 检查，但
  `select()` 路径没有。
- `src/plugins/registry.ts:822-825`：Provider `select` 通过逻辑宿主异步返回。

**现象**

用户下钻一个 Provider 结果后，在 `select()` 返回前输入新的查询。新查询完成并显示
正确结果后，旧的 `select()` 返回，结果区被旧下钻行覆盖。若该 Provider 可过滤，
旧路径还会重新设置 `subInput` 所有权，把搜索框交给已经过期的下钻层级。

**复现**

隔离 Provider：

```js
async search(q) {
  if (q === "raceparent") {
    return [{ name: "RACE_PARENT", path: "lume-probe://race-parent", drill: true }];
  }
  if (q === "racesecond") {
    return [{ name: "RACE_SECOND", path: "https://example.com/race-second" }];
  }
  return [];
},
async select() {
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return [{ name: "RACE_STALE_CHILD", path: "https://example.com/stale-child" }];
}
```

操作序列：

1. 输入 `raceparent`，点击 `RACE_PARENT`。
2. 立即输入 `racesecond`。
3. 等待 `select()` 完成。

观测：

```json
{
  "q": "racesecond",
  "names": ["RACE_STALE_CHILD"],
  "sub": "导航"
}
```

**建议**

在进入分支时捕获当前 `searchToken`（或新的代际号），在 `await select()` 返回后检查
token 是否仍匹配；不匹配时丢弃结果，并且不得修改 `drill`、`subInput`、selection
或 resize 状态。Provider 的所有异步入口（search、select、filter、onEnter）应使用
同一套代际协议。

## F-04 Presenter 并发挂载会把旧实例写回当前状态

**严重度：中**

**位置**

- `src/page-runtime/presenterHost.ts:109-189`：`mount()` 先 `unmount()`，随后
  对候选 Presenter 逐个异步 `factory` 和 `ready()`；没有挂载代际号，也没有取消
  正在进行的前一个 `mount()`。
- `src/page-runtime/presenterHost.ts:209-221`：`unmount()` 只处理已经设置的
  `current`，无法取消尚未完成的 factory。
- `src/plugins/pageRuntimeMode.tsx:462-470` 与 `:580-593`：Presenter 设置变更和
  切换入口可以并发触发 `session.switchPresenter()`。

**复现**

用一个独立的 PresenterHost 测试挂载两次：

1. 请求 `slow-a`，其 `ready()` 延迟 120 ms。
2. 立即请求 `fast-b`，其 `ready()` 延迟 15 ms。
3. 等待两个 Promise 完成。

观测：

```json
{
  "current": "slow-a",
  "state": {
    "presenterId": "fast-b",
    "status": "ready"
  }
}
```

`state.presenterId` 显示的是第二次请求的 `fast-b`，但实际保存的句柄是第一次请求的
`slow-a`。后续模型更新会走错 Presenter，界面与运行时状态不一致。

**建议**

在 PresenterHost 内维护单调挂载代际号（或在 mount 开始时创建
`AbortController`）；每次新的 mount 使旧代际失效。旧 `ready()` 返回后必须丢弃并
dispose，不得执行 `set current` 或写回状态。`PageSession` 还应拒绝 destroyed 后的
重挂载，防止已淘汰页面被异步 factory 重新激活。

## F-05 自动合并后的富文本 HTML 与纯文本内容不一致

**严重度：中**

**位置**

- `src-tauri/src/clipboard.rs:314-345`：自动合并只执行
  `content = content || char(10) || ?1` 和 `merged_count + 1`，没有更新 `html`。
- `src-tauri/src/clipboard.rs:2257-2266`：复制富文本行时仍使用旧的 `row.html`。
- `src-tauri/src/clipboard.rs:1001-1025`：每次复制最多保存 64 KiB HTML，但合并
  路径不处理这段 HTML 的语义。

**复现**

使用两个富文本复制片段，开启自动合并并在窗口内复制：

```text
piece 1: HTMLMERGEONE...
piece 2: HTMLMERGETWO...
```

数据库行得到：

```json
{
  "content": "HTMLMERGEONE...\nHTMLMERGETWO...",
  "merged_count": 2,
  "has_html": true
}
```

把这个合并行复制回系统剪贴板后读取 CF_HTML，片段中只有：

```html
<b>HTMLMERGEONE...</b>
```

第二个片段没有进入 HTML。应用粘贴富文本时可能只插入第一段，而不是列表里展示的
合并内容。

**建议**

合并操作必须原子地决定 HTML 政策：

- 最简单、最安全的策略是合并时把 `html` 置为 `NULL`，明确降级为纯文本；
- 若要保留格式，则必须把两段 HTML 包装成合法片段并保证编码、长度和纯文本回退
  一致；
- 对“首段 HTML + 后续纯文本”的混合情况，不能继续标记为完整富文本。

增加“两段富文本合并后复制回剪贴板”的 Rust 回归，断言 `content`、`html` 和
`has_html` 三者一致。

## F-06 剪贴板搜索没有转义 SQL LIKE 通配符

**严重度：中**

**位置**

- `src-tauri/src/clipboard.rs:502-528`：查询条件为
  `content LIKE '%' || ?1 || '%' OR source_app LIKE '%' || ?1 || '%'`，
  没有 `ESCAPE` 子句，也没有对用户输入中的 `%` / `_` 做替换。
- 这条查询同时服务空查询、文本搜索、分类搜索与 source-app 搜索。

**现象**

搜索 `%` 返回全部历史；搜索 `_` 返回全部历史；不存在的普通字符串返回 0 条。
SQL 参数化阻止了注入，但没有阻止 LIKE 语义解释。

**复现**

在已有 200 条历史的 debug 数据库中，通过剪贴板搜索输入：

```text
%
_
this_text_does_not_exist_zzzz
```

观测：

```json
{
  "percent": { "q": "%", "total": 200 },
  "underscore": { "q": "_", "total": 200 },
  "literalMiss": { "q": "this_text_does_not_exist_zzzz", "total": 0 }
}
```

**建议**

对 `\`、`%`、`_` 做转义，并使用显式 `ESCAPE '\'`；或者把普通搜索改成
`instr(lower(content), lower(?1)) > 0` 这类字面匹配，同时保留 source-app
匹配。为 `%`、`_`、反斜杠、混合大小写和多语言文本补充测试。

## F-07 剪贴板页面拦截按钮上的 Space

**严重度：中**

**位置**

- `src/plugins/clipboard/store.ts:287-313`：`onKey()` 只检查
  `event.isComposing`、`clearOpen`、`ctx.editing` 和 `ctx.hasResults`，没有检查
  `event.target` 是否为交互控件。
- `src/launcher/keyboard.ts:189-193`：焦点在按钮上时仍先调用页面 `onKey`。
- `src/presenters/clipboard-list/ClipboardListPresenter.tsx:159-172` 与
  `src/presenters/clipboard-compact/ClipboardCompactPresenter.tsx:190-203`：
  分类按钮没有单独的键盘处理；它们的原生 Space 激活本应生效。
- 同一问题也影响状态栏暂停、清空按钮和当前行的复制、粘贴、删除按钮。

**复现**

1. 打开剪贴板页。
2. 用 Tab 或点击让“文本”分类按钮获得焦点。
3. 按下 Space。

观测：

```json
{
  "activeCategory": "全部",
  "checks": 1,
  "status": "已选 1 条"
}
```

分类没有切换，反而把当前行加入了多选。

**影响**

键盘用户无法用标准 Space 激活分类、暂停、清空、复制、粘贴、删除等按钮；这会直接
破坏 `UI_GUIDELINES.md` 中“命令控件可见焦点、Tab 可遍历、输入框可继续输入”的
契约。

**建议**

页面级 Space 多选只在焦点不属于
`button, [role="button"], [role="tab"], a, input, textarea, select, [contenteditable]`
时处理；分类和状态栏按钮可以保留自己的原生 click 行为。增加 Space/Enter 对照
CDP 用例，至少覆盖分类、暂停、清空、复制、粘贴和删除。

## F-08 清单门接受非法 plugin id，部分加载后才失败

**严重度：中低**

**位置**

- `src-tauri/src/plugins.rs:508-513`：已有 `valid_plugin_id()`，只允许 ASCII
  字母、数字、`-`、`_`。
- `src-tauri/src/plugins.rs:683-692`：`validate_manifest()` 校验 api、kind 和 entry，
  但没有校验 `m.id`。
- `src/plugins/registry.ts` 与 `plugin_store.rs` 后续按 id 访问存储；存储层再次
  检查 id 并拒绝。
- `.lupx` 路径会单独检查 id，因此手动放入 `plugins/` 的插件与包安装路径行为不一致。

**复现**

清单：

```toml
id = "bad id"
kind = "provider"
api = 2
entry = "main.js"
```

一页 Provider：

```js
export default function create(ctx) {
  return {
    async search(q) {
      try { await ctx.storage.get("x"); }
      catch (e) { return [{ name: "INVALID_ID_STORAGE:" + e, path: "https://example.com/x" }]; }
      return [];
    },
  };
}
```

观测：

- `get_plugins` 返回该插件，`apiError: null`、`enabled: true`；
- 搜索行可见；
- 行文本包含 `invalid plugin id`，说明逻辑入口已运行但 storage 拒绝。

**影响**

插件作者得到一个“清单有效、搜索可用、存储随机失败”的半加载状态；权限、数据库、
私有文件与设置命令都可能在不同层拒绝，排障成本高。若手动目录名本身含空格，错误
也会落在很晚的运行时。

**建议**

在 `validate_manifest()` 最先执行 `valid_plugin_id(&m.id)`；为空 id 时，对回退的
目录名执行同样校验。失败应写入 `apiError`，让设置页显示原因，并阻止注册任何
contribution。`plugins.rs` 的清单测试应覆盖空格、点号、反斜杠、控制字符和超长 id。

## F-09 HTTP(S) 插件图标与 deny proxy 的契约冲突

**严重度：中低**

**位置**

- `docs/PLUGIN_API.md:118` 与 `:266`：明确允许 `http(s):` 图标 URI。
- `src/launcher/iconSpec.ts:22-31`：HTTP(S) 字符串原样通过。
- `src-tauri/src/webview_guard.rs:41-52`：所有 WebView2 请求走 deny-only 代理；
  只有 `tauri.localhost`、asset、local dev origin 等列在 bypass 名单。
- `src/page-runtime/presenterBridge.tsx:275-290`：Presenter CSP 的 `img-src` 也没有
  允许任意 HTTP(S) 源。

**复现**

Provider 返回：

```js
{
  name: "HTTP_ICON_ROW",
  path: "https://example.com/http-icon",
  icon: "http://127.0.0.1:18777/icon.png?probe=1"
}
```

本地 HTTP server 监听 `127.0.0.1:18777`，等待请求；输入查询使该行渲染。

观测：

```json
{
  "requests": 0,
  "src": "http://127.0.0.1:18777/icon.png?probe=1",
  "naturalWidth": 0,
  "complete": true
}
```

即使插件声明 `network` 权限也不会改变结果，因为 deny proxy 是无条件的 WebView
出站闸门；插件能力 `http.request` 走的是 Rust/WinHTTP，和 `<img>` 不是同一条路径。

**建议**

二选一并统一文档、类型和运行时：

1. 禁止 HTTP(S) 图标：清单/Provider 行校验拒绝远程 URL，文档只保留
   `asset:`、`data:`、`blob:` 和本地相对路径；或
2. 允许 HTTP(S) 图标：由 Rust 通过权限感知的 `http.request` 同一条 SSRF 检查获取
   图片，并转换成 `data:`/asset 资源再交给 Presenter。不要放开 WebView 的远程
   图片加载，否则会再次形成绕过 network 权限的出站通道。

## 测试盲区

当前回归覆盖了大量正常路径，但以下边界没有被既有脚本覆盖：

1. 禁用已加载的 service / provider / mode，检查 frame、token、timer、生命周期与能力。
2. 超大 navBars、超大 select/filter、坏 path 类型和长字段的聚合预算。
3. Provider select 在查询切换、模式切换和页面隐藏后的代际行为。
4. 同一 Presenter 连续切换、快速失败重试和页面淘汰时的并发挂载。
5. 两个富文本片段自动合并后的 HTML、纯文本与回剪贴板一致性。
6. `%`、`_`、反斜杠、多语言和 source-app 组合搜索。
7. 焦点位于剪贴板分类/状态栏/行操作按钮时的 Space、Enter、Escape、Tab。
8. 手动放置非法 id 的插件，验证清单门、设置页错误和运行时无贡献。
9. HTTP(S) 图标在 deny proxy、Presenter CSP 和 network 权限下的行为。
10. 大图片复制、批量文件存在性检查、DB 锁竞争时的主线程/IPC 延迟。

## 工程改进建议

### 1. 把异步贡献统一到可证明的代际协议

Provider search/select/filter、剪贴板 search、navBars 刷新、Presenter mount 和
窗口状态推送都应使用相同的 `generation` 或 `AbortController` 语义。每个异步结果
只有在自己的代际仍是当前代际时才能写模型、选择、子输入、布局或窗口状态。

### 2. 把插件贡献做成有预算的“扇入”层

不要把插件的原始数组直接拼进页面模型。建议在 registry 做统一的
`ContributionBudget`：

- 每插件、每页面、每主机窗口的条目数；
- 单字段长度与总 JSON 字节；
- 行形状白名单；
- 单插件失败隔离；
- 超限时记录插件 id、贡献类型和丢弃数量，便于设置页诊断。

### 3. Provider 搜索改为并发有界、增量发布

`src/plugins/navigate/search.ts:279-295` 目前按插件串行 `await`，所有 Provider
返回后才设置结果。一个慢 Provider 会延迟后续 Provider 和原生结果的显示。建议：

- 先发布 native index / file-search 结果；
- Provider 用 `Promise.allSettled` 并发查询，设置全局超时；
- 每完成一个 Provider，就增量合并并遵守总预算。

### 4. 将重剪贴板命令移出同步 main thread

以下命令当前是同步 Tauri command，按仓库自己的约定会占用主线程：

- `copy_clipboard`
- `paste_clipboard`
- `paste_clipboard_multi`
- `plugin_clipboard_write_image`
- `check_file_exists`
- `delete_clipboard`
- `clear_clipboard`

其中图片 read/decode/encode、UNC `Path::exists` 和多文件清理尤其可能阻塞。建议分别
使用 `async` + `spawn_blocking`，并给批量路径检查设置数量/大小上限。CDP 可用
`performance.now()` 包裹 `invoke` 建立主线程延迟基线。

### 5. 修正过时的安全注释与契约文字

`src/plugins/permissions.ts:17-22` 仍写着 mode iframe 是 same-origin；实际
`src/plugins/iframeBridge.tsx:9-12` 和 `docs/PLUGIN_API.md` 已采用 opaque-origin
sandbox。`src/plugins/registry.ts:166-169` 也保留了“same-origin/no sandbox”的旧
说明。建议删除这些历史描述，统一以当前的三层防线（sandbox、Rust 调用方归属、
前端权限台账）为准。

### 6. 补一份公开的宿主行为表

把“禁用时是否卸载”“HTTP 图标是否可用”“未就绪 hook 是否计入熔断”“Presenter
切换是否取消旧挂载”“空查询下 navBars 是否阻塞”列为机器可读契约，并由构建期脚本
和 CDP 用例检查。这样可以避免实现与 API 文档再次分叉。

## 附录：本轮临时复现件

以下文件位于本机 gitignored 的 `test/`，用于复现，不属于产品源码：

- `probe_disabled_plugin_lifecycle.mjs`：禁用 service 后查询仍写入 storage。
- `probe_disabled_plugin_capability.mjs`：禁用后仍可读取剪贴板。
- `probe_provider_select_race.mjs`：旧 `select()` 结果覆盖新查询。
- `probe_presenter_switch_race.mjs`：PresenterHost 并发挂载状态错位。
- `probe_navbar_flood.mjs`：超大 navBars 使 Page Model 超限。
- `probe_clipboard_wildcards.mjs`：`%` / `_` 被当作通配符。
- `probe_merge_html.mjs`：富文本自动合并后 HTML 仍只含第一段。
- `probe_clipboard_space_button.mjs`：分类按钮上的 Space 被多选逻辑吞掉。
- `probe_invalid_plugin_id.mjs`：非法 id 通过清单门后在运行时失败。
- `probe_http_plugin_icon.mjs`：HTTP 图标请求没有到达本地服务器。
- `probe_presenter_scroll_preservation.mjs`：Presenter 切换时选中行和可视位置保持
  正常，用于排除该问题。

复现使用的临时插件基目录：`test/disable-base/`、`test/spoof-base/`、
`test/icon-base/` 与 `src-tauri/target/debug/plugins/` 下的隔离 fixture。测试后的临时 settings 值为 `merge_copy = false`、`merge_window_ms = 1500`、`dedup = true`；
业务源码和 git 跟踪文件未被这些临时插件修改。

## 处理顺序建议

1. 先处理 F-01：禁用必须成为真正的停用边界，至少在逻辑、生命周期和能力层同时生效。
2. 再处理 F-02：给贡献数据加总预算并让坏插件只影响自己，避免核心首页被拖垮。
3. 处理 F-03、F-04：为 Provider 下钻和 Presenter 挂载补代际/取消语义。
4. 处理 F-05、F-06、F-07：分别修正合并 HTML、LIKE 搜索和键盘控件。
5. 处理 F-08、F-09：收口清单 id 与远程图标契约。
6. 最后补同步命令的性能基线、回归脚本和文档对齐。
