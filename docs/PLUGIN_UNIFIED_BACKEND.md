# 统一插件后端与贡献模型

本文定义 Lume 插件系统的下一次破坏性协议：每个插件只有一个后端实例，贡献
通过清单声明并由宿主按贡献类型注册，宿主能力通过独立授权台账控制，页面仍由
Page Service 与隔离的 Presenter 组成。

本文是重构设计与目标契约，不描述当前 api 2 行为。落地期间以本文、实现代码和
`docs/PLUGIN_API.md` 的迁移结果为准；当前历史设计见
[History/PAGE_MODEL_PRESENTER.md](History/PAGE_MODEL_PRESENTER.md)。

## 结论

目标模型由四个互相独立的维度组成：

```text
Plugin Backend      每个插件一个入口、一个沙箱、一个令牌、一份状态
Contribution        搜索、页面、导航栏目、动作等可组合输出
Grant               贡献准入、宿主资源访问和宿主事件订阅
Presenter           页面模型之上的受限渲染层
```

`kind` 不再决定逻辑身份、贡献类型、权限或 UI 形态。一个插件可以同时是搜索源、
多个页面的拥有者、导航栏目提供者和动作处理器。

推荐的目标声明形状：

```toml
api = 3
id = "translation-demo"
entry = "backend.js"

capabilities = [
  "contribute.search",
  "contribute.page",
  "contribute.action",
  "event.query",
  "host.network",
  "host.secrets",
]
```

贡献定义与授权分开：

- `capabilities` 是宿主承认的准入和资源授权；
- `[[search]]`、`[[pages]]`、`[[nav]]`、`[[actions]]` 是贡献定义；
- 有贡献定义但缺少对应 `contribute.*` 授权时清单失败；
- 有 `contribute.*` 授权但缺少贡献定义时清单失败；
- `host.*` 只控制后端能访问什么，不授予页面或搜索结果贡献；
- `event.*` 只控制后端能收到哪些宿主事件。

这样既能表达“有该权限就可以贡献”，又不会把“读取剪贴板”和“贡献一个页面”
显示成同一种风险。

这里的“权限”不等于只有一个数组。贡献准入、事件订阅和宿主资源访问都使用
`capabilities` 作为统一授权事实，但贡献本身仍需要独立的声明表：

```text
capabilities: contribute.page     “允许提供页面”
[[pages]]                         “这里就是页面”
capabilities: host.network        “允许联网”
```

如果只保留 `capabilities` 而不保留 `[[pages]]`，宿主无法知道页面 id、model、
Presenter、窗口属性和路由目标；如果只保留 `[[pages]]` 而不保留授权，用户和
安装确认又无法看到插件要扩展哪类能力。两部分必须同时存在，并通过稳定键交叉
校验。

## 为什么替换当前模型

当前 api 2 让一个 `kind` 同时承担四件事：

1. 决定入口逻辑的角色和 Page Service 身份；
2. 决定只能选择 provider、mode 或 service 之一；
3. 间接影响宿主能力的使用方式；
4. 决定是否存在页面、Presenter 或页面模板。

这种耦合造成三个结构性问题。

### 能力已经天然重合

provider、service、Page Service 和 list template 都运行在逻辑宿主中，共用
`ctx.storage`、`ctx.db`、`ctx.settings`、`ctx.http`、`ctx.clipboard`、文件、
搜索、窗口和通知等宿主能力。将它们拆成不同 kind 没有形成能力隔离，只形成了
不同的注册入口。

### 横切贡献已经突破单一 kind

`navBars`、声明式设置、`[[features]]` 和 `[[secrets]]` 都能跨 kind 使用。继续
把贡献挂在 kind 上，会让每一种新增横切能力都追加条件分支。

### 角色与贡献没有一一对应

当前 `service` role 实际表示“完整 Page Service mode”，而磁盘插件
`kind = "service"` 使用的是 `logic` role。名称相同、权限不同，解释成本高，也
容易让实现者把“服务生命周期”和“页面后端”混为一谈。

目标模型采用“一个后端、多份贡献”的模型。它保留当前真正有效的安全边界：
后端令牌、Page Model 校验、Presenter 沙箱和 Rust 侧权限复核；同时删除由 kind
隐式推导能力的分支。

## 目标与非目标

### 目标

- 每个插件只创建一个后端入口、一个逻辑帧、一个令牌和一份模块缓存。
- 同一插件可以同时贡献搜索源、多个页面、导航栏目、动作和设置。
- 所有贡献拥有稳定的贡献键，可独立启停和诊断。
- 宿主能力按组投影，未授权能力不出现在后端 `ctx`。
- 贡献准入与宿主资源授权使用同一个台账，但保留不同命名空间。
- 一个插件的所有页面共享同一后端状态，页面切换不重建后端。
- Presenter 继续只接收 Page Model 和受限制的 Presenter API。
- 清单校验、安装确认、设置页、运行时检查和测试共用同一契约。

### 非目标

- 不把 Presenter 合并进后端；Presenter 永远拿不到后端令牌。
- 不提供 Node.js、原生模块或无沙箱 preload。
- 不让插件直接访问 SQLite 或其他插件的私有数据。
- 不把“全部授权”扩散为默认行为。
- 不保留 api 2 的加载兼容层。
- 不改变 Page Model、Page Intent 和 Presenter 的隔离原则。
- 不把所有插件能力做成单个万能 `ctx` 对象；未授权组不投影。

## 术语

| 术语 | 含义 |
|---|---|
| Plugin Package | `<base>/plugins/<目录>/` 下的清单、入口、页面和资源 |
| Plugin Backend | 清单 `entry` 导出的唯一后端工厂及其实例 |
| Contribution | 后端向宿主注册的一种输出，例如搜索源、页面、栏目、动作 |
| Contribution Key | 全局稳定键，例如 `page:translation-demo/translator` |
| Grant | 清单声明并由宿主校验的准入或访问词 |
| Capability | `ctx` 中可调用的宿主能力组，由 Grant 投影 |
| Page Instance | 一个页面贡献的运行时实例，拥有独立 Page Session |
| Presenter | Page Instance 的受限 HTML 渲染层 |
| Host Runtime | 注册、路由、权限、窗口、设置和生命周期的宿主部分 |

## 清单 api 3

api 3 只接受一份统一清单。旧字段 `kind`、`page_runtime`、顶层 `model`、
顶层 `presenters`、`template`、顶层 `permissions`、`keywords` 和 `features`
不再属于公开契约；出现旧字段时清单门直接拒绝并给出迁移提示。

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `api` | integer | 是 | 必须为 `3` |
| `id` | string | 是 | 1–64 字符，ASCII 字母、数字、`-`、`_` |
| `name` | string | 否 | 设置页显示名 |
| `version` | string | 否 | 包版本 |
| `description` | string | 否 | 设置页和安装确认说明 |
| `entry` | string | 是 | 唯一后端入口；目录入口解析为 `index.js` |
| `capabilities` | string[] | 是 | 贡献准入、宿主资源和事件订阅的统一台账 |
| `icon` | string | 否 | 插件目录内相对路径 |
| `icon_light` | string | 否 | 浅色表面图标 |
| `icon_dark` | string | 否 | 深色表面图标 |
| `development` | bool | 否 | 开发模式下刷新即重载 |
| `keep_session` | bool | 否 | 尚未配置页面覆盖时的会话保留默认值 |

页面窗口尺寸、隐藏状态、关键词、是否可分离等属于页面贡献，不再属于插件顶层。
`[[settings]]` 和 `[[secrets]]` 属于插件后端。Presenter 设置隶属于具体页面。

### 能力命名空间

`capabilities` 使用三个命名空间。未知词、重复词和超过预算的清单都被拒绝。

#### `contribute.*` — 贡献准入

| 词 | 允许的声明 |
|---|---|
| `contribute.search` | 一个或多个 `[[search]]` |
| `contribute.page` | 一个或多个 `[[pages]]` |
| `contribute.nav` | 一个或多个 `[[nav]]` |
| `contribute.action` | 一个或多个 `[[actions]]` |

#### `event.*` — 宿主事件订阅

| 词 | 允许后端的根钩子 | 语义 |
|---|---|---|
| `event.visibility` | `onShow` / `onHide` | 启动器显隐 |
| `event.query` | `onQuery` | 导航页非空输入 |
| `event.subInput` | `onSubInput` | 本插件接管搜索框后的输入 |
| `event.files` | `onFilesDropped` | 启动器级文件拖入 |
| `event.settings` | `onSettings` | 本插件声明式设置变更 |

页面内的显隐、查询、Intent、进入载荷和文件拖入属于页面贡献自身，不需要额外的
根事件授权。页面贡献只会在该页面活动时收到这些事件。

页面事件的授权边界是“`contribute.page` + 页面键 + 页面活动”。它不会因为页面
拥有 `host.clipboard` 等资源授权而扩大，也不会因为缺少 `event.query` 而停止；
`event.query` 只管根对象上的导航页输入监听。实现必须把页面事件和根事件放在
不同路由表中，避免页面输入被重复投递给根 handler。

#### `host.*` — 宿主资源与动作

| 词 | 投影到后端 `ctx` | 说明 |
|---|---|---|
| `host.network` | `http` | 宿主 HTTP，含 SSRF 与重定向防护 |
| `host.clipboard` | `clipboard` | 文本、图片、文件和粘贴 |
| `host.notify` | `app.notify` | 系统通知 |
| `host.dialog` | `dialog` | 文件与目录对话框 |
| `host.screen` | `screen` | 光标与显示器 |
| `host.search.files` | `search` | 全盘文件搜索与就绪状态 |
| `host.fs.read` | `fs.read*` | 读取任意路径、缩略图、图标和视频海报 |
| `host.fs.write` | `fs.writeFile` | 写入任意绝对路径 |
| `host.open` | `app.openPath` / `app.revealPath` | 打开或定位任意路径与 URL |
| `host.trash` | `app.trash` | 回收站删除 |
| `host.window` | `app.foreground` | 前台窗口上下文 |
| `host.preview` | `preview` | 卫星预览显示与关闭 |
| `host.secrets` | `secrets` | 读取声明的 Windows Credential Manager 槽位 |

以下能力属于插件自己的局部范围，自动授权，不需要用户同意：

| 局部能力 | 范围 |
|---|---|
| `local.settings` | 清单声明的 `[[settings]]` |
| `local.storage` | 以插件 id 隔离的 KV |
| `local.db` | 以插件 id 隔离的文档库 |
| `local.files` | 插件目录下的私有 `files/` |
| `local.theme` | 本插件的颜色偏好 |
| `ui.*` | toast、placeholder、resize、drag、detach、setQuery、hide 等宿主 UI 动作 |

`local.*` 和 `ui.*` 不需要写进 `capabilities`；它们不能越过插件 id 或改写别的
插件表面。`host.open` 是显式授权，因为打开路径和 URL 已经超出插件私有范围。

### `[[search]]` 贡献

```toml
[[search]]
id = "web"
label = "Web results"
icon = "assets/web.svg"
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `id` | string | 是 | 插件内唯一，稳定不变 |
| `label` | string | 否 | 设置页和诊断显示名 |
| `icon` | string | 否 | 搜索结果默认图标 |

同一个插件可声明最多 8 个搜索源。每个搜索源独立拥有结果预算和失败熔断状态。

### `[[pages]]` 贡献

```toml
[[pages]]
id = "translator"
label = "Translation"
keywords = ["翻译", "translate"]
model = "translator.translation/v1"
default_presenter = "default"
height = 560
detachable = true
hidden = false
keep_session = true

[[pages.presenters]]
id = "default"
name = "Detailed"
entry = "views/default.html"
models = ["translator.translation/v1"]

[[pages.presenters]]
id = "compact"
name = "Compact"
entry = "views/compact.html"
models = ["translator.translation/v1"]
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `id` | string | 是 | 插件内唯一；运行时页面键为 `<plugin-id>/<id>` |
| `label` | string | 否 | 模式条和设置页显示名 |
| `keywords` | string[] | 否 | 全局进入关键词 |
| `model` | string | 是 | Page Model schema |
| `default_presenter` | string | 是 | 默认 Presenter id |
| `keywords_pinyin` | 内部字段 | 否 | Rust 扫描时计算，不由 TOML 提供 |
| `height` | integer | 否 | 固定高度；省略使用全局窗口高度 |
| `detachable` | bool | 否 | 是否允许分离到独立窗口 |
| `detach_button` | bool | 否 | 是否显示宿主分离按钮，默认 `true` |
| `hidden` | bool | 否 | 是否只通过搜索结果进入 |
| `keep_session` | bool | 否 | 页面会话保留默认值 |
| `[[pages.presenters]]` | table[] | 是 | 至少一个 Presenter，最多 16 个 |
| `[[pages.presenter_settings]]` | table[] | 否 | Presenter 专属声明式设置 |

Presenter 字段保持当前 Page Runtime 语义：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `id` | string | 是 | 页面内唯一 |
| `name` | string | 否 | 设置页显示名 |
| `entry` | string | 是 | 页面目录内 HTML |
| `titlebar` | string | 否 | 独立窗口标题栏 Presenter |
| `models` | string[] | 否 | 必须包含页面 `model` |

同一个插件最多 16 个页面。多个页面实例共享同一个后端实例，但各自拥有独立
Page Session、模型、页面查询、Presenter 状态、窗口状态和会话快照。

### 集合页快捷贡献

当前 `template = "list"` 不再作为 mode 的模板字段，而是页面贡献的显式驱动：

```toml
[[pages]]
id = "quick-list"
label = "清单"
driver = "collection"
model = "lume.collection/v1"
keywords = ["清单"]
```

`driver = "collection"` 的页面使用宿主内置 collection adapter 和
`collection-list` Presenter。插件不提供 Presenter HTML；后端页面对象提供
`search(q)`、`onActivate(item)` 和可选 `onShow` / `onHide` / `onQuery`。

`driver` 的允许值：

- `page`：Page Service + 一个或多个自定义 Presenter；
- `collection`：宿主内置 collection adapter + 内置 Presenter。

`driver` 描述页面贡献的渲染方式，不是插件类型，也不能替代 `contribute.page`。

### `[[nav]]` 贡献

```toml
[[nav]]
id = "links"
title = "快速链接"
```

后端返回该栏目的 `NavBarContribution`。`id` 在插件内唯一，宿主最终键为
`<plugin-id>/<nav-id>`。栏目条目仍走统一的启动、定位和共享右键菜单管线。

### `[[actions]]` 贡献

`[[actions]]` 取代顶层 `[[features]]`。动作是导航页的声明式入口，可路由到页面
或交给后端处理。

```toml
[[actions]]
code = "uppercase"
label = "文本工具：转为大写"
match = "query"
over = true
max_length = 200
target = "backend"

[[actions]]
code = "open-in-translator"
label = "翻译这段文本"
match = "query"
regex = '^[\p{Han}]+$'
target = "page:translator"

[[actions]]
code = "handle-files"
label = "处理文件"
match = "files"
extensions = ["md", "txt"]
target = "page:translator"
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---:|---|
| `code` | string | 是 | 投递给后端的动作码 |
| `label` | string | 否 | 搜索行文案 |
| `match` | string | 是 | `query`、`files`、`image`、`window` |
| `target` | string | 是 | `backend` 或 `page:<page-id>` |
| `regex` / `over` | string / bool | 条件 | `match = "query"` 的匹配方式 |
| `min_length` / `max_length` | integer | 否 | 文本长度或文件数边界 |
| `extensions` / `file_type` | string[] / string | 否 | 文件规则 |
| `process` / `class` / `title` | string[] | 否 | 窗口规则 |
| `icon*` | string | 否 | 行图标 |

`target = "backend"` 调用根 `onAction(info)`。`target = "page:<id>"` 先切换到目标
页面，再调用该页面的 `onEnter(info)`。不存在目标页面或 handler 时，清单或
运行时贡献校验失败，并保留其他贡献。

### `[[settings]]` 与 `[[secrets]]`

`[[settings]]` 保持当前声明式设置模型，统一归属于插件后端。根 `onSettings`
只在声明 `event.settings` 时收到变更；首次加载仍可调用 `ctx.settings.all()`。

`[[secrets]]` 属于插件后端。每个槽位必须同时在 `capabilities` 声明
`host.secrets`；Presenter 永远不能读取 secret。设置窗只写不读，后端令牌才能
读取明文。

### Presenter 设置

```toml
[[pages.presenter_settings]]
presenter = "compact"
key = "density"
label = "Density"
type = "select"
default = "normal"

[[pages.presenter_settings.options]]
value = "normal"
label = "Normal"
```

设置键按页面实例和 Presenter 双重隔离。后端可以通过 `ctx.settings.all()` 读取
插件级设置，但不读取 Presenter 设置明文；Presenter 设置只由 Host Runtime 推给
对应 Presenter。

## 完整清单示例

```toml
api = 3
id = "translation-demo"
name = "Translation Demo"
version = "2.0.0"
entry = "backend.js"
description = "Unified search, page and action example."
icon = "assets/icon.svg"

capabilities = [
  "contribute.search",
  "contribute.page",
  "contribute.action",
  "event.query",
  "event.visibility",
  "host.network",
  "host.secrets",
]

[[search]]
id = "dict"
label = "Dictionary"

[[pages]]
id = "translator"
label = "Translation"
keywords = ["翻译", "translate"]
model = "translator.translation/v1"
default_presenter = "default"
height = 560
detachable = true

[[pages.presenters]]
id = "default"
name = "Detailed"
entry = "views/default.html"
models = ["translator.translation/v1"]

[[pages.presenters]]
id = "compact"
name = "Compact"
entry = "views/compact.html"
models = ["translator.translation/v1"]

[[pages.presenter_settings]]
presenter = "compact"
key = "density"
label = "Density"
type = "select"
default = "normal"

[[actions]]
code = "translate"
label = "翻译这段文本"
match = "query"
over = true
target = "page:translator"

[[settings]]
key = "engine"
label = "Engine"
type = "select"
default = "local"

[[settings.options]]
value = "local"
label = "Local"

[[settings.options]]
value = "remote"
label = "Remote"

[[secrets]]
key = "api_key"
label = "API Key"
```
## 后端 ABI

### 唯一入口

每个插件只有一份可执行入口：

```js
export default function create(ctx) {
  return {
    search: {
      dict: async (query) => [],
    },
    pages: {
      translator: {
        async getModel() { /* ... */ },
        async onIntent(intent) { /* ... */ },
      },
      "quick-list": {
        async search(query) { return []; },
        async onActivate(item) {},
      },
    },
    nav: {
      links: async () => [],
    },
    async onAction(info) {},
    async onShow() {},
    async onSettings(values) {},
  };
}
```

工厂在插件自己的 opaque-origin 沙箱帧中执行一次。`ctx` 是该插件唯一的宿主
能力面，不再按 provider、service 或 Page Service 生成不同连接方式。

入口可以是单文件或多文件目录。目录入口仍解析到 `index.js`，相对导入仍由宿主
改写为帧内 blob URL，并禁止裸包名、目录越界和运行时下载。

### 根对象

| 成员 | 形状 | 所需声明 | 说明 |
|---|---|---|---|
| `search` | `Record<search-id, SearchBackend>` | `contribute.search` | 搜索源映射 |
| `pages` | `Record<page-id, PageBackend>` | `contribute.page` | 页面后端映射 |
| `nav` | `Record<nav-id, NavBackend>` | `contribute.nav` | 导航栏目映射 |
| `onAction` | `(info) => void \| Promise<void>` | `contribute.action` | 无页面动作 |
| `onShow` / `onHide` | `() => void \| Promise<void>` | `event.visibility` | 启动器级显隐 |
| `onQuery` | `(q) => void \| Promise<void>` | `event.query` | 导航页非空输入 |
| `onSubInput` | `(text) => void \| Promise<void>` | `event.subInput` | 本插件接管搜索框后的输入 |
| `onFilesDropped` | `(paths) => void \| Promise<void>` | `event.files` | 启动器级文件拖入 |
| `onSettings` | `(values) => void \| Promise<void>` | `event.settings` | 设置变更 |

根 `onShow` / `onHide` 描述插件后端本身的显隐，不替代页面贡献的
`pages[id].onShow` / `onHide`。调用顺序固定为：

```text
启动器级 onShow
  → 活动页面的 pages[id].onShow

启动器级 onHide
  → 活动页面的 pages[id].onHide
```

重复收到同一显隐或查询事件必须幂等。页面处于分离窗口时，页面自身以窗口显隐
为准；根事件仍跟随启动器，避免把“插件后端常驻”误解为“独立窗口也控制了根事件”。

### 搜索后端

```ts
interface SearchBackend {
  search(query: string): Promise<ProviderResult[]> | ProviderResult[];
  onEnter?(item: ProviderResult): void | Promise<void>;
  select?(item: ProviderResult): Promise<ProviderResult[]> | ProviderResult[];
  filter?(item: ProviderResult, query: string): Promise<ProviderResult[]> | ProviderResult[];
}
```

搜索后端只返回 Navigate 可用的 `ProviderResult`。声明式动作不会自动分发到所有
搜索后端；需要无页面处理的动作由根 `onAction` 接收。

每个搜索源独立拥有：

- 6 秒超时；
- 64 行 / 192 KiB 结果预算；
- 查询 generation；
- 失败计数与熔断状态；
- 图标与路径解析上下文。

一个搜索源失败不影响同一插件的页面、栏目或动作。

### Page Backend

`driver = "page"` 的页面后端保持当前 Page Service 语义：

```ts
interface PageBackend {
  getModel(): PageModel | Promise<PageModel>;
  onIntent?(intent: PageIntent): IntentResult | Promise<IntentResult>;
  onQuery?(query: string): void | Promise<void>;
  onSubInput?(text: string): void | Promise<void>;
  onShow?(): void | Promise<void>;
  onHide?(): void | Promise<void>;
  onEnter?(info: ActionInfo): void | Promise<void>;
  onFilesDropped?(paths: string[]): void | Promise<void>;
  onSettings?(values: Record<string, unknown>): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
```

`driver = "collection"` 的页面后端是宿主集合适配器契约：

```ts
interface CollectionPageBackend {
  search(query: string): Promise<ProviderResult[]> | ProviderResult[];
  onActivate?(item: ProviderResult): void | Promise<void>;
  onShow?(): void | Promise<void>;
  onHide?(): void | Promise<void>;
  onQuery?(query: string): void | Promise<void>;
  onSubInput?(text: string): void | Promise<void>;
  onEnter?(info: ActionInfo): void | Promise<void>;
  onFilesDropped?(paths: string[]): void | Promise<void>;
  onSettings?(values: Record<string, unknown>): void | Promise<void>;
  dispose?(): void | Promise<void>;
}
```

集合页没有 `getModel` / `onIntent`。宿主构建 `lume.collection/v1` 模型和内置
Presenter 交互。它不具备自定义 Presenter，也不能调用 `ctx.page.publish`。

### Page 上下文

页面后端共享插件 `ctx`，额外收到页面坐标：

```ts
interface PageContext {
  pageId: string;          // 清单内的局部 id
  pageKey: string;         // <plugin-id>/<page-id>
  model: string;
  driver: "page" | "collection";
  page: {
    publish(model: PageModel): Promise<void>;
    emit(event: PageEvent): Promise<void>;
    setError(error: PageError): Promise<void>;
    clearError(): Promise<void>;
  };
}
```

`ctx.page` 是按页面实例投影的，不是根 `ctx` 上可直接伪造的共享发布器。宿主必须
把发布调用绑定到当前页面键、页面 schema 和页面后端令牌。发布到非当前页面、
伪造 schema、重复/倒退 revision 或超过 1 MiB 都失败。

### 导航后端

```ts
interface NavBackend {
  (): Promise<NavBarContribution[]> | NavBarContribution[];
}
```

宿主把返回栏目的 id 加上 `<plugin-id>/` 命名空间，保留当前单插件 8 栏、
120 项、192 KiB 和整页总预算。`nav` 中的每个 key 必须存在对应后端函数。

### 动作路由

```ts
interface ActionInfo {
  code: string;
  type: "regex" | "over" | "redirect" | "files" | "img" | "window";
  payload: string;
  paths?: string[];
  window?: ForegroundInfo;
}
```

路由规则：

- `target = "backend"` → 根 `onAction(info)`；
- `target = "page:<id>"` → 切换到对应页面后调用该页面的 `onEnter(info)`；
- 页面已被禁用或不可用时保留后端和其他贡献，该动作快速失败并记录诊断；
- 没有 handler 的动作在清单阶段拒绝，避免运行时静默无效。

### 返回对象与声明校验

后端返回对象的形状必须与清单贡献一一对应：

```text
每个 [[search]].id ↔ backend.search[id]
每个 [[pages]].id  ↔ backend.pages[id]
每个 [[nav]].id    ↔ backend.nav[id]
```

缺失或多余项只使对应贡献失败，沿用当前失败隔离原则。但以下结构错误属于整个
插件不可加载：

- 没有返回对象或返回非对象；
- 清单声明了贡献但没有对应容器；
- 两个贡献使用同一局部 id；
- Page Presenter 与 model 不兼容；
- 清单中存在 `target = "backend"` 的动作，但根对象没有 `onAction`；
- 声明 `event.*` 但没有对应根 handler；
- 清单声明旧字段或未知 capability。

### 后端模块状态

所有贡献共享同一模块实例和内存状态。插件可以用一份连接池、缓存和取消控制器
服务搜索、页面和动作。贡献失败不得销毁整个后端；只有后端工厂失败或逻辑帧崩溃
才进入插件级故障状态。

后端重载会：

1. 卸载全部贡献代理；
2. 撤销旧令牌；
3. 清理旧帧、pending RPC 和事件订阅；
4. 关闭受该插件拥有的分离窗口；
5. 丢弃页面会话帧；
6. 从磁盘重新加载清单和入口。

## Host Runtime 授权

### 单令牌，多授权

每个插件只获得一个随机的后端令牌：

```text
host_token → plugin_id
```

令牌只证明调用者身份。它不再携带 `service` / `logic` 角色来决定贡献能力。
每次敏感调用同时检查：

```text
插件身份
+ 目标贡献或页面键
+ capabilities 台账
+ 当前启停状态
+ 参数与预算
```

这比把所有插件统一成当前 `service` role 更安全，因为“统一身份”不会自动获得
Page Model 或 secret 权利。

### 请求上下文

Rust 侧一次插件调用的有效上下文至少包含：

```ts
interface CallerContext {
  pluginId: string;
  token: string;
  contributionKey?: string;
  pageKey?: string;
  enabled: boolean;
}
```

- `contributionKey` 由 supervisor 绑定，不由帧内自报；
- `pageKey` 只能来自该 Contributions Registry 中登记的页面；
- 未声明贡献键的宿主能力调用允许，但仍受 `host.*` 授权；
- 页面模型发布必须携带有效页面键和绑定 schema；
- Presenter 调用不经过后端令牌。

### `ctx` 投影

不向未授权插件提供“调用时才报错”的完整对象，而是由宿主只投影已授权组：

```text
capabilities: host.network
  ctx.http exists

capabilities: 不含 host.network
  ctx.http 不存在
```

投影规则：

- `local.*` 组始终存在，但由插件 id 严格隔离；
- `ui.*` 组始终存在，但只作用于本插件表面；
- `host.*` 组只在声明后存在；
- `event.*` 不投影 API，而是决定根事件订阅；
- 未声明的组必须在前端守卫和 Rust 侧同时拒绝，防止绕过投影。

Rust 侧仍是最终边界。即使帧内伪造一个 `ctx.http` 或直接发 RPC，命令侧也会按
令牌、plugin id 和 capability 再次拒绝。

### 贡献注册

Host Runtime 在加载后端前先建立“声明贡献表”，加载完成后再建立“实例贡献表”：

```text
Manifest Registry (Rust)
  → Contribution Declarations (shared typed model)
  → Backend load
  → Contribution Instances (frontend)
  → Runtime authorization (Rust + frontend)
```

贡献键格式固定：

```text
search:<plugin-id>/<search-id>
page:<plugin-id>/<page-id>
nav:<plugin-id>/<nav-id>
action:<plugin-id>/<action-code>
```

贡献键必须在设置、日志、诊断和测试中使用同一格式。页面会话、Presenter 设置、
分离窗口和 `last_page` 继续用页面键，而不是裸插件 id。

### 页面模型授权

`publish` 需要满足：

```text
token -> plugin_id
page_key 属于 plugin_id
page declaration.driver == page
model.schema == page declaration.model
model.runtime == lume.page/v1
revision 大于该页面当前 revision
序列化后 <= 1 MiB
```

Contributions Registry 只持有页面键、schema 和所有者，不能从 Presenter 侧修改。
集合页不接受自定义模型发布。

### Secret 授权

读取 secret 需要：

```text
capabilities 包含 host.secrets
+ key 在 [[secrets]] 声明
+ 调用者是后端令牌
+ 不是 Presenter
+ 插件当前启用
```

Presenter 没有后端令牌，也没有 `secrets` 投影。Set/Clear 仍只允许设置窗调用，
同样校验声明槽位和插件状态。

### Host Runtime 不变量

- 插件不能伪造别的 plugin id、contribution key 或 page key。
- Presenter 永远拿不到后端令牌、通用 `ctx` 或任意 Tauri IPC。
- 未授权能力既不在对象上，也不能通过裸 RPC 调用。
- 禁用插件会撤销令牌、卸载帧、移除贡献和停止事件投递。
- 贡献级失败不改写插件级身份，也不让其他贡献的调用串台。
- 页面切换不重建共享后端。
- 一个页面实例的模型不能发布到另一个页面实例。

## 生命周期

目标生命周期：

```text
scan manifests
  → validate api 3 + capabilities + contribution shapes
  → compile contribution declarations
  → create one backend frame
  → load factory
  → instantiate contributions
  → apply settings
  → restore last page / presenter
  → deliver pending events
```

### 启动顺序

1. Rust 扫描清单并完成静态校验；
2. 前端获取统一 manifest；
3. Host Runtime 建立贡献声明表和页面注册表；
4. 创建逻辑宿主帧并注册后端令牌；
5. 调用 `create(ctx)` 一次；
6. 将返回对象绑定到声明贡献；
7. 投递设置、显隐、查询和已登记页面事件；
8. 页面实例按需创建 Page Session；
9. Presenter 就绪后重放 model、settings、theme、skin、snapshot、query、show；
10. 未访问的页面不创建 Page Session，但已加载的后端实例仍存在。

### 禁用与启用

禁用插件：

- 撤销令牌；
- 卸载逻辑帧；
- 移除搜索、页面、栏目和动作贡献；
- 关闭分离窗口；
- 停止根事件订阅；
- 丢弃或冻结会话帧；
- 活动页面自动回导航页。

重新启用走完整加载流程。未重启时，不保留旧逻辑帧或旧令牌。

### 运行时故障

| 故障 | 影响范围 |
|---|---|
| 一个搜索源超时或抛错 | 该搜索源本轮空结果，按熔断规则计数 |
| 一个页面 `getModel` 失败 | 该页面进入可见错误态，可重试 |
| 一个 Presenter 崩溃 | 仅该 Presenter 重试或回退 |
| 一个 nav 栏目返回错误 | 该栏目移除，其他栏目保留 |
| 一个动作 handler 失败 | 该动作失败，其他贡献保留 |
| 后端工厂失败 | 整个插件不可用，所有贡献离线 |
| 逻辑帧崩溃 | 整个插件重载，10 秒内二次崩溃放弃 |

### 事件隔离

根事件只发给声明了对应 `event.*` 的启用插件。页面事件只发给当前页面后端。
每个事件都携带插件键、贡献键和页面键，宿主不得仅凭插件 id 广播私密载荷。

分离窗口监听继续必须带 `target`，其中后端私有事件按插件键过滤，页面私有事件
按页面键过滤，应用级事件才使用全局监听。

## 安全模型

### 信任主体

安全主体仍是：

```text
plugin id
+ backend token
+ contribution key
+ capability grant
+ sandbox / bridge surface
```

而不是 kind。所有层必须使用同一 composable manifest。

### 前端守卫

前端守卫负责：

- 在 SDK 层面只投影已授权组；
- 明确命名缺失的 capability；
- 阻止跨插件 id 和跨页面键调用；
- 在设置页和安装确认中展示风险。

前端不是最终边界。Rust 命令侧必须对每个宿主资源命令复核令牌、插件 id、
贡献键和 capability。

### Rust 边界

至少以下命令必须迁移到新上下文：

- HTTP 请求；
- 剪贴板读写与粘贴；
- 文件读取、写入、私有文件；
- 文件搜索与状态；
- 对话框、屏幕、窗口上下文；
- 系统通知与回收站；
- 分享预览；
- Page Model 发布与事件；
- secret 状态读取；
- 私有存储、文档库和设置；
- 插件包安装与卸载。

前端不能根据 `kind` 做最终授权，Rust 也不能根据“插件是 service”放行页面或
secret。

### Presenter

Presenter 保持独立沙箱和受限桥。只有页面宿主持有的 Presenter 桥可以发：
`page.ready/getModel/subscribe/dispatch/reportLayout/setModal/requestSearchFocus`、
主题和外壳安全动作。

Presenter 不应获得：

- 后端 `ctx`；
- `host.*` 能力；
- Page Model 发布；
- secret；
- 任意 Tauri 命令；
- 其他页面或其他插件的状态。

Presenter 的 `lume.page` 与后端 `ctx.page` 是不同协议。前者消费模型和发送
Intent，后者发布模型和处理 Intent，不能合并。
## Host Runtime 结构

目标实现把当前集中在 `registry.ts` 的职责拆成显式模块。

### 共享契约

新增或重构：

```text
src/plugins/manifest.ts          api 3 清单类型与静态形状
src/plugins/contributions.ts     贡献声明、键和实例类型
src/plugins/capabilities.ts      capability 词表、命名空间和前端守卫
src/plugins/backendContext.ts    ctx 投影与类型
src/plugins/contributionRegistry.ts
src/plugins/pageRegistry.ts
src/plugins/eventRouter.ts
```

`registry.ts` 保留生命周期和启停编排，不再包含 provider、mode、service 的加载
分支。`types.ts` 保留共享 UI 与 `LauncherPlugin` 类型，但移除 `kind` 驱动的
manifest 契约。

### Rust 模块

| 模块 | 目标职责 |
|---|---|
| `plugins.rs` | 扫描、解析 api 3、贡献与 capability 静态校验、canonical manifest |
| `plugin_logic.rs` | 一个插件一个后端帧、一令牌、一模块缓存、事件与 hook 路由 |
| `plugin_page.rs` | 页面键注册、页面 schema、模型发布、事件与错误 |
| `plugin_secret.rs` | 后端 capability 与声明槽位校验，不再使用 service role |
| `plugin_perm.rs` | 令牌归属、capability 台账、贡献键和页面键校验 |
| `plugin_window.rs` | 页面键窗口、页面键几何、页面键 snapshot/state |
| `plugin_install.rs` | api 3 安装确认、贡献和授权事实 |
| `plugin_devwatch.rs` | 插件目录变化重载整个后端与全部贡献 |

`plugin_perm.rs` 不再包含 `service` / `logic` / `legacy-presenter` 贡献授权角色。
如果实现仍需要令牌角色，只允许内部 `backend` 与 `presenter` 两种传输身份，
且二者都不能直接决定页面或 secret 能力。

### 前端模块

| 模块 | 目标职责 |
|---|---|
| `src/pluginLogic.tsx` | 共享逻辑宿主 supervisor，一次加载一个后端 |
| `public/pluginLogicFrame.js` | 按 capability 投影 `ctx`，承载统一入口 |
| `src/plugins/hostApi.ts` | 实现统一 capability groups |
| `src/plugins/rpc.ts` | RPC 统一分发；页面发布携带 page key |
| `src/plugins/pageRuntimeMode.tsx` | 页面贡献运行时，接收 page key、driver 和 token |
| `src/plugins/listTemplate.tsx` | collection driver 适配，不复用 mode kind |
| `src/plugins/iframeBridge.tsx` | 仅服务 Presenter，不增加后端能力 |
| `src/page-runtime/presenterBridge.tsx` | 保持受限 Presenter 桥 |
| `src/plugins/registry.ts` | 注册、启停、重载、事件和贡献实例编排 |

### 页面注册表

页面注册表至少维护：

```ts
interface PageRegistration {
  pluginId: string;
  pageId: string;
  pageKey: string;
  schema: string;
  driver: "page" | "collection";
  presenters: PresenterDescriptor[];
  defaultPresenter: string;
  enabled: boolean;
}
```

页面注册表是 Rust `plugin_page_publish` 与前端 Page Session 的共同事实源。不得
从 iframe 消息中的 `pluginId` 或 `pageId` 直接信任调用者。

### 贡献启停

设置模型增加贡献级开关。插件总开关仍控制整个后端：

```text
plugins.disabled                → 插件后端和全部贡献离线
plugins.contributions.disabled  → 指定贡献键离线，后端继续运行
```

例如关闭某插件的 search 贡献时：

- 搜索不再查询该插件；
- 页面、栏目和动作继续工作；
- 后端实例不重建；
- 贡献键写入设置后可跨重启保持。

页面贡献关闭时：

- 模式条和关键词入口消失；
- `last_page` 指向该页面时回导航页；
- 分离窗口关闭；
- 该页面 Page Session 丢弃；
- 其他页面和后端保持。

贡献级开关用于解决“统一后端之后只能整插件关闭”的体验回退。默认全部贡献
启用；关闭页面或搜索属于用户控制，不改变清单授权事实。

## 内置页面

导航页和剪贴板继续编译进 `lume.exe`，但不保留公开的 kind 特殊值。

推荐做法：

- `navigate` 与 `clipboard` 实现与磁盘插件相同的贡献对象；
- 它们通过内部受信任的 Contribution Registry 注册；
- 不经过磁盘清单、`.lupx`、permission token 或前端插件列表的宿主资源校验；
- 仍复用 Page Session、Presenter Host、页面键、模型和 Intent；
- 设置页可选择其 Presenter，但不需要显示“权限授予”卡片；
- 任何内部页面都不能被磁盘插件冒用 id 或页面键。

`BUILTIN_PLUGINS` 可以保留为编译器内置元数据表，但不再产生 `kind` 决定逻辑。
如果导航页仍由 App 组合根直接创建，也应显式包装为 Page Contribution，而不是
在 App 中按 `kind === "mode"` 分派。

内部可信不等于共享令牌：

- 内置模块直接调用 Rust 第一方命令；
- 磁盘后端只能通过令牌和能力组调用；
- 二者共享的是页面和贡献协议，不是信任等级。

## 实现映射

### 清单与安装

需要修改：

- `src-tauri/src/plugins.rs`
  - 替换 `PluginManifest` 的 kind、page_runtime、template、顶层 model/presenters；
  - 新增 `capabilities`、`search`、`pages`、`nav`、`actions`、`settings`、`secrets`；
  - 将 pinyin 计算迁移到每个页面贡献；
  - 将 `validate_manifest` 拆为 schema 校验、引用校验和预算校验；
  - 对 api 2 字段返回具体迁移错误；
  - canonical manifest 去重和目录选择规则保持不变。
- `src-tauri/src/plugin_install.rs`
  - `LupxInfo` 展示贡献和授权；
  - 在 `.lupx` inspect 阶段运行同一 api 3 清单门；
  - 不复制任何 api 2 加载兼容逻辑。
- `src-tauri/src/plugin_sign.rs`
  - 不需要格式变化；安装事实绑定继续覆盖新清单。

### 逻辑宿主

需要修改：

- `src-tauri/src/plugin_logic.rs`
  - `plugin_logic_meta` 返回统一 manifest 与 contribution declarations；
  - `plugin_logic_register_tokens` 只登记 `backend` token；
  - `plugin_logic_push` 的 hook 增加 page 或 contribution 坐标；
  - 不允许没有 token 的裸 invoke；
  - 每个插件的加载、卸载和重载继续串行化。
- `src/pluginLogic.tsx`
  - 移除 `role` 分支；
  - 加载统一入口一次；
  - 为所有贡献建立代理；
  - 缓存贡献级失败和熔断状态；
  - `logic-loaded` 动作携带实际 hook 和贡献键。
- `public/pluginLogicFrame.js`
  - 根据 capability 投影 `http`、`clipboard`、`fs`、`search`、`dialog`、`screen`、`app.notify`、`preview`、`secrets`；
  - 统一 `page` 发布器按 page key 绑定；
  - 不再依据 `role=service` 暴露 `page`。
- `src/plugins/rpc.ts`
  - 每个 RPC 带 contribution key 或 page key；
  - 页面模型调用必须使用页面上下文；
  - 未声明的后端组不存在或明确 fail-closed。

### 页面运行时

需要修改：

- `src/plugins/pageRuntimeMode.tsx`
  - 页面 key 从 `<plugin-id>` 改为 `<plugin-id>/<page-id>`；
  - `getModel` / `onIntent` / `onQuery` / `onShow` / `onHide` / `onEnter` 通过页面坐标调用；
  - 页面实例共享后端 token，但 Presenter 不共享；
  - 集合页 driver 使用内置模型构建器；
  - Presenter 选择和设置按页面 key 持久化。
- `src/page-runtime/session.ts`
  - 保留权威模型、Intent、Presenter Host 和快照；
  - `PageSession` 持有 page key；
  - 页面启动失败不卸载整个后端；
  - 页面切换不重建后端。
- `src/page-runtime/presenterBridge.tsx`
  - 继续使用受限桥；
  - 新增 capability 由贡献桥显式决定，而不是后端 `ctx` 全量透传。
- `src-tauri/src/plugin_window.rs`
  - 窗口 label 和几何按 page key 映射；
  - `plugin_window_meta` 返回页面、模型和 Presenter；
  - 请求/回复增加 page key；
  - 关闭回流写回页面键，不写插件裸 id。

### 权限与设置

需要修改：

- `src/plugins/permissions.ts`
  - 从单一 `RPC_PERMISSION` 扩展为 `CapabilityRegistry`；
  - 支持 `contribute.*`、`event.*`、`host.*`、`local.*`、`ui.*`；
  - 错误信息带 capability 与 contribution key。
- `src/plugins/hostApi.ts`
  - 拆分为可组合 capability group 工厂；
  - `guardHostApi` 以 group 投影为准；
  - 未知或未授权 group 不注入。
- `src-tauri/src/plugin_perm.rs`
  - 按 token + capability + contribution/page key 校验；
  - 删除 kind/service role 推导；
  - 对 `plugin_page_publish`、secret、HTTP、文件、搜索、preview 等命令统一使用。
- `src/settings/PluginsPane.tsx`
  - 卡片显示贡献列表和授权列表；
  - 提供插件总开关与贡献级开关；
  - Presenter 选择按页面 key；
  - 安装确认展示 `.lupx` 中的贡献与授权；
  - 移除 kind 标签、kind 筛选和 kind 徽标。
- `src/settings/catalog.ts`
  - 搜索插件时包含贡献名称、页面标题和授权词；
  - Presenter 设置检索按页面键。
- `languages/*.json`
  - 移除 `pluginKindMode` / `pluginKindService` / `pluginKindProvider` 的用户文案；
  - 新增贡献类型、贡献启停、capability 命名空间和迁移错误文案；
  - 三语同步。

### 示例与文档

实施后需要迁移：

```text
examples/plugins/web-search
examples/plugins/actions
examples/plugins/hello-mode
examples/plugins/file-search
examples/plugins/hidden-mode
examples/plugins/list-demo
examples/plugins/nav-bar
examples/plugins/notes
examples/plugins/state-probe
examples/plugins/text-tools
examples/plugins/themed-icons
examples/plugins/titlebar-demo
examples/plugins/translation-demo
examples/plugins/window-demo
examples/plugins/files-img-demo
examples/plugins/host-tools
```

需要更新：

- `docs/PLUGIN_API.md`：api 3 完整契约；
- `docs/PLUGINS.md`：新手上手与增量迁移；
- `docs/ARCHITECTURE.md`：统一后端、贡献注册表和页面注册表；
- `docs/SETTINGS.md`：贡献级开关、授权展示和页面键；
- `docs/TESTING.md`：api 3 验证链；
- `docs/PLUGIN_HOST_BEHAVIOR.json`：api 3 机器契约；
- `scripts/check_plugin_contract.mjs`：静态实现标记；
- `README.md`：插件平台描述；
- `CHANGELOG.md`：重构和验证记录；
- `docs/ROADMAP_HISTORY.md`：完成后归档迭代记录。

## 迁移映射

api 2 到 api 3 不提供运行时兼容。安装和加载 api 2 插件时，清单门拒绝并显示
迁移字段。

| api 2 | api 3 |
|---|---|
| `kind = "provider"` + `entry` | `capabilities += "contribute.search"`，增加 `[[search]]` |
| provider 的 `search` | `backend.search.<id>.search` |
| provider 的 `onEnter` / `select` / `filter` | 对应 `SearchBackend` 成员 |
| `kind = "service"` | 删除 kind；按实际钩子增加 `event.*` |
| service 的 `onShow` / `onHide` | `event.visibility` + 根 handler |
| service 的 `onQuery` | `event.query` + 根 handler |
| service 的 `onSubInput` | `event.subInput` + 根 handler |
| service 的 `onFeature` | `contribute.action` + `[[actions]]` + `onAction` |
| `kind = "mode"` + `page_runtime` | `contribute.page` + `[[pages]]` + `backend.pages.<id>` |
| 顶层 `model` | `[[pages]].model` |
| 顶层 `presenters` | `[[pages.presenters]]` |
| 顶层 `default_presenter` | `[[pages]].default_presenter` |
| 顶层 `height` / `hidden` / `keywords` / `keep_session` | 对应页面字段 |
| `template = "list"` | `[[pages]].driver = "collection"` |
| `[[features]]` | `[[actions]]`，`target` 明确为 backend 或页面 |
| `navBars()` | `contribute.nav` + `[[nav]]` + `backend.nav.<id>` |
| `permissions` | 按语义拆成 `host.*` 或 `event.*`；贡献准入用 `contribute.*`；旧的自由 `app.openPath` 需显式声明 `host.open` |
| `[[secrets]]` | 保留，并要求 `host.secrets` |
| `[[settings]]` | 保留；根 `onSettings` 需要 `event.settings` |
| 顶层 `[[presenter_settings]]` | `[[pages.presenter_settings]]` |
| `page_runtime = false` 的 list mode | `driver = "collection"` |

### 设置迁移

当前设置包含：

- `plugins.disabled`；
- `plugins.trusted` / `plugins.trust_all`；
- `plugins.window_bounds`；
- `plugins.color_modes`；
- `plugins.keep_session_overrides`；
- `pages.presenters`。

目标字段建议：

```toml
[plugins]
disabled = ["plugin-id"]
contributions_disabled = ["page:plugin-id/page", "search:plugin-id/source"]

[plugins.window_bounds]
"plugin-id/page" = { x = 0, y = 0, width = 720, height = 480 }

[plugins.keep_session_overrides]
"plugin-id/page" = true

[pages.presenters]
"plugin-id/page" = "presenter-id"
```

迁移规则：

- 旧 window bounds、Presenter 选择、keep-session 覆盖在插件只有单页面时映射到
  该页面键；
- 多页面 api 3 插件没有旧键，使用清单默认值；
- 旧 `trusted` / `trust_all` 不自动转化为任何 `host.*` 授权；
- 旧已禁用插件继续禁用整个插件；
- 无法映射的旧值保留但标记为 orphan，设置页显示可清理；
- 不恢复旧 api 2 插件代码。

### 发布与版本

- `HOST_PLUGIN_API` 从 `2` 提升到 `3`；
- `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的 semver
  同步按项目发布流程处理；
- api 2 `.lupx` 包在 inspect 阶段拒绝，错误中包含迁移表链接；
- 已安装 api 2 插件不执行，设置页显示迁移原因和卸载入口；
- 新分支不应同时维护 api 2 和 api 3 加载器。

### 用户可见的升级与回退

api 3 是破坏性协议，发布时必须同时满足：

- 首次启动扫描到 api 2 插件时，设置页显示迁移原因、受影响贡献和迁移指南链接；
- 已安装 api 2 插件不执行，但目录和私有数据保留，不能静默删除；
- 用户可以选择卸载、替换为 api 3 包或暂时回退到旧版本；
- 回退版本仍能读取旧设置中的插件目录、私有数据和安装记录；
- 回退前清理或标记 api 3 新增的贡献级设置，避免旧版本误读；
- `.lupx` inspect 在写入前提示 api 3 与旧宿主不兼容；
- CHANGELOG 明确写出版本门槛、迁移路径和已知损失。

如果无法保证回退可读，必须在升级前弹出阻断式提示，并要求用户导出
`settings.toml`、`plugin_store.db` 和插件目录备份。不得让用户在不知情的情况下
失去插件私有数据。

## 实施顺序

1. **契约先落盘**：新增 api 3 manifest、贡献键、capability 词表和共享测试。
2. **Rust 清单门**：解析、引用、预算、旧字段错误和 canonical manifest。
3. **统一逻辑宿主**：单入口、单令牌、能力投影、贡献代理和后端故障边界。
4. **页面注册表与 Page Runtime**：页面键、多页面、模型和 Presenter 选择。
5. **页面窗口与快照**：page key 窗口、几何、快照、关闭回调和 Esc。
6. **权限边界**：Rust 命令按 capability 与 contribution/page key 复核。
7. **贡献级设置**：插件总开关、贡献开关、设置页和 Presenter 设置。
8. **安装与迁移**：`.lupx` inspect、api 2 拒绝、设置迁移和错误文案。
9. **内置页面**：navigate/clipboard 接入统一贡献对象，移除 kind 分派。
10. **示例与文档**：全部示例迁移、PLUGIN_API 更新、CDP fixture 更新。
11. **回归与收口**：构建、单测、CDP、手工项和 CHANGELOG。

每一步都必须保持现有用户功能可运行，但中间态不需要兼容 api 2 插件加载。

## 验收矩阵

### 清单与安装

- api 3 最小 provider 清单通过。
- 有 `[[pages]]` 但无 `contribute.page` 被拒绝。
- 有 `contribute.page` 但无 `[[pages]]` 被拒绝。
- 页面 Presenter 不支持页面 schema 被拒绝。
- 页面 `default_presenter` 不存在被拒绝。
- `[[actions]]` target 引用不存在页面被拒绝。
- `secrets` 未声明 `host.secrets` 被拒绝。
- `[[secrets]]` 未声明槽位但请求 key 被拒绝。
- 旧 `kind` / `page_runtime` / `template` / `permissions` 被拒绝并显示迁移字段。
- api 2 `.lupx` 在 inspect 阶段拒绝且不写盘。

### 后端与贡献

- 一个后端同时提供搜索、页面、栏目和动作。
- 多个页面共享后端内存状态。
- 搜索源失败不影响页面实例。
- 页面失败不影响搜索和动作。
- 后端工厂失败使整个插件离线。
- 禁用插件卸载全部贡献、帧、窗口和事件订阅。
- 重启后贡献级禁用仍生效。
- 贡献键在日志、设置、诊断和错误中稳定一致。

### 授权

- 未声明 `host.network` 时 `ctx.http` 不存在且裸 RPC 被拒绝。
- 未声明 `host.clipboard` 时剪贴板调用被前端与 Rust 双层拒绝。
- 未声明 `host.fs.write` 时任意路径写入被拒绝。
- `host.secrets` 只允许后端读取声明槽位。
- Presenter 无法访问任何 `host.*`。
- 直接伪造另一个 plugin id 或 page key 被令牌归属拒绝。
- `trust_all` 只作为开发逃生门，不影响安装时声明事实。

### Page Runtime

- 多页面切换不重建后端。
- 每个页面独立模型、Presenter、查询和会话。
- 页面 A 不能向页面 B 发布模型。
- Presenter 切换不改写后端模型。
- 页面禁用后活动页面回导航页。
- 分离窗口标签、几何和回流按页面键隔离。
- 两个页面同时分离不会互相收到私有事件。
- 集合页使用内置 Presenter 且不接受自定义模型发布。

### 兼容与安全

- Presenter 的 CSP 仍禁止 fetch、XHR、WebSocket、EventSource、表单和子资源网络。
- Page Model 仍有 1 MiB、schema、revision 和 JSON 校验。
- Provider 结果仍有 64 行 / 192 KiB、单行 16 KiB 和查询 generation。
- `navBars` 仍有单插件和整页预算、重复 id 拒绝。
- 分离窗口监听仍带 `target`，不同页面私有事件不串台。
- 禁用/重载不留下旧令牌、旧帧、旧 pending call 或旧窗口。

## 测试计划

### 单元与静态

```bash
pnpm exec tsc --noEmit
pnpm run test:page-runtime
pnpm run test:plugin-contract
pnpm run build
cd src-tauri
cargo check
cargo test
cargo clippy --all-targets --message-format=short
```

新增或更新的 Rust 测试：

- api 3 清单合法/非法组合；
- capability 与贡献引用一致性；
- 页面键 canonicalization 和 schema 绑定；
- 后端令牌与页面发布归属；
- secret 只允许后端；
- 贡献级禁用和插件级禁用；
- `.lupx` inspect 拒绝 api 2；
- 设置迁移。

新增或更新的前端测试：

- capability group 投影；
- contribution registry 注册与卸载；
- 多页面 Page Session；
- collection driver；
- page key Presenter 设置；
- 页面私有窗口状态。

### CDP

保留并迁移：

- `cdp_plugin_verify.mjs`：provider 与 sandbox。
- `cdp_plugin_v2_verify.mjs` 改为 api 3 后端/页面 smoke。
- `cdp_sandbox_verify.mjs`：Presenters 与后端双层权限。
- `cdp_plugin_audit_runtime_verify.mjs`：capability 热刷新、贡献失败隔离。
- `cdp_plugin_window_verify.mjs` / `cdp_plugin_state_verify.mjs`：page key 窗口。
- `cdp_page_runtime_verify.mjs`：内置多 Presenter。
- `cdp_file_search_presenter_verify.mjs`：磁盘 Page Service。
- `cdp_presenter_control_verify.mjs`：页面 Presenter 设置。
- `cdp_presenter_network_verify.mjs`：Presenter 网络封闭。
- `cdp_contribution_budget_verify.mjs`：贡献预算和 collection driver。

新增最小 fixture：

```text
examples/plugins/unified-backend/
  plugin.toml
  backend.js
  views/detail.html
  views/compact.html
```

它应同时贡献搜索、两个页面、栏目和一个动作，并验证共享后端状态。

新增负向 fixture：

```text
examples/plugins/legacy-api-2/
examples/plugins/bad-capability/
examples/plugins/page-key-escape/
examples/plugins/presenter-secret-probe/
```

### 手工验证

- 真实文件拖入触发 `files` action。
- 分离窗口拖拽与 DWM 边框。
- 两个页面同时分离，关闭其中一个不影响另一个。
- 插件禁用后系统剪贴板采集仍由核心设置控制。
- 通知、预览、文件搜索和 UI 权限显示符合实际调用。
- 旧 api 2 插件显示迁移原因且不执行任何代码。

## 风险与决策

### 统一后端可能变成 god object

缓解方式：

- 后端接口按贡献分组，不把所有方法平铺在根对象；
- `ctx` 按 capability group 投影；
- 类型和运行时都禁止未授权组；
- 贡献失败隔离，不以单个 hook 失败销毁插件。

### 多页面共享后端带来故障耦合

同一插件的页面共享模块和连接池，后端崩溃会影响全部贡献。这是统一的代价；
必须保持页面级和 Presenter 级隔离，并让单页错误可重试。若未来需要把不同页面
放到不同隔离域，应新增显式 `isolation` 贡献字段，而不是恢复 kind 分支。

### 贡献级开关增加设置复杂度

主界面只显示插件总开关；详情页显示贡献开关。默认全开，普通用户无需操作。
贡献关闭只影响该贡献，不改变安装和授权事实。

### 事件授权可能挡住已有插件

现有 provider/service 的 `onQuery` 等行为需要显式 `event.query`。迁移示例和
文档必须明确。首次安装确认展示事件订阅，避免插件静默收不到输入。

### 页面键迁移可能丢失用户选择

单页面插件可以确定性映射旧设置；多页面插件无法从旧值推断目标页面。迁移保留
orphan 值并回退清单默认，设置页提供清理，不猜测用户意图。

### 安全边界不能只靠前端

所有 capability 都必须有 Rust 侧复核。前端投影是可用性和诊断层，不是边界。
任何新增 `host.*` 或 `event.*` 都需同步：

1. 共享词表；
2. 语法校验；
3. 前端投影；
4. Rust 命令检查；
5. 设置与安装确认；
6. 测试。

## 完成标准

重构完成时，应满足：

- 公开契约中不存在 `kind`、`page_runtime` 或 `template`；
- 磁盘插件只有一个后端入口和一个后端令牌；
- 所有贡献通过 `[[search]]`、`[[pages]]`、`[[nav]]`、`[[actions]]` 声明；
- 所有敏感能力和事件订阅都在 `capabilities` 台账中；
- 未授权能力既不在 `ctx` 中，也无法通过裸 RPC 调用；
- Page Model、Presenter 和 secret 边界仍由 Rust 复核；
- 多页面共享后端，同时拥有独立页面会话；
- 内置导航与剪贴板走同一贡献协议，但不绕过内核信任边界；
- api 2 插件不执行，并提供明确迁移错误；
- 构建、单测、CDP、手工项和文档同步完成。
## 贡献键与预算

### 稳定键

| 对象 | 键格式 | 使用位置 |
|---|---|---|
| 插件 | `<plugin-id>` | 启停、令牌、私有数据 |
| 搜索贡献 | `search:<plugin-id>/<search-id>` | 预算、熔断、诊断 |
| 页面贡献 | `page:<plugin-id>/<page-id>` | 窗口、Presenter、会话、`pages.presenters` |
| 导航贡献 | `nav:<plugin-id>/<nav-id>` | 栏目预算与诊断 |
| 动作贡献 | `action:<plugin-id>/<action-code>` | 设置页与失败记录 |

页面运行时、分离窗口、Presenter 设置和 `keep_session_overrides` 只接受完整
页面键。插件 id 加页面 id 的裸拼接容易与 `:`、`/`、大小写和未来命名空间冲突，
不得作为新设置的持久化键。

### 预算

沿用当前安全预算，并把它们变成 api 3 的明确上限：

| 对象 | 上限 |
|---|---|
| 清单文件 | 由 `.lupx` 与扫描门限制 |
| 搜索贡献 | 每插件最多 8 个 |
| 单个搜索结果 | 64 行 / 192 KiB；单行 16 KiB |
| 导航贡献 | 每插件最多 8 栏 / 120 项 / 192 KiB |
| 整页导航栏 | 32 栏 / 320 项 / 512 KiB |
| 页面贡献 | 每插件最多 16 个 |
| 单个页面的 Presenter | 最多 16 个 |
| 单个 Presenter 支持的 model | 最多 32 个 |
| 声明式设置 | 每插件最多 64 个 |
| Presenter 设置 | 每个页面最多 64 个 |
| secret | 每插件最多 32 个 |
| 声明式动作 | 每插件最多 64 个 |
| capability | 每插件最多 32 个，重复词拒绝 |
| action 正则 | 最多 512 字符 |
| 页面模型 | 1 MiB |
| 单次页面桥请求/回复 | 1 MiB |
| 窗口状态 | 2 MiB |
| 关闭快照 | 1,200,000 字符 |

### 路径与大小写

- 清单相对路径不得绝对化、包含 `..`、盘符、替代数据流或设备名；
- 页面、Presenter、图标和资源路径在 Windows 上按大小写不敏感比较，但保留原始
  路径用于显示；
- 贡献 id、动作 code 只允许 ASCII 字母、数字、`-`、`_`；
- 页面键和贡献键的比较使用规范化后的 ASCII 形式；
- 私有文件仍按 canonical plugin directory 解析，不能根据清单 id 反过来拼接目录。

## 贡献级隔离

### 加载成功后的注册规则

后端工厂成功返回对象后，Host Runtime 按贡献逐项注册：

```text
backend.search["web"]       → search contribution
backend.pages["translator"] → page contribution
backend.nav["links"]         → nav contribution
backend.onAction             → backend action target
```

某个贡献缺失、形状错误或预算失败时：

- 该贡献不注册；
- 其他贡献继续注册；
- 插件后端保持在线；
- 设置页显示贡献级错误；
- 报错包含 contribution key；
- 不因一个贡献失败而自动给整个插件熔断。

以下错误则视为整体不可用：

- 工厂返回 `null` / 基本类型；
- 根对象不是可调用结构；
- 清单没有有效贡献；
- 页面贡献的 model / Presenter 引用不成立；
- 逻辑帧崩溃或工厂超时。

### 事件路由的失败边界

- 根 `onQuery` 和 `onSubInput` 失败只记录该事件，不影响搜索；
- 根 `onSettings` 失败不清空已保存设置；
- 页面 `getModel` 失败只让该页面进入错误态；
- 页面 `onIntent` 失败只返回该 Intent 的失败结果；
- Presenter 崩溃只重试或回退该 Presenter；
- 单个搜索源超时只丢弃该源本轮结果。

### 贡献开关和卸载

贡献级关闭必须真正停止运行时流量，而不是只在 UI 隐藏：

| 关闭对象 | 运行时行为 |
|---|---|
| search | 移出搜索合并管线，停用熔断计数，不调用对应后端 |
| nav | 从导航栏注册表移除，取消刷新 |
| action | 从推荐块移除，旧匹配行失效 |
| page | 卸下 Page Session 与 Presenter，关闭该页面分离窗口，回导航页 |

插件总开关仍优先于贡献开关。贡献关闭不会撤销 `host.*` 授权，也不会重建后端；
插件重新启用后仍使用同一份清单事实。

## 页面会话与模型权威

### 页面键与实例

`<plugin-id>/<page-id>` 是页面实例的稳定身份。一个页面键对应：

- 一个 Page Session；
- 一份当前 Page Model；
- 一个活动 Presenter；
- 一份 Presenter 设置；
- 一份查询和可见性；
- 一份会话快照；
- 最多一个分离窗口。

搜索框的共享/独立查询语义保持现状，但页面状态按页面键隔离，不再把所有模式
共用同一个插件 id。

### 模型所有权

- Page Model 由页面贡献后端发布；
- Host Runtime 保存当前权威快照与 revision；
- Presenter 只能读取模型和发送 Intent；
- Page Intent 通过 Host Runtime 路由到对应页面后端；
- 页面切换只更换活动 Presenter 与可见页面，不重建后端。

### 关闭与重载

- 插件整体禁用：所有页面 Session 卸载并丢弃；
- 贡献级页面关闭：只卸载该页面；
- 插件重载：全部页面、Presenter、窗口和快照按插件整体换代；
- 后端崩溃：所有页面进入错误态，等待插件级重试；
- 单页面 `getModel` 失败：其他页面可继续使用，失败页面按会话重试。

### 旧 api 2 状态的迁移

api 2 的页面只以插件 id 为键。迁移到 api 3 时：

- 只有一个页面的插件，将其 window bounds、Presenter 选择、keep-session 覆盖
  迁移到唯一页面键；
- 有多个页面的插件，旧值无法无歧义映射时保留为 orphan；
- orphan 不自动套用到任意页面；
- 设置页显示可清理的迁移项；
- `last_page` 只有在能唯一映射时才自动迁移，否则回导航页。

## 安装确认与设置展示

### 安装确认

`.lupx` inspect 必须展示：

```text
插件名称、版本、API 版本
贡献：搜索 / 页面 / 栏目 / 动作
授权：host.* 与 event.*
页面：页面键、model、Presenter 数量
secret 槽位名称
包大小、文件数、哈希、签名状态
```

确认卡不展示后端代码，也不允许“先安装、后补 capability”。用户确认的是
清单事实，安装后运行时不按 UI 状态扩展授权。

### 设置页

插件卡片分成三个区域：

1. 插件信息与总开关；
2. 贡献列表与贡献开关；
3. 授权台账、设置、secret 和开发者选项。

展示规则：

- 搜索源显示“搜索”类型与搜索源名；
- 页面显示“页面”、页面名、Presenter 和窗口属性；
- 栏目显示“导航栏目”；
- 动作显示目标后端或页面；
- 未识别的 capability 降级显示原词，不隐藏；
- 过期或 orphan 的页面设置只在该插件内显示清理入口。

### 运行日志

日志前缀至少包含：

```text
[plugins] [plugin-id] contribution-key ...
```

错误不得只显示插件 id 而丢失搜索源、页面或动作坐标。页面错误还要带 page key
和 Presenter id，便于定位问题来源。

## 文档与代码的单一事实源

api 3 契约应由以下文件共同钉住：

```text
docs/PLUGIN_UNIFIED_BACKEND.md   设计意图与迁移约束
docs/PLUGIN_API.md              落地后的公开 API 参考
src/plugins/manifest.ts         前端类型与静态校验
src-tauri/src/plugins.rs        Rust 解析与预算校验
src/plugins/capabilities.ts     capability 台账
src-tauri/src/plugin_perm.rs    Rust 命令边界
docs/PLUGIN_HOST_BEHAVIOR.json  机器可读安全行为
scripts/check_plugin_contract.mjs 静态契约检查
```

文档中的示例必须在实施时被自动测试覆盖，至少包括：

- 清单可解析；
- 贡献引用完整；
- capability 词存在；
- 路径不越界；
- 预算不超限；
- 页面 Presenter 与 model 兼容。
## 实现工作项与依赖

完整重构跨清单、逻辑宿主、页面运行时、窗口、设置、安装器和示例。为避免一次性
改动过大，实施分支应按可独立验证的纵向工作项推进，但每个工作项必须同时保持
“可发现、可检查、可回退”三项属性。

### 清单契约与安装门

交付内容：

- api 3 manifest 类型；
- capability 词表；
- search/page/nav/action 的静态引用校验；
- api 2 字段拒绝与迁移提示；
- `.lupx` inspect 输出新事实。

这一片完成后，api 3 插件仍可以没有运行时加载器，但清单和安装事实必须已经完整
可验证。

退出条件：

- 所有 `cargo test` 通过；
- 所有仓库示例的迁移清单可生成；
- api 2 安装包被拒绝且不写盘。

### 统一后端与贡献代理

交付内容：

- 一插件一入口、一帧、一令牌；
- capability group 投影；
- search/page/nav/action 代理；
- 贡献级失败隔离；
- 后端级崩溃与重载；
- Rust 侧按 token + capability 校验。

退出条件：

- 一个 fixture 同时贡献搜索、页面、栏目和动作；
- 未授权能力既不存在也无法裸调用；
- 一个贡献失败不影响其他贡献；
- 禁用后无残留帧、令牌、pending call 和窗口。

### 页面注册与多页面会话

交付内容：

- page registry；
- 页面键持久化；
- Page Session 与 Presenter 按页面隔离；
- 多页面共享后端；
- collection driver；
- Presenter 设置按页面键隔离。

退出条件：

- 同一插件两个页面拥有不同模型、查询和 Presenter；
- 页面切换不重建后端；
- 页面 A 不能向页面 B 发布模型；
- Presenter 崩溃不拖垮后端。

### 分离窗口与会话恢复

交付内容：

- 页面键窗口；
- 页面几何；
- 页面快照；
- 关闭回流；
- 私有事件按页面键过滤；
- 多窗口同时分离。

退出条件：

- 一个页面关闭不影响另一个；
- 页面私有的主题、设置、query 和 enter 不串台；
- 页面键迁移后重启仍能恢复；
- 窗口 label、AUMID 和任务栏图标不冲突。

### 设置迁移与内置页面

交付内容：

- 插件总开关与贡献级开关；
- 贡献列表和 capability 台账；
- 安装确认；
- 内置 navigate / clipboard 统一接入；
- 旧设置迁移；
- 文档、示例、i18n 和 CDP。

退出条件：

- 用户可以独立关闭页面的搜索入口或单个页面；
- 设置页能解释每一项授权；
- 内置页面与磁盘页面共享 Page Runtime，但信任边界独立；
- 全量验证矩阵通过。

## 决策门槛

以下决策必须在实现前固定，否则不同模块会各自发明规则。

### 是否允许“贡献比后端多”

允许。后端是执行体，贡献是输出。一个插件可以只贡献搜索而没有页面，也可以只
贡献页面而没有搜索。清单禁止“有贡献定义却缺少对应授权”，但不要求每个贡献都
出现在后端返回对象中；缺失项只让该贡献失败。

### 是否允许“一个插件多个页面但只有一个 Page Service”

允许。这是统一后端最重要的收益。多个页面共享同一个后端实例，但拥有独立页面
注册、模型和 Presenter。

### 是否允许“一个插件多个搜索源”

允许。每个搜索源拥有独立 budget、timeout、generation 和熔断状态。不要用一个
插件级结果预算掩盖错误来源。

### 是否允许“一个插件多个导航栏目”

允许，但总预算仍按插件和整页计算。栏目 id 在插件内唯一，运行时键加插件前缀。

### 是否允许“一个贡献多个 Presenter”

允许，仅限页面贡献。Presenter 隶属于某页面，不能跨页面复用设置、快照或窗口。

### 是否允许“一个贡献关闭后仍保留后端”

允许。贡献关闭只移除该贡献的流量和实例；插件总开关关闭才卸载后端。

### 是否允许“内置插件使用同一 capability 台账”

页面与贡献协议相同，信任边界不同。内置插件不走用户授权，但不得用磁盘插件 id
冒用其页面键或 token。

### 是否允许“Presenter 直接调用 host.*”

不允许。Presenter 只能使用受限桥。若未来需要新的 Presenter 动作，必须先把
它定义为受限桥动作，并单独经过安全评审。

### 是否允许“统一后端直接访问所有 ctx”

不允许。后端对象可以引用全部已授权 group，但未授权 group 不投影。类型检查、
运行时检查和 Rust 检查三层必须一致。

### 是否允许“api 2 插件自动加载并提示迁移”

不允许。api 2 代码不执行，只显示拒绝原因和迁移链接。迁移是包作者的动作，不是
宿主在运行中重新解释旧清单。

### 授权词与 RPC 的映射是否允许一对多

允许。一个 `host.*` 可以覆盖多个 RPC，例如 `host.clipboard` 覆盖读取文本、
写入文本、读取图片、写入图片、读取文件、写入文件和粘贴。Rust 侧仍必须逐个命令
校验，每行命令的参数和结果预算不能因为共享一个 capability 而放宽。

禁止一对一之外的隐式继承：

- `host.fs.read` 不放行写入；
- `host.open` 不放行任意文件读取；
- `host.search.files` 不放行普通文件读取；
- `host.clipboard` 不放行通知、窗口或 secret；
- `contribute.page` 不放行页面模型发布之外的宿主资源；
- `event.query` 不放行页面查询，页面查询绑定页面贡献。

### 页面事件与根事件是否共享路由

不共享。路由表必须分开：

```text
root event router
  → event.query / event.visibility / event.settings / ...

page runtime router
  → pages[id].onQuery / onShow / onHide / onEnter / onIntent / ...
```

同一键在页面活动时可能同时产生根事件和页面事件，二者必须各自投递一次，不能
把页面事件转投给根 handler，也不能让根 handler 覆盖页面处理。

### 贡献级开关是否改变清单授权

不改变。贡献开关是用户对运行流量的控制，清单仍是安装时的授权事实。关闭搜索
贡献不等于撤销 `host.network`，但该贡献不再注册，后端也不能借搜索源代偿。

### 是否可以删除未启用的贡献

不可以自动删除。清单、安装确认和设置页必须保留贡献事实；运行时只跳过注册。
否则升级、迁移和用户重新启用的行为会随历史状态而改变。

## 失败与降级原则

### 清单失败

清单失败时：

- 插件仍出现在设置页，便于用户看到原因；
- 不注册任何贡献；
- 不创建逻辑帧；
- 不创建页面或窗口；
- 不参与权限缓存；
- `.lupx` 不可安装。

### 后端失败

后端工厂失败、加载超时或帧崩溃时：

- 所有贡献离线；
- 已打开页面显示错误态；
- 搜索源不再参与合并；
- 导航栏目撤销；
- 动作行撤销；
- 后端重试按插件级熔断处理。

### 贡献失败

贡献实例缺失或形状错误时：

- 其他贡献保持可用；
- 失败贡献不注册；
- 错误带 contribution key；
- 页面贡献失败不影响后端；
- 搜索贡献失败不影响导航页渲染。

### 功能降级

所有降级都必须可见：

- UI 显示错误态或提示；
- 日志包含坐标；
- 不静默丢弃用户数据；
- 不把失败伪装成空结果，除非贡献契约明确允许空结果（搜索源）。

## 使用与扩展规则

新增贡献或 capability 时，必须按以下顺序设计：

1. 明确贡献的输出协议；
2. 明确贡献键；
3. 明确是否需要 `contribute.*`；
4. 明确后端是否接收新事件，若是则定义 `event.*`；
5. 明确是否访问宿主资源，若是则定义 `host.*`；
6. 定义前端投影；
7. 定义 Rust 复核；
8. 定义设置和安装展示；
9. 定义预算和失败语义；
10. 定义测试和迁移。

如果一个需求只能通过“新增 kind”表达，应先检查它是否其实是贡献、capability
或页面驱动，避免重新引入本次重构要移除的耦合。

## 一句话契约

```text
一个插件一个后端；
一项贡献一份声明；
一项访问一份授权；
一个页面一份会话；
一个 Presenter 一个沙箱。
```
## 窗口标识与会话持久化

页面键不能直接作为 Tauri 窗口 label：页面键包含 `:` 与 `/`，既不适合长期作为
窗口标识，也会让任务栏、AUMID 和事件路由的命名空间变得脆弱。

### 规范映射

Host Runtime 为每个页面键生成稳定的窗口标识：

```text
page key:   page:translation-demo/translator
window key: plugin-translation-demo--translator
AUMID:      Lume.Plugin.translation-demo.translator
```

规则：

- 插件 id 与页面 id 均只允许 ASCII 字母、数字、`-`、`_`；
- 分隔符 `--` 是保留分隔符，插件或页面 id 不得包含连续两个连字符；
- 窗口 label 必须以 `plugin-` 开头，便于既有策略命令拒绝插件窗口调用；
- AUMID 使用点分隔离，避免任务栏合并；
- 同一插件同一页面最多一个分离窗口；
- 不同插件或不同页面的窗口不能收到对方的私有事件；
- 窗口几何、Presenter 选择和关闭快照都存页面键，而不是窗口 label。

### 旧窗口迁移

api 2 的窗口 label 是 `plugin-<plugin-id>`。对单页面插件可以迁移到新页面窗口；
多页面插件的旧窗口无法判断属于哪个页面，不做自动迁移，只清理旧几何记录。

### 事件过滤

所有插件私有事件监听必须带 `target`。事件载荷至少包含：

```text
pluginId
pageKey（页面事件）
contributionKey（贡献事件）
```

监听器按 target 与载荷双重过滤，不能只按窗口 label 推断页面身份。

## 发布前人工决策

实现分支开工前，维护者需要确认以下产品决策：

1. 是否接受 api 3 破坏性升级，并同时发布迁移指南与示例；
2. 是否保留“全部授权”开发逃生门，以及它是否只影响 `host.*` 而不影响
   `contribute.*` 和 `event.*`；
3. 是否允许贡献级关闭作为正式设置，还是只放在开发者选项；
4. 是否允许一个插件拥有多个页面并共同显示在模式条；
5. 是否为不同宿主能力设置用户级二次确认；
6. 是否保留当前“插件目录即信任”的安装模型，还是对高权限插件追加签名要求。

在决策固定前，可以在实现分支完成清单、运行时和测试骨架，但不能把这些产品
决策写死在多个模块中。
