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
permissions = ["network"]  # 预留字段 — v1 不强制
entry = "main.js"          # provider 的入口 JS（相对插件目录）
```

`kind` 决定贡献类型（**三类均已支持磁盘加载**）：

- `provider` — 向搜索结果追加条目（纯对象 `{search}` 或工厂 `create(ctx)`）
- `mode` — 整页模式：`view` HTML 自由 UI（桥接 iframe）+ 可选 `entry`
  逻辑钩子 + `keywords` 全局关键字进入 + 可选 `height` 窗口高度 +
  可选 `icon` pill 图标
  （示例 `examples/plugins/hello-mode/`；基于宿主 `search.files` 能力的
  完整文件搜索模式见 `examples/plugins/file-search/`）
- `service` — 无 UI 生命周期钩子（`onShow`/`onHide`/`onQuery`）

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

## 安全模型（v1）

加载第三方 JS = 在启动器 webview 里执行任意代码。v1 的信任模型是
**显式放置即信任**（用户自己把插件放进 plugins/ 目录），`permissions`
清单字段为将来的权限强制层预留。内置插件（clipboard/preview）编译进
二进制，与磁盘插件走同一注册表与启停路径。

## 内置插件

| id | kind | 说明 |
|---|---|---|
| clipboard | mode | 剪贴板历史整页（`src/plugins/clipboard/`） |
| preview | service | 卫星预览窗路由（`src/plugins/preview/`） |

在 设置 → 插件 关闭一个 mode 插件后，模式 pill 隐藏、Tab 不再切入；
若关闭时正停在该模式，启动器自动回到导航页。
