# 用户可见文案语义审查报告（2026-10-22）

本文对 Lume 全部用户可见文案做了一次语义走查，重点是设置窗（`src/settings/**`
九个分区）。本文只记录现象、证据、影响与建议，不描述进度。

## 审查范围与方法

- **文案源**：`languages/en.json`、`languages/zh-CN.json`、`languages/zh-TW.json`。
  三份文件各 567 个叶子键，键集合完全一致（无缺键、无多余键）。
- **界面**：设置窗九页（外观 / 启动器 / 剪贴板 / 搜索 / 快捷键 / 自动化 / 插件 /
  系统 / 关于）、设置搜索目录（`src/settings/catalog.ts`）、设置窗外壳
  （`Settings.tsx` 的标题栏搜索、状态栏、确认框、分层帮助），以及启动器
  （搜索行、上下文菜单、toast、栏目、预览窗、独立插件窗）。
- **后端用户可见文字**：`src-tauri/src/tray.rs`（托盘菜单）、`hotkey.rs`
  （热键冲突通知）、`svc.rs`（services.msc 里的服务描述）、`agent.rs`
  （计划任务里的任务描述）、`plugins.rs`（内置插件名）。
- **方法**：静态走查。三语逐键对照；键的定义与引用扫描；文案与实现比对
  （Rust 命令、SQL 剪枝规则、键盘路由、窗口放置、插件注册路径）。
- **不在本文范围**：视觉、布局、动效（见 [UI_VISUAL_AUDIT_2026-10-17.md](UI_VISUAL_AUDIT_2026-10-17.md)、
  [SETTINGS_AUDIT_2026-10-20.md](SETTINGS_AUDIT_2026-10-20.md)）与交互缺陷。本文未启动 exe 验证，所有结论
  均可按文中文件与行号复核。
- **严重程度**：中等 = 会让用户形成错误预期，或跨语言明显不一致；轻微 = 措辞与
  实现有出入、同一概念多个名字；建议 = 冗余、覆盖不全、死键清理。

## 结论摘要

| # | 类别 | 现象 | 严重程度 |
| --- | --- | --- | --- |
| 1 | 本地化 | 内置插件名硬编码简体中文：EN / zh-TW 用户在设置页看到中文名，且与启动器模式栏的本地化名称不同 | 中等 |
| 2 | 语义错误 | 「最近使用条数」摘要称固定条目不受上限约束，实现里没有这种豁免 | 中等 |
| 3 | 术语 | 剪贴板「收藏」态在 收藏 / 固定 / 钉选 / Favorite / pinned 之间摇摆 | 中等 |
| 4 | 语义错误 | 勾选「保留…」清空后仍提示「剪贴板历史已清空」 | 轻微 |
| 5 | 语义错误 | 「默认展开已固定」摘要写「记住上次状态」，实现是每次呼出按配置重置 | 轻微 |
| 6 | 语义错误 | 「呼出主界面」摘要写「启动时注册」，实现是保存时立即重新注册 | 轻微 |
| 7 | 歧义 | 「切换模式」摘要的「任意位置」未限定在启动器窗口内 | 轻微 |
| 8 | 本地化 | 插件视图加载失败页与预览窗错误区外露英文 / 原始后端错误 | 轻微 |
| 9 | 本地化 | 托盘、热键通知、服务与任务描述在语言文件之外；zh-TW 会收到简体与大陆措辞 | 轻微 |
| 10 | 三语 | `autoNotice` 等若干条在三语间语义强弱或信息量不一致 | 轻微 |
| 11 | 三语 | zh-TW 混入简体 / 大陆用语（剪贴板、用戶、插件、當前） | 轻微 |
| 12 | 英文 | `{count}` 文案没有单复数变体，1 条时显示 "1 items" 之类 | 轻微 |
| 13 | 动作命名 | 服务 / 代理的「注册 / 安装 / 卸载 / 注销」在 EN 与中文里各说各话 | 轻微 |
| 14 | 帮助层级 | 快捷键「切换模式」行的摘要与详情几乎是同一句 | 建议 |
| 15 | 覆盖 | 外观 / 启动器页说明漏掉页内字段；恢复默认的范围说明有三份 | 建议 |
| 16 | 搜索 | 设置搜索关键词表三语覆盖不均，个别 zh-TW 词搜不到对应行 | 建议 |
| 17 | 死键 | 36 条键没有任何引用，其中「未保存草稿」一整套对应的 UI 已不存在 | 建议 |

## 详细发现

### 1. 内置插件名硬编码简体中文，且与启动器模式栏名称不一致

**现象**：设置窗「插件」页的卡片标题、详情标题、启用开关的无障碍名称、
启用/重载/卸载 toast，用的都是后端返回的插件名。两个内置插件的名字写死在
Rust 里，且是简体中文；EN 与 zh-TW 用户会原样看到它们。

**证据**：

- `src-tauri/src/plugins.rs:395-398`：`BUILTIN_PLUGINS = &[("clipboard", "剪贴板历史",
  "mode"), ("preview", "卫星预览", "service")]`，这些名字经 `PluginInfo.name`
  （`plugins.rs:592`）下发。
- `src/settings/PluginsPane.tsx:684`（`{p().name || p().id}`）、`:738`
  （`pluginToggleLabel`）、`:645`（图标回退取首字）等处直接渲染该名字；
  `:95-98` 的 `BUILTIN_DESC` 只补了描述，没有补名字。
- 同一插件在启动器模式栏走另一条路径：`src/plugins/clipboard/index.tsx:107`
  与 `src/plugins/navigate/index.tsx:308` 声明 `labelKey`，由
  `src/App.tsx:716` 渲染 `t(labelKey)`，因此是「剪贴板 / Clipboard / 剪貼簿」。
- 设置搜索目录同样引用该名字：`src/settings/catalog.ts`（插件条目
  `label: plugin.name || plugin.id`）。

**影响**：同一个插件在启动器里叫「剪贴板」、在设置里叫「剪贴板历史」；英文与
繁体中文用户看到简体中文名；`languages/*.json` 的运行时覆盖也无法修改它。

**建议**：给内置插件名加 i18n 键（如 `pluginNameClipboard` / `pluginNamePreview`），
前端按 id 取 `t()`，Rust 的名字只作为兜底。

### 2. 「最近使用条数」摘要承诺了不存在的固定豁免

**现象**：设置 → 启动器 → 会话与搜索的「最近使用条数」行摘要写着
「范围 5–200；固定条目不计入上限。」/ "Between 5 and 200 items; pinned entries
stay exempt."，暗示固定过的应用会额外保留在「最近使用」栏里。

**证据**：

- 文案：`languages/en.json` / `zh-CN.json` / `zh-TW.json` 的
  `settingsRecentCountHint`；渲染于 `src/settings/LauncherPane.tsx`（`appearance.recent_count` 行）。
- 实现：`src-tauri/src/recent.rs` 的 `record_recent` 只按时间倒序保留最新
  `max` 条（`DELETE FROM recent_apps WHERE id NOT IN (... LIMIT ?1)`），
  `get_recent_apps` 再 `truncate(max)`；固定应用存在另一张表
  `pinned_apps`（`src-tauri/src/pins.rs:26`），两者互不影响。
- 对照：剪贴板侧的 `settingsHistoryCapHint`（「固定记录不计入此上限」）与
  `src-tauri/src/clipboard.rs` 的剪枝（`WHERE pinned = 0 ...`，保留全部固定行）
  行为一致；「最近使用」这条像是从剪贴板那条抄过来的。

**影响**：用户会以为固定过的应用不会被挤出最近栏；实际固定应用照样按时间被剪掉
（固定只体现在「已固定」栏）。

**建议**：改成陈述真实语义，例如「控制『最近使用』栏保留的条数（固定应用另行
显示在『已固定』栏）」。

### 3. 剪贴板「收藏」态有四五种叫法

**现象**：同一个 `clipboard.pinned` 状态，在不同界面被叫作 收藏 / 固定 / 钉选 /
Favorite / pinned。

**证据**：

- 右键菜单：`src/launcher/menu.ts:58`、`:107` 用 `t("pin")` / `t("unpin")`，
  EN 为 Favorite / Unfavorite，zh-CN 为 收藏 / 取消收藏，zh-TW 为 收藏 / 取消收藏。
- 剪贴板分类页签 `clipCategoryFavorites`（收藏 / Favorites）。
- 设置 → 剪贴板 → 显示：`clipFavoritesTop`「收藏的条目置顶显示」/ "Show favorited
  entries on top"。
- 设置 → 剪贴板 → 历史：`settingsHistoryCapHint`「固定记录不计入此上限」/ "Pinned
  entries do not count toward this limit"（zh-TW「固定記錄…」）。
- 清空确认框：「保留固定记录」`keepPinned`（zh-TW 用「保留釘選記錄」）。
- [ROADMAP_HISTORY.md](ROADMAP_HISTORY.md):770 记录过一次刻意的改名：右键菜单「固定 / 取消固定」
  改成了「收藏 / 取消收藏」，只保留「已固定」栏标题。「保留固定记录」与
  「固定记录不计入此上限」是那次改名没有跟上的遗留（README 也沿用「保留固定记录」）。

**影响**：清空确认框里的「保留固定记录」与菜单里的「收藏」被读成两个功能；
zh-TW 在「收藏 / 釘選 / 固定」三种说法之间跳。

**建议**：为 `clipboard.pinned` 选定一个词并全量替换（跟随既有决定用「收藏 /
Favorite」最省改动，或在全应用统一为「钉选 / Pin」）。应用「已固定」栏是另一个
状态，需要与剪贴板用词显式区分。

### 4. 勾选「保留…」清空后仍提示「剪贴板历史已清空」

**现象**：清空对话框可以勾选保留收藏（固定）记录；勾选后确认，toast 仍显示
「剪贴板历史已清空」/ "Clipboard history cleared"。

**证据**：`src/plugins/clipboard/store.ts:300-309`（`doClear` 不分 `keepPinned`
一律 toast `clipCleared`）；`src-tauri/src/clipboard.rs:804-807`（`keep_pinned`
时只删 `pinned = 0`）。

**影响**：用户按提示以为历史已被完全清空，下拉仍能看到收藏项。

**建议**：保留路径给一句独立文案（如「已清空，收藏项已保留」）。

### 5. 「默认展开已固定」的摘要说「记住上次状态」，实际是每次呼出重置

**现象**：摘要写「启动器重新打开时保留已固定栏的展开状态。」/ "Remembers whether
the pinned bar starts expanded."，读起来像是记住用户上次手动展开/收起的结果。

**证据**：`src/plugins/navigate/index.tsx:184-191` 的 `reset()` 在每次呼出时
`nav.setPinnedExpanded(expandPinned())`，即每次都用设置值重设，用户上一轮的手动
展开状态不留存（旁边的 `setRecentExpanded(false)` 注释也写明「不跨呼出保留」）。

**影响**：用户以为手动收起一次就能被记住；实际下次呼出又按设置值展开。

**建议**：改成「每次呼出时，已固定栏默认处于展开 / 收起状态」。

### 6. 「呼出主界面」的摘要说「启动时注册」，实际是保存即刻生效

**现象**：摘要写「Lume 启动时注册的唯一全局呼出键。」/ "The single global shortcut
Lume registers at startup."，容易被读成「改完要重启才生效」。

**证据**：`src-tauri/src/settings.rs:900-903` 在保存设置且 `hotkeys.toggle` 变化时
立即 `crate::hotkey::apply()` 重新注册；`src-tauri/src/hotkey.rs:166-181` 的
`apply` 会先注销旧键再注册新键。

**影响**：用户可能重启程序来「应用」新热键，多此一举；也可能以为新键没生效而重复录制。

**建议**：改为「Lume 唯一的全局呼出键（保存后立即生效）」。

### 7. 「切换模式」摘要的「任意位置」没有限定范围

**现象**：摘要写「单键仅在搜索框聚焦时生效；Ctrl+Tab 可在任意焦点下切换模式。」
/ "A single key works while the search box is focused; Ctrl+Tab works anywhere."

**证据**：`src/launcher/keyboard.ts:150-176` 的判定是启动器窗口内的 DOM 键盘路由
（`searchFocused` 时接受裸键，带修饰键的组合与 Ctrl+Tab 别名不受焦点限制）；
`src-tauri/src/hotkey.rs:133-135` 说明模式切换键刻意不进系统级 `RegisterHotKey`
命名空间，因此它只在启动器窗口内可用。紧邻的上一行（`hotkeys.toggle`）才是唯一的
系统级全局热键。

**影响**：用户可能以为「切换模式」也是全局键，在别的程序里按键无反应。

**建议**：改为「在启动器窗口内，仅搜索框聚焦时可用单键；Ctrl+Tab 在任何焦点
都可用」。

### 8. 加载失败页与预览窗错误区外露英文与原始错误

**现象**：三类错误界面没有走 `t()`：

- 启动器内联的插件视图加载失败页：
  `src/plugins/registry.ts:677-681` 生成
  `plugin view load failed: ${String(err)}`；
- 独立插件窗的同名失败页：`src/pluginWindow.tsx:351-356`；
- 预览窗的文本 / 图片 / PDF 错误区：`src/preview.tsx:175`、`:199`、`:207`
  存 `String(e)`，`src/preview.tsx:279`、`:357` 直接渲染（例：后端
  `ShellExecuteW failed with code 5`、pdf.js 异常串）。

**影响**：英文界面之外的用户看到英文句子与原始错误码；与「所有 UI 字符串走 `t()`」
的约定不一致。

**建议**：给这三处各加一条本地化兜底文案，原始错误只写日志（或放进详情展开区）。

### 9. Rust 侧用户可见文案在语言文件之外

**现象**：有几处用户可见文案不在 `languages/*.json` 里——有的是自带语言分支，
有的是固定英文：

- 托盘菜单：`src-tauri/src/tray.rs:99-120` 手写
  `("设置","重启","关闭")` / `("設定","重新啟動","關閉")` / `("Settings","Restart","Exit")`；
- 热键注册冲突通知：`src-tauri/src/hotkey.rs:31-46`，只分 zh / 非 zh——zh-TW 用户
  会收到简体的「呼出快捷键 … 被其他程序占用。请从托盘打开设置 → 快捷键…」，
  其中「托盘」也是大陆用语（zh-TW 界面用「系統匣」）；
- 服务描述：`src-tauri/src/svc.rs:403` 仅英文，显示在 services.msc；
- 计划任务描述：`src-tauri/src/agent.rs:274` 仅英文，显示在任务计划程序；
- 窗口标题：`src-tauri/src/lib.rs:134`、`:176`、`:218` 固定为 "Lume" / "Lume
  Preview"（设置窗、预览窗在任务栏与 Alt+Tab 列表里的名字），独立插件窗的标题
  取自清单名（`src-tauri/src/plugin_window.rs:163`，内置插件即第 1 条的简体中文名）；
- `index.html` 的 `<noscript>` 提示 "You need to enable JavaScript to run this app."
  只有英文一种写法。

**影响**：这些文案无法被 `languages/*.json` 的用户覆盖机制修改；语言行为与设置窗
不一致（设置窗按 `appearance.language`，通知按系统语言，且只分两类）。

**建议**：把这几条并入语言文件（或在 Rust 侧建同源映射表），托盘与通知统一按
`appearance.language` 取值。

### 10. 三语语义不对齐（同一键在不同语言里说法不同）

| 键 | EN | zh-CN / zh-TW | 问题 |
| --- | --- | --- | --- |
| `autoNotice` | "background / minimized launches aren't covered." | 「后台启动或最小化启动不保证」 | 中文弱化成「不保证」，实测语义是「不覆盖」 |
| `autoForceFocus` | "Take focus back after the delay" | 「强制聚焦」 | 中文标签没有「延迟之后」这一关键条件，读起来像另一个功能 |
| `settingsClipPreview` | "Preview"（名词） | 「开启预览」 | 中文是动词短语，英文标签在「预览」分组内含义含混 |
| `settingsModeIconsHint` | 只写窄窗自动转图标 | 追加「悬停显示名称」 | 同一行提示中英信息量不同 |
| `pluginsFilterDisk` | "Third-party" | 「磁盘插件」/「磁碟外掛」 | 英文把同一集合叫 Third-party，徽标处又叫 Disk（`pluginDisk`） |
| `pluginKindProvider` | "Provider" | 「搜索提供」/「搜尋提供」 | 中文缺中心词，读起来像半句话 |
| `pluginsInstallUnsigned` | "…verify it out of band if you care about its origin." | 「如需确认来源请另行核对。」 | 英文在安全提示里带轻佻语气，中文是中性表述 |

**建议**：以行为为准统一三语措辞；`autoNotice` 与 `autoForceFocus` 属于会误导的
一类，优先处理。

### 11. zh-TW 混入简体 / 大陆用语

**现象**（脚本扫描 `languages/zh-TW.json` 的结果）：

- 「剪貼板」2 处：`placeholderClipboard`、`clipClearConfirm`（全文件其余位置用
  「剪貼簿」）；
- 「用戶」2 处：`settingsUserIndex`、`indexEmpty`（其余位置用「使用者」）；
- `pluginApiMismatch` 使用「插件 API」「當前宿主」（其余位置用「外掛」「目前」）；
- 「快捷鍵」13 条与「快速鍵」11 条混用，同一页内会同时出现（`settingsHotkeys`
  = 快捷鍵，而 `settingsAutomationPageDesc`、`settingsRestoreDefaultsHint`、
  `hotkeyNotRegistered` 等用快速鍵）。

**影响**：繁体中文用户看到的术语不统一，像是不同批次翻译拼在一起。

**建议**：为 zh-TW 固定一份词表（剪貼簿 / 使用者 / 外掛 / 目前 / 快捷鍵），
一次性替换。

### 12. 英文 `{count}` 文案没有单复数变体

**现象**：所有计数文案都只有一个形式，且调用方传入的是字符串（i18next 的
`_one` / `_other` 复数查找只在 `count` 为数字时触发），1 个时会显示
"1 items" / "1 files" / "1 windows" / "1 plugins · 1 enabled"。

**证据**：`languages/*.json` 无 `_one` / `_other` 键；调用处如
`src/plugins/clipboard/ClipboardView.tsx:400-402`、
`src/launcher/clipData.ts:40`、`:44`、`src/settings/ProgramPicker.tsx:208`、
`src/settings/PluginsPane.tsx:428-431`、`:574-577`。
涉及键：`clipTotal`、`clipSelected`、`fileCount`、`clipMergedCount`、
`autoPickWindows`、`pluginsSummary`、`pluginsInstallStats`、`pluginFeatureFiles`
（后者用 "file(s)" 硬凑）。

**建议**：改用数值 `count` + `_one` / `_other`，或改写为不含名词复数的句式
（如 "Items: 1"）。

### 13. 服务 / 代理的动作命名在 EN 与中文里各说各话

**现象**：

- EN 按钮 `settingsRegisterService` = "Register service"，但状态与结果文案是
  "Service installed and running"（`settingsServiceInstalled`）、"Service
  registration failed" / "Service removal failed"，安装态与注册态混用；
- zh-CN 同组文案在 注册 / 安装 / 卸载 之间切换（`settingsRegisterService` 注册服务、
  `settingsServiceInstalling` 正在注册、`settingsServiceUninstalled` 服务已卸载）；
- 代理侧 EN 用 Register / Unregister（一致），但 zh-CN 在 注册 / 卸载 / 注销 之间切换
  （`settingsAgentInstall` 注册代理、`settingsAgentUninstall` 卸载代理、
  `settingsConfirmUninstallAgentTitle` 注销提权代理、`settingsAgentUninstalled` 代理已卸载），
  zh-TW 又在 註冊 / 解除 / 註銷 之间切换（`settingsAgentUninstall` 解除代理、
  `settingsConfirmUninstallAgentTitle` 註銷提權代理、`settingsAgentUninstalled` 代理已解除）。

**证据**：`languages/*.json` 的 `settings*Service*` / `settings*Agent*` 键；
渲染处 `src/settings/SystemPane.tsx:163-214`（服务状态与动作）、`:230-289`
（代理动作与确认框）。

**影响**：用户在「注册」和「安装」之间对不上自己在做什么（Windows 服务机制里这两步
实际是同一个操作）。

**建议**：为服务和代理各选一组动词并统一三语（服务建议跟 Windows 用「安装 / 卸载」，
代理建议跟计划任务用「注册 / 注销」），确认框标题、按钮、状态与结果都跟随。

### 14. 快捷键「切换模式」行的摘要与详情重复

**现象**：该行的摘要 `settingsSwitchHotkeyHint`（EN "A single key works while the
search box is focused; Ctrl+Tab works anywhere."，CN「单键只在搜索框聚焦时切换；
Ctrl+Tab 可在任意位置切换。」）与详情 `hotkeyModeHint`（EN "…Ctrl+Tab switches
modes from anywhere."，CN「单键仅在搜索框聚焦时生效；Ctrl+Tab 可在任意焦点下
切换模式。」）是同一句话的两种写法，帮助气泡/模态没有补充生效条件、冲突规则
或例外。

**证据**：`src/settings/HotkeysPane.tsx:203-207`（`summary` 与 `details` 同时
指向这两个键）。

**建议**：摘要保留一句话结论，详情补真实增量（例如「带修饰键的组合在窗口任何
焦点都生效；该键不注册为系统全局热键」）。

### 15. 页面说明与范围文案的覆盖问题

**现象**：

- 外观页说明 `settingsAppearancePageDesc` 只提语言、明暗主题与皮肤，漏掉同页的
  设置窗主题色（`settingsAccent`）；启动器页说明 `settingsLauncherPageDesc`
  漏掉同页的搜索框占位符与条目框外观。
- 「恢复应用默认值」的范围说明存在三份几乎同义的键：
  `settingsRestoreDefaultsHint`（设置搜索结果里该行的摘要）、
  `settingsRestoreDefaultsHintLong`（用在确认框）、
  `settingsRestoreAppDefaultsHint`（36 条死键之一，且把 launcher 页写成
  "navigation" / 「导航页」，与实际分区名「启动器」不一致）。

**证据**：`src/settings/AppearancePane.tsx`、`src/settings/LauncherPane.tsx` 的组
标题；`src/settings/catalog.ts` 与 `src/settings/Settings.tsx:583-585` 的用法；
三条键的取值在 `languages/en.json` 中并列存在。

**建议**：页说明补齐页内字段；范围说明收敛成一条（确认框可在其上加「不可从设置窗
撤销」之类的前提），并删除 stale 的那份。

### 16. 设置搜索关键词表的三语覆盖不均

**现象**：`catalog.ts` 的 `keywords` 数组写明「English keys and synonyms so
technical values remain searchable in every locale」，但实际覆盖不一致：有的条目
简繁都给（`语言`+`語言`、`宽度`+`寬度`、`管理员`+`管理員`），有的只给简体
（`鼠标`、`剪贴板`、`图标`、`默认`、`历史`、`插件`），还有的混搭
（`appearance.settings_skin` 是 `皮肤` + `主題` + `风格`）。

**证据**（`src/settings/catalog.ts` 的数组原文）：

- `appearance.window_position`：`["position","center","corner","mouse","manual","位置","鼠标"]`
  ——zh-TW 的「視窗位置」行摘要与详情都不含「滑鼠」，所以 zh-TW 用户搜「滑鼠」
  命中不到该行，而 zh-CN 用户搜「鼠标」可以。
- `appearance.search_placeholder_clipboard`：`[...,"占位符","剪贴板"]`（缺「剪貼簿」）。
- `appearance.mode_switch_icons_only`：`[...,"模式","图标"]`（缺「圖示」）。
- 插件条目：`[..., "plugin", "插件"]`（缺「外掛」）；虽然插件行的路径含
  「外掛程式」，多数查询能兜底，但关键词本身仍不完整。
- `appearance.settings_skin`：`["skin","theme","style","quiet","chromatic","皮肤","主題","风格"]`
  ——同一数组里简繁各取一部分。

**影响**：同一概念在不同界面语言下的可搜索性不同；这是用户直接感知的语义落差。

**建议**：关键词表按「英文 + 简体 + 繁体」三列补齐，或在构建时对简体关键词自动
生成繁体变体；补一条自检脚本扫描含中文的关键词数组是否成对出现。

### 17. 死键清单（定义但无引用）

**现象**：脚本扫描 `src/**` 与 `src-tauri/src/**`，下列 36 个键没有任何引用
（既无 `t("…")`，也无目录/映射里的字面量）。其中一组描述的是当前并不存在的 UI：

- 未保存草稿对话（9 条）：`settingsUnsavedTitle`、`settingsUnsavedHint`、
  `settingsSaveAndClose`、`settingsDiscardAndClose`、`settingsContinueEditing`、
  `settingsDiscardTitle`、`settingsDiscardHint`、`settingsDiscardAndContinue`、
  加上徽标键 `settingsImmediate`（「立即生效」）。设置窗现在是自动保存 +
  页脚「未保存 · 重试」+ 撤销，代码里没有「立即生效」标记，也没有草稿保存对话
  （`src/settings/Settings.tsx` 只有通用确认框）；这批文案若日后复用，
  「标有『立即生效』的控件」这句会指向不存在的元素。
- 其余 27 条：`autoDelayHint`、`autoComboOk`、`typeToSearchWithHotkey`、
  `typeToSearch`、`shortcutHint`、`clipDeletedMany`、`imageLabel`、`interface`、
  `saveApply`、`settingsComingSoon`、`settingsWindowSize`、`settingsConfirmAction`、
  `settingsAgentUacCanceled`、`settingsServiceUacCanceled`、`indexEmpty`、
  `searchPlaceholder`、`placeholderHint`、`rememberLastPageHint`、
  `settingsSearchClear`、`settingsUserIndexPath`、`settingsRestoreAppDefaultsHint`、
  `settingsCustomHint`、`hotkeyCustomButton`、`settingsUndoDone`、
  `settingsPageMore`、`settingsConfirm`、`settingsCloseSettings`。
- 其中 `autoDelayHint` 的内容与现行实现冲突：它写「若延迟期间前台已切到别的程序，
  则不发送该快捷键」，而 `autoForceFocus` 打开时 Lume 会先把目标窗口拉回前台再发送
  （`autoForceFocusHint`）。这条如果被直接复用会与详情说明矛盾。
- `settingsAgentUacCanceled` / `settingsServiceUacCanceled` 已被
  `src/settings/errors.ts` 的通用「操作已取消」取代。

**影响**：每条死键都要在三份语言文件里同步维护；未保存草稿这批还带有与实际行为
不符的描述，属于「读代码时以为有这功能」的噪声。

**建议**：确认不再需要后从三份文件删除；确实预留给后续界面的（如
`settingsComingSoon`）单独列一张「预留键」清单，避免与死键混在一起。
