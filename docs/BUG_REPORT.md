# 插件系统加固建议

> 基线：`76a99eb`（2026-10-16）。复现件位于仓库本地 `test/`（scratch，
> 不入库）。本文件只记录尚未实施的防御纵深建议；缺陷处置记录见
> `CHANGELOG.md` 的 `[Unreleased]` 与 `docs/ROADMAP_HISTORY.md` #50/#51。

这些项目前都不构成可直接利用的漏洞：沙箱帧的 opaque origin 会让 raw
`invoke` 被 Tauri 拒绝，且权限台账与 Rust 命令侧校验已按插件 id
fail-closed。建议的价值在于减少对单一 origin 边界的依赖，避免将来放宽
sandbox 属性或 Tauri 策略时突然变成可利用面。

## 加固建议

1. **给原生文件/剪贴板命令补调用方归属校验** — `get_file_text` /
   `get_file_bytes` / `get_file_thumb` / `get_video_thumb` / `get_app_icons` /
   `get_clipboard_text` / `set_clipboard_text` 目前只有前端台账 + origin
   拦截两层。建议加 `plugin_id` + `host_token` 参数，并按
   `plugin_perm` 的能力校验路径处理；native 调用仍只允许 main window。
2. **约束窗口/逻辑宿主控制命令的调用方** — `plugin_window_push_state` /
   `plugin_window_close` / `plugin_logic_host_ensure` /
   `plugin_logic_host_close` 还没有统一的调用窗口 label 校验。建议把这些
   命令收口到 main 窗口（或对应的插件窗口）后再执行。
3. **绑定 `.lupx` inspect 与 install 的哈希** — 确认卡展示的
   `inspect` 结果与最终安装的包之间没有 sha256 绑定；本机并发替换文件可
   造成 TOCTOU。建议 `plugin_lupx_install` 携带 inspect 返回的 sha256，
   安装前重新计算并拒绝不一致的包。
4. **卸载时移除逻辑帧 `message` 监听器** — `src/pluginLogic.tsx` 为每个
   entry 插件注册的匿名 `message` 监听器在 `unloadPlugin` 时没有被移除。
   建议把 listener 存进 `LogicEntry`，卸载时
   `removeEventListener`，避免热重载累积闭包与监听器。
5. **用规范化路径比较插件私有目录** — `src/pluginLogic.tsx` 的
   `readPluginFile` 目前用字符串前缀判断目录归属（`dir\..\..\...` 形态
   依赖下游 asset 协议 403）。建议先 `Path`/组件级规范化，再比较是否位于
   该插件目录内。

## 当前边界

- 沙箱帧内 `window.__TAURI_INTERNALS__` 存在，但 opaque origin 的 `Origin`
  头不是合法 URL，Tauri 会拒绝 `invoke`。
- `plugin_logic_meta` / `plugin_logic_register_tokens` 等令牌与策略命令从
  帧内调用同样被 origin 拒绝；策略类命令已有 `deny_from_plugin_windows`。
- 权限台账 `RPC_PERMISSION` 中的声明类能力与 Rust 侧同名校验逐项对齐；
  `plugin_fs` 的私有文件名、保留设备名与目录逃逸均有测试。
