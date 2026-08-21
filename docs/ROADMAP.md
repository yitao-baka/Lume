# Roadmap

Planned features for Lume, in priority order. Items are added here before
implementation; each becomes a scoped iteration when started. See
`CHANGELOG.md` for what shipped.

## 0. ✓ Navigate 主菜单网格化

**状态：已实现（v0.2.2）**

Navigate 模式的应用条目从长条列表改为方框网格（5 列），支持四方向键盘
导航、鼠标悬停选中、点击启动；空查询显示全部应用。

## 1. ✓ i18n 国际化

**状态：已实现（v0.2.3）**

简体中文 / 繁体中文 / 英语；字符串集中在 `src/i18n.ts`，跟随系统语言。
**约定：所有新 UI 字符串必须走 `t()` 字符串表，禁止硬编码。** 设置页
覆盖语言（`setLocale`）留待设置页迭代。

## 2. ✓ 真实应用图标

**状态：已实现（v0.2.4）**

`IShellItemImageFactory` 从 `.lnk` 提取 64px 图标；网格先显示字母 tile 再
分批（20 个/批）渐进替换。**图标不落库**——后端 `IconCache` + 前端 Map 双
内存缓存，按路径进程内复用。

## 3. ✓ Navigate 固定栏

**状态：已实现（v0.2.5）**

主菜单空查询时网格上方显示独立固定栏（横条），右键菜单固定/取消选中项，
`↑`/`←`/`→`/`↓` 在栏与网格间导航；存 SQLite（`pinned_apps` 表）持久化。

## 4. ✓ 自适应窗口

**状态：已实现（v0.2.10）**

窗口高度随展示条目自适应（结果少则收缩、多则封顶 520px 内部滚动），始终
居中；宽度固定 720。测量修正：用子元素 rect + scrollTop 校正，WINDOW_PAD
计入 padding/边框，条目完整展示时不出现滚动条。**后续可扩展**：宽度随
列数自适应、最大高度可配置。

## 5. ✓ 拼音搜索（应用名）

**状态：已实现（v0.2.7）**

应用名在扫描时生成全拼 + 首字母索引，搜索时与名称评分融合（拼音权重
0.9）。"kuake" / "kk" → 夸克，"wanmei" → 完美解码。拼音字段仅搜索用，不
序列化到前端。**后续可扩展**：剪贴板内容的拼音搜索、多音字优化。

## 6. 设置界面

**状态：规划完成（2026-08-03），等待实现。优先级高于插件系统。**

独立设置窗口（齿轮按钮 + 托盘入口），左侧 4 大选项（界面 / 系统 / 插件 /
关于），右下角「保存 / 应用」。完整功能规范见 `docs/SETTINGS.md`，通用
文件规范见 `docs/NORMS.md`。

子步骤（按顺序实施）：
- **6.1 ✓ i18n 规范化（2026-08-03 完成）** — 语言文件迁移到
  `languages/*.json`（JSON + i18next），`src/i18n.ts` 重写为 i18next +
  响应式 `t()`，新增 Rust `load_language_files` 命令（exe 同级 `languages/`
  运行时覆盖，已随资源打包并 CDP 实测）
- **6.2 ✓ 设置文件体系（2026-08-03 完成）** — `exe_dir/settings/`
  （default / settings / backup.toml）三文件体系，`settings.rs` 提供
  load/save/备份/导入导出/恢复命令；`data/` 迁移 lume.db（旧 app_data 自动
  复制），`paths.rs` 统一 exe 同级路径（cargo test 29 项全过 + CDP 实测）
- **6.3 ✓ 设置窗口框架（2026-08-03 完成）** — 第二窗口 `settings`（普通
  装饰窗口 720×560）+ `open_settings`/`close_settings` 命令 + 齿轮按钮（已
  接 onClick）+ 托盘「设置」菜单项 + 前端按窗口标签分支渲染 `<Settings />`
  （左侧四选项 + 分割线 + 内容区 + 右下角保存/应用，脏状态禁用）+ settings
  capability；CDP 实测（四导航渲染、切换、保存命令生成 backup.toml）
- **6.4 ✓ 「界面」页（2026-08-03 完成）** — 语言（跟随系统+三语言，
  即时预览+事件联动主窗口）/ 条目框大小（预设+数字，CSS 变量）/ 窗口大小
  （预设+数字，Rust 应用宽度）/ 窗口位置（5 预设点 + 记住位置开关；
  `window.rs` show 重构：宽度设置 + 记住位置/初始位置，`apply_position`
  命令；`resizeToContent` 改为保留宽度+调 apply_position，不再硬编码 720/
  无条件居中）。CDP 实测：语言预览+持久化+主窗口联动、宽度 720→800、
  右上角定位、保存命令、恢复默认
  **修正（同日）**：条目框 = 包裹整个条目的方框（`.result-box`），网格列随
  框大小自适应 + 键盘导航动态列数；窗口大小 = 宽度 + 初始高度
  （`window_height` 为自适应上限，替代固定 520）；数值输入统一改滑块；
  新增「组件现代美观、必要时用外部组件库」规范（docs/NORMS.md）
  **再修正（同日）**：右侧空隙根因 = 原生滚动条保留 ~10px 横向空间
  （clientWidth<offsetWidth）→ 隐藏原生滚动条 + 自定义悬浮滚动指示条
  （`src/scrollbar.ts` 注入 `.scroll-indicator`，滚动时淡入、随进度移动），
  网格零空隙铺满；滑块改为细轨+圆角蓝拇指+`--fill` 填充效果。CDP 实测：
  gapBeyondPadding=0、指示条自动隐藏、键盘导航 7 列换行正常
- **6.5 ✓ 「系统」页（2026-08-03 完成）** — 快捷键（呼出主界面 Alt+Space/
  Ctrl+Space/自定义，切换模式 Tab/自定义；录制+实时校验：≥1 修饰键+
  系统注册检测+与另一槽位冲突，Rust `validate_hotkey` 返回机器码、
  `hotkey::apply` 重注册 toggle，主窗口 `matchesSwitchKey` 按修饰键+键
  匹配切换）、索引目录（系统索引只启停 + 用户索引输入框/添加/删除）、
  导入导出与恢复（tauri-plugin-dialog 文件对话框、恢复二次确认）。CDP
  实测：录制 Ctrl+Alt+K 通过、无修饰键报错、Ctrl+Q 切换模式（Tab 失效）、
  热键重注册 get_hotkey 更新、用户索引增删、恢复确认
  **再修正（同日）**：因系统索引已成搜索来源，移除开始菜单应用扫描
  （`apps.rs` 的 `scan_apps`/`AppIndex` 置空，保留拼音机制 `#[allow(dead_code)]`，
  移除相关测试与 prewarm）。随后实现**基础文件搜索**：`search_apps` 改为按
  设置索引目录（桌面 via SHGetKnownFolderPath / System32 via SystemRoot +
  用户目录）**不递归**列出文件，空查询浏览（封顶 200）或按名称/拼音过滤
  （上限 8），`launch_app` 用 ShellExecuteW 打开文件、图标用 IShellItemImageFactory
  提取；无启用索引时空态提示 `indexEmpty`。CDP 实测：空查询 200 条、搜
  "txt" 8 条匹配、196 个真实文件图标
  **性能缓存（同日，重设计）**：三库——`data/system32_cache.db`（首次构建，
  只含可打开可执行类型 exe/com/cmd/bat/msc，排除 DLL）、`data/user_cache.db`
  （桌面+用户目录，启动刷新一次 + 每小时差异刷新，间隔可在
  系统→索引目录→缓存刷新间隔 自定义 5~1440 分钟默认 60）、`data/icons.db`
  （图标按内容哈希去重，显示时懒提取，两缓存库 files.icon_hash 引用）。
  `.lnk` 显示名去扩展名（同资源管理器）。`cache.rs` 统一 DB 层（差异刷新、
  icons_for 批量查、store_icon 去重），`apps.rs` 内存态搜索，`icons.rs`
  get_app_icons 查库+懒提取。CDP 实测：.lnk 无扩展名、0 DLL、24 个唯一
  图标覆盖 ~95 文件、user_cache 重启持久化、差异新增生效
  **修正（同日）**：Desktop 索引同时覆盖用户桌面 + 公用桌面
  （`FOLDERID_PublicDesktop`），对齐资源管理器合并视图；CDP 实测 Chrome/
  微信/夸克（公用桌面）可搜到
  **再加（同日）**：系统索引新增「开始菜单」（默认关，递归收录 Programs
  下全部 .lnk 含子文件夹）；保存时索引配置变化立即刷新（不等每小时）；
  启动时补全已知系统目录（旧 settings 自动获得 StartMenu 项）。CDP 实测：
  7-Zip ZS File Manager / Remote Desktop Connection（子文件夹）可搜到
- **6.6 ✓ 「关于」页（2026-08-03 完成）** — 居中大图标（`res/icons/`
  software.png）+ 名称 + 版本（`getVersion`）+ 项目介绍。**至此设置迭代
  6.1–6.6 全部完成。**
  另修复：`resizeToContent` 宽度改为设置值来源（不再读回当前宽度，消除
  DPI 舍入导致的窗口逐渐变宽）
  **SVG 图标接入（同日）**：res/icons 新增大量 SVG——设置按钮
  settings.svg、模式导航/剪贴板图标、右键菜单（启动 normal_run、固定 pin、
  取消固定 pinned、删除 delete、复制回剪贴板 clipboard）、设置四大选项
  （interface/system/plugins/about）、语言按钮（english/chinese_simplified/
  chinese_traditional）。**图标提取失败回退改为 `unknow_universal.svg`**（不再
  用字母 tile，移除 tileColor/TILE_COLORS）。SVG 随包打包到 exe 同级 res/

## 7. 插件系统

**前置条件未就绪前不开始。** 等核心基础设施（i18n、图标、搜索架构、
设置页）稳定后，由用户明确指示再启动。

插件系统需要先定义：插件 API / 协议、插件发现与加载、权限模型、与搜索
引擎的集成方式。

## 8. Program Files 安装 + LumeSVC 服务 + 管理员启动 + 开机自启

**状态：已实现（2026-08-04）。**

背景：目标是把 Lume 装进 `Program Files`（普通用户只读）。分析确认剪贴板
写入（Session 0 拿不到用户剪贴板）与主程序各写路径注定留在交互进程，故
**治本 = 数据搬到 `%LOCALAPPDATA%\Lume\`**；SYSTEM 服务保留，为后续
SYSTEM 级能力（如 USN 全盘索引）铺路。

- **数据搬家（`paths.rs` 双模式）**：exe 含 "Program Files" → 数据根为
  `%LOCALAPPDATA%\Lume`（优先读 `HKLM\Software\Lume\DataDir`），便携版不变；
  首启把 exe 同级旧数据复制过去（只拷不删）。
- **LumeSVC 服务（空转骨架）**：新增 `lume-svc.exe`（`src-tauri/src/bin/`，
  不跑 UI），SYSTEM + AUTO。设置→系统→「注册服务 / 卸载服务」经
  `ShellExecuteW runas` 提权调用 `--install/--uninstall`（UAC 取消给友好提示）。
  **服务不管理数据库刷新**——主程序是唯一刷新者（启动 + 每小时 + 改配置即时
  刷新，见下）；服务只持有 SCM 生命周期 + 命名管道（`\\.\pipe\LumeSVC`，带
  DACL），数据目录经 `HKLM\Software\Lume\DataDir` 交接，为后续 SYSTEM 级
  功能（如 USN 全盘索引）做桥。
- **管理员启动**：应用条目右键菜单「以管理员身份启动」（`launch_app` 加
  `elevated` 参数，`ShellExecuteW` runas；`res/icons/administrator_run.svg`）。
- **开机自启**：设置→系统 Toggle，写 / 删 `HKCU\...\Run`（注册表为唯一事实
  源）。
- **主程序 = 唯一刷新者**：启动一次 + 每小时（间隔可配）+ 改索引配置即时
  刷新，与服务互不依赖；便携版 / 未注册服务时行为一致。

**后续可扩展**：USN / 全盘增量索引（服务是为此铺路的骨架）；在管道协议上
扩展服务职责（REFRESH_NOW 推送等）；托盘服务状态实时推送。

## 9. 环境变量同步（WM_SETTINGCHANGE 监听）

**状态：已实现（2026-08-04）。**

背景：系统环境变量修改后（设置→环境变量对话框、`setx`），Lume 自身进程的
环境块仍是启动时快照，导致之后经 `ShellExecuteW` 启动的应用 / 命令行继承到
**旧 PATH**。目标：让 Lume 随时跟上前台 / 后台的环境变量变更。

设计要点（`src-tauri/src/envwatch.rs`）：

- **纯事件驱动，零轮询**：专用线程阻塞在 `MsgWaitForMultipleObjectsEx`
  （内核等待），系统安静时完全挂起、不占 CPU；仅当 Windows 广播
  `WM_SETTINGCHANGE` 或环境注册表键被改写时才被唤醒。**刻意不做注册表轮询**
  （那是每次空转唤醒、纯浪费）。相比之下剪贴板监听是 250ms 轮询，环境监听
  比它安静几个数量级。
- **覆盖两个通道**：环境变量对话框广播 `WM_SETTINGCHANGE`
  （`lParam = "Environment"`，message-only 窗口接住）；`setx` / 直接改注册表
  **不广播**，故额外用 `RegNotifyChangeKeyValue`（同为事件驱动、同样零轮询）
  盯 `HKCU\Environment` 与 HKLM `Session Manager\Environment` 两个键。
- **合并语义**：`PATH` = 系统 PATH + 用户 PATH（Windows 拼接顺序，整体替换、
  删除项生效）；其余变量用户覆盖系统；`REG_EXPAND_SZ` 展开（`%SystemRoot%` 等）。
- **边界**：只影响**之后启动**的进程（ShellExecuteW 子进程继承刷新后的环境）；
  已运行进程保持原样（Windows 不会改写活进程）。进程里存在但注册表已无的变量
  不删除（怕误伤 Lume 自身运行环境），仅 PATH 整体替换。

**后续可扩展**：设置页开关（默认常开，成本可忽略）；向前端推送
`env-refreshed` 事件供未来「运行命令」功能展示；按需把刷新结果可视化。

## 10. 最近使用栏 + 固定栏改造 + 界面设置项

**状态：已实现（2026-08-05）。**

背景：主界面（应用模式、空查询）目前是「固定栏 + 全部应用浏览网格」。本迭代把
**空查询浏览网格移除**——主菜单变为两栏：「最近使用」（新）+「已固定」（改造），
输入搜索词时才出现结果网格。两栏都支持标题 + 展开/收起，默认收起始终展示一行。

### 10.1 数据模型「最近使用」（新）

- SQLite 新表 `recent_apps`（`pins.rs` 同款独立 WAL 连接）：
  `id INTEGER PK AUTOINCREMENT, path TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  opened_at INTEGER NOT NULL`。
- **按路径去重**：重复打开 → `ON CONFLICT(path) DO UPDATE` 前移 `opened_at`；满
  `appearance.recent_count` 条后按 `opened_at` 剔除最旧（删数据与显示同用该上限）。
- **单一埋点**：在 `launch_app`（`apps.rs`，搜索/两栏/右键/管理员启动全走它）里记录，
  应用 + 文件都记。`launch_app` 增加可选 `name` 参数（前端各调用点已有
  `AppEntry.name`，与网格显示名一致、无扩展名）。
- 新模块 `src-tauri/src/recent.rs`：命令 `get_recent_apps`（按 `opened_at` 倒序、
  封顶 `recent_count`）+ 内部 `record_recent(path, name)`；`init` 接在 `lib.rs`。
- **「显示最近使用」开关只影响显示**，关闭时仍照常记录，重新打开可见历史。

### 10.2 界面改造（主菜单 = 两栏）

- **移除空查询浏览网格**：空查询时 `.result-grid` 不渲染（输入时保留，现有搜索逻辑
  不变）；`.pinned-bar` 仍仅空查询显示，新增 `.recent-bar` 位于其上方。
- **两栏结构统一**：每栏 = 头部行（左标签「最近使用」/「已固定」，右「展开」按钮）
  + 内容区。内容区复用 `.result-grid` 的
  `repeat(auto-fill, minmax(var(--entry-size), 1fr))` → 条目尺寸、列数与主网格一致。
  - **收起态 = 1 行**（实现：JS 按测量列数切片 `slice(0, barCols)`，非 CSS 裁剪）；
    **展开态 = 全部条目换行铺满**。
  - 点「展开」切换，文字「展开」↔「收起」；**不持久化展开状态**——每次呼出主界面
    （`clearSearch` / 窗口聚焦）重置为收起。
  - **「展开」显示条件**：栏内容 ≤ 1 行时不显示；**0 条时整栏（含标题）隐藏**，两栏
    都空时空白无提示（不再显示空查询 `indexEmpty` 提示；仅输入搜索词且无结果时保留
    `noResults` 提示）。
- **键盘导航**：空查询时 zone 扩为 `recent | pinned` 两区，↑↓ 纵向循环，←→ 栏内
  移动，Enter 启动；输入搜索词后只剩结果网格（现有导航不变）。
- **右键菜单**：两栏条目复用现有应用菜单（固定/取消固定、启动、打开文件位置、以
  管理员身份启动）；从最近栏「固定」即加入已固定栏。
- **窗口自适应**：`resizeToContent` 需支持「无网格、仅两栏」的测量——现在没有
  `.result-grid/.result-list` 会提前 return；把两栏容器纳入测量，展开内容超高时受
  `window_height` 上限 + 内部滚动（现有滚动条隐藏 + 悬浮指示条机制不变）。
- **图标**：两栏条目走现有 `iconCache` / `get_app_icons`，与网格一致。

### 10.3 设置项（「界面」页，`appearance`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `show_recent` | bool | `true` | 「显示最近使用」开关 |
| `recent_count` | u32 | `20` | 「最近使用条数」上限 |
| `search_placeholder_apps` | String | `""` | 应用模式搜索框占位符（空 = 默认文案） |
| `search_placeholder_clipboard` | String | `""` | 剪贴板模式占位符（空 = 默认文案） |

- 全部 `#[serde(default)]`，旧 `settings.toml` 直接加载（`meta.version` 保持 1 仅作
  记录；`Settings::default()` 补齐新字段，`default.toml` 随之生成）。
- `InterfacePane.tsx` 新增 groups：「显示最近使用」Toggle；「最近使用条数」预设
  chips（10 / 20 / 30）；「搜索框占位符」两个文本输入（应用 / 剪贴板各一）。
- 占位符生效：`App.tsx` 占位符改为 `设置值 || 模式默认文案`；`show_recent` 经
  `applyRuntimeSettings` 读入、控制 `.recent-bar` 渲染。
- i18n 新增三语字符串：`recent`/`pinned`/`expand`/`collapse`/`showRecent`/
  `recentCount`/`searchPlaceholder` 等（en / zh-CN / zh-TW）。

### 10.4 剪贴板页面重新设计

**仅记入规划，方案待定**——由用户后续提供设计后，再开子步骤实现。

### 测试

- `recent.rs` 单测：upsert 前移、满额剔除、去重、`recent_count` 生效；`cargo test`。
- 手工：打开多个条目 → 主菜单最近栏按时间倒序；展开/收起与重置；开关与上限设置
  即时生效；输入搜索词后两栏隐藏。

### 实现说明（2026-08-05）

- **收起态实现**：不用 CSS `overflow` 裁剪，改为 JS 按测量列数切片——折叠渲染
  `slice(0, barCols)`，展开渲染全部；`barCols` 由 `measureBarCols` 读 `.bar-grid`
  计算 `gridTemplateColumns` 得出（auto-fill 轨道数稳定），窗口宽度/条目框变化时
  经 effect 重测。比 `max-height` 裁剪更稳（方框高度随列宽自适应，无法用固定高度
  定一行）。
- **测量自洽**：`measureBarCols` 变更列数后补一次 `resizeToContent`，消除首帧
  6 列默认值导致的窗口高度偏差。
- **占位符**：`placeholderApps() || t("searchApps")`（剪贴板同理），两模式各一条。
- **`runSearch("")` 短路**：空查询不再加载浏览网格（省掉 200 条浏览查询）。
- **`launch_app` 埋点**：加 `name: Option<String>` 参数（前端各调用点传
  `AppEntry.name`），启动成功后记入 `recent_apps`（按路径 upsert + 上限剔除）；
  UAC 取消（`ERROR_CANCELLED`）不记录。
- **已知边界**：展开栏的非首行仅鼠标可达（↑↓ 用于两栏循环，栏内只有 ←→ 移动第一
  行）；栏内多行键盘导航留待后续。
- **加（同日）**：最近栏条目右键菜单新增「从最近使用中删除」（软删除，只删
  `recent_apps` 记录，重新打开即回），位于「以管理员身份启动」之前；最近栏
  选中时按 `Del` 同样删除；仅最近栏右键显示，网格/固定栏菜单不变。
  `recent::delete_recent` + `remove_recent` 单测。
- 验证：`cargo test` 35 通过（含 recent 3 个）、`npm run build` + `tsc --noEmit`
  通过。

## 11. 剪贴板自动粘贴 + 复制按钮 + 界面体验项

**状态：已实现（2026-08-05，由远程提交合入）。**

背景：剪贴板历史此前只能「复制回剪贴板」。本迭代加入一键**自动粘贴**——把
历史条目直接送到呼出启动器之前的那个窗口；并补三处界面体验项与一次架构修正。

### 11.1 自动粘贴 + 复制按钮（`clipboard.rs` / `window.rs` / `App.tsx`）

- 新命令 `paste_clipboard(id)`：**先保存当前剪贴板内容**（文本/图片，
  `SavedClipboard`）→ 把条目写入系统剪贴板 → `hide_launcher` → 等 60ms 让
  Windows 把焦点还给前台窗口 → `SendInput` 发 Ctrl+V（`send_ctrl_v`，
  key-down/key-down/key-up/key-up）→ 等 100ms 处理 → **恢复原剪贴板**，用户
  剪贴板不被污染。
- **目标窗口来源**：`window.rs` 新增 `FocusState`（`last_hwnd`），
  `toggle_launcher` 每次呼出时用 `GetForegroundWindow` 记录呼出前的窗口；
  粘贴前 `IsWindow` 校验，窗口已消失或无记录则退化为普通复制
  （`set_clipboard_from_row`）。
- 剪贴板模式 **`Enter` 由「复制」改为「粘贴」**；右键菜单新增「粘贴回」
  （`pasteBack`）；每条历史行新增**复制按钮**（`.result-copy`，与删除按钮
  并列，`copyOnly` 仅复制不粘贴）。
- 新 i18n：`pasteBack` / `copyToClipboard`（en / zh-CN / zh-TW 已同步）。
- **无单测**：粘贴依赖真实前台窗口 + SendInput，靠手工验证；`cargo test` 由
  35 → **36 通过**。

### 11.2 跟随鼠标定位（`window.rs`）

- `appearance.window_position` 新增 `"follow-mouse"`（界面位置第 6 个预设）：
  呼出时窗口中心对齐鼠标光标（`GetCursorPos` + `position_at_mouse`），并
  clamp 在当前显示器工作区内（不越界）。
- `apply_position` 在 follow-mouse 模式下 **no-op**——内容高度自适应不再把
  窗口拉回某个固定锚点。

### 11.3 界面设置项（`appearance`，`InterfacePane.tsx`）

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `expand_pinned` | bool | `false` | 「默认展开已固定」——每次呼出时已固定栏直接展开 |
| `shift_enter_admin` | bool | `true` | 「Shift+Enter 以管理员身份启动」——选中项 Shift+Enter 提权启动 |

- InterfacePane 新增两 Toggle；`clearSearch` 按 `expand_pinned` 初始化
  `pinnedExpanded`（不再总是收起）；`onKeyDown` 的 Enter 分支在
  `e.shiftKey && shiftEnterAdmin()` 时走 `activateAdmin`（网格与两栏均生效）。

### 11.4 设置经 initialization_script 注入（`lib.rs` / `tauri.conf.json`）

- `setup()` 序列化生效设置 → `window.__LUME_CONFIG__`，经
  `.initialization_script()` 注入 main / settings 两个窗口；
  `tauri.conf.json` 的 `windows` 清空（窗口改由 Rust 构建）。
- 前端 createSignal 初始值同步读该全局（`_cfg?.appearance`），**消除首帧
  渲染的异步 IPC 竞态**——语言/尺寸/开关不再首帧先显示默认值再闪变。

### 11.5 修复：搜索网格键盘导航（`App.tsx`）

- 输入搜索词后有查询时，方向键**总是**走结果网格导航（`!empty` 分支优先于
  zone）——修复此前残留空查询两栏 `zone` 状态导致的方向键错位。

### 测试

- `cargo test` **36 通过**；`npm run build` + `tsc --noEmit` 通过。
- 手工：剪贴板条目 Enter → 粘贴进呼出前窗口；复制按钮仅复制；跟随鼠标呼出
  位置、展开固定开关、Shift+Enter 提权启动。

## 12. 两栏连续导航 + 剪贴板存储重构 + 展开撑满窗口

**状态：已实现（2026-08-05）。**

三条需求一次迭代：①主界面空查询两栏（最近使用/已固定）的键盘导航从「独立
区域」改为**连续网格**；②剪贴板存储重构——DB 不再保存复制数据的原貌（图片
落文件、文件存路径列表）；③点「展开」时窗口**纵向撑满内容**（受屏幕限制）。

### 12.1 主界面键盘导航：两栏合并为连续网格（`App.tsx`）

**现状**：空查询两栏是两个独立 `zone`（recent/pinned），各持
`recentSelected`/`pinnedSelected`；`↓`/`↑` 只是切换 zone，选中项不按列对齐。

**目标行为**（展开/收起同理，仅行数不同）：

- 列数 `C = barCols`；每个栏可视作矩阵：行 = `ceil(条数/C)`、列 = C，末行可不满。
- 选中态 =（栏, 栏内下标 i），列 `c = i mod C`、行 `r = ⌊i/C⌋`。
- **`↓`**：当前栏还有下一行且该行第 c 个元素存在 → `i += C`；否则若存在下一栏
  → 进入下一栏第 0 行、下标 = `min(c, 下一栏首行条数−1)`（**同列对齐**）；否则
  （已是最后栏末行）→ 环绕到第一栏第 0 行，下标同式钳制。
- **`↑`**：当前行非首行 → `i −= C`；否则若存在上一栏 → 进入上一栏末行，下标 =
  `min(c, 该行条数−1)`；否则环绕到最后一栏末行。
- **`←`/`→`**：行内移动，行首/行尾**钳制不环绕**（保持现状）。
- 只有**可见栏**参与（`show_recent` 关 → 仅固定栏；空栏整栏隐藏）。
- `Enter`/`Shift+Enter`/`Del`（仅选中项落在最近栏时删）/悬停，均作用于这个
  唯一选中项。

**实现**：`zone` 信号可移除；`recentSelected`/`pinnedSelected` 保留为
「栏内下标」，但 `onKeyDown` 的两栏分支改为**行/列感知的跨栏转换**（见上）。
列数变化（窗口宽度/条目框设置）时选中项保持列对齐语义。

### 12.2 剪贴板存储重构（`clipboard.rs` / `paths.rs` / `window.rs`）

**目标**：DB 只存「文本本体 / 图片文件引用 / 文件路径列表」，不存图片字节、
不复制文件本体。

#### 12.2.1 Schema（`init_db`/`migrate` 就地迁移）

```sql
CREATE TABLE clipboard (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL DEFAULT 'text',   -- 'text' | 'image' | 'file'
    content    TEXT NOT NULL,                  -- 文本 / 图片标签"Image" / 文件路径列表(换行分隔)
    data       BLOB,                           -- 仅旧版图片字节；迁移后恒为 NULL
    path       TEXT,                           -- 新增：kind='image' 时指向 PictureCache 的 PNG（相对 data_dir）
    pinned     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
);
```

- `migrate()`：检测缺 `path` 列 → 加列；遍历旧 `kind='image' AND data IS NOT NULL`
  行 → 导出 PNG 到 `PictureCache/<id>.png`、`path` 写相对路径、`data` 置 NULL。
- **图片文件命名** `<id>.png`（id 不复用，天然唯一）；**DB 存相对路径**
  `PictureCache/<id>.png`，读取时 `data_dir().join(path)` 解析——保证便携版整体
  拷贝不失效。

#### 12.2.2 图片采集（截图 / 网页图片 = 位图）

- `capture()` 现有 arboard `get_text()` → `get_image()` 流程保留；图片改为
  **先写文件再入库**：编码 PNG → `std::fs::write` 到 `PictureCache/<id>.png` →
  行存 `kind='image', path, data=NULL`。
- 缩略图：序列化时按 `path` 读文件 → `make_thumb`（逻辑不变，数据源从 BLOB
  换成文件）；文件缺失时回退未知图标。
- 进程内 `last_image_hash` 防连续重复仍有效（写文件前先哈希比对）。

#### 12.2.3 文件采集（资源管理器复制 = CF_HDROP 路径列表）

- 新增 CF_HDROP 检测（`windows` crate：`DataExchange` 的
  `OpenClipboard`/`GetClipboardData(CF_HDROP)`/`CloseClipboard` + `UI::Shell` 的
  `DragQueryFileW`；`Cargo.toml` 补 feature）。
- **采集顺序**：文本 → CF_HDROP → 位图（从资源管理器复制图片文件 = CF_HDROP →
  记为文件条目，符合"路径原样入库"；截图/网页位图才记图片条目）。
- **一次复制 = 一行**（已拍板）：整份路径列表用**换行**连接存 `content`
  （Windows 文件名不含 `\n`/`\r`，无歧义）；`kind='file'`；不复制任何文件本体。
- 去重：同内容（同列表）走文本同款「UPDATE 前移 created_at，无变更才 INSERT」，
  无需对 file 加唯一索引。

#### 12.2.4 复制回 / 自动粘贴（`copy_clipboard` / `paste_clipboard`）

- **图片**：读 PNG 文件 → 解码 RGBA → `arboard set_image`（替换原 BLOB 直接 set）。
- **文件**：重建 `CF_HDROP` 放回剪贴板——`GlobalAlloc(GMEM_MOVEABLE)` 写
  `DROPFILES` 头（`pFiles` 偏移、`fWide=TRUE`）+ UTF-16 路径列表（逐个 NUL、
  整体双 NUL 结尾）+ `SetClipboardData(CF_HDROP)`。
- **自动粘贴**（已拍板：文件条目**也走自动粘贴**）：`paste_clipboard` 对文件
  条目同样「重建 HDROP 放回 → Ctrl+V → 恢复原剪贴板」；前台若为资源管理器会
  就地复制/移动文件，**属预期行为**。
- 删条目（垃圾桶/Del）：`kind='image'` 时同步删除其 PNG；`clear_clipboard`
  清空全部行 + 清空 `PictureCache`。

#### 12.2.5 前端（`App.tsx` / `i18n`）

- `ClipboardItem.kind` 扩为 `'text' | 'image' | 'file'`；文件条目 tile 用文件/文件夹
  SVG，标签显示「N 个文件」（`fileCount` 三语 key）或单文件去扩展名名；
  点击/Enter 走自动粘贴（同 12.2.4）。
- 文件条目按 `content` LIKE 可搜（路径/文件名匹配，天然支持）。

### 12.3 展开撑满窗口（`window.rs` / `App.tsx`）

**现状**：`resizeToContent` 高度上限 = `window_height` 设置（默认 520px），展开
内容超出即内部滚动。

**目标**：任一栏展开（**两栏都生效**，已拍板）→ 窗口纵向撑到完整展示内容，
仅当内容超屏幕时才滚动。

- 高度上限动态化：`(recentExpanded() || pinnedExpanded()) ? 屏幕工作区逻辑高 −
  边距(~40px) : window_height 设置`。收起后恢复设置封顶。
- 新增 Rust 命令返回当前窗口所在显示器**工作区逻辑高度**
  （`current_monitor().work_area()` + `scale_factor()` 换算），处理 HiDPI/多显示器；
  读不到时回退 `window_height`。
- 展开态内容自然高测量沿用现有 `resizeToContent`（lastElementChild rect）；
  超出屏幕封顶才内部滚动（滚动条隐藏 + 悬浮指示条机制不变）。
- `apply_position` 锚点逻辑不变（center/corner/follow-mouse），增长后照常锚定。

### 测试

- `cargo test` **39 通过**（新增：图片写文件+path、文件行去重、迁移 BLOB→文件、
  HDROP 缓冲结构断言；原 36 个全保留）；`npm run build` + `tsc --noEmit` 通过。
- 手工（待用户验证）：资源管理器复制多文件 → 历史出现「N 个文件」且可搜；文件
  条目 Enter 自动粘贴到呼出前窗口；截图/网页图片 → `data/PictureCache` 出现 PNG、
  DB 无 BLOB；删条目 PNG 被清；跨栏 ↓/↑ 列对齐；展开后窗口撑满/超屏滚动。

### 实现说明（2026-08-05）

- **schema**：`clipboard` 新增 `path TEXT`（图片相对 `data_dir` 的
  `PictureCache/<id>.png`）；`data` 列保留但迁移后恒 NULL（`Row.data` 标
  `#[allow(dead_code)]`）。`migrate()` 先做 v0.2 重建再加 `path` 列；
  `migrate_blobs_to_files` 在 `open_db` 时一次性把旧 BLOB 导出成文件。
- **采集顺序**：文本 → CF_HDROP（`read_file_list`，`IsClipboardFormatAvailable`/
  `OpenClipboard`/`GetClipboardData`/`DragQueryFileW`，`windows` crate 补
  `Win32_System_DataExchange` + `Win32_System_Memory` features）→ 位图。
  从资源管理器复制图片文件 = CF_HDROP → 记为文件条目。
- **防自写**：`ClipboardState` 新增 `last_files`（换行连接串）跳过自己放回的
  文件列表，避免自动粘贴后又被采一条。
- **复制回**：图片读 `PictureCache/<id>.png` 解码 set_image；文件用
  `build_hdrop_buffer`（纯函数，`DROPFILES{ fWide=TRUE }` + UTF-16 路径双 NUL）
  + `GlobalAlloc/SetClipboardData` 重建 CF_HDROP。
- **文件清理**：`delete_row`/`clear_history` 同步删 PNG；`prune` 后
  `gc_picture_cache` 清扫未被引用的文件。
- **导航（12.1）**：新增 `visibleBars` + `moveBarSelection(dc, dr)`——两栏堆叠为
  一个连续网格（每栏行数 = 展开 ? ⌈条数/cols⌉ : **1**；收起态只暴露首行
  `min(条数, cols)` 个条目）。纵向 `↓`/`↑` 找该列**有内容的最近行**（跨栏保持
  列对齐；上一栏末行未填满时跳过，落在上一行对应列而非栏末尾），横向 `←`/`→`
  当前行内钳制；行首/行尾环绕。`zone` 语义保留（高亮/Enter/Del 用），默认从
  顶栏开始。**修正（同日，用户反馈）**：收起态此前按完整列表算行、可走进隐藏
  行；展开态跨栏 `↑` 此前钳到栏末尾——统一改为上述列对齐模型。
- **撑满（12.3）**：`window.rs` 新命令 `get_work_area`（`current_monitor().work_area()`
  + `scale_factor` → 逻辑高，0.0 回退）；`resizeToContent` 高度封顶 =
  `(recentExpanded||pinnedExpanded) ? max(window_height, 工作区高-32) : window_height`；
  展开切换时失效 `workAreaH` 缓存重新测量当前显示器。
- **已知边界**：`get_work_area` 按窗口当前所在显示器取，跨屏移动后需重新展开
  才刷新缓存；文件条目自动粘贴若前台是资源管理器会就地复制文件（预期行为，
  已在规划拍板）。

## 13. 剪贴板管理器重构（布局 + 行为，分三阶段）

**状态：阶段 1 + 2 + 3 已实现（2026-08-13），ROADMAP #13 全部完成。**

### 13.1 布局

- **页面结构**：剪贴板模式 = 搜索栏 → 分类区（全部/文本/图片/文件/收藏，
  按钮 32px、左右 padding 12px、圆角 8px，Active 用品牌色底不夸张）→ 列表区
  → 底部状态栏（左「共 N 条」/多选时「已选 N 条」，右「清空」→ 确认对话框
  +「保留固定记录」勾选）→ 空状态（剪贴板图标 +「暂无剪贴板记录」+「复制任意
  内容后会自动记录」小字）。
- **固定高度**：剪贴板模式窗口高度 = 设置窗口高度（不再随内容自适应），列表
  视口内部滚动；apps 模式仍自适应。`resizeToContent` 分模式（剪贴板固定、
  导航自适应），模式切换时强制重排。
- **单条记录三栏**：左 36px 圆角 tile（文本 T / 文件 SVG / 图片缩略图；URL 行
  → 链接图标；颜色行 → 色块）；中两行（第一行摘要单行省略、第二行
  「来源应用 · 时间」，来源应用按设置显隐）；右悬停显复制/粘贴/删除按钮；
  固定记录图钉标识；多选行品牌色底 + ✓ 角标。
- **URL / 颜色识别 = 前端展示时分类**（正则：`#hex` 3/6/8 位 + `rgb()/rgba()`
  + `hsl()/hsla()`；URL `http(s)://`/`www.`），不入库、不联网。

### 13.2 行为

- **来源应用**：捕获时取前台进程名（`GetForegroundWindow →
  GetWindowThreadProcessId → OpenProcess → QueryFullProcessImageNameW`，
  抽 `process_display_name` 纯函数），存 `source_app` 列；搜索范围 = 内容 +
  来源应用名。
- **分类过滤**：`search_history` 按 kind 过滤（text/image/file/favorites=pinned）
  + 匹配 content/source_app；返回上限 = 设置的 `history_cap`（返回全部匹配）。
- **多选 + 合并粘贴**：空格切换选中、Enter 对选中集调 `paste_clipboard_multi`
  （文本行内容换行连接 → 既有保存/粘贴/恢复流程）；Esc 清多选。
- **删除带动画 + 撤销**：删除行保留图片 PNG（孤儿由下次 prune 的 gc 清理）；
  `delete_clipboard` 返回 `DeletedClip`，前端 Toast「已删除 N 条 / 撤销」3s →
  `restore_clipboard`（text/file 按 (kind,content) 去重，恢复不 prune）。
- **清空**：二次确认 +「保留固定记录」；`clear_clipboard(keep_pinned)` 返回删除
  条数，保留固定项及其 PNG。
- **Toast / 动画**：底部居中 Toast（150ms ease-out，1.6s/撤销 3s）；
  hover/focus/menu 100ms、删除 120ms（淡出+上移）、窗口开/关 150/120ms。
- **虚拟滚动**：手写窗口化渲染（行高 52px 固定，~30 个 DOM + 前后 overscan，
  绝对定位切片）；键盘导航自动滚动保持选中可见；造 500 条 DOM 仍 < 60。
- **设置面板**：「剪贴板」页（历史上限 100/200/500/1000、记录图片、记录文件、
  粘贴后关闭、显示来源应用、时间显示方式 relative/absolute）；监听器实时读设置
  （关记录图片/文件即刻生效）。粘贴后关闭 = false 时后端 `auto_paste` 不隐藏 +
  短暂抑制失焦自动隐藏（`FocusState.suppress_hide_until`）。
- **右键菜单**：复制/粘贴/固定/删除 + 链接行「打开链接」、文件行「打开文件
  位置」（`launch_app` 打开 URL / `reveal_in_folder`）。

### 实现说明（2026-08-13）

- **schema**：`clipboard` 新增 `source_app TEXT`（`migrate()` ALTER，旧行留空）；
  读列用 `Option<String>` 防 NULL。
- **设置**：`settings.rs` 新增 `clipboard: Clipboard` 组，全部 `#[serde(default)]`
  向后兼容；`src/settings/types.ts` 同步。
- **删除语义变更**：`delete_row` 不再立即删 PNG（供撤销），孤儿由
  `gc_picture_cache` 惰性清扫——与 ROADMAP #12「删条目同步删 PNG」不同。
- **新建命令**：`paste_clipboard_multi`、`restore_clipboard`；`clear_clipboard`
  加 `keep_pinned` 参数；`delete_clipboard` 改返回 `DeletedClip`；
  `search_clipboard` 加 `kind` 参数。
- **已砍（阶段 3）**：预览区、拖拽导出（WebView2 需原生 OLE 拖拽源，成本高）。
- **已知边界**：来源应用名 = 捕获瞬间前台进程，若复制发生在 Lume 自身（复制
  按钮）会被防自写跳过；多选合并只取文本行（含图片/文件的选择回退为第一项
  单项粘贴）；相对时间显示在列表静态渲染时取当前时刻，长期停留不实时刷新。

### 13.3 阶段 2：富文本 / 忽略应用 / 暂停记录 / 自动合并复制

**状态：已实现（2026-08-13）。**

- **富文本 / 纯文本**：文本复制时若有 CF_HTML（arboard `get().html()`）一并存
  新 `html` 列（64KB 截断）；复制/粘贴默认带格式（`set_html(html, Some(text))`），
  右键「复制为纯文本」只设纯文本（`copy_clipboard({ plain: true })`）。搜索/显示
  仍用纯文本；`ClipboardItem` 只序列化 `has_html` 布尔（IPC 不传全文）。
- **忽略应用**：`ignore_apps` 列表（剪贴板设置页输入添加 + 逐条删除），与
  `source_app`（进程显示名）**不区分大小写精确匹配**，命中不记录——且不写
  last_*，同内容从非忽略应用再复制仍入库（`is_ignored` 纯函数）。
- **暂停记录**：状态栏「暂停记录 / 继续记录」运行时开关（`AtomicBool`，
  不持久化、重启恢复），`capture` 顶部直接返回。
- **自动合并复制**：`merge_copy`（默认关）+ `merge_window_ms`（默认 1500ms）。
  插入顺序 = 整条去重 → 合并追加 → 新行。合并条件：最近一行是文本、`now −
  last.created_at ≤ 窗口`、`last_paste_at < last.created_at`（粘贴关合并）、
  新文本 ≠ 该行最后一段（重复则前移不追加）。追加 = `content || \n || 新文本`、
  `merged_count + 1`。`merged_count >= 2` 时列表标题显示「合并复制 N 条」。
- **schema**：`clipboard` 加 `html TEXT`、`merged_count INTEGER NOT NULL DEFAULT 0`
  （`migrate()` ALTER + 0→1 规范化 legacy 行）；`DeletedClip`/`restore_row`
  保留 html/merged_count 供撤销。

### 实现说明（2026-08-13 阶段 2）

- 合并窗口判断用**真实 `now_millis()`**（不能用 `next_created_at`——它恒比上一条
  大 1ms，会恒在窗口内）。
- `set_clipboard_from_row` 文本分支：有 html → `set_html`；否则 `set_text`。
  「复制为纯文本」走 `set_clipboard_from_row_plain(row, true)` 强制 `set_text`。
- `paste_clipboard`/`paste_clipboard_multi` 成功后写 `state.last_paste_at = now`
  （有意使用某条即关合并）。
- 测试：53 通过（新增 html 存取、is_ignored、合并五态（窗口内/超窗/重复末段/
  粘贴关/开关关）、restore 保留 merged/html）。

- **已知边界**：HTML 仅存有 CF_HTML 的文本复制；合并仅作用于最近一条文本行；
  被忽略应用复制同内容后从非忽略应用再复制仍入库（不写 last_*）。

### 13.4 阶段 3：预览区 + 拖拽导出

**状态：已实现（2026-08-13），ROADMAP #13 收尾。**

- **右侧预览区**：选中剪贴板行时窗口加宽 `window_width + 320`（`resizeToContent`
  剪贴板分支按 `previewOpen` 计算 targetW，`lastWindowW`+`lastWindowH` 双守卫避免
  每换一行都 resize；取消选中/隐藏缩回）。布局 `.clip-page > .clip-cats + .clip-main
  (row: .clip-list + .clip-preview)`。预览按 kind：
  - 文本：全文可滚动（`.clip-preview-text`）。
  - 图片：`get_clipboard_image(id)` 读全尺寸 PNG → data URI（`.clip-preview-img`
    contain 限高）；点击弹**放大浮层**（`.clip-enlarge` fixed overlay）。
  - 文件：`get_file_info(paths)` → 每文件 名称 / 大小（`formatBytes`）/ 路径 /
    修改时间。
- **拖拽导出（原生 OLE）**：WebView2 HTML5 拖拽无法携带文件出 webview，改走
  `DoDragDrop`——新 `src-tauri/src/dragdrop.rs`（`Win32_System_Ole` feature +
  直接依赖 `windows-core`），`implement` 实现 `IDataObject`（CF_HDROP、
  `build_hdrop_buffer` 复用）+ `IDropSource`（Esc 取消/按键松开放下/默认光标）+
  最小 `IEnumFORMATETC`。命令在**专用线程** `OleInitialize → DoDragDrop →
  OleUninitialize`。
  - 图片行 `drag_out_image(id)`：拷贝 `PictureCache/<id>.png` 到临时 PNG →
    CF_HDROP 拖出 → 结束清理。
  - 文件行 `drag_out_files(paths)`：CF_HDROP 原路径，Explorer 就地复制到目标。
  - 前端 `clipRow` 对 image/file 行加 `draggable` + `onDragStart`（preventDefault
    阻断 HTML5 拖拽 → invoke 原生拖拽；`clip-row-dragging` 抓取态）。

### 实现说明（2026-08-13 阶段 3）

- **修 phase 1 遗留 bug**：图片取文件路径双重前缀——`set_clipboard_from_row` 与
  `get_clipboard_image` 用 `picture_dir().join(rel)` 而 `rel` 已含 `PictureCache/`，
  导致图片复制/预览一直取不到文件（os error 3）。改为 `data_dir().join(rel)`；
  `picture_dir()` 删除。
- **COM 实现要点**：`implement` 宏生成 `Foo_Impl` 包装（实现 `IUnknownImpl` +
  Deref），trait 须实现在 `Foo_Impl` 上；`windows::core::Result` 与 `std::Result`
  勿混用；`GlobalFree` 收 `Option<HGLOBAL>`；`STGMEDIUM.pUnkForRelease = None`
  由 drop target 释放（HGLOBAL 交给目标后不再自己 free）。
- 测试：54 通过（+1 `stat_file_reports_name_and_size`）。OLE 拖拽无法单测/CDP
  模拟，靠手动验证。

- **已知边界**：图片拖出生成临时名 PNG 副本（图片原始文件名未存，无法还原）；
  文件拖出为复制（原文件不动）；预览跟随选中行，多选态不额外处理；
  `EnumFormatEtc` 返回最小单格式枚举（个别非 Explorer 拖拽目标若要求更多格式
  再扩展）。

### 13.5 阶段 3 修正（2026-08-13，用户反馈）

- **预览区门控（内容类型判定）**：仅当选中条目为**文本行**或**内容类型 =
  文本 / 音频 / 视频 / 图片的文件行**时展开右侧预览区并加宽窗口；**其他二进制
  （.dll/.exe/.zip 等，`fileContent` 判定为 `other`）不展开**，**图片 kind 行不
  展开**（图片预览在条目框缩略图，点击弹放大浮层 `.clip-enlarge`）。窗口宽度随
  `previewOpen` 状态切换收/放（effect 仅在开关翻转时 `scheduleResize`）。
- **内容预览**：`ClipPreview` 按内容类型分支（`<Switch>/<Match>` 响应式——
  分支判断必须在 JSX/响应式中，写在组件函数体里会因 SolidJS 不重跑函数体而
  僵死在首挂载类型）：
  - 文本行 / 文本文件（.txt/.md/.json/.py…）：`get_file_text(path)`（512KB
    上限，`from_utf8_lossy`）→ 可滚动全文。
  - 音频 / 视频文件：`<audio>/<video src={convertFileSrc(path)} controls>`——
    启用 **asset protocol**（`tauri.conf.json` `app.security.assetProtocol`
    scope `["**"]`，tauri 自动加 `protocol-asset` feature）。
  - 图片文件（.png/.jpg/…）：`<img src={convertFileSrc(path)}>`，点击经
    `onEnlarge` 弹 App 级放大浮层。
  - `other` 二进制：不展开（被 `previewOpen` 排除）。
- **文件 tile 区分内容类型**：`fileContent` 按扩展名给文本（T 图标）/音频
  （音符）/视频（摄像）/图片（画框）/其他（通用文件）不同 tile。
- **拖拽导出卡死修复**：`drag_out_image`/`drag_out_files` 改为 **async 命令**
  ——`run_drag` 的 `thread::join()` 从主线程移出（tauri 异步命令跑在 tokio
  worker 上），拖拽期间 UI 不再冻结。
- **文件属性稳健化**：`stat_file` 对路径 `trim()` + 去尾部 NUL（部分 HDROP
  源会残留）。
- **鼠标进预览区不关闭**：`onMouseLeave`（mouse 来源时 `setSelected(-1)`）从
  `.clip-list` 移到 `.clip-main`——鼠标从列表移进右侧预览区不再触发清除选中/
  关闭预览；离开整个列表+预览区域才清除。预览区与文本预览隐藏滚动条
  （`scrollbar-width:none` + webkit 0，滚轮滚动）。
- **移除剪贴板拖拽导出**（2026-08-14，用户认为无用）：删除 `dragdrop.rs`、
  `drag_out_image`/`drag_out_files` 命令、前端 `draggable`/`onDragStart` 与
  `clip-row-dragging`；还原 `build_hdrop_buffer`/`get_row`/`Row` 可见性；移除
  `windows-core` 依赖与 `Win32_System_Ole` feature。asset protocol（音视频预览）
  保留。
- **右键完全不改变窗口状态**：`onContextMenu` **不再 `setSelected(idx)`**（菜单
  操作的是右键行的 `m.item`，不依赖 `selected`），右键任何行都不会改变选中/
  预览/窗口宽度；配合 resize effect 的 `menu()` 守卫，右键前/菜单中/关闭后
  窗口完全不变。
- **分类重构（2026-08-14）**：分类改为 **全部 / 文本 / 文本文件 / 图片 / 视频 /
  收藏**（原「文件」→「视频」，新增「文本文件」）。后端 `search_history` 支持
  `textfile`/`video`（file 行按 `file_content_kind` 扩展名过滤）与 `image`
  （image kind 行 **+** 图片内容 file 行）；前端 `ClipKind`/`CLIP_CATS` 同步。
- **内容分类始终展开预览**：`previewOpen` 对 `textfile`/`image`/`video` 分类
  无条件返回 true（窗口恒宽、预览恒在）；`ClipPreview` 新增 image-kind 行分支
  （`get_clipboard_image` 大图 + 点击放大）。**右键期间预览保持**：`previewOpen`
  在 `menu()` 打开时返回 true，右键不会再让预览消失。
- **预览规则细化（2026-08-14）**：**文本 / 收藏 分类不打开预览区**（纯列表）；
  **全部按需**（文本行与非二进制文件行才展开）；**文本文件 / 图片 / 视频 常驻**
  预览。`previewOpen` 改 `switch(clipKind())` 分派（移除 `ALWAYS_PREVIEW_CATS`）。
- **左右箭头切换分类**：剪贴板模式下空查询时 `←`/`→` 循环切换分类
  （`switchCategory(delta)` 取模 CLIP_CATS）；有输入时仍是文本编辑。
- **输入模态互斥（2026-08-14）**：键盘导航激活后**鼠标悬停不再改变选中**（一行
  `onMouseMove` 里 `if (selectionSource === "keyboard") return`，apps 网格同）；
  **鼠标点击恢复鼠标模式**（`onClick` 先设 mouse+选中再 activate），点击始终生效。
- **文本行不触发预览**：`previewOpen` 的「全部」分支仅 file 行（内容≠other）展开，
  移除文本行 `return true`；文本预览仅服务 文本文件 分类（.txt 内容）。
- **固定即时生效**：`toggleClipPin` 对本地 `clips()` **乐观更新**（图钉立刻出现），
  失败回滚，再重搜置顶。
- **键盘滚动修复**：虚拟列表滚动 effect 加 8px 缓冲 + 视口尺寸变化重算；并**跳过
  `scrollIntoView({block:"nearest"})`**（它会把滚动覆盖回无缓冲的精确贴边位置，
  导致选中行底边差 0.1px 露在视口外）。
- **移除文件属性预览（2026-08-14）**：删除 `.clip-preview-files`（名称/大小/路径/
  修改时间）前端与后端 `get_file_info`/`stat_file`/`FileInfo` 命令；`ClipPreview`
  只剩 文本文件/音频/视频/图片 内容分支。**移除 `previewOpen` 的 menu 守卫**——
  右键不再强制打开预览（右键行若本不该预览则不出现预览区）。
- **单击选中 / 再击粘贴**：`onClick` 若 `selected()===idx` 才 `activate()`（粘贴），
  否则仅 `setSelected(idx)`（选中）；配合悬停选中，双击/第二次点击即粘贴。
- **移除悬停加深**：删除 `.clip-row:hover { background }`；条目仅在选中态高亮，
  悬停不再加深（操作按钮仍悬停显示）。
- **悬停选中可开关（2026-08-14）**：设置/剪贴板新增「悬停选中条目」
  （`clipboard.hover_select`，默认**关**）——关闭时鼠标选中条目的唯一条件是
  **单击**（`onMouseMove` 门控 `!hoverSelect() || selectionSource==="keyboard"`），
  开启时恢复悬停选中；apps 网格同门控。
- **收藏/取消收藏**：右键菜单「固定/取消固定」改文案「收藏/取消收藏」
  （`pin`/`unpin` i18n 值改，`pinned` 栏标题「已固定」不变）。
- **收藏置顶可开关**：设置/剪贴板新增「收藏的条目置顶显示」
  （`clipboard.favorites_top`，默认**关**）——关闭时按纯时间倒序（收藏仅保留
  图钉徽标），开启时固定行 `ORDER BY pinned DESC` 置顶。`search_history` 加
  `favorites_top` 参数（条件 ORDER BY），`search_clipboard` 读设置。

- **已知边界（修正后）**：图片原始文件名未存，放大浮层标题仅显示「图片」；
  音频/视频预览为文件属性（非媒体播放器）。

## 14. PDF / Office / 压缩包预览（规划，已被 #16 取代）

**状态：已并入 #16（2026-08-15）。经 grill-me 定稿：Office 与 压缩包 均放弃，
仅 PDF 预览实现（走前端 PDF.js），技术细节见 #16。**

原规划：当前 `fileContent` 把 `pdf`、Office、压缩包等格式归为「其他」——只有
通用文件图标、不展开预览。本迭代补这三类格式的预览。

### 14.1 范围与识别

- `fileContent` / `file_content_kind`（前后端各一份，规则须一致）扩扩展名集：
  - PDF：`pdf`
  - Office：`doc docx xls xlsx ppt pptx`（旧二进制格式 `doc/xls/ppt` 解析难度高，可能只支持新 OOXML）
  - 压缩包：`zip rar 7z tar gz gzip`（rar/7z 依赖第三方 crate，可能只支持 zip/tar.gz）
- 行首图标：PDF（文档图标）、Office（表格/幻灯片图标）、压缩包（压缩包图标）。

### 14.2 预览方案（技术选型下次会话敲定）

- **PDF**：渲染首页/多页预览。候选：后端 PDFium（`pdfium-render`）抽页转 PNG；
  或前端 PDF.js 渲染（需引入 web 依赖 + CSP 调整）；或后端纯文本抽取（轻量，
  但无版面）。
- **Office（OOXML = ZIP+XML）**：**抽取纯文本**预览——docx 读
  `word/document.xml`、xlsx 读 `sharedStrings.xml`、pptx 读 `ppt/slides/*.xml`；
  用 `zip` crate 解包 + XML 去标签。轻量、无 Office 依赖。旧二进制格式待定。
- **压缩包**：**列出包内文件清单**（路径 + 大小）——`zip` crate 读目录；
  rar/7z 若支持则同，否则只支持 zip。
- 后端新增命令（`clipboard.rs` 或新模块）：`get_office_text(path)`、
  `get_archive_list(path)`、`get_pdf_preview(path)`（或 `get_pdf_pages`）。
- 前端 `ClipPreview` 加分支：PDF 显示页图（+翻页）；Office 显示抽取文本
  （复用 `.clip-preview-text`）；压缩包显示文件清单列表。

### 14.3 待用户确认（实现前）

- 分类归属：是否新增「文档」「压缩包」分类，还是并入现有「文件」/「全部」
  按需预览？PDF/Office 归「文本文件」还是新分类？
- PDF 渲染深度：仅首页缩略 vs 多页可翻。
- 资源约束：引入 `pdfium-render`/`zip` crate 需镜像源；PDF.js 引入前端依赖
  需评估 CSP。

### 测试

- 单元：扩展名分类、docx/xlsx/pptx 文本抽取、zip 清单解析（用构造的样例文件）。
- CDP：各格式预览内容正确渲染、分类过滤生效。

## 15. 预览内存回收：独立磁吸预览窗口（已实现）

**状态：已实现（2026-08-15）。磁吸/焦点/回收策略经 grill-me 定稿，CDP 实测通过，
内存回收为「部分回收」（见下「实测结论」），用户接受。**

### 实测结论（2026-08-15，`scripts/measure-webview-mem.ps1` + `cdp_preview_memtest.mjs`）

- **renderer ×3 确认**：main + settings + preview 各一 renderer。
- **主 renderer 隔离成立**：图片预览打开时 main 的 renderer 仅 +1.5MB（其余为剪贴板
  页自身），解码峰值不进主窗——卫星窗口的核心价值达成。
- **about:blank 只做部分回收**：4000×3000 大图预览时 renderer 52.9→60.3MB；Esc 关闭
  （about:blank）后 **60.3MB 未回落**——Chromium renderer 进程的工作集不主动归还 OS
  （分配器保留），~7MB 滞留在预览 renderer，封顶不增长、下次预览复用。**用户接受
  部分回收**，未采用乙方案（关闭时销毁窗口，运行时建窗有 AppHangB1 GPU 挂起风险）。

### 背景与问题

当前所有页面（launcher + 剪贴板 + 预览）都驻留在同一个 WebView2 renderer 里。
Chromium 的设计：DOM 元素移除后，解码的图片位图和媒体缓冲仍留在 renderer 的
缓存/堆里，**不主动归还**——系统内存吃紧时才回收。因此：

- 图片「放大」解码的全尺寸位图（4K 截图 ~33MB）在关闭覆盖层后仍残留。
- 视频「播放」缓冲的媒体数据在离开预览后仍残留。
- 这不是泄漏，是 WebView2/Chromium 引擎行为；DOM 层面无法做到「关闭即回收」。

### 已做的缓解（2026-08-15）

- 预览区图片改为缩略图（`item.thumb` / 新增 `get_file_thumb`），选中记录不再
  解码全图。
- 媒体元素加 `preload="none"`，选中不缓冲，点击播放才加载。
- 但放大/播放产生的峰值仍在主 renderer 里、关闭后不回收——#15 解决这个。

### 方案（grill-me 定稿，2026-08-15）

**所有预览内容移出主 renderer，进一个独立的、固定挂靠主窗口右缘的卫星预览窗口。**
主窗口恒为基础宽度，永不为预览变化。四项决策：

1. **焦点语义**：卫星窗口 `WS_EX_NOACTIVATE` 非激活（`show` 不 `set_focus`）——点
   预览不抢焦点，主窗口始终持焦、不触发失焦隐藏。**代价**：文本预览不可选中/
   复制（copy-back 走主列表行按钮）；视频仅鼠标控件可用（空格/方向键/全屏快捷键
   失效）；滚轮可滚、拖滚动条不灵。
2. **回收机制**：隐藏时导航 `about:blank`——页面销毁、解码位图/媒体缓冲释放，
   renderer 进程保留 ~15MB 待复用。窗口在启动时创建（同 settings 模式），规避
   运行时建窗 AppHang 风险。
3. **预览范围**：文本/文本文件/图片/音频/视频**全部**走卫星。主窗口内嵌预览 UI
   （`.clip-preview` 侧栏、`PREVIEW_W` 加宽、`.clip-enlarge` 放大浮层、
   `previewOpen` 分类 switch）全部删除。列表行内 tile 缩略图保留。
4. **磁吸**：固定挂靠（非可拖离）。卫星左缘 = 主窗口右缘（宽 320 = 旧 `PREVIEW_W`，
   高跟随主窗口，磁吸成一整块）；`WindowEvent::Moved`/`Resized` 跟随重定位；右缘
   溢出兜底贴左缘。生命周期与主窗口绑定：主窗口隐藏 → 卫星隐藏（视频只能
   「启动器开着时」看）。

**防抖**：show 和 hide 都 ~100ms（滚动经过 other 行时不闪）。

### 实现要点

- **新页面 `preview.html`**（vite 多入口 + 极小 `src/preview.tsx`）：按 kind 渲染
  文本/文本文件 `<pre>` / `<img>`（object-fit contain，点按切 1:1）/ `<audio>` /
  `<video>`；深色背景、拖拽区（`data-tauri-drag-region`）、Esc/点击关闭（invoke
  `close_preview`）；加载后 invoke `get_preview_request` 取 `(kind, path)`——避免
  asset:// URL 传参编码坑。
- **Rust**：启动时建 `preview` 窗口（`lib.rs`/`window.rs`：无边框、透明深色背景、
  置顶、skip_taskbar、非激活、`visible(false)`）；命令 `show_preview(kind, path)`
  （存 Mutex → navigate `preview.html` → show + 贴右定位）、`close_preview()`
  （hide + navigate `about:blank` + 清 Mutex）、`get_preview_request()`；
  `main` 窗口 `WindowEvent::Moved`/`Resized` 时重定位卫星；主窗口隐藏时连带隐藏
  卫星。
- **前端**：删除全部内嵌预览 UI 与窗口加宽逻辑（`lastWindowW`/`prevPreviewOpen`/
  `PREVIEW_W`/`enlargeImg` 等）；选中变化防抖后调 `show_preview`/`close_preview`，
  规则 = 除 other 二进制（.dll/.exe 等）外所有行都预览，无选中/other → 隐藏。

### 验证顺序（实现第一步）

1. 确认 `preview` 窗口独立 renderer（进程数对照，预期 renderer×3）。
2. `scripts/measure-webview-mem.ps1` 实测 about:blank 后回落 ~15MB 基线；
   **若不回落 → 回退乙方案（隐藏时销毁窗口，代价 = 重建延迟 + 运行时建窗风险）**。
3. `WS_EX_NOACTIVATE` 下视频控件鼠标可用性、文本不可选中接受度、磁吸跟随/溢出贴左、
   生命周期绑定——CDP/手动验证。

### 已知取舍

- **首屏延迟**：选中稳定后 ~150~250ms 才出预览（防抖 100ms + 页面加载/内容读取）。
- **视频是「预览」不是播放器**：只能鼠标控制、生命周期随启动器。
- **空闲基线**：main + settings + preview 三个 renderer ≈ 115→130MB（+15~20MB
  常驻），换来峰值不滞留。

### 测试

- 内存：`scripts/measure-webview-mem.ps1` 对比打开/关闭预览前后的 renderer
  priv-WS（预期关闭后回落 ~15MB 基线）。
- CDP/手动：文本/文本文件/图片/音频/视频预览、磁吸跟随、拖主窗跟随、溢出贴左、
  Esc/点击关闭、失焦一起隐藏、快速滚动防抖不闪。

## 16. PDF 预览 + 源码/歌词归文本 + 音乐分类 + 预览开关 + 左磁吸重叠修复（已实现）

**状态：已实现（2026-08-15）。grill-me 定稿：压缩包/Office 放弃，仅 PDF；PDF 走
前端 PDF.js（懒加载）；预览开关默认开、只关卫星窗；左右都放不下时隐藏卫星窗。**

承接 #15（独立磁吸预览窗口）。本迭代四个改动：

### 16.1 PDF 预览（PDF.js，多页可翻）

- **技术选型**：前端 `pdfjs-dist`（v6，npm 走镜像 `--registry=https://registry.npmmirror.com`），
  放弃后端 PDFium——PDFium 的 DLL 需构建时从 GitHub 下载（违背「始终用镜像源」铁律），
  且主进程常驻 +25~40MB 不可回收；PDF.js 懒加载后 ~5MB 常驻**卫星 renderer**（契合
  #15 已接受的回收模型，主 renderer 零影响）。CSP 为 `null`、asset 范围 `**`，无阻碍。
- **懒加载**：`await import("pdfjs-dist")`（Vite 分包 `pdf-*.js` 479KB + worker
  1.26MB），首次预览 PDF 才进卫星 renderer；worker 用
  `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`。
- **手写迷你查看器**（不用整套 viewer UI，320px 卫星窗够用）：`.preview-pdf-scroll`
  滚动区 + canvas + 工具栏 `‹ › 页码 ‹/ › ＋ − 缩放`。**只渲染当前可见页**，
  `pdfRenderToken` + `pdfRenderTask.cancel()` 保证快速翻页不交错；离屏页 `page.cleanup()`，
  切换文件 `loadingTask.destroy()`。
- **文件读取**：`getDocument({ url: convertFileSrc(path) })`——asset:// 经
  `http://asset.localhost`（CORS 由 Tauri asset 协议放行），无需新后端命令。
- **未配置 cMap / wasm / standard_fonts**：非内嵌 CJK/标准字体与 JBIG2/JPEG2000 的
  极端 PDF 会降级（控制台警告、个别字形缺失）——v1 接受，后续可在 `getDocument`
  选项里补目录 URL。放大仍受 320px 宽限制（缩放解决），卫星窗为 PDF 单独加宽留作后续。

### 16.2 源码/歌词归文本

`TEXT_EXTS` / `file_content_kind`（前后端两份，保持一致）扩扩展名：新增常见编程语言
`kt swift php rb dart scala cs fs fsx r pl hs zig nim ex exs erl clj vue svelte jsx tsx
mjs cjs groovy gradle proto gql tex`，歌词 `.lrc`，字幕 `.srt .vtt .ass`。文本行已有
T tile + 卫星文本预览，无 UI 改动。

### 16.3 「音乐」分类 + 预览开关 + 左磁吸重叠修复

- **音乐分类**：`ClipKind` 加 `"music"`，插到 图片 和 视频 之间；后端 `search_history`
  `"music" => file_content_kind == "audio"`（SQL 走 `kind='file'` + Rust 后过滤）；
  i18n `clipCategoryMusic` ×3。音频行本就有音符 tile（沿用）。
- **预览开关**：`clipboard.preview`（默认**开**），设置/剪贴板顶部新增「开启预览」
  Toggle（i18n ×3 + 提示文案）。关闭时前端 `previewEnabled` 信号门控卫星同步
  （`req = null` → `close_preview`），后端 `show_preview` 也门控（teardown 兜底）。
  **只关卫星窗**——列表内图片行内缩略图保留。
- **左磁吸重叠修复**（#16 修 #15 的一个 bug，用户复测发现未根治，**两层根因**）：
  **①钳制**——`dock_position` 左分支原来把位置 `max()` 钳进工作区左缘，主窗贴
  左缘且右侧放不下时（高 DPI / 窄工作区最常见）卫星窗与主窗重叠。修：左停靠 =
  `main_pos.x - preview_width`（贴紧），`dock_position` 改返回 `Option<Position>`，
  两侧都放不下 → `None`，`redock` 隐藏卫星窗（页面保留、不导航 about:blank，
  移回后可立即再贴）。**②不可见非客户区**——用户复测仍重叠 ~8px。加 Rust 临时
  `eprintln` 实测地面真值（`scripts/cdp_dock_measure.mjs` + stderr 捕获）：
  `main_pos=(1469,2)`、`dock=(989,2)`、`set_position` 后 `outer=(989,2)` 但
  `inner=(1000,4)`——**预览窗虽 `decorations(false)` 仍带 ~11px 左 / ~2px 顶
  不可见边框**（150% DPI）。`set_position` 设的是**外框**，而磁吸数学算的是
  **客户区**：左停靠时预览客户区右缘 = 989+11+480 = 1480 > 主窗客户区左缘 1469
  → 重叠 11px；右侧同理有 11px 隐藏间隙（#15 曾误判为 ~1px）。修：在 `redock`
  用同样的 `GetClientRect`+`ClientToScreen`（预览自身 HWND）量出 client→outer
  inset，`set_position(client_target - inset)`——**两侧客户区真正对齐**；随后按
  用户要求加 `PREVIEW_GAP_LOGICAL`（4→8 逻辑 px）两侧统一留间距（CDP 实测左/右
  gap 均 8.0 CSS px）。**附注**：磁吸数学本身没错，bug 全在「外框 vs 客户区」的
  坐标系错位。**show_preview 可见性门控**——「开启预览」在设置里重新打开时，设置窗
  抢焦点使启动器失焦隐藏，前端 preview sync 会在启动器隐藏时调 `show_preview` →
  飘出孤立预览窗。修：`show_preview` 先查 `main.is_visible()`，启动器不可见则
  `teardown_preview` 不显示（也顺带挡住「隐藏时新剪贴板行触发 effect」的同款潜在
  bug）。另将 `custom-protocol` 加进 Cargo.toml tauri features——否则裸
  `cargo build --release` 出 dev 版（`cfg(dev) = !custom_protocol`，加载
  localhost:1420 而非内嵌前端）。

### 测试

- 单元（62 通过）：`file_content_kind_extends_source_lyrics_and_pdf`（新扩展名/
  .lrc/.srt/.ass/pdf）、`search_filters_by_kind_and_source_app`（+ music 分支）、
  `dock_left_flush_matches_right_gap` / `dock_left_hidden_when_no_room_on_either_side`
  （`dock_position` 改 Option 后贴紧 + None 兜底）、settings `preview` 默认 true。
- CDP（`scripts/cdp_feature_smoke.mjs`）：PDF 卫星渲染 canvas、音乐分类介于图片/
  视频之间且过滤音频行、.lrc 进文本预览、开关关闭卫星不弹、设置页剪贴板栏渲染开关。

## 17. 多文件勾选 + 失效判定 + 去重开关 + 记住页面（已实现）

**状态：已实现（2026-08-17）。grill-me 定稿七项，全部落地。`cargo test` 71 通过。**

承接 #15/#16 的卫星预览窗。一个 grilling 会话定稿的七项改动：

### 17.1 严重问题修复：旧条目复制/粘贴"无反应"（静默失败 → 全部可见）

**根因**（代码核实）：复制/粘贴按钮本身正常；「无反应」全是**静默失败**——`copyOnly`
失败分支只 `console.error` 无 toast（图片 PNG 丢失时 `copy_clipboard` 返回 Err，字面无
反应）；文件行路径失效时 `set_files_to_clipboard` 不查存在性、返回 Ok，复制"成功"但粘进
目标没东西。

**修复**：`copyOnly`/`copyPlain` 失败也弹 toast（新 `copyFailed`）；所有复制/粘贴错误经
`clipErrorToast` 映射——`CLIP_INVALID` →「内容已失效」、`CLIP_NO_FILES` →「未勾选任何
文件」，其余 → 通用失败。失效拦截见 17.2。

### 17.2 失效条目划线变灰（file 全缺失 / image PNG 丢失）

- **判定**：`row_invalid`/`ClipboardItem.valid`——文本永不失效；图片行 PNG 不存在；
  文件行**全部**路径不存在（部分缺失仍可用）。`search_history` 每次搜索现算（`Path::exists`，
  与图片 thumb 现有逐次读取一致；历史大时可加短 TTL 缓存）。
- **表现**：`.clip-row-invalid`（标题划线 + 整行变灰，App.css）；`previewTarget` 对失效行
  返回 null（不展开预览）；前端复制/粘贴直接拦 + toast，后端 `usable_paths` 返回 `CLIP_INVALID`
  兜底。

### 17.3 多文件条目 → 文件列表预览 + 勾选（项2）

- **≥2 文件**行卫星窗显示**文件列表**（取代"预览第一个文件"），**含全 other 二进制行**
  （推翻"other 不预览"规则——列表本身有用）。单文件行维持按类型预览。
- **卫星 `filelist` 模式**（`preview.tsx`）：每文件复选框 + 逐文件存在性（新命令
  `check_file_exists`，缺失项划线变灰 + 禁用勾选）；头部 `fileCount` + **「记住勾选」
  开关**（`clipboard.remember_checks`，默认开）。
- **复制/粘贴只对勾选子集生效**：`effective_file_paths` = 存储勾选 ∩ 现存文件（记住开且
  有覆盖时）否则全部现存文件；`usable_paths` 拒绝失效行 / 全不勾选行（`CLIP_NO_FILES`）。
  `set_clipboard_from_row_paths` 用过滤子集重建 HDROP。命令无需前端传路径——`copy_clipboard`/
  `paste_clipboard` 读 DB 最新 `checked`，消除卫星与主窗的同步问题。
- **持久化**：`clipboard` 表新增 `checked TEXT`（JSON 索引数组；迁移 ALTER）；勾选经新命令
  `set_clipboard_checked` 写入（记住开才调）；`DeletedClip`/`restore_row` 携带，撤销不丢。
- **默认勾选 = 仅存在的文件**；记住关 → 每次会话重置为该默认。

### 17.4 内容去重开关（`clipboard.dedup`，默认开）

- 开 = 现状（文本/文件整条一致 → 前移不重复；图片只防连续重复）；**关 = 相同内容也新增
  一条**。文本部分唯一索引 `idx_clipboard_text_unique` 按开关 DROP/重建（启动 + `save_settings`
  时 `set_dedup_enabled`）；`insert_text_history`/`insert_file_history`/`restore_row` 去重分支门控。
- 已知边界：`capture()` 的 `last_*` 连续防自写保留——连续两次相同复制在关状态下仍折叠，
  仅"隔次"重复新增。

### 17.5 记住上次所在页面（`appearance.remember_last_page`，默认关）

- 记住**模式 + 剪贴板分类**（`last_page`/`last_page_kind` 落盘，新命令 `save_last_page`
  轻量写盘、**不碰 backup.toml**）；**搜索词仅本会话内**记住（`clearSearch` 不再清两模式
  query，热键重呼出恢复、重启清空，避免明文搜索词写盘）。
- `clearSearch`/`launcher-shown`/`onMount` 按记忆恢复模式并 runSearch；`switchMode`/
  `setClipKindAndSearch` 防抖 400ms 持久化。命名与窗口位置「记住位置」区分。

### 17.6 多文件行混合类型 tile（项6）

`clipTile`：≥2 文件且类型**混合**（`Set` of `fileContent` > 1）→ 新 `res/icons/multifiles.svg`；
全部同类型 → 仍显示该类型 tile。分类过滤（音乐/视频/图片/文本文件）仍按首路径。

### 17.7 移除剪贴板底部快捷键提示（项3）

删 `.shortcut-hint`（App.tsx / App.css / `clipShortcutHint` 三语）+ `resizeToContent` footer 测量。

### 测试

- 单元（71 通过，+7）：`file_row_valid_reflects_surviving_paths`、`image_row_invalid_when_png_missing`、
  `effective_paths_respects_checked_and_existing`、`usable_paths_rejects_invalid_and_empty_checks`、
  `dedup_off_records_duplicate_text_rows`、`dedup_toggle_gates_file_list_dedup`、
  `checked_state_survives_delete_and_undo`。
- 前端：`tsc --noEmit` + `npm run build` 通过。
- CDP/手动（待验证）：多文件行列表预览与勾选、记住开关、缺失划线、失效行灰色拦截、
  去重开关重启生效、记住页面跨呼出/重启、混合类型 multifiles 图标。

### 17.8 修正（2026-08-17，用户复测"旧条目复制/粘贴只对最新文件有效"，真正根因）

**定位**：隔离副本 + 用户真实数据自动化验证——`copy_clipboard`/`paste_clipboard` 对任意
旧 id 均精确设置该行内容（FileDropList 逐 id 比对全对），渲染/选中/按钮全对，但用户坚持
复现。按用户提示对照 ZTools 剪贴板插件（`E:\Softwares\ZTools\resources\app.asar`，
主进程 `ClipboardMonitor.setClipboardFiles` 走原生 addon 建 CF_HDROP）。
**真正根因**：`set_files_to_clipboard` **不调 `EmptyClipboard()`**。Explorer 复制文件时剪贴板
同时有 `CF_HDROP` + `CF_UNICODETEXT`（最新文件路径文本）；Lume 只 `SetClipboardData(CF_HDROP)`
替换文件列表，**残留的 CF_UNICODETEXT 仍是最新文件路径**。`Get-Clipboard` 默认读文本 →
永远显示最新文件；HDROP 里其实已是旧文件。文本条目用 arboard `set_text`（内部先清空剪贴板）
所以正常。**复现**：设文本哨兵 → `copy_clipboard(旧id)` → `Get-Clipboard` 文本仍=哨兵（残留）。

**修改**：①`set_files_to_clipboard` 在 `OpenClipboard` 后加 `EmptyClipboard()`（照搬 ZTools
原生做法）——剪贴板只含该文件列表，无残留文本格式。修复后 `Get-Clipboard` 文本=空、
FileDropList=旧文件。②（用户选「保留粘贴的内容」，同 ZTools）移除 `auto_paste` 的保存/还原
（删 `SavedClipboard`/`save_current_clipboard`/`restore_saved_clipboard`）——粘贴后剪贴板
保留粘贴内容。两者互补。文档（README/CLAUDE/CHANGELOG）同步更新。`cargo test` 仍 71 通过。

## 18. WebView2 闲置内存裁剪（已实现）

**背景**：Lume 常驻三个 webview（main / settings / preview），即使全部隐藏也各保有一个
renderer 进程。实测基线（release，idle 全隐藏，`scripts/measure-webview-mem.ps1`）：
**priv-WS 138.1 MB** = browser 39.4 + gpu 29.6 + **renderer ×3 58.1**（main 24.9 / settings
18.1 / preview 15.1）+ utility ×2 9.4 + crashpad 1.6。可压缩的几乎全在 renderer 闲置驻留上。

### 方案：WebView2 官方 `MemoryUsageTargetLevel = Low`

`ICoreWebView2_14+::SetMemoryUsageTargetLevel(Low)` 把 webview 闲置内存换出到分页文件（页面
保活不卸载、脚本继续跑），**重新激活必须手动设回 Normal**（不会自动恢复）——官方正是为
「隐藏但需保活」场景设计。tauri 2.11.5 未把该 API 透出到 builder，但 `Webview::controller()`
返回 COM controller 可直调。

**裁剪策略**（用户 /grill-me 拍板）：
- settings/preview **隐藏立即 Low**（`sync_aux_memory_targets` 按各自可见性设置）。
- main **隐藏满 10s 才 Low**（`trim_main_when_idle`：spawn 线程 sleep 10s 后查仍隐藏才设 Low，
  幂等）——频繁开关不触发换出；热键呼出前 `restore_main` 先设 Normal 预热，呼出不被换回卡住。

**实现**（`src-tauri/src/window.rs`）：
- `set_memory_target(app, label, low)` — `get_webview_window().as_ref().with_webview()` 取
  COM controller → `CoreWebView2()` → `cast::<ICoreWebView2_19>()` →
  `SetMemoryUsageTargetLevel(LOW/NORMAL)`。任何一步失败静默跳过（老 runtime 降级为不裁剪）。
  `with_webview` 回调经 dispatcher 在主线程执行，后台线程调用安全。
- `sync_aux_memory_targets`（settings/preview 按可见性）、`trim_main_now`（启动全 Low）、
  `restore_main`（show 前 Normal）、`trim_main_when_idle`（延时 Low）。
- 挂接点：启动 setup 末尾全 Low；`show()` 先 Normal；`toggle_launcher`/`hide_launcher`/
  `Focused(false)` 自动隐藏 → `trim_main_when_idle`；`open_settings`/`close_settings`/
  settings 标题栏 X → `sync_aux_memory_targets`；`show_preview` → `sync_aux`；
  `teardown_preview` 末尾 → `sync_aux`。
- Cargo.toml 加 `webview2-com = "0.38"`（与 tauri 的 0.38.2 统一；其 windows-core 0.61 与
  Lume 的 `windows` 0.61.3 同版，`windows::core::Interface::cast` 直接可用）。

### 实测

| 状态 | 原基线 | 裁剪后 |
|---|---|---|
| 隐藏 idle（启动 16s，全部隐藏）| 138.1 MB | **~102 MB**（renderer 58.1 → 23 MB，省 ~36 MB / 26%）|
| 隐藏稳定态（~2min）| — | **~59-75 MB**（含 OS 随时间的工作集修剪）|
| 热键呼出（从全 Low 状态）| — | **87ms**（可接受）|

- settings 打开 → renderer 恢复到 Normal（约 +10 MB）；关闭 → 回落 Low。
- 预览 dock、主窗呼出/隐藏、单实例等均正常。
- `cargo test` 73 通过；`cargo check` / `tsc --noEmit` / `npm run build` 全过。

### 被否实验：`--renderer-process-limit=1`

把 3 个 renderer 合并成 1 个进程（实测 renderer ×1 16.7 MB，总数 86.8 MB，额外省 ~18 MB）。
**但 WebView2 不支持多 webview + 该开关**：settings/preview 窗口创建**静默失败**——HWND 从
顶层窗口枚举中消失、CDP `/json/list` 只剩 1 个 page target、`open_settings` 返回 Ok 但无窗口
出现。**已回退**，仅保留 Part 1（MemoryUsageTargetLevel 裁剪）。教训：WebView2 的
`additional_browser_args` 不能随意用 Chromium 全局进程开关；多 webview 下 renderer-process-limit
是已知不支持的组合。

## 19. Explorer 上下文栏（呼出时识别当前文件夹）（已实现）

**背景**：Lume 在呼出时已用 `FocusState.last_hwnd`（`window.rs::toggle_launcher`）捕获呼出前的
前景窗口（用于剪贴板自动粘贴回填）。把该能力向前推一步：**若前景窗口是 Explorer，拿到它当前
打开的文件夹路径**（对齐 ZTools 的 `getExplorerFolderPath`），并实用化——在导航页底部新增
「Windows 资源管理器」栏，可一键在**当前文件夹**打开终端 / 复制路径，右键可启动 / 以管理员身份
启动。

### 实现

- **路径解析**（`src-tauri/src/explorer.rs`，COM `IShellWindows`）：`FindWindowSW(hwnd)` →
  `IServiceProvider(SID_STopLevelBrowser)` → `IShellBrowser` → `IShellView` → `IFolderView` →
  `IPersistFolder2::GetCurFolder` 拿 PIDL → `SHGetPathFromIDListW` 转本地路径。非 Explorer /
  虚拟文件夹 → `None`（栏不出现），优雅降级。
- **线程模型**：主线程是 STA COM 公寓，项目惯例把 shell COM 挪到新线程（同 `icons.rs`）。因此
  `get_foreground_context` 做成 async 命令，在 `spawn_blocking` 里再开**专用 STA 线程** +
  `CoInitializeEx(COINIT_APARTMENTTHREADED)` + `CoUninitialize`，避免与线程池既有公寓冲突，也
  不在热键主路径上做 COM。HWND 从 `FocusState` 拷贝（不 take，粘贴仍可用）。
- **动作**：`open_terminal_in_folder { path, shell, elevated }` — `ShellExecuteW` + `lpDirectory=path`
  （终端 cwd 即该文件夹），`runas` verb 实现高权限；`copy_path` — `arboard` set_text。
- **前端**（`src/App.tsx`）：`launcher-shown` 时 `refreshFolderCtx()` 拉取 → `folderCtx`；
  `.bar-list` **底部**新增「Windows 资源管理器」栏（`folderBarSection`，三个 tile：CMD 中打开 /
  PowerShell 中打开 / 复制路径），纳入**现有连续导航**（`zone` 扩展 `"folder"`，
  `moveBarSelection`/`visibleBars`/`hasBars` 泛化）；空查询自动选中时 folder 栏兜底。右键菜单
  `kind:"folder"`：终端 tile → 启动 / 以管理员身份启动；复制 tile → 复制路径。Enter 终端隐藏界面，
  复制路径留界面 + toast。
- **设置项**：`appearance.show_explorer_bar`（默认 **on**），设置/界面 → 「显示「Windows 资源
  管理器」栏」toggle；关 = 不再捕获/显示该栏。
- **依赖**：Cargo.toml `windows` 加 `Win32_System_Variant` + `Win32_UI_Shell_Common`
  （`GetCurFolder`/`SHGetPathFromIDListW` 的 feature 门控）。

### 验证

`cargo check` / `cargo test`（73 通过）/ `tsc --noEmit` / `npm run build` 全过。手动：Explorer
里呼出 → 底部出现该栏并显示文件夹名 → CMD/PowerShell 在目录打开、右键高权限、复制路径 toast；
非 Explorer 场景栏不出现。
