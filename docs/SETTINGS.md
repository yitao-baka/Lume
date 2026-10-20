# 设置功能规范（Settings）

本文是设置窗口的功能、字段与交互规范。设置窗口是独立于启动器的 SolidJS
WebView2 窗口，无边框、自绘标题栏；视觉与共享行为同时以
[Quiet Control Deck](SETTINGS_REDESIGN.md)、
[Chromatic Edge](SETTINGS_REDESIGN_SELECTED.md) 和
[设置窗皮肤切换](SETTINGS_SKIN_SWITCH.md) 为准。数据文件与路径规则见
[ARCHITECTURE.md](ARCHITECTURE.md)。

## 概览

- 设置窗口是独立 `settings` webview，默认 `1040×720`，最小 `560×420`；工作区
  不足时按 64px 边距收敛，仍可调整大小与最大化。
- 标题栏固定显示品牌、命令式设置搜索和窗口控制；内容区滚动，底部 32px 状态栏
  始终可见。
- 九个分区分为「个性化」「效率」「管理」三组：
  - 个性化：外观、启动器、剪贴板
  - 效率：搜索、快捷键、自动化
  - 管理：插件、系统、关于
- 可逆偏好自动保存，不提供全局「保存并应用」。服务、代理、导入、恢复和卸载等
  系统操作仍是显式命令，并使用确认对话框与真实结果。
- 设置窗皮肤由 `appearance.settings_skin` 控制，默认 `quiet`。皮肤只改变设置窗
  视觉与版面，不改变启动器、插件页、插件窗口、托盘或 DWM 边框。
- 所有用户可见字符串走 `t()`，`languages/en.json`、`zh-CN.json`、`zh-TW.json`
  同步维护。

## 窗口与布局

```text
┌──────────────────────────────────────────────────────────────┐
│ LUME 设置            [搜索设置…  Ctrl F]         ─  □  ×    │
├───────────────┬──────────────────────────────────────────────┤
│ 个性化        │ 页面标题 / 页码                              │
│ 外观          │ 页面说明                                     │
│ 启动器        │                                              │
│ 剪贴板        │ 组标题 + 标准设置行                          │
│ 效率          │                                              │
│ 搜索          │                                              │
│ 快捷键        │                                              │
│ 自动化        │                                              │
│ 管理          │                                              │
│ 插件          │                                              │
│ 系统          │                                              │
│ 关于          │                                              │
├───────────────┴──────────────────────────────────────────────┤
│ ✓ 所有更改已自动保存                         撤销  恢复默认… │
└──────────────────────────────────────────────────────────────┘
```

- 宽布局侧栏 `208px`（Quiet）或 `224px`（Chromatic）；中等宽度分别收紧到
  `184px` / `196px`；窗口窄于 `760px` 时折叠为 `56px` 图标栏。
- 内容最大宽 `760px` 并居中；页面标题、组标题、组面板和底栏使用同一左轴。
- Quiet 使用圆角面板与双平面；Chromatic 使用直角、1.5px 结构线和编辑式页码。
  两套皮肤共用同一 DOM，切换时不重建页面、不丢失焦点或滚动位置。
- 页面头由一行说明、标题、可选页码和当前页动作组成。页面头随内容滚动，标题栏
  保持固定。

## 皮肤字段

| 键 | 类型 | 值 | 默认值 | 作用域 |
|---|---|---|---|---|
| `appearance.settings_skin` | string | `quiet` / `chromatic` | `quiet` | 仅设置窗口 |

- 首帧由 `src/index.tsx` 在 `render()` 前读取 `__LUME_CONFIG__` 并写入
  `html[data-settings-skin]`；缺少配置或未知值回落 `quiet`。
- 运行时唯一写入器为 `src/settings/skin.ts` 的 `applySettingsSkin`。
- Rust 在读取、补丁合并、导入、恢复默认、恢复备份与整表保存后统一规范化未知
  皮肤值，避免整张设置表反序列化失败。
- 切换先更新 DOM 属性、再更新工作副本并走自动保存。保存失败时 DOM、工作副本和
  控件一起回滚到最近确认值。
- 撤销与重试都走同一条保存链，不直接改属性绕过队列。

## 自动保存

可逆偏好修改统一走以下生命周期：

```text
编辑 → 本地校验/归一化 → 乐观更新与即时预览 → 合并保存队列
     → save_settings_patch（最小差异）
       ├─ 成功：更新基线；底栏显示已保存并保留 6 秒撤销
       └─ 失败：恢复最近确认值；行内与底栏显示错误和重试入口
```

- 同一时间只允许一个写请求在途；后续编辑在内存中合并，旧响应不能覆盖新值。
- 开关、分段选择和列表操作立即提交；单行文本在停止输入 500ms、失焦或 Enter 时
  提交；滑块使用 200ms 合并；快捷键校验通过后立即提交。
- 保存仍只发送相对最近确认基线的最小 patch，因此插件启停、窗口几何、最后页面等
  并发轻写不会被设置窗的整份旧快照覆盖。
- 外部 `settings-applied` 到达时，没有本地写入且没有文本焦点才重新读取；自身写入
  触发的通知只更新保存状态，不重新加载页面。
- 关闭窗口前刷新待提交队列。保存失败时保持窗口打开并聚焦底栏重试入口，不再弹出
  “是否保存草稿”。
- 导入、恢复备份、恢复默认与卸载插件不属于可撤销偏好；它们使用确认对话框并报告
  真实结果。

## 设置搜索

- 搜索框固定在标题栏中部，使用 combobox / listbox 语义；`Ctrl+F` 聚焦。
- 索引来自 `src/settings/catalog.ts` 的 `SETTINGS_CATALOG` 构建函数，包含字段
  ID、分区、显示路径、标签、摘要、详情、关键词、控件类型和当前值。
- 排序优先级为标题精确匹配、标题前缀、关键词、摘要、详情/当前值、页面名称。
- 结果一行一个设置，显示标签、页面路径和摘要或当前值；标题/摘要中的命中词高亮。
- 点击或 Enter 跳转到对应分区，把目标行滚到视口中央并聚焦行容器；目标短暂显示
  强调描边。动作类目录项只跳转，不自动执行系统操作。
- 插件名称、描述、关键词、声明式设置标签与选项值进入同一索引。插件设置跳转会
  自动筛选并打开对应插件详情，再聚焦具体设置行。
- 无结果时显示本地化空态和建议词；`Esc` 清空并关闭结果，方向键移动选中项。

## 分层帮助

1. 页面说明只解释该页共同目标。
2. 行摘要默认可见，描述真实影响，最多两行。
3. 详情按钮展开行下方帮助带，包含生效时机、影响、依赖与例外。

帮助按钮暴露 `aria-expanded` / `aria-controls`，`Esc` 收起并把焦点还给按钮。
同一页面同一时间只展开一个帮助带；摘要与详情参与搜索但不复制进结果列表。

## 控件与可访问性

- 开关使用 `role="switch"` 与 `aria-checked`；命中盒至少 44×36px。
- 分段选择使用 radio 语义，支持方向键、Home / End；焦点环与选中态分离。
- 单行输入、数字输入与滑块都有可访问名称；滑块同时显示当前值和单位。
- 快捷键以 keycap 展示；录制中失焦、点击外部或 `Esc` 都取消。
- 侧栏使用 tablist / tabpanel、roving tabindex 和方向键/Home/End 导航。
- 确认对话框是焦点陷阱：背景 `inert`，默认聚焦安全的取消动作，`Esc` 关闭，
  关闭后焦点返回触发控件。
- 窄窗口下设置行标签与控件上下排列；所有控件在 `560×420` 下可操作且无横向
  溢出。
## 页面与字段

### 01 外观（`appearance`）

页面说明：选择界面语言、明暗主题与设置窗皮肤。

- **颜色模式** `appearance.color_mode`：跟随系统 / 深色 / 浅色，使用三张主题
  预览卡。跟随系统响应 `prefers-color-scheme`。
- **语言** `appearance.language`：跟随系统 / English / 简体中文 / 繁體中文；
  语言名称使用自身语言显示，切换后当前窗口与托盘立即更新。
- **设置窗皮肤** `appearance.settings_skin`：Quiet / Chromatic。只改变当前设置
  窗口，启动器和插件页面不受影响。

### 02 启动器（`launcher`）

页面说明：控制呼出窗口的尺寸、位置、主界面内容与会话记忆。

#### 窗口

| 字段 | 控件 | 语义 |
|---|---|---|
| `appearance.window_width` | 小 540 / 中 720 / 大 900 | 启动器水平宽度 |
| `appearance.window_height` | 小 420 / 中 520 / 大 620 | 内容自动收缩时的最大高度 |
| `appearance.window_position` | 3×2 位置网格 + 跟随鼠标 + 手动位置 | 首次出现的位置策略 |
| `appearance.remember_position` | 手动位置 | 打开时不再套用预设位置 |

位置只在本次运行内继承。选择四角/居中会关闭手动位置；选择手动位置会打开
`remember_position`。重启后重新按设置定位。

#### 主界面

| 字段 | 标签 |
|---|---|
| `appearance.show_recent` | 显示最近使用（只隐藏栏目，记录继续保存） |
| `appearance.show_explorer_bar` | 显示 Windows 资源管理器栏 |
| `appearance.expand_pinned` | 默认展开已固定 |
| `appearance.mode_switch_icons_only` | 模式切换栏仅显示图标 |
| `appearance.shift_enter_admin` | Shift+Enter 以管理员身份启动 |

#### 会话与搜索

| 字段 | 行为 |
|---|---|
| `appearance.remember_last_page` | 重启后回到上次页面；搜索词不写入磁盘 |
| `appearance.per_mode_query` | 关闭时共用一个搜索值，开启后每个模式分别记忆 |
| `appearance.idle_reset_enabled` | 隐藏超过阈值后，下次呼出回到干净状态 |
| `appearance.idle_reset_minutes` | 5 / 15 / 30 / 60 / 120 / 240 分钟或自定义 1–10080；父开关关闭时禁用但可见 |
| `appearance.recent_count` | 5–200，默认 20 |
| `appearance.search_placeholder_apps` | 留空使用本地化默认提示 |
| `appearance.search_placeholder_clipboard` | 留空使用本地化默认提示 |

闲置重置会清除查询并重置未豁免的插件页面；插件 `keep_session` 默认值可由插件页
三态覆盖。分离窗口不参与闲置重置。

#### 条目

- `appearance.entry_size`：70 / 110 / 150，使用三个方块预览。
- `appearance.round_app_icons`：只影响导航结果图标；关闭时显示提取出的原始图标。

### 03 剪贴板（`clipboard`）

页面说明：管理剪贴板历史的采集、显示、粘贴与预览方式。内置剪贴板页面被停用时，
页首显示信息条，说明后台采集仍受本页开关控制，并提供前往插件页的入口。

| 组 | 字段 / 行为 |
|---|---|
| 历史与采集 | `history_cap`、`record_images`、`record_files`、`dedup` |
| 合并复制 | `merge_copy`、`merge_window_ms`（500–5000ms，步进 100；关闭合并时滑块可见但禁用） |
| 忽略应用 | `ignore_apps` 列表、手动输入、选择运行中程序、删除；名称由 Rust 归一化并去重 |
| 显示 | `show_source_app`、`time_display`、`hover_select`、`favorites_top`、`paste_close` |
| 预览 | `preview`、`remember_checks` |

固定记录不计入历史上限。图片以本地缓存保存；文件只保存引用。忽略应用区域使用
风险色边界表达隐私含义。

### 04 搜索（`search`）

页面说明：选择应用与文件搜索覆盖的目录并维护索引缓存。

- **系统索引** `index.system_dirs`：桌面、System32、开始菜单逐项开关。
- **用户索引** `index.user_index`：每项包含名称、路径、是否索引文件、修复路径与
  删除。新增前由 `validate_index_dir` 校验存在性、目录类型、可访问性与重复项。
- **索引维护** `index.cache_refresh_interval_minutes`：5–1440 分钟，启动时仍会
  刷新一次。
- 页面动作 `refresh_index`：只重建可重建缓存；运行中显示旋转图标与
  `aria-busy`，结果或错误留在页面内。

### 05 快捷键（`hotkeys`）

页面说明：设置呼出 Lume 与切换模式的按键，并查看键盘速查。

- `hotkeys.toggle`：呼出主界面，默认 `Alt+Space`。预设 Alt+Space / Ctrl+Space
  收在“常用组合”折叠区。
- `hotkeys.switch_mode`：切换模式，默认 `Tab`。单键只在搜索框聚焦时切换；
  `Ctrl+Tab` 可在任意焦点切换。
- 两个槽使用不同 Rust 校验命令：`validate_hotkey` 检查缺修饰键、Lume 槽冲突、
  系统占用与无效组合；`validate_mode_hotkey` 允许单键，只检查格式、槽冲突和
  启动器保留键。
- 录制状态在失焦、点击外部或 `Esc` 时取消。`get_hotkey` 与当前配置不一致时显示
  未注册警告。
- 键盘速查列出 F6 / Shift+F6、Ctrl+Tab、Ctrl+, 与 Shift+F10 / Menu。
### 06 自动化（`automation`）

页面说明：当指定程序的新窗口取得焦点时，自动发送一次配置好的快捷键。

| 字段 / 动作 | 行为 |
|---|---|
| `automation.enabled` | 自动动作总开关；关闭时规则仍可查看和编辑 |
| `automation.force_focus` | 延迟结束后尝试抢回目标程序焦点；失败记录日志 |
| `automation.use_agent` | 通过 `lume-agent.exe` 向提权程序发送按键 |
| `automation.agent_resident` | 登录后常驻代理；依赖 `use_agent`，关闭父项时禁用但可见 |
| `automation.actions` | 每条规则包含程序、快捷键、延迟、启用状态 |
| `test_automation_rule` | 规则卡上的“测试”；结果就地显示 |
| `list_window_programs` | 规则编辑器的程序选择器 |
| `agent_status` | 只读代理状态；管理入口跳转系统页 |

规则以卡片呈现：折叠态用“程序 + 快捷键 + 延迟”形成自然语言摘要，展开后显示
程序、快捷键、延迟与测试/开关/删除。重复程序显示行内错误和跳转入口。

### 07 插件（`plugins`）

页面说明：启用、配置和检查插件；能力只来自清单声明。

- 页面使用主从视图：左侧列表（Quiet 最宽 300px，Chromatic 274px）显示图标、
  名称、类型、来源、启用开关；右侧详情显示版本、描述、关键词、进入规则、
  权限、声明式设置、闲置重置三态、ID 与磁盘位置。
- 宽于 `900px` 时列表与详情并排；更窄时切换为“列表 → 详情 → 返回”。
- 筛选支持全部 / 已启用 / 已停用 / 磁盘插件和关键词输入。
- 声明式设置 `toggle` / `select` / `text` 使用统一行控件；写入仍走
  `plugin_settings_put`。
- `plugins.keep_session_overrides` 由三态控件维护：跟随清单 / 强制保留 / 强制重置。
- 开发者选项位于详情底部折叠区：`plugins.dev_mode`；开启后显示
  `plugins.trust_all`，全部授权需要确认并在页面顶部持续显示安全警告。
- 安装 `.lupx` 前显示名称、版本、类型、来源、文件数、大小、签名或 SHA-256、
  权限说明与升级/重装/降级关系。安装确认后才写入。
- 重载、卸载、开发者模式、全部授权与插件设置继续使用现有 Rust 命令与真实结果；
  卸载使用确认对话框。

### 08 系统（`system`）

页面说明：管理 Windows 集成、后台组件与数据备份。本页按钮是显式系统操作，
不纳入自动保存或泛化撤销。

- **开机启动**：`autostart_get` / `autostart_set`，写入当前用户启动项，不需要
  管理员权限。
- **后台组件**：
  - `svc_status` / `svc_install` / `svc_start` / `svc_restart` / `svc_uninstall`
  - `agent_status` / `agent_install` / `agent_uninstall`
  - 状态票券同时显示安装与运行状态；操作只禁用本卡动作。卸载服务与注销代理
    使用确认对话框。
- **数据与备份**：`export_settings`、`import_settings`、`restore_backup`。
  导入和恢复备份在替换前确认范围；恢复默认值也可从底栏入口触发。失败结果留在
  当前页并显示 `role="alert"`，不关闭页面。

恢复应用默认值只覆盖 `appearance`、`launcher`、`clipboard`、`hotkeys`、`index`
与 `automation` 对应内容，不修改插件状态、插件开发选项和系统集成。

### 09 关于（`about`）

- 品牌区显示 `Lume` 与一句 tagline。
- 版本 `APP_VERSION_LABEL` 可选择复制；许可证、贡献者与项目主页使用细线表格。
- 主页通过 `launch_app`（ShellExecuteW）打开；失败在按钮下方显示 `role="alert"`。
- 该页不承担设置写入，不显示自动保存状态。

## 数据文件与恢复

- 生效文件：`<base>/settings/settings.toml`
- 出厂只读：`<base>/settings/default.toml`
- 保存前快照：`<base>/settings/backup.toml`
- dev / debug 运行的 `<base>` 为 `src-tauri/target/debug/`，release 为
  `src-tauri/target/release/`；安装布局下位于 `%LOCALAPPDATA%\Lume\`。
- 旧配置缺少 `appearance.settings_skin` 时读取为 `quiet`；未知值同样回落
  `quiet`。导入、恢复默认和恢复备份都经过同一 Rust 规范化路径。
- 外部 TOML 替换、`backup.toml` 恢复和默认值恢复都通过 Rust 命令完成；前端不直接
  读写设置文件或 SQLite。

## 验证

- 前端：`pnpm exec tsc --noEmit`、`pnpm run build`。
- Rust：`cargo check`、`cargo test`。
- CDP：`node scripts/cdp_settings_smoke.mjs` 与
  `node scripts/cdp_settings_skin_verify.mjs`。后者覆盖双皮肤六种明暗组合、
  首帧属性、焦点/滚动保持、目录搜索与插件动态设置、保存失败回滚、确认对话框、
  以及九页在 `1040×720` 与 `560×420` 下的横向溢出检查。
- 手工：按 [TESTING.md](TESTING.md) 的设置窗清单复核真实窗口、200% 缩放、
  快捷键录制、UAC、服务/代理注册与备份恢复。