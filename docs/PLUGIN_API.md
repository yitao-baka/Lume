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

要拿到宿主能力（toast/剪贴板/存储…），把默认导出写成**工厂函数**（§5.6）；
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
| `permissions` | string[] | `[]` | **预留**（v1 不校验、不强制）。为将来权限层准备的声明位。 |
| `entry` | string | `""` | 入口 JS（相对插件目录）。provider 必填；mode 可选（逻辑钩子）；service 必填（钩子）。 |
| `view` | string | `""` | **mode 专属** — 视图 HTML 页（相对插件目录），渲染进桥接 iframe（§6）。 |
| `keywords` | string[] | `[]` | **mode 专属** — 全局关键字：Navigate 输入与关键字完全一致时，结果里出现「进入 <name>」行，激活即切进该模式（uTools 式进入）。 |
| `height` | integer | — | **mode 专属** — 本模式页面的窗口高度（逻辑 px）。省略 = 全局 设置 → 窗口大小 → 高度；前端会钳制到工作区高度（见 §5B）。 |
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
  search(query: string): Promise<{ name: string; path: string }[]>
};
```

| 成员 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `search` | `(query: string) => Promise<ProviderResult[]>` | ✅ | 同步返回数组也可以（加载器会 `Promise.resolve` 包装）。 |

`ProviderResult`：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 结果条目显示名（网格里单行省略）。 |
| `path` | string | ✅ | 文件绝对路径 **或** URL。激活时经 `launch_app`（`ShellExecuteW`）打开，两者都支持。 |

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
- **激活路径与原生条目完全一致**：点击/Enter → `launch_app`（URL 走默认
  浏览器，文件走 ShellExecute）；图标走 `get_app_icons` 管线（取不到 →
  未知图标回退，URL 条目通常就是未知图标）。
- **错误隔离**：单个 provider 的 `search` 抛错/拒绝 →
  `console.error("provider search failed: <id>")`，其它 provider 与原生
  结果不受影响。

### 5.3 能力边界（v1 provider 不能做什么）

- 无法访问启动器内部模块（i18n、store、图标缓存……）——blob 模块是独立
  作用域，只有标准 Web API + Tauri 注入的全局（`window.__TAURI_INTERNALS__`
  技术上可达，但**不属于契约**，随版本可能变化）。
- 无法贡献整页模式、右键菜单动作或卫星预览——那些是内置 mode/service
  贡献的能力（§6）。
- 无法在条目上挂自定义动作/预览——条目激活固定走 `launch_app`。

### 5.4 加载与禁用语义

- **单次加载**：`loadDiskProviders` 用 `loadedDiskIds` 保证每个 id 每会话
  只 import 一次（无论成败）。修改插件代码 → 重启 Lume。
- **禁用**：设置 → 插件 关闭后，`settings.plugins.disabled` 记录 id →
  `providerPlugins()` 的 enabled 过滤把它的结果从合并中剔除——**但模块
  仍驻留内存**（v1 不卸载已加载模块）。重新启用立即恢复结果，无需重启。
- **内置 provider**（如果有）与磁盘 provider 走同一合并管线。

### 5.5 完整参考示例

`examples/plugins/web-search/`——为每个查询追加一个 Bing 搜索条目。
安装：把整个 `web-search/` 目录拷进 `<base>/plugins/`，重启或触发一次
settings-applied，然后在 设置 → 插件 里确认它处于开启状态。

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

mode 页是 srcdoc 同源 iframe，注入的桥接客户端暴露一个 Promise RPC 对象
`window.lume`（方法拒绝时 reject；桥接层捕获并 `console.error`，返回
`undefined`）：

| 组 | 方法 | 说明 |
|---|---|---|
| `app` | `hide()` / `toast(text, opts?)` / `setQuery(q)` / `setPlaceholder(text)` / `openPath(path)` / `revealPath(path)` / `trash(paths)` / `resize({width?, height?})` | 同 §6B.0 的组合根能力；`setPlaceholder` 自定本模式搜索框占位文字（§5C）；`openPath` 经 `launch_app`（文件/URL 均可）并标记「已使用条目」；`revealPath` 在 Explorer 中定位并选中目标（**不**标记「已使用条目」、**不**隐藏启动器——打开位置后用户通常还要继续搜，是否隐藏由插件自定）；`trash(paths)` 把文件/文件夹批量送入回收站（无永久删除回退，失败即 reject；宿主不做确认框，删除确认由插件自行用 toast/UI 二次确认实现） |
| `clipboard` | `readText()` / `writeText(text)` | 系统剪贴板文本 |
| `fs` | `readText(path)` / `thumb(path)` / `videoPoster(path)` / `icon(paths)` | 文件读取能力：`readText` 返回文本内容（lossy-UTF8 解码；**> 512KB reject**——插件自行显示「预览前 512KB」类提示）；`thumb` / `videoPoster` 返回 base64 PNG data URI（可直接进 `<img src>` / `poster`；shell 无缩略图提供者时 reject）；`icon` 返回与 `get_app_icons` 同形的 `{path, icon}[]`（icon 为 data/asset URI 或 null） |
| `storage` | `get(key)` / `set(key, value)` / `remove(key)` | 插件私有 KV（`<base>/plugins/<id>/storage.json`） |
| `search` | `files(q, opts?)` | **全盘文件搜索** — 统一门面 `file_search`（Everything 在运行则走它的 IPC，否则 LumeSVC 自研 USN 索引）。返回 `{backend: "everything"\|"svc"\|"none", status: "ready"\|"building"\|"unavailable", total?, sort?, entries: [{id,name,path,isFolder,mtime?,size?}]}`。`opts` 兼容旧调用：**数字 = max**；对象 = `{offset, max, sort}`——`max` 默认 12、钳制 1..=100；`offset` 从第 offset 条开始（0 起，Everything 全量有效，svc 引擎无偏移由宿主取页后裁剪）；`sort` 取 `"name" \| "path" \| "size" \| "mtime" \| "name_desc" \| "path_desc" \| "size_desc" \| "mtime_desc"`（非法值 = 引擎默认序；svc 无全局排序，对返回页做页内排序并如实回显）。`total` 为引擎报告的总命中数（svc / 老版 Everything 拿不到时缺省）；条目的 `mtime`/`size`（ms epoch / 字节）拿不到时缺省，UI 按字段存在与否自适应隐藏列。完整示例 `examples/plugins/file-search/` |

事件（页面赋值 `window.lume.on.<type> = fn`）：

| 事件 | 载荷 | 时机 |
|---|---|---|
| `query` | `string` | 模式激活期间的每次搜索框输入（含清空） |
| `show` | — | 模式切入 / 每次呼出（reset） |
| `hide` | — | 启动器隐藏且本模式活动 |
| `key` | `{key, ctrlKey, shiftKey, altKey}` | 模式激活时的 keydown 转发——**↑↓/Enter/翻页等导航键由模式页自行实现**（磁盘 mode 的 `rows()` 为空，根网格键位不生效；搜索框中的文本编辑键照常）。焦点在插件 iframe 内时同样送达：iframe 的 keydown（冒泡阶段、目标非可编辑、未被插件 `preventDefault`）由宿主回投 window 路由后经本事件回流。示例 file-search 用 ↑↓ 移动选中、Enter 打开、Ctrl+Enter 复制路径 |

Esc 默认不经过 `key` 事件（根统一处理：菜单 → 模式 onEscape → 卫星预览 → 隐藏）。**插件要消费 Esc**：在自己的 document 上挂冒泡 keydown 监听并 `preventDefault`（须在宿主转发监听之前注册——页面自身脚本先于桥接转发执行，天然满足）——被消费的按键不再回流根路由。iframe 内非可编辑目标的按键在转发后同样经过根 `blockBrowserKeys`（Ctrl/Alt 组合被拦，与宿主非输入区行为一致）；可编辑目标（input/textarea/contenteditable）的按键完全归插件。另外，iframe 内非可编辑区域的点击会把焦点交还宿主搜索框（宿主统一兜底，插件无需自行实现 focus hand-off）。

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

- **动态加载 = 任意代码执行**。v1 的信任模型是**显式放置即信任**：用户
  自己把插件放进 `<base>/plugins/`。清单 `permissions` 字段只是声明位，
  v1 不校验、不隔离——插件代码与启动器同权限（可达 Tauri IPC）。
- **`fs.readText`/`thumb`/`icon`（及 `app.trash`）暴露任意路径的文件读取
  与删除能力**，与 v1 信任模型（显式放置即信任）一致；`permissions`
  强制层落地后纳入白名单。
- 内置插件与磁盘插件在注册表/启停上无差别，但内置代码经编译审计随包发布。
- 后续方向：`permissions` 强制层（IPC 白名单）、插件沙箱、签名校验。

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
    remove (<id>) <key> → …`（值只记大小不记内容）。
- **CDP 连接**：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`
  启动后连 `127.0.0.1:9222`。现成脚本：
  - `scripts/cdp_plugin_verify.mjs` — provider 行 + 插件面板截图
  - `scripts/cdp_settings_smoke.mjs` — 8 分区设置冒烟
  - `scripts/cdp_launcher_shots.mjs` — 启动器截图（前后对比）
- **手工验证清单**：放入插件 → 重启 → 设置/插件可见 → 搜索出现结果行 →
  启停 toggle 即时生效 → 关闭活动模式插件自动回导航页；mode 页可另验
  `setPlaceholder` 按钮（§5C）与 DevTools Verbose 下的 RPC 轨迹。

---

## 11. 兼容性与版本化

- v1 没有 manifest 版本字段与协商机制——契约变更以「字段只增不改义」的
  方式演进；`kind` 是分发键，新增贡献类型会引入新的 kind 值。
- `ModeInstance.rows` 目前与剪贴板行形状（`ClipboardItem`）耦合，泛化为
  任意模式自定义行模型留待后续。
- 磁盘插件的 JS 在 blob URL 中执行：可用标准 Web API 与标准 ESM 语法
  （`export`），但**不能 `import` 项目内部模块或第三方包**（无解析根）。

---

## 12. 路线

- 权限强制层（消费 `permissions` 声明：IPC 白名单/能力注入）
- 磁盘 `mode` / `service` 动态加载（需要视图与服务的沙箱化）
- provider 结果的自定义动作与预览
- 插件级设置界面（插件自述设置项 → 设置页自动渲染）
