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

`kind` 决定贡献类型：`provider` = 向搜索结果追加条目（**v1 唯一支持动态
加载的类型**）；`mode` / `service` 目前仅内置插件使用（剪贴板/预览），
动态加载它们是后续工作。

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
