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

