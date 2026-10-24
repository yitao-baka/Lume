# Page Model / Presenter 运行时

本文是 Lume 页面运行时的当前契约。公开插件清单、能力与生命周期以
[PLUGIN_API.md](PLUGIN_API.md)、`src/plugins/types.ts` 和
`src-tauri/src/plugins.rs` 为准。

## 结论

页面由四个角色组成：

```text
Native Core        Rust 中的系统能力和业务事实
Page Service       页面模型、领域动作、网络/存储等逻辑后端能力
Host Runtime       生命周期、权限、意图路由、资源解析和窗口拼接
Presenter          只负责 DOM、布局、动画和交互形式
```

数据方向固定为：

```text
Native Core / Page Service
          ↓
       Page Model
          ↓
      Host Runtime
          ↓
       Presenter
          ↓
       Page Intent
          ↓
   Host Runtime / Page Service
```

同一个 Page Model 可以挂载不同的 Presenter，而页面服务、后端命令和权限规则
不变。Presenter 不直接访问 Tauri、数据库、文件、剪贴板、网络或秘密。

## 设计边界

- 原生能力仍在 Rust：Windows API、SQLite、剪贴板采集、文件索引、应用启动。
- Page Service 可以运行在启动器内的逻辑宿主，也可以由磁盘插件提供；它负责
  模型、请求、缓存、取消、错误和持久化。
- Presenter 是沙箱中的普通 HTML/CSS/JS，不是新的布局 DSL。
- Page Model 只包含可 JSON 化的数据，不包含函数、DOM、Solid 信号、Promise
  或不可结构化克隆的值。
- provider、navBars、list template 和后台 `service` 继续使用既有贡献模型；
  mode 的页面服务与 Presenter 使用本契约。

## 代码结构

| 路径 | 责任 |
|---|---|
| `src/page-runtime/contracts.ts` | Page Model、Intent、Service、Presenter 类型 |
| `src/page-runtime/session.ts` | Page Session、服务生命周期、查询和事件 |
| `src/page-runtime/modelStore.ts` | revision、校验、1 MiB 上限、帧合并 |
| `src/page-runtime/intents.ts` | Intent 目标与动作白名单 |
| `src/page-runtime/presenterHost.ts` | Presenter 选择、重试、回退、重挂 |
| `src/page-runtime/presenterBridge.tsx` | Presenter 受限桥、模型/事件/设置/快照 |
| `src/page-runtime/resources.ts` | 图标、缩略图和 URL scheme 校验 |
| `src/plugins/pageRuntimeMode.tsx` | 把远程 Page Service 与 Presenter 接入启动器外壳 |
| `src/page-services/navigate/` | 导航 Page Service |
| `src/page-services/clipboard/` | 剪贴板 Page Service |
| `src/presenters/navigate-*` | 导航网格与列表 Presenter |
| `src/presenters/clipboard-*` | 剪贴板历史与紧凑 Presenter |
| `src/pluginWindow.tsx` | 独立窗口中的镜像 Page Session |
| `src-tauri/src/plugin_window.rs` | 跨窗口 Page Service 请求/回复与窗口校验 |

## Page Session

`PageSession` 是一个页面的权威宿主，持有：

- Page Service 与当前模型；
- 当前 Presenter id、挂载状态、布局和 modal 状态；
- Intent 路由器；
- 模型 revision 与诊断探针。

生命周期规则：

- 切换 Presenter 不重建 Page Service，也不清空模型或选择。
- 隐藏页面保留会话；宿主栈达到上限时按 LRU 卸载 DOM，卸载前保存会话帧。
- 分离窗口中的 Page Session 是镜像：模型和动作都回到启动器内的权威会话。
- Presenter 崩溃由 Presenter Host 重试并回退其他兼容 Presenter。
- Page Service 崩溃由逻辑宿主熔断、重载和可见错误处理。
- 新的声明式 `enter` 丢弃旧会话帧，并交给 Page Service 处理新的载荷。
- 空闲重置可以卸载宿主并丢弃会话帧；`keep_session` 的页面不参与。

## 插件清单

api 2 自绘 mode 的当前形状：

```toml
id = "file-search"
name = "File Search"
version = "2.0.0"
kind = "mode"
api = 2

model = "lume.collection/v1"
entry = "service.js"
permissions = ["search.files", "clipboard"]
page_runtime = true
default_presenter = "default"
height = 560
detachable = true

[[presenters]]
id = "default"
name = "Default"
entry = "view.html"
titlebar = "titlebar.html"
models = ["lume.collection/v1"]

[[presenters]]
id = "compact"
name = "Compact"
entry = "compact.html"
models = ["lume.collection/v1"]

[[presenter_settings]]
presenter = "default"
key = "density"
label = "Density"
type = "select"
default = "comfortable"

[[presenter_settings.options]]
value = "comfortable"
label = "Comfortable"
```

规则：

- `api = 2` 是唯一接受的插件 API。
- 自绘 mode 需要 `model`、`entry`、`page_runtime = true` 和至少一个 Presenter。
- `permissions` 只约束 Page Service。
- Presenter 默认没有敏感能力；它只拿到 `lume.page`、主题和外壳安全动作。
- 每个 Presenter 的 `models` 必须覆盖顶层 `model`；省略时继承顶层 schema。
- `default_presenter` 缺失或不可用时选择第一个兼容 Presenter。
- 顶层 `view` / `titlebar` 不再是页面入口；标题栏属于具体 Presenter。
- 顶层清单不再接受 api 1、缺失 api 或旧页面字段。

`template = "list"` 继续作为宿主内置 collection 页面的快捷形式，不提供任意
Presenter HTML。provider、navBars 和后台 `service` 的清单形状不变。

## Page Model

```ts
type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface PageModel<Data extends JsonValue = JsonValue> {
  runtime: "lume.page/v1";
  schema: string;
  revision: number;
  status: "loading" | "ready" | "empty" | "error";
  data: Data;
  selection?: {
    primaryId?: string;
    selectedIds?: string[];
  };
  actions?: PageAction[];
  preview?: PagePreview | null;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}
```

- `revision` 单调递增，旧 revision 不覆盖新 revision。
- 条目 id 必须稳定，不使用数组下标作为跨更新身份。
- 模型文本由 Page Service 本地化；Presenter 自己的装饰文案自行本地化。
- 模型不得包含 API Key、令牌、完整私有内容或不必要的绝对路径。
- 单次模型上限为 1 MiB；大集合使用窗口化数据。
- 高频更新在动画帧边界合并；Page Service 负责丢弃过时请求。

内置 schema：

- `lume.navigate/v1`：栏目、结果、推荐区、选择、展开和页面状态。
- `lume.clipboard/v1`：分类、历史窗口、多选、状态栏、预览和清空状态。
- `lume.collection/v1`：通用条目/分组集合，供磁盘 mode 和 list template 使用。
- 插件也可以声明自定义 schema，例如 `translator.translation/v1`。

## Page Intent

支持的标准意图：

- `selection.set`、`selection.move`、`selection.clear`
- `item.activate`
- `item.action`
- `query.submit`
- `page.refresh`、`page.cancel`、`page.escape`、`page.retry`
- `viewport.request`
- `layout.report`

规则：

- `item.activate` 必须指向模型中的稳定 target id。
- `item.action` 的 `actionId` 必须来自全局动作或 target 的动作台账。
- `actionId` 为空时只允许模型声明的全局动作。
- collection 的 `viewport.request` 受 offset/limit 边界限制。
- hover、临时焦点环、滚动位置和动画属于 Presenter 本地状态。
- 搜索框由 Host Runtime 拥有；Presenter 只能请求聚焦或设置查询。
- 模态状态通过 `setModal(true/false)` 回报，宿主据此暂停全局快捷键。

## Page Service

Page Service 通过逻辑宿主中的 `ctx` 使用能力：

```ts
interface PageService {
  getModel(): PageModel | Promise<PageModel>;
  onIntent?(intent: PageIntent): Promise<IntentResult> | IntentResult;
  onQuery?(query: string): Promise<void> | void;
  onSubInput?(text: string): Promise<void> | void;
  onShow?(): Promise<void> | void;
  onHide?(): Promise<void> | void;
  onEnter?(info: unknown): Promise<void> | void;
  onFilesDropped?(paths: string[]): Promise<void> | void;
  onSettings?(values: Record<string, unknown>): Promise<void> | void;
  dispose?(): Promise<void> | void;
}
```

Page Service 的服务面：

- `ctx.page.publish(model)` / `patch(update)` / `emit(event)` / `setError` /
  `clearError`；
- `ctx.storage`、`ctx.db`、`ctx.settings`；
- 清单声明的 `http`、`fs`、`search`、`clipboard` 等能力；
- 清单声明的 `ctx.secrets` 只对 service 角色开放，明文不进入模型或事件。

## Presenter

Presenter 只获得：

```ts
interface PagePresenterApi {
  ready(): Promise<void>;
  getModel(): Promise<PageModel>;
  subscribe(fn: (model: PageModel) => void): () => void;
  dispatch(intent: PageIntent): Promise<IntentResult>;
  reportLayout(report: PageLayoutReport): Promise<void>;
  setModal(open: boolean): Promise<void>;
  requestSearchFocus(): Promise<void>;
}
```

附加外壳动作：

- `theme.get` / `theme.set`
- `app.toast`
- `app.resize`
- `app.dragWindow`
- `app.detach`
- `app.setQuery`

Presenter 桥在页面处理器安装前缓存事件；首次 mount、Presenter 切换和设置更新
都从同一路径下发。Presenter 的文件请求通过资源解析器，不允许任意 URL scheme。

## 内置页面

### 导航

- Page Service 拥有栏目、合并搜索、激活、菜单、pin/recent/folder 动作和拖拽重排。
- `lume.navigate/v1` 是唯一页面事实。
- `navigate-grid` 与 `navigate-list` 消费同一模型，差异只在 DOM 和交互形式。
- 网格保留二维方向键移动；紧凑列表以 ↑/↓ 线性遍历可见行，←/→ 留给搜索框
  光标编辑。紧凑列表把收起的栏目显示为一行，并在切换 Presenter、收起栏目与
  执行 `Enter` 前把选择钳制到可执行行，隐藏项不能被激活。
- provider、feature、keyword 和 navBars 在 Page Service 内归一化。
- Presenter 切换不重新搜索，不丢栏目展开和选择。

### 剪贴板

- Page Service 包装 Rust-backed ClipboardStore，只发布视口窗口内的行。
- Rust 继续拥有采集、去重、合并、历史裁剪、图片缓存和前台粘贴。
- `clipboard-list` 与 `clipboard-compact` 共用分类、选择、清空、暂停和窗口请求。
- `viewport.request` 同时上报 `scrollTop`、`viewportHeight` 与当前 Presenter 的
  `rowHeight`；模型另外发布完整列表中的 `selectedIndex`，Presenter 据此滚动和
  请求新的窗口化行。历史列表使用 52px 行高，紧凑历史使用 44px。
- 两套 Presenter 都把首击未选中行解释为“选择”，只有已选中行再点击才激活；
  `item.activate` 回到 ClipboardStore 的统一激活路径，从而保留空格多选后的
  合并粘贴。清空确认框是带遮罩、焦点陷阱和安全默认焦点的模态作用域。
- 预览服务跟随 Page Model 的选择，不依赖 Presenter DOM。
- 停用页面不改变 Rust 后台采集配置。

### 外壳适配

`ModeInstance` 只作为启动器内部的 shell adapter，连接
Page Session、键盘路由、窗口尺寸、上下文菜单和 Solid 页面挂载。它不是磁盘
插件可实现的公开接口，也不是 Presenter 契约。磁盘 mode 的公开入口始终是
Page Service + `[[presenters]]`。

## 独立窗口

`detachable = true` 的 page-runtime mode 可以把 Presenter 移入独立窗口：

- 启动器持有权威 Page Session；窗口中的会话只镜像模型。
- 请求通过 `plugin_page_bridge_call/reply`，由 Rust 校验窗口标签、请求 id、
  操作白名单、参数/结果大小和回复方。
- 窗口关闭时把 view 与标题栏帧的快照上报启动器；启动器消费帧、保留模型，
  并在用户请求时回流到原页面。
- 新 `enter` 清除旧帧，避免旧输入覆盖新载荷。
- Presenter 的 `titlebar` 在独立窗口中作为第二个受限 Presenter 挂载。
- 独立窗口的 Presenter 切换、设置、主题和错误状态复用同一状态通道。

## 设置归属

| 类别 | 所有者 | 示例 |
|---|---|---|
| 外壳设置 | Host Runtime / 设置窗 | 语言、主题、窗口宽高、模式胶囊、共享查询 |
| 页面服务设置 | Page Service | 最近使用、历史上限、API 默认引擎 |
| Presenter 设置 | 当前 Presenter | 条目尺寸、圆角图标、时间格式 |
| 秘密设置 | Page Service + Rust secret store | API Key、访问令牌 |

- 内置页设置留在 `settings.toml`。
- 磁盘插件服务设置和 Presenter 设置进入插件独立文档库。
- `[pages.presenters]` 保存页面到 Presenter 的映射。
- 缺失或损坏的 Presenter 选择回退清单默认项。
- Presenter 设置按 `{presenter: {key: value}}` 隔离，不与服务设置同名覆盖。

## 安全与限额

- Presenter 运行在 opaque-origin 沙箱，不授予 `allow-same-origin`。
- Presenter 的敏感 RPC 在 `permissions.ts`、宿主 API 和 Rust 命令侧同时拒绝。
- Page Service 的 `entry` 仍受插件权限与 Rust 台账约束。
- 模型 JSON 校验深度、节点数、字符串长度和总大小。
- ResourceRef 校验 scheme、插件目录和 URL。
- Presenter 模型、资源和 intent 都有传输上限。
- Presenter 崩溃不终止 Page Service；Page Service 崩溃走逻辑宿主熔断和重载。

## 诊断

- `window.__pageModels`：模型元数据、revision 和大小。
- `window.__pageIntents`：最近 intent、处理者、结果和耗时。
- `window.__presenterStates`：ready、错误、布局、modal 和重挂状态。
- `window.__pageResources`：资源失败和 scheme 拒绝。
- `window.__logicRpcLog`：逻辑宿主 RPC。
- 探针只保留小环形缓冲，不记录秘密、完整文本或大图片。

## 验证

编译与单测：

```bash
pnpm exec tsc --noEmit
pnpm exec tsc -p examples/tsconfig.json
pnpm run test:page-runtime
pnpm run build
cd src-tauri && cargo check && cargo test
```

页面运行时集成：

- `scripts/cdp_page_runtime_verify.mjs`
- `scripts/cdp_file_search_presenter_verify.mjs`
- `scripts/cdp_translation_service_verify.mjs`
- `scripts/cdp_presenter_control_verify.mjs`
- `scripts/cdp_detached_page_runtime_verify.mjs`
- `scripts/cdp_plugin_state_verify.mjs`
- `scripts/cdp_plugin_window_verify.mjs`

回归范围还包括插件、安全沙箱、熔断、主题、图标、LRU、导航/剪贴板、设置窗和
视觉审计。具体命令与手工项见 [TESTING.md](TESTING.md)。

## 验收不变量

- 导航与剪贴板共用 Page Session、模型和 Intent 协议。
- 两个不同 Presenter 渲染同一模型，不需要修改 Page Service。
- 翻译服务独占网络、缓存、取消、错误和秘密读取。
- Presenter 无法直接访问网络、数据库、文件、剪贴板或秘密。
- 切换 Presenter 不重置服务、查询结果或选择。
- 独立窗口、titlebar、回流、主题、懒加载和键盘契约保持。
- `file-search` 与 `translator` 声明 api 2，并以 Page Service / Presenter 运行。
- api 1 插件被明确拒绝，不存在隐式兼容路径。
- provider、navBars、list template 和后台 service 没有回归。
- 设置窗持久化 Presenter 选择，并保留旧设置值。
- 编译、Rust 单测、CDP 回归和手工清单通过。
