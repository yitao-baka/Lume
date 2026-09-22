# 设置功能规范（Settings）

迭代状态：**分组卡片布局（2026-08-30 重排）**。信息架构与 `feat/flutter-settings`
分支的 Flutter 独立设置 exe 对齐；实现载体仍是主进程的 SolidJS WebView2 窗口
（两个 Lume 版本共用同一 settings.toml 格式，仅设置载体不同）。通用文件规范见
`docs/NORMS.md`。

## 概览

- **独立设置窗口**（launcher 之外的 `settings` webview，带原生标题栏），
  940×660 启动（min 560×420），可调整大小；齿轮按钮 + 托盘「设置」打开；
  标题栏 X = 隐藏（工作副本保留），`close_settings` 在保存成功后调用。
- 打开设置窗口不影响 launcher 自身的显隐与焦点逻辑；隐藏时窗口内存随
  WebView2 `SetMemoryUsageTargetLevel` 裁剪（`sync_aux_memory_targets`）。

## 布局（Chrome 式分组卡片）

```
┌────────────────────────────────────────────────────────┐
│  Lume                        [🔍 搜索设置____________]  │  ← 顶栏
├──────────────┬─────────────────────────────────────────┤
│  外观        │      分组标题（accent 小字）              │
│  导航页      │  ┌─────────────────────────────────┐    │
│  剪贴板      │  │ 标签行                控件（右）  │    │
│  快捷键      │  │ 标签行                控件（右）  │    │
│  搜索        │  └─────────────────────────────────┘    │
│  系统        │      分组标题                            │
│  关于        │  ┌─────────────────────────────────┐    │
│              │  │ …                                │    │
│              │  └─────────────────────────────────┘    │
├──────────────┴─────────────────────────────────────────┤
│                       [恢复默认设置] [保存并应用]        │  ← 底栏
└────────────────────────────────────────────────────────┘
```

- **顶栏**：`Lume` 标题 + 「搜索设置」输入框。
- **导航栏**（160px）：8 个分区，图标取 `res/icons/`（platte / navigate /
  clipboard / keyboard / search / system / plugins / about.svg）。
- **内容列**：居中、max-width 720；每分区由若干「分组标题 + 卡片」组成，
  卡片 = `--surface-raised` 底、12px 圆角、细边框；行 = 标签左 + 控件右。
- **底栏**：「恢复默认设置」（次要）+「保存并应用」（主要，`!dirty` 禁用）。

### 设置搜索框

与 Flutter 设置 exe 的 `_cardText` 机制一致：每个分区持有一份 i18n 键清单
（`Settings.tsx` 的 `SECTION_SEARCH_KEYS`），查询对分区标题 + 清单的本地化
文本做大小写不敏感子串匹配；不匹配的分区从导航栏隐藏，内容区**堆叠显示全部
匹配分区**；清空查询恢复单分区视图；点击导航项即清空查询回到该分区。

## 保存 / 恢复语义

- **「保存并应用」**：备份（当前 `settings.toml` → `backup.toml`，覆盖式）→
  写入 → 立即生效（dedup 唯一索引重建 / 窗口宽度 / 呼出热键重注册 / 索引
  刷新 + `settings-applied` 事件）→ **关闭设置窗口**；失败留在设置页
  （保持脏状态）供重试。
- **「恢复默认设置」= 两步语义（同 Flutter）**：仅把内存工作副本重置为
  `DEFAULT_SETTINGS`（`src/settings/types.ts`，镜像 Rust `Default`）并标脏 +
  toast；**不写盘**，需再点「保存并应用」才落盘。无确认对话框（两步天然防
  误触）。`restore_default` 命令保留但设置页不再调用。
- 开机自启动 / 服务注册卸载 / 导入 / 导出 / 恢复备份 / 刷新索引 = **即时
  生效**，不走脏状态。

## 分区与控件

### 1. 外观（`navAppearance`）

| 控件 | 键 | 值 |
|---|---|---|
| 语言（chips，带图标） | `appearance.language` | system / en / zh-CN / zh-TW |
| 颜色模式（chips） | `appearance.color_mode` | system / dark / light |

### 2. 导航页（`navLauncher`）

组「窗口」：

| 控件 | 键 | 档位 |
|---|---|---|
| 宽度 | `appearance.window_width` | 540 / 720 / 900 |
| 高度 | `appearance.window_height` | 420 / 520 / 620 |
| 窗口位置 | `appearance.window_position` + `remember_position` | 居中 / 跟随鼠标 / 左上 / 右上 / 左下 / 右下 / **自定义**（=记住位置，Flutter 版没有） |

组「导航栏」：显示最近使用 `show_recent`、显示 Explorer 栏
`show_explorer_bar`、默认展开已固定 `expand_pinned`、Shift+Enter 管理员
`shift_enter_admin`（均为 toggle）；最近使用条数 `recent_count`
（10/20/30/50）；应用 / 剪贴板占位符 `search_placeholder_apps` /
`search_placeholder_clipboard`（220px 输入框）；记住上次所在页面
`remember_last_page`（+ hint）。

组「条目框」：条目框大小 `entry_size`（70 / 110 / 150）。

> **档位变更（2026-08-30）**：宽度 600/720/840 → 540/720/900、高度
> 360/520/720 → 420/520/620、条目框 80/110/140 → 70/110/150、最近使用
> +50 档——与 Flutter 版对齐。旧的非默认值仍生效，只是对应 chip 不再高亮。

### 3. 剪贴板（`clipboard`）

卡片「历史记录条数上限」（组标题复用首行标签，同 Flutter）：上限
`history_cap`（100/200/500/1000）、记录图片 `record_images`、记录文件
`record_files`、合并复制 `merge_copy` + 条件显示的**合并窗口滑块**
`merge_window_ms`（500–5000ms，步进 100，显示秒——由档位 chips 改为滑块）、
**忽略应用整宽列表编辑器** `ignore_apps`（damage-map 图标行 + 输入行 +
folder_plus 添加，空态「尚未添加忽略应用」）、内容去重 `dedup`（+ hint）。

组「显示」：显示来源应用 `show_source_app`、时间显示方式 `time_display`
（相对/绝对 chips）、悬停选中条目 `hover_select`、收藏的条目置顶显示
`favorites_top`。

组「粘贴」：粘贴后关闭窗口 `paste_close`。

组「预览」：开启预览 `preview`（+ hint）、**记住勾选 `remember_checks`**
（本次重排新增到设置页；schema 已有，此前仅在预览区右键菜单切换）。

### 4. 快捷键（`navHotkeys`）

呼出主界面 `hotkeys.toggle` + 切换模式 `hotkeys.switch_mode` 两行。每行 =
预设 chips（呼出：Alt+Space / Ctrl+Space；切换：Tab）+ **紧凑录制按钮**
（显示当前组合；点击开始录制，标签变「按下新的组合键…」，Esc 取消）。
录制经 `validate_hotkey` **实时校验**（缺修饰键 / 与另一 Lume 槽冲突 /
被系统占用 / 无效），失败留在录制态并显示错误行。

> 预设 chips 是 main 版保留项：WebView2 捕获不到 Alt+Space（系统菜单占用），
> 预设是回到默认呼出键的唯一入口。Flutter 版只有录制按钮。

### 5. 搜索（`navSearch`）

组「索引目录」（标题行含**刷新索引**图标按钮 + 2s toast——main 版保留项）：

- **系统索引**：每目录一行 toggle（本地化标签：桌面 / System32 / 开始菜单，
  默认 Desktop ✓、System32 ✓、StartMenu ✗）→ `index.system_dirs`。
- **用户索引**：**键值编辑器**（对齐 Flutter，样式仿 Windows 环境变量对话框）
  → `index.user_index: [{name, path, no_files}]`。行 = folder_open 图标 +
  **名称（粗体）→ 路径** + **「索引文件」toggle（main 版保留项，`no_files`，
  Flutter 版无）** + 删除；添加行 = 名称输入（留空自动取 basename）+ 路径
  输入 + folder_plus 按钮，任一输入框 Enter 提交；空态「尚未添加索引项」。

组「索引缓存」：刷新间隔滑块 `index.cache_refresh_interval_minutes`
（5–1440 分钟，步进 5）。

> **schema 迁移（2026-08-30）**：`user_dirs`/`user_dirs_no_files`（旧路径
> 列表）→ `user_index` 键值结构。`Index::migrate()` 在 `read_settings` 时
> 一次性转换（name = basename），旧 settings.toml 自动升级，写回只保留
> `user_index`；两版本格式互通。`cache.rs::live_dirs` 与 `dirwatch.rs`
> 改读 `user_index`。

### 6. 系统（`system`）

- 组「开机自启动」：toggle，经 `autostart_get`/`autostart_set` 直写
  `HKCU\...\CurrentVersion\Run`（注册表为唯一事实源，即时生效不走脏状态）。
- 组「系统服务」：状态文本（未安装 / 运行中 / 已安装未运行）+
  注册/卸载按钮（UAC `runas`；取消给友好提示；2s 后重查状态）。
- 组「提权代理」（`agent_status` / `agent_install` / `agent_uninstall`）：状态文本
  （代理未注册 / 已注册未运行 / 运行中（已提权）/ 运行中但未取得管理员权限）+
  注册/卸载按钮 + 能力边界说明。与「系统服务」同款：OS 是唯一事实源、即时生效、
  不走脏状态、UAC 取消给友好提示、2s 后重查。**状态查询不会拉起代理**。
- 组「导入导出」：导出（save 对话框，默认 settings.toml）、导入（open
  对话框 + 重载工作副本）、**恢复备份设置**（双击确认——main 版保留项，
  Flutter 版已删）。`backup.toml` 由每次保存自动写。

### 7. 自动化（`automation`）

- 主开关 `automation.enabled`（默认开）；`automation.force_focus`
  （「延迟结束后抢回焦点」，默认关）。
- **`automation.use_agent`（「使用提权代理」，默认开）** —— 自动动作是否经提权
  代理 `lume-agent.exe` 发送。`SendInput` 受 UIPI 限制只能投递给同级或更低完整性
  级别的窗口，因此以管理员运行的目标程序必须走这条通道。代理本身要在「系统」页
  注册；未注册或关闭时 Lume 仍在自身进程内发送，并在日志中如实说明失败原因。
- **`automation.agent_resident`（「登录后常驻代理」，默认关）** —— 关：代理按需
  拉起、空闲 60s 自灭；开：常驻（几 MB），注入零延迟。
- 规则列表：每条 = 程序 | 快捷键（录制按钮）| 测试 | 延迟 | 开关 | 删除；底部添加
  行（程序输入 + 选择 + 快捷键 + 延迟 + 添加）。「测试」优先经代理执行——设置窗
  自身不是提权的，否则无法验证一个提权目标。

### 8. 插件（`plugins`）

> **重设计（2026-09-22）**：从扁平行列表升级为插件管理器式卡片布局
> （`PluginsPane.tsx`，样式类 `plg-*`）。

**工具栏**：概要行（「共 N 个插件 · M 个已启用」）+ 分段筛选
（全部 / 已启用 / 已停用 / 磁盘插件）+ 关键词筛选输入框（按名称 / id /
描述 / 关键词子串匹配）；无匹配时显示空态「没有匹配的插件」。最右是
**「开发者模式」开关**（`plugins.dev_mode`，默认关，即时生效轻量写
`set_plugin_dev_mode`）：关闭时**隐藏全部开发者选项**（卡片上的重载按钮、
「开发」徽章、权限区的「全部授权」行），且后端 `get_plugins` 把所有插件
上报为 `trusted=false`——残留的 trusted 列表授予不了任何能力（权限层
fail-closed 到声明能力）；开启时这些选项显示并生效，随后重读插件清单。

**插件卡片**（每个插件一张）：

- 左侧 40px 图标块：manifest `icon` 经 asset 协议解析（与启动器 pill
  同规则）；无图标时按类型着色的首字母块（模式 = 蓝 / 服务 = 紫 /
  搜索提供 = 绿）。
- 名称（粗体）+ 版本 + 徽章（「内置」accent 蓝 /「磁盘」中性 /
  「开发」橙）；第二行描述（内置插件用本地化文案
  `pluginDescClipboard` / `pluginDescPreview`，磁盘插件用 manifest
  `description`）；第三行类型 + 关键词预览。
- 右侧：重载按钮（仅磁盘插件，`reload_plugin`）+ 启停 toggle +
  展开箭头。点击卡片头展开详情；已停用的卡片整卡降透明度并去饱和。

**详情面板**（单开，展开一卡收起其它）：

- 关键词 chips、进入规则（`[[features]]`：label + 类型小标 文本/文件/图片）。
- **权限**（仅磁盘插件）：manifest `permissions` 逐词映射为本地化
  能力 chips（剪贴板/网络/通知/对话框/屏幕信息/全盘搜索/读取文件/
  写入文件/回收站，悬停显示一句话说明）+ 强制说明文案 +
  橙色警示样式的「全部授权」行（`settings.plugins.trusted`，
  **仅开发者模式开启时显示**）。
- **声明式设置**（`[[settings]]`，P3.4）：toggle / select chips /
  文本输入；值 ≠ 默认时在该行下方显示「默认 {value}」提示；写入经
  `plugin_settings_put`，插件经 `plugin-settings` 事件收到变更。
- **信息**：ID 与磁盘位置（等宽字体，可选中复制）。

启停 / 全部授权 / 重载均给出本地化的 2.4s 状态反馈（成功 / 失败）。
启停语义不变：写 `settings.plugins.disabled`，`settings-applied` 后
启动器重读注册表；关闭活动模式插件自动回导航页。格式与开发见
`docs/PLUGINS.md`。

### 9. 关于（`about`）

行式布局（对齐 Flutter）：描述（`aboutTagline`）、版本（`APP_VERSION_LABEL`，
无 v 前缀）、许可证 Apache License 2.0、作者 yitao-baka、主页
`https://github.com/yitao-baka/Lume`（点击经 `launch_app` ShellExecuteW 打开）。
旧的大图标居中头部移除。

## 实现说明（2026-08-30 重排）
- 壳：`src/settings/Settings.tsx`（顶栏 / 搜索过滤 / 7 导航 / 底栏）；
  分区组件 `AppearancePane` / `LauncherPane` / `ClipboardPane` / `HotkeysPane`
  / `SearchPane` / `SystemPane` / `AboutPane`；共享控件 `controls.tsx`
  （Chip / Toggle / NumberPreset / Row）。旧 `InterfacePane.tsx` 删除（拆入
  外观 + 导航页）；`plugins.svg` / `interface.svg` 不再被设置页引用（文件保留）。
- 设置窗口 720×560 → 940×660（`lib.rs`）。
- i18n 新增 20 键（nav* / group* / searchSettings / settingsUserIndex* /
  about* / clipIgnoreEmpty），三语言同步。
- 验证：`cargo test` 74 通过（含 `legacy_user_dirs_migrate_to_key_value_index`）、
  `tsc --noEmit` + `vite build` 干净。

## 实现说明（2026-09-22 全局开发者模式）

- `settings.plugins.dev_mode`（Rust `Plugins` 结构，`#[serde(default)]`，
  默认关）；新命令 `set_plugin_dev_mode`（轻量写 + `settings-applied`，
  与 `set_plugin_enabled` / `set_plugin_trusted` 同款）。
- **trusted 门控在 `get_plugins`**（`plugins.rs`）：dev_mode 关时以空表
  调 `list_plugins`，所有插件上报 `trusted=false` —— 前端权限层
  （`permissions.ts`）无需改动即 fail-closed 到声明能力；残留 trusted id
  不授予任何能力。
- 插件页：工具栏最右「开发者模式」开关（初值经 `get_settings` 读取）；
  关闭时隐藏重载按钮 / 「开发」徽章 / 「全部授权」行，开启时显示并在
  切换后重读清单。i18n +5 键 ×3（`pluginsDevMode{,Hint,On,Off}`）。
- 测试：`plugin_dev_mode_defaults_off_and_round_trips`（整表缺失 / 缺键
  均默认关 + 轻量写往返）。

## 实现说明（2026-09-22 插件页重设计）

- `PluginsPane.tsx` 全量重写（卡片 + 详情面板），样式为 `App.css` 的
  `plg-*` 块（旧 `settings-plugin-*` 类删除）；重载按钮复用
  `settings-icon-btn` + `res/icons/refresh.svg`。
- i18n 新增 ~45 键 × 3 语言（筛选/概要/空态、详情分区标题、能力词
  `perm*` 标签 + 说明、内置插件描述、操作反馈 `pluginToast*`、
  `pluginSettingDefault`）；`Settings.tsx` 的 `SECTION_SEARCH_KEYS.plugins`
  补齐新键（能力词与分区标题可被设置搜索命中）。
- 验证：`tsc --noEmit` + `vite build` + `cargo build` 干净；
  `scripts/cdp_plugins_pane_verify.mjs` 6 项全过（工具栏/卡片结构/详情
  面板/筛选输入/已停用筛选空态/声明式设置渲染），截图
  `test/plg_dark_list.png`、`test/plg_light_detail.png`（双主题目检）。

## 实现说明（2026-09-19 提权代理）

> **变更（2026-09-19）**：自动化页新增 `automation.use_agent`（使用提权代理，
> 默认开）与 `automation.agent_resident`（登录后常驻代理，默认关）；系统页新增
> 「提权代理」组。导航项 9 个不变（无新分区）。**默认值坑**：`Automation` 原先
> `#[derive(Default)]`，整张 `[automation]` 表缺失时（功能上线前写的
> settings.toml）派生 Default 会把 `enabled`/`use_agent` 静默关掉 →
> 改为手写 `impl Default for Automation`，并由
> `automation_defaults_apply_when_the_table_is_absent` 钉住。

- 自动化页：`AutomationPane.tsx` 两个新 `Row`+`Toggle`+`settings-hint`（走壳的
  脏状态，随「保存并应用」落盘）；「测试」的失败原因分支补 `needs_agent` /
  `unavailable` / `blocked`（含 `uipi`）/ `focus_moved`。
- 系统页：`SystemPane.tsx` 新增 `AgentStatus` 接口 + `agent`/`agentBusy`/
  `agentMsg` 三个信号 + `agentText()` + `toggleAgent()`（UAC 取消识别 `canceled`、
  2s 后复查），与既有「系统服务」组同构。
- `src/settings/types.ts`：`SettingsData.automation` 与 `DEFAULT_SETTINGS` 同步
  两个字段（无编译期校验，四处手改成对）。
- 设置搜索：`SECTION_SEARCH_KEYS.automation` 补 `autoUseAgent` /
  `autoAgentResident`，`system` 补 `settingsAgentGroup`。
- i18n 新增 23 键 × 3 语言（`autoUseAgent{,Hint}` / `autoAgentResident{,Hint}` /
  `autoTest{NeedsAgent,AgentUnavailable,Blocked,FocusMoved}` / `settingsAgent*` 共
  15 键），三语言键集完全一致（253 键）。
- 命令 `agent_status` / `agent_install` / `agent_uninstall`（注册进
  `lib.rs` 的 `generate_handler!`）。
- 验证：`cargo test` 122 通过（+16，含两个新字段默认/往返与「整表缺失」回归）、
  `tsc --noEmit` + `vite build` 干净、
  `scripts/cdp_agent_smoke.mjs` 14 项 + `scripts/cdp_agent_verify.mjs`
  端到端 9 项全过（截图 `test/agent_automation.png`、`test/agent_system.png`）。
