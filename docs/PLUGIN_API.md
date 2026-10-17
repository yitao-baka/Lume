# Lume 插件 API 参考（关于「为什么不做」的决策依据与已落地能力的实现细节见 docs/ROADMAP_HISTORY.md。v1）

> 快速上手指南见 `docs/PLUGINS.md`；本文是完整的 API 参考：清单字段、三类贡献、
> 桥接契约、宿主能力、数据与设置、打包安装、安全模型与调试手段。
> 所有契约以源码为唯一事实源：`src/plugins/types.ts`（契约与注册单元）、
> `src/plugins/registry.ts`（注册表与加载器）、`src-tauri/src/plugins.rs`
> （清单发现与校验）。

---

## 1. 模型总览

Lume 插件 = **一份清单**（`plugin.toml`）+ **零或多份贡献**（contribution）。
注册表按 id 把两者关联，启停状态来自 `settings.plugins.disabled`。

```
<base>/plugins/<id>/           ← 磁盘插件（便携版 = exe 同级；安装版 = %LOCALAPPDATA%\Lume）
├── plugin.toml                ← 清单（§3）
└── main.js                    ← 入口（provider 类；kind 决定是否需要）
```

**贡献类型**：

| 贡献 | 契约 | 动态加载 | 内置示例 | 磁盘示例 |
|---|---|---|---|---|
| `provider` | `ProviderInstance` — 向 Navigate 搜索追加结果 | 支持 | `web-search`（examples/） | — |
| `mode` | `ModeInstance`（内置）/ **桥接 iframe 页**（磁盘） | 支持 | `clipboard` | `hello-mode`、`file-search`（examples/） |
| `service` | `PreviewService`（内置）/ **生命周期钩子**（磁盘） | 支持 | `preview` | — |
| `navBars` | `NavBarContribution[]` — 导航页栏目（§5.7，任意 kind 可选钩子） | 支持 | — | `nav-bar`（examples/） |

内置插件（clipboard/preview/apps）走与磁盘插件相同的注册表与启停路径；区别
只在它们的代码编译进 lume.exe、不参与权限表（§14）。

**生命周期**：

```
启动 → Rust 扫描 plugins/*/plugin.toml（坏清单跳过）
     → 前端 App 组合根创建内置插件并 definePlugin()
     → refreshPlugins(): get_plugins 拉清单（含 enabled 态）
       → loadDiskPlugins(): 磁盘插件经 asset 协议读文件 + 沙箱帧加载
设置变更/插件启停 → settings-applied → refreshPlugins() 重新同步
     → 若活动模式被禁用 → 自动回导航页
```

**运行中安装新插件**：下一次 `settings-applied`（任一设置保存、任一插件
启停）时加载；重启必然加载。已加载的插件每个会话只尝试一次（§4.3）。

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
kind = "provider"       # 必填 — provider/mode/service
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

完成。重启 Lume（或任一设置变更触发 settings-applied，或声明
`development = true`/点「↻ 重载」）后，Navigate 搜索结果末尾会出现插件返回
的条目；**设置 → 插件** 里可启停。可运行的完整示例：
`examples/plugins/web-search/`。

要拿到宿主能力（toast/剪贴板/文档库/设置…），把默认导出写成**工厂函数**
（§5.1）；用了权限台账里的能力要在清单写 `permissions = [...]`（§8.2）。
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
| `permissions` | string[] | `[]` | **能力声明**：台账（§8.2）里的能力没声明就调用 → 明确拒绝（fail-closed），设置页每行显示这些 chip。「全部授权」可整插件放行（§11.4）。 |
| `entry` | string | `""` | 入口 JS（相对插件目录）。provider 必填；mode 可选（逻辑钩子）；service 必填（钩子）。**可以是目录**（多文件打包产物）— 此时实际加载其中的 `index.js`，目录内文件的相对 `import` 由宿主改写为 blob URL（§5.5）。 |
| `view` | string | `""` | **mode 专属** — 视图 HTML 页（相对插件目录），渲染进桥接 iframe（§6）。 |
| `titlebar` | string | `""` | **mode 专属，仅独立窗口**（§6.8）— 标题栏 HTML 页（相对插件目录）：渲染为标题与窗口控制按钮之间的第二个桥接 iframe，与 `view` 同一沙箱与 `window.lume` 能力（uTools 式搜索框等自由内容）。launcher 内嵌时忽略。示例 `examples/plugins/titlebar-demo/`。 |
| `template` | string | `""` | mode 插件：`"list"` = 用内置列表模板渲染 `entry` 逻辑的行，**免 `view` HTML**（§10.4） |
| `keywords` | string[] | `[]` | **mode 专属** — 全局关键字：Navigate 输入匹配关键字时，结果里出现「进入 <name>」行，激活即切进该模式（uTools 式进入）。行图标 = 插件自己的图标集（两套按所在表面主题选）。匹配分级：**精确 → 前缀 → 拼音首字母前缀 → 拼音全拼前缀**（拼音由后端预计算，输入 `miao`/`ms` 可匹配「秒搜」；见 §5.6）。 |
| `development` | bool | `false` | **开发模式** — 每次插件刷新（settings-applied，含任一设置保存）都从磁盘重新加载本插件，改代码无需重启。设置 → 插件 每行的「↻ 重载」按钮可对任意磁盘插件手动触发同等效果（§4.4）。 |
| `api` | integer | `1` | **目标宿主 API 版本** — 插件针对的契约版本（§16）。缺省 = 当前宿主版本（旧清单零改动）；声明**高于**宿主支持的版本（`HOST_PLUGIN_API`）→ 加载期明确拒绝 + toast 提示，而不是静默半坏。 |
| `network_allow` | string[] | `[]` | **网络白名单** — `network` 能力的私网放行名单（§8.1 http）：默认拒绝回环/私网/链路本地目标（防 SSRF），`network_allow = ["192.168.1.10", "*.internal.example.com"]` 声明的 host（精确或 `*.` 通配后缀，大小写不敏感）跳过该检查。公网访问无需声明。 |
| `settings` | array of table | `[]` | **声明式设置**（§11.3）——`[[settings]]` 子表：`key`、`label`、`type`（`toggle`/`select`/`text`）、`default`、`[[settings.options]]`（`value`/`label`）。设置 → 插件 自动渲染，值存插件 `__settings` 文档，插件经 `ctx.settings.get/all` 读、`onSettings` 感知变更。 |
| `features` | array of table | `[]` | **声明式进入规则**（任意 kind，§9.1）——`[[features]]` 子表，字段 `code`（必填，进入时下发）、`label`（结果行文案）、`regex`（正则匹配输入）、`over`（匹配任意非空文本）、`min_length`/`max_length`（长度界）、`icon`（旧版单图行图标）、`icon_light`/`icon_dark`（两套行图标；显式变体优先，一组都没给 → 用插件自己的图标集）。命中的查询在导航结果里出现「<label>」行，激活把该查询作为 payload 投递给插件的 `onFeature`/`onEnter`。`type = "files"`（文件拖入，含 `file_type` 类别，§9.2）、`"img"`（剪贴板图片，§9.3）与 `"window"`（活动窗口匹配，§9.4）规则见对应小节。 |
| `height` | integer | — | **mode 专属** — 本模式页面的窗口高度（逻辑 px）。省略 = 全局 设置 → 窗口大小 → 高度；前端会钳制到工作区高度（§6.10）。分离窗口的默认高度同样取它（§6.8）。 |
| `detachable` | bool | `false` | **mode 专属**（§6.8）— 页面可以分离为独立窗口：设置页显示「可分离」chip，激活该模式时页面右上角悬停出现「在独立窗口打开」按钮（插件也可经 `lume.app.detach()` 自绘按钮触发，§6.1）。依赖启动器搜索框交互（`setSubInput`/`setQuery` 驱动）的模式不要声明。 |
| `detach_button` | bool | `true` | **mode 专属 + `detachable` 配套**（§6.8）— 宿主是否在模式页右上角渲染内置的悬停「在独立窗口打开」按钮。插件自绘分离按钮（常驻、纯图标…）时设 `false` 把右上角完全让给页面，分离走 `lume.app.detach()`（§6.1）。 |
| `hidden` | bool | `false` | **mode 专属** — 在模式切换栏（pill）与切换键（Tab）循环中隐藏本模式：不渲染 pill、Tab 不切入（模式激活时 Tab 从导航页重新开始）。唯一入口是导航页搜索结果：keywords 的「进入 <name>」行、`[[features]]` 命中行与插件互跳（`app.redirect`）。设置 → 插件 卡片会显示「仅搜索进入」徽标；插件仍然可以被启停。示例：`examples/plugins/hidden-mode/`。 |
| `keep_session` | bool | `false` | **mode 专属** — 闲置重置（启动器隐藏超过设置阈值后的下一次呼出，§6.6）时保留本模式会话状态的**声明式默认**：查询、页面状态、保活宿主与会话帧都不动。用户可在 设置 → 插件 逐插件覆盖（`settings.plugins.keep_session_overrides`，用户值优先）。适合「状态 = 未保存草稿」的页面；不改变「超阈值先回导航页」这一点。示例：`examples/plugins/state-probe/`。 |
| `icon` | string | `""` | **旧版单图（兼容）** — 模式 pill（与 Tab 循环）的图标文件（相对插件目录，或 `data:`/`http(s):`/`asset:`/`blob:` URI）。省略 = 不显示图标。**同时是本插件在导航搜索结果里的默认行图标**：keywords 行、没有自己 `icon` 的 provider 结果与 feature 行都用它（没有才回退到 `path` 常规图标管线）。旧图表现不变：在本来就按 `--icon-filter` 反相的位置（模式 pill、列表模板行）深色下仍反相；结果网格/设置卡片沿用原样。分离窗口（§6.8）的任务栏图标同源。 |
| `icon_light` | string | `""` | **浅色界面变体** — 浅色表面显示的那套图（通常是深色描边），相对插件目录（URI 规则同上）。省略 → 回退 `icon`（仍没有 → 用另一套）。显式变体一律**按原样渲染、不再反相**。 |
| `icon_dark` | string | `""` | **深色界面变体** — 深色表面显示的那套图（通常是浅色描边）。省略 → 回退 `icon`（仍没有 → 用另一套）。 |

**解析规则**（`plugins.rs::parse_manifest` / `scan_disk_plugins`）：

- TOML 语法错误 → 该插件被**静默跳过**（stderr 记录 `[plugins] skipping …`），不影响其它插件。
- 非 `plugin.toml` 的散文件、无清单的子目录一律忽略。
- 清单里的字段拼错会被 toml 解析器**忽略**（不会报错）——拼写要对照上表。
- 磁盘插件清单按 id 排序后合并进列表；内置插件（clipboard/preview）始终排在前面。

**图标深/浅两套**：`icon_light` / `icon_dark`（以及运行时行上的
`icon: { light, dark }`）由宿主决定显示哪一套 —— 按图标**所在表面**的当前
生效主题：启动器内的搜索结果行 / 模式 pill / 列表模板行 / 设置页卡片跟随
启动器（设置窗口）自己的主题（`system` 跟 OS 实时）；独立插件窗口的
任务栏 / Alt+Tab 图标跟随**该插件的生效主题**（`lume.theme.set` 覆盖优先，
与窗口画布/chrome 一致）。选择顺序：浅色表面 `icon_light` → `icon` →
`icon_dark`；深色表面 `icon_dark` → `icon` → `icon_light`。命中旧
`icon` 时保持旧行为；命中显式变体时原样渲染（不反相）。主题运行中切换时，
已经显示的行/胶囊/任务栏图标即时换套（无需重跑搜索）。插件 iframe 页面
内部的图仍由插件自己负责（页面已收 `on.theme`）。示例：
`examples/plugins/themed-icons/`。


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
  entry: string;            // 磁盘插件的入口文件（可为目录）；内置为 ""
  dir: string;              // 磁盘插件绝对目录；内置为 ""
}
```

### 4.2 前端侧（`src/plugins/registry.ts`）

`refreshPlugins()` 在两处被调用：**App 组合时**（启动）与每次
**`settings-applied`**（设置窗口保存 / 插件启停 / 导入恢复）。流程：

1. `invoke("get_plugins")` 拉清单 → 存入响应式 signal（设置页据此渲染）。
2. `loadDiskPlugins()`：遍历清单，加载所有「未加载过 + 非内置 + `enabled`
   + 有 `entry`/`dir`」的插件，按 `kind` 分流 — `provider`（§5）、
   `mode`（桥接 iframe 页，§6）、`service`（生命周期钩子）；任意 kind 都可带
   `navBars` 钩子（§5.7）。

加载一个磁盘插件的步骤：

1. 读入口文件（经 asset 协议），标准 ES Module 语义（可用 `export`，
   不可 `import` 项目内部模块）。
2. 校验默认导出：provider 需 `default.search` 是函数（否则
   `console.error("[plugins] bad default export …")` 并放弃）；mode/service
   需对应钩子形状。
3. 合格则包装成注册表中的贡献，`console.log("[plugins] loaded provider: <id>")`
   一类日志记录结果。

**失败语义**：

- 每个磁盘插件 id 每会话**只尝试加载一次**——进入流程即标记
  `loadedDiskIds`，失败（文件缺失 / HTTP 错误 / 语法错误 / 形状不对）
  不重试。改完插件代码需要**重启 Lume**（或用 §4.4 的重载手段）。
- 加载失败、运行期钩子抛错，都只影响该插件自己。
- 查询 `get_plugins` 失败 → 保留上一次清单状态，插件是可选能力，从不阻塞
  启动器。

### 4.3 加载与禁用语义

- **单次加载**：加载器用 `loadedDiskIds` 保证每个 id 每会话只加载一次
  （无论成败）。修改插件代码 → 设置 → 插件 点「↻ 重载」，或重启 Lume
  （§4.4）；清单声明 `development = true` 的插件每次刷新自动重载。
- **禁用**：设置 → 插件 关闭后，`settings.plugins.disabled` 记录 id →
  `providerPlugins()` 的 enabled 过滤把它的结果从合并中剔除——**但模块
  仍驻留内存**（v1 不卸载已加载模块）。重新启用立即恢复结果，无需重启。
- **关闭活动模式插件**：refresh 后校验当前模式仍然存在，不存在则自动切回
  导航页并清空搜索。
- **内置 provider**（如果有）与磁盘 provider 走同一合并管线。

### 4.4 热重载

- **手动**：设置 → 插件 每个磁盘插件行的「↻ 重载」按钮 → Rust `reload_plugin`
  命令 → `plugin-reload` 事件 → 前端注册表卸载并重新从磁盘加载该插件
  （含清单重读：改 `keywords`/`height`/`icon` 同样生效）。内置插件无此按钮。
- **自动（settings-applied）**：清单 `development = true` → 每次 settings-applied
  （任一设置保存、任一插件启停）都先卸载再重载。
- **自动（目录监听）**：开发者模式开启时（设置 → 插件 → 开发者模式），
  Rust `plugin_devwatch.rs` 递归监听 `<base>/plugins`（内核事件、零轮询），
  文件变动静默 800ms 后发 `plugin-dev-changed` → 前端走与 settings-applied
  相同的重载路径。**改代码保存即生效，无需任何点击**。
- 重载会清空模块缓存（§5.5）；若重载的是当前激活的 mode，模式实例被整体
  替换（查询清空，页面重建）。重载窗口期内的 hook 调用快速失败（不计熔断）。

---

## 5. Provider 插件 API（磁盘 JS）

### 5.1 入口契约

入口文件是**标准 ES Module**，默认导出必须是以下两者之一：

1. **纯对象**（无宿主能力）：

```ts
export default {
  search(query: string): Promise<ProviderResult[]>
  onEnter?(item: ProviderResult): void   // 可选 — `enter` 条目的激活回调
};
```

2. **工厂函数**（要宿主能力时用）— 宿主以 `ctx`（§8）调用一次，返回值即上面的对象：

```js
export default function create(ctx) {
  return {
    async search(query) { /* … */ },
    onEnter(item) { /* … */ },
  };
}
```

| 成员 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `search` | `(query: string) => Promise<ProviderResult[]>` | 是 | 同步返回数组也可以（加载器会 `Promise.resolve` 包装）。 |
| `onEnter` | `(item: ProviderResult) => void` | — | 用户激活带 `enter` 标记的条目时回调；收到的是 `search` 返回的那个对象（自定义字段原样保留）。见下。 |
| `onFeature` | `(info: {code, type, payload, paths?}) => void` | — | `[[features]]` 规则命中且无 mode 页时回调（§9）。 |
| `navBars` | `() => NavBarContribution[]` | — | 导航页栏目贡献（§5.7）。 |

`ProviderResult`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | 是 | 结果条目显示名（网格里单行省略）。 |
| `path` | string | — | 文件绝对路径 **或** URL。声明了 `enter` 的条目可省略（动作条目不打开任何东西，宿主生成合成去重键）。激活时经 `launch_app`（`ShellExecuteW`）打开。 |
| `description` | string | — | 可选副行，显示在名字下方（结果网格两行形态）。 |
| `icon` | string \| `{ light?, dark? }` | — | 可选显式图标：字符串形式是 `data:`/`http(s):`/`asset:`/`blob:` URI 或文件路径（**相对路径相对插件目录**）；`{ light, dark }` 为两套变体（取值规则相同），宿主按所在表面主题选一套并按原样渲染。省略（或对象里一个都没有）= 用插件清单的图标集；都没有才走 `path` 的常规图标管线。 |
| `enter` | boolean | — | 标记：激活本条目**不调 `launch_app`**，改为回调 provider 的 `onEnter(item)`；启动器保持打开，插件自行决定何时 `ctx.app.hide()`。 |
| `drill` | boolean | — | 声明下钻行：激活改为调 `select(item)`（§10.2）。 |

#### `enter` 动作条目

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
- 合并规则（导航页 apps 分支，`src/plugins/navigate/search.ts`）：
  1. 原生索引结果（`search_apps`）与文件搜索命中构成**正常结果网格**
     （文件命中按 `path` 与原生结果去重，合计封顶 **20**）；
  2. 每个**已启用** provider 的返回条目落在网格下方的**「推荐使用」块**
     ——与 `lume-mode://` 关键字行、feature 行同块，以标题分隔行与正常
     结果隔开；关键字/feature 行不被 20 条封顶挤掉，provider 与
     文件命中共享该预算；
  3. 按 `path` 全局去重（与原生结果、与其它 provider 之间都去重）；
  4. 整个过程用根搜索令牌（`searchToken`）守卫——期间有新按键搜索，
     迟到的结果被丢弃。
- **激活路径**：普通条目与原生条目完全一致 — 点击/Enter → `launch_app`
  （URL 走默认浏览器，文件走 ShellExecute）。**图标优先级**：条目的
  显式 `icon`（字符串或 `{light,dark}` 两套；URI 或相对插件目录的
  路径）→ 插件清单图标集（`icon_light`/`icon_dark`/`icon`，按所在表面
  主题选）→ `path` 的常规 `get_app_icons` 管线（取不到 → 未知图标回退）。
  声明了 `enter` 的条目改为回调 `onEnter(item)`（§5.1）。
- **错误隔离**：单个 provider 的 `search` 抛错/拒绝 →
  `console.error("provider search failed: <id>")`，其它 provider 与原生
  结果不受影响。

### 5.3 能力边界（v1 provider 不能做什么）

- 无法访问启动器内部模块（i18n、store、图标缓存……）——插件脚本是独立
  作用域，只有标准 Web API + Tauri 注入的全局（`window.__TAURI_INTERNALS__`
  技术上可达，但**不属于契约**，随版本可能变化）。
- 无法贡献整页模式、右键菜单动作或卫星预览——那些是内置 mode/service
  贡献的能力（§7）。
- **能用哪些宿主能力由 manifest 的 `permissions` 决定**：
  没声明就调用会明确失败（§11.4）。插件自有数据（`db`/`storage`/`settings`）
  与私有目录（`<plugin>/files/`）不受限。

### 5.4 完整参考示例

- `examples/plugins/web-search/` — 最小 provider（每查询追加一个 Bing 条目）。
- `examples/plugins/notes/` — 文档库（`db.put/allDocs/bulkDocs` +
  乐观锁）、私有目录导出、声明式设置（`[[settings]]` + `onSettings`）、以及
  权限层两向对照（未声明 `network` 被拒 / 已声明 `clipboard` 放行）。
- `examples/plugins/host-tools/` — 宿主能力（HTTP/通知/对话框/剪贴板/屏幕）。
- `examples/plugins/actions/` — `enter` 动作条目 + `description` 副行 +
  显式 `icon` + **多文件入口**（`entry = "dist/"` + 相对导入，见 §5.5）。
- `examples/plugins/text-tools/` — features + 下钻（drill/select/filter）+
  redirect。
- 安装：把整个目录拷进 `<base>/plugins/`，重启或触发一次 settings-applied，
  然后在 设置 → 插件 里确认它处于开启状态。

### 5.5 多文件入口（entry 目录）

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

### 5.6 关键字匹配分级（mode `keywords`）

Navigate 输入按以下优先级匹配关键字（多插件命中时按级排序，同「进入」行合并）：

| 级 | 匹配 | 例（关键字「秒搜」） |
|---|---|---|
| 0 | 精确（大小写不敏感） | `秒搜` |
| 1 | 关键字前缀 | `秒` |
| 2 | 拼音首字母前缀 | `ms` |
| 3 | 拼音全拼前缀 | `miao` / `miaosou` |

拼音形式由 Rust 在扫描清单时预计算（`pinyin` crate）并随 `get_plugins` 下发
（`keywordsPinyin`），前端不做拼音转换。命中产生的「进入 <name>」行默认用
插件清单 `icon` 作行图标（同 `hidden` 模式的唯一入口行）。

### 5.7 导航页栏目（navBars）

任何磁盘插件（provider/mode/service 不限）都可以在工厂逻辑对象上实现
`navBars()`，向**导航页空查询主菜单**贡献栏目：

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
| `id` | string | 是 | 栏目 id，插件内唯一；宿主加 `<插件id>:` 前缀作为键盘导航 zone 键。 |
| `title` | string | 是 | 栏目标题，原样渲染。 |
| `items` | `{ name, path, icon? }[]` | 是 | 每栏封顶 50 条；name/path 必填，坏条目丢弃并记控制台日志。 |

- **渲染位置**：「已固定」之后（内建的「推荐使用」栏之后）、「Windows
  资源管理器」之前，多个栏目按插件注册序排列；**explorer 栏始终位于最下层**
  （结构性固定，插件栏不可越过）。
- **条目激活**：与原生栏条目完全一致 — 点击/Enter → `launch_app`（文件与
  URL 都可以）→ 启动器隐藏；右键 → 共享 app 菜单（固定/启动/打开位置/管理
  员启动）。
- **图标**：`icon` 可省 — 文件路径走 `get_app_icons` 管线（取不到 → 未知图
  标回退）；`data:`/`https?:`/`asset:`/`blob:` URI 直接使用，其它字符串按
  文件路径经 asset 协议解析（相对路径相对插件目录）。也可给
  `{ light, dark }` 两套，宿主按所在表面主题选一套、显式变体按原样渲染。
- **调用时机**：组合时、每次呼出（`launcher-shown`）、每次插件刷新
  （settings-applied）。可返回 Promise（宿主等待）；单插件抛错/坏形状只影
  响它自己。动态栏目（按 `ctx.storage` 状态返回不同条目）因此可行。
- **键盘导航 / 展开**：与原生栏一致 — 参与连续网格导航（↑/↓/←/→ 跨栏保
  列），超过一栏宽度出现「展开」，展开态撑满工作区。
- **空栏目**（items 为空）不渲染；返回 `[]` 或不实现钩子 = 不贡献。

完整示例：`examples/plugins/nav-bar/`。


---

## 6. Mode 页桥接契约（window.lume）

### 6.1 RPC 面

mode 页是 srcdoc iframe，运行在 **opaque-origin 沙箱**里（iframe 带
`sandbox="allow-scripts allow-forms allow-popups allow-modals"`，**无**
`allow-same-origin`——页面够不到宿主文档、`parent.__TAURI_INTERNALS__` 与
启动器 DOM，也不能导航顶层窗口；代价见 §6.1.1「沙箱边界」）。注入的桥接
客户端暴露一个 Promise RPC 对象 `window.lume`（方法拒绝时 reject；桥接层
捕获并 `console.error`，返回 `undefined`——**每条 RPC 都要判空**）：

| 组 | 方法 | 说明 |
|---|---|---|
| `env` | `form: "launcher" \| "window"` | **宿主形态常量**：同步字符串，注入桥在页面脚本运行前钉死——`"launcher"` = 启动器主窗口内嵌页，`"window"` = 独立窗口内的 view/titlebar 帧；逻辑帧（§6.9）恒为 `"launcher"`。**判别宿主形态只用它**——不要数父文档 iframe 数：keep-alive 让启动器同时挂着多个已访问模式页（iframe 数 ≥ 2 是常态），数法会误判 |
| `app` | `hide()` / `toast(text, opts?)` / `setQuery(q)` / `setPlaceholder(text)` / `openPath(path)` / `revealPath(path)` / `trash(paths)` / `resize({width?, height?})` / `notify(title, body)` / `setSubInput(opts?)` / `removeSubInput()` / `redirect(pluginId, opts?)` / `detach()` | 与内置工厂 `ctx.app` 同面。`setPlaceholder` 自定本模式搜索框占位文字（§6.10）；`openPath` 经 `launch_app`（文件/URL 均可）并标记「已使用条目」；`revealPath` 在 Explorer 中定位并选中目标（**不**标记「已使用条目」、**不**隐藏启动器——打开位置后用户通常还要继续搜，是否隐藏由插件自定）；`trash(paths)` 把文件/文件夹批量送入回收站（无永久删除回退，失败即 reject；宿主不做确认框，删除确认由插件自行用 toast/UI 二次确认实现）；`notify(title, body)` 系统通知（§8.1）；`setSubInput`/`removeSubInput` 接管/交还搜索框（§10.1）；`redirect(pluginId, {code?, payload?})` 跳到另一个插件（§10.3）；`detach()` 把本模式分离为独立窗口（§6.8）——`detachable` 插件自绘分离按钮（常驻/纯图标等形态自定）时调用它，快照/建窗/回放与宿主内置悬停按钮同一条路 |
| `theme` | `set(mode)` / `get()` | **本插件自己的颜色模式**：`"system"`（跟随启动器）/ `"light"` / `"dark"`。只作用于本插件 —— 本模式页画布、独立窗口的 chrome 与任务栏图标一起切，**启动器自身主题不受影响**；宿主落盘（`settings.plugins.color_modes`），重启与独立窗口首帧即生效。`get()` 返回 `{pref, mode, host}`。非法取值 reject。免权限（插件本地 UI，§8.2）。细节见 §6.7 |
| `clipboard` | `readText()` / `writeText(text)` / `writeImage(data)` / `writeFiles(paths)` / `readFiles()` / `readImage()` / `paste({text?, image?, files?})` | 系统剪贴板：文本读写、图片（base64 或 `data:image/png;base64,…`）、文件列表（CF_HDROP，Explorer 式复制）、读回文件列表；`readImage()` 返回 PNG data URI（无图 = null；`img` feature 的取数路径，§9.3）；`paste` 写入单个载荷并 Ctrl+V 到启动器呼出前的前台窗口（§8.1） |
| `http` | `request({url, method?, headers?, body?, bodyBase64?, timeoutMs?})` | **宿主 HTTP**——请求在 Rust 侧经 WinHTTP 发出（Schannel TLS + 系统代理），**不受页面 CORS 限制**；返回 `{status, headers, body(base64), truncated, text(), json()}`。仅 http/https；默认超时 10s（钳制 1–60s）；响应体 4MiB 截断并置 `truncated`（§8.1） |
| `dialog` | `open({title?, defaultPath?, fileName?, filters?, multiple?, folder?})` / `save({…})` | 原生文件选择/保存对话框。`open` 返回选中路径数组，`save` 返回路径或 `null`；**取消不是错误**（`[]` / `null`），由插件决定提示文案 |
| `screen` | `cursor()` / `displays()` | 光标位置与显示器列表，单位是**物理像素**；`displays()` 每项含 `x/y/width/height`、工作区 `workX/workY/workWidth/workHeight`、`primary` |
| `fs` | `readText(path)` / `bytes(path)` / `thumb(path)` / `videoPoster(path)` / `icon(paths)` / `writeText(name, text)` / `writeBytes(name, base64)` / `readPrivate(name)` / `listPrivate()` / `privatePath(name)` / `removePrivate(name)` / `writeFile(path, text)` | 文件读写能力。读取与任意路径写入（`writeFile`）**需要声明**（`fs.read` / `fs.write`，§8.2）；`readText` 返回文本内容（lossy-UTF8 解码；**> 512KB reject**——插件自行显示「预览前 512KB」类提示）；`bytes` 返回**原始字节**（base64，≤ 32 MB，超出 reject）——沙箱后页面是 opaque origin，`fetch(asset://)` 被 CORS 拒绝，pdf.js/SheetJS 这类要在 JS 里解二进制的渲染器从这里取字节；`thumb` / `videoPoster` 返回 base64 PNG data URI（可直接进 `<img src>` / `poster`；shell 无缩略图提供者时 reject）；`icon` 返回与 `get_app_icons` 同形的 `{path, icon}[]`（icon 为 data/asset URI 或 null）。`writeText`/`writeBytes`/`readPrivate`/`listPrivate`/`privatePath`/`removePrivate` 操作**插件私有目录** `<plugin>/files/`（无需权限，单文件 10 MiB，`name` 只能是文件名 —— 见 §11.2） |
| `storage` | `get(key)` / `set(key, value)` / `remove(key)` | 插件私有 KV —— v1 契约的**兼容垫片**，内部就是文档库里的 `__storage` 文档（§11.1）；新代码请用 `db` |
| `db` | `get(id)` / `put(doc)` / `remove(doc\|id, rev?)` / `allDocs({idStartsWith?, limit?})` / `bulkDocs(docs)` | **文档库**（§11.1）：uTools/CouchDB 形状的文档（`_id` + `_rev` 乐观锁），持久化在 `<base>/data/plugin_store.db`。冲突 reject，消息以 `conflict:` 开头 |
| `settings` | `all()` / `get(key)` | 本插件声明式设置的**生效值**（manifest 默认值 ⊕ 用户改过的值，§11.3） |
| `search` | `files(q, opts?)` | **全盘文件搜索** — 统一门面 `file_search`（Everything 在运行则走它的 IPC，否则 LumeSVC 自研 USN 索引）。返回 `{backend: "everything"\|"svc"\|"none", status: "ready"\|"building"\|"unavailable", total?, sort?, entries: [{id,name,path,isFolder,mtime?,size?}]}`。`opts` 兼容旧调用：**数字 = max**；对象 = `{offset, max, sort, exts, folder}`——`max` 默认 12、钳制 1..=100；`offset` 从第 offset 条开始（0 起；Everything 全量有效，LumeSVC 由引擎 `skip` 分页）；`exts`（小写、不带点的扩展名数组）/`folder` 是**名称级过滤**：Everything 收到的是它自己的 `ext:`/`folder:` 语法，USN 引擎在扫描时判定（它的名字排序会把这类命中埋到几千条之后，客户端对一页结果过滤是找不到的）。回复里 `filter` 字段回显**真正生效**的过滤（规范 Everything 语法，如 `"ext:png;jpg"`）；**没有回显＝没过滤**（老服务/老宿主），调用方要自己兜底。`sort` 取 `"name" \| "path" \| "size" \| "mtime" \| "name_desc" \| "path_desc" \| "size_desc" \| "mtime_desc"`（非法值 = 引擎默认序；svc 无全局排序，对返回页做页内排序并如实回显）。`total` 为引擎报告的总命中数（svc / 老版 Everything 拿不到时缺省）；条目的 `mtime`/`size`（ms epoch / 字节）拿不到时缺省，UI 按字段存在与否自适应隐藏列。完整示例 `examples/plugins/file-search/` |

#### 6.1.1 沙箱边界

- iframe 是 opaque origin——`window.localStorage`/`document.cookie` 访问会
  **抛错**（插件数据请用 `storage`/`db`）。
- 页面内直接 `fetch` 远程受 CORS 约束（opaque origin 发不出带凭据的请求），
  跨域取数请用 `lume.http.request`（宿主代理，无 CORS）；`<img>`/`<video>`
  等非 CORS 资源、asset: 协议图标不受影响。
- iframe 内非可编辑区域的点击会把焦点交还宿主搜索框（桥内 mousedown 交接，
  宿主统一兜底）。
- Esc 默认不经过 `key` 事件（根统一处理：菜单 → 模式 onEscape → 卫星预览 →
  隐藏）。**插件要消费 Esc**：在自己的 document 上挂冒泡 keydown 监听并
  `preventDefault`——被消费的按键不再转发给宿主（桥接的转发监听检查
  `defaultPrevented`）。iframe 内非可编辑目标的按键在转发后同样经过根
  `blockBrowserKeys`（Ctrl/Alt 组合被拦，与宿主非输入区行为一致）；可编辑
  目标（input/textarea/contenteditable）的按键完全归插件。

### 6.2 事件面（on.*）

页面赋值 `window.lume.on.<type> = fn`：

| 事件 | 载荷 | 时机 |
|---|---|---|
| `query` | `string` | 模式激活期间的每次搜索框输入（含清空） |
| `show` | — | 模式切入 / 每次呼出（reset） |
| `hide` | — | 启动器隐藏且本模式活动 |
| `enter` | `{code, type, payload}` | 声明式进入规则命中本模式或别的插件 `app.redirect` 过来（§9）。`type` = `"regex" \| "over" \| "redirect"`，`payload` = 命中的查询文本（redirect 时为发送方给的 payload）。**页面在 `load` 之后才会收到状态重放**（§6.3）。`files`/`img`/`window` 规则同样经此送达（类型与 payload 见 §9） |
| `subInput` | `string` | 本模式调 `app.setSubInput` 接管搜索框后，每一次按键（§10.1） |
| `settings` | `Record<string, unknown>` | 用户在设置页改动了本插件的声明式设置（§11.3）；页面 `load` 后的握手会重放当前值 |
| `theme` | `"light" \| "dark"` | 颜色模式推送。沙箱后页面读不到宿主文档，宿主在就绪握手重放当前值，并在变化时推给本模式页与分离窗口。**载荷是本插件「生效」的明暗**：`theme.set` 定过 light/dark 就是它（此时启动器翻转不再影响本插件），否则＝启动器的有效模式——页面按它切换自己的明暗即可 |
| `key` | `{key, ctrlKey, shiftKey, altKey}` | 模式激活时的 keydown 转发——**↑↓/Enter/翻页等导航键由模式页自行实现**（磁盘 mode 的 `rows()` 为空，根网格键位不生效；搜索框中的文本编辑键照常）。转发链路：页面内非可编辑目标、未被页面 `preventDefault` 的 keydown 由**桥接脚本**转发给宿主 → 宿主在其窗口重放该键（Esc 分层/Tab 切模式/箭头导航照旧）→ 根路由消费的键异步回执 `preventDefault`（迟滞消费——Tab 这类移动焦点的键，iframe 内默认动作可能已先发生；Esc 契约不受影响，页面在**自己 document** 上的冒泡监听里 `preventDefault` 即同步消费，被消费的按键不再转发）。焦点在插件 iframe 内时同样送达。示例 file-search 用 ↑↓ 移动选中、Enter 打开、Ctrl+Enter 复制路径 |
| `snapshot` | — | 宿主索取快照时调用 `lume.on.snapshot = () => state`（§6.4） |
| `restore` | `state` | 跨窗口/重挂载恢复时调用 `lume.on.restore = (state) => {}`（§6.4） |


### 6.3 状态重放与就绪握手

桥接脚本在 `<head>`、页面自己的 `lume.on.*` 赋值在 `</body>` 之前——所以宿主
**不会**在 iframe 一挂载就推事件。页面 `load` 后桥接发 `__lumeReady`，宿主
随即重放当前状态：`query` → `show` → 本次进入载荷 `enter`（若有）。含义：

1. 页面脚本请同步赋值 `lume.on.*`（异步赋值会错过首播）；
2. 重复收到同一 `show`/`query` 是正常的，处理器应幂等；
3. **收到新的 `enter` 会作废该插件还在等待重放的陈旧会话帧**（LRU 淘汰 /
   detach / 关闭回流的遗留）——用户带着新载荷重进时 enter 优先，详见 §6.4
   「状态快照」。

**搜索框的共享单值**：默认（设置「各模式使用独立搜索词」关）所有模式共享
一份搜索框内容——切模式 / 切换键会把最新值灌入目标页（`setQuery` 镜像 +
`search`），插件 `app.setQuery` 写的也是这份值；就绪重放里的 `query` 因此
可能是从别的模式带过来的文字（不是本页上次的内容）。开启该设置恢复逐页
独立。经关键字 / feature 行**进入**模式属于「使用条目」：宿主先清掉共享值
再切换，目标页不会被入口触发词过滤。

**`query` 空串的判别（实测固化）**：`query` 事件在状态重放时会**原样再发
一次当前查询（含空串）**，而用户把搜索框删空同样是空串——「空串 = 用户
清空」只在**它紧跟插件自己应用过的非空值之后**成立。把搜索框当输入源的
插件应记录最近一次下发/应用的非空查询：空串到达时，仅当页面状态仍是该值
才清空（否则是呼出/切页/就绪重放，来自 `enter`、历史或页内编辑的状态不能
被清）。无条件忽略空串会让「逐字删到最后一个字符」的收尾永远收不到
（translator 此前原文停在最后删剩的字符，即此坑）。

### 6.4 状态快照与恢复

宿主在 detach / 关闭独立窗口 / keep-alive LRU 淘汰前，经
`__lumeCall{type:"snapshot"}`（宿主→页面的带响应调用，1.5s 超时兜底）向
页面要一份状态，跨窗口/重挂载后以 `restore` 事件回放。快照分两层：

- **auto 层（桥自动捕获，无需插件参与）**：`input`/`textarea`/`select`
  （含 `multiple`/checkbox/radio）按**稳定键**寻址（`id` → `name` →
  nth-of-type 路径，含 open shadow root），加纯文本 `contenteditable`、
  document 与可滚动容器位置、焦点与选区。恢复时 auto 层由桥自动应用，并
  对每个被赋值的控件补发 `input`/`change` 事件（titlebar 槽位帧除外，见下）。
- **custom 层（页面可选）**：赋值 `lume.on.snapshot = () => state`（可返回
  Promise）提供任意可 JSON 化对象；恢复时桥把 `custom` 交给
  `lume.on.restore = (state) => {}`。**页面自有 JS 状态（选中行、内部
  模型、异步初始化后才渲染的视图）只有 custom 层能跨窗口/淘汰恢复**——
  auto 层是尽力而为。

**恢复语义**：每个字段正常只应用一次；补写只有三种受限情形——「DOM 还不
存在」（load 后异步插入的控件，≤4s 重试窗口）、「应用过的节点被替换」，
以及**结束前的最终校正**（页面在此期间没有收到任何宿主事件、用户也没动过
该字段时，把异步初始化覆盖掉的首屏值再拉回一次）。恢复循环不会反复回滚
页面自己的状态变化（实测坑：无节制的重试会把 3.2s 后到达的正常 `enter`
状态回滚）。用户输入过的字段永不覆盖。`restore` 事件在标准状态重放
（query/show/enter/settings/theme）**之后**投递。

**例外：新的进入优先**——模式收到新的 `enter`（进入载荷）时，宿主先丢弃该
插件尚在等待重放的会话帧（淘汰 / 分离 / 关闭回流的遗留），因此「被 LRU
淘汰后立刻用新文本重进」不会被旧快照覆盖；已经消费掉的帧（页面活着）不受
影响。**titlebar 槽位帧**在标准重放**之前**、**静默**恢复（不派发
input/change）：它的输入通常是宿主 query 的视图，派发事件会被页面当成新
输入经 `app.setQuery` 回灌、把当前 query 冲掉。

快照结构 `{v:2, auto:{fields, editables?, scroll[], focus?}, custom?}`（宿主
组装为 `{v:2, frames:{view, titlebar?}}` 跨窗口传递），上限 1MB（超限先丢
`custom` 再整体放弃）；**仅内存流转，不落盘**；`password` 输入框的值会进
快照（同一插件的页面间传递，宿主不持久化）——不希望密码被快照的页面请在
`lume.on.snapshot` 里自行剔除。旧版按 DOM 顺序的 v1 快照仍可被应用
（兼容，新代码不再产生）。

### 6.5 搜索框共享语义

见 §6.3「搜索框的共享单值」与 §6.3「`query` 空串的判别」。

### 6.6 闲置重置

启动器**隐藏**超过设置阈值（默认开 + 30 分钟；睡眠/休眠照常计时）后的
下一次呼出，宿主回到导航页并**完整重置**所有未豁免的模式页：查询清零
（`setQuery("")`——query 住在插件实例里，只卸宿主会「复活」旧查询）、
`restorePage("all")` + `reset()` 各调一次、保活宿主卸载、`sessionFrames`
丢弃——被重置的模式下次进入等同**冷启动**（页面脚本重新加载、DOM/JS 状态
从零开始）。豁免 = 清单 `keep_session` 或用户在设置里的覆盖（用户值优先）；
豁免页完全不动，超阈值时也只是「先回导航页」，其状态可在下次进入时原样
恢复。分离窗口不属于启动器会话，不参与重置；进程重启后的恢复仍由
`remember_last_page` 决定。

### 6.7 插件自身颜色模式

插件可以让**自己的**明暗与启动器不同 —— `lume.theme.set` 取三个值
`"system"`（跟随启动器）/ `"light"` / `"dark"`。语义边界（照抄实现，别自行
推断）：

1. **只作用于调用方自己**：宿主把该插件的「生效模式」送到它的页面画布（注入的
   `--lume-page-bg`）、`theme` 事件、独立窗口的 chrome（标题栏/窗口底色/任务栏
   图标变体）。**启动器自身不移动**——`data-theme`、面板与其它插件页都不受影响。
2. **持久化**：值写进 `settings.plugins.color_modes`，所以下次启动、以及独立窗口
   的**首帧**就已经是它（不会先按启动器的主题画一帧再翻）。
3. **`"system"` 是默认**，含义是「跟随启动器」（启动器自己可能正跟随系统）。
4. **谁来切换本页的明暗**：宿主只推 `theme` 事件，页面自己设 `data-theme` /
   自己的 CSS 变量（沙箱里页面读不到宿主调色板，镜像令牌是插件自己的事）。
   `theme.set` 不会替页面改 DOM。
5. **回读**：`lume.theme.get()` → `{pref, mode, host}`（本插件偏好 / 生效明暗 /
   宿主明暗）。`mode` 就是上面 `theme` 事件的载荷。
6. **权限**：无需声明（它只改插件自己的表面，碰不到启动器与其它插件；§8.2）。
7. **失败要当心**：非法取值 reject（宿主与 Rust 两侧都校验），桥接层照例把
   reject 记到控制台并返回 `undefined` —— 见 §6.1「每条 RPC 都要判空」。

```js
// 三态轮换（标签栏那颗对比度按钮的形态）
const { pref } = await lume.theme.get();
const next = pref === "system" ? "dark" : pref === "dark" ? "light" : "system";
await lume.theme.set(next);          // 本插件专属；启动器不动
```

示例：`examples/plugins/hello-mode/`（页面上的「切换本插件颜色模式」按钮，
另外在搜索框输入 `theme:dark` / `theme:light` / `theme:system` 等价 —— 便于脚本
驱动）；实装参考 translator 1.2.0（标签栏主题按钮 + 设置页主题下拉都同步给宿主）。
验收脚本 `scripts/cdp_plugin_theme_verify.mjs`。


### 6.8 mode 页独立窗口（detachable、titlebar 槽位）

清单声明 `detachable = true` 的磁盘 mode 插件可以把页面**分离为独立窗口**：
激活该模式时，页面右上角悬停出现「在独立窗口打开」按钮（⧉）——点击后启动器
隐藏、插件窗口打开；关闭窗口（× 或 Esc）即销毁，模式回到启动器内页形态。
设置 → 插件 的卡片上会显示「可分离」chip。按钮形态要自定义（常驻、纯图标…）
的插件有两条路：① 保留内置按钮，自绘按钮并调 `lume.app.detach()`（§6.1）；
② 声明 `detach_button = false` 关掉内置按钮（连它的悬停占位一起去掉），右上角
完全归插件页面，分离只走自绘按钮 + `app.detach`。

```toml
kind = "mode"
view = "view.html"
detachable = true     # 允许分离为独立窗口
```

#### 6.8.1 生命周期

| 动作 | 行为 |
|---|---|
| 分离（按钮） | `plugin_window_open` 创建（或聚焦既有）窗口 `plugin-<id>`，加载 `plugin.html?plugin=<id>`；启动器隐藏 |
| 任务栏图标 / 身份 | 分离时把插件图标集解析出的浅/深两套（`icon_light`/`icon_dark`，缺失回退 `icon`/另一套）一起光栅化上传，窗口按**该插件的生效主题**取对应一套：显式变体按原样显示（不反相）；只有旧单图时保持 `--icon-filter` 反相约定。无图标回退 Lume 主题图标。任务栏按钮与 Alt+Tab 都是插件图标，主题切换/重开自动重绘；窗口携带独立 AppUserModelID `Lume.Plugin.<id>`，任务栏独立成项（可单独钉住，不与其他 Lume 窗口合并） |
| 再次激活 | pill 点击 / Tab 循环 / 关键字 / redirect 进入一个已分离的模式 → 聚焦其窗口（不切启动器页面），启动器隐藏 |
| 就绪握手 | 窗口页监听器就绪后调 `plugin_window_ready` → 启动器注册表推送 `{show, query, enter, settings, snapshot?}`（`plugin-state` 事件）——跨窗口版的 `__lumeReady` 状态重放。`snapshot` 是 detach 时从启动器内页面取走的**帧快照**（`{v:2, frames:{view, titlebar?}}`，§6.4）：view 帧在标准回放之后投递；titlebar 帧在标准回放之前**静默**恢复（不派发 input/change，避免把标题栏输入经 `app.setQuery` 回灌冲掉当前 query） |
| 显隐 | 窗口获得焦点/重新打开 → `show` 事件重放 + `onShow` 钩子；窗口隐藏不留事件（shown 推送发生在建窗瞬间、页面尚未加载，**不携带快照**） |
| 关闭 | × 按钮 / Esc / Alt+F4 → Rust 拦截一次 `CloseRequested`，页面先向每个活帧要状态快照（view + titlebar）、连同最终 query 与 `user:true` 经 `plugin_window_close_report` 上报后销毁；启动器把帧存入会话（消费即删）、query 写回模式查询信号，并**回流**到该插件页（挂在隐藏的启动器里立即切换 + ready 握手恢复；启动器再呼出即原样呈现）。插件卡死时 3s 看门狗强制销毁并同样带 `user:true`（无快照，回到初始态）。禁用/重载走的 `plugin_window_close` 是**立即**路径（不带 `user`：代码即将被替换，状态丢弃）。宿主记忆窗口几何（`settings.plugins.window_bounds`），下次分离原位打开 |
| 禁用/重载 | settings-applied 后插件被禁用/移除、或 设置 → 插件 点「↻ 重载」→ 独立窗口自动关闭 |
| 装载看门狗 | 视图/槽位两个沙箱帧都会在装载时被观察：桥在文档提交后立即上报 `__lumeFrameBoot`，宿主 700/1500/2800ms 没等到就重新触发该帧的导航（WebView2 会丢掉「两个沙箱帧几十毫秒内先后换进程」时的后一个导航，帧会永久停在空文档上），三次仍失败才放弃并 `plog.error` 留痕。插件侧无需任何配合，页面脚本不会因此被重复执行（只有未提交的导航才会被重放） |

#### 6.8.2 桥接契约的窗口内差异

窗口内跑的是**同一个沙箱 iframe + `window.lume` 桥接**（§6.1），权限层照常。
语义随宿主变化的部分：

| 能力 | 启动器内 | 独立窗口内 |
|---|---|---|
| `app.hide()` | 隐藏启动器 | 隐藏**插件窗口**（再激活 = 重新聚焦） |
| `app.resize({w,h})` | 改启动器窗口高度 | 改**插件窗口**尺寸（宽高独立，最小 360×240） |
| `app.dragWindow()` | 拖动启动器窗口 | 拖动**插件窗口**（标题栏页的空白区约定，见 §6.8.4） |
| `app.detach()` | 分离本模式为独立窗口（快照/建窗/回放与内置按钮同路） | 已分离 —— 聚焦本窗口（升到前台） |
| `app.toast(text)` | 启动器底部 toast | 窗口内浮动 toast |
| `app.setQuery(q)` | 覆写启动器搜索框查询 | **生效** — 查询住在本窗口的 iframe 里：把 `query` 事件扇出到视图页与标题栏页（调用方也会收到回声）。标题栏搜索框驱动视图就靠它 |
| `app.setPlaceholder` / `setSubInput` / `removeSubInput` | 生效 | **不可用**（没有共享搜索框，调用被忽略并记 debug 日志） |
| `app.redirect(pluginId, …)` | 切页/投递 | 经 Rust `plugin-window-redirect` 转回启动器路由（目标可以是另一个插件） |
| `lume.on.show` / `hide` | 模式切入/启动器隐藏 | 窗口打开/聚焦 → `show`（视图页与标题栏页都收）；无对应 `hide`（关闭即销毁） |
| `lume.on.key` | 模式激活时由根路由转发 | 窗口页直接转发全部非可编辑按键（含标题栏页转发出来的）；**未被消费的 Esc 关闭窗口** |
| `lume.on.query` | 搜索框输入 | `app.setQuery` / 启动器推送时触发（视图页与标题栏页都收） |
| `lume.on.subInput` | 子输入接管 | 不会触发 |

其余能力（`clipboard` / `http` / `dialog` / `screen` / `fs` / `storage` / `db` /
`settings` / `search.files`）两个宿主完全一致。

#### 6.8.3 实现与边界

- 插件的**逻辑钩子**（`entry` 的 `onShow`/`onQuery`/…）跑在共享逻辑宿主窗口
  的沙箱 iframe 里（§6.9），与视图解耦——独立窗口只是视图；
  `onQuery` 在窗口内不会到来（没有共享搜索框）。
- **状态快照/恢复**只作用在视图侧（沙箱 iframe 的 DOM/页内状态）；逻辑侧的
  注册表信号（query/enter/settings）本就跨窗口存活。分离期间启动器**不留活
  副本**（单一权威），关闭回流的端到端脚本见
  `scripts/cdp_plugin_state_verify.mjs`。
- `detachable = true` 声明的窗口是**运行时创建**的——主窗口/设置/预览仍是
  启动时创建。按插件复用窗口（重复 open = 聚焦）。
- 依赖启动器搜索框的模式（子输入框、query 驱动）**不要**声明 `detachable`；
  确要在分离后保留输入的模式应在页面里**自带搜索框**——首选清单 `titlebar`
  字段（§6.8.4，输入经 `app.setQuery` 驱动视图，uTools 式），或页内自建输入框
  （「宿主搜索框是否可达」的判别手法见 `plugins/file-search`：`app.setQuery`
  仅在启动器回声；**「启动器内 / 独立窗口」形态判别一律用 `lume.env.form`**，
  不要数父文档 iframe 数，§6.1）。
- 示例 `examples/plugins/hello-mode/`（`detachable = true`）；实机脚本
  `scripts/cdp_plugin_window_verify.mjs` + `plugins/file-search/scripts/
  verify-host.mjs`（标题栏槽位/setQuery 扇出/按键中继/双页主题推送/权限链路）。

#### 6.8.4 标题栏页（清单 `titlebar`）

可分离模式可以在清单里声明 `titlebar = "titlebar.html"`：独立窗口的标题栏
中间（标题与窗口控制按钮之间）会渲染**第二个桥接 iframe**——与 `view` 同一
沙箱（opaque origin，无宿主 DOM / Tauri 内部访问）、同一 `window.lume`
能力、同一权限台账；页面高度约为 30px（单行工具条/搜索框的尺寸）。

```toml
kind = "mode"
detachable = true
view = "view.html"
titlebar = "titlebar.html"   # 可选；launcher 内嵌时忽略
```

**事件与数据流**（与视图页同收一份数据，键分发规则不同）：

- `show` / `query` / `enter` / `settings` / `theme` —— 视图页与标题栏页
  **都收到**（宿主扇出 + 就绪时重放）。典型用法：标题栏搜索框输入 →
  `app.setQuery(text)` → 宿主把 `query` 扇出（调用方也会收到**回声**，覆盖
  输入框前先比较）→ 视图页 `on.query` 渲染结果。实机参考
  `plugins/file-search`（标题栏图标 + 固定宽度搜索框；Enter/导航键在
  输入框里以 body 上的非可编辑合成 keydown 中继给视图页的 `on.key`）。
- `key` —— **只发给视图页**。标题栏页自己的按键就地处理：桥只转发
  「非可编辑目标」的按键（保护 IME 组合词），焦点在输入框里时 Esc 属于本页
  —— 约定先 `blur()`（下一个 Esc 走宿主路由关闭窗口），或页面自行调
  `app.hide()`。
- 窗口控制按钮（钉住/最小化/最大化/关闭）与拖动间隙归宿主；**iframe 内的
  事件不会越过文档边界**，宿主拖动区覆盖不到——空白区拖窗口调
  `app.dragWindow()`（仅用户手势内调用有意义）。
- **宿主默认拖动（兜底）**：宿主向标题栏页注入一个拖动助手——**非交互元素
  的按下自动调 `app.dragWindow()`**，交互元素（`a/button/input/select/
  textarea/label/summary`、`contenteditable`、`tabindex`、`role`）保留自己的
  点击，`user-select: text` 的目标不拖（让位文字选择），双击不拖。装饰性/
  空白槽页（如 translator 的空白装饰槽位）因此整条可拖，插件**无需**再自带
  拖动处理；自带处理的页面（titlebar-demo 的 grip、file-search 的 body
  监听）照常工作——同一手势的重复调用被宿主去重（300ms 门，防两次
  `start_dragging` 让窗口在松手后吸住鼠标）。整页退出：
  `<html data-lume-drag="off">`（任意祖先元素均可）；单元素退出：
  `data-lume-no-drag`。双击最大化仍只在宿主区域（标题/间隙）生效，槽内
  没有 maximize RPC。
- **实现注记（挂载）**：槽位组件必须**只创建一次**——把它写进反应式
  getter（如 `slot={cond ? <View /> : undefined}`）会在依赖变化时重新调用
  组件、重建 iframe，已接线的实例与存活的节点被拆散，槽位通道整体失灵。
  `pluginWindow.tsx` 在 App 作用域创建一次槽位元素，可见性交给
  响应式 classList。

**分离窗口的权限与主题**：

- **权限台账必须接线**：独立窗口没有启动器 registry——加载视图前经
  `get_plugins` 接线权限来源（`setPermissionSource`），并在 settings-applied
  时刷新（启用态/权限清单可能在窗口存续期间变化）。不接线时所有需要权限的
  能力在窗口里一律被拒（fail-closed 成了 fail-all）。
- **主题推送**：窗口页自己会应用颜色模式，但 iframe 读不到——registry
  监听本窗口 `data-theme` 变更，向模式页 `postEv("theme", mode)`、向分离
  窗口经 `plugin_window_push_state` 携带/推送 `theme`（§6.2 事件表）。
  **推送值是本插件生效的明暗**（`theme.set` 覆盖），并额外带
  `themePref`（本插件偏好）—— 独立窗口的**窗口自身**（chrome/标题栏/窗口
  底色/任务栏图标）按「偏好 ⊕ 启动器设置」判明暗：只在 `theme` 上做不够，
  因为 `"system"` 还得跟随系统（`applyPluginColorMode`，src/theme.ts）。
- **静默推送的窗口过滤（实测坑）**：Tauri 的 JS `listen()` 默认目标是
  `EventTarget::Any`，而 `emit_to` 只按**监听器目标**过滤（每个 webview 都会
  被走一遍）—— 不显式带 `target` 的监听器**会收到所有其它插件的 `emit_to`
  流量**。单窗口时看不出来（载荷相同），一旦载荷带插件私有值（`themePref`）
  就会串台：hello-mode 的窗口曾照 file-search 的 `themePref` 重刷自己的
  chrome。分离窗口里所有**插件私有**事件的监听（`plugin-state`、
  `plugin-window-shown`、`plugin-window-close-requested`）都必须
  `listen(ev, fn, { target: getCurrentWindow().label })`；应用级事件
  （`settings-applied`）保持全局（全局 `emit` 不经过该过滤器）。

示例：`examples/plugins/titlebar-demo/`（标题栏搜索框 + 拖动区，输入驱动
视图列表过滤）。

### 6.9 逻辑运行时（共享逻辑宿主）

声明 `entry` 的磁盘插件的**逻辑**跑在一个共享的隐藏窗口
（label `plugin-logic-host`，页面 `pluginLogic.html`）里：每插件一个
opaque-origin 沙箱 iframe（`pluginLogicFrame.html?plugin=<id>`，classic
script——opaque origin 下 module 脚本按 CORS 取数会被自定义协议拒绝）。
WebView2 站点隔离给每帧独立 renderer 进程：插件死循环只拖死自己的进程。

registry 不 `import()` 任何第三方代码：`loadDiskPlugins` 注册**代理贡献**
（provider/mode/service 的 hook 全部变为跨窗口 RPC `logicCall`，8s 超时；
帧内未实现的 hook 安全返回 `undefined`），并发 `plugin_logic_push{kind:"load"}`
让 supervisor 建帧。视图、快照（§6.8）、权限台账全部不变。

**通信拓扑**（全部经 Rust 中继，没有跨窗口 postMessage）：

| 方向 | 通道 | 门控 |
|---|---|---|
| 启动器 → 宿主 | `plugin_logic_push`（kind = load / unload / event / hook） | label 必须是 main |
| 宿主 → 启动器 | `plugin_logic_result`（hook 回执，按 callId 收口）/ `plugin_logic_action`（ctx 的 toast/setQuery/hide/redirect/logic-loaded 等） | 调用必须带 `host_token`，Rust 按令牌→id 强制归属 |
| iframe ↔ supervisor | 窗口内 postMessage（`__lumeRpc` / `__lumeCall` / `__lumeEvent`，与视图桥同族） | `e.source` 过滤 |

**令牌**：supervisor 每建一帧生成随机令牌，经 `plugin_logic_register_tokens`
登记到 Rust（token → plugin id）；令牌**不进帧**（URL/全局都没有）——帧内
代码纵然逃逸出桥做裸 invoke，也因缺令牌被拒。`invalidate`（reload）与卸载
会清除对应令牌。

**模块加载**：帧内的加载器（`public/pluginLogicFrame.js`，classic script）
经 RPC `__readPluginFile` 由 supervisor 代理读文件（路径**必须**留在本插件
目录内，越界即拒），相对导入改写为**帧内** blob URL 后 `import()`；模块缓存
随帧生命周期（reload = 换帧 = 全新缓存）。逻辑工厂 `create(ctx)` 的
`ctx` 就是帧内的 `window.lume`（与视图页同面，`db`/`http`/`fs`/… 每次
调用带令牌走 supervisor → invoke → Rust 门控；同步常量 `env.form` 恒为
`"launcher"`——逻辑帧永远跑在启动器侧）。**面一致性是硬契约**：新增 ctx
方法必须同时改 `iframeBridge.tsx` 客户端、`public/pluginLogicFrame.js` 与
`rpc.ts`，`cdp_p2b_verify` 有静态断言钉住。

**生命周期**：`plugin_logic_host_ensure` 幂等建窗（隐藏 1×1、skip-taskbar、
恒定低水位内存修剪）；supervisor 就绪后通告 `plugin-logic-host-ready`，
registry（重）发全部 load（覆盖建窗竞态）；宿主窗口 `Destroyed` →
`plugin-logic-host-closed` → registry 重建并重载（10s 内二次崩溃放弃）；
禁用/重载/卸载 → `plugin_logic_push{kind:"unload"}` 拆帧 + 清令牌。

**声明式设置的时序**：`applyPluginSettings` 首投可能早于逻辑就绪——registry
暂存（`pendingLogicSettings`），帧加载完成（supervisor 发 `logic-loaded`
动作）后补投。

**性能取舍**：每插件约一个独立 renderer 进程（空闲可修剪）；每次 ctx 调用
多 2-3 跳 IPC（实测可感知阈值以下）；启动只多一个隐藏窗口（~110ms）。

### 6.10 插件自定窗口尺寸 / 占位文字

mode 插件可以用两种互补的方式决定启动器窗口大小：

**声明式 — 清单 `height` 字段（静态默认值）**

```toml
kind = "mode"
view = "view.html"
height = 560        # 本模式页面的窗口高度（逻辑 px）
```

切换进该模式时，sizer 的 fixed-height 分支取清单 `height`，未声明时回退
全局 设置 → 窗口大小 → 高度。前端会把声明值钳制到
`90px ≤ height ≤ 工作区高度 - 32px`，坏清单值不会撑爆屏幕。

**运行时 — 宿主 RPC `app.resize`（动态调整）**

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

**自定搜索框占位文字（`app.setPlaceholder`）**：

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

## 7. 内置插件开发 API（TypeScript 贡献）

> 这一节面向**第一方/编译进二进制**的插件（clipboard/preview 即此形态）。
> 磁盘 mode/service 同样走 registry 与启停路径（`kind = "mode"` + `view` /
> `kind = "service"` + `entry`）；本节是内置贡献契约的权威描述。
> 契约定义：`src/plugins/types.ts`。

### 7.1 `LauncherPlugin` — 注册单元

```ts
interface LauncherPlugin {
  id: string;                        // 稳定 id（= 清单 id；启停/日志的键）
  modeMeta?: {                       // mode 贡献的模式 pill 元数据
    labelKey: string;                //   i18n 键（pill 文案）
    placeholderKey: string;          //   i18n 键（搜索框占位，v1 占位实际仍按 id 特判）
    icon: string;                    //   SVG import 的 URL
  };
  mode?: ModeInstance;               // mode 贡献（§7.2）
  preview?: PreviewService;          // service 贡献（§7.2）
  provider?: ProviderInstance;       // provider 贡献（§5）
  clipMenuActions?: () => unknown;   // 共享右键菜单的剪贴板动作（§7.3）
}
```

注册：组合根按序 `definePlugin(plugin)`。**注册顺序 = 模式 pill 顺序 =
磁盘插件之前的合并顺序**。注册发生在 App 组件作用域内——mode 实例里的
Solid `createEffect/createSignal` 因此拥有正确的响应式 owner。

### 7.2 `PluginServices` / `ModeInstance` / `ModeKeyContext` / `PreviewService`

#### 7.2.1 `PluginServices` — 组合根开放给内置插件的能力

| 方法 | 语义 |
|---|---|
| `showToast(text, opts?)` | 底部 toast。`opts.undo` 撤销回调（3s 窗口）；`opts.duration` 覆盖默认停留（1.6s）。 |
| `markEntryOpened()` | 标记「已使用条目」。下一次呼出时若停在**导航首页**，首页清空自己的查询后重搜；插件页的查询与页面状态不受影响，也不会强制切回导航页。launch/paste/开链接类动作都应调用。 |
| `resetAndHide()` | 隐藏启动器（`endSummon` + `hide_launcher`）。**不清理** mode/query/页面状态，会话续存不受影响。 |
| `persistLastPage()` | 防抖 400ms 持久化「记住上次所在页面」（读活动模式的 `pageKind`）；它只决定**重启恢复**，会话内续存始终开启。模式内切换分类/页面时调用。 |
| `runSearch(q)` | **根搜索管线**：重置选中 + 令牌 +1 → 活动页 `instance.search(q)`。页面内部刷新数据应调它而不是自己的 `search`，以保证选中态/令牌一致。 |
| `scheduleResize()` | 下一帧重测窗口高度（内容变化后调用）。 |
| `searchToken()` | 单调递增令牌——根每次搜索 +1。异步结果落地前比对，令牌变了就丢弃（防乱序）。 |
| `nextSearchToken()` | 令牌 +1 并返回——页面自己的异步链（如下钻过滤）按同一时间线丢弃陈旧结果。 |
| `selectionSource()` | `"keyboard" \| "mouse" \| "other"`——最后一次选中变更的来源。hover 门控（键盘导航中悬停不接管）读它。 |
| `markMouse()` | `selectionSource = "mouse"`。视图的 onMouseMove/onClick 调用。 |
| `openMenu(m)` | 打开共享右键菜单（根渲染；`m` 为 `MenuState` 结构：`{kind, x, y, app?/item?/idx?}`）。 |
| `mode()` | 当前活动模式 id（`"apps"` 或插件模式 id）。 |
| `requestMode(id)` | 请求切模式（等价于用户点 pill → `switchMode`）。 |
| `setModePlaceholder(pluginId, text)` | 设置某插件模式的搜索框占位文字（`""` = 默认；按插件 id 隔离，见 §6.10）。内置插件一般用不到——`createHostApi` 会自动带上调用方自己的 id。 |

#### 7.2.2 `ModeInstance` — 整页模式契约

每个方法都标注**调用方与时机**——实现必须能在这些时机被安全调用：

| 成员 | 调用方 / 时机 |
|---|---|
| `query()` / `setQuery(q)` | 组合根读取/设置当前页面查询。默认是**全局共享一份**：最新输入为准，切模式把该值灌入本页并按其搜索，`app.setQuery` 也写这份值；设置「各模式使用独立搜索词」开启后恢复逐页独立 query。hide/show 都不清（会话续存）；打开首页条目后的下次呼出 / 闲置重置会清空共享值。 |
| `search(q)` | 根 `runSearch` 对**活动页**的统一分发（导航首页同样走此路径）。实现须：取 `services.searchToken()` 快照 → 异步取数 → 令牌不一致则丢弃 → 写自己的 rows → `setSelected(0)` + 复位滚动 → `services.scheduleResize()`。 |
| `reset()` | 每次**呼出**（`launcher-shown` → `beginSummon`，仅活动页）、页面挂载与启动页恢复时调用；切模式**不**调用，也不负责清 query/页面状态。实现只清多选/对话框/动画态等**每呼出状态**；rows 清空后由随后的 `runSearch` 重填。 |
| `selected()` / `setSelected(i)` | 根 `moveSelection`（↑↓/网格移动）、`runSearch` 复位、Enter 激活前的对齐。 |
| `rows()` | `currentResults()`（键盘移动的边界）与 Enter 激活。返回 `PageRow[]`（`AppEntry \| ClipboardItem`；任意模式自定义行模型仍留待后续）。 |
| `activate(opts?)` | Enter / 点击选中行的激活（`opts.elevated` = Shift+Enter 提权请求，应用启动类页面消费它）：多选 → 合并粘贴；单选 → 粘贴。 |
| `onKey(e, ctx)` | 键盘路由先交给**活动页**处理；返回 `true` = 已消费。首页自管网格四向键与栏分区导航，剪贴板消费 ←/→（切分类）、Space（多选）、Del（删除）——未消费的 ↑/↓/Enter 落到根的通用绑定（`ctx.moveSelection`、根 `activate`）。`ctx = { hasResults, moveSelection, gridCols, markKeyboard }`。 |
| `handleQuery?(q)` | 可选 — 输入拦截（先于 subInput 路由与常规搜索管线）：返回 `true` = 本页消费了这次击键（首页的 provider 下钻过滤用它）。 |
| `onEscape()` | Esc 分层：菜单 → **页面**（如退下钻层/退出多选，返回 true）→ 卫星预览 → 隐藏。 |
| `previewTarget()` | 卫星预览插件每次选中变化时轮询：当前选中行的预览请求（`PreviewReq`）或 `null`（隐藏）。行失效 → `null`。 |
| `previewEnabled()` | 该页面当前是否想要卫星预览（对应 设置 → 开启预览）。 |
| `measureViewport()` | 窗口尺寸变化（sizer 定高分支 + 根视口 effect）时触发；重测页面内部虚拟列表视口。 |
| `ready?()` | 可选 — **加载门控**（反应式）：本页当前是否有内容可显示。返回 false 时壳隐藏 `.results`、sizer 把窗口收拢到搜索行、该页 pill 显示加载态（强调色 + 图标转圈）——**页面不完整就不显示**。磁盘页在页面桥接 `__lumeReady` 前为 false（每次重挂载都重新加载；3s 宽限兜底，异常页不会永远转圈），模板/剪贴板页在首次取数落定前为 false（之后不再回退）。省略 = 永远就绪（导航首页——空态由它自己负责）。 |
| `heightPolicy?()` | 可选 — `"fit"` = 窗口随内容自适应（导航首页）；`"fixed"`（默认）= 搜索框下方定高拼接。sizer 的分支选择依据。 |
| `anyExpanded?()` | 可选 — 是否有展开态栏目（fit 页专用，sizer 工作区封顶）。 |
| `desiredHeight?()` | 可选 — sizer 定高分支读取：本页面的固定窗口高度（清单 `height`），`null` = 用全局设置高度（§6.10）。 |
| `home?` | 可选 — 主页标记（导航页）。所有保活页面都跨模式留存（不切入即重置）；该标记用于 **keep-alive LRU 豁免**（首页永不被淘汰）。 |
| `placeholder?()` | 可选 — 本页激活时搜索框占位符（subInput 接管优先，然后本值，最后 `app.setPlaceholder` 映射）。 |
| `menuActions?()` | 可选 — 共享右键菜单动作来源（窄结构接口，见 §7.3）。 |
| `pageKind()` / `restorePage(kind)` | 记住上次所在页面：持久化当前页（如剪贴板分类）/ 恢复；切到该页面时根先 `restorePage("all")` 复位。 |
| `applySettings(s)` | 每次 `settings-applied`（对**所有**页面实例，含未激活的）：应用自己的设置切片（栏目显示、剪贴板显示类开关、占位符…）。 |
| `onShow?()` | 可选 — 呼出（召唤搜索之后）时对**所有**页面调用：刷新呼出级数据（首页的栏数据 / 资源管理器栏 / 前台窗口行 / 空菜单自动选中）。 |
| `onFilesDropped?(paths)` | 可选 — 系统文件拖入：主页据此生成 feature 行（行状态随呼出一次性）。 |
| `View` | 无 props 的 Solid 组件——活动时经 `<Dynamic>` 渲染为整页内容（拼接在搜索框部件下方）。内部通过闭包持有自己的 store 与 `services`。 |

**模式 pill**：`modeMeta.labelKey` 提供文案（i18n），`icon` 提供图标；
关闭插件的 pill 自动消失，Tab 循环也随之跳过。**清单 `hidden = true`
的模式不渲染 pill、Tab 循环也跳过** —— 它的唯一入口是导航搜索结果（keywords
/ feature 行）与插件互跳；模式激活时切换键从导航页重新开始循环（此时无 pill
高亮）。导航首页是注册表中的第一个 mode（id `"apps"`，`home: true`），
它的 pill 即最左侧「导航」。

**拼接面（页面画布）**——宿主对页面的三条保证：

1. **几何**：搜索行与页面共用一块连续面板。面板是不透明 `--surface`（同一
   值也刷在窗口外缘的 DWM 边框条上），搜索行 / 页面 / 四角像素级同色；搜索行
   无下边框、页面区无内衬，页面内容直贴搜索行底边与窗口的左/右/下边；需要
   留白就由页面自己给（现有页面的内衬见 ARCHITECTURE「拼接几何」）。`fit`
   页的窗口高度含 `WINDOW_PAD` 余量。
2. **画布**：磁盘插件的 `view` 页是**不透明源（sandbox）iframe**——宿主元素背景
   对它不可见。暗色 `color-scheme`（镜像主题配色的插件都会设）下，根背景透明的
   文档会被 Chromium 画成**不透明 #121212 画布**，在拼接处露出明显色阶。宿主
   因此在 `injectBridge` 注入默认画布
   `html{background:var(--lume-page-bg,<主题 --surface>)}`，桥接在 `theme` 事件
   到来时切换该变量（主题翻转即时跟随）。该默认值就是启动器面板自身的颜色
   （暗 #1e1e20 / 浅 #fbfbfd），所以默认画布与面板在拼接处完全同色。插件用
   `theme.set` 定过自己的明暗时，这个变量与事件都取**本插件生效的**那一侧
   （页面上就不再与面板同色 —— 那时页面的底色由插件自己负责，见 §6.7）。**插件
   自己写 `html`/`body` 背景即覆盖该默认**（文档更靠后，优先级更高）；自绘
   背景时请与 `lume.on.theme` 给出的明暗保持一致，否则拼接处会出现色阶
   （此时页面已不等于面板色）。
3. **加载门控**：页面**未就绪就不显示**。`ModeInstance.ready()` 返回 false 期间，
   壳隐藏 `.results`、sizer 把窗口收拢到搜索行、该页 pill 显示加载态（强调色 +
   图标转圈）；就绪后才按页面高度展开。磁盘插件无需做任何事（宿主以页面的
   `__lumeReady` 桥接握手为准，3s 宽限兜底），但**别在页面里做长时间同步 IPC**：
   Tauri 的同步命令跑在主线程上，会把宿主的 resize（乃至加载门控的收拢）一起
   卡住——重活放 `async`/`spawn_blocking`（见 ARCHITECTURE `clipboard.rs`）。

#### 7.2.3 `ModeKeyContext`

```ts
{ hasResults: boolean; moveSelection(delta: number): void; gridCols(): number; markKeyboard(): void }
```

`hasResults` = 当前 rows 非空；`moveSelection` = 根的选中移动（含
selectionSource 标记、自动滚动）；`gridCols` = 结果网格列数（网格页 ↑↓
按列移动）；`markKeyboard` = 标记 selectionSource 为键盘（栏分区导航用）。

#### 7.2.4 `PreviewService` — 卫星预览服务

```ts
{ currentPreview(): PreviewReq | null; clear(): void }
```

- 组合根把「活动模式的 `previewTarget()`/`previewEnabled()`」组装成依赖
  注入 preview 插件；插件内部跑 100ms 防抖 effect（show/close IPC）。
- `currentPreview` 是**同步**信号——Esc 分层在预览防抖未落地前也能正确
  判断「预览开着」并优先关它。
- `clear()` = 立即清空（卫星窗 × 按钮 / Rust 侧 teardown 的
  `preview-closed` 事件回调）。

### 7.3 共享右键菜单集成（menuActions）

右键菜单由根渲染（`buildMenuItems`），目标条目的动作由所属页面以**窄
接口**供给（`menu.ts::NavMenuActions` / `ClipMenuActions`）。组合根取各页
`mode.menuActions()` 传入——菜单不依赖插件的完整类型，只依赖这份结构；
插件端直接返回自己的 store（结构天然满足）。

### 7.4 完整内置示例：剪贴板插件

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

## 8. 宿主能力面

### 8.1 能力方法参考

所有能力都是 **Rust 侧的一个命令**，三条路径（内置工厂 `ctx` / 磁盘 provider
工厂 `ctx` / iframe 桥接 `window.lume`）暴露同一套方法名——本节是插件侧可
调用的完整参考；桥接 `window.lume` 各组的签名汇总见 §6.1。

#### `app.*` — 基础动作

| 方法 | 语义 |
|---|---|
| `hide()` | 隐藏启动器（独立窗口内则隐藏插件窗口，§6.8.2）。 |
| `toast(text, opts?)` | 底部 toast。`opts.undo` 撤销回调（3s 窗口）；`opts.duration` 覆盖默认停留。 |
| `setQuery(q)` | 覆写搜索框查询（独立窗口内把 `query` 扇出到本插件的帧，§6.8.2）。 |
| `setPlaceholder(text)` | 自定本模式搜索框占位文字（§6.10）。 |
| `openPath(path)` | 经 `launch_app` 打开文件/URL，并标记「已使用条目」。 |
| `revealPath(path)` | 在 Explorer 中定位并选中目标（**不**标记「已使用条目」、**不**隐藏启动器——打开位置后用户通常还要继续搜，是否隐藏由插件自定）。 |
| `trash(paths)` | 文件/文件夹批量送入回收站（需要 `trash` 声明，§8.2）。无永久删除回退，失败即 reject；宿主不做确认框，删除确认由插件自行用 toast/UI 二次确认实现。 |
| `resize({width?, height?})` | 调整窗口尺寸（§6.10）。 |
| `notify(title, body)` | 系统通知（见下）。 |
| `setSubInput(opts?)` / `removeSubInput()` | 接管/交还搜索框（§10.1）。 |
| `redirect(pluginId, opts?)` | 跳到另一个插件（§10.3）。 |
| `detach()` | 把本模式分离为独立窗口（§6.8）；快照/建窗/回放与宿主内置悬停按钮同一条路。 |
| `dragWindow()` | 拖动窗口（标题栏槽位帧的空白区用，§6.8.4）。 |
| `foreground()` | 前台窗口快照（见下）。 |

#### `app.notify` — 系统通知

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

#### `app.foreground` — 前台窗口快照（权限 `window`）

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
  COM 解析链；`process` 是 limited-information 查询，无需提权。
- **权限 `window`**：没有声明时调用即被拒（前端守卫 +
  Rust `plugin_foreground_context` 命令侧双重校验，§8.2）。

#### `http.request` — 宿主 HTTP（无 CORS）

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
- 权限：`network`（必须在 manifest 声明；前端守卫与 Rust
  `plugin_perm.rs` 都会按调用方 plugin id fail-closed 校验）。
- **内网防护**：插件请求默认拒绝解析到**回环/私网/链路本地**的
  目标（127/8、::1、10/8、172.16/12、192.168/16、169.254/16、100.64/10、
  fe80::/10、fc00::/7、未指定地址，含 IPv4-mapped IPv6）——防 SSRF（云
  元数据 169.254.169.254、本机管理面板、内网服务探测）。需要触达自建服务
  的插件在清单声明 `network_allow = ["192.168.1.10", "*.internal.dev"]`
  （精确或 `*.` 通配后缀，大小写不敏感；裸 `*` 放行一切）。公网目标无需
  声明。错误信息即指引：`network access to private address "<ip>" denied
  (declare network_allow in plugin.toml to override)`。
- **重定向逐跳校验**：跟随重定向（≤5 跳）不再交给 WinHTTP——每一跳的
  Location 都重新做同样的目标检查（302 跳内网同样被拒）；301/302/303 降级
  为 GET 并清空请求体，307/308 保留 method 与 body。
- 已知边界：域名目标按「本次请求的 DNS 解析结果」判定——解析与连接之间的
  DNS rebinding 理论上可绕过（白名单 host 不做解析检查）；`network_allow`
  命中的 host 不做任何地址检查（声明即信任）。

#### 剪贴板扩展

```js
await ctx.clipboard.writeImage(canvas.toDataURL("image/png")); // PNG，base64 或 data URI
await ctx.clipboard.writeFiles(["C:\\a.txt", "C:\\b.txt"]);    // CF_HDROP（Explorer 式复制）
const files = await ctx.clipboard.readFiles();                 // 当前文件列表（无则 []）
await ctx.clipboard.paste({ text: "粘贴到前台窗口" });          // 写入并 Ctrl+V
```

- `readImage()` 返回 PNG data URI（无图 = null；§9.3 的取数路径）。
- `paste` 复用剪贴板模式的完整流程：隐藏启动器 → 把焦点还给呼出前的前台窗口
  → 注入 Ctrl+V；**载荷粘贴后留在剪贴板上**（与普通复制一致）。只有一个载荷
  字段允许存在；没有目标窗口时退化为纯复制（并记日志）。
- 图片上限 32 MB（解码前检查）。
- 权限：`clipboard`（文本读写与其它剪贴板方法同名）。

#### `dialog.open` / `dialog.save` — 原生文件对话框

```js
const files = await ctx.dialog.open({ title: "选择文本", multiple: true,
  filters: [{ name: "文本", extensions: ["txt", "md"] }] });
const target = await ctx.dialog.save({ fileName: "输出.txt" });  // 取消 → null
```

- 取消不是错误：`open` 返回 `[]`，`save` 返回 `null`——由插件决定提示什么。
- `defaultPath` 指定起始目录，`folder: true` 改为选目录。
- 对话框由 Rust 侧驱动（`tauri-plugin-dialog`），启动器窗口的能力集不因此扩大。
- 权限：`dialog`。

#### `screen.cursor` / `screen.displays` — 屏幕几何

```js
const { x, y } = await ctx.screen.cursor();     // 物理像素
const ds = await ctx.screen.displays();         // [{x,y,width,height,workX,workY,workWidth,workHeight,primary}]
```

- 全部是**物理像素**（多屏时 `x` 可为负）；配合 `app.resize` 可做「贴着光标」的
  小窗类插件。
- 权限：`screen`。

#### `search.files` — 全盘文件搜索

见 §6.1 的 `search` 行（完整签名、后端、分页/过滤/排序语义与回显规则）；
权限：`search.files`。

#### `fs.*` — 文件读写

见 §6.1 的 `fs` 行（读取 512KB/32MB 边界、缩略图、私有目录、`fs.read`/
`fs.write` 声明）；私有文件的细节见 §11.2。

#### `db` / `storage` / `settings` — 插件自有数据

见 §6.1 对应行与 §11（文档库乐观锁、迁移语义、声明式设置）。

#### `theme.*` — 插件自身颜色模式

见 §6.7；免权限。

### 8.2 权限台账（单一事实源）

| 宿主能力 | RPC / 命令 | 权限声明 |
|---|---|---|
| 隐藏启动器 / toast / 改查询 / 打开路径 / 定位 / 回收站 / 改窗口尺寸 | `app.*` | 无（基础能力） |
| 系统通知 | `app.notify` / `plugin_notify` | `notify` |
| 剪贴板读写（文本/图片/文件/粘贴） | `clipboard.*` | `clipboard` |
| 宿主 HTTP | `http.request` / `plugin_http_fetch` | `network` |
| 文件对话框 | `dialog.*` / `plugin_dialog_*` | `dialog` |
| 光标与显示器 | `screen.*` / `plugin_cursor_pos`、`plugin_displays` | `screen` |
| 全盘文件搜索 | `search.files` / `file_search` | `search.files` |
| 文件读取（文本/字节/缩略图/图标） | `fs.readText/bytes/thumb/videoPoster/icon` | `fs.read` |
| 任意路径写入 | `fs.writeFile` | `fs.write` |
| 插件私有目录读写 | `fs.writeText/writeBytes/readPrivate/listPrivate/privatePath/removePrivate` | 无（属于插件自己） |
| 回收站删除 | `app.trash` / `trash_to_recycle` | `trash` |
| 前台窗口信息与 Explorer 当前文件夹 | `app.foreground` / `plugin_foreground_context` | `window` |
| 插件私有 KV / 文档库 / 设置 | `storage.*`、`db.*`、`settings.*` | 无（插件自有数据） |
| 本插件自己的颜色模式 | `theme.set` / `theme.get` | 无（只改本插件的表面，启动器不受影响） |

每个宿主能力 RPC 都按**调用方 plugin_id** 对照清单 `permissions` 校验：表里
每一行未声明即被拒绝（fail-closed，文案带缺失的能力词）。实现在
`src/plugins/permissions.ts`（`guardHostApi` 逐方法把关，插件逻辑与 mode
桥接两条路径都覆盖）与 `src-tauri/src/plugin_perm.rs`（Rust 侧同样强制；
`file_search`/`trash_to_recycle` 的原生调用路径按「main 窗口 + 无 plugin_id」
放行）——绕过前端守卫的调用（直连 `invoke`）同样被拦。
「全部授权」是开发逃生门，语义见 §11.4。

> **维护者核对清单**：新增宿主能力必须同时更新——
> ① `src/plugins/hostApi.ts` 的 RPC 实现；
> ② `src/plugins/permissions.ts` 的 `RPC_PERMISSION` 台账（并在本表登记一行）；
> ③ Rust 侧 `plugin_perm.rs` 的白名单；
> ④ `src-tauri/capabilities/*.json`（暴露给 webview 的命令，如适用）。
> 缺一，能力要么不可用、要么绕过权限校验。

---

## 9. 声明式进入规则

### 9.1 `[[features]]` 总览

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

- **匹配时机**：导航模式（apps）每次非空查询；命中即在结果页的「推荐使用」块
  追加「<label>」行（与「进入 <插件>」关键字行、provider 结果同块；正常查询
  结果留在上方网格，两者以标题分隔行隔开）。
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
- **行图标**：规则声明了 `icon_light`/`icon_dark` 用两套（按所在表面
  主题选、按原样渲染）；只有旧 `icon` 则用它（旧行为不变）；一组都没给 →
  默认用插件清单的图标集；都没有才回退未知图标。

### 9.2 `type = "files"` 文件拖入

```toml
[[features]]
code = "handle-docs"
label = "文件处理器：处理文本文件"
type = "files"              # 缺省 "text"（上面的 regex/over 规则）
extensions = ["md", "txt"]  # 大小写不敏感、不带点；省略 = 任意文件
min_length = 1              # 这里是文件数边界（text 规则里是字符数）

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

- **触发**：把文件从资源管理器**拖到启动器窗口**（Tauri drag-drop handler 提供
  真实路径；WebView2 的 HTML5 drop 拿不到路径）即出现「<label>（N 个文件）」行
  ——拖入时主菜单在则立即出行（空查询下落在「推荐使用」栏，最近使用/已固定
  栏保持可见，且该栏首行自动聚焦，Enter 直接激活），不在（启动器隐藏）则先
  拖住文件再按热键呼出。
- **激活**：把命中的路径**子集**投递给 `onFeature({code, type: "files", payload: "",
  paths})`（mode 收 `onEnter`）——只匹配了规则的过滤条件（`extensions`/`file_type`）
  的文件在 `paths` 里。行在下一次隐藏/呼出后消失；查询非空时拖入也会把行追加进
  「推荐使用」块。
- **`file_type` 类别与文件夹匹配**（TOML 键 snake_case，前端 JSON 为
  `fileType`）：类别词表 `image` / `video` / `audio` / `document` / `text` /
  `folder` / `others`（= 不在任何类别表里的文件；表在宿主
  `registry.ts::FILE_TYPE_EXTS` 内 curated，未映射的扩展名归 others）。
  **匹配语义**（三选一，按优先级）：
  1. `extensions` 非空 → 扩展名匹配，且**文件夹永不命中**（目录名带点不
     冒充扩展名）；
  2. 否则 `file_type` 声明 → `folder` 只匹配目录；其余类别只在**文件**上按
     表匹配；
  3. 都未声明 → 任意**文件**（不含文件夹——文件夹规则必须
     `file_type = "folder"`）。
  文件夹判据是真实属性查询：拖入时宿主对新命令 `file_kinds(paths)`
  （`GetFileAttributesW`，`file/folder/missing` 逐路径）查询一次，结果与拖入
  路径平行存放、随隐藏/呼出清空——一次拖拽一次查询，无逐键 IO。类别未知
  （`missing`）的路径按文件处理。`min_length`/`max_length` 语义不变（命中
  子集计数）。
- 示例：`examples/plugins/files-img-demo/`；实机脚本
  `scripts/cdp_lupx_verify.mjs`、`scripts/cdp_p2b_verify.mjs` fileType 段。

### 9.3 `type = "img"` 剪贴板图片

```toml
[[features]]
code = "handle-image"
label = "图片处理器：处理剪贴板图片"
type = "img"
```

- 剪贴板持有可解码图片（CF_DIB/DIBV5、截图工具的自定义 PNG、CF_BITMAP）
  时，**空查询主菜单的「推荐使用」栏**出现「<label>」行（激活 = `onFeature({code,
  type: "img", payload: ""})`）。像素由插件自己读：
  `ctx.clipboard.readImage()` → `data:image/png;base64,…`（null = 无图），
  需要清单声明 `clipboard` 权限。
- 示例：`examples/plugins/files-img-demo/`。

### 9.4 `type = "window"` 活动窗口匹配

按**呼出启动器前的前台窗口**触发：呼出时空查询主菜单的「推荐使用」栏出现
「<label>」行，
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

**触发与生命周期**：仅空查询主菜单的「推荐使用」栏出现（非空查询不出现，
uTools 同）；每次呼出按新前台重算，隐藏后清空（summon-scoped，与 files 行
一致）；有 window 行时落在「推荐使用」栏（与 files/img 行同语义，不以网格
顶掉其它栏目条）。

**权限语义**：匹配是宿主侧行为——只看清单声明，**不需要权限**；行 payload
只携带该插件自己命中的窗口信息。插件要**主动**读窗口信息（`app.foreground`，
§8.1）才需要声明 `window`。

示例：`examples/plugins/window-demo/`；实机脚本
`scripts/cdp_window_feature_verify.mjs`（process/AND 维度正负例、
payload 投递、summon-scoped 清空、权限拒绝/放行/fail-closed；Explorer 的
class 维度与 path 解析依赖真实 Explorer 窗口激活，自动化不稳定，由示例的
手工步骤覆盖）。


---

## 10. 搜索交互扩展

### 10.1 子输入框（`app.setSubInput` / `removeSubInput`）

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
- **自动释放**：切模式、再次呼出、插件被重载/关闭都会把搜索框
  交还宿主（所有权是会话级状态，不持久化）。
- 与「会话续存」的关系：接管期间输入的文字仍写入搜索框的当前值（默认
  即全局共享值；开启「各模式使用独立搜索词」后写本页 query；宿主照常显示），
  但不会触发 `search`。

### 10.2 provider 二级下钻（`drill` + `select` + `filter`）

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
  回上一级（恢复父层行，并释放搜索框）。只支持一层（不做多层栈）。
- 实现 `filter` 时，宿主在下钻期间把按键喂给它（`filter(item, query)`），层级
  行随输入刷新；**没实现 `filter`** 则搜索框保持常规语义——一旦继续输入会运行
  普通搜索并离开下钻层（行为可预期，不静默）。
- 下钻行同样支持 `enter`/`icon`/`description`；`select`/`filter` 抛错只记日志
  并 toast，不影响其它 provider。

### 10.3 插件互跳（`app.redirect`）

```js
lume.app.redirect("hello-mode", { code: "from-x", payload: "要带过去的内容" });
```

- 目标为 mode：切页并投递 `onEnter({code, type: "redirect", payload})`
  （页面收 `lume.on.enter`）；目标为 provider/service：投递 `onFeature(...)`。
- 目标不存在 / 未启用 / 未加载 → **宿主 toast 提示**（`pluginActionUnavailable`），
  不做静默失败（市场跳转是远期，暂不提供）。

### 10.4 内置列表模板（`template = "list"`）

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
  （`{ name, path?, description?, icon? }`，`name` 必填；`icon` 同样接受
  `{ light, dark }`，省略时用插件清单的图标集）。
- `onEnter(item)`（可选）：行激活。启动器保持打开 —— 插件自己决定何时
  `ctx.app.hide()`。
- 可选钩子 `onShow` / `onHide` / `onQuery(q)` / `onSubInput` / `onSettings` 与
  provider/service 相同；`[[features]]` 命中投递到 `onFeature(info)`（mode 在
  切页后收，同 §9.1）。`[[settings]]` 照常生效。
- `view` 字段被忽略；`height` / `icon` / `keywords` 照常。

示例：`examples/plugins/list-demo/`（零 HTML，文档库 + 剪贴板 + features）。

---

## 11. 数据与设置

### 11.1 文档库 `db`（`ctx.db` / `window.lume.db`）

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

### 11.2 插件私有文件 `fs private`（`<plugin>/files/`）

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
  声明 `fs.write`（§8.2）。父目录必须已存在（不静默造目录）。
- 附件的典型用法：`writeBytes` → `privatePath` → `app.openPath` / `clipboard.paste`
  / `search.files`，或直接 `convertFileSrc` 进 `<img>`。

### 11.3 声明式设置 `[[settings]]`

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

### 11.4 权限强制层（fail-closed 语义）

`permissions` 不是预留字段：**没声明的能力，调用即被拒绝**（fail-closed，
未知插件同样拒），拒绝文案带缺失的能力词，并在控制台留一行
`[plugins(id)] permission denied: <method> needs "<perm>" — declared: […]`。

```toml
permissions = ["network", "clipboard", "fs.write"]
```

- **台账**（单一事实源 = §8.2 表）：`app.notify→notify`、`app.trash→trash`、
  `clipboard.*→clipboard`、`http.request→network`、`dialog.*→dialog`、
  `screen.*→screen`、`search.files→search.files`、`fs.readText/bytes/thumb/
  videoPoster/icon→fs.read`、`fs.writeFile→fs.write`。
- **无需声明**：基础动作（`app.hide/toast/setQuery/setPlaceholder/openPath/
  revealPath/resize/setSubInput/redirect/detach`）、插件自有数据（`storage.*`、`db.*`、
  `settings.*`）、私有目录（`fs.writeText` 等）。
- **校验点**：宿主构建插件 API 时逐方法包一层（`guardHostApi`），所以插件
  **逻辑**（跑在逻辑宿主帧、持有 API 的那份）与 **mode 页的桥接** 两条路径
  都被覆盖——只在桥接入口拦是不够的。
- **设置页**：每个磁盘插件行显示声明的权限 chips；「全部授权」是开发
  逃生门——开启后所有磁盘插件的一切能力调用放行，用于「插件先跑起来、
  manifest 之后补」的场景。**形态**：授权开关并入 设置 →
  插件 工具栏的**全局开发者选项**，不再有逐插件开关——「开发者模式」
  （`settings.plugins.dev_mode`，默认关）是总闸与显隐开关，「全部授权」
  （`settings.plugins.trust_all`）只在它开启时显示且生效；`get_plugins`
  在开发者模式关闭时把所有插件上报为 `trusted=false`，残留的 trusted
  列表与 trust_all 都授予不了任何能力。逐插件的 `trusted` 列表仍被
  尊重（`set_plugin_trusted` 命令保留），只是设置页不再写入。内置插件
  （clipboard/preview）编译进 lume.exe，不参与该表。


---

## 12. `.lupx` 打包、安装与卸载

`.lupx` = 一个 zip 包：`plugin.toml` + 插件资产。清单 `plugin.toml` 在**归档
根**或在**唯一顶层目录内**（「右键压缩文件夹」产物可装；前缀外的散文件被
忽略）。打包：`powershell -NoProfile -File scripts/pack_lupx.ps1 <插件目录>
<输出.lupx>`。

**安装流程（设置 → 插件）**：工具栏「安装插件…」→ 选 `.lupx` 文件 → 宿主
`plugin_lupx_inspect` 只读校验并弹**内联确认卡**（名称/版本/kind/描述/
**权限 chips（本地化）**/文件数与大小/签名状态；已装同 id 时对包内/已装
版本做 semver-ish 比较（点分段数字序、缺段补 0、release 高于 prerelease），
按关系显示「升级 vX → vY」/「同版本重装 vX」/「降级 vX → vY」（黄字）——
关系只决定措辞，任何关系确认后都安装，降级即回滚旧包）→ 确认 →
`plugin_lupx_install` 解压换位。这张卡就是权限模型的
「安装时知情同意」时刻。**卸载**：每张磁盘插件卡（内置无）的卸载按钮，
两段式确认（3 秒武装窗口）。

**签名**：包内可选条目 `LUME.SIGN`（ed25519）——签名工具与宿主同源：

```bash
lume --gen-key <目录>                              # 生成 lume-signing.key/.pub
lume --sign-lupx <包.lupx> --key lume-signing.key  # 就地重写包 + 注入 LUME.SIGN
```

`LUME.SIGN` 覆盖 manifest 字节 + 全部文件（逐个 SHA-256，按名排序）；
验签信任根 = 内置发行公钥（`plugin_sign.rs::RELEASE_PUBKEY_B64`）+ 用户
`<base>/settings/trust-keys/*.pub`（发布者发 .pub 文件，用户丢进目录即
导入，无 UI）。三态：**已验证**（确认卡绿字徽标）/ **未签名**（维持现有
流程，卡上展示归档 SHA-256 供线下核对）/ **签名无效**（篡改或密钥不符 →
inspect 直接报错、install 不可达——硬拒）。私钥永不进仓库。

Rust 侧（`plugin_install.rs`）语义：

| 环节 | 行为 |
|---|---|
| 校验 | 清单解析（`parse_manifest`）+ 必须显式声明 `id`（包内无目录名可回退）+ `valid_plugin_id` 字符集；entry 名逐段守卫（`\`→`/` 规范化——PowerShell 兼容、拒绝绝对路径/`..`/保留设备名/控制字符/结尾空格点、单段 ≤120 字符）；单文件 ≤64 MiB、总解压 ≤256 MiB、条目 ≤4096；前两者按**实测**解压字节判定（zip 头部声明的未压缩大小可伪造——解压/哈希时逐块计数，声明与实测不一致的包直接拒绝） |
| 换位 | 解压到 `<base>/data/install-staging/<id>-<ts>`（**不在 `plugins/` 下**——半成品不会被扫描发现）→ 旧安装 rename 到 staging 备份 → rename 到位（**失败自动还原旧安装**）→ 旧安装私有 `files/` 移入新目录（目录名常量在 `plugin_fs::PRIVATE_FILES_DIRNAME`；无则跳过，双方都有则逐项合并、**旧数据赢**同路径冲突；恢复失败把旧安装改名 `<id>-files-recovery-<pid>` 留在 `plugins/` 待手动处理——数据安全前不删备份）→ 清备份 |
| 生效 | 双事件：`settings-applied`（清单刷新）+ `plugin-reload`（已加载模块立即从新文件重 import——**升级无需重启**） |
| 卸载 | 删 `<plugins>/<id>/`（私有 `files/` 随目录走——它就在插件目录里；`data/plugin_store.db` 的文档**保留**）；目录不存在不算错（重复卸载幂等） |
| 残留 | staging 目录在启动时整体清理（崩溃/被杀不留垃圾） |

---

## 13. 启停与状态管理

- 启停集 = `settings.toml` 的 `plugins.disabled: string[]`（缺省 = 全启用）。
- **设置 → 插件** 的 toggle 调 `set_plugin_enabled`（轻量写，不触发重量级
  apply 副作用），随后 `settings-applied` 让前端 `refreshPlugins()`。
- **fail-open**：清单里查不到的 id 视为启用（内置插件在首次清单上报前也
  如此）。
- **关闭活动模式插件**：refresh 后校验当前模式仍然存在，不存在则自动切回
  导航页并清空搜索（见 §4.3）。
- 关闭 provider：结果立即从合并中消失（模块驻留内存，重新启用即恢复）。
- 关闭 preview 服务：卫星窗不再弹出（`enabled` 门控）。
- 设置第 8 分区「插件」（`PluginsPane`）自动列出 `get_plugins` 的全部插件：
  显示名（回退 id）+ 类型/来源/版本 chips + 启停 toggle。无需为新插件写
  任何设置 UI 代码——清单字段齐了，面板就有了。设置搜索框可用关键词：
  `插件 / pluginKindMode / pluginKindService / pluginKindProvider /
  pluginBuiltin`。


---

## 14. 安全模型

**三层防线**（对应三条独立实现路径，任何一层拒绝都会让调用失败）：

1. **opaque-origin 沙箱 iframe**（§6.1）：mode 页与宿主隔离，够不到
   `parent.__TAURI_INTERNALS__` 与启动器 DOM；页面数据走 `storage`/`db`，
   跨域取数走 `lume.http`。
2. **Rust 命令侧白名单**（`plugin_perm.rs`）：每个宿主能力命令按清单
   `permissions` 校验调用方 plugin_id（fail-closed；原生路径 = main 窗口且
   无 plugin_id）；清单缓存随 `get_plugins`/`reload_plugin` 刷新。
3. **前端守卫**（`permissions.ts`）：负责知情同意与本地化文案（§11.4）。

**归属判定**（`plugin_perm::resolve_plugin_caller`）：逻辑宿主的调用必须带
supervisor 签发的 `host_token`，有效 id 一律以令牌映射为准（声称值被忽略，
冒用失效）；分离视图窗口 `plugin-<id>` 的调用强制以 label 后缀为 id；策略类
命令（启停/信任/安装/inspect）拒绝一切 `plugin-*` 窗口。逻辑帧内的裸 `invoke` 在
WebView2 IPC 层就过不去（opaque origin，无 ACAO——"Origin header is not a
valid URL"），fail-closed。

**信任模型**：动态加载 = 任意代码执行。**显式放置即信任**——用户自己把插件
放进 `<base>/plugins/`（或经 `.lupx` 确认安装）。`.lupx` 签名（§12）与安装
确认卡把「知情同意」放进流程。

**残余边界（如实说）**：启动器主窗口内的视图 iframe（label 仍是 main）
逃逸沙箱后的裸 `invoke` 沿用既有白名单规则（main 直通）；db/storage/
settings 类无权限命令对 main 窗口内的帧仍按声称 id 计——彻底关闭它需要
给视图帧也发令牌。跑在逻辑宿主里的插件逻辑已由令牌归属强制（上段）。
`fs.readText`/`thumb`/`icon`（及 `app.trash`）暴露任意路径的读取与删除能力，
现已被 `fs.read` / `trash` 声明覆盖。内置插件与磁盘插件在注册表/启停上无
差别，但内置代码经编译审计随包发布且不参与权限表。

**加固层**：

- **API 版本契约**（§16）：清单 `api` 超过宿主 `HOST_PLUGIN_API` → 加载期
  拒绝（前端加载门 + 逻辑宿主二次校验）。
- **`.lupx` 签名**（§12）：ed25519 验签，无效签名 inspect/install 硬拒；
  未签名包维持确认流 + 展示 SHA-256。
- **网络内网防护**（§8.1 http）：插件请求默认拒绝回环/私网/链路本地目标，
  `network_allow` 白名单放行；重定向逐跳重检（302 跳内网同样被拒）。
- **插件熔断**：同一插件连续 3 次 hook 失败（超时/推送失败/ok:false）→
  标记离线 + toast，其调用快速失败、load 不重发（其余插件不受影响）；
  重载/保存设置复位。帧卡死由 supervisor 6s 兜底回执（先于 registry 8s
  超时），未就绪/重载窗口的调用按「未就绪」快速失败、不计熔断。**从未申请
  逻辑帧的插件**（纯视图 mode，无 `entry`）同样豁免：supervisor 对未加载
  id 静默丢弃（无令牌、无法回执），若不豁免，宿主广播（如 `setQuery("")`）
  会让每个纯视图 mode 每轮呼出白烧一次 8s 超时并计熔断；mode 实例侧
  `throttledLogicCall` 也按 `entry` 门控，视图页状态只走 iframe 桥。
- **失败不静默**：帧侧与视图桥的 rpc 不吞错；两个宿主（逻辑宿主与视图桥）
  的 reply 遇不可克隆值（http 的 `text()`/`json()`）都剥离函数重发而非降级
  为假失败。
- **桥看门狗不抢请求自己的超时**：视图桥 rpc 兜底超时对 `http.request`
  取其 `timeoutMs`（钳 1–60s）+5s 余量，其余方法 10s（逻辑帧 rpc 为 30s）。
  回归探针：`scripts/cdp_http_probe_verify.mjs`（离线，本地 echo 服务）。

---

## 15. 调试与测试

### 15.1 日志分级

WebView2 DevTools / CDP 可见控制台日志；Rust 侧行在 stderr 输出（dev 终端
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

### 15.2 CDP 连接

`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
启动后连 `127.0.0.1:9222`。**改前端后的重建要求**：`tauri build` 产出的
exe 把 `frontendDist` **编译期嵌进二进制**——改前端后要重新 build 才
生效。`tauri dev` / 裸 `cargo build` 不带该 feature，加载 devUrl
（localhost:1420，vite 需在跑）——调试前端不必每次重嵌。

### 15.3 观测探针 tap

`srcdoc` 视图帧的 CDP execution context 不暴露给宿主 target，探针用宿主侧
的环形缓冲：

- `window.__frameStates`（宿主，含分离窗口/逻辑宿主的页面）：视图帧经
  `__lumeFrameState` 上报的控件值（桥的 `reportState`：就绪/恢复即时报 +
  1s 心跳），`values[{id,name,value}]` 与 `form`（宿主形态
  `"launcher"`/`"window"`）。`restoring` 字段 = 迟到 DOM 重试窗口是否仍在
  活动——状态「回弹」类问题的判据。
- `window.__logicCircuit`（main）：熔断状态（`failCounts`/`offline`）与
  失败原因环形缓冲 `log`。
- `window.__sessionFrames`（main）：会话帧存取记录（`{op: put/take/
  evict/drop, id, frame, frames}`）；`window.__snapPending`（main）：最近
  一次帧入库的字段摘要（`{id, frame, stored, fields}`，`k=v` 前 12 条）；
  `window.__pwClosed`（main）：关闭回传的 `{hasSnapshot, query, user}`
  （`user:true` 才触发回流到该插件页）。
- `window.__idleReset`（main）：每次闲置重置的决策
  `{at, reset:[ids], kept:[ids]}`（`kept` = 分离中或豁免、未被重置的模式），
  环形缓冲 40 条——`scripts/cdp_idle_reset_verify.mjs` 的判据。
- `window.__queryRoute`（main）：搜索框路由环形缓冲 80 条
  `{at, mode, ev, q?, to?, mirror?, perMode?}`（`ev` =
  set/switch/search/clear/consume/adopt/toggle）——共享查询的搬运、行进入
  消耗与开关过渡最终只落到框内文字，探针靠它断言 mirror 写入与 consume；
  `scripts/cdp_mode_query_verify.mjs` 的判据。
- `window.__rpcLog` / `__logicEntries`（逻辑宿主）：帧 rpc 结局摘要与
  每插件帧状态（`loaded`/`calls`）。
- `window.__pluginThemes`（各窗口）：本插件的颜色模式偏好写入
  记录 `[{id, pref, source}]`（`source` = main/window/settings/launcher）——
  沙箱页面不可达、分离窗口的 `data-theme` 只反映当前值，探针靠它读**意图**
  与**来源**；`window.__themeLog`（main）是每次下发给模式页的 `theme` 载荷
  `[{id, mode}]`（`postEv` 收口）；`window.__pwPush`（main）是每次跨窗口
  `plugin-state` 推送的 `{id, theme, themePref}`（含发给别的插件的 —— 用来
  验证推送归属）。
- `__lumeFrameBoot`（桥 → 宿主）：视图页文档真正提交、桥脚本开始
  执行时的第一个信号。宿主用它把**「帧活着、只是慢」**与**「导航被丢了」**
  区分开（后者靠 `__lumeReady` 永远等不到：那要等页面 load）——装载看门狗
  据此决定是否重新触发导航（§6.8.1）。插件页无需消费。

### 15.4 验证脚本索引

以下脚本位于 `scripts/`（CDP 冒烟；运行前需构建带内嵌前端的 exe）：

- `cdp_sandbox_verify.mjs` — 沙箱：opaque iframe 隔离 +
  桥接/按键/焦点在沙箱内照常 + Rust 命令侧白名单（探针插件
  `scripts/fixtures/sandbox-probe/` 在沙箱内自检）。
- `cdp_plugin_window_verify.mjs` — 独立窗口：分离 →
  状态握手 → 聚焦/enter 投递 → Esc 销毁 → 几何记忆 → 禁用自动关窗。
- `cdp_p3_verify.mjs` — 数据层/权限/私有文件/声明式设置。
- `cdp_lupx_verify.mjs` — `.lupx` 安装/卸载：inspect
  形状与拒绝路径 → 安装未重启可用 → subdir/升级/卸载 → 设置页按钮与
  两段式卸载。
- `cdp_p2b_verify.mjs` — files 拖入 / img 剪贴板图片 / template="list" 列表模板 /
  磁贴指针重排 / folder·image·extensions 类别匹配。
- `cdp_plugin_theme_verify.mjs` — 插件自身颜色模式：
  启动器浅色基线 → 页面声明 pin → 画布转深而启动器不动 → 反向（插件 pin 浅、
  启动器深）→ 分离窗口 chrome/画布都是插件色 → 窗口内改偏好回传启动器 →
  回启动器后仍是 pin 的值（1×1 `Page.captureScreenshot` + zlib 解 PNG
  直接采样画布像素 —— 沙箱帧的 CDP DOM/execution context 对宿主不可见，
  这是唯一能断言的「渲染结果」）。
- `cdp_plugin_verify.mjs` — provider 行 + 沙箱化 mode 页 + 插件面板截图。
- `cdp_plugin_state_verify.mjs` — 保活 / detach 继承 / enter 扇出 /
  关闭回流 / 再分离。
- `cdp_idle_reset_verify.mjs` — 闲置重置决策（`__idleReset` 探针）。
- `cdp_mode_query_verify.mjs` — 共享查询路由（`__queryRoute` 探针）。
- `cdp_http_probe_verify.mjs` — 视图桥 rpc 超时与 `http.request` 的
  `timeoutMs` 交互（离线，本地 echo 服务）。
- `cdp_window_feature_verify.mjs` — `type = "window"` 规则匹配与 payload 投递。
- `cdp_settings_smoke.mjs` — 8 分区设置冒烟。
- `cdp_launcher_shots.mjs` — 启动器截图（前后对比）。

### 15.5 手工验证清单

- 放入插件 → 重启 → 设置/插件可见 → 搜索出现结果行 → 启停 toggle 即时生效
  → 关闭活动模式插件自动回导航页。
- mode 页可另验 `setPlaceholder` 按钮（§6.10）与 DevTools Verbose 下的
  RPC 轨迹；数据与设置面可验设置项渲染与改动后插件 toast、以及未声明能力
  的拒绝文案；`detachable` 模式可验「在独立窗口打开」→ 窗口内 toast/resize
  → Esc 关闭 → 再分离原位恢复（§6.8）。


---

## 16. 兼容性与版本化

- **宿主 API 版本契约**：宿主实现的版本 = `HOST_PLUGIN_API`（当前
  **1**，Rust `plugins.rs` 与前端 `types.ts` 双侧镜像）。清单 `api` 字段缺省
  = 当前版本；声明更高版本 → 加载期拒绝 + 明确提示（前端加载门 + 逻辑宿主
  二次校验）。演进规则：**破坏性变更必须 bump 版本**；非破坏性新增（新能力、
  新 hook、新字段）不 bump；废弃的 API 先标注、保留至少一个版本周期后再在
  bump 时移除。v1 之前以「字段只增不改义」演进的历史照旧成立。
- **图标两套是增量字段**：`icon_light`/`icon_dark` 与运行时
  `icon: {light,dark}` 未 bump 版本；旧宿主忽略新字段后回退 `icon`（仍无则
  无图），需要兼容旧宿主的插件保留一个 `icon` 兜底即可。
- `kind` 是分发键，新增贡献类型会引入新的 kind 值。
- `ModeInstance.rows` 已泛化为 `PageRow`（`AppEntry | ClipboardItem`，
  主窗口部件化改造）；任意模式自定义行模型仍留待后续。
- 磁盘插件的 JS 在 blob URL 中执行：可用标准 Web API 与标准 ESM 语法
  （`export`），但**不能 `import` 项目内部模块或第三方包**（无解析根）；
  blob 带 `//# sourceURL=lume-plugin/<id>/<相对路径>`，DevTools 按真实
  文件名显示。
- **插件数据的落点**：`storage.json` 已迁到 `<base>/data/plugin_store.db`
  的 `__storage` 文档（旧文件改名为 `storage.json.migrated` 保留）。`storage.*`
  旧调用语义不变，但**换机/备份时不要只拷 `plugins/`**——插件数据在 `data/` 里。

---

## 17. 路线

未做项（市场源、拖包/文件关联安装、浏览器 URL/划词捕获、超级面板、
AI 宿主 API）与开放事项、优先级见 `docs/ROADMAP.md`。

关于「为什么不做」的决策依据与已落地能力的实现细节见 docs/ROADMAP_HISTORY.md。
