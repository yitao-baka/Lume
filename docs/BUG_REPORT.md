# Bug 搜查报告（插件系统重点）

> 基线：`76a99eb`（2026-10-16）。行号以该版本为准，修复后可能偏移。
> 复现件位于仓库本地 `test/`（scratch，不入库）。本文只记录开放缺陷与加固项；
> 每项都写了"位置 / 根因 / 复现 / 影响 / 修复建议"，便于逐项处理。

## 摘要

本轮以插件系统为重点，配合静态审查、单元测试、CDP 冒烟与自建恶意样本进行搜查：

- 基线验证：`pnpm run build` 通过；`cargo test` 211 passed / 0 failed。
- 动态验证：重建 debug exe 后运行项目自带 20 个 CDP 脚本 + 自建探针（沙箱帧、逻辑帧、
  `.lupx` 样本、重复 id、路径穿越、跨帧注入）。
- 结果：**7 个缺陷（B1–B7）+ 1 组验证脚本漂移（B8）+ 5 条加固建议**；
  其中 B1–B4 的动态复现件（`test/cdp_bugprobe2.mjs`、`cdp_bomb_probe.mjs`、
  `cdp_stall_probe.mjs`、`cdp_renamed_probe.mjs`）保留在 `test/`，继续当回归探针用。
- 本文件当前只列开放项：**B5–B8 + 加固建议**（编号沿用搜查基线，不重排）。
  B1–B4 的修复实现与验证数据见 `CHANGELOG.md` 的 `[Unreleased]`。

---

## 缺陷

### B5 功能规则正则缓存不失效、`title` 多正则互相串用

- **严重度**：中（热重载/重装后规则改动静默不生效）
- **位置**：`src/plugins/registry.ts:1299` `featureRegexCache`（全仓库仅"定义/读/写"三处，
  无任何清理）、`:1303/1316`（缓存键 `${pluginId}#${idx}`）、`:1521` `titleValueMatches`
  （同一规则的每个 `title` 值都用同一个 `ruleIdx` 作缓存键）
- **复现**：`test/cdp_regex_probe2.mjs` + `test/regex-probe/`。manifest
  `[[features]] regex = "qone"` → 输入 `qone` 出行；改为 `"qtwo"` 后调用 `reload_plugin`
  （设置页「↻ 重载」/ dev 热重载同路径）：`qone` **仍然出行**（旧正则未失效），
  `qtwo` 不出行（新正则未编译）。
- **影响**：插件开发/升级时规则类改动不生效，表现为"改了没反应"；window 规则
  `title = ["/a/", "/b/"]` 这类多正则匹配器只会用第一条的正则。
- **修复建议**：`unloadDiskPlugin`（或 `loadDiskPlugins` 前）清掉该插件 `#` 前缀的缓存
  条目；缓存键加入 pattern（如 `${id}#${idx}#${pattern}`）。

### B6 注入桥 `pendingKeys` 用对象当 Map 键

- **严重度**：低（内存泄漏 + 消费键的默认行为抑制失效）
- **位置**：`src/plugins/iframeBridge.tsx:723` `pendingKeys.set(seq, e)`（数字键）与
  `:266-267` `pendingKeys.get(d.__lumeKeyConsumed)` / `.delete(d.__lumeKeyConsumed)`
  （对象键，永远 miss）
- **影响**：每次按键转发都把 `KeyboardEvent` 永久留在 Map（注释里"收据防泄漏"的保险丝是
  坏的）；宿主路由判定"已消费"的键（Esc/Tab 等）无法再对页面原始 keydown 调
  `preventDefault`，Tab 的焦点移动等浏览器默认行为失去抑制。
- **修复建议**：`pendingKeys.get(d.__lumeKeyConsumed.seq)`、
  `.delete(d.__lumeKeyConsumed.seq)`。

### B7 重复插件 id 未去重，身份归属存在歧义

- **严重度**：低（需要同 id 冲突才会触发）
- **位置**：`src-tauri/src/plugins.rs` `scan_disk_plugins` / `list_plugins`（不去重）；
  `src-tauri/src/plugin_perm.rs::find_manifest` 只取扫描到的第一个；前端
  `loadedDiskIds` 只加载第一个。
- **复现**：`test/cdp_dup_probe.mjs` + `test/probe-dup/`。两个目录同
  `id = "renamed-id"`，`get_plugins` 返回两条同 id 条目（一条 mode、一条 provider，
  权限各异），且 dir 都指向同一个不存在的路径。
- **影响**：加载对象与权限校验对象可能不是同一份清单（"谁的 permissions 被采用"取决于
  目录枚举顺序），至少是可预期之外的半坏状态。
- **修复建议**：扫描时按 id 去重并明确优先级；或在设置页明确提示重复 id 并拒绝其一。

### B8 自带验证脚本的漂移与环境依赖

- **严重度**：低（影响回归信号可信度）
- **`scripts/cdp_plugin_theme_verify.mjs` ⑧a 稳定失败**（复跑 2 次均 27/1）：
  脚本假设关窗后从导航页重新进入 hello-mode；而"关窗回流到该插件页"是 #40/#42 之后的
  既有契约，启动器已直接停在插件页（⑧b 颜色断言反而通过）。属断言陈旧，需更新脚本。
- **`scripts/cdp_filesearch_smoke.mjs`**：本机 Everything 未运行 → backend=svc，按脚本
  定义必红；另外首跑偶发控制台错误
  `provider onSettings failed: logic not loaded`（启动时设置推送先于逻辑帧就绪的竞态噪声，
  功能有 `pendingLogicSettings` 补投兜底，但"console errors 必须为空"的断言会偶发变红）。
- **`scripts/cdp_window_feature_verify.mjs`**：依赖本机 Notepad3 与中文标题激活，本次
  2 条 title 规则断言因前台未切到夹具 B 而失败；首跑还出现过一次不可复现的
  `pin_app: state not managed`（疑似与残留 webview/启动时序有关，建议加清理与重试）。

---

## 攻击面实测结论（防住的部分）

- **沙箱帧 raw invoke**：逻辑帧/视图帧内 `window.__TAURI_INTERNALS__` 确实存在，但
  `invoke(...)` 全部被 Tauri 拒绝（opaque origin 的 Origin 头无效："Origin header is not
  a valid URL"）。因此未加 Rust 守卫的命令当前不可被插件直接利用（见加固项）。
- **令牌归属**：`plugin_logic_meta` / `plugin_logic_register_tokens` 从帧内调用同样被
  origin 拒绝；策略类命令（`set_plugin_*` / `plugin_lupx_install` / `plugin_uninstall`）
  有一致的 `deny_from_plugin_windows`。
- **路径穿越**：`src/pluginLogic.tsx:137` 的前缀字符串校验可被 `dir\..\..\...` 构造绕过，
  但 Tauri asset 协议 `SafePathBuf` 对 `..` 一律 403（真实 exe 验证：干净路径 200、
  含 `..` 403），未形成可利用漏洞。
- **权限台账与 Rust 校验对齐**：`RPC_PERMISSION` 中声明类能力（network / clipboard /
  notify / trash / window / dialog / screen / search.files / fs.write）逐条核对均有
  Rust 侧同名校验；`plugin_fs` 的私有文件名/保留设备名/目录逃逸防护测试完备。
- **CDP 套件**：插件相关脚本除 B8 外全部通过（插件桥接 29/29、沙箱 14/14、
  插件状态 54/54、LRU 22/22、独立窗口 16/16、HTTP 探针 11/11、帧装载 5/5、
  lupx / 设置面板 / 功能规则等其余脚本；circuit 在补齐本地禁用状态后通过）。

## 加固建议（未构成当前可利用漏洞）

1. 给 `get_file_text` / `get_file_bytes` / `get_file_thumb` / `get_video_thumb` /
   `get_app_icons` / `get_clipboard_text` / `set_clipboard_text` 补 `plugin_id` +
   `host_token` 与 capability 校验（目前只有前端台账 + origin 拦截两层；一旦沙箱属性
   改动或 Tauri 放宽 origin 策略即变成免授权文件读/剪贴板读写）。
2. `plugin_window_push_state` / `plugin_window_close` /
   `plugin_logic_host_ensure` / `plugin_logic_host_close` 无调用方窗口约束（仅靠
   "沙箱帧打不到 invoke"）；建议统一加 label 校验。
3. `.lupx` inspect→install 之间无哈希绑定，确认卡展示的清单理论上可与最终安装的包不同
   （TOCTOU，需本机并发改文件）；install 时可携带 inspect 返回的 sha256 做一致性校验。
4. `src/pluginLogic.tsx:190` 每个插件加载都注册一个永久 `message` 监听器，
   `unloadPlugin` 不移除（重载泄漏闭包/监听器）；建议命名监听器并在 unload 时移除。
5. `readPluginFile` 建议改用组件级路径比较（或规范化后比对），不要依赖
   "前缀字符串 + 下游 403"这层巧合防御。

## 复现件速查

| 缺陷 | 证据 |
|---|---|
| B5 正则缓存 | `test/cdp_regex_probe2.mjs`、`test/regex-probe/` |
| B7 重复 id | `test/cdp_dup_probe.mjs`、`test/probe-dup/` |
| 套件结果 | `test/run_*.log`、`test/run2_*.log`、`test/run3_*.log` |
