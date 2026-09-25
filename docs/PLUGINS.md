# 插件开发指南（ROADMAP #7，v1）

> **完整 API 参考**见 `docs/PLUGIN_API.md`（清单字段表、Provider 契约、
> ModeInstance/PluginServices 逐方法时序、启停语义、安全模型、调试）。
> 本文是最小上手指南。

Lume 的插件 = 一份**清单**（`plugin.toml`）+ 一份**入口 JS**（provider 类）。
插件放在 `<base>/plugins/<id>/`（便携版 = lume.exe 同级的 `plugins/`；安装
版 = `%LOCALAPPDATA%\Lume\plugins\`），启动时被自动发现，在 **设置 → 插件**
里启停（`settings.plugins.disabled`）。

## 清单（plugin.toml）

```toml
id = "web-search"          # 可省略 — 默认取目录名；须全目录唯一
name = "Web Search"        # 设置页显示名（可省）
version = "1.0.0"          # 可省
kind = "provider"          # provider（搜索提供）| mode | service
description = "…"          # 可省
permissions = ["network"]  # P3.2 起强制：用到的能力必须声明（见下）
entry = "main.js"          # provider 的入口 JS（相对插件目录）
```

`kind` 决定贡献类型（**三类均已支持磁盘加载**）：

- `provider` — 向搜索结果追加条目（纯对象 `{search}` 或工厂 `create(ctx)`；
  条目支持 `description` 副行、显式 `icon` 与 `enter` 动作回调（激活不打开
  文件而是回调 `onEnter(item)`），完整契约见 `docs/PLUGIN_API.md` §5.1；
  多文件入口（`entry` 指向目录）见 §5.6。示例 `examples/plugins/web-search/`
  与 `examples/plugins/actions/`）
- `mode` — 整页模式：`view` HTML 自由 UI（桥接 iframe）+ 可选 `entry`
  逻辑钩子 + `keywords` 全局关键字进入 + 可选 `height` 窗口高度 +
  可选 `icon` pill 图标
  （示例 `examples/plugins/hello-mode/`；基于宿主 `search.files` 能力的
  完整文件搜索模式见 `examples/plugins/file-search/`；`template = "list"`
  免 HTML 列表模式见 `examples/plugins/list-demo/`）
- `service` — 无 UI 生命周期钩子（`onShow`/`onHide`/`onQuery`）

`keywords` 的匹配分级为 精确 → 前缀 → 拼音首字母 → 拼音全拼（后端预计算
拼音，输入 `miao`/`ms` 可匹配「秒搜」）。改插件代码后无需重启：设置 → 插件
每行有「↻ 重载」按钮；清单声明 `development = true` 则每次设置保存自动重载
（§5.8）。

宿主能力 API（`ctx` / `window.lume`）：`app.hide/toast/setQuery/setPlaceholder/openPath/
resize`、`clipboard.readText/writeText`、`storage.get/set/remove`（插件私有
KV）、`search.files(q, max?)`（全盘文件秒搜 = `file_search` 门面，Everything /
LumeSVC 引擎自动选择；**空查询 = 最近文件**，引擎默认按修改时间倒序）。
mode 桥接 iframe 还会收到 `lume.on.key` 按键事件
（模式激活时的 keydown 转发 {key,ctrlKey,shiftKey,altKey}——含焦点在 iframe
内的情况；模式页自实现 ↑↓/Enter，插件可对自己的 document 监听
`preventDefault` 来消费按键，如 Esc）。详见 `docs/PLUGIN_API.md` §6C。

## provider 契约（entry JS）

入口文件是标准 ES Module，默认导出必须是一个 `search` 函数：

```js
export default {
  async search(query) {
    const q = query.trim();
    if (!q) return [];
    return [
      {
        name: `搜索 "${q}"`,
        path: `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
      },
    ];
  },
};
```

- **返回条目** `{ name, path }` — 与原生结果同构：追加在原生索引结果之后
  （按 path 去重，总数封顶 20），激活时经 `launch_app` 打开（文件路径与
  URL 都可以），图标走既有管线（取不到 → 未知图标回退）。
- **调用时机**：Navigate 模式每次非空搜索（空查询的主菜单不触发）。
- **异常隔离**：单个 provider 抛错只会在控制台记录，不影响原生搜索；
  加载失败（文件缺失/非 ES Module/缺少 search）同样只记录并跳过。

完整示例见 `examples/plugins/web-search/`。

## 导航页栏目（navBars，可选钩子）

任何磁盘插件（kind 不限）都能在工厂逻辑里再实现一个 `navBars()`，向**导
航页空查询主菜单**贡献栏目（完整契约见 `docs/PLUGIN_API.md` §5A）：

```js
export default function create(ctx) {
  return {
    navBars() {
      return [
        {
          id: "links",            // 插件内唯一 — 宿主加 "<插件id>:" 前缀
          title: "快速链接",
          items: [{ name: "GitHub", path: "https://github.com" }],
        },
      ];
    },
  };
}
```

栏目渲染在「已固定」与「Windows 资源管理器」之间；条目点击/Enter 经
`launch_app` 打开（文件与 URL 均可），右键是共享 app 菜单，并参与栏目的
连续键盘导航与展开/收起。**「Windows 资源管理器」栏始终位于最下层**，插件
栏不可越过。每次呼出与插件刷新时重新拉取（可按 `ctx.storage` 动态返回）。
完整示例 `examples/plugins/nav-bar/`。

## 声明式进入与搜索链路（P2）

除关键字外，插件还能用**声明式规则**被输入自然触发（完整契约见
`docs/PLUGIN_API.md` §6E，示例 `examples/plugins/text-tools/`）：

```toml
[[features]]
code = "upper"
label = "转为大写"
over = true            # 任意非空文本命中（regex = "^https?://" 则按正则命中）
min_length = 2
```

带进来四件事：① `features` 命中出「<label>」行，激活把查询作为 payload 投递给
`onEnter`（mode）/`onFeature`（provider/service）；② `app.setSubInput`
让模式接管搜索框逐字过滤（`lume.on.subInput`）；③ provider 用 `drill` +
`select`（可选 `filter`）做二级下钻，Esc 回上一级；④ `app.redirect(插件id,
{code, payload})` 跳到另一个插件并带数据。

**文件拖入与剪贴板图片（P2.2，2026-09-22）**：规则加 `type = "files"`
（拖文件到启动器 → 「<label>（N 个文件）」行，payload 是命中路径数组
`info.paths`；`extensions = ["md", "txt"]` 过滤扩展名）或 `type = "img"`
（剪贴板有图时空查询出行，插件用 `ctx.clipboard.readImage()` 读 PNG data
URI）。示例 `examples/plugins/files-img-demo/`。

**免 HTML 的列表模式（P2.5b）**：mode 插件声明 `template = "list"` 后不用写
`view` —— 宿主用内置列表渲染 `search(q)` 返回的行（形状同 provider 结果），
↑/↓/Enter/点击走 `onEnter(item)`。示例 `examples/plugins/list-demo/`。

## 数据、私有文件与插件设置（P3）

三件事一起补上（完整契约见 `docs/PLUGIN_API.md` §6F，示例
`examples/plugins/notes/`）：

**① 文档库 `ctx.db`** — 存在独立的 `<base>/data/plugin_store.db` 里，
uTools/CouchDB 形状：

```js
const doc = await ctx.db.get("settings");            // null = 不存在
const { _rev } = await ctx.db.put({ _id: "draft", text: "…" });   // 新建 → rev 1
await ctx.db.put({ _id: "draft", text: "改一下", _rev });         // 覆盖要带读到的 rev
const all = await ctx.db.allDocs({ idStartsWith: "note:" });      // 按 id 升序
await ctx.db.bulkDocs([{ _id: "a", text: "1" }, { _id: "b", text: "2" }]);
```

并发写入靠 `_rev` 乐观锁：rev 不符时 reject，消息以 `conflict:` 开头，插件
自己决定重读还是提示。旧的 `ctx.storage.*` 仍在（内部就是库里的 `__storage`
文档，`storage.json` 已自动迁移并改名为 `storage.json.migrated`），新代码
建议直接用 `db`。

**② 私有文件 `ctx.fs`** — `<plugin>/files/`，**无需任何权限**（属于插件自己）：

```js
const path = await ctx.fs.writeText("export.txt", text);   // → 绝对路径
await ctx.fs.writeBytes("shot.png", canvas.toDataURL());   // ≤10 MiB
await ctx.fs.privatePath("export.txt");                    // 交给 openPath / paste
```

写**任意**绝对路径是 `ctx.fs.writeFile(path, text)`，需要在清单声明
`fs.write`。

**③ 插件设置** — 清单里声明，设置 → 插件 自动渲染，插件收 `onSettings`：

```toml
[[settings]]
key = "sort"
label = "排序"
type = "select"        # toggle | select | text
default = "newest"
[[settings.options]]
value = "newest"
label = "最新在前"
```

```js
const sort = await ctx.settings.get("sort");
onSettings(values) { /* 面板一改，这里立刻拿到新值 */ }
```

## 权限（P3.2 起强制）

`permissions` 不再是预留字段：**台账里的能力没声明就调用会被明确拒绝**
（fail-closed），设置 → 插件 每行显示声明的 chips，并提供「全部授权」
（开发用）。示例：

```toml
permissions = ["network", "clipboard", "fs.write"]
```

| 能力 | 声明词 |
|---|---|
| 宿主 HTTP（`http.request`） | `network` |
| 剪贴板全部读写与粘贴 | `clipboard` |
| 系统通知 | `notify` |
| 文件对话框 | `dialog` |
| 光标 / 显示器 | `screen` |
| 全盘文件搜索 | `search.files` |
| 文件读取（文本/缩略图/图标） | `fs.read` |
| 任意路径写入 | `fs.write` |
| 回收站删除 | `trash` |

不用声明的：`app.hide/toast/setQuery/openPath/…` 这类基础动作、插件自有数据
（`storage`/`db`/`settings`）与私有目录 `files/`。完整台账与边界（含「这是
前端关卡、不是沙箱」的说明）见 `docs/PLUGIN_API.md` §6D.6 与 §9。

## 安全模型（v1 + P5 沙箱）

加载第三方 JS = 在启动器 webview 里执行任意代码。信任模型是
**显式放置即信任**（用户自己把插件放进 plugins/ 目录）。`permissions`
自 P3.2 起**被强制**（上表；未声明的能力调用即失败），且自 P5 起是
**三层防线**：

1. **沙箱 iframe** — mode 页运行在 opaque-origin 沙箱里，够不到宿主与
   Tauri IPC；页内数据用 `ctx.storage`/`ctx.db`（`localStorage` 不可用），
   跨域取数用 `lume.http.request`（页内 `fetch` 受 CORS 限制）。
2. **Rust 命令侧白名单** — 每个宿主能力命令再按清单校验一次调用方
   plugin_id（直连 `invoke` 也拦得住）。
3. **前端守卫** — 未声明就调用当场报错，设置页 chips 可见。

残余边界（如实说）：跑在启动器窗口里的插件逻辑（provider/service）仍是
同源代码，可冒用任意 plugin_id——这是「显式放置即信任」的既有决定。
内置插件（clipboard/preview）编译进二进制，与磁盘插件走同一注册表与启停
路径，不参与权限表。

## 内置插件

| id | kind | 说明 |
|---|---|---|
| clipboard | mode | 剪贴板历史整页（`src/plugins/clipboard/`） |
| preview | service | 卫星预览窗路由（`src/plugins/preview/`） |

在 设置 → 插件 关闭一个 mode 插件后，模式 pill 隐藏、Tab 不再切入；
若关闭时正停在该模式，启动器自动回到导航页。
