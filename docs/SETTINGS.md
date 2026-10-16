# 设置功能规范（Settings）

本文是设置窗口的功能与字段规范。设置窗口是独立于启动器的 SolidJS WebView2
窗口，无边框、页面自绘标题栏；布局、分区与控件、各字段语义及保存/恢复行为以
本文为准。通用文件规范见 `docs/ARCHITECTURE.md`。

## 概览

- **独立设置窗口**（launcher 之外的 `settings` webview，无边框自绘标题栏），
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
│  自动化      │  ┌─────────────────────────────────┐    │
│  插件        │  │ …                                │    │
│  关于        │  └─────────────────────────────────┘    │
├──────────────┴─────────────────────────────────────────┤
│                       [恢复默认设置] [保存并应用]        │  ← 底栏
└────────────────────────────────────────────────────────┘
```

- **顶栏**：`Lume` 标题 + 「搜索设置」输入框。
- **导航栏**（160px）：9 个分区，图标取 `res/icons/`，顺序为外观 / 导航页 /
  剪贴板 / 快捷键 / 搜索 / 系统 / 自动化 / 插件 / 关于。
- **内容列**：居中、max-width 720；每分区由若干「分组标题 + 卡片」组成，
  卡片 = `--surface-raised` 底、12px 圆角、细边框；行 = 标签左 + 控件右。
- **底栏**：「恢复默认设置」（次要）+「保存并应用」（主要，`!dirty` 禁用）。

### 设置搜索框

每个分区持有一份 i18n 键清单（`Settings.tsx` 的 `SECTION_SEARCH_KEYS`），
查询对分区标题 + 清单的本地化文本做大小写不敏感子串匹配；不匹配的分区从
导航栏隐藏，内容区**堆叠显示全部匹配分区**；清空查询恢复单分区视图；点击
导航项即清空查询回到该分区。

## 保存 / 恢复语义

- **「保存并应用」**：备份（当前 `settings.toml` → `backup.toml`，覆盖式）→
  写入 → 立即生效（dedup 唯一索引重建 / 窗口宽度 / 呼出热键重注册 / 索引
  刷新 + `settings-applied` 事件）→ **关闭设置窗口**；失败留在设置页
  （保持脏状态）供重试。
- **「恢复默认设置」= 两步语义**：仅把内存工作副本重置为
  `DEFAULT_SETTINGS`（`src/settings/types.ts`，镜像 Rust `Default`；新增字段需
  手动同步，无编译期交叉校验）并标脏 + toast；**不写盘**，需再点
  「保存并应用」才落盘。无确认对话框（两步天然防误触）。`restore_default`
  命令保留但设置页不再调用。
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
| 窗口位置 | `appearance.window_position` + `remember_position` | 居中 / 跟随鼠标 / 左上 / 右上 / 左下 / 右下 / **自定义**（=首次出现也不自动定位） |

组「导航栏」：显示最近使用 `show_recent`、显示 Explorer 栏
`show_explorer_bar`、默认展开已固定 `expand_pinned`、模式切换栏仅图标
`mode_switch_icons_only`（默认关；开启后搜索行的模式胶囊只显示图标，
悬停 tooltip 给名，无图标模式回退 `res/icons/unknow_universal.svg`）、
Shift+Enter 管理员 `shift_enter_admin`（均为 toggle）；最近使用条数 `recent_count`
（10/20/30/50）；应用 / 剪贴板占位符 `search_placeholder_apps` /
`search_placeholder_clipboard`（220px 输入框）；记住上次所在页面
`remember_last_page`（+ hint）。**语义**（`docs/ROADMAP_HISTORY.md` #40）：
会话内续存（hide/show、模式切换、分离回流）始终开启、与该开关无关；开关只控
「重启后恢复上次模式 + 分类」，查询与页面快照从不落盘。

各模式使用独立搜索词 `per_mode_query`（默认关 + hint，
`docs/ROADMAP_HISTORY.md` #48）：**关 = 所有模式共享同一份搜索框内容**
——以最新输入为准，模式切换/切换键把该值交给目标页并按其执行搜索，插件
`app.setQuery` / 输入框占用回填写的也是这份值；打开首页条目后的下次呼出与
闲置重置清空它，分离窗口关闭回流时窗口最后的查询并入。**开 = 每个模式分别
记住自己的查询**。两种模式都只在会话内存里，查询从不落盘。注意：经关键字 /
feature 行**进入**某模式属于「使用条目」，会消耗共享值（入口触发词不是目标
页的过滤条件）；共享模式下插件页的 `keep_session` 闲置豁免只保页面状态，
不保独立搜索词。

闲置重置 `idle_reset_enabled` + 阈值 `idle_reset_minutes`（5 / 15 / 30 / 60 /
120 / 240 分钟；默认**开 + 30 分钟**，`docs/ROADMAP_HISTORY.md` #46）：启动器
**隐藏**超过阈值后，下一次呼出从干净状态开始——回导航页、清空搜索；所有
**未豁免**的插件页被完整重置（查询、页面分类/状态、保活宿主与会话帧一并
清掉，下次进入是冷启动）。
豁免有两层：清单 `keep_session = true` 提供默认值，设置 → 插件 每个 mode
卡片上的开关可按插件覆盖（**用户值优先**）。豁免只保「页面状态」，不保
「落地页」——超阈值时一律先回导航页。分离窗口是单一权威，不参与重置；
睡眠/休眠照常计时（挂钟间隔），仅会话内生效、不落盘。

组「条目框」：条目框大小 `entry_size`（70 / 110 / 150）。

**窗口位置语义**（`docs/ROADMAP_HISTORY.md` #41）：预设/自定义只决定**本次
运行窗口首次出现**的位置；此后每次呼出都继承上次关闭时的位置，内容高度变化
只维持原锚点（用户手动拖过窗口后锚点也不再套用）——每次呼出/保存都不重置。
「跟随鼠标」是唯一例外：每次呼出都定位到光标。显式改「窗口位置」保存时立即
生效并重新接管；保存无关设置不会把手动摆放的窗口拉回。位置不落盘：重启后按
设置重新首次定位。

> **档位兼容**：旧配置中不在当前档位列表里的值仍生效，只是对应 chip 不再高亮。

### 3. 剪贴板（`clipboard`）

卡片「历史记录条数上限」（组标题复用首行标签）：上限
`history_cap`（100/200/500/1000）、记录图片 `record_images`、记录文件
`record_files`、合并复制 `merge_copy` + 条件显示的**合并窗口滑块**
`merge_window_ms`（500–5000ms，步进 100，显示秒）、
**忽略应用整宽列表编辑器** `ignore_apps`（damage-map 图标行 + 输入行 +
folder_plus 添加，空态「尚未添加忽略应用」）、内容去重 `dedup`（+ hint）。

组「显示」：显示来源应用 `show_source_app`、时间显示方式 `time_display`
（相对/绝对 chips）、悬停选中条目 `hover_select`、收藏的条目置顶显示
`favorites_top`。

组「粘贴」：粘贴后关闭窗口 `paste_close`。

组「预览」：开启预览 `preview`（+ hint）、**记住勾选 `remember_checks`**。

### 4. 快捷键（`navHotkeys`）

呼出主界面 `hotkeys.toggle` + 切换模式 `hotkeys.switch_mode` 两行。每行 =
预设 chips（呼出：Alt+Space / Ctrl+Space；切换：Tab）+ **紧凑录制按钮**
（显示当前组合；点击开始录制，标签变「按下新的组合键…」，Esc 取消）。
录制经 `validate_hotkey` **实时校验**（缺修饰键 / 与另一 Lume 槽冲突 /
被系统占用 / 无效），失败留在录制态并显示错误行。

`hotkeys.toggle` 是启动时唯一注册的组合（单次注册）：被别的程序占用时只在
日志报错并保持无呼出键，**不会自动换用别的组合**；托盘 → 设置始终可达，
改成空闲组合即可。

> 预设 chips 的存在原因：WebView2 捕获不到 Alt+Space（被系统菜单占用），
> 预设是回到默认呼出键的唯一入口。

### 5. 搜索（`navSearch`）

组「索引目录」（标题行含**刷新索引**图标按钮 + 2s toast）：

- **系统索引**：每目录一行 toggle（本地化标签：桌面 / System32 / 开始菜单，
  默认 Desktop、System32 开，StartMenu 关）→ `index.system_dirs`。
- **用户索引**：**键值编辑器**（样式仿 Windows 环境变量对话框）
  → `index.user_index: [{name, path, no_files}]`。行 = folder_open 图标 +
  **名称（粗体）→ 路径** + **「索引文件」toggle（`no_files`）** + 删除；
  添加行 = 名称输入（留空自动取 basename）+ 路径
  输入 + folder_plus 按钮，任一输入框 Enter 提交；空态「尚未添加索引项」。

组「索引缓存」：刷新间隔滑块 `index.cache_refresh_interval_minutes`
（5–1440 分钟，步进 5）。

> **schema**：`index.user_index: [{name, path, no_files}]`；旧的 `user_dirs` /
> `user_dirs_no_files` 路径列表在 `read_settings` 时由 `Index::migrate()`
> 一次性转换为键值结构（name = basename），旧 settings.toml 读取时自动升级，
> 写回只保留 `user_index`；`cache.rs::live_dirs` 与 `dirwatch.rs` 读 `user_index`。

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
  对话框 + 重载工作副本）、**恢复备份设置**（双击确认）。`backup.toml`
  由每次保存自动写。

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

**工具栏**：概要行（「共 N 个插件 · M 个已启用」）+ 分段筛选
（全部 / 已启用 / 已停用 / 磁盘插件）+ 关键词筛选输入框（按名称 / id /
描述 / 关键词子串匹配）；无匹配时显示空态「没有匹配的插件」。最右是
**全局开发者选项**（即时生效轻量写，权限层的唯一入口）：

- **「开发者模式」**（`plugins.dev_mode`，默认关）：关闭时**隐藏全部
  开发者选项**（卡片上的重载按钮、「开发」徽章与下面的全部授权开关），
  且后端 `get_plugins` 把所有插件上报为 `trusted=false`——trusted 列表
  与全部授权都授予不了任何能力（权限层 fail-closed 到声明能力）；开启时
  显示并生效，随后重读插件清单。
- **「全部授权」**（`plugins.trust_all`，橙色警示文案，**仅在开发者模式
  开启时显示**）：对所有磁盘插件跳过能力检查。生效条件 = dev_mode 开 ∧
  trust_all 开（`list_plugins`
  的 `trust_all` 参数把全部磁盘插件上报为 trusted）；设置页不再提供
  逐插件的 trusted 切换（旧 `trusted` 列表仍被尊重，但 UI 不再写入）。

**插件卡片**（每个插件一张）：

- 左侧 40px 图标块：manifest `icon` 经 asset 协议解析（与启动器 pill
  同规则）；无图标时按类型着色的首字母块（模式 = 蓝 / 服务 = 紫 /
  搜索提供 = 绿）。
- 名称（粗体）+ 版本 + 徽章（「内置」accent 蓝 /「磁盘」中性 /
  「开发」橙；mode 清单声明 `detachable` / `hidden` 时另有「可分离」/
  「仅搜索进入」徽章）；第二行描述（内置插件用本地化文案
  `pluginDescClipboard` / `pluginDescPreview`，磁盘插件用 manifest
  `description`）；第三行类型 + 关键词预览。
- 右侧：重载按钮（仅磁盘插件，`reload_plugin`）+ 启停 toggle +
  展开箭头。点击卡片头展开详情；已停用的卡片整卡降透明度并去饱和。

**详情面板**（单开，展开一卡收起其它）：

- 关键词 chips、进入规则（`[[features]]`：label + 类型小标 文本/文件/图片）。
- **权限**（仅磁盘插件）：manifest `permissions` 逐词映射为本地化
  能力 chips（剪贴板/网络/通知/对话框/屏幕信息/全盘搜索/读取文件/
  写入文件/回收站，悬停显示一句话说明）+ 强制说明文案。逐插件的
  「全部授权」开关并入工具栏的全局开发者选项（见上）。
- **声明式设置**（`[[settings]]`）：toggle / select chips /
  文本输入；值 ≠ 默认时在该行下方显示「默认 {value}」提示；写入经
  `plugin_settings_put`，插件经 `plugin-settings` 事件收到变更。
- **信息**：ID 与磁盘位置（等宽字体，可选中复制）。

启停 / 全部授权 / 重载均给出本地化的 2.4s 状态反馈（成功 / 失败）。
启停语义：写 `settings.plugins.disabled`，`settings-applied` 后
启动器重读注册表；关闭活动模式插件自动回导航页。格式与开发见
`docs/PLUGINS.md`。

**轻量写字段（不走「保存并应用」脏状态）**：

| 键 | 含义 |
|---|---|
| `plugins.window_bounds.<id>` | 独立窗口记住的几何（关闭时写） |
| `plugins.color_modes.<id>` | 本插件自己的颜色模式（`lume.theme.set`，`docs/ROADMAP_HISTORY.md` #36）：`system` \| `light` \| `dark`，缺省 = `system`（跟随启动器）。插件调 `theme.set` 时写；重启、独立窗口建窗（窗口底色 + 任务栏图标变体）与主题翻转时都读它 |
| `plugins.keep_session_overrides.<id>` | 闲置重置豁免的用户覆盖（`docs/ROADMAP_HISTORY.md` #46）：`true` 保留该插件会话状态，`false` 强制重置；缺省 = 跟随清单 `keep_session`。「设置 → 插件」每个 mode 卡片写入 |

- 几何与颜色两项由宿主静默写入：只写 `settings.toml`、**不发 `settings-applied`**
  ——改的是插件自己的表面，不需要让整个前端刷新一遍（由发起方或下一次
  窗口事件自行收敛）。
- `keep_session_overrides` 由设置页开关经 `set_plugin_keep_session` 轻量写并
  广播 `settings-applied`，启动器重读豁免表。

### 9. 关于（`about`）

行式布局：描述（`aboutTagline`）、版本（`APP_VERSION_LABEL`，无 v 前缀）、
许可证 Apache License 2.0、贡献者 IndexEeve&yitao-baka、主页
`https://github.com/yitao-baka/Lume`（点击经 `launch_app` ShellExecuteW 打开）。
