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
