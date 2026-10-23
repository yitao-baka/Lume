# Page Model / Presenter 运行时重构方案

本文定义 Lume 启动器页面运行时的目标架构、公共契约和迁移顺序。它描述的
是待实施设计，不是当前已经生效的 API；当前插件契约仍以
[PLUGIN_API.md](PLUGIN_API.md)、`src/plugins/types.ts` 和
`src-tauri/src/plugins.rs` 为准。

## 结论

页面不再由单个 `ModeInstance` 同时拥有数据、动作、键盘和 Solid 组件。目标
模型把页面拆成四个角色：

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

验收目标是：同一个页面模型可以在不修改页面服务、后端命令和权限规则的情况下，
被内置网格、普通列表、命令面板或第三方 HTML/JS 页面渲染。

## 设计边界

### 「后端」的含义

本项目中的「后端能力」分成两层：

- **原生能力**：Rust 核心、Windows API、SQLite、剪贴板采集、文件索引和启动
  应用。
- **页面逻辑后端**：页面对应的 Page Service。它可以运行在宿主内，也可以由
  磁盘插件提供，负责页面模型、API 请求、缓存、错误处理、取消和持久化。

翻译插件需要的是第二层能力，不是任意 Windows 系统权限。它应通过 Page
Service 使用 `http`、`storage`、`settings`，并可通过新增的 `secrets` 能力读取
API Key；Presenter 不接触这些能力。

### 不属于本次目标

- 不把 Rust 中已有的业务逻辑搬到浏览器。
- 不提供 Node.js、任意子进程或完整原生 preload。
- 不设计一套 CSS/布局 DSL；Presenter 仍然写真正的 HTML/CSS/JS。
- 不要求每个设置页、预览页或后台服务都立即改成 Presenter。
- 不允许 Presenter 绕过沙箱直接调用 Tauri 命令。
- 不让「模型 JSON」包含函数、DOM 节点、Solid 信号或不可结构化克隆的值。

## 当前结构审计

### 外壳与页面

- `src/App.tsx` 是组合根，同时负责 mode 切换、查询共享、窗口尺寸、键盘路由、
  toast、右键菜单、页面保活、插件刷新和设置同步。
- `src/shell/SearchBox.tsx` 是受控展示组件，查询路由和 placeholder 决议在
  `App.tsx`。
- 页面在当前代码中通过 `ModeInstance` 接入。该接口同时包含：
  - 查询和搜索。
  - 行数据与选中索引。
  - 激活和按键。
  - 右键菜单动作。
  - 加载、尺寸、预览和 settings 生命周期。
  - `View: Component`。

`View: Component` 直接依赖 SolidJS，意味着当前页面契约不是框架无关的；
页面模型也没有和展示器分离。

### 导航页

- `src/plugins/navigate/index.tsx` 负责注册、按键、菜单、页面状态和 view 接线。
- `store.ts` 同时拥有栏目数据、选择状态、应用动作、终端动作和拖拽重排。
- `search.ts` 同时拥有查询、结果合并、provider 调用、feature 匹配、拖拽文件
  上下文和前台窗口上下文。
- `NavigateView.tsx` 直接消费 store/search 返回的 Solid 响应式值。

导航页的业务状态和展示状态有明确边界，但当前没有形成稳定的模型契约。

### 剪贴板页

- `src/plugins/clipboard/store.ts` 同时维护查询、历史行、选择、多选、分类、
  虚拟列表窗口、清空确认、撤销和多个 Tauri 命令调用。
- `ClipboardView.tsx` 直接拿到整个 store，因此 View 与命令、设置和页面状态
  强耦合。
- 停用剪贴板页面不会停止 Rust 的后台采集；采集配置属于原生能力，页面展示
  属于 Presenter，两者必须继续分开。

### 磁盘插件

- `src/plugins/registry.ts` 的 `createDiskModeInstance` 把磁盘 mode 映射成
  `ModeInstance`。
- 视图通过 opaque-origin iframe 加载，HTML 和桥接能力已经具备沙箱基础。
- `entry` 逻辑运行在共享逻辑宿主中，每个插件一个隔离帧，已经具备服务 Runtime
  所需的崩溃隔离、超时、熔断和重载机制。
- 当前 mode 的 `permissions` 是插件级权限，不是服务/展示器分级权限；新架构
  必须区分角色。

### Provider、navBars 和 list template

- provider 当前返回 `{name,path,description,icon,enter,drill}` 等结果行。
- navBars 当前返回栏目标题和条目。
- `template = "list"` 当前由宿主列表模板渲染逻辑入口返回的行。

这些贡献可以继续存在，但最终都要归一化成导航 Page Service 消费的语义条目，
不能让 Presenter 理解 provider 来源和 feature 来源的差异。

### 设置与插件管理

- 设置窗口是独立的 `settings` WebView，通过 `settings-applied` 通知启动器。
- `App.tsx` 再调用每个 mode 的 `applySettings()`。
- 插件启停、权限、声明式设置和 `.lupx` 安装由设置窗及 Rust 命令管理。
- 当前设置混合了外壳设置、页面服务设置和展示器设置，例如：
  - 最近使用是否显示属于导航服务。
  - 条目框大小和圆角图标属于导航展示器。
  - 是否记录图片/文件和历史上限属于剪贴板采集服务。
  - 是否显示来源应用、时间格式和悬停选择属于剪贴板展示器。

迁移后必须把这些设置按角色重新归属，否则替换 Presenter 后会留下一批无效或
含义不一致的设置。

### 翻译插件

文档和 CDP 历史多次引用外部 `translator`，但该插件源码不在本仓库的
`examples/plugins/` 中。实施时必须在仓库内建立可离线验证的翻译
service/presenter fixture，避免依赖本机外部插件才能验证架构。

### 已知 API 1 mode 插件升级范围

正式切换前只保留一份明确的升级清单，不建立长期兼容层：

- `examples/plugins/file-search/`
  - 把查询、文件搜索调用和结果状态移入 Page Service。
  - 模型使用自定义 schema 或 `lume.collection/v1`，保留文件类型、路径、
    副标题、图标和打开/定位动作。
  - 当前页面视觉迁移为默认 Presenter。
  - 增加一个替代 Presenter，用于验证同一搜索结果模型可以更换展示。
- 外部 `translator`
  - 把引擎选择、语言方向、API 调用、取消、缓存和 API Key 读取移入 Page Service。
  - 默认左右对照 Presenter 和紧凑 Presenter 共享同一翻译模型。
  - 保留 detachable；独立窗口的标题栏继续作为该 Presenter 的 titlebar 槽位。
  - API Key 使用 `secrets`，不得进入模型、页面脚本或日志。
- 仓库中的 `hello-mode`、`list-demo`、`host-tools`、`file-search` 等 mode
  示例和 CDP fixture 必须随 API 2 一起改写；它们不是发行兼容对象，但会作为
  新契约的测试载体。
- provider 和后台 service 示例在没有页面模型变化时可以保留原逻辑，但仍需
  把清单升级到 `api = 2`，并通过新版公共类型和示例构建。

## 目标运行模型

### Page Session

每个已访问页面有一个 Page Session。它拥有：

- 页面 id 和 pill 元数据。
- Page Service 实例。
- 当前 Page Model 和 revision。
- 当前 Presenter 及其状态。
- 查询、可见性、模态、布局和 detach 生命周期。
- 诊断日志、最近的 intent 和模型更新。

Page Session 的领域状态与 Presenter 生命周期解耦。切换 Presenter 不得重建
Page Service，也不得丢失页面数据。

### 生命周期

```text
首次进入页面
  → 创建 Page Service
  → 请求初始 Page Model
  → 选择兼容的 Presenter
  → Presenter ready
  → 推送快照

用户输入 / 点击
  → Presenter dispatch(Page Intent)
  → Host Runtime 验证
  → Page Service 执行领域动作
  → 发布新 revision / events
  → Presenter 更新

切换 Presenter
  → 保留 Page Service 和 Page Model
  → 销毁旧 Presenter
  → 创建新 Presenter
  → 推送同一模型

分离窗口
  → Page Service 保持单一权威
  → 独立窗口挂载同一模型的 Presenter
  → 关闭窗口后回流 Presenter
```

### 所有权矩阵

| 关注点 | Native Core | Page Service | Host Runtime | Presenter |
|---|---|---|---|---|
| Windows / DB / 索引 / 启动 | 拥有 | 通过命令调用 | 路由 | 不可访问 |
| 页面领域数据 | 提供事实 | 拥有模型与状态迁移 | 缓存和校验 | 只读消费 |
| 网络、API Key、缓存 | 提供安全存储 | 拥有请求与业务规则 | 限制到服务角色 | 不可访问 |
| 查询 | 可提供搜索结果 | 处理语义查询 | 拥有搜索框和路由 | 只读/可请求聚焦 |
| 选择、多选 | 不负责 | 拥有或确认状态 | 校验并分发 | 发起选择意图 |
| DOM、布局、动画 | 不负责 | 不负责 | 不进入 Presenter DOM | 拥有 |
| 窗口高度、模态 | 提供窗口 API | 可报告业务需求 | 最终裁决 | 报告布局需求 |
| 快捷键基础路由 | 不负责 | 不负责 | 拥有 | 处理页内语义键 |
| 右键菜单动作 | 不负责 | 提供动作与规则 | 可渲染共享菜单 | 可自绘并发出同一意图 |
| 主题和语言 | 设置事实 | 可本地化模型文本 | 分发 | 负责自身视觉 |
| 预览 | 窗口和内容解码 | 声明预览目标 | 转发到预览服务 | 可请求显示/关闭 |

## 公共契约

### 插件 API 版本

页面契约直接切换到插件 API 2：

- 新宿主只发布并支持 `api = 2`。
- 正式版本拒绝加载所有 `api = 1` 插件包和页面，包括 mode、provider 和后台
  service，并给出明确的本地化升级提示。
- 面向真实用户的现有 API 1 mode 插件按当前盘点只有 `file-search` 和
  `translator`，两者在正式切换前同步升级。
- 仓库内其他 `examples/plugins/` 和 CDP fixture 即使不是发行插件，也要同步
  改写，避免测试继续固化旧契约。
- 迁移期间可以保留一个只服务于内置页面和仓库测试的编译期适配器；它不是公共
  兼容层，正式版本收口时删除。
- Page Model 的 schema 单独版本化，例如 `lume.navigate/v1`。以后的破坏性
  模型变化使用新的 schema 名称，不重新解释旧 schema。

`kind = "mode"` 继续表示「页面贡献」，避免同时引入新的 kind 和 API 版本。
已有的 `service` kind 仍表示无页面的后台服务，不把两种 service 混为一谈。

### 清单形状

目标清单示例：

```toml
id = "translator"
name = "Translator"
version = "2.0.0"
kind = "mode"
api = 2

model = "translator.translation/v1"
entry = "service.js"
permissions = ["network", "secrets"]
keywords = ["translate", "翻译"]

height = 560
detachable = true
default_presenter = "default"

[[presenters]]
id = "default"
name = "Default"
entry = "view.html"
titlebar = "titlebar.html"
models = ["translator.translation/v1"]

[[presenters]]
id = "compact"
name = "Compact"
entry = "presenters/compact.html"
models = ["translator.translation/v1"]

[[presenter_settings]]
presenter = "default"
key = "density"
label = "Density"
type = "select"
default = "comfortable"

[[presenter_settings.options]]
value = "comfortable"
label = "Comfortable"

[[presenter_settings.options]]
value = "compact"
label = "Compact"
```

清单规则：

- `api = 2` 的自绘 mode 必须声明 `model` 和至少一个 Presenter。
- Page Service 入口是 `entry`；没有 `entry` 的 api 2 自绘页面不能声明动态模型。
- `permissions` 只约束 Page Service。
- Presenter 默认没有网络、文件、数据库、剪贴板或密钥权限。
- `default_presenter` 缺失时选择第一个兼容 Presenter。
- `view` 不再是 api 2 的页面入口；每个 Presenter 必须通过 `[[presenters]]`
  明确定义。
- `template = "list"` 继续作为宿主内置 collection Presenter 的快捷形式，
  但底层应走同一 Page Model / Intent 路径。
- 每个 Presenter 用 `models` 声明支持的 schema；省略时继承顶层 `model`。
- Presenter 可选声明 `titlebar`，只在 detachable 独立窗口中挂载；它共享
  当前 Page Model，但只获得标题栏所需的受限 UI 动作。
- 宿主内置 Presenter 的兼容 schema 在代码注册表声明，不写清单。
- `.lupx` 安装确认必须分别展示服务能力和 Presenter 列表，不能把两者合并成
  一个模糊的「插件可做的事」。

### Page Model

Page Model 是当前展示所需的完整语义快照，不是整个数据库。

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

interface PageAction {
  id: string;
  label: string;
  kind?: "default" | "primary" | "danger";
  shortcut?: string;
  enabled?: boolean;
}
```

规则：

- `revision` 单调递增；旧 revision 不得覆盖新 revision。
- 条目使用稳定 id，不用数组下标作为跨更新身份。
- 模型只包含可 JSON 化的数据，不包含函数、类实例、DOM、信号或 Promise。
- 模型文本由 Page Service 负责本地化；Presenter 的自身装饰文案可自行本地化。
- 模型不得包含 API Key、访问令牌、完整私有文件内容或不必要的绝对路径。
- Host Runtime 对模型做运行时校验、资源字段检查和大小限制。
- 初始实现的单次模型上限为 1 MiB。大集合使用窗口化数据，不把全部历史记录
  一次序列化给 Presenter。
- 模型更新初期使用完整快照替换；协议保留增量 patch 的扩展位，但只有在性能
  数据证明必要时实现，避免过早引入复杂的 JSON Patch 语义。
- Host Runtime 在动画帧边界合并高频更新；Page Service 仍必须自行丢弃过时请求。

### 标准模型 schema

宿主提供以下内置 schema：

- `lume.navigate/v1`：栏目、结果、推荐区、选择、展开和页面状态。
- `lume.clipboard/v1`：分类、历史窗口、多选、状态栏、预览和清空状态。
- `lume.collection/v1`：通用标题、分组、条目、动作、空态和滚动窗口，用于
  `template = "list"` 及简单插件页面。

插件可以使用自定义 schema，例如 `translator.translation/v1`。自定义 schema
需要随插件提供：

- TypeScript 类型或 `.d.ts` 声明。
- 可重复的 JSON fixture。
- 最小运行时守卫。
- Presenter 兼容声明。

不为所有页面强行设计一个万能 UI DSL。`collection` 只覆盖列表类页面，翻译这类
有明确双栏状态机的页面使用自己的 schema。

### `lume.collection/v1`

通用集合模型至少包含：

```ts
interface CollectionModel {
  title?: string;
  groups?: {
    id: string;
    title?: string;
    expandable?: boolean;
    expanded?: boolean;
    items: CollectionItem[];
  }[];
  items?: CollectionItem[];
  total?: number;
  window?: {
    offset: number;
    limit: number;
  };
  emptyText?: string;
}

interface CollectionItem {
  id: string;
  label: string;
  description?: string;
  icon?: ResourceRef;
  badges?: string[];
  disabled?: boolean;
  actions: string[];
}
```

`window` 表示当前模型只描述某一页或某一视口范围，不表示 Page Service 忘记了
完整数据。

### Page Intent

Presenter 只能发出语义意图，不能发 Tauri 命令名。

```ts
interface PageIntent {
  requestId?: string;
  type: string;
  targetId?: string;
  actionId?: string;
  payload?: JsonValue;
}

interface IntentResult {
  requestId?: string;
  status: "accepted" | "completed" | "failed";
  code?: string;
  message?: string;
  value?: JsonValue;
}

interface PageEvent {
  type: string;
  requestId?: string;
  payload?: JsonValue;
}
```

标准意图包括：

- `selection.set`
- `selection.move`
- `selection.clear`
- `item.activate`
- `item.action`
- `query.submit`
- `page.refresh`
- `page.cancel`
- `page.escape`
- `page.retry`
- `viewport.request`

领域动作使用 `item.action` 加模型中的 `actionId`，例如：

- `open`
- `open-as-admin`
- `reveal`
- `pin`
- `unpin`
- `remove-recent`
- `copy`
- `paste`
- `delete`
- `restore`
- `clear`
- `preview`
- `translate`
- `swap-languages`
- `select-engine`

规则：

- Host Runtime 验证 `targetId` 和 `actionId` 存在于当前模型。
- Page Service 再做一次业务校验；前端守卫不等于安全边界。
- 不在模型中的动作不能被执行。
- 异步动作携带 `requestId`，完成或失败通过 Intent Result 和 Page Event 返回。
- Page Event 只用于瞬时或流式结果，不替代可恢复的 Page Model 状态。
- 取消是协作式的；Host Runtime 转发取消意图，Page Service 负责中止底层工作。
- Presenter 不得通过任意字符串调用未声明的宿主方法。

### Page Service

Page Service 是逻辑后端角色，不是新的进程模型。

```ts
export default function create(ctx) {
  return {
    async getModel() {
      return {
        runtime: "lume.page/v1",
        schema: "translator.translation/v1",
        revision: 1,
        status: "ready",
        data: {},
      };
    },

    async onIntent(intent) {
      return { status: "accepted" };
    },

    onQuery(query) {},
    onShow() {},
    onHide() {},
    onEnter(info) {},
    onFilesDropped(paths) {},
    onSettings(values) {},
  };
}
```

Service context 至少提供：

- `ctx.page.publish(model)`：发布新的完整模型。
- `ctx.page.patch(update)`：为后续增量更新保留。
- `ctx.page.emit(event)`：发送不进入持久模型的一次性或流式事件。
- `ctx.page.setError(error)` / `ctx.page.clearError()`：发布统一错误状态。
- 现有 `ctx.http`、`ctx.storage`、`ctx.db`、`ctx.settings`、`ctx.fs` 和宿主动作。
- 新增 `ctx.secrets`，只对 Page Service 角色开放。

Service 可以做：

- 翻译 API、汇率、词典、搜索等网络请求。
- API Key、缓存、历史和文档持久化。
- 去抖、重试、取消、限流和错误分类。
- 在后台产生模型更新和事件。

Service 不可以做：

- 直接访问 Presenter DOM。
- 返回函数、DOM 或不可克隆值。
- 把秘密值写入 Page Model、日志或事件。
- 通过发布模型绕过 Host Runtime 的动作规则。

### Presenter

Presenter 是沙箱 iframe 内的任意 HTML/CSS/JS 页面，也可以是内置 Solid 组件。
外部 Presenter 的公共入口：

```js
await lume.page.ready();

const model = await lume.page.getModel();
lume.page.subscribe((model) => render(model));

const result = await lume.page.dispatch({
  type: "item.action",
  targetId: "item-42",
  actionId: "open",
});
```

Presenter 可用：

- `lume.env.form`
- `lume.page.getModel/subscribe/dispatch`
- `lume.page.reportLayout`
- `lume.page.setModal`
- `lume.page.requestSearchFocus`
- `lume.theme.get/set`
- `lume.app.toast`
- `lume.app.resize`
- `lume.app.dragWindow`
- `lume.app.detach`
- `lume.app.setQuery`
- Presenter 自身声明且保存的展示设置

Presenter 不可用：

- `http`
- `storage`
- `db`
- `fs`
- `clipboard`
- `dialog`
- `screen`
- `search.files`
- `secrets`
- 任意 Tauri `invoke`
- 启动任意路径或其他敏感动作；这些动作必须走 Page Intent

Presenter 错误、刷新和崩溃只影响该 Presenter。Host Runtime 应保留 Page
Service 和 Page Model，并尝试重挂载当前 Presenter；重复失败时回退到同 schema
的默认 Presenter 或通用错误 Presenter。

Detachable 页面的 titlebar 是当前 Presenter 的第二个槽位，不是独立页面服务。
它接收同一 Page Model 的精简快照、主题和 query，可使用 `app.setQuery`、
`app.dragWindow`、窗口控制和 `lume.page.dispatch`；关闭、最小化、最大化等
窗口动作由 Host Runtime 路由。主 Presenter 切换时，titlebar 重新加载；切换
不得重建 Page Service。

Presenter 必须遵守 [UI_GUIDELINES.md](UI_GUIDELINES.md) 的连续面板、焦点、
命中区域、滚动和无障碍契约。内置 Solid Presenter 的用户可见文案继续走 `t()`；
外部 Presenter 自行负责自己的本地化，但模型中的显示文本应由 Page Service
按当前语言提供。

### 资源引用

模型可以携带已经由宿主解析的图标和缩略图引用：

```ts
interface ResourceRef {
  kind: "url" | "asset" | "file-icon" | "thumbnail";
  src: string;
  light?: string;
  dark?: string;
  width?: number;
  height?: number;
  alt?: string;
}
```

规则：

- Presenter 不理解插件目录、文件索引或图标缓存。
- Host Runtime 负责把插件相对路径、应用图标和剪贴板缩略图解析为可展示 URL。
- 只允许明确白名单的 URL scheme。
- 大图使用缩略图或资源 URL，不把大块 base64 塞进 Page Model。
- 图标主题变体由模型携带或由 `lume.resources` 解析，不让 Presenter 读取宿主
  主题表来猜。

### 选择、键盘与焦点

- 选中状态属于 Page Model，使用稳定 id。
- hover、临时焦点环、滚动位置和动画属于 Presenter 本地状态，不写入模型。
- Presenter 根据自身布局计算方向键目标，再发 `selection.set`。
- Host Runtime 为线性列表提供默认选择回退，但不猜测网格列数。
- Enter 默认调用选中条目的主动作；主动作也必须在模型 actions 中声明。
- Space 多选、Delete、左/右分类等页面快捷键由 Presenter 解释为语义意图。
- 搜索框始终由 Host Runtime 拥有；Presenter 只能请求聚焦或设置查询。
- Presenter 进入模态时调用 `setModal(true)`，宿主据此暂停 mode 切换和全局
  快捷键。
- 模态关闭后必须恢复焦点到 Presenter 内的触发控件；返回搜索框时调用
  `requestSearchFocus()`。
- F6 环把外部 Presenter iframe 视为一个页面区域；Presenter 自己负责内部控件
  顺序和焦点陷阱。

### 布局和窗口高度

Presenter 自己决定布局，因此由 Presenter 报告布局需求：

```ts
lume.page.reportLayout({
  sizing: "fit",
  contentHeight: 384,
  expanded: true,
});
```

或：

```ts
lume.page.reportLayout({
  sizing: "fixed",
  height: 560,
});
```

Host Runtime 负责：

- 最小/最大高度和工作区上限。
- 加载时折叠到搜索行。
- 空页面折叠。
- 模式切换后的重新测量。
- Presenter 切换和 detach 时的尺寸恢复。

Presenter 不能直接控制窗口大小绕过 Host Runtime；它只能报告布局意图。

### 右键菜单和共享动作

- Page Model 的 actions 是语义动作台账。
- Host Runtime 可以生成共享右键菜单和键盘菜单入口。
- Presenter 可以自绘菜单，但必须发出同一组 Page Intent。
- 菜单项是否可见、是否危险、是否可用由模型动作和 Page Service 共同决定。
- 共享菜单只是可选的宿主呈现，不是 Presenter 必须采用的 UI。

### 预览

剪贴板等页面在模型中提供 `preview`：

```ts
interface PagePreview {
  kind: "text" | "image" | "file" | "audio" | "video" | "pdf";
  targetId: string;
  payload: JsonValue;
}
```

预览服务监听当前 Page Session 的模型：

- 选中项变化时更新预览目标。
- 页面卸载或选择清空时关闭预览。
- Presenter 只负责选择；不直接创建预览窗口，也不解码大文件。

### 设置归属

新架构必须区分四类设置：

| 设置类别 | 所有者 | 示例 |
|---|---|---|
| 外壳设置 | Host Runtime / 设置窗 | 语言、主题、窗口宽高、模式胶囊、共享查询 |
| 页面服务设置 | Page Service | 最近使用是否显示、历史上限、是否记录图片、API 默认引擎 |
| Presenter 设置 | 当前 Presenter | 网格/列表、条目尺寸、圆角图标、来源应用显示、时间格式 |
| 秘密设置 | Page Service + Rust secret store | API Key、访问令牌 |

迁移映射：

- 导航 `show_recent`、`show_explorer_bar`、`expand_pinned` 归导航 Page Service。
- 导航 `entry_size`、`round_app_icons` 归导航 Presenter。
- 剪贴板 `history_cap`、`record_images`、`record_files`、`dedup`、
  `merge_copy`、`merge_window_ms`、`ignore_apps` 归原生剪贴板服务和 Rust。
- 剪贴板 `show_source_app`、`time_display`、`hover_select`、
  `favorites_top` 归剪贴板 Presenter。
- `paste_close`、`preview` 和 `remember_checks` 按实际动作归属拆开：
  动作是否隐藏窗口属于宿主/服务，预览目标属于预览服务，勾选持久化属于页面服务。
- `per_mode_query`、共享搜索值、模式胶囊和窗口尺寸继续归 Host Runtime。

旧 `settings.toml` 键在迁移期保留并映射到新角色，避免用户升级后丢失配置。
设置窗根据当前 Presenter 显示相应设置；不兼容的 Presenter 设置不应继续显示为
「有效」。

Presenter 选择存入新增的设置映射：

```toml
[pages.presenters]
apps = "navigate-grid"
clipboard = "clipboard-list"
```

新字段使用 `#[serde(default)]`，旧配置缺失时选择清单默认 Presenter。设置窗
提供切换入口；如果 Presenter 不支持当前 schema 或缺少必需能力，不允许选中。

Presenter 自己的声明式设置使用独立命名空间，例如：

```toml
[[presenter_settings]]
presenter = "default"
key = "density"
type = "select"
default = "comfortable"
```

这些值不能与服务设置同名覆盖。内置页面可以把旧字段作为别名读取，但新代码
只写新归属下的设置。

内置页面和内置 Presenter 的设置进入 `settings.toml`；磁盘插件的服务设置和
Presenter 设置进入该插件的 `plugin_store.db`。两边都使用 manifest 声明作为
唯一 schema，拒绝未声明键。

### 秘密能力

真实翻译插件不能把 API Key 放进普通 `storage`、Page Model、DOM 或日志。

新增 Rust `plugin_secret` 模块，使用 Windows Credential Manager 保存每个插件
的命名秘密：

```text
service = "Lume.Plugin.<plugin-id>"
account = "<setting-key>"
```

命令和 API：

- `plugin_secret_status`：只返回是否已设置。
- `plugin_secret_set`：仅设置窗允许写入或替换。
- `plugin_secret_clear`：仅设置窗允许删除。
- `ctx.secrets.has(key)`：Page Service 查询是否存在。
- `ctx.secrets.get(key)`：Page Service 读取；Presenter 不可调用。

清单中声明 `permissions = ["secrets"]`，并在安装确认中显示。秘密值不进入
插件数据库、设置文件、模型、snapshot、事件或普通日志。`trust_all` 可以放行
能力，但不能把服务角色变成 Presenter 角色。

### 安全模型

新契约继续保持三层防线：

- **Presenter 沙箱**：opaque-origin iframe，无同源权限，无 Tauri IPC。
- **Host Runtime 校验**：只暴露 Presenter 安全子集；模型、资源、动作和意图
  都在宿主侧验证。
- **Rust 能力校验**：Page Service 的每次敏感调用仍按 plugin id 和权限词校验。

令牌应携带角色：

```text
host_token -> { plugin_id, role: "page-service" }
```

Presenter 不获得 `host_token`。逻辑宿主中的服务帧获得 page-service token；
Rust 只在服务角色下允许 `secrets` 等敏感读取。Presenter 的直接 `invoke`
继续被 opaque origin 和现有 IPC 边界挡住。

额外约束：

- 模型 JSON 做深度、节点数、字符串和总大小限制。
- ResourceRef 做 scheme、插件目录和 URL 校验。
- `actionId` 只能来自当前模型。
- Page Event 只传 JSON；超限时丢弃并记录诊断，不得静默截断成错误模型。
- Presenter 崩溃不会终止 Page Service。
- Page Service 崩溃会标记页面错误并走现有逻辑宿主熔断和重载路径。

## 内置页面迁移目标

### 导航页

目标拆分为：

```text
src/page-services/navigate/
  service.ts        栏目、搜索合并、动作、选择
  model.ts          lume.navigate/v1 类型和校验
  native.ts         invoke 适配
  providers.ts      provider / feature / navBars 归一化

src/presenters/navigate-grid/
  index.tsx         当前 Solid 网格和栏目 UI

src/presenters/navigate-list/
  index.html        验收用替代列表 Presenter
```

`lume.navigate/v1` 至少表达：

- 当前查询、加载和错误状态。
- 最近使用、已固定、推荐使用、插件栏目、资源管理器栏目。
- 每个栏目的标题、展开状态、条目和可执行动作。
- 查询结果的普通区和「推荐使用」分隔区。
- 当前选择、主选中 id 和多选 id。
- 条目图标、描述、置灰、固定、最近使用和 provider/feature 动作。

Page Service 消费：

- Rust 的 `search_apps`、文件搜索、pins、recent 和 Explorer 上下文。
- provider、feature、keyword 和 navBars 贡献。
- 拖入文件和前台窗口上下文。

Presenter 不再知道 `pluginStart`、provider 来源、feature 来源或 Tauri 命令名。
它只认识模型中的 entries、sections、actions 和 intents。

导航默认 Solid Presenter 保留当前视觉和交互；替代列表 Presenter 只用于验收
「同一模型可换 UI」。后续可以加入命令面板或终端风格 Presenter，而不改导航
Service。

### 剪贴板页

目标拆分为：

```text
src/page-services/clipboard/
  service.ts        查询、分类、多选、删除、清空、撤销、粘贴动作
  model.ts          lume.clipboard/v1 类型和校验
  native.ts         Rust 命令适配
  window.ts         虚拟窗口和分页

src/presenters/clipboard-list/
  index.tsx         当前 Solid 虚拟列表和状态栏

src/presenters/clipboard-compact/
  index.html        验收用替代 Presenter
```

`lume.clipboard/v1` 至少表达：

- 分类和当前分类。
- 当前查询、总数和 window。
- 条目 id、kind、标题、来源、时间、缩略图/图标、pinned、valid 和多选状态。
- 可用动作：copy、paste、delete、pin、preview、open-link、reveal-file。
- 清空确认、保留 pinned、撤销和记录暂停状态。
- 状态栏需要显示的计数和操作。

Rust 继续拥有采集、去重、合并、历史裁剪、图片缓存和粘贴到前台窗口。Page
Service 负责把命令结果映射成模型和意图，Presenter 不直接调用
`search_clipboard` 或 `paste_clipboard`。

大列表使用 window 模型。Host Runtime 和 Page Service 只向 Presenter 提供当前
可见范围加 overscan，避免 5000 条历史全部跨 iframe 克隆。

### 设置页

设置页本身暂不迁移为 Presenter，但它要同步变化：

- 读取页面和 Presenter 清单。
- 显示当前 Presenter 及其支持的设置。
- 支持切换 Presenter。
- 显示 api 2 的服务权限、Presenter 列表和秘密设置状态。
- `.lupx` 确认弹窗把服务能力和 Presenter 文件分开呈现。
- 继续使用最小 patch 自动保存，避免旧快照覆盖并发轻写。

设置页未来可以复用 Page Model / Presenter 运行时，但不是导航和剪贴板迁移的
前置条件。

### list template 和后台 service

- `template = "list"` 继续作为 `lume.collection/v1` 的宿主 Presenter。
- 现有 provider/navBars 先保留原接口，由导航 Page Service 归一化。
- 现有 `kind = "service"` 继续提供后台生命周期；它不会自动成为 Page Service。
- 如果后台服务希望提供页面模型，应使用 api 2 的 mode service，而不是伪造
  一个不可见 mode。

## 代码影响面

### 前端新增与调整

| 路径 | 责任 |
|---|---|
| `src/page-runtime/contracts.ts` | Page Model、Intent、Event、Presenter 契约 |
| `src/page-runtime/modelStore.ts` | revision、订阅、合并更新 |
| `src/page-runtime/session.ts` | Page Session 和生命周期 |
| `src/page-runtime/intents.ts` | 意图验证和路由 |
| `src/page-runtime/resources.ts` | 图标、缩略图和 URL 解析 |
| `src/page-runtime/presenterHost.ts` | Presenter 加载、ready、错误、重挂载 |
| `src/page-runtime/migrationAdapter.ts` | 迁移期将内置 `ModeInstance` 包装为临时页面，不作为公共兼容层 |
| `src/page-services/navigate/` | 导航逻辑后端 |
| `src/page-services/clipboard/` | 剪贴板逻辑后端 |
| `src/presenters/navigate-grid/` | 当前导航视觉 |
| `src/presenters/clipboard-list/` | 当前剪贴板视觉 |
| `src/presenters/collection-list/` | list template 和通用集合 Presenter |
| `src/plugins/registry.ts` | 发现 Page Service 和多个 Presenter |
| `src/plugins/types.ts` | api 2 类型；`ModeInstance` 仅作迁移期内部类型 |
| `src/plugins/iframeBridge.tsx` | Presenter role、受限 API、模型事件 |
| `src/pluginWindow.tsx` | 独立窗口的 Presenter/titlebar 槽位和状态握手 |
| `src/App.tsx` | 将 page session 适配进现有外壳 |
| `src/settings/` | Presenter 选择、角色设置和秘密设置 |

### Rust 调整

| 路径 | 责任 |
|---|---|
| `src-tauri/src/plugins.rs` | api 2、model、presenters 清单解析与校验 |
| `src-tauri/src/plugin_perm.rs` | 服务/Presenter 角色和 secrets 能力 |
| `src-tauri/src/plugin_secret.rs` | Windows Credential Manager 秘密存取 |
| `src-tauri/src/plugin_logic.rs` | 服务角色 token 和 page 动作通道 |
| `src-tauri/src/settings.rs` | presenter 选择和旧字段兼容 |
| `src-tauri/src/plugin_install.rs` | 安装事实、权限和 Presenter 元数据 |
| `src-tauri/src/lib.rs` | 新命令注册 |
| `src-tauri/capabilities/*.json` | 新 WebView 命令能力声明 |

### 公开文件与示例

- `public/pluginLogicFrame.js`：Page Service 的 `ctx.page`、intents 和 secrets。
- `examples/plugins/plugin-api.d.ts`：api 2 类型声明。
- `examples/plugins/page-runtime-demo/`：两个 Presenter、一个 Service、无网络。
- `examples/plugins/translation-demo/`：本地 HTTP 服务、秘密状态、取消和错误。
- `examples/plugins/list-demo/`：迁移到 collection 模型的示例。
- `examples/plugins/file-search/`：升级为 Page Service + Presenter。
- 外部 `translator`：升级为 Page Service + 两个 Presenter。

### 诊断探针

新增 CDP 可读探针：

- `window.__pageModels`：每个页面最近一次模型元数据、revision 和大小。
- `window.__pageIntents`：最近 intent、处理者、结果和耗时。
- `window.__presenterStates`：ready、错误、布局、modal 和重挂状态。
- `window.__pageResources`：资源解析失败和 scheme 拒绝。
- 逻辑宿主内的 `__logicRpcLog` 继续记录服务 RPC。

探针只保存小环形缓冲，不记录秘密、完整文本或大图片。

## 实施顺序

以下条目按依赖关系排列，不是分期编号，也不代表完成状态。导航和剪贴板可以在
运行时基座稳定后并行；设置控制面和翻译验证可以并行推进。

### 契约与版本门

先只改契约、类型和测试，不切换运行路径：

- 新增 `src/page-runtime/contracts.ts`，定义 Page Model、Intent、Event 和
  Presenter 安全 API。
- 在 `src/plugins/types.ts` 增加 api 2 页面类型，把现有 `ModeInstance`
  标记为迁移期内部类型。
- 在 `plugins.rs` 解析 `model`、`[[presenters]]`、`default_presenter` 和
  `[[presenter_settings]]`。
- 实现只接受 `api = 2` 的版本门和字段组合校验。
- 为 `lume.navigate/v1`、`lume.clipboard/v1` 和 `lume.collection/v1` 写
  TypeScript 类型与 JSON fixture。
- 在 `PLUGIN_API.md`、`PLUGINS.md` 和 `examples/plugins/plugin-api.d.ts` 将
  api 2 作为唯一公开契约。

退出条件：

- `pnpm exec tsc --noEmit` 通过。
- `cargo test` 覆盖清单组合、版本门和重复 Presenter id。
- `file-search`、`translator`、仓库示例和 CDP fixture 的升级清单完整。
- api 1 插件包被拒绝并显示可操作的升级提示。

### 运行时基座

建立页面运行时，不迁移内置页面的数据所有权：

- 实现 `PageSession`、`ModelStore`、`IntentRouter`、`ResourceResolver` 和
  `PresenterHost`。
- 用 `migrationAdapter` 包装尚未迁移的内置页面，保证迁移期间外壳仍能工作。
- 将 Presenter 加载抽象为 `mountPresenter(pageId, presenterId, model)`。
- Host Runtime 统一管理 ready、模型快照、布局报告、modal、错误和重挂。
- 增加诊断探针和模型/IPC 限额。
- 先只注册一个内存 fixture Presenter，避免改变用户可见页面。

退出条件：

- fixture Presenter 能接收模型、发 intent、收到结果。
- Presenter 断开/崩溃后 Page Session 和模型保留。
- 模型校验拒绝函数、循环、超大对象和非法资源。
- 现有启动器、设置窗、分离窗口和插件探针无回归。

### 安全角色与服务页面

把现有逻辑宿主扩展成 Page Service Runtime：

- `public/pluginLogicFrame.js` 增加 `ctx.page`、intent handler 和事件发布。
- `plugin_logic.rs` 的 host token 增加 page-service 角色。
- Host Runtime 只向 Presenter 转发受限的 `lume.page` 和外壳安全动作。
- Presenter 的 http/storage/db/fs/clipboard/secrets/search RPC 明确拒绝。
- 增加 Service/Presenter 角色权限测试和静态 ctx 面对拍。

退出条件：

- 一个 page-service fixture 能通过服务角色读取 `storage` 和声明能力。
- 同一插件的 Presenter 调用敏感能力时明确失败。
- 违约调用不会触发其他插件或整个页面崩溃。

### 翻译服务验收

在迁移内置页之前，先证明插件可以提供自己的后端能力：

- 新增 `examples/plugins/translation-demo/`，使用本地可控 HTTP endpoint。
- 实现多引擎选择、源/目标语言、进行中、取消、错误和结果模型。
- 实现 `getModel`、`onQuery`、`onIntent` 和 `ctx.page.publish`。
- 增加 `ctx.secrets` 与设置窗的「已设置 / 替换 / 清除」流程。
- 两个 Presenter 使用同一翻译模型：左右对照和紧凑单栏。
- 测试 API Key 不出现在模型、事件、日志、CDP 探针或 Presenter 可读设置中。

退出条件：

- 翻译请求只由 Page Service 发起。
- 切换 Presenter 不丢失当前译文和请求取消状态。
- 网络失败、超时和取消都能回到一致模型。
- 秘密读取只对 service 角色成功。

### 导航页迁移

迁移顺序应保持用户可见行为可回退：

- 从 `src/plugins/navigate` 抽取不依赖 DOM 的栏目、搜索和动作到
  `src/page-services/navigate/`。
- 将 `lume.navigate/v1` 作为唯一页面事实；`NavigateView.tsx` 只消费模型和
  dispatch intents。
- provider、feature、keyword 和 navBars 先复用现有接口，在 service 内归一化。
- 迁移 `show_recent`、`show_explorer_bar`、`expand_pinned` 等服务设置。
- 迁移 `entry_size`、`round_app_icons` 等 Presenter 设置。
- 保留现有导航 Solid 视觉作为默认 Presenter。
- 新增一个简单列表 Presenter，只实现模型、选择、展开、激活和动作菜单。
- 用 `migrationAdapter` 保持尚未迁移的内置路径，直到该页面通过全部回归。

退出条件：

- 默认导航 Presenter 通过现有导航、键盘、尺寸、拖拽和视觉验收。
- 列表 Presenter 使用同一导航模型正常工作，无需修改 Page Service。
- 两个 Presenter 之间切换不重新搜索、不丢栏目展开和选择。
- provider/feature 行、Explorer 栏、最近使用和已固定行为一致。

### 剪贴板页迁移

- 将查询、分类、多选、删除、撤销、清空、暂停和粘贴动作移入
  `src/page-services/clipboard/`。
- Rust 命令保持不变，由 service 适配成 `lume.clipboard/v1`。
- Presenter 不再调用 Tauri 命令，也不再拿到整个 `ClipboardStore`。
- 用 window 模型代替整表序列化；滚动请求使用 `viewport.request`。
- 剪贴板 Solid 列表作为默认 Presenter，保留虚拟化、状态栏和清空确认。
- 新增紧凑 Presenter，验证模型可替换。
- 保持停用页面不影响 Rust 后台采集的既有语义。

退出条件：

- 复制、粘贴、多选、删除、撤销、清空、预热、搜索和分类全部通过现有 CDP。
- 大历史不把全部条目传给 Presenter。
- 默认实现与紧凑实现共享同一模型和动作。
- 预览服务只跟随模型选择，不依赖 Presenter DOM。
- 停用 Presenter/页面不会改变采集设置。

### 设置控制面

- 增加 `settings.pages.presenters`，保存页面 id 到 Presenter id 的映射。
- 设置窗显示每个页面的兼容 Presenter 和当前选择。
- 显示 Presenter 自己的声明式设置。
- 把旧导航/剪贴板设置映射到对应角色，并保证旧配置可读。
- 插件页显示 api、Page Service、Presenter 列表、服务权限和秘密设置状态。
- `.lupx` 安装确认分别列出服务权限与 Presenter。

退出条件：

- 切换 Presenter 持久化并在下次启动后恢复。
- 不兼容或缺失的 Presenter 自动回退默认，不出现空白页。
- 旧设置文件升级后值不丢失。
- 损坏或只读设置文件的回滚路径保持现有行为。

### 收口旧页面契约

在前面的验收稳定后：

- 内置导航和剪贴板不再依赖 `ModeInstance.View` 直接持有业务 store。
- `App.tsx` 只通过 Page Session 读取模型、选择、动作、布局和预览信息。
- `file-search` 和外部 `translator` 完成 Page Service / Presenter 升级。
- 仓库内所有 mode 示例和 CDP fixture 迁移到 api 2。
- 删除 `migrationAdapter`、旧 view bridge 和公共 `ModeInstance` 契约。
- 更新 `ARCHITECTURE.md`、`PLUGIN_API.md`、`PLUGINS.md`、`SETTINGS.md`、
  `TESTING.md` 和示例。

退出条件：

- 新内置页面不再 import `ModeInstance` 的 Solid View 字段。
- api 2 插件示例、分离窗口、provider、navBars 和 list template 正常运行。
- api 1 插件包被明确拒绝，不存在隐式兼容路径。
- 文档中的当前契约与源码一致。

## 升级与回退

### 插件升级

- api 2 使用新的 Presenter bridge，不复用旧 view 的敏感 API 面。
- `file-search` 和外部 `translator` 在正式切换前升级到 api 2。
- 仓库内 mode 示例和 CDP fixture 同步迁移，避免继续依赖旧页面契约。
- api 1 插件包在加载和 `.lupx` inspect 阶段被明确拒绝，并提示升级。
- `template = "list"` 作为 api 2 的宿主 Presenter 快捷形式保留，不再承接旧
  `ModeInstance`。

### 页面兼容

- `apps` 和 `clipboard` 的 id 不变，`last_page` 和 `last_page_kind` 不迁移。
- 默认 Presenter 保持现有视觉和 CSS 契约。
- `settings.toml` 新字段使用 serde default；整表缺失时不能因为派生默认值关闭
  旧功能。
- 新设置写回使用最小 patch，避免设置窗与插件启停、窗口几何等轻写互相覆盖。

### 运行时回退

- `migrationAdapter` 只用于迁移期尚未切换的内置页面，不是公共 API 或发行版
  兼容承诺；所有页面迁移完成后删除。
- 新 Presenter 加载失败时先回退同页面默认 Presenter，再回退通用错误页。
- Page Service 失败时保留页面错误模型和重试动作，不静默显示空列表。
- 模型不兼容时不允许强行渲染，必须拒绝并给出本地化错误。

## 验证矩阵

### 编译与单元测试

- `pnpm exec tsc --noEmit`
- `pnpm run build`
- `cd src-tauri && cargo check`
- `cd src-tauri && cargo test`
- `node scripts/check_i18n.mjs`

Rust 单测需要覆盖：

- api 2 清单解析、api 1 明确拒绝和版本错误提示。
- Presenter 唯一性、默认回退和 schema 兼容声明。
- service 角色 token 与 presenter 拒绝路径。
- secrets 的写入、替换、清除和 service-only 读取。
- 新旧设置字段的 default、round-trip 和 patch 合并。
- `.lupx` 安装事实中的 service/presenter 权限拆解。

前端单测或纯函数测试需要覆盖：

- 模型 revision 单调性。
- 意图目标/动作白名单。
- 非法资源 scheme。
- collection window 边界。
- Presenter 兼容选择和回退。

### CDP 与集成测试

新增脚本建议：

- `scripts/cdp_page_runtime_verify.mjs`
  - 同一 fixture 模型挂载两个 Presenter。
  - 切换 Presenter 后模型和选择保持。
  - intent 结果、错误、modal、布局和重挂。
- `scripts/cdp_page_security_verify.mjs`
  - Presenter 访问 `http`、`db`、`clipboard`、`fs`、`secrets` 被拒绝。
  - service 声明能力成功。
  - 模型和事件中的超大对象被拒。
- `scripts/cdp_translation_service_verify.mjs`
  - 本地 echo/translation endpoint。
  - 两个引擎、取消、超时、错误、秘密状态。
  - Presenter 只能看到译文模型。
- `scripts/cdp_navigate_presenter_verify.mjs`
  - 默认 Solid 网格与替代列表使用同一模型。
  - 栏目展开、最近/固定、provider/feature、Explorer、拖拽和键盘。
- `scripts/cdp_clipboard_presenter_verify.mjs`
  - 大历史 window、多选、粘贴、删除、撤销、清空和预览。

必须同时回归：

- `cdp_plugin_verify.mjs`
- `cdp_p2b_verify.mjs`
- `cdp_sandbox_verify.mjs`
- `cdp_circuit_verify.mjs`
- `cdp_plugin_state_verify.mjs`
- `cdp_plugin_window_verify.mjs`
- `cdp_plugin_theme_verify.mjs`
- `cdp_clipboard_smoke.mjs`
- `cdp_clipboard_p2.mjs`
- `cdp_settings_smoke.mjs`
- `cdp_settings_skin_verify.mjs`
- `cdp_settings_accent_verify.mjs`
- `cdp_visual_audit_verify.mjs`
- `cdp_mode_query_verify.mjs`
- `cdp_idle_reset_verify.mjs`

### 性能与安全边界

需要设定并记录基线：

- 热键呼出仍以 `< 50ms` 为目标。
- 搜索触发、模型组装和 Presenter 首帧不因多一次序列化出现肉眼可见延迟。
- 高频模型更新按动画帧合并。
- Presenter 模型上限、事件大小、item window 和资源解析都有硬上限。
- 大剪贴板历史只传输视口窗口。
- 关闭 Presenter 或切换 Presenter 不触发重新查询。
- 服务崩溃、Presenter 崩溃和模型超限都有可见错误和恢复路径。

### 手工验证

- 真实文件拖入、剪贴板图片、粘贴到前台窗口。
- 独立窗口分离、标题栏、焦点返回和状态回流。
- 200% DPI 下的布局、窗口尺寸和图标资源。
- 浅色/深色主题切换、插件自带颜色模式和页面画布拼接。
- 设置窗自动保存、撤销、只读回滚和 Presenter 切换。
- API Key 在设置窗中只能看到已设置状态，不能从 Presenter 或日志读取。

## 风险与缓解

| 风险 | 表现 | 缓解 |
|---|---|---|
| 模型设计过度 | 每种页面都被迫适配万能 schema | 只稳定内置 schema，插件可用自定义 schema |
| 模型过大 | 剪贴板/搜索结果跨 iframe 变慢 | window 模型、资源引用、1 MiB 上限、帧内合并 |
| 键盘/焦点回归 | 替代 Presenter 无法用方向键或 Esc | selection 进入模型，标准 intent，宿主 fallback |
| 设置错位 | 换 Presenter 后选项失效或互相覆盖 | 服务/Presenter/外壳设置分层，旧键映射 |
| 权限扩大 | Presenter 直接联网或读密钥 | Presenter 安全 API 白名单，Rust 角色 token |
| 一次性切换风险 | api 1 包在升级后无法加载 | 发布前完成 `file-search`、`translator` 和全部 fixture 升级，明确拒绝提示 |
| 服务崩溃拖垮页面 | 翻译请求卡死或页面空白 | 逻辑宿主隔离、超时、熔断、错误模型、重挂 |
| 迁移战线过长 | 新旧两套路径长期并存 | 每页先采用 adapter，再完成退出条件，定期收口 |
| 秘密泄漏 | Key 出现在模型/日志/CDP | Credential Manager、service-only API、探针脱敏 |
| Presenter 兼容欺骗 | 声称支持 schema 但实际渲染失败 | ready/live 检查、失败回退、清单和 runtime 双重校验 |

## 验收判定

以下条件同时成立时，页面模型 / Presenter 运行时才算完成：

- 导航页和剪贴板页使用同一套 Page Session、模型和意图协议。
- 导航页能用两个不同 Presenter 渲染同一模型，且无需改 Page Service。
- 剪贴板页能用两个不同 Presenter 渲染同一窗口模型，且无需改 Rust 命令。
- 翻译 fixture 的网络请求、缓存、取消和 API Key 完全留在 Page Service。
- Presenter 无法直接访问网络、数据库、文件、剪贴板或秘密。
- 切换 Presenter 不重置 Page Service、查询结果和选择。
- 分离窗口、titlebar 槽位、回流、主题、懒加载、插页尺寸和键盘契约保持。
- `file-search` 和 `translator` 已完成 api 2 升级。
- api 1 插件包被明确拒绝，不存在隐式兼容路径。
- provider、navBars、list template 和 detached window 没有回归。
- 设置窗可以持久化 Presenter 选择，并保留旧设置值。
- 编译、Rust 单测、CDP 回归和手工清单全部通过。
