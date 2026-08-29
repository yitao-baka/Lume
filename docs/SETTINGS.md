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
- **导航栏**（160px）：7 个分区，图标取 `res/icons/`（platte / navigate /
  clipboard / keyboard / search / system / about.svg）。
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
- 组「导入导出」：导出（save 对话框，默认 settings.toml）、导入（open
  对话框 + 重载工作副本）、**恢复备份设置**（双击确认——main 版保留项，
  Flutter 版已删）。`backup.toml` 由每次保存自动写。

### 7. 关于（`about`）

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
