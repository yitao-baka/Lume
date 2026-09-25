# Lume 插件 API 参考（v1）

> 适用版本：Pre-26.8+（ROADMAP #7 v1 + 第二/三/四轮）。
> 快速上手见 `docs/PLUGINS.md`；本文是完整的 API 参考。
> 所有契约以源码为唯一事实：`src/plugins/types.ts`（契约）、
> `src/plugins/registry.ts`(注册表与加载器)、`src-tauri/src/plugins.rs`
> （清单发现）。

---

## 1. 模型总览

Lume 插件 = **一份清单**（`plugin.toml`）+ **零或多份贡献**（contribution）。
注册表按 id 把两者关联，启停状态来自 `settings.plugins.disabled`。

```
<base>/plugins/<id>/           ← 磁盘插件（便携版 = exe 同级；安装版 = %LOCALAPPDATA%\Lume）
├── plugin.toml                ← 清单（§3）
└── main.js                    ← 入口（provider 类；kind 决定是否需要）
```

**三类贡献**：

| 贡献 | 契约 | 动态加载 | 内置示例 | 磁盘示例 |
|---|---|---|---|---|
| `provider` | `ProviderInstance` — 向 Navigate 搜索追加结果 | ✅ | `web-search`（examples/） |
| `mode` | `ModeInstance`（内置）/ **桥接 iframe 页**（磁盘） | ✅ | `clipboard` | `hello-mode`、`file-search`（examples/） |
| `service` | `PreviewService`（内置）/ **生命周期钩子**（磁盘） | ✅ | `preview` | — |
| `navBars` | `NavBarContribution[]` — 导航页栏目（§5A，任意 kind 可选钩子） | ✅ | — | `nav-bar`（examples/） |

**生命周期**：

```
启动 → Rust 扫描 plugins/*/plugin.toml（坏清单跳过）
     → 前端 App 组合根创建内置插件并 definePlugin()
     → refreshPlugins(): get_plugins 拉清单（含 enabled 态）
       → loadDiskProviders(): 磁盘 provider 经 asset 协议 + blob import()
设置变更/插件启停 → settings-applied → refreshPlugins() 重新同步
     → 若活动模式被禁用 → 自动回导航页
```

**运行中安装新插件**：下一次 `settings-applied`（任一设置保存、任一插件
启停）时加载；重启必然加载。已加载的插件每个会话只尝试一次（见 §5.4）。

---

## 2. 快速开始（5 分钟写一个 provider）

```
<base>/plugins/my-plugin/
├── plugin.toml
└── main.js
```

**plugin.toml**

```toml
id = "my-plugin"        # 可省略 — 默认取目录名
name = "My Plugin"      # 设置页显示名（可省）
kind = "provider"       # 必填 — 动态加载仅支持 provider
entry = "main.js"       # 必填（provider）— 入口 JS，相对插件目录
```

**main.js**

```js
export default {
  async search(query) {
    const q = query.trim();
    if (!q) return [];
    return [{ name: `搜索 "${q}"`, path: `https://www.bing.com/search?q=${encodeURIComponent(q)}` }];
  },
};
```

完成。重启 Lume（或任一设置变更触发 settings-applied）后，Navigate 搜索
结果末尾会出现插件返回的条目；**设置 → 插件** 里可启停。
可运行的完整示例：`examples/plugins/web-search/`。

要拿到宿主能力（toast/剪贴板/文档库/设置…），把默认导出写成**工厂函数**（§5.6）；
用了台账里的能力要在清单写 `permissions = [...]`（§6F.4）；
要贡献**整页模式**（自由 HTML UI + 全局关键字进入），见 §6（示例
`examples/plugins/hello-mode/`）。

---

## 3. 清单 `plugin.toml` 参考

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `id` | string | **目录名** | 插件唯一 id。省略时回退为所在目录名；与目录名不一致时以清单为准（不强制相等）。启停、去重、日志都以它为键。 |
| `name` | string | `""` | 设置页显示名；为空时前端回退显示 id。 |
| `version` | string | `""` | 显示用；设置页以 chip 呈现。内置插件固定为 lume 的包版本。 |
| `kind` | string | `"mode"` | `provider` \| `mode` \| `service`。三类均支持磁盘加载（mode 需 `view`，provider/service 需 `entry`）。 |
| `description` | string | `""` | 预留展示位。 |
| `permissions` | string[] | `[]` | **能力声明，P3.2 起强制**：台账（§6D.6）里的能力没声明就调用 → 明确拒绝（fail-closed），设置页每行显示这些 chip。「全部授权」可整插件放行。 |
| `entry` | string | `""` | 入口 JS（相对插件目录）。provider 必填；mode 可选（逻辑钩子）；service 必填（钩子）。**可以是目录**（多文件打包产物）— 此时实际加载其中的 `index.js`，目录内文件的相对 `import` 由宿主改写为 blob URL（§5.6）。 |
| `view` | string | `""` | **mode 专属** — 视图 HTML 页（相对插件目录），渲染进桥接 iframe（§6）。 |
| `template` | string | `""` | mode 插件：`"list"` = 用内置列表模板渲染 `entry` 逻辑的行，**免 `view` HTML**（§6E.5） |
| `keywords` | string[] | `[]` | **mode 专属** — 全局关键字：Navigate 输入匹配关键字时，结果里出现「进入 <name>」行，激活即切进该模式（uTools 式进入）。匹配分级：**精确 → 前缀 → 拼音首字母前缀 → 拼音全拼前缀**（拼音由后端预计算，输入 `miao`/`ms` 可匹配「秒搜」；见 §5.7）。 |
| `development` | bool | `false` | **开发模式** — 每次插件刷新（settings-applied，含任一设置保存）都从磁盘重新加载本插件，改代码无需重启。设置 → 插件 每行的「↻ 重载」按钮可对任意磁盘插件手动触发同等效果（§5.8）。 |
| `settings` | array of table | `[]` | **声明式设置**（P3.4，§6F.3）——`[[settings]]` 子表：`key`、`label`、`type`（`toggle`/`select`/`text`）、`default`、`[[settings.options]]`（`value`/`label`）。设置 → 插件 自动渲染，值存插件 `__settings` 文档，插件经 `ctx.settings.get/all` 读、`onSettings` 感知变更。 |
| `features` | array of table | `[]` | **声明式进入规则**（任意 kind，§6E.1）——`[[features]]` 子表，字段 `code`（必填，进入时下发）、`label`（结果行文案）、`regex`（正则匹配输入）、`over`（匹配任意非空文本）、`min_length`/`max_length`（长度界）、`icon`。命中的查询在导航结果里出现「<label>」行，激活把该查询作为 payload 投递给插件的 `onFeature`/`onEnter`。`type = "files"`（文件拖入，含 `file_type` 类别，§6E.1.1）、`"img"`（剪贴板图片）与 `"window"`（活动窗口匹配，§6H.4）规则见对应小节。 |
| `height` | integer | — | **mode 专属** — 本模式页面的窗口高度（逻辑 px）。省略 = 全局 设置 → 窗口大小 → 高度；前端会钳制到工作区高度（见 §5B）。分离窗口的默认高度同样取它（§6G）。 |
| `detachable` | bool | `false` | **mode 专属**（P6，§6G）— 页面可以分离为独立窗口：设置页显示「可分离」chip，激活该模式时页面右上角悬停出现「在独立窗口打开」按钮。依赖启动器搜索框交互（`setSubInput`/`setQuery` 驱动）的模式不要声明。 |
| `icon` | string | `""` | **mode 专属** — 模式 pill（与 Tab 循环）的图标文件（相对插件目录）。省略 = 不显示图标。`data:`/`http(s):`/`asset:`/`blob:` URI 原样透传，其余按文件路径走 asset 协议解析。 |

**解析规则**（`plugins.rs::parse_manifest` / `scan_disk_plugins`）：

- TOML 语法错误 → 该插件被**静默跳过**（stderr 记录 `[plugins] skipping …`），不影响其它插件。
- 非 `plugin.toml` 的散文件、无清单的子目录一律忽略。
- 清单里的字段拼错会被 toml 解析器**忽略**（不会报错）——拼写要对照上表。
- 磁盘插件清单按 id 排序后合并进列表；内置插件（clipboard/preview）始终排在前面。

---

## 4. 发现与加载管线

### 4.1 Rust 侧（`src-tauri/src/plugins.rs`）

- 启动时不主动扫描——`get_plugins` 命令**每次调用都实时扫描**磁盘目录，
  合并 `BUILTIN_PLUGINS`（clipboard/preview），并按
  `settings.plugins.disabled` 计算每个插件的 `enabled`。
- 返回结构（`PluginInfo`）：

```ts
interface PluginManifest {   // 前端看到的形态
  id: string;
  name: string;
  version: string;
  kind: string;             // "mode" | "service" | "provider"
  description: string;
  permissions: string[];
  builtin: boolean;         // 内置 = true
  enabled: boolean;         // settings.plugins.disabled 的反相
  entry: string;            // 磁盘 provider 的入口文件；内置为 ""
  dir: string;              // 磁盘插件绝对目录；内置为 ""
}
```

### 4.2 前端侧（`src/plugins/registry.ts`）

`refreshPlugins()` 在两处被调用：**App 组合时**（启动）与每次
**`settings-applied`**（设置窗口保存 / 插件启停 / 导入恢复）。流程：

1. `invoke("get_plugins")` 拉清单 → 存入响应式 signal（设置页据此渲染）。
2. `loadDiskPlugins()`：遍历清单，加载所有「未加载过 + 非内置 + `enabled`
   + 有 `entry`/`dir`」的插件，按 `kind` 分流 — `provider`（§5）、
   `mode`（桥接 iframe 页）、`service`（生命周期钩子）；任意 kind 都可带
   `navBars` 钩子（§5A）。

**加载一个磁盘 provider 的步骤**：

1. `fetch(convertFileSrc(dir + "\\" + entry))` 经 asset 协议读文件（CSP
   为 null、asset scope `**`，无需额外配置）。
2. 文本 → `Blob(text/javascript)` → `import(URL.createObjectURL(blob))`
   —— 标准 ES Module 语义（可用 `export`，不可 `import` 项目内部模块）。
3. 校验默认导出：`default.search` 必须是函数；否则
   `console.error("[plugins] bad default export …")` 并放弃。
4. 合格则包装成 `LauncherPlugin`（provider 贡献）注册进注册表，
   `console.log("[plugins] loaded provider: <id>")`。

**失败语义（重要）**：

- 每个磁盘插件 id 每会话**只尝试加载一次**——进入流程即标记
  `loadedDiskIds`，失败（文件缺失 / HTTP 错误 / 语法错误 / 形状不对）
  不重试。改完插件代码需要**重启 Lume** 才会重新加载。
- 加载失败、运行期 `search` 抛错，都只影响该插件自己（§5 错误模型）。
- 查询 `get_plugins` 失败（理论上不会）→ 保留上一次清单状态，插件是
  可选能力，从不阻塞启动器。

---

## 5. Provider 插件 API（磁盘 JS 插件）

### 5.1 入口契约

入口文件是**标准 ES Module**，默认导出必须满足：

```ts
export default {
  search(query: string): Promise<ProviderResult[]>
  onEnter?(item: ProviderResult): void   // 可选 — `enter` 条目的激活回调
};
```

| 成员 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `search` | `(query: string) => Promise<ProviderResult[]>` | ✅ | 同步返回数组也可以（加载器会 `Promise.resolve` 包装）。 |
| `onEnter` | `(item: ProviderResult) => void` | — | 用户激活带 `enter` 标记的条目时回调；收到的是 `search` 返回的那个对象（自定义字段原样保留）。见 §5.1.1。 |

`ProviderResult`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 结果条目显示名（网格里单行省略）。 |
| `path` | string | — | 文件绝对路径 **或** URL。声明了 `enter` 的条目可省略（动作条目不打开任何东西，宿主生成合成去重键）。激活时经 `launch_app`（`ShellExecuteW`）打开。 |
| `description` | string | — | 可选副行，显示在名字下方（结果网格两行形态）。 |
| `icon` | string | — | 可选显式图标：`data:`/`http(s):`/`asset:`/`blob:` URI 原样使用，其余按文件路径走 asset 协议；省略 = 走 `path` 的常规图标管线。 |
| `enter` | boolean | — | 标记：激活本条目**不调 `launch_app`**，改为回调 provider 的 `onEnter(item)`；启动器保持打开，插件自行决定何时 `ctx.app.hide()`。 |

#### 5.1.1 `enter` 动作条目

```js
export default function create(ctx) {
  return {
    async search(query) {
      return [{
        name: "复制当前时间",
        description: "点击执行动作（不打开文件）",
        icon: "data:image/svg+xml;…",
        enter: true,
        action: "time",           // 自定义字段会随 item 原样回传
      }];
    },
    onEnter(item) {
      if (item.action === "time") {
        ctx.clipboard.writeText(new Date().toString())
          .then(() => ctx.app.toast("已复制"));
      }
    },
  };
}
```

- 与原生条目激活路径的差异：`onEnter` 抛错/缺失只记控制台日志；启动器**不隐藏**
  （与 `app.revealPath` 同一哲学 — 做完动作往往还要继续搜，隐藏由插件决定）。
- 普通条目（无 `enter`）激活路径不变：`launch_app` 打开 `path`。

### 5.2 调用时机与结果合并

- **只在 Navigate 模式的非空查询时调用**（空查询的主菜单不触发 provider）。
- 每次按键搜索都会调用——`search` 应当快速返回（异步网络请求请自行加
  防抖/缓存；慢响应会被 stale-token 机制丢弃结果，见下）。
- 合并规则（组合根 `runSearch` apps 分支）：
  1. 先取原生索引结果（`search_apps`，System32/桌面/开始菜单/用户索引）；
  2. 依次调用每个**已启用** provider，把返回条目**追加在原生结果之后**；
  3. 按 `path` 全局去重（与原生结果、与其它 provider 之间都去重）；
  4. 总条数封顶 **20**（原生 + provider 合计）；
  5. 整个过程用根搜索令牌（`searchToken`）守卫——期间有新按键搜索，
     迟到的结果被丢弃。
- **激活路径**：普通条目与原生条目完全一致 — 点击/Enter → `launch_app`
  （URL 走默认浏览器，文件走 ShellExecute）；图标走 `get_app_icons` 管线
  （取不到 → 未知图标回退，URL 条目通常就是未知图标）。声明了 `enter` 的
  条目改为回调 `onEnter(item)`（§5.1.1）；带显式 `icon` 的条目图标直接使用，
  不再走图标管线。
- **错误隔离**：单个 provider 的 `search` 抛错/拒绝 →
  `console.error("provider search failed: <id>")`，其它 provider 与原生
  结果不受影响。

### 5.3 能力边界（v1 provider 不能做什么）

- 无法访问启动器内部模块（i18n、store、图标缓存……）——blob 模块是独立
  作用域，只有标准 Web API + Tauri 注入的全局（`window.__TAURI_INTERNALS__`
  技术上可达，但**不属于契约**，随版本可能变化）。
- 无法贡献整页模式、右键菜单动作或卫星预览——那些是内置 mode/service
  贡献的能力（§6）。
- **能用哪些宿主能力由 manifest 的 `permissions` 决定**（P3.2 起强制）：
  没声明就调用会明确失败（§6F.4）。插件自有数据（`db`/`storage`/`settings`）
  与私有目录（`<plugin>/files/`）不受限。

### 5.4 加载与禁用语义

- **单次加载**：加载器用 `loadedDiskIds` 保证每个 id 每会话只 import 一次
  （无论成败）。修改插件代码 → 设置 → 插件 点「↻ 重载」，或重启 Lume
  （§5.8）；清单声明 `development = true` 的插件每次刷新自动重载。
- **禁用**：设置 → 插件 关闭后，`settings.plugins.disabled` 记录 id →
  `providerPlugins()` 的 enabled 过滤把它的结果从合并中剔除——**但模块
  仍驻留内存**（v1 不卸载已加载模块）。重新启用立即恢复结果，无需重启。
- **内置 provider**（如果有）与磁盘 provider 走同一合并管线。

### 5.5 完整参考示例

- `examples/plugins/web-search/` — 最小 provider（每查询追加一个 Bing 条目）。
- `examples/plugins/notes/` — P3 新面全演示：文档库（`db.put/allDocs/bulkDocs` +
  乐观锁）、私有目录导出、声明式设置（`[[settings]]` + `onSettings`）、以及
  权限层两向对照（未声明 `network` 被拒 / 已声明 `clipboard` 放行）。
- `examples/plugins/host-tools/` — P1 宿主能力（HTTP/通知/对话框/剪贴板/屏幕）。
- `examples/plugins/actions/` — P0 新契约全演示：`enter` 动作条目 +
  `description` 副行 + 显式 `icon` + **多文件入口**（`entry = "dist/"` +
  相对导入，见 §5.6）。
- 安装：把整个目录拷进 `<base>/plugins/`，重启或触发一次 settings-applied，
  然后在 设置 → 插件 里确认它处于开启状态。

### 5.6 多文件入口（entry 目录）

清单 `entry` 可以指向**目录**（Rust 侧解析为其中的 `index.js`），目录内的
相对 `import`（`./util.js`、`../x/y.js`）由宿主加载器递归改写为 blob URL：

```
my-plugin/
├── plugin.toml        entry = "dist/"
└── dist/
    ├── index.js       import { helper } from "./util.js";
    └── util.js
```

- 无需打包工具也能拆文件；用 esbuild/vite 打出的多文件产物同样直接可用。
- **不支持裸包名**（`import "lodash"`）——依赖请在打包时内联；无 node_modules
  解析、无运行时下载。
- 模块按路径缓存（一次搜索会话内重复加载不重编译）；重载插件时缓存清空。

### 5.7 关键字匹配分级（mode `keywords`）

Navigate 输入按以下优先级匹配关键字（多插件命中时按级排序，同「进入」行合并）：

| 级 | 匹配 | 例（关键字「秒搜」） |
|---|---|---|
| 0 | 精确（大小写不敏感） | `秒搜` |
| 1 | 关键字前缀 | `秒` |
| 2 | 拼音首字母前缀 | `ms` |
| 3 | 拼音全拼前缀 | `miao` / `miaosou` |

拼音形式由 Rust 在扫描清单时预计算（`pinyin` crate）并随 `get_plugins` 下发
（`keywordsPinyin`），前端不做拼音转换。

### 5.8 热重载

- **手动**：设置 → 插件 每个磁盘插件行的「↻ 重载」按钮 → Rust `reload_plugin`
  命令 → `plugin-reload` 事件 → 前端注册表卸载并重新从磁盘 import 该插件
  （含清单重读：改 `keywords`/`height`/`icon` 同样生效）。内置插件无此按钮。
- **自动**：清单 `development = true` → 每次 settings-applied（任一设置保存、
  任一插件启停）都先卸载再重载。
- 重载会清空模块缓存（§5.6）；若重载的是当前激活的 mode，模式实例被整体
  替换（查询清空，页面重建）。

---

## 5A. 导航页栏目（navBars — 任意 kind 的可选钩子）

任何磁盘插件（provider/mode/service 不限）都可以在工厂逻辑对象上实现
`navBars()`，向**导航页空查询主菜单**贡献栏目（bar/栏目）：

```js
export default function create(ctx) {
  return {
    navBars() {
      return [
        {
          id: "links",            // 插件内唯一 — 宿主加 "<插件id>:" 前缀
          title: "快速链接",       // 直接渲染，i18n 由插件自行处理
          items: [
            { name: "GitHub", path: "https://github.com" },
            { name: "设备管理器", path: "C:\\Windows\\System32\\devmgmt.msc" },
          ],
        },
      ];
    },
  };
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | 栏目 id，插件内唯一；宿主加 `<插件id>:` 前缀作为键盘导航 zone 键。 |
| `title` | string | ✅ | 栏目标题，原样渲染。 |
| `items` | `{ name, path, icon? }[]` | ✅ | 每栏封顶 50 条；name/path 必填，坏条目丢弃并记控制台日志。 |

- **渲染位置**：「已固定」之后、「Windows 资源管理器」之前，多个栏目按
  插件注册序排列；**explorer 栏始终位于最下层**（结构性固定，插件栏不可
  越过）。
- **条目激活**：与原生栏条目完全一致 — 点击/Enter → `launch_app`（文件与
  URL 都可以）→ 启动器隐藏；右键 → 共享 app 菜单（固定/启动/打开位置/管理
  员启动）。
- **图标**：`icon` 可省 — 文件路径走 `get_app_icons` 管线（取不到 → 未知图
  标回退）；`data:`/`https?:`/`asset:`/`blob:` URI 直接使用，其它字符串按
  文件路径（如插件目录内的图标）经 asset 协议解析。
- **调用时机**：组合时、每次呼出（`launcher-shown`）、每次插件刷新
  （settings-applied）。可返回 Promise（宿主等待）；单插件抛错/坏形状只影
  响它自己。动态栏目（按 `ctx.storage` 状态返回不同条目）因此可行。
- **键盘导航 / 展开**：与原生栏一致 — 参与连续网格导航（↑/↓/←/→ 跨栏保
  列），超过一栏宽度出现「展开」，展开态撑满工作区（sizer cap 覆盖插件栏）。
- **空栏目**（items 为空）不渲染；返回 `[]` 或不实现钩子 = 不贡献。

完整示例：`examples/plugins/nav-bar/`。

---

## 5B. 插件自定窗口尺寸

mode 插件可以用两种互补的方式决定启动器窗口大小：

**① 声明式 — 清单 `height` 字段（静态默认值）**

```toml
kind = "mode"
view = "view.html"
height = 560        # 本模式页面的窗口高度（逻辑 px）
```

切换进该模式时，sizer 的 fixed-height 分支取 `desiredHeight()`（清单
`height`），未声明时回退全局 设置 → 窗口大小 → 高度。前端会把声明值钳制
到 `90px ≤ height ≤ 工作区高度 - 32px`，坏清单值不会撑爆屏幕。

**② 运行时 — 宿主 RPC `app.resize`（动态调整）**

iframe 页面里（桥接 `window.lume`）或工厂 `ctx.app` 上：

```js
lume.app.resize({ height: 720 });          // 只改高度，宽度保持当前值
lume.app.resize({ width: 800, height: 600 });
```

- 省略的轴保持当前尺寸；height 钳制到启动器最小高度（90px）。
- 典型用法：页面加载/内容变化后量自己的 DOM 再调
  （`lume.app.resize({ height: document.documentElement.scrollHeight + padding })`），
  实现真正的按内容自适应。调用频率请自行节制（host 侧不做防抖）。
- **时效**：`app.resize` 的尺寸保持到下一次内容驱动的 resize —— 切换模式、
  回到导航页（auto-fit）或其它 `scheduleResize` 触发会重新应用配置值。

内置剪贴板模式不声明 `height`（沿用全局设置）；示例 `examples/plugins/
hello-mode/` 演示了 `height = 560` 与 `app.resize` 按钮。

---

## 5C. 插件自定搜索框占位文字（`app.setPlaceholder`）

模式页可以运行时自定搜索框的占位文字（placeholder）——iframe 页里
（桥接 `window.lume`）或工厂 `ctx.app` 上：

```js
lume.app.setPlaceholder("在 My Mode 里搜点什么…"); // 自定
lume.app.setPlaceholder("");                        // 传 "" 恢复默认
```

- **作用域按插件 id 隔离**：宿主把文字存进以调用方插件 id 为键的表，
  仅当**该插件自己的模式页激活**时显示（provider/service 插件调用无害，
  但只有存在同 id 模式页时才会被看到）——一个插件永远改不了别的模式
  （含导航页/剪贴板）的搜索框。
- **回退链**：本插件自定文字 → 通用占位 `搜索…`（`searchGeneric`）。
  导航页/剪贴板两个内置模式不受影响（各自的设置项照旧优先）。
- 无持久化——每次会话由插件在 `onShow`/`onQuery` 里自行设置；典型用法
  是按页面状态切换提示语（如「输入关键字」→「正在索引…」）。

示例 `examples/plugins/hello-mode/` 演示了设置与恢复两个按钮。

---

## 6C. 磁盘 mode 桥接契约（`window.lume`）

mode 页是 srcdoc iframe，运行在 **opaque-origin 沙箱**里（P5：iframe 带
`sandbox="allow-scripts allow-forms allow-popups allow-modals"`，**无**
`allow-same-origin`——页面够不到宿主文档、`parent.__TAURI_INTERNALS__` 与
启动器 DOM，也不能导航顶层窗口；代价见下方「沙箱边界」）。注入的桥接客户端
暴露一个 Promise RPC 对象 `window.lume`（方法拒绝时 reject；桥接层捕获并
`console.error`，返回 `undefined`）：

| 组 | 方法 | 说明 |
|---|---|---|
| `app` | `hide()` / `toast(text, opts?)` / `setQuery(q)` / `setPlaceholder(text)` / `openPath(path)` / `revealPath(path)` / `trash(paths)` / `resize({width?, height?})` / `notify(title, body)` / `setSubInput(opts?)` / `removeSubInput()` / `redirect(pluginId, opts?)` | 同 §6B.0 的组合根能力；`setPlaceholder` 自定本模式搜索框占位文字（§5C）；`openPath` 经 `launch_app`（文件/URL 均可）并标记「已使用条目」；`revealPath` 在 Explorer 中定位并选中目标（**不**标记「已使用条目」、**不**隐藏启动器——打开位置后用户通常还要继续搜，是否隐藏由插件自定）；`trash(paths)` 把文件/文件夹批量送入回收站（无永久删除回退，失败即 reject；宿主不做确认框，删除确认由插件自行用 toast/UI 二次确认实现）；`notify(title, body)` 系统通知（P1.2，§6D）；`setSubInput`/`removeSubInput` 接管/交还搜索框（P2.3，§6E.2）；`redirect(pluginId, {code?, payload?})` 跳到另一个插件（P2.5，§6E.4） |
| `clipboard` | `readText()` / `writeText(text)` / `writeImage(data)` / `writeFiles(paths)` / `readFiles()` / `readImage()` / `paste({text?, image?, files?})` | 系统剪贴板：文本读写、图片（base64 或 `data:image/png;base64,…`）、文件列表（CF_HDROP，Explorer 式复制）、读回文件列表；`readImage()` 返回 PNG data URI（无图 = null；`img` feature 的取数路径，§6E.1.1）；`paste` 写入单个载荷并 Ctrl+V 到启动器呼出前的前台窗口（P1.3，§6D） |
| `http` | `request({url, method?, headers?, body?, bodyBase64?, timeoutMs?})` | **宿主 HTTP**（P1.1）——请求在 Rust 侧经 WinHTTP 发出（Schannel TLS + 系统代理），**不受页面 CORS 限制**；返回 `{status, headers, body(base64), truncated, text(), json()}`。仅 http/https；默认超时 10s（钳制 1–60s）；响应体 4MiB 截断并置 `truncated` |
| `dialog` | `open({title?, defaultPath?, fileName?, filters?, multiple?, folder?})` / `save({…})` | 原生文件选择/保存对话框（P1.4）。`open` 返回选中路径数组，`save` 返回路径或 `null`；**取消不是错误**（`[]` / `null`），由插件决定提示文案 |
| `screen` | `cursor()` / `displays()` | 光标位置与显示器列表（P1.5），单位是**物理像素**；`displays()` 每项含 `x/y/width/height`、工作区 `workX/workY/workWidth/workHeight`、`primary` |
| `fs` | `readText(path)` / `thumb(path)` / `videoPoster(path)` / `icon(paths)` / `writeText(name, text)` / `writeBytes(name, base64)` / `readPrivate(name)` / `listPrivate()` / `privatePath(name)` / `removePrivate(name)` / `writeFile(path, text)` | 文件读写能力。读取与任意路径写入（`writeFile`）**需要声明**（`fs.read` / `fs.write`，§6D.6）；`readText` 返回文本内容（lossy-UTF8 解码；**> 512KB reject**——插件自行显示「预览前 512KB」类提示）；`thumb` / `videoPoster` 返回 base64 PNG data URI（可直接进 `<img src>` / `poster`；shell 无缩略图提供者时 reject）；`icon` 返回与 `get_app_icons` 同形的 `{path, icon}[]`（icon 为 data/asset URI 或 null）。`writeText`/`writeBytes`/`readPrivate`/`listPrivate`/`privatePath`/`removePrivate` 操作**插件私有目录** `<plugin>/files/`（无需权限，单文件 10 MiB，`name` 只能是文件名 —— 见 §6F.2） |
| `storage` | `get(key)` / `set(key, value)` / `remove(key)` | 插件私有 KV —— v1 契约的**兼容垫片**，内部就是文档库里的 `__storage` 文档（§6F.1）；新代码请用 `db` |
| `db` | `get(id)` / `put(doc)` / `remove(doc\|id, rev?)` / `allDocs({idStartsWith?, limit?})` / `bulkDocs(docs)` | **文档库**（P3.1，§6F.1）：uTools/CouchDB 形状的文档（`_id` + `_rev` 乐观锁），持久化在 `<base>/data/plugin_store.db`。冲突 reject，消息以 `conflict:` 开头 |
| `settings` | `all()` / `get(key)` | 本插件声明式设置的**生效值**（manifest 默认值 ⊕ 用户改过的值，P3.4，§6F.3） |
| `search` | `files(q, opts?)` | **全盘文件搜索** — 统一门面 `file_search`（Everything 在运行则走它的 IPC，否则 LumeSVC 自研 USN 索引）。返回 `{backend: "everything"\|"svc"\|"none", status: "ready"\|"building"\|"unavailable", total?, sort?, entries: [{id,name,path,isFolder,mtime?,size?}]}`。`opts` 兼容旧调用：**数字 = max**；对象 = `{offset, max, sort, exts, folder}`——`max` 默认 12、钳制 1..=100；`offset` 从第 offset 条开始（0 起；Everything 全量有效，LumeSVC 由引擎 `skip` 分页——宿主不再用「取 offset+max 再裁剪」的旧技巧，那个技巧被服务端 100 条上限截断过）；`exts`（小写、不带点的扩展名数组）/`folder` 是**名称级过滤**：Everything 收到的是它自己的 `ext:`/`folder:` 语法，USN 引擎在扫描时判定（它的名字排序会把这类命中埋到几千条之后，客户端对一页结果过滤是找不到的）。回复里 `filter` 字段回显**真正生效**的过滤（规范 Everything 语法，如 `"ext:png;jpg"`）；**没有回显＝没过滤**（老服务/老宿主），调用方要自己兜底。；`sort` 取 `"name" \| "path" \| "size" \| "mtime" \| "name_desc" \| "path_desc" \| "size_desc" \| "mtime_desc"`（非法值 = 引擎默认序；svc 无全局排序，对返回页做页内排序并如实回显）。`total` 为引擎报告的总命中数（svc / 老版 Everything 拿不到时缺省）；条目的 `mtime`/`size`（ms epoch / 字节）拿不到时缺省，UI 按字段存在与否自适应隐藏列。完整示例 `examples/plugins/file-search/` |

事件（页面赋值 `window.lume.on.<type> = fn`）：

| 事件 | 载荷 | 时机 |
|---|---|---|
| `query` | `string` | 模式激活期间的每次搜索框输入（含清空） |
| `show` | — | 模式切入 / 每次呼出（reset） |
| `hide` | — | 启动器隐藏且本模式活动 |
| `enter` | `{code, type, payload}` | 声明式进入规则命中本模式（P2.1）或别的插件 `app.redirect` 过来（P2.5）。`type` = `"regex" \| "over" \| "redirect"`，`payload` = 命中的查询文本（redirect 时为发送方给的 payload）。**页面在 `load` 之后才会收到状态重放**（见下） |
| `subInput` | `string` | 本模式调 `app.setSubInput` 接管搜索框后，每一次按键（P2.3） |
| `settings` | `Record<string, unknown>` | 用户在设置页改动了本插件的声明式设置（P3.4）；页面 `load` 后的握手会重放当前值 |
| `key` | `{key, ctrlKey, shiftKey, altKey}` | 模式激活时的 keydown 转发——**↑↓/Enter/翻页等导航键由模式页自行实现**（磁盘 mode 的 `rows()` 为空，根网格键位不生效；搜索框中的文本编辑键照常）。转发链路（P5 沙箱化后）：页面内非可编辑目标、未被页面 `preventDefault` 的 keydown 由**桥接脚本**转发给宿主 → 宿主在其窗口重放该键（Esc 分层/Tab 切模式/箭头导航照旧）→ 根路由消费的键异步回执 `preventDefault`（迟滞消费——Tab 这类移动焦点的键，iframe 内默认动作可能已先发生；Esc 契约不受影响，页面在**自己 document** 上的冒泡监听里 `preventDefault` 即同步消费，被消费的按键不再转发）。焦点在插件 iframe 内时同样送达。示例 file-search 用 ↑↓ 移动选中、Enter 打开、Ctrl+Enter 复制路径 |

**状态重放（重要）**：桥接脚本在 `<head>`、页面自己的 `lume.on.*` 赋值在 `</body>`
之前——所以宿主**不会**在 iframe 一挂载就推事件。页面 `load` 后桥接发
`__lumeReady`，宿主随即重放当前状态：`query` → `show` → 本次进入载荷
`enter`（若有）。含义：① 页面脚本请同步赋值 `lume.on.*`（异步赋值会错过首播）；
② 重复收到同一 `show`/`query` 是正常的，处理器应幂等。

**沙箱边界（P5 起）**：iframe 是 opaque origin——`window.localStorage`/
`document.cookie` 访问会**抛错**（插件数据请用 `ctx.storage`/`ctx.db`）；
页面内直接 `fetch` 远程受 CORS 约束（opaque origin 发不出带凭据的请求），
跨域取数请用 `lume.http.request`（宿主代理，无 CORS）；`<img>`/`<video>`
等非 CORS 资源、asset: 协议图标不受影响。另外，iframe 内非可编辑区域的
点击会把焦点交还宿主搜索框（桥内 mousedown 交接，宿主统一兜底）。

Esc 默认不经过 `key` 事件（根统一处理：菜单 → 模式 onEscape → 卫星预览 → 隐藏）。**插件要消费 Esc**：在自己的 document 上挂冒泡 keydown 监听并 `preventDefault`——被消费的按键不再转发给宿主（桥接的转发监听检查 `defaultPrevented`）。iframe 内非可编辑目标的按键在转发后同样经过根 `blockBrowserKeys`（Ctrl/Alt 组合被拦，与宿主非输入区行为一致）；可编辑目标（input/textarea/contenteditable）的按键完全归插件。

---

## 6. 内置插件开发 API（TypeScript 贡献）

> 这一节面向**第一方/编译进二进制**的插件（clipboard/preview 即此形态）。
> 磁盘 mode/service 动态加载已支持（第三轮，`kind = "mode"` + `view` /
> `kind = "service"` + `entry`）；本节仍是内置贡献契约的权威描述。
> 契约定义：`src/plugins/types.ts`。

### 6.1 `LauncherPlugin` — 注册单元

```ts
interface LauncherPlugin {
  id: string;                        // 稳定 id（= 清单 id；启停/日志的键）
  modeMeta?: {                       // mode 贡献的模式 pill 元数据
    labelKey: string;                //   i18n 键（pill 文案）
    placeholderKey: string;          //   i18n 键（搜索框占位，v1 占位实际仍按 id 特判）
    icon: string;                    //   SVG import 的 URL
  };
  mode?: ModeInstance;               // mode 贡献（§6.3）
  preview?: PreviewService;          // service 贡献（§6.5）
  provider?: ProviderInstance;       // provider 贡献（§5）
  clipMenuActions?: () => unknown;   // 共享右键菜单的剪贴板动作（§6.6）
}
```

注册：组合根按序 `definePlugin(plugin)`。**注册顺序 = 模式 pill 顺序 =
磁盘插件之前的合并顺序**。注册发生在 App 组件作用域内——mode 实例里的
Solid `createEffect/createSignal` 因此拥有正确的响应式 owner。

### 6B.0 `PluginServices` — 组合根开放给内置插件的能力

| 方法 | 语义 |
|---|---|
| `showToast(text, opts?)` | 底部 toast。`opts.undo` 撤销回调（3s 窗口）；`opts.duration` 覆盖默认停留（1.6s）。 |
| `markEntryOpened()` | 标记「本此呼出已使用条目」→ 清空搜索召回（下次呼出回导航页）。launch/paste/开链接类动作都应调用。 |
| `resetAndHide()` | 清空会话状态（走 clearSearch）并隐藏启动器。 |
| `persistLastPage()` | 防抖 400ms 持久化「记住上次所在页面」（读活动模式的 `pageKind`）。模式内切换分类/页面时调用。 |
| `runSearch(q)` | **根搜索管线**：重置选中/隐藏导航高亮/zone 归 grid → 按 mode 分发（apps 原生搜索；插件模式 → `instance.search(q)`）。模式内部刷新数据应调它而不是自己的 `search`，以保证选中态/zone/令牌一致。 |
| `scheduleResize()` | 下一帧重测窗口高度（内容变化后调用）。 |

| `searchToken()` | 单调递增令牌——根每次搜索 +1。异步结果落地前比对，令牌变了就丢弃（防乱序）。 |
| `selectionSource()` | `"keyboard" \| "mouse" \| "other"`——最后一次选中变更的来源。hover 门控（键盘导航中悬停不接管）读它。 |
| `markMouse()` | `selectionSource = "mouse"`。视图的 onMouseMove/onClick 调用。 |
| `openMenu(m)` | 打开共享右键菜单（根渲染；`m` 为 `MenuState` 结构：`{kind, x, y, app?/item?/idx?}`）。 |
| `mode()` | 当前活动模式 id（`"apps"` 或插件模式 id）。 |
| `requestMode(id)` | 请求切模式（等价于用户点 pill → `switchMode`）。 |
| `setModePlaceholder(pluginId, text)` | 设置某插件模式的搜索框占位文字（`""` = 默认；按插件 id 隔离，见 §5C）。内置插件一般用不到——`createHostApi` 会自动带上调用方自己的 id。 |

### 6B.1 `ModeInstance` — 整页模式契约

每个方法都标注**调用方与时机**——实现必须能在这些时机被安全调用：

| 成员 | 调用方 / 时机 |
|---|---|
| `query()` / `setQuery(q)` | 组合根读取/清空当前模式查询（呼出恢复、clearSearch 全清、搜索框输入回写）。query 与 apps 模式独立。 |
| `search(q)` | 根 `runSearch` 对非 apps 模式的分发。实现须：取 `services.searchToken()` 快照 → 异步取数 → 令牌不一致则丢弃 → 写自己的 rows → `setSelected(0)` + 复位滚动 → `services.scheduleResize()`。 |
| `reset()` | 每次呼出（`clearSearch`）与切模式（`switchMode`）调用：清多选/对话框/动画态等**每呼出状态**，并清空自己的 rows（原生语义：呼出即全新搜索）。 |
| `selected()` / `setSelected(i)` | 根 `moveSelection`（↑↓/网格移动）、`runSearch` 复位、Enter 激活前的对齐。 |
| `rows()` | `currentResults()`（键盘移动的边界）与 Enter 激活。返回 `ClipboardItem[]` 形状（v1 契约即剪贴板行；泛化是后续工作）。 |
| `activate()` | Enter / 第二次点击选中行的激活：多选 → 合并粘贴；单选 → 粘贴。 |
| `onKey(e, ctx)` | 键盘路由在**非 apps 模式**下先交给模式处理；返回 `true` = 已消费。收到的键：←/→（空查询切分类）、Space（多选）、Del（删除）——↑/↓/Enter 由根统一处理（`ctx.moveSelection`、根 `activate`）。`ctx = { hasResults, moveSelection }`。 |
| `onEscape()` | Esc 分层：菜单 → **模式**（如退出多选，返回 true）→ 卫星预览 → 隐藏。 |
| `previewTarget()` | 卫星预览插件每次选中变化时轮询：当前选中行的预览请求（`PreviewReq`）或 `null`（隐藏）。行失效 → `null`。 |
| `previewEnabled()` | 该模式当前是否想要卫星预览（对应 设置 → 开启预览）。 |
| `measureViewport()` | 窗口尺寸变化（sizer 定高分支 + 根视口 effect）时触发；重测模式内部虚拟列表视口。 |
| `desiredHeight?()` | 可选 — sizer 定高分支读取：本模式的固定窗口高度（清单 `height`），`null` = 用全局设置高度（§5B）。 |
| `pageKind()` / `restorePage(kind)` | 记住上次所在页面：持久化当前页（如剪贴板分类）/ 恢复；切到该模式时根先 `restorePage("all")` 复位。 |
| `applySettings(s)` | 每次 `settings-applied`（对**所有**模式实例，含未激活的）：应用自己的设置切片（如剪贴板的显示类开关）。 |
| `View` | 无 props 的 Solid 组件——活动时经 `<Dynamic>` 渲染为整页内容。内部通过闭包持有自己的 store 与 `services`。 |

**模式 pill**：`modeMeta.labelKey` 提供文案（i18n），`icon` 提供图标；
关闭插件的 pill 自动消失，Tab 循环也随之跳过。

### 6B.2 `ModeKeyContext`

```ts
{ hasResults: boolean; moveSelection(delta: number): void }
```

`hasResults` = 当前 rows 非空；`moveSelection` = 根的选中移动（含
selectionSource 标记、导航高亮恢复、自动滚动）。

### 6B.3 `PreviewService` — 卫星预览服务

```ts
{ currentPreview(): PreviewReq | null; clear(): void }
```

- 组合根把「活动模式的 `previewTarget()`/`previewEnabled()`」组装成依赖
  注入 preview 插件；插件内部跑 100ms 防抖 effect（show/close IPC）。
- `currentPreview` 是**同步**信号——Esc 分层在预览防抖未落地前也能正确
  判断「预览开着」并优先关它。
- `clear()` = 立即清空（卫星窗 × 按钮 / Rust 侧 teardown 的
  `preview-closed` 事件回调）。

### 6B.4 共享右键菜单集成（`clipMenuActions`）

右键菜单由根渲染（`buildMenuItems`），剪贴板目标的动作由剪贴板插件以
**窄接口**供给（`menu.ts::ClipMenuActions`：`copyOnly / pasteClip /
toggleClipPin / copyPlain / openClipLink / revealClipFile / requestDelete`）。
组合根取 `clipboardPlugin.clipMenuActions()` 传入——菜单不依赖插件的完整
类型，只依赖这份结构；插件端直接返回自己的 store（结构天然满足）。

### 6B.5 完整内置示例：剪贴板插件

`src/plugins/clipboard/` 的目录结构即推荐的内置插件布局：

```
src/plugins/clipboard/
├── index.tsx          ← createClipboardPlugin(services)：建 store、
│                        实现 ModeInstance 契约、返回 LauncherPlugin
├── store.ts           ← 全部信号与动作（rows/selection/虚拟列表/设置切片
│                        + 键盘滚动跟随 effect——在组件 owner 内创建）
└── ClipboardView.tsx  ← 纯渲染（读 store + services，交互经回调）
```

关键实现要点（照抄即可避坑）：

- **store 工厂只依赖 `PluginServices`**——rows/selection/viewport 都是
  自己的信号，不向根索要。
- 内部数据刷新（撤销/清空/pin/删除后）调 `services.runSearch(query)` 走
  根管线，而不是自己的 `search`——保持选中复位/zone/令牌语义一致。
- 视图的悬停选中要同时满足：`hoverSelect` 设置开启 +
  `services.selectionSource() !== "keyboard"`；点击先
  `services.markMouse()`。
- `search` 第一行取令牌：`const token = services.searchToken()`；落地前
  `token !== services.searchToken()` 则丢弃。

---

## 6D. P1 宿主能力（HTTP / 通知 / 剪贴板 / 对话框 / 屏幕）

> `docs/PLUGIN_GAP_ANALYSIS.md` 的 P1 阶段（2026-09-21 落地）。所有能力都是
> **Rust 侧的一个命令**，三条路径（内置工厂 `ctx` / 磁盘 provider 工厂 `ctx` /
> iframe 桥接 `window.lume`）暴露同一套方法名。表格见 §6C。

### 6D.1 `http.request` — 宿主 HTTP（无 CORS）

插件页面里的 `fetch` 受同源/CORS 约束，翻译、查词、汇率这类插件因此做不了。
宿主 HTTP 把请求放到 Rust 侧发出（WinHTTP：Schannel TLS、跟随重定向、
gzip/deflate 自动解压、**自动使用系统代理**），页面直连被拦的地址经此即可访问。

```js
const res = await ctx.http.request({ url: "https://api.example.com/x", timeoutMs: 15000 });
res.status;            // 200
res.headers;           // { "content-type": "application/json", … }（键小写）
res.text();            // 响应体解码为 UTF-8 文本
res.json();            // 解析为对象（格式非法时抛错）
res.truncated;         // 响应体超过 4 MiB 被截断时为 true
```

- `method`（默认 GET，仅字母）、`headers`、`body`（UTF-8 文本）、
  `bodyBase64`（二进制，优先于 `body`）、`timeoutMs`（钳制 1–60 秒）。
- 仅允许 `http` / `https`；其他协议与非法 URL 直接 reject。
- 主线程永不阻塞：请求跑在 Rust 工作线程上。
- 权限：`network`（manifest 声明位；强制层见 §9 与 P3.2 规划）。

### 6D.2 `app.notify` — 系统通知

启动器隐藏时，应用内 toast 触达不到用户；`notify(title, body)` 经 Windows
通知区投递（宿主自注册一个**隐藏**的通知图标，不占用托盘位置；标题/正文按
shell 字段宽度截断）。

```js
await ctx.app.notify("下载完成", "report.pdf 已保存到下载文件夹");
```

- 首次调用时懒注册通知图标，之后复用；注册或投递失败会 reject（不静默）。
- **显示与否取决于系统设置**：Windows 关闭通知 / 专注助手开启时 shell 会丢弃
  气泡——API 仍成功返回，这一点在实机验证脚本里如实报告。
- 权限：`notify`。

### 6D.3 剪贴板扩展

```js
await ctx.clipboard.writeImage(canvas.toDataURL("image/png")); // PNG，base64 或 data URI
await ctx.clipboard.writeFiles(["C:\\a.txt", "C:\\b.txt"]);    // CF_HDROP（Explorer 式复制）
const files = await ctx.clipboard.readFiles();                 // 当前文件列表（无则 []）
await ctx.clipboard.paste({ text: "粘贴到前台窗口" });          // 写入并 Ctrl+V
```

- `paste` 复用剪贴板模式的完整流程：隐藏启动器 → 把焦点还给呼出前的前台窗口
  → 注入 Ctrl+V；**载荷粘贴后留在剪贴板上**（与普通复制一致）。只有一个载荷
  字段允许存在；没有目标窗口时退化为纯复制（并记日志）。
- 图片上限 32 MB（解码前检查）。
- 权限：`clipboard`（既有文本读写同名）。

### 6D.4 `dialog.open` / `dialog.save` — 原生文件对话框

```js
const files = await ctx.dialog.open({ title: "选择文本", multiple: true,
  filters: [{ name: "文本", extensions: ["txt", "md"] }] });
const target = await ctx.dialog.save({ fileName: "输出.txt" });  // 取消 → null
```

- 取消不是错误：`open` 返回 `[]`，`save` 返回 `null`——由插件决定提示什么。
- `defaultPath` 指定起始目录，`folder: true` 改为选目录。
- 对话框由 Rust 侧驱动（`tauri-plugin-dialog`），启动器窗口的能力集不因此扩大。
- 权限：`dialog`。

### 6D.5 `screen.cursor` / `screen.displays` — 屏幕几何

```js
const { x, y } = await ctx.screen.cursor();     // 物理像素
const ds = await ctx.screen.displays();         // [{x,y,width,height,workX,workY,workWidth,workHeight,primary}]
```

- 全部是**物理像素**（多屏时 `x` 可为负）；配合 `app.resize` 可做「贴着光标」的
  小窗类插件。
- 权限：`screen`。

### 6D.6 能力与权限台账（单一事实源；P3.2 起已强制）

| 宿主能力 | RPC / 命令 | 权限声明 |
|---|---|---|
| 隐藏启动器 / toast / 改查询 / 打开路径 / 定位 / 回收站 / 改窗口尺寸 | `app.*` | 无（基础能力） |
| 系统通知 | `app.notify` / `plugin_notify` | `notify` |
| 剪贴板读写（文本/图片/文件/粘贴） | `clipboard.*` | `clipboard` |
| 宿主 HTTP | `http.request` / `plugin_http_fetch` | `network` |
| 文件对话框 | `dialog.*` / `plugin_dialog_*` | `dialog` |
| 光标与显示器 | `screen.*` / `plugin_cursor_pos`、`plugin_displays` | `screen` |
| 全盘文件搜索 | `search.files` / `file_search` | `search.files` |
| 文件读取（文本/缩略图/图标） | `fs.readText/thumb/videoPoster/icon` | `fs.read` |
| 任意路径写入 | `fs.writeFile` | `fs.write` |
| 插件私有目录读写 | `fs.writeText/writeBytes/readPrivate/listPrivate/privatePath/removePrivate` | 无（属于插件自己） |
| 回收站删除 | `app.trash` / `trash_to_recycle` | `trash` |
| 前台窗口信息与 Explorer 当前文件夹 | `app.foreground` / `plugin_foreground_context` | `window`（P4，§6H.2） |
| 插件私有 KV / 文档库 / 设置 | `storage.*`、`db.*`、`settings.*` | 无（插件自有数据） |

> **现状（P3.2 起）**：本表就是**强制层**的输入——表里每一行未声明即被拒绝
> （fail-closed，文案带缺失的能力词），实现在 `src/plugins/permissions.ts`
> （`guardHostApi` 逐方法把关，插件逻辑与 mode 桥接两条路径都覆盖）。
> 新增宿主命令时**必须**在这里登记一行、并在该文件里加一条
> `RPC_PERMISSION`；`信任全部权限`（「全部授权」）是开发逃生门。细节与边界
> 见 §6F.4，信任模型见 §9。
> **P5 起双层防线**：同一张表在 **Rust 侧**也强制（`src-tauri/src/plugin_perm.rs`
> ——每个宿主能力命令按调用方 plugin_id 对照清单 `permissions` 校验，
> fail-closed；`file_search`/`trash_to_recycle` 的原生调用路径按「main 窗口 +
> 无 plugin_id」放行）。绕过前端守卫的调用（直连 `invoke`）同样被拦。

---

## 6E. P2 入口矩阵与搜索链路

> `docs/PLUGIN_GAP_ANALYSIS.md` 的 P2 阶段（2026-09-21 落地）。这一阶段把插件
> 从「能被关键字唤起」变成「能被用户此刻的输入自然触发」。示例
> `examples/plugins/text-tools/`（features + 下钻 + filter + redirect）。

### 6E.1 声明式进入规则（`[[features]]`）

```toml
[[features]]
code = "upper"          # 必填 — 进入时下发（payload.code）
label = "文本工具：转为大写"   # 结果行文案（省略 = 插件名）
over = true             # 匹配任意非空文本
min_length = 2          # 可选长度界（字符数）
max_length = 200

[[features]]
code = "open-url"
label = "文本工具：打开这个网址"
regex = "^https?://"    # 正则匹配输入（与 over 二选一；两者都有时 regex 优先）
```

- **匹配时机**：导航模式（apps）每次非空查询；命中即在结果里追加「<label>」行，
  位置与「进入 <插件>」关键字行同级（原生结果之后、文件命中与 provider 之前）。
- **正则语义**：大小写不敏感，**在前端编译**（按插件+规则缓存）。**匹配空串的
  正则被忽略**（`.*`、`a?` 等——否则每次按键都出一行，uTools 同样忽略）；非法
  正则会记 error 并跳过该条规则。`over` 与 `regex` 都没声明的规则永不命中。
- **激活**：把当前查询作为 payload 投递——
  - `kind = "mode"`：先切到该模式，再调它的 `onEnter({code, type, payload})`
    （页面同时收到 `lume.on.enter`）；
  - `kind = "provider"` / `"service"`：调其 `onFeature({code, type, payload})`。
  - 三种都没实现处理函数时：宿主记 warn 并 toast「插件无法处理该动作」，启动器
    不隐藏。
- **无 UI 的用法**：service 插件 + `over` + `onFeature` 就能做「选中文本 → 转
  换 → 写剪贴板」这类零 UI 工具。

### 6E.1.1 `type = "files"` 文件拖入与 `type = "img"` 剪贴板图片进入（P2.2）

```toml
[[features]]
code = "handle-docs"
label = "文件处理器：处理文本文件"
type = "files"              # 缺省 "text"（上面的 regex/over 规则）
extensions = ["md", "txt"]  # 大小写不敏感、不带点；省略 = 任意文件
min_length = 1              # 这里是文件数边界（text 规则里是字符数）

[[features]]
code = "handle-image"
label = "图片处理器：处理剪贴板图片"
type = "img"
```

- **files**：把文件从资源管理器**拖到启动器窗口**（Tauri drag-drop handler 提供
  真实路径；WebView2 的 HTML5 drop 拿不到路径）即出现「<label>（N 个文件）」行
  ——拖入时主菜单在则立即出行，不在（启动器隐藏）则先拖住文件再按热键呼出。
  **激活**把命中的路径**子集**投递给 `onFeature({code, type: "files", payload: "",
  paths})`（mode 收 `onEnter`）——只匹配了 `extensions` 的文件在 `paths` 里。
  行在下一次隐藏/呼出后消失。查询非空时拖入也会把行追加进结果。
  *P4 更新*：`file_type` 类别（image/video/audio/document/text/folder/others）
  与文件夹匹配已支持——见 §6H.3；`extensions` 规则下文件夹不再命中（行为
  收窄）。
- **img**：剪贴板持有可解码图片（CF_DIB/DIBV5、截图工具的自定义 PNG、CF_BITMAP）
  时，**空查询主菜单**出现「<label>」行（激活 = `onFeature({code,
  type: "img", payload: ""})`）。像素由插件自己读：
  `ctx.clipboard.readImage()` → `data:image/png;base64,…`（null = 无图），
  需要清单声明 `clipboard` 权限。
- 示例：`examples/plugins/files-img-demo/`。

### 6E.2 子输入框（`app.setSubInput` / `removeSubInput`）

```js
lume.app.setSubInput({ placeholder: "在此输入要过滤的内容…" });  // 接管
lume.on.subInput = function (text) { /* 每次按键 */ };
lume.app.removeSubInput();                                       // 交还
```

- 接管后主搜索框的输入**不再触发常规搜索**，而是逐字送到插件的 `onSubInput`
  （磁盘 mode 页面收 `lume.on.subInput`，工厂逻辑收到同名钩子，service 亦可）。
- `placeholder` 在此期间替换搜索框提示语；`value` 可写一个初始文本（会一并
  投递给接管者）。
- **一次只有一个拥有者**：别的插件调 `setSubInput` 不会抢走；`removeSubInput`
  只有拥有者自己有效。
- **自动释放**：切模式、再次呼出（clearSearch）、插件被重载/关闭都会把搜索框
  交还宿主（所有权是会话级状态，不持久化）。
- 与「搜索记忆」的关系：接管期间输入的文字仍写入该模式的 query（宿主照常显示），
  但不会触发 `search`。

### 6E.3 provider 二级下钻（`drill` + `select` + `filter`）

```js
export default {
  async search(q) {
    return [{ name: "选择转换方式…", drill: true }];   // 声明下钻行
  },
  async select(item) {
    return [{ name: "大写", enter: true }, { name: "小写", enter: true }];  // 下一层
  },
  async filter(item, query) {
    return rows.filter((r) => r.name.includes(query));  // 可选：层内过滤
  },
};
```

- 激活带 `drill: true` 的行 → 调 `select(item)`，返回的行**替换网格**；Esc
  回上一级（恢复父层行，并释放搜索框）。只支持一层（v2 不做多层栈）。
- 实现 `filter` 时，宿主在下钻期间把按键喂给它（`filter(item, query)`），层级
  行随输入刷新；**没实现 `filter`** 则搜索框保持常规语义——一旦继续输入会运行
  普通搜索并离开下钻层（行为可预期，不静默）。
- 下钻行同样支持 `enter`/`icon`/`description`；`select`/`filter` 抛错只记日志
  并 toast，不影响其它 provider。

### 6E.4 插件互跳（`app.redirect`）

```js
lume.app.redirect("hello-mode", { code: "from-x", payload: "要带过去的内容" });
```

- 目标为 mode：切页并投递 `onEnter({code, type: "redirect", payload})`
  （页面收 `lume.on.enter`）；目标为 provider/service：投递 `onFeature(...)`。
- 目标不存在 / 未启用 / 未加载 → **宿主 toast 提示**（`pluginActionUnavailable`），
  不做静默失败（市场跳转是远期，暂不提供）。

### 6E.5 内置列表模板（`template = "list"`，P2.5b）

```toml
id = "list-demo"
kind = "mode"
entry = "main.js"      # 必填 —— 逻辑（provider 同款 ctx 能力面）
template = "list"      # 声明内置列表模板 —— 不需要 view.html
```

`kind = "mode"` 且声明 `template = "list"` 的插件**免写任何 HTML**：宿主把
`entry` 装进启动器窗口（与 provider 相同的信任模型与 `ctx` 能力面），用内置
Solid 列表组件渲染其行；键盘 ↑/↓/Enter 走共享导航（宿主读 `rows()` /
`selected()` / `activate()`），点击行回调 `onEnter(item)`。逻辑契约：

- **`search(q) → 行数组`（必需）**：行形状与 provider 结果相同
  （`{ name, path?, description?, icon? }`，`name` 必填）。
- `onEnter(item)`（可选）：行激活。启动器保持打开 —— 插件自己决定何时
  `ctx.app.hide()`。
- 可选钩子 `onShow` / `onHide` / `onQuery(q)` / `onSubInput` / `onSettings` 与
  provider/service 相同；`[[features]]` 命中投递到 `onFeature(info)`（mode 在
  切页后收，同 §6E.1）。`[[settings]]`（P3.4）照常生效。
- `view` 字段被忽略；`height` / `icon` / `keywords` 照常。

示例：`examples/plugins/list-demo/`（零 HTML，文档库 + 剪贴板 + features）。

---

## 6F. P3 数据层、私有文件、声明式设置与权限强制层

> `docs/PLUGIN_GAP_ANALYSIS.md` 的 P3 阶段（2026-09-21 落地）。这一阶段把插件的
> **数据**（文档库替代整文件重写）、**磁盘**（自己的 `files/` 目录）、**配置**
> （自述设置项）和**边界**（`permissions` 真正生效）四件事一起补上。示例
> `examples/plugins/notes/`（速记）把四项全用了一遍，实机脚本
> `scripts/cdp_p3_verify.mjs`（45 项）逐项验收。

### 6F.1 文档库 `ctx.db` / `window.lume.db`

独立的 SQLite 库 `<base>/data/plugin_store.db`（**不在 `lume.db` 里**：卸载 =
删一个文件，插件写坏也波及不到剪贴板历史与固定项）。单表：

```sql
docs(plugin_id TEXT, id TEXT, rev INTEGER, json TEXT, PRIMARY KEY(plugin_id, id))
```

契约与 uTools `utools.db` / CouchDB 同形——文档是一条 JSON **对象**，宿主在读写
时挂上/摘下 `_id`、`_rev` 两个簿记字段：

| 调用 | 语义 |
|---|---|
| `db.get(id)` | 返回文档（含 `_id`/`_rev`），不存在 → `null` |
| `db.put(doc)` | **不带** `_rev` = 新建（已有同 id 文档 → `conflict:`）；带 `_rev` = 覆盖（rev 不符 → `conflict:`）。resolve `{_id, _rev}`（新 rev） |
| `db.remove(doc \| id, rev?)` | 删除。传文档对象即用它的 `_rev`；缺 rev 直接 reject（避免「删掉别人刚写的那版」） |
| `db.allDocs({idStartsWith?, limit?})` | 本插件文档，按 id 升序；**不列 `__` 前缀的宿主文档**；`limit` 默认/上限都是 2000 |
| `db.bulkDocs(docs)` | 单事务写入，**逐条**返回 `{_id, _rev, error}`（某条冲突不影响其它条） |

约束：单文档 ≤ 512 KB、每插件 ≤ 2000 篇、单批 ≤ 1000 篇；`id` 不能为空、不能以
`__` 开头（那是宿主的 `__settings` / `__storage`）。**冲突消息以 `conflict:` 开头**
（如 `conflict: doc "x" is at rev 3, not 2 — re-read it`），插件据此重读后决定
重试或提示；删除**不留 tombstone**，删掉再从 rev 1 开始。

**乐观锁为什么值得**：一个插件页与它的逻辑钩子会并发改同一批数据（用户连点、
异步回包），没有 `_rev` 时后写的会静默覆盖先写的；有了它，落后的那次写入会
明确失败，插件才可能做对。示例里有一行「同一 _rev 写两次」亲眼看到第二次被拒。

**v1 `storage.*` 的兼容垫片**：整个 KV map 存在 `__storage` 文档里，语义不变
（值仍是 JSON 文本）。进程**首次**访问 store 时会把旧的
`<plugin>/storage.json` 搬进该文档，并把文件改名为 `storage.json.migrated`
（**只改名不删**——万一有插件直接读那个文件，数据还在）。旧插件零改动即可继续
跑，新插件请直接用 `db`。

### 6F.2 插件私有文件 `ctx.fs.*`（`<plugin>/files/`）

```js
const path = await ctx.fs.writeText("export.txt", text); // 私有目录，无需权限
await ctx.fs.writeBytes("cover.png", dataUriOrBase64);   // ≤10 MiB
const names = await ctx.fs.listPrivate();                // [{name, size, mtime}]
const text = await ctx.fs.readPrivate("export.txt");     // lossy UTF-8
const abs = await ctx.fs.privatePath("export.txt");      // 交给 openPath / paste / <img src>
await ctx.fs.removePrivate("export.txt");                // 不存在也算成功
```

- 私有目录属于插件自己：**不需要任何权限**，随插件目录一起被用户掌控/删除。
- `name` 只能是**文件名**（不能带 `/`、`\`、`:`，不能是 `.`/`..`，不能以空格或点
  结尾，不能是 `NUL`/`CON`/`COM1`… 这类 Windows 保留设备名——`<dir>\NUL` 是设备
  不是文件，naive 拼接会静默丢弃内容），上限 120 字符、单文件 10 MiB。
- 写**任意绝对路径**是另一回事：`ctx.fs.writeFile(path, text)`，需要 manifest
  声明 `fs.write`（§6F.4）。父目录必须已存在（不静默造目录）。
- 附件的典型用法：`writeBytes` → `privatePath` → `app.openPath` / `clipboard.paste`
  / `search.files`，或直接 `convertFileSrc` 进 `<img>`。

### 6F.3 声明式设置 `[[settings]]`（设置页自动渲染）

`plugin.toml` 里声明，设置 → 插件 每行的「设置项」自动渲染，值存在插件的
`__settings` 文档里：

```toml
[[settings]]
key = "prefix"          # 插件读取的键（必填）
label = "列表前缀"       # 面板文案（空 → 显示 key）
type = "text"           # toggle | select | text（未知类型按 text 渲染）
default = "· "          # 未改动前的值（可省 = null）

[[settings]]
key = "sort"
label = "排序"
type = "select"
default = "newest"

[[settings.options]]    # select 的选项（label 空 → 显示 value）
value = "newest"
label = "最新在前"
```

插件侧：

```js
const all = await ctx.settings.all();      // {prefix: "· ", sort: "newest", …}
const one = await ctx.settings.get("sort");
// 用户一改，宿主立刻把新值推过来（mode 的 onSettings / provider / service 钩子；
// mode 页另收 lume.on.settings 事件）
onSettings(values) { /* 重新渲染 / 重新排序 */ }
```

规则：**manifest 即 schema** —— 只有声明过的 `key` 能写入（`plugin_settings_put`
对未声明的键报 `unknown setting "x" …`，避免作者改键名后老值阴魂不散）；
生效值 = 默认值 ⊕ 用户改过的键；设置窗口与启动器是两个窗口，改动经 Rust 的
`plugin-settings` 事件送到插件实例，页面在 `load` 握手时还会重放一次当前值。

### 6F.4 权限强制层（消费 `permissions`）

`permissions` 不再是预留字段：**没声明的能力，调用即被拒绝**（fail-closed，
未知插件同样拒），拒绝文案带缺失的能力词，并在控制台留一行
`[plugins(id)] permission denied: <method> needs "<perm>" — declared: […]`。

```toml
permissions = ["network", "clipboard", "fs.write"]
```

- **台账**（单一事实源 = §6D.6 表）：`app.notify→notify`、`app.trash→trash`、
  `clipboard.*→clipboard`、`http.request→network`、`dialog.*→dialog`、
  `screen.*→screen`、`search.files→search.files`、`fs.readText/thumb/videoPoster/
  icon→fs.read`、`fs.writeFile→fs.write`。
- **无需声明**：基础动作（`app.hide/toast/setQuery/setPlaceholder/openPath/
  revealPath/resize/setSubInput/redirect`）、插件自有数据（`storage.*`、`db.*`、
  `settings.*`）、私有目录（`fs.writeText` 等）。
- **校验点**：宿主构建插件 API 时逐方法包一层（`guardHostApi`），所以插件
  **逻辑**（跑在启动器窗口、直接持有 API 的那份）与 **mode 页的桥接** 两条路径
  都被覆盖——只在桥接入口拦是不够的（这是本阶段实机脚本抓出来的第一个 bug）。
- **设置页**：每个磁盘插件行显示声明的权限 chips；「全部授权」是开发
  逃生门——开启后所有磁盘插件的一切能力调用放行，用于「插件先跑起来、
  manifest 之后补」的场景。**形态（2026-09-22 起）**：授权开关并入 设置 →
  插件 工具栏的**全局开发者选项**，不再有逐插件开关——「开发者模式」
  （`settings.plugins.dev_mode`，默认关）是总闸与显隐开关，「全部授权」
  （`settings.plugins.trust_all`）只在它开启时显示且生效；`get_plugins`
  在开发者模式关闭时把所有插件上报为 `trusted=false`，残留的 trusted
  列表与 trust_all 都授予不了任何能力。逐插件的 `trusted` 列表仍被
  尊重（`set_plugin_trusted` 命令保留），只是设置页不再写入。内置插件
  （clipboard/preview）编译进 lume.exe，不参与该表。
- **边界要诚实**：前端关卡之上，P5 起还有**命令侧白名单**（`plugin_perm.rs`）：
  每个宿主能力命令在 Rust 侧再校验一次调用方的 plugin_id 与清单声明。mode 页
  已是 opaque-origin 沙箱 iframe（§6C），页面无法触达 Tauri IPC；即便某个沙箱
  被绕开，没有清单背书的能力调用也会在 Rust 层被拒。今天仍然成立的残余边界：
  **跑在启动器窗口里的插件逻辑**（provider/service 的 `entry`，同源、直接持有
  `invoke`）可以冒用任意 plugin_id——那是「显式放置即信任」的既有决定，真正
  关死它需要进程隔离（生态阶段再议）。这一层买到的是**知情同意 + 明确失败 +
  命令侧边界**：能力写在 manifest 里看得见，忘了声明会当场报错而不是悄悄可用。

### 6F.5 验收与示例

- 示例 `examples/plugins/notes/`（速记）：`[[features]]` 保存文本 → `db.put`；
  输入「笔记」列出全部文档 + 一组演示行（`bulkDocs`、乐观锁、导出到私有目录、
  导出到选定路径（dialog + `fs.write`）、清空、以及**故意未声明 network** 的
  `http.request` 与**已声明**的剪贴板写入各一行）。
- 实机脚本 `scripts/cdp_p3_verify.mjs`：45 项，覆盖保存→库内容一致、乐观锁双向
  拒绝、`bulkDocs` 逐条结果、内部文档不可写、权限拒绝/放行、私有文件真的落盘、
  旧 `storage.json` 迁移改名、设置改值后端到端生效、设置页 chips/开关/控件渲染。

---

## 6G. mode 页独立窗口（`detachable`，P6）

清单声明 `detachable = true` 的磁盘 mode 插件可以把页面**分离为独立窗口**：
激活该模式时，页面右上角悬停出现「在独立窗口打开」按钮（⧉）——点击后启动器
隐藏、插件窗口打开；关闭窗口（× 或 Esc）即销毁，模式回到启动器内页形态。
设置 → 插件 的卡片上会显示「可分离」chip。

```toml
kind = "mode"
view = "view.html"
detachable = true     # 允许分离为独立窗口
```

### 6G.1 生命周期

| 动作 | 行为 |
|---|---|
| 分离（按钮） | `plugin_window_open` 创建（或聚焦既有）窗口 `plugin-<id>`，加载 `plugin.html?plugin=<id>`；启动器隐藏 |
| 再次激活 | pill 点击 / Tab 循环 / 关键字 / redirect 进入一个已分离的模式 → 聚焦其窗口（不切启动器页面），启动器隐藏 |
| 就绪握手 | 窗口页监听器就绪后调 `plugin_window_ready` → 启动器注册表推送 `{show, query, enter, settings}`（`plugin-state` 事件）——跨窗口版的 `__lumeReady` 状态重放 |
| 显隐 | 窗口获得焦点/重新打开 → `show` 事件重放 + `onShow` 钩子；窗口隐藏不留事件 |
| 关闭 | × 按钮 / Esc / `plugin_window_close` → 窗口**销毁**（状态不保留，重开重建；插件数据在 `db`/`files` 里不受影响）；宿主记忆窗口几何（`settings.plugins.window_bounds`），下次分离原位打开 |
| 禁用/重载 | settings-applied 后插件被禁用/移除、或 设置 → 插件 点「↻ 重载」→ 独立窗口自动关闭 |

### 6G.2 桥接契约的窗口内差异

窗口内跑的是**同一个沙箱 iframe + `window.lume` 桥接**（§6C），权限层照常。
语义随宿主变化的部分：

| 能力 | 启动器内 | 独立窗口内 |
|---|---|---|
| `app.hide()` | 隐藏启动器 | 隐藏**插件窗口**（再激活 = 重新聚焦） |
| `app.resize({w,h})` | 改启动器窗口高度 | 改**插件窗口**尺寸（宽高独立，最小 360×240） |
| `app.toast(text)` | 启动器底部 toast | 窗口内浮动 toast |
| `app.setQuery` / `setPlaceholder` / `setSubInput` / `removeSubInput` | 生效 | **不可用**（没有共享搜索框，调用被忽略并记 debug 日志） |
| `app.redirect(pluginId, …)` | 切页/投递 | 经 Rust `plugin-window-redirect` 转回启动器路由（目标可以是另一个插件） |
| `lume.on.show` / `hide` | 模式切入/启动器隐藏 | 窗口打开/聚焦 → `show`；无对应 `hide`（关闭即销毁） |
| `lume.on.key` | 模式激活时由根路由转发 | 窗口页直接转发全部非可编辑按键；**未被消费的 Esc 关闭窗口** |
| `lume.on.query` / `subInput` | 搜索框输入 | 不会触发 |

其余能力（`clipboard` / `http` / `dialog` / `screen` / `fs` / `storage` / `db` /
`settings` / `search.files`）两个宿主完全一致。

### 6G.3 实现与边界

- 插件的**逻辑钩子**（`entry` 的 `onShow`/`onQuery`/…）始终跑在启动器窗口
  （注册表），独立窗口只是视图；`onQuery` 在窗口内不会到来（没有共享搜索框）。
- `detachable = true` 声明的窗口是**运行时创建**的（lume 首例）——主窗口/
  设置/预览仍是启动时创建。按插件复用窗口（重复 open = 聚焦）。
- 依赖启动器搜索框的模式（子输入框、query 驱动）**不要**声明 `detachable`。
- 示例 `examples/plugins/hello-mode/`（`detachable = true`）；实机脚本
  `scripts/cdp_plugin_window_verify.mjs`。

---

## 6H. P4 前半：`.lupx` 安装/卸载、前台上下文与 files 规则 `file_type`（2026-09-25）

> `docs/PLUGIN_GAP_ANALYSIS.md` P4 的第一块（ROADMAP #28）。三件事：分发
> 脱离手工拷目录（`.lupx` + 安装确认 + 卸载）、把呼出前的前台窗口信息透出
> 给插件（`app.foreground`，新权限词 `window`）、files 规则按类别匹配并支持
> 文件夹（`file_type`）。浏览器 URL 读取（uTools `readCurrentBrowserUrl`）
> 明确不在本块——完全 UIA 绿地，另立项。

### 6H.1 `.lupx` 打包、安装与卸载

`.lupx` = 一个 zip 包：`plugin.toml` + 插件资产。清单 `plugin.toml` 在**归档
根**或在**唯一顶层目录内**（「右键压缩文件夹」产物可装；前缀外的散文件被
忽略）。打包：`powershell -NoProfile -File scripts/pack_lupx.ps1 <插件目录>
<输出.lupx>`。

**安装流程（设置 → 插件）**：工具栏「安装插件…」→ 选 `.lupx` 文件 → 宿主
`plugin_lupx_inspect` 只读校验并弹**内联确认卡**（名称/版本/kind/描述/
**权限 chips（本地化）**/文件数与大小；已装同 id 显示「将覆盖 vX → vY」）→
确认 → `plugin_lupx_install` 解压换位。这张卡就是权限模型的「安装时知情
同意」时刻。**卸载**：每张磁盘插件卡（内置无）的卸载按钮，两段式确认
（3 秒武装窗口）。

Rust 侧（`plugin_install.rs`）语义：

| 环节 | 行为 |
|---|---|
| 校验 | 清单解析（`parse_manifest`）+ 必须显式声明 `id`（包内无目录名可回退）+ `valid_plugin_id` 字符集；entry 名逐段守卫（`\`→`/` 规范化——PowerShell 兼容、拒绝绝对路径/`..`/保留设备名/控制字符/结尾空格点、单段 ≤120 字符）；单文件 ≤64 MiB、总解压 ≤256 MiB、条目 ≤4096 |
| 换位 | 解压到 `<base>/data/install-staging/<id>-<ts>`（**不在 `plugins/` 下**——半成品不会被扫描发现）→ 旧安装 rename 到 staging 备份 → rename 到位（**失败自动还原旧安装**）→ 清备份 |
| 生效 | 双事件：`settings-applied`（清单刷新）+ `plugin-reload`（已加载模块立即从新文件重 import——**升级无需重启**） |
| 卸载 | 删 `<plugins>/<id>/`（私有 `files/` 随目录走——它就在插件目录里；`data/plugin_store.db` 的文档**保留**）；目录不存在不算错（重复卸载幂等） |
| 残留 | staging 目录在启动时整体清理（崩溃/被杀不留垃圾） |

### 6H.2 `app.foreground` — 前台窗口快照（权限 `window`）

```js
const fg = await ctx.app.foreground();        // iframe 桥接：lume.app.foreground()
fg.process;    // "chrome.exe"（前台进程 exe 文件名；解析不到 = ""）
fg.className;  // "CabinetWClass"（Win32 窗口类，Explorer 文件夹 = CabinetWClass）
fg.title;      // 窗口标题
fg.path;       // 仅当是 Explorer 文件系统视图（Win11 解析活动标签页）
```

- **快照语义**：返回的是**呼出启动器前**的前台窗口（`FocusState.last_hwnd`，
  热键呼出时捕获、复制不取走），不是每次调用实时探测；`null` = 本会话从未
  经热键呼出过。呼出后用户点进别的窗口不会改变这个值——插件要在呼出瞬间
  拿「用户此刻在哪」就是它。
- `path` 与原生 Explorer 上下文栏（导航页「Windows 资源管理器」栏）同一
  COM 解析链；`process` 是新增字段（limited-information 查询，无需提权）。
- **权限 `window`**：新台账行（§6D.6）。没有声明时调用即被拒（前端守卫 +
  Rust `plugin_foreground_context` 命令侧双重校验）。

### 6H.3 files 规则 `file_type` 类别与文件夹匹配

`[[features]]` 的 `files` 规则新增 **`file_type`**（TOML 键 snake_case，同
`min_length` 惯例；前端 JSON 为 `fileType`）：

```toml
[[features]]
code = "handle-folders"
label = "文件夹工具：处理文件夹"
type = "files"
file_type = "folder"     # 只匹配文件夹
min_length = 1

[[features]]
code = "handle-images"
label = "图片工具：处理图片文件"
type = "files"
file_type = "image"      # 图片扩展名类别表（png/jpg/gif/webp/…）
```

类别词表：`image` / `video` / `audio` / `document` / `text` / `folder` /
`others`（= 不在任何类别表里的文件；表在宿主 `registry.ts::FILE_TYPE_EXTS`
内 curated，未映射的扩展名归 others）。**匹配语义**（三选一，按优先级）：

1. `extensions` 非空 → 扩展名匹配，且**文件夹永不命中**（目录名带点不再
   冒充扩展名——这是相对 P2.2 的行为收窄）；
2. 否则 `file_type` 声明 → `folder` 只匹配目录；其余类别只在**文件**上按
   表匹配；
3. 都未声明 → 任意**文件**（不含文件夹——文件夹规则必须 `file_type = "folder"`）。

文件夹判据是真实属性查询：拖入时宿主对新命令 `file_kinds(paths)`（
`GetFileAttributesW`，`file/folder/missing` 逐路径）查询一次，结果与拖入
路径平行存放、随隐藏/呼出清空——一次拖拽一次查询，无逐键 IO。类别未知
（`missing`）的路径按文件处理。`min_length`/`max_length` 语义不变（命中
子集计数）。

示例：`examples/plugins/files-img-demo/`（extensions + folder + image 三类
规则各一条）；实机脚本 `scripts/cdp_lupx_verify.mjs`（23 项）、
`scripts/cdp_p2b_verify.mjs` fileType 段。

### 6H.4 活动窗口匹配（`[[features]] type = "window"`，ROADMAP #29）

按**呼出启动器前的前台窗口**触发：呼出时空查询主菜单出现「<label>」行，
激活把窗口信息投递给 `onFeature`/`onEnter`（`info.window`）。典型用途：
用户正在某应用里 → 呼出 → 插件针对「用户此刻在哪」出动作行。

```toml
[[features]]
code = "notepad"
label = "窗口工具：这是记事本"
type = "window"
process = ["notepad", "notepad.exe"]   # exe 文件名或去 .exe 的 stem，忽略大小写

[[features]]
code = "explorer"
label = "窗口工具：资源管理器文件夹"
type = "window"
class = ["CabinetWClass"]               # Win32 窗口类（精确、忽略大小写）

[[features]]
code = "notepad-verified"
label = "窗口工具：记事本（标题含「验证用」）"
type = "window"
process = ["notepad"]
title = ["验证用"]                       # 大小写不敏感子串；"/…/" 包裹为正则
```

**匹配语义**：字段内 OR（多个值任一命中）、字段间 AND（声明的每个维度都要
命中）；**三个字段都没写 = 永不命中**（与 text 规则「无 regex 无 over 永不
命中」对称）。匹配发生在呼出瞬间（`FocusState.last_hwnd` 的快照）：
`process` 用前台进程的 exe 文件名（`app.foreground` 同源），`class`/`title`
用 `GetClassNameW`/`GetWindowTextW`。

**触发与生命周期**：仅空查询主菜单出现（非空查询不出现，uTools 同）；每次
呼出按新前台重算，隐藏后清空（summon-scoped，与 files 行一致）；有 window
行时网格替代栏目条（与 files/img 行同语义）。

**权限语义**：匹配是宿主侧行为——只看清单声明，**不需要权限**；行 payload
只携带该插件自己命中的窗口信息。插件要**主动**读窗口信息（`app.foreground`
，§6H.2）才需要声明 `window`。

示例：`examples/plugins/window-demo/`；实机脚本
`scripts/cdp_window_feature_verify.mjs`（11 项：process/AND 维度正负例、
payload 投递、summon-scoped 清空、权限拒绝/放行/fail-closed；Explorer 的
class 维度与 path 解析依赖真实 Explorer 窗口激活，自动化不稳定，由示例的
手工步骤覆盖）。

---

## 7. 启停与状态管理

- 启停集 = `settings.toml` 的 `plugins.disabled: string[]`（缺省 = 全启用）。
- **设置 → 插件** 的 toggle 调 `set_plugin_enabled`（轻量写，不触发重量级
  apply 副作用），随后 `settings-applied` 让前端 `refreshPlugins()`。
- **fail-open**：清单里查不到的 id 视为启用（内置插件在首次清单落地前也
  如此）。
- **关闭活动模式插件**：`applyRuntimeSettings` 在 refresh 后校验
  `modeById(mode())`，不存在则自动切回导航页并清空搜索。
- 关闭 provider：结果立即从合并中消失（模块驻留内存，重新启用即恢复）。
- 关闭 preview 服务：卫星窗不再弹出（`enabled` 门控）。

---

## 8. 设置页集成

设置第 8 分区「插件」（`PluginsPane`）自动列出 `get_plugins` 的全部插件：
显示名（回退 id）+ 类型/来源/版本 chips + 启停 toggle。无需为新插件写
任何设置 UI 代码——清单字段齐了，面板就有了。设置搜索框可用关键词：
`插件 / pluginKindMode / pluginKindService / pluginKindProvider /
pluginBuiltin`。

---

## 9. 安全模型

- **动态加载 = 任意代码执行**。信任模型仍是**显式放置即信任**：用户自己把插件
  放进 `<base>/plugins/`。插件代码与启动器同进程、同权限。
- **`permissions` 自 P3.2 起被强制**（§6F.4）：台账（§6D.6）里的能力没声明就
  调用会**明确失败**（fail-closed，含未知插件），设置页每行显示声明的权限 chips，
  「全部授权」是开发逃生门。覆盖范围：`app.notify`、`app.trash`、`clipboard.*`、
  `http.request`、`dialog.*`、`screen.*`、`search.files`、`fs.read*`、
  `fs.writeFile`；基础 UI 动作与插件自有数据（`storage`/`db`/`settings`）与私有
  目录（`<plugin>/files/`）无需声明。
- **P5 沙箱（2026-09-25）**：防线从前端一层变为三层——
  1. **opaque-origin 沙箱 iframe**（§6C）：mode 页与宿主隔离，够不到
     `parent.__TAURI_INTERNALS__` 与启动器 DOM（原 §9 承认的同源绕过已关死）；
     页面数据走 `storage`/`db`，跨域取数走 `lume.http`；
  2. **Rust 命令侧白名单**（`plugin_perm.rs`）：每个宿主能力命令按清单
     `permissions` 校验调用方 plugin_id（fail-closed；原生路径 = main 窗口且
     无 plugin_id）；清单缓存随 `get_plugins`/`reload_plugin` 刷新；
  3. **前端守卫**（`permissions.ts`）：不变，负责知情同意与本地化文案。
- **残余边界（如实说）**：宿主窗口里的插件**逻辑**（provider/service entry）仍
  是同源代码，可直接 `invoke` 并冒用 id——「显式放置即信任」的既有决定；进程级
  隔离（每插件一个 webview/进程）留待生态阶段。签名校验、`.lupx` 安装确认同样
  在生态阶段（P4）；届时台账与设置页的权限 UI 已就位。
- `fs.readText`/`thumb`/`icon`（及 `app.trash`）暴露任意路径的读取与删除能力，
  现已被 `fs.read` / `trash` 声明覆盖。
- 内置插件与磁盘插件在注册表/启停上无差别，但内置代码经编译审计随包发布且不
  参与权限表。

---

## 10. 调试与测试

- **控制台日志**（WebView2 DevTools / CDP；Rust 侧行 stderr——dev 终端
  或重定向可见）。前端统一走 `src/plugins/log.ts` 的 `plog`：宿主侧前缀
  `[plugins]`，带插件 id 时为 `[plugins(id)]`；iframe 页内桥接错误前缀
  `[lume bridge]`。分层：
  - `debug` — 逐调用细节（默认 DevTools 不显示，需勾选 Verbose）：
    `rpc → app.toast {…}`（每次桥接 RPC 及参数）、`event → query`（下发
    给页面的事件）、`app.setQuery/setPlaceholder/resize/…`、清单逐条
    明细、加载跳过原因（`already loaded this session` / `disabled in
    settings` / `no dir`）、`register: mode/navBars`（注册的贡献）。
  - `info` — 生命周期：`manifests refreshed: N (builtin X, disk Y)`、
    `loaded provider/mode/service (…明细)`、`mode view fetching/ready`、
    磁盘插件刷新完成。
  - `warn/error` — 需要处理的：`load failed`（文件缺失/HTTP/语法错误）、
    `provider needs search()`、`unusable manifest`（含缺哪个字段的说明）、
    `unknown lume rpc`、`bad navBars entry`、钩子抛错。
  - Rust 侧（`[plugins]` 前缀）：`scanning <dir>` / `scan: found "<id>"
    (kind=…, version=…)` / `scan: skipping …`（无清单/解析失败）/
    `"<id>" enabled=…` / `list: N plugin(s) total` / `storage get/set/
    remove (<id>) <key> → …`（值只记大小不记内容）/ `db put|remove|allDocs|
    bulkDocs (<id>) …` / `settings set (<id>) <key> = <n bytes>` /
    `fs private write|read|list|remove (<id>) <name> …` /
    `storage migrate: …`（迁移逐插件一行）。
- **CDP 连接**：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
  启动后连 `127.0.0.1:9222`。现成脚本：
  - `scripts/cdp_sandbox_verify.mjs` — 沙箱（P5）：opaque iframe 隔离 +
    桥接/按键/焦点在沙箱内照常 + Rust 命令侧白名单（14 项；探针插件
    `scripts/fixtures/sandbox-probe/` 在沙箱内自检）
  - `scripts/cdp_plugin_window_verify.mjs` — 独立窗口（P6）：分离 →
    状态握手 → 聚焦/enter 投递 → Esc 销毁 → 几何记忆 → 禁用自动关窗（12 项）
  - `scripts/cdp_p3_verify.mjs` — P3 数据层/权限/私有文件/设置（45 项；
    其设置页面板一段的选择器落后于 26b0f3b 的插件页重设计，5 项历史性
    失败，与本轮无关）
  - `scripts/cdp_lupx_verify.mjs` — `.lupx` 安装/卸载（P4 前半）：inspect
    形状与拒绝路径 → 安装未重启可用 → subdir/升级/卸载 → 设置页按钮与
    两段式卸载（23 项）
  - `scripts/cdp_p2b_verify.mjs` — P2 余项 + P4 `file_type`：files 拖入 /
    img 剪贴板图片 / template="list" 列表模板 / 磁贴指针重排 /
    folder·image·extensions 类别匹配（20 项）
  - `scripts/cdp_plugin_verify.mjs` — provider 行 + 沙箱化 mode 页 +
    插件面板截图
  - `scripts/cdp_settings_smoke.mjs` — 8 分区设置冒烟
  - `scripts/cdp_launcher_shots.mjs` — 启动器截图（前后对比）
- **手工验证清单**：放入插件 → 重启 → 设置/插件可见 → 搜索出现结果行 →
  启停 toggle 即时生效 → 关闭活动模式插件自动回导航页；mode 页可另验
  `setPlaceholder` 按钮（§5C）与 DevTools Verbose 下的 RPC 轨迹；P3 面可验
  设置项渲染与改动后插件 toast、以及未声明能力的拒绝文案；detachable 模式
  可验「在独立窗口打开」→ 窗口内 toast/resize → Esc 关闭 → 再分离原位恢复
  （§6G）。
- **改前端后必须重新 `cargo build` 再跑 CDP 冒烟**：debug/release exe 的
  `frontendDist` 资源是**编译期嵌进二进制**的，只跑 `vite build` 时 exe 仍在
  服务上一版 bundle（本轮排查「权限层不生效」的真凶）。

---

## 11. 兼容性与版本化

- v1 没有 manifest 版本字段与协商机制——契约变更以「字段只增不改义」的
  方式演进；`kind` 是分发键，新增贡献类型会引入新的 kind 值。
- `ModeInstance.rows` 目前与剪贴板行形状（`ClipboardItem`）耦合，泛化为
  任意模式自定义行模型留待后续。
- 磁盘插件的 JS 在 blob URL 中执行：可用标准 Web API 与标准 ESM 语法
  （`export`），但**不能 `import` 项目内部模块或第三方包**（无解析根）。
- **插件数据的落点变了（P3.1）**：`storage.json` 已迁到 `<base>/data/plugin_store.db`
  的 `__storage` 文档（旧文件改名为 `storage.json.migrated` 保留）。`storage.*`
  旧调用语义不变，但**换机/备份时不要只拷 `plugins/`**——插件数据在 `data/` 里。

---

## 12. 路线

已完成（细节见对应章节与 `docs/ROADMAP.md` #23–#28）：

- ✅ 权限强制层（`permissions` → 逐 RPC 校验 + 设置页 chips + 全部授权）—— §6F.4
- ✅ 宿主能力面：HTTP 代理（打掉 CORS）、系统通知、剪贴板图片/文件、对话框、
  屏幕（P1）—— §6D
- ✅ 进入方式矩阵：regex/over 声明式进入、文件拖入（files）、剪贴板图片（img）、
  子输入框、provider 二级下钻、插件互跳、内置列表模板（P2 全量）—— §6E
- ✅ 插件级设置界面（`[[settings]]` → 设置页自动渲染 → `onSettings`）—— §6F.3
- ✅ storage → SQLite 文档库（`_rev` 乐观锁 + allDocs/bulkDocs + 自动迁移）—— §6F.1
- ✅ 插件私有文件目录（`<plugin>/files/`）与 `fs.write` 能力 —— §6F.2
- ✅ 沙箱机制（opaque iframe + Rust 命令侧白名单 + 前端守卫双层防线）—— §6C、§9
- ✅ mode 页独立窗口（`detachable` 清单字段 + 运行时插件窗口 + 跨窗口状态推送）—— §6G
- ✅ `.lupx` 打包、安装确认与卸载；`app.foreground`（`window` 权限）；
  files 规则 `file_type` 类别与文件夹匹配（P4 前半）—— §6H.1–6H.3
- ✅ 活动窗口匹配（`[[features]] type = "window"`，process/class/title
  维度，呼出时快照匹配）—— §6H.4

未做（见 `docs/PLUGIN_GAP_ANALYSIS.md` P4 后半）：

- `.lupx` 市场源（静态索引 + 应用内安装 + 版本提示）、签名校验、
  拖包/文件关联安装
- 浏览器 URL / 划词捕获（UIA）、超级面板、AI 宿主 API
- 宿主窗口内插件逻辑的进程级隔离（沙箱已覆盖 mode 页与命令侧，§9 残余边界）
