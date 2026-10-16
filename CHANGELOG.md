# Changelog

All notable changes to Lume are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versions follow
[semantic versioning](https://semver.org/).

> 历史条目保留当年的文档名与分期编号（如 P5 / ROADMAP #N）原文；被引用的
> `docs/RULES.md`、`docs/NORMS.md`、`docs/PLUGIN_GAP_ANALYSIS.md` 已合并或删除，现状见 `docs/` 下各活跃文档。

## [Unreleased]

### Documentation

- **文档体系改革 —— 活跃文档与历史归档分离** — 删除 `docs/RULES.md` 与
  `docs/NORMS.md`（内容分别并入 README/AGENTS 与 SETTINGS/ARCHITECTURE）；
  路线图一拆为二：`docs/ROADMAP.md` 改为只含开放事项（近期候选 / 远期方向 /
  明确不做），`docs/ROADMAP_HISTORY.md` 归档 #0–#49 的全部实现与验证记录；
  删除已自我归档的 `docs/PLUGIN_GAP_ANALYSIS.md`（uTools 调研的历史使命
  已由 PLUGIN_API 与路线图吸收，被删能力已在 ROADMAP「明确不做」登记）。
  `docs/PLUGIN_API.md` 重写为纯 API 参考：废除 P0–P6 与 #N 进度标记、重排
  连续章节编号（5A/6C/6I 交错问题消除）、删除「已完成」清单与历史注记，
  功能契约零丢失。`docs/SETTINGS.md` 删除 5 节历史「实现说明」（缺失条目
  已补进本文件的 Unreleased），`docs/TESTING.md` / `ARCHITECTURE.md` /
  `PLUGINS.md` / `UI_GUIDELINES.md` 清除阶段编号与进度标记。全仓 109 个
  文件的代码注释引用由 `ROADMAP #N` 重定向为 `docs/ROADMAP_HISTORY.md #N`。
  **新增文档规范（AGENTS.md 硬性约定 8）**：任何文档不得出现分期编号
  （P0–P6、Phase N）与完成状态标志，历史进度一律归 CHANGELOG 与
  ROADMAP_HISTORY。验证：`pnpm exec tsc --noEmit` 通过；
  `rg "P[0-6]|ROADMAP #|NORMS|RULES"` 在活跃文档与代码注释零残留
  （归档文件与 CHANGELOG/History 内的历史记录除外）。

### Removed

- **呼出键自动回退（ROADMAP #49）** — 废弃极早期的候选链「Alt+Space 被占用 →
  Ctrl+Space → Ctrl+Alt+Space，取第一个系统允许的组合」：启动改为只注册设置里的
  `hotkeys.toggle`（默认 Alt+Space）一次，冲突如实写日志
  （`[hotkey] <combo> unavailable: …` + 指引行）并保持无呼出键，不再静默换键；改键走
  设置 → 快捷键（录制仍实时校验占用；托盘 → 设置 始终可达）。顺带修掉旧候选
  链的副作用：自定义呼出键重启后被 Alt+Space 顶掉（旧 `register` 不读设置）。
  `docs/ARCHITECTURE.md` / `SETTINGS.md` / `TESTING.md` /
  `docs/ROADMAP_HISTORY.md` #49、`README.md` 同步。验证：debug exe 实机——A 默认设置日志
  `[hotkey] registered Alt+Space`；B 外部进程先占 Alt+Space 再启动，日志
  `[hotkey] Alt+Space unavailable: HotKey already registered …` + 无任何
  `registered Ctrl+…`，占位进程随后注册 Ctrl+Space 成功（证明无回退）；
  C 预置 `toggle = "Ctrl+Alt+F13"` 重启日志 `registered Ctrl+Alt+F13` 后恢复
  现场；`cargo check` / `cargo test`（211 passed / 9 ignored）干净。

### Fixed

- **搜索框删空收尾丢失（translator 1.4.1，插件侧修复）** — translator 模式页
  激活时把搜索框 "Hello" 逐字删空，插件原文停在 "H"。CDP 定位：宿主
  `setQuery`/`search` 两条路径都确实投递了 `query("")`（`__frameStates` +
  console 双向核对），是插件 `lume.on.query` 把空串写死丢弃。插件 1.4.1
  改为记录最近一次非空下发值、空串仅在原文仍等于该值时清空（`enter` 载荷 /
  历史 / 页内编辑不会被呼出·切页·就绪重放误清），页内「重置原文」× 同步
  走 `store.clearSource()`（作废在途翻译/防抖）。`docs/PLUGIN_API.md` §6C
  固化空串判别模式（ROADMAP #45）。验证：`test/_verify_query_clear.mjs`
  端到端 **9/9**（feature 进入 / hide-show 不误清 / 逐字删空清空 /
  切页往返保留 / 再次删空 / 新 enter 优先）；插件 `pnpm run verify`
  （95 测试 + build + check）干净。

### Changed

- **导航页「推荐使用」栏（ROADMAP #43）** — 插件结果与正常结果全面隔离：
  空查询主菜单里插件追加的行（文件拖入 / 剪贴板图片 / 命中活动窗口的
  `[[features]]`）不再以「网格替代栏目条」顶掉最近使用与已固定栏，而是进入
  独立栏目「推荐使用」（最近使用 → 已固定 → 推荐使用 → 插件栏目 →
  资源管理器，explorer 仍结构性最底）；**非空查询同样分块**——正常结果
  （原生索引 + 文件搜索）网格在上，网格内以「推荐使用」标题分隔行隔出插件行
  （全局关键字 / feature / provider；下钻与过滤仍是整栏替换）。拖入文件自动
  聚焦该栏首行（Enter 直接激活）；剪贴板/窗口行随呼出出现与消失，不再夺走
  召唤时自动选中的栏目。`docs/PLUGIN_API.md` §5.2/§5A/§6E.1/§6E.1.1/§6H.4、
  `docs/ARCHITECTURE.md`、`docs/TESTING.md`、`docs/ROADMAP_HISTORY.md` #43
  同步。
  验证：`cdp_p2b_verify` **29 项全过**（空查询并存断言 + 非空分块
  `{normal:1, plugin:4}` / 拖入聚焦首行 + Enter 激活）、
  `cdp_window_feature_verify` **14 项全过**；`cdp_p2_verify` 17/21 与既有
  4 项 `iframe.contentDocument` 陈旧探针基线一致；`tsc --noEmit` /
  `pnpm run build` / `cargo check` / `cargo test`（202 passed / 9 ignored）
  干净。

- **搜索框内容跨模式共享（ROADMAP #48）** — 默认（设置「各模式使用独立
  搜索词」关）所有模式共享同一份搜索框内容：在任一模式输入后切模式 / 按切换
  键，目标页显示同一段文字并按其搜索；插件 `app.setQuery`、输入框占用
  （subInput）回填写同一份值；打开首页条目后的下次呼出与闲置重置清空它，
  分离窗口关闭回流把窗口最后查询并入。经关键字 / feature 行**进入**某模式
  属于使用条目，会消耗该值（入口触发词不是目标页的过滤条件）。新增设置
  `appearance.per_mode_query`（默认关；设置 → 导航页 →「导航栏」组，挨着
  「记住上次所在页面」）可恢复逐页独立查询（#48 之前行为）；两种模式都仅
  会话内存、查询从不落盘。`docs/SETTINGS.md` / `PLUGIN_API.md` /
  `ARCHITECTURE.md` / `TESTING.md` / `docs/ROADMAP_HISTORY.md` #48 同步。
  验证：
  `cdp_mode_query_verify` **47/47**（默认共享 / 面板开关实时 + 播种 / 行进入
  消耗 / 闲置重置清共享 / 重启注入与不落盘）；`cdp_idle_reset_verify`
  **48/48**（脚本钉住独立搜索词前提；共享重置由 #48 脚本覆盖）、
  `cdp_p2b_verify` **29/29**、`cdp_plugin_state_verify` **54/54**、
  `cdp_plugin_lru_verify` **22/22**、`cdp_mode_bar_icons_verify` **22/22**；
  `cargo test` 211 passed / 9 ignored、`cargo check` / `tsc --noEmit` /
  `pnpm run build` / debug exe 干净。

### Added

- **模式切换栏仅图标（ROADMAP #47）** — 设置 → 导航页新增「模式切换栏仅显示
  图标」`appearance.mode_switch_icons_only`（默认关，保持 图标 + 名称）。
  开启后模式胶囊只显示图标，`title`/`aria-label`（悬停 tooltip）保名；两种
  呈现胶囊高度一致（切换不跳行）；无图标模式回退
  `res/icons/unknow_universal.svg`。`docs/SETTINGS.md` / `ARCHITECTURE.md` /
  `UI_GUIDELINES.md` / `TESTING.md` / `docs/ROADMAP_HISTORY.md` #47
  同步。验证：
  `cdp_mode_bar_icons_verify` **22/22**（默认关 / 实时开关 / 真实设置面板
  保存并应用 / 重启首帧注入 / 无图标回退 / 点击与切换键交互），回归
  `cdp_plugin_mode_bar_verify` 15/15；`cargo test` 210 passed / 9 ignored、
  `cargo check` / `tsc --noEmit` / `pnpm run build` / debug exe 干净。

- **闲置重置（ROADMAP #46）** — 启动器隐藏超过阈值后的下一次呼出从干净状态
  开始：回导航页、清空搜索，并**完整重置**未豁免的插件页（查询 + 页面状态
  + 保活宿主 + 会话帧；下次进入冷启动）。默认**开 + 30 分钟**，设置 → 导航页
  可选 5/15/30/60/120/240；计时锚点是唯一隐藏收口 `window::hide_main`
  （blur / 热键 / Esc）广播的 `launcher-hidden`，比较**挂钟间隔**、无后台
  定时器（睡眠/休眠照常计时）。豁免双层：清单 `keep_session = true` 是默认，
  设置 → 插件 每个 mode 卡片可逐插件覆盖（用户值优先）；豁免只保状态、不保
  落地页，home 永不豁免、分离窗口不参与；仅会话内生效（重启恢复仍由
  `remember_last_page` 决定）。`docs/SETTINGS.md` / `PLUGIN_API.md`
  §3/§6C / `PLUGINS.md` / `ARCHITECTURE.md` / `TESTING.md` /
  `docs/ROADMAP_HISTORY.md` #46 同步。验证：`cdp_idle_reset_verify`
  **48/48**（阈值内不重置 /
  完整重置 / 清单与用户双向豁免 / 总开关关闭 / 恢复默认）；回归
  `cdp_plugin_state_verify` 54/54、`cdp_p2b_verify` 29/29、
  `cdp_plugin_window_verify` 16/16、`cdp_plugins_pane_verify` ALL PASS；
  `cargo test` 209 passed / 9 ignored、
  `cargo check` / `tsc --noEmit` / `pnpm run build` / debug exe 构建干净。

- **插件图标深/浅两套（ROADMAP #44）** — 插件可为交给宿主渲染的图标提供两套
  （清单 `icon_light`/`icon_dark`、`[[features]]` 同名字段、运行时行
  `icon: { light, dark }`），宿主按**图标所在表面**的生效主题选一套：启动器
  搜索结果行 / 模式 pill / 列表模板行 / 设置卡片跟随启动器（`system` 跟 OS
  实时），独立插件窗的任务栏 / Alt+Tab 图标跟随该插件的生效主题
  （`lume.theme.set` 覆盖优先）。主题运行中切换即时换图（新增响应式
  `themeMode()`，无需重跑搜索）；显式变体按原样渲染、不再叠加
  `--icon-filter` 反相，旧单图 `icon` 保持既有行为（含 pill / 列表行的
  反相约定）作为兼容回退。分离窗任务栏图标：detach 时把两套一起光栅化上传，
  Rust `PluginIconRecord` 按窗口生效主题取用（显式变体不反相，旧上传仍
  反相）。顺带修：`navBars` 相对路径图标按插件目录解析、list 模板行图标
  接入统一解析（此前完全不解析）。纯增量字段，不 bump `HOST_PLUGIN_API`。
  示例 `examples/plugins/themed-icons/`；`docs/PLUGIN_API.md` §3 / §5.1–5.2 /
  §6E.1 / §6E.5 / §6G / §11、`docs/PLUGINS.md`、`docs/ARCHITECTURE.md`、
  `docs/TESTING.md`、`docs/ROADMAP_HISTORY.md` #44 同步。验证：新
  `cdp_plugin_themed_icon_verify` **21/21**（浅→深即时换套、显式不过滤、
  legacy 仍 `invert(1)`、feature 行随主题、任务栏 ICON_BIG 像素按插件生效
  主题取原样变体）+ `--legacy` **6/6**（旧单图深色仍反相）；
  `cdp_plugin_theme_verify` 28/28、`cdp_p2b_verify` 29/29、`cdp_p2_verify`
  17/21（既有 4 项陈旧探针基线）；`cargo test` 206 passed / 9 ignored、
  `cargo check` / `tsc --noEmit` / `pnpm run build` / debug exe 构建干净。

- **`lume.env.form` 宿主形态常量（ROADMAP #42）** — 注入桥为每个插件帧钉死
  同步常量 `"launcher"`（启动器主窗口内嵌）/ `"window"`（独立窗口的 view /
  titlebar 帧），页面脚本运行前即可读；逻辑帧（§6I）恒为 `"launcher"`；
  `__lumeFrameState` 诊断上报同时带 `form`。这是「启动器内 / 独立窗口」的
  唯一可靠判别 —— #40 的 keep-alive 让启动器同时挂着多个已访问模式页，
  「父文档 iframe 数」必然误判（translator 因此丢分离按钮、提示变
  「Esc 关闭窗口」；ROADMAP #35 记录过旧手法）。`docs/PLUGIN_API.md`
  §6C/§6G.3/§6G.5/§10 同步；translator 1.4.0 改为优先读该常量（旧宿主
  回退帧间握手）。验证：`cdp_plugin_state_verify` **54/54**（新增 4 条
  form 断言：启动器 launcher / 窗口 view+titlebar window / 回流重挂载）。

### Fixed

- **#40 副效应：陈旧会话帧覆盖新 enter + LRU 一次溢出整批清栈（ROADMAP #42）**
  — ① 模式页被 LRU 淘汰后立刻用**新文本**重进时，ready 握手回放的旧快照
  （auto + custom，含结束前终校正）会覆盖刚投递的 enter 载荷（实测 `#src`
  从 `sp:new-lru` 回退成 `pre-lru`、custom 计数回填 7）—— 现在 `onEnter`
  直接作废该插件尚在等待重放的会话帧（淘汰 / detach / 关闭回流遗留），
  新进入优先，已消费的帧不受影响；② `runEvictionPass` 的同步循环看不见
  `evict()` 异步快照期间的 `entries.size` 下降，一次溢出把全部候选都标记
  淘汰（实测一次溢出 8 个挂载点掉到 3 个）—— 现在把在飞行中的淘汰计入
  预算并支持 `protect`，一次溢出只淘汰应淘汰的页数。验证：新增
  `scripts/cdp_plugin_lru_verify.mjs` **22/22**（脚本自造 7 个填充 mode +
  state-probe：淘汰数 = 1、victim 唯一且存了快照、新 enter 胜出、陈旧帧
  被 `drop-all` 且无 `take`）；回归 `cdp_plugin_state_verify` 54/54、
  `cdp_plugin_window_verify` 16/16、`cdp_p2b_verify` 24/24、
  `cdp_sandbox_verify` 14/14、`test/_snapshot_probe.mjs` 全过；实机
  translator 1.4.0 双形态：启动器内分离按钮在 + 「Esc 隐藏启动器」，
  独立窗口内按钮隐藏 + 「Esc 关闭窗口」、两帧 `form=window`。

### Added


- **插件会话续存 + 分离窗口状态同步泛化（ROADMAP #40）** — 同一会话内
  hide/show、模式切换与分离回流都保持上次页面、查询与页面状态（对标
  uTools/zTools 的 WebContentsView 保活）：已访问页面挂载后只隐藏不卸载
  （keep-alive 主机栈，LRU 8 + 淘汰快照），打开条目后仅首页清空查询；
  分离窗口成为单一权威（启动器不留活副本），用户关闭窗口后自动回流到
  该插件页并恢复状态。跨窗口快照升级为 v2：键控表单字段（含 multiple/
  checkbox/radio、open shadow root）、contenteditable、滚动容器与焦点，
  每字段只应用一次 + 仅迟到 DOM 重试/结束前一次受保护校正（修掉恢复循环回滚 3.2s 后正常
  `enter` 状态的实测坑）；titlebar 帧在标准重放前静默恢复（修掉标题栏
  输入回灌 `app.setQuery` 冲掉当前查询的实测坑）。`remember_last_page`
  升级为重启恢复模式+分类（不再退出清页）；查询/快照仍不落盘。验证：
  `scripts/cdp_plugin_state_verify.mjs`（新夹具 state-probe）**50/50**、
  `test/_snapshot_probe.mjs` 全过，`cdp_plugin_window_verify` 16/16、
  `cdp_plugin_theme_verify` 28/28、`cdp_sandbox_verify` 14/14、
  `cdp_p2b_verify` 24/24、`cdp_plugin_mode_bar_verify` 15/15、
  `cdp_plugin_verify` OK、`cdp_plugin_frame_load_verify` 5/5、
  `cargo test` 200、`tsc --noEmit` / `pnpm run build` 干净。

- **模式切换栏隐藏 + 导航结果行图标（ROADMAP #37）** — mode 插件可以声明
  `hidden = true`：不渲染模式 pill、Tab 循环也跳过（激活时从导航页
  重新开始），唯一入口是导航页搜索结果（关键字 / feature 行 /
  插件互跳）；设置 → 插件 卡片显示「仅搜索进入」徽标。同步统一导航
  结果行图标优先级：**行显式 `icon` → 插件清单 `icon`（默认）→ `path`
  常规图标管线** —— provider 结果的相对路径 `icon` 现在真的相对插件目录
  解析（此前只有 URI 生效，与文档不符），feature / 关键字行缺省时用
  插件自己的图标。示例 `examples/plugins/hidden-mode/`；`docs/PLUGIN_API.md`
  §3/§5.1–5.2/§5.7/§6B.1/§6E.1、`docs/PLUGINS.md`、`docs/ARCHITECTURE.md`、
  `docs/TESTING.md` 同步。验证：`scripts/cdp_plugin_mode_bar_verify.mjs`
  **15/15**（真机 debug exe：pill 缺席 / 两类结果行图标 / 点行进入 / Tab
  回导航 / provider 显式与默认图标），`cargo test` 202、
  `tsc --noEmit` 与 `pnpm run build` 干净，回归 `cdp_plugin_verify` OK、
  `cdp_clipboard_smoke` 正常。

- **插件自身颜色模式（`lume.theme.set`，ROADMAP #36）** — 插件可以把自己的
  明暗定成浅/深（`"system"` 仍跟随启动器），**独立窗口与启动器内嵌两种形态
  都生效，而启动器自身主题不动**。生效值覆盖该插件的全部表面：模式页画布
  （注入的 `--lume-page-bg`）、`theme` 事件载荷、独立窗口的 chrome/窗口底色/
  任务栏图标变体；值持久化在 `settings.plugins.color_modes`（静默轻写，不
  触发 `settings-applied`），所以重启与独立窗口首帧就是它。权限免声明
  （只改插件自己的表面）；`theme.get()` 回读 `{pref, mode, host}`。宿主侧
  新增 `themePrefs.ts` 镜像 + `plugin-color-mode` 跨窗口回传事件；Rust 侧
  `set_plugin_color_mode`（归属强制）+ 建窗/翻转时按插件生效模式取窗口底色
  与图标变体。`docs/PLUGIN_API.md` §6B.1/§6C/§6D.6/§6G.4/§10、`docs/PLUGINS.md`、
  `docs/ARCHITECTURE.md`、`docs/SETTINGS.md` 同步；示例 hello-mode 加了切换
  按钮（并在搜索框里认 `theme:dark|light|system`，便于脚本驱动）。

### Added

- **`app.detach` 桥接接口 + `detach_button` 清单开关（P6）** —
  `lume.app.detach()` 把调用方的模式页分离为独立窗口（快照/建窗/回放与内置
  悬停按钮同一条链路；已在独立窗口内调用则聚焦本窗口）。内置的「在独立窗口
  打开」悬停按钮**默认保持原样**（兼顾既有插件页面的空间预留）；插件自绘分
  离按钮（常驻、纯图标…）时可声明 `detach_button = false` 关掉内置按钮，右上
  角完全让给插件页面。权限免声明（基础动作，§6D.6）；`docs/PLUGIN_API.md`
  §3/§6C/§6D.6/§6G 同步。首个采用者：translator 1.1.1（标签栏右侧常驻图标
  按钮，不受悬停影响）。

### Fixed

- **主窗口位置不再被重置（ROADMAP #41）** — 「窗口位置」设置改为**只在本次
  运行窗口首次出现时**生效：此后每次呼出继承上次关闭时的位置，内容高度变化
  只维持原锚点（居中/角落的对称伸缩），用户手动拖过窗口后连锚点也不再套用
  ——修掉「拖走 → 关闭 → 下次呼出跳回预设」与「拖走后输入内容被拉回居中」
  两个实测重置。跟随鼠标仍是例外（每次呼出重新定位到光标）；显式改「窗口
  位置」保存时立即生效并重新接管，保存无关设置不再把拖走的窗口拉回。实现：
  `window.rs` 新增会话级 `PlacementState`（首次出现 / 程序化锚点 / 手动摆放
  sticky 标志 + 位置配置变更检测）；窗口完全离开所有显示器时回退预设一次。
  验证：新脚本 `scripts/cdp_window_position_verify.mjs`（真 HWND
  `MoveWindow` 模拟拖拽）**12/12**（修前同脚本 **3 FAIL**：apply_position
  拉回 / hide-show 重置 / 无关保存重置）；回归 `cdp_feature_smoke` ALL PASS、
  `cdp_settings_smoke` ALL PASS；`cargo test` **202**（新增 rect 相交 2 项）、
  `pnpm exec tsc --noEmit` 与 `pnpm run build` 干净。

- **插件回归脚本修复（ROADMAP #39）** — `cdp_p2b_verify` 的两条日志断言
  仍指向 P6.5 前的旧文案（`loaded provider (entry=` / `loaded mode
  (template=list, entry=`），改为现行的 `registered provider proxy (entry=`
  与 `registered mode proxy (template=list, entry=`；并让脚本自行幂等启用
  `files-img-demo` / `list-demo` 两个夹具（启用态是逐机设置，此前靠环境，
  禁用时整段连锁失败）。`cdp_plugins_pane_verify` 的开发者选项断言改用
  `.plg-card .settings-icon-btn:not(.plg-uninstall)` —— 常驻的卸载按钮与
  重载按钮共用类名，原选择器让「dev mode off 应 0 个重载按钮」恒红。
  验证：`cdp_p2b_verify` **24/24**、`cdp_plugins_pane_verify` **ALL PASS**。

- **插件宿主链路回归：`clipboard.readImage` 路由与逻辑帧 ctx 面（ROADMAP #38）** —
  两个「接口在、路没通」的既有问题（自 P6.5 逻辑宿主隔离起）：① 视图桥与
  逻辑帧的 ctx 都调 `clipboard.readImage`，`src/plugins/rpc.ts` 的 switch
  却缺 case，调用落到 `unknown lume rpc`；② 逻辑帧 ctx
  （`public/pluginLogicFrame.js`）缺 `fs` 组（12 方法）、`theme.set/get`
  与 `app.detach`，`ctx.fs.*` 为 undefined。修复后两个 ctx 面对齐为同一
  52 方法集合；`cdp_p2b_verify` 新增静态面一致性断言（逻辑帧 ctx ≡ 视图桥，
  且每个方法都有 rpc case）钉住这类漂移。验证：p2b 的 img `readImage` 与
  files `fs.readText` 两条功能性断言由 FAIL 转 PASS、面一致性 2/2
  （该脚本其余 2 项失败为陈旧日志断言，见 ROADMAP #39）；`tsc` 干净、
  debug exe 重建实测。

- **分离窗口的 `emit_to` 广播串台 + 关一个窗口连带关另一个（ROADMAP #36）** —
  Tauri 的 JS `listen()` 默认目标是 `EventTarget::Any`，而 `emit_to` 的过滤器
  只看**监听器**目标（每个 webview 都会被遍历），于是每个 `plugin-*` 窗口都
  收到了**所有**其它插件的 `plugin-state`/`plugin-window-*` 流量。此前载荷对
  所有插件相同（`theme` = 宿主模式），所以一直没暴露；本次载荷带上插件私有
  值后立刻显形：hello-mode 的独立窗口按 file-search 的 `themePref` 把自己刷成
  了浅色。修法：分离窗口里插件私有的三个监听显式带
  `{ target: getCurrentWindow().label }`（应用级的 `settings-applied` 保持全局）。
  顺带修掉一个更严重的既有隐患：两个独立窗口并存时，任一窗口的关闭请求会被
  另一个也收到，关一个连带关另一个。
  验证：`scripts/cdp_plugin_theme_verify.mjs` **28/28**（修前 ⑥/⑦ 全红）、
  `cdp_plugin_window_verify` **16/16** 无回归。
- **`cdp_sandbox_verify` ③h 断言去硬编码**——它断言 iframe 里的 Tab「切回导航页」，
  实际是**循环**切页，下一站取决于当前启用的插件集合：导航页后面排着磁盘 mode 时
  `.plugin-frame` 仍在，检查恒红（ROADMAP #32.11 已记为既有失败）。改成断言「激活
  模式变了」（契约本身），脚本 **14/14**。
- **独立窗口标题栏槽位拖动兜底（ROADMAP #35，P6.9）** — translator 等插件的
  独立窗口只有「翻译」标题文字处能拖动：chrome 行中段整块被 titlebar 槽
  iframe 占满，插件把槽位当宿主形态判别器（纯空白页、无 JS），而老契约
  「空白区由插件自己调 `app.dragWindow()`」没人履行，中段成死区。宿主侧
  兜底：向标题栏页注入默认拖动助手（非交互元素的按下自动 `app.dragWindow`，
  交互元素/文字选择豁免，`data-lume-drag="off"` 可整页退出）；插件自带的
  拖动处理照常工作，同一手势的重复调用被宿主 300ms 去重门合并——tao 的
  `drag_window` 异步投递 `HTCAPTION`，两次 `start_dragging` 会让窗口在松手
  后吸住鼠标。装饰性槽页插件**无需任何改动**即整条标题栏可拖。
  验证：重建 exe 后 `cdp_plugin_window_verify.mjs` **16/16**（新增 ⑥ 槽页
  注入断言三项目）；实机真实拖拽探针 **8/8**（translator 死区与 file-search
  双触发路径：窗口随拖移动、松手不吸鼠标、去重后 `__dragStarts` 均为 1）。

### Changed

- **版本号与二进制图标（Pre-26.10 发布准备）** — 内部 semver `3.0.0` → `2.8.0`
  （package.json / tauri.conf.json / Cargo.toml / Cargo.lock），对外标签
  `Pre-26.9` → `Pre-26.10`（`APP_VERSION_LABEL`，About 页展示）；静态 exe
  图标（Explorer / 安装器场景）改用 `res/icons/application.png` 经
  `tauri icon` 重新生成（浅底黑鸽 artwork，运行期任务栏/托盘的主题图标对
  不变）。

- **发布前文档同步（Pre-26.10）** — README 状态/功能/打包命令更新到插件平台、
  全盘文件搜索与提权代理；`RULES` / `NORMS` / `ARCHITECTURE` / `SETTINGS` /
  `TESTING` 按当前三二进制、插件权限与构建/验收流程校正；
  `docs/ROADMAP_HISTORY.md` 标记 #6、#7、#8、#10.4 的后续落地，并加入
  2026-10-12 当前快照；`PLUGIN_API` 修正
  权限与沙箱层数措辞；`PLUGIN_GAP_ANALYSIS` 明确归档为 P0 前历史分析。

- **`.lupx` 覆盖安装按版本关系措辞（ROADMAP #28.1）** — 原实现遇到同 id 已装
  插件不看版本号，确认卡永远显示「将覆盖 vX → vY」。现在 Rust 侧对包内/已装
  版本做 semver-ish 比较（点分段数字序、缺段补 0、release 高于 prerelease；
  manifest version 是自由字符串，排序尽力而为、永不用于拒绝），
  `plugin_lupx_inspect` 结果新增 `relation`（`fresh`/`upgrade`/`reinstall`/
  `downgrade`），确认卡相应显示「升级 / 同版本重装 / 降级（黄字提示）」；
  **降级仍允许安装**——回滚旧包是正当操作，只提示不拦。三语键同步
  （`pluginsInstallOverwrite` → `pluginsInstallUpgrade` / `…Reinstall` /
  `…Downgrade`）。
  验证：cargo test **210**（+3：版本排序十条断言、fresh→upgrade→reinstall→
  downgrade 全序 + install_into 预换位取值、私有 files 保留——见下条）；
  tsc / vite build 干净；重建 exe 后 `cdp_lupx_verify.mjs` **24 项全过**
  （relation fresh/upgrade/reinstall 三态实机 + 私有 files 升级保留）。

### Added

- **独立窗任务栏图标与身份（P6.8，ROADMAP #34）** — 分离出的插件窗口在任务栏
  用**插件自己的图标**，并以独立身份成项，不再显示启动器图标/与 Lume 窗口
  合并：
  - **每窗图标**：分离时启动器在 webview 里把 manifest `icon`（多为 SVG）光栅
    化成 256×256 PNG（Rust 侧 `image` 只有 PNG 特性、无 SVG 解码器），随
    `plugin_window_open` 上传；Rust 复用 appicon 的 RGBA→HICON 路径，在
    `show()` 之前设好 ICON_BIG/ICON_SMALL —— 任务栏按钮与 Alt+Tab 都是插件
    图标。深色主题按 `--icon-filter` 约定反相（与 pill 内图标一致），主题
    切换时已开窗口自动重绘；重开/焦点路径复用已存位图。无 `icon` 或光栅化
    失败 → 回退 Lume 主题图标（静默，只记日志）。
  - **独立任务栏项**：每个插件窗写独立 AppUserModelID `Lume.Plugin.<id>`
    （`SHGetPropertyStoreForWindow` + `PKEY_AppUserModel_ID`，Electron
    `setAppDetails` 等价、Tauri 无此 API；windows crate 补 3 个 feature，
    无新依赖）。实测默认「始终合并」下与启动器/设置窗各占一个任务栏按钮、
    可单独钉住；写入必须发生在创窗线程（主线程，`run_on_main_thread`），
    工作线程的 store 写 S_OK 但不生效。
  - 验证：`scripts/cdp_plugin_icon_verify.mjs` **8/8**（真实分离流程的图标
    上传：插件窗 ICON_BIG ≠ 启动器图标；UIA 任务栏按钮
    `Appid: Lume.Plugin.file-search`；无 icon 的插件回退 Lume 图标且仍独立
    成项）；实机截图复验「仅插件窗」「与设置窗同屏两个独立按钮」
    「light↔dark 主题翻转重绘」；`cdp_plugin_blank_verify` **0/12**、
    `cdp_plugin_window_verify` **12/12** 无回归。

- **插件系统加固（ROADMAP #32，P6.6）** — 契约/安全/健壮性/DX 四组十项：
  - **宿主 API 版本契约**：清单新增 `api`（缺省 = 宿主版本）；声明高于
    `HOST_PLUGIN_API`（=1）→ 加载期明确拒绝 + toast，逻辑宿主二次校验
    （PLUGIN_API §11）。
  - **`.lupx` ed25519 签名**：包内 `LUME.SIGN` 覆盖清单 + 全部文件哈希；
    验签信任根 = 内置发行公钥 + `<base>/settings/trust-keys/*.pub`；无效签名
    inspect/install 硬拒，未签名包维持确认流 + 展示 SHA-256；签名 CLI 与宿主
    同源（`lume --gen-key` / `lume --sign-lupx <pkg> --key <file>`）。
  - **网络内网防护**：`network` 能力的插件请求默认拒绝回环/私网/链路本地/
    CGNAT 目标（防 SSRF，云元数据在内），清单 `network_allow`（精确或
    `*.` 通配）放行自建服务；重定向改手动逐跳（≤5），302 跳内网同样被拒。
  - **插件熔断**：连续 3 次 hook 失败（超时 / 推送失败 / ok:false）→ 标记
    离线 + toast，此后调用快速失败、load 不重发（共享逻辑宿主下单插件不再
    拖累同窗他人）；重载 / 保存设置复位；supervisor 侧 hook 6s 兜底回执 +
    load 15s 兜底，帧卡死不再泄漏 `entry.calls`。
  - **onQuery/onSubInput 跨进程节流**：宿主侧 120ms trailing 合并（打得再快
    也只在窗口边界发一次，插件收到的最新输入语义不变）。
  - **plugins 目录 dev 监听**：开发者模式下编辑插件代码保存即自动热重载
    （`plugin_devwatch.rs`，内核事件零轮询 + 800ms 静默窗）。
  - **`plugin-api.d.ts` 类型面**：examples 全局类型（ctx/app/http/clipboard/
    db/settings/fs/on + LumeProviderLogic），list-demo 示范 `@ts-check`，
    `pnpm exec tsc -p examples/tsconfig.json` 校验。
  - **blob 模块 sourceURL**：DevTools 按真实文件名显示插件模块（此前是匿名
    hash）；UA 字符串跟随包版本；快照超限降级写入 plog.warn（不再静默）。

### Fixed

- **`.lupx` 升级不再清空插件私有 `files/`（ROADMAP #28.1）** — 私有目录
  `<plugins>/<id>/files/` 在插件目录里、由 fs API 运行期写入，原换位流程把
  旧目录整体 rename 备份后删除，升级即丢数据。现在新安装就位后、删备份前，
  旧 `files/` 移入新目录（目录名常量 `plugin_fs::PRIVATE_FILES_DIRNAME`
  单一来源；旧目录无 `files/` 跳过；双方都有则逐项合并、**旧数据赢**同路径
  冲突——包内随包 `files/` 对运行过的插件是陈旧种子）。尽力而为：恢复失败
  时旧安装改名 `<id>-files-recovery-<pid>` 留在 `plugins/`（无 plugin.toml，
  扫描不可见）+ 日志报路径，备份在数据安全前不删；已成功的安装不因数据恢复
  失败改口失败。
  验证：`upgrade_keeps_the_previous_private_files`（旧数据赢冲突 + 包内
  files 落地 + 嵌套目录存活 + staging 清空）；
  `failed_swap_restores_the_previous_installation` 回归不破；实机
  `cdp_lupx_verify.mjs` 升级前写 `plugins/lupx-demo/files/upgrade-keep.txt`、
  v1→v2 换位后内容原样。
- **纯视图 mode 被误熔断：「文件秒搜」连续调用失败（不进插件页也弹，ROADMAP
  #32.12）** — 无 `entry` 的 mode（file-search 等）实例在 `setQuery`/`search`/
  `onSubInput` 里无条件把 onQuery/onSubInput 转发进逻辑中继，而宿主里没有它的
  逻辑帧：`clearSearch` 每次呼出/隐藏都对全部 mode 广播 `setQuery("")`，
  supervisor 对未加载 id 静默丢弃（无令牌、无法回执）→ registry 等满 8s 记
  `timeout: onQuery`，**3 轮呼出即熔断 + toast，插件从未被打开**（实测
  file-search/http-probe/sandbox-probe/translator 四个纯视图 mode 全中；带
  entry 的插件不受影响）。修复两层：`createDiskModeInstance` 以 `hasLogic`
  门控三处 `throttledLogicCall`（视图页状态本就走 iframe 桥）；`logicCall`
  对从未申请逻辑帧（`!logicLoadedIds.has(id)`）的调用按 "logic not loaded"
  快速失败、不计熔断。
  验证：新增 `scripts/cdp_circuit_verify.mjs`（3 轮呼出/隐藏 + `__logicCircuit`
  探针 + supervisor 侧 entry 路径正面探针）：修复版熔断全空、无 toast、
  hello-mode hook 派发 9 次 0 挂起；stash 修复的旧二进制同序列复现 4 个纯视图
  mode 全部熔断。
- **视图桥把 http.request 的成功结果降级为假失败（第三方 translator 全引擎
  报错的根因，ROADMAP #32.11）** — mode 页（沙箱 iframe）的 RPC 回执由视图桥
  直发 `postMessage`，而 `http.request` 的成功结果带 `text()`/`json()` 函数
  （不可结构化克隆）→ `DataCloneError: ()=>f(r.body??"")` 被宿主 catch 成
  `ok:false`：**请求成功也报错**，用网络的 mode 插件（翻译/图片翻译/朗读）
  全灭。P6.5 只给逻辑宿主（`pluginLogic.tsx`）补了「不可克隆 → 剥离函数重发」，
  §9 文档声称已修但视图桥漏网。修复：视图桥回执与逻辑宿主同款 try →
  `jsonSafe`（JSON 往返剥函数，帧侧桥按 §6D.1 契约重建助手）→ 重发，仍失败
  才回执错误；`createIframeView` 同时服务 mode 页与独立插件窗，一处修复两处
  生效。同修：视图桥看门狗 10s 死限短于 `http.request` 自己的 `timeoutMs`
  （契约 1–60s）→ 大于 10s 的合法慢请求被提前判超时、迟到的真回复落空；改按
  请求 `timeoutMs`（钳 1–60s）+5s，其余方法维持 10s。
  验证：translator 实测进页自动翻译出结果（谷歌在本机不可达、按插件声明的
  20s 预算判失败后回退，腾讯交互 ~1s 出译文，DataCloneError 0 次）；新增
  **离线**回归 `scripts/cdp_http_probe_verify.mjs` + `scripts/fixtures/
  http-probe/`（本地 echo 服务，不碰外网）：修复版 **11/11**，stash 修复的
  旧二进制 **1/11**（首条请求即复现同一 DataCloneError）；
  `cdp_plugin_verify`、`cdp_plugin_frame_load_verify` **5/5** 无回归。
- **独立窗口偶发全白（P6.7，ROADMAP #33）** — release 构建下打开插件独立窗口
  会有约 1/3–5/6 的概率整页空白（只剩宿主 chrome，视图帧什么都没有）。根因
  不在插件侧：`createIframeView` 挂载 iframe 时把信号初值 `""` 写进了
  `srcdoc` → 帧先按**空 srcdoc** 导航一次（含一次 renderer 进程交换），真实
  页面几百毫秒后到达又要再导航一次；独立窗口有**两个**这样的沙箱帧（视图 +
  titlebar 槽位），两次进程交换挤在几十毫秒内时 WebView2 会**丢掉后一个导航**
  ——帧永久停在空文档上（CDP 实测：失败帧的 `document` 是 39 字节的空
  srcdoc 文档，浏览器侧只有 `frameRequestedNavigation` 没有 `frameNavigated`）。
  逻辑宿主帧用 `src` 在插入前赋值（单次导航）从不失败，反证了这一点。修复
  两半：①**预防**——HTML 未就绪前不导航帧（`srcdoc={undefined}` 走 Solid 的
  `removeAttribute` 分支，帧停在 about:blank），每个帧只做一次导航；②**兜底**
  ——桥在最开头上报 `__lumeFrameBoot`，宿主侧 boot 看门狗（700/1500/2800ms）
  发现帧没起来就重新触发导航（remove+set，实测可靠的恢复手段），三次仍失败
  才 plog.error 放弃。两条路径都有专项实机验证。
- **P6.5 逻辑隔离回归修复（CDP probe 挖出）** — 逻辑宿主下 `hostApi` 有 28 处
  裸 `invoke` 漏注入 host token，clipboard/http/dialog/screen/fs 等能力调用被
  Rust fail-closed 拒绝；`plugin_net` 的内网防护按**原始参数**判插件身份，而
  逻辑宿主调用只带令牌 → 防护对 entry 插件完全失效；帧侧与视图桥的 rpc 把
  失败吞成 `resolve(undefined)`（权限/网络拒绝不可感知、`res.status` 抛
  TypeError），http 成功结果因携带 `text()`/`json()` 函数跨 postMessage 触发
  DataCloneError 被降级成假失败——均已修复（内网防护对逻辑宿主插件实测生效、
  白名单放行往返 status-200）。
- **dev/embedded 构建语义**（#16 遗留）— `custom-protocol` 从 tauri 依赖移入
  `[features]`（模板惯例）：`tauri build` 自动启用（内嵌前端），`tauri dev` /
  `cargo run` 走 devUrl——此前任何构建都强制 embedded，改前端必须手工
  `pnpm build` + `cargo build` 才生效。
- **快照可观测性** — 独立窗口**无快照**关闭（query 清空路径）原先在 tap 前
  提前 return，回归验证看不到该事件；桥新增 `__lumeFrameState` 上报
  （`__frameStates`），srcdoc 帧 DOM 在 CDP 不可见的 runtime 下仍可观测。
- **重载竞态误熔断** — 重载窗口内 navBars/onSettings 拉取可能被投给正在
  销毁的旧帧（无回执 → 8s 超时）而把正常注册流程误判为插件故障：registry
  新增 `logicPendingReady`（未就绪/重载期的 hook 快速失败、不计熔断），
  `pushLogicLoad` 提前到注册前，`unload` push 改 await，supervisor 补发
  `logic-loaded`（P6.5 的接线缺口：registry 有 case、从未有人发）。

### 验证

独立窗口空白页回归（P6.7）：`scripts/cdp_plugin_blank_verify.mjs`（新建/销毁
独立窗口 N 次，逐次断言视图帧桥接就绪）修复前 file-search **10/12 空白**、
修复后连跑 **0/58**（14+20+12+12）且 hello-mode **0/10**；
`scripts/cdp_plugin_frame_load_verify.mjs --mode=empty` **4/4**（记录到的
srcdoc 写入恰好两条非空——每帧一次导航，零次空写入）、`--mode=dropfirst`
**4/4**（人为吞掉首次大写入后，看门狗按预期重导航把页面救回来：写入序列
`[25638, 2269338, 2269338]`）；`cdp_plugin_window_verify` **12/12**、
`cdp_sandbox_verify` **14/14**；`cdp_p3_verify` **36/9** 与修复前基线逐项
一致（这 9 项在本机为既有失败：设置窗插件面板渲染 + notes 导出动作 + 日志
tap，与本次改动无关）。

cargo test **198**；`test/_harden_probe.mjs` **8/8**（api 契约拒绝 / 私网拒绝 /
白名单放行 / 熔断开+快速失败）、`test/_logic_host_probe.mjs` **12/12**、
`test/_snapshot_probe.mjs` **16/16**（含清空 query 关闭的回归路径）；dev 监听
实测 V1→V2 自动生效；`.lupx` 签名链 `test/_sign_probe.mjs` 5/5（未信任拒绝 /
信任验签 / 篡改拒绝 / 未签名展示哈希）。

- **插件逻辑进程级隔离（P6.5 第二阶段）** — entry 插件的逻辑移出启动器
  主窗口：共享隐藏窗口 `plugin-logic-host` 每插件一个 opaque-origin 沙箱
  iframe（WebView2 站点隔离 → 独立 renderer 进程，插件死循环不再波及他人），
  registry 贡献全部代理化（hook = 跨窗口 RPC）。归属强制：supervisor 签发
  一次性令牌（不进帧），Rust `resolve_plugin_caller` 按 label+令牌解析有效
  plugin id——逻辑宿主无令牌/假令牌一律拒绝，`plugin-<id>` 视图窗强制
  label 归属，策略命令（启停/信任/安装）拒绝一切 plugin-* 窗口；db/storage/
  fs 等数据落点全部改用解析后 id。生命周期：supervisor 就绪通告重发 load
  （建窗竞态）、崩溃自动重建（10s 冷却）、声明式设置就绪后补投。
  性能实测（调试机）：宿主窗口创建 ~110ms、空闲 CPU ≈0、每插件约一个独立
  renderer 进程（空闲 `MemoryUsageTargetLevel=Low` 修剪）。端到端
  `test/_logic_host_probe.mjs` 12 项全过（四类裸 invoke 拒绝 / provider
  搜索往返 / ctx.db 令牌链路 / 设置恢复）；cargo test 185 全过。

- **插件独立窗口双向状态快照/恢复（P6.5）** — 分离为独立窗口不再是「全新文档」：
  detach 时启动器先经桥接新通道 `__lumeCall{type:"snapshot"}`（1.5s 超时兜底）
  向页面要状态快照，随 ready 握手推送带进独立窗口，标准回放之后以 `restore`
  事件落地；关闭窗口（×/Esc/Alt+F4）时 Rust 拦截一次 `CloseRequested`，页面
  快照后经新命令 `plugin_window_close_report` 上报销毁（3s 看门狗兜底插件
  卡死），快照与最终 query 回到启动器——iframe 仍挂载则直投恢复，已卸载则
  下次进入本模式时经 ready 握手恢复（消费即删）。快照分两层：桥自动捕获的
  `auto` 层（表单控件值 + 滚动位置，恢复时自动回放并补发 input 事件）与
  页面可选的 `custom` 层（`lume.on.snapshot` / `lume.on.restore`，PLUGIN_API
  §6C）；1MB 上限、仅内存不落盘。端到端脚本 `test/_snapshot_probe.mjs`
  （12 项断言：两条继承/恢复路径 + query 连续性）。

- **页面加载门控 + 加载反馈** — 切到剪贴板/插件页时「未加载完不显示」：窗口
  收拢成搜索行、`.results` 隐藏，该页 pill 变强调色（`#5ac8fa`）且图标上转圈
  （`ModeInstance.ready` 新契约成员：磁盘 view 页以页面桥接 `__lumeReady` 为准
  ——挂载/换文档即复位，另有 3s 宽限兜底；模板页与剪贴板页以首次取数落定为准；
  导航首页永远就绪）。同一信号也驱动高度模型：就绪后窗口才展开到页面高度。

### Fixed

- **导航页空态 = 搜索行** — 无栏目时不再预留 56px 的「空态提示位」，
  `MIN_WINDOW_H` 90 → 60（搜索行高度）；「无结果」提示改为自带内衬的
  `.page-hint` 行，fit 窗口收缩到 搜索行 + 该行（实测 107px），不再在大片
  空页面里居中显示。
- **剪贴板首载期间整个启动器 IPC 卡死** — Tauri 的**同步命令跑在主线程**：
  debug 下 172 行首载（~4s）期间所有其它 IPC（窗口 resize、按键取数……）都在
  排队——探针实测一个琐碎 IPC 耗时 **3895ms**，加载门控的窗口收拢因此从不
  落地。`search_clipboard` 改 `async`，`get_file_thumb` / `get_file_bytes`
  改 async + `spawn_blocking`（与既有 `get_video_thumb`/`get_app_icons` 同法）；
  同一测量降到 **3ms**。
- **主窗口「四角亮弧 + 1px hairline」—— 面板改不透明 `--surface`** — 用户观感
  反馈，对实机截图做 RLE 像素制图定位出三层：① `.launcher` 的 1px `--border`
  hairline 沿 12px CSS 圆角描出一圈亮弧（四角实测 61,61,61），直边的 1px 亮线
  也是它；② CSS 圆角(12px) 大于 DWM 圆角（约 8 DIP），弧外一截未覆盖区域露出
  Acrylic 新月带（36→55 渐变，随壁纸漂移）；③ 半透明面板合成色（该用户桌面处
  38,38,40）与页面画布 / 边框条实体色（30,30,32）差 8 级。现 `.launcher` 填
  **不透明 `var(--surface)`**（与 DWM 边框条涂色、插件页画布默认值是同一个
  值），去掉 border / border-radius / box-shadow，主窗口 Acrylic 效果撤除
  （对不透明面板不可见，且其半透明合成永远无法被不透明边框条复刻——环带的
  根源）；`.detach-btn` 填充 `--surface` → `--surface-raised`（面板同色后需
  抬升面才可见）。圆角保持由 DWM 完成（圆角变体矩阵实测：≤7px 与无圆角等同、
  ≥8px 反而新增未覆盖像素）。验证：暗色四缘 / 四角 / 拼接缝全 30,30,32、浅色
  251,251,253；cargo test 185、`_seam_probe` 10、`_shell_nav_check` 10、
  `cdp_p2b_verify` 22 全过。
- **窗口外缘「几像素灰色边框」** — 上一轮拼接缝修好后的残留环带，三层叠加
  （DwmGetWindowAttribute + 屏幕级像素采样实证）：① DWM 给 shadow(true) +
  无边框窗口画的可见帧边框条（`DWMWA_VISIBLE_FRAME_BORDER_THICKNESS` = 2px，
  默认浅灰，压在被自绘的客户区之上——设置/预览/分离窗口早先已用
  `clear_dwm_border`（COLOR_NONE）压掉，主窗口漏了）；② 该边框条被清成 NONE 后
  露出 Acrylic 背景（亮桌面下比面板亮 ~25 级）——主窗口是唯一 透明+Acrylic 的
  窗口，所以改为把边框条**画成主题实体面板色**
  （`window::set_panel_frame_border`，`DWMWA_BORDER_COLOR` = `--surface`，
  `颜色模式` 变化与系统主题翻转事件里重画）；③ `#root` 的 1px 透明内衬
  （原设计让 Acrylic 在圆角处发光）在高 DPI 下同样读作亮环，去掉
  （面板直贴客户区，圆角处仍透亚克力），`WINDOW_PAD` 8 → 6 同步。修复后仅剩
  面板自身的 1px hairline（设计内描边）。
- **主窗口「拼接缝」四缘露框 + 插件页比面板黑一截** — 用户观感反馈（页面
  边缘与搜索框连接不完美，上下左右都有边框），两处叠加：① 几何——搜索行的
  `border-bottom` + `.results` 的 6px 内衬把每个页面包成内缩的卡片，四缘露出
  面板底色；现搜索行无下边框、`.results` 无内衬，页面直贴搜索行底边与窗口
  左/右/下边，内衬改由各页自给（`.result-grid` 8 / 栏网格 10 / `.plugin-list`
  10 / `.clip-list` `0 6px 4px`），`WINDOW_PAD` 20 → 8 同步；磁盘插件页
  iframe 由 `100vh - 60px` 改 flex 填充（搜索行高度与常数不吻合时溢出错位）。
  ② 画布——`color-scheme: dark` + 透明根背景的插件页被 Chromium 画成**不透明
  #121212 画布**（与面板差 ≈20 级色阶），且宿主元素背景对 sandbox iframe 不可
  见（`.plugin-frame` 上写 background 无效）；现由 `injectBridge` 给每个插件页
  注入 `html{background:var(--lume-page-bg,<主题 --surface>)}` 并由桥接随
  `theme` 事件切换，插件自绘 html/body 背景仍覆盖默认（`iframeBridge.tsx`、
  `theme.ts`、`App.css`、`launcher/types.ts`）。
- **分离窗口「白描边」与「纯黑」背景** — 两个渲染层问题叠加（用户观感反馈，
  CDP 像素级实证）：① Chromium 给无 `border:none` 的 iframe 画 UA 默认
  `border: 2px inset`（左深右浅的凹陷框，DPI 缩放下呈 2–3px 亮线）——
  启动器侧 `.plugin-frame` 一直有 `border: none`，`pluginWindow.css` 漏了，
  视图 iframe 与标题栏槽位 iframe 都中招，补 `.plugin-window-root iframe
  { border: none }`；② 沙箱插件页是跨进程（OOPIF）frame，透明像素合成
  WebView2 自己的暗色画布（#121212）而非宿主页背景，插件页现已自涂不透明
  surface（插件侧 2.7.1），宿主给分离窗口设 `background_color(#1e1e20)`
  画布兜底，并新增 `window::clear_dwm_border`（`DWMWA_BORDER_COLOR =
  DWMWA_COLOR_NONE`）压掉 shadow(true) 无边框窗口文档记载的 1px 系统白边
  ——阴影与 Win11 圆角保留，插件/设置/预览三个窗口统一应用
  （`plugin_window.rs`、`lib.rs`、`window.rs`、`pluginWindow.css`）。
- **标题栏槽位消息通道失活** — `slot={titlebarHtml() ? <slotView.View /> :
  undefined}` 把槽位组件写进反应式 prop getter：`titlebarHtml`/
  `pluginName` 变化时 Solid 重新调用组件、重建 iframe，已接线的实例（消息
  监听器 + frame 引用）与 DOM 中存活的 iframe 被拆散——槽位的 RPC 与事件
  整体失灵，`titlebar` 槽位页收不到任何状态、其 RPC 也到不了宿主
  （`titlebar-demo` 同样受影响）。现改为 App 作用域只创建一次槽位元素，
  可见性交给响应式 classList（无 titlebar 页的插件保持空槽 + 拖动区）。

### Added

- **分离窗口权限/主题补全 + `fs.bytes` 字节桥接（2026-09-25）** — 三项跟进，
  补齐 P5/P6 落地后插件生态实际会遇到的三处缺口：
  ① **分离窗口权限台账接线**（修复）：`setPermissionSource` 原本只在启动器
  窗口的 registry 里调用，独立窗口没有 registry——所有需要权限的能力
  （`search.files`/`fs.read`/`clipboard`/`trash`）在分离窗口里一律被拒为
  「unknown plugin」。`pluginWindow.tsx` 现在在加载视图前经 `get_plugins`
  接线，settings-applied 时随主题一起刷新；
  ② **`fs.bytes(path)` 桥接**（新 `fs.read` 能力）：P5 沙箱让 mode 页成为
  opaque origin，`fetch(asset://)` 被 CORS 拒绝——pdf.js/SheetJS 这类要在
  JS 里解二进制的预览渲染器失去字节通道；`bytes` 返回 base64 原始字节
  （≤ 32 MB，Rust 侧 `get_file_bytes`），图片/音视频走 `<img>`/`<video>`
  标签不受影响；
  ③ **`lume.on.theme` 颜色模式推送**：沙箱后插件页读不到宿主文档，registry
  监听 `data-theme` 变更，向模式页 post、向分离窗口经
  `plugin_window_push_state` 携带/推送 `theme`，就绪握手一并重放——插件
  深浅色跟随启动器的权威来源（§6C 事件表、§6G.4）。
- **mode 插件页独立窗口（P6）** — mode 插件可在清单声明 `detachable = true`，
  激活该模式时页面右上角悬停出现「在独立窗口打开」按钮：点击后启动器隐藏、
  插件页面在自己的窗口里打开（窗口标题 = 插件名，默认尺寸取清单 `height`，
  关闭时记忆几何、下次分离原位恢复）。窗口内是**同一个沙箱桥接 iframe**
  （`plugin.html` 第三个 Vite 入口），`window.lume` 契约不变，仅宿主语义随
  窗口调整（`app.hide` = 隐藏窗口、`app.resize` = 改窗口尺寸、toast 窗口内
  浮动、`setQuery`/子输入框不可用、`redirect` 经 Rust 事件转回启动器路由、
  未消费 Esc 关闭窗口）。再次激活已分离的模式（pill/Tab/关键字/redirect）
  = 聚焦其窗口；禁用/重载插件自动关窗。插件**逻辑钩子**始终留在启动器窗口，
  页面状态经 `plugin_window_push_state` → `plugin-state` 事件跨窗口推送
  （就绪握手对齐桥内 `__lumeReady` 重放）。窗口为**运行时创建**（`plugin-<id>`
  标签，lume 首例，按插件复用）；新能力文件 `capabilities/plugin-windows.json`
  （glob `plugin-*`）。示例 hello-mode 已声明 `detachable`；实机脚本
  `scripts/cdp_plugin_window_verify.mjs`
  （`src-tauri/src/plugin_window.rs`、`src-tauri/src/plugins.rs`、
  `src/plugin.html`、`src/pluginWindow.tsx`、`src/plugins/{registry,rpc,types}.ts`、
  `src/App.tsx`）。
- **插件沙箱机制（P5）** — mode 页 iframe 从同源 srcdoc 升级为 **opaque-origin
  沙箱**（`sandbox="allow-scripts allow-forms allow-popups allow-modals"`，
  无 allow-same-origin）：插件页够不到宿主文档与 `parent.__TAURI_INTERNALS__`、
  不能导航顶层窗口（原 §9 承认的同源绕过关死）。按键/焦点转发移入桥接脚本
  （postMessage 协议 + 消费回执迟滞 preventDefault），Esc「页面 preventDefault
  即消费」契约不变；页内 `localStorage` 不可用（用 `ctx.storage`/`db`）、页内
  `fetch` 受 CORS 限制（用 `lume.http.request`）。同时新增 **Rust 命令侧权限
  白名单** `plugin_perm.rs`：每个宿主能力命令（notify/clipboard/http/dialog/
  screen/search.files/fs.write/trash）按调用方 plugin_id 对照清单
  `permissions` 再校验一次（fail-closed，缓存随 `get_plugins`/`reload_plugin`
  刷新；`file_search`/`trash_to_recycle` 的原生路径 = main 窗口且不带 id）。
  权限层从「前端知情同意」升级为「前端 + 命令侧双层防线」；7 项 Rust 单测 +
  `scripts/cdp_sandbox_verify.mjs` 14 项实机验证（探针插件在沙箱内自检）
  （`src-tauri/src/plugin_perm.rs`、`src/plugins/{iframeBridge,permissions,
  hostApi}.ts`）。
- **全局开发者模式（`plugins.dev_mode`）** — 设置 → 插件工具栏最右新增「开发者
  模式」开关（默认关；轻量写 `set_plugin_dev_mode` + `settings-applied`，初值
  经 `get_settings` 读取）。关闭时隐藏全部开发者选项（卡片上的重载按钮、「开发」
  徽章与「全部授权」开关），且后端 `get_plugins` 以空表调 `list_plugins`、把
  所有插件上报 `trusted=false`——前端权限层无需改动即 fail-closed 到声明能力，
  残留 trusted id 不授予任何能力；开启时显示并生效，随后重读插件清单。i18n
  新增 `pluginsDevMode{,Hint,On,Off}` ×3 语言。验证：`cargo test` 含
  `plugin_dev_mode_defaults_off_and_round_trips`（整表缺失 / 缺键均默认关 +
  轻量写往返）；`cdp_plugins_pane_verify` 新增开发者选项显隐断言（关 = 无重载
  按钮 / 无开发徽章，开 = 重载按钮回归）。
- **提权注入代理（Elevation agent）** — 新增第三个二进制 `lume-agent.exe`：一个
  极小的**高完整性**助手，唯一能力是「向指定前台窗口发送一次配置好的组合键」。
  解决的是自动动作对**以管理员权限运行的目标程序**永远不生效——根因是 UIPI
  （`SendInput` 只投递给同级或更低完整性级别的窗口，且失败无法从返回值读出），
  而完整性级别是**进程级**属性，所以只能拆进程：主进程保持中 IL，特权代码只在
  这个助手里。启动方式为预先注册的计划任务 `Lume\LumeAgent`
  （`RunLevel=HighestAvailable`，注册时一次 UAC，之后 `schtasks /Run` 静默拉起；
  XML 定义以保证 `ExecutionTimeLimit=PT0S`（否则 72 小时杀常驻）与
  `MultipleInstancesPolicy=IgnoreNew`），空闲 60s 自动退出，除非客户端请求常驻。
  **安全边界**：`\\.\pipe\LumeAgent` 的 DACL 只授予**安装者本人的 SID** + SYSTEM
  （刻意不用 `AU`，否则同机任何用户的进程都能驱动一个高 IL 按键注入器；SID 取不到
  即拒绝服务），并要求同会话、客户端镜像是同目录的 `lume.exe`、目标窗口必须当前
  前台且属主 pid 匹配；不接受任意命令、不启动进程、不写文件。新增设置「使用提权
  代理」（默认开）与「登录后常驻代理」（默认关），系统页新增「提权代理」组
  （状态 + 注册/卸载，UAC 取消有提示，状态查询不会拉起代理）。「测试」按钮同样
  优先经代理执行——设置窗自身不是提权的，否则永远无法验证提权目标。
  Rust 侧新模块 `agent.rs`（协议/管道服务端/客户端/任务注册）、`input.rs`
  （合成按键与窗口/进程探针，两条注入路径共用）、`pipe.rs`（管道客户端从 `svc.rs`
  抽出泛化）；**未新增任何 crate 或 `windows` feature**
  （`src-tauri/src/{agent,input,pipe}.rs`, `src-tauri/src/bin/lume-agent.rs`）。
- i18n 新增 23 键 × 3 语言（`autoUseAgent{,Hint}`、`autoAgentResident{,Hint}`、
  `autoTest{NeedsAgent,AgentUnavailable,Blocked,FocusMoved}`、`settingsAgent*`），
  三语言键集一致（253 键）。

### Changed

- **逐插件「全部授权」并入全局开发者选项（`plugins.trust_all`）** — 插件详情
  面板里的逐插件授权行删除（`.plg-trust` 样式一并移除），改为工具栏开发者模式
  开关旁的全局「全部授权」（默认关，橙色警示文案，仅开发者模式开启时显示；
  轻量写 `set_plugin_trust_all` + `settings-applied`）。`list_plugins` 增加
  `trust_all` 参数（`is_trusted` 短路为真）；`get_plugins` 门控扩为：dev_mode 关
  → trusted 空 + trust_all=false；开 → 透传 trusted 列表与 trust_all。
  `set_plugin_trusted` 命令保留（列表仍被尊重）但设置页不再调用。i18n：删
  `pluginToastTrustedOn/Off`、`pluginTrustHint`，增 `pluginsTrustAll{Hint,On,Off}`
  ×3 语言。验证：`cargo test` 含 `plugin_trust_all_defaults_off_and_round_trips`；
  `cdp_plugins_pane_verify` 断言同步更新（开 = 重载 + 全局全部授权各就位、
  详情面板无逐插件授权行）。
- **插件页重设计 —— 卡片式插件管理器** — `PluginsPane.tsx` 从扁平行列表重写为
  卡片 + 详情面板布局（样式为 `App.css` 的 `plg-*` 块，旧 `settings-plugin-*`
  类删除；重载按钮复用 `settings-icon-btn` + `res/icons/refresh.svg`）。工具栏 =
  概要行（「共 N 个插件 · M 个已启用」）+ 分段筛选（全部 / 已启用 / 已停用 /
  磁盘插件）+ 关键词筛选输入框（无匹配给空态「没有匹配的插件」）；每插件一张
  卡片（图标或按类型着色的首字母块、名称 / 版本 / 内置·磁盘·开发徽章、描述、
  类型 + 关键词预览、重载 / 启停 / 展开），详情面板单开（关键词 chips、进入
  规则、权限能力 chips 本地化 + 说明、声明式设置、ID 与磁盘位置）。i18n 新增
  约 45 键 × 3 语言（筛选 / 概要 / 空态、详情分区标题、能力词 `perm*` + 说明、
  内置插件描述、操作反馈 `pluginToast*`、`pluginSettingDefault`），
  `Settings.tsx` 的 `SECTION_SEARCH_KEYS.plugins` 同步补齐（能力词与分区标题
  可被设置搜索命中）。验证：`tsc --noEmit` + `vite build` + `cargo build` 干净；
  `scripts/cdp_plugins_pane_verify.mjs` 6 项全过（工具栏 / 卡片结构 / 详情面板 /
  筛选输入 / 已停用筛选空态 / 声明式设置渲染），截图 `test/plg_dark_list.png`、
  `test/plg_light_detail.png`（双主题目检）。
- **代理用完即灭活（非驻留）** — 「登录后常驻代理」关闭时，一条规则的快捷键经
  提权代理发送**完成**后立即关闭代理，而不是让它再闲置约 60s 才自灭。为兼容并发
  规则，`shutdown` 改为**优雅退出**：代理收到 `shutdown` 只置 `should_exit`，等
  **没有任何请求在途**（`active == 0`）才真正退出——正在发送中的另一条规则不会
  被掐断；常驻模式仍保持代理存活。对应 `agent.rs`（`Ctx.should_exit`、
  `dispatch` 的 `Shutdown` 分支、`serve_connection` 收尾检查、
  `spawn_idle_watchdog`）与 `automation.rs`（`send_later` 注入完成后
  `agent::shutdown()`）。**代价**：每次非驻留触发都有一轮冷启动（`schtasks /Run`
  + 起提权进程，约 100–300ms），且与「登录后常驻代理」互相矛盾（要 0 冷启动就开
  常驻，要即杀就关常驻）。
- **更详细的自动动作日志** — `agent::ensure_reason` 返回 `AgentUnavailable`
  （未注册 / Run 失败 / 启动超时），回退到进程内 `SendInput` 时明确打印**具体原因**
  而非笼统的「no agent」；armed 日志附加目标完整性；进程内发送成功时注明目标是否
  已提权（`automation.rs`）。
- **发布改为 zip 便携包（不再出 MSI/NSIS）** — 新增 `scripts/package-zip.sh` 作为
  标准打包命令：构建 release（前端 + `lume.exe` / `lume-agent.exe` / `lume-svc.exe`
  + `languages/` + `res/`）并打成 `target/release/Lume-<版本>-win-x64.zip`。同时
  移除 `tauri.conf.json` 的 `externalBin` 并把 `bundle.targets` 置空——外置代理/服务
  经 tauri 安装器打包有历史痛点（曾致 MSI ICE30；实测 externalBin 会把
  `lume-agent.exe` 重复装入、使 WiX 链接失败），改为 zip 便携包后这些代理天然随包
  携带（便携模式代理本就要求与 `lume.exe` 同目录）。

### Fixed

- **LumeSVC 搜索仍然间歇失败 —— 同一症状的第二轮根因**（首轮见下条：并发
  accept + 客户端 `WaitNamedPipeW`）。首轮修好后仍能稳定复现「先输入一个字符、
  再改成 pptx」，实测抓到三个叠加原因：① **引擎每查询的热循环浪费**——
  `contains_bytes` 对**每个文件名**重建一次 256 字节 Horspool 跳表（~68 万文件
  ≈ 每次查询 1.7 亿字节的无效初始化），且把**全部命中**收进 Vec 再整体排序、
  截断（单字符命中可达数十万条）；改跳表为每查询构建一次（`Matcher`，单字节
  查询走 `memchr`）、命中改用**有界 top-k 堆**（排序语义完全不变：`(是否前缀
  命中, 名称长度, FRN, 卷)` 是全序，结果与旧实现一致）。实测 68 万节点索引：
  debug 269.7→54.8ms（`pptx`）/ 414.8→115.7ms（`a`），release 82.9→20.6ms /
  107.8→16.7ms。② **`ERROR_PIPE_CONNECTED` 被当成失败**——客户端在服务端调用
  `ConnectNamedPipe` **之前**到达时（前一个请求刚结束、下一个紧随其后，正是
  连续打字的情形），Windows 以该错误码完成，连接其实**已经建立**；按失败处理
  就 `CloseHandle` 掉了活连接，客户端表现为「刚连上就 EPIPE」。新增共享的
  `pipe::accept_client`（`svc.rs` / `agent.rs` 同修，此前两者都受影响）。
  ③ **排队被误判为后端不可用**——服务端按序作答，连打四个键时最后一个要排在
  三个 ~100ms 的扫描之后，超过当时 800ms 的客户端超时 → 冷却 10s → 用户看到
  「后端不可用」；`SVC_TIMEOUT` 放宽到 1500ms（调用是 async、过期结果本来就被
  前端丢弃，唯一代价是极端情况下晚一点回退到原生结果）。验证：`cargo test`
  135 通过；管道探针（8 并发 + 5 连击）从 3146ms + 2×EPIPE 降到 715ms 零错误；
  新增 ignored 基准 `perf_search_at_real_scale`（68 万合成节点，钉住查询预算）；
  并按用户给的路径实机复现（秒搜页输入 `a` → 改为 `pptx`）确认命中正常、
  无「后端不可用」。
  （`src-tauri/src/{usnidx.rs,pipe.rs,svc.rs,agent.rs,filesearch.rs}`）

- **LumeSVC 文件搜索间断性失败（`connect pipe: busy/failed`）** — 首次查询可用、
  紧接着的下一次查询失败、约 10s（后端冷却）后恢复。两个叠加的根因：① `svc.rs`
  管道服务端是**严格串行的单实例** accept 循环——同一时刻只存在一个管道实例，
  正被服务的实例让后续 `CreateFileW` 得到 `ERROR_PIPE_BUSY`；② `pipe.rs` 客户端
  只重试 2 次 × 50ms（共 ~100ms），而一次引擎 search 要占服务端 ~100–300ms，
  重试必然耗尽；实例回收间隙的 `ERROR_FILE_NOT_FOUND` 也被笼统报成 busy。逐字
  触发的搜索恰好 ~100ms 一发，于是「首查成功、次查失败、冷却 10s」周期出现。
  修复：服务端改为与 `lume-agent` 同款的**每连接一个线程**并发 accept（
  `ConnectNamedPipe` 返回即派发、立即监听下一个实例，`PIPE_UNLIMITED_INSTANCES`
  本就允许），连接不再被在途请求阻塞；客户端连接阶段改用规范的
  `WaitNamedPipeW` + 250ms 截止预算等实例释放，`FILE_NOT_FOUND`（回收间隙）
  单独 80ms 快速重试、管道真不存在时立即报错（安装探测语义不变），其余错误
  （拒绝访问等）立即失败。`SendHandle` 上移 `pipe.rs` 供两个服务端共用。
  新增 ignored 回归测试 `live_pipe_rapid_back_to_back_queries`（10 次背靠背
  search 全部连通）。
  （`src-tauri/src/{svc.rs,pipe.rs,agent.rs}`）

- **提权代理注册失败（根因）** — `schtasks /Create /XML` 拒绝我们生成的 XML，
  因为声明行 `<?xml version="1.0" encoding="UTF-8"?>` 带 `encoding=` 属性，报
  `错误: 任务 XML 格式错误 (1,40) 无法切换编码`。去掉 XML 声明后同一内容即可正常
  注册（实测：带 `encoding=` 声明的一律失败、不带的一律成功，与文件编码无关）。
  （`agent.rs` `task_xml`）
- **注册失败的原因被吞掉** — 提权代理经 `ShellExecuteW(runas)` 分离运行且无
  控制台，一旦 `--install-task` 出错，错误不可见，设置页只显示笼统「注册失败」。
  现在 `--install-task` / `--uninstall-task` 把结果写入
  `%TEMP%\lume-agent-install.result`，主进程等待并读回，把**真实错误**（如
  schtasks 报错）直接抛给设置页；`agent_install` / `agent_uninstall` 改为
  async + `spawn_blocking` 以免等待期间卡 UI。
- **debug 版代理弹出黑窗口抢焦点且不自动关** — `lume-agent.exe` 之前只有 release
  用 Windows 子系统，debug 是控制台子系统，计划任务拉起 `--serve` 时会弹出一个
  抢焦点的黑窗口、在代理存活期间不关。现改为**所有构建**都用
  `windows_subsystem="windows"`（GUI 子系统进程不会获得控制台）。

- **自动动作的发送结果是假的** — `send_combo` 过去丢弃 `SendInput` 的返回值并无
  条件返回成功，因此日志总是打印「sent」，即使输入被 UIPI 静默丢弃。现在检查实际
  插入的事件数（0 = 被拦截），并在发送前比较目标与自身的令牌：目标以管理员权限
  运行时记 `needs_agent` 并提示去注册代理，不再假报成功。
- **`settings.toml` 缺少整张 `[automation]` 表时默认值错误** — `Automation` 原先是
  `#[derive(Default)]`，而 `#[serde(default = "…")]` 只在「表存在但缺键」时生效；
  **整表缺失**（功能上线前写的配置文件）会走派生 `Default`，把 `enabled` 与新的
  `use_agent` 静默关掉。改为手写 `impl Default for Automation`，并加回归测试
  `automation_defaults_apply_when_the_table_is_absent` 钉住。
- **扩展键缺 `KEYEVENTF_EXTENDEDKEY`** — 方向键 / Ins / Del / Home / End / PgUp /
  PgDn / 右 Ctrl / 右 Alt / NumLock / 小键盘 `/` / PrintScreen 属于 0xE0 扩展键，
  合成时必须带该标志。列表严格取 MSDN 的扩展键集合（**不含**通用的左 Ctrl/左 Alt）。
  另按参照实现填充 `wScan`，但**刻意不设 `KEYEVENTF_SCANCODE`**——实机可在原神工作
  的参照实现并不设置该标志。

### Tests

- 122 单测通过（+16）：`input.rs`（`key_to_vk` 覆盖集、扩展键 = 0xE0 集合且不含通用
  Ctrl/Alt、不可合成组合键拒绝、无效 pid 不 panic）；`agent.rs`（四动词解析、
  `inject` 可选字段默认、`inject_ack` 全 reason 往返、畸形回复 = `unavailable`、
  回复 `t` 标签、`AgentInfo` 缺字段默认、**SDDL 只给用户 + SYSTEM**（断言不含
  `AU`/`WD`）、任务 XML 承重设置与路径引号规则、`<UserId>` 出现两次）；`pipe.rs`
  （`wide` NUL 结尾、管道缺失报错）；`settings.rs`（两个新字段默认/往返、整表缺失
  回归）。
- 新增 `scripts/cdp_agent_smoke.mjs`（14 项：设置页两个开关默认值与脏状态、系统页
  代理组、`agent_status` 结构、状态查询无拉起副作用；截图
  `test/agent_{automation,system}.png`）与 `scripts/cdp_agent_verify.mjs`
  （端到端 9 项：自行拉起非提权代理 + release Lume，经 `test_automation_rule` 发送
  **Alt+F4**，断言 **Notepad3 真的被关掉**、`sent_total` 0→4）。
- `cargo test -- --ignored live_agent` 实测：代理答复 `status`（同用户 DACL 放行），
  且非姊妹 `lume.exe` 的客户端被 `denied_client` 拒绝（身份门有效）。空闲自杀亦
  实测（最后一次请求后 >60s 进程自行退出）。

- **自动化（自动动作）** — 新增设置「自动化」页：配置「某程序启动并取得前台
  焦点 → 自动按一次指定快捷键」的规则列表（程序可填全路径或文件名，大小写
  不敏感）。快捷键用与「快捷键」页同款的**按键录制**控件采集（点一下再按组合
  键，`validate_auto_combo` 校验通过才提交；Esc 取消；录制器只监听自身按钮并
  在失焦时取消，不会吞掉旁边程序名输入框的按键），已有规则也可点开重录。
  Rust 侧新模块
  `automation.rs` 用 message-only 窗口 + `RegisterShellHookWindow`（零轮询，
  同 envwatch 风格）：`HSHELL_WINDOWCREATED` 命中规则的程序 → 挂起，
  `HSHELL_WINDOWACTIVATED` 时经泛化的 `send_combo`（`SendInput`，复用
  剪贴板 `send_ctrl_v` 骨架）注入组合键一次并出队——Alt+Tab 切回已运行实例
  不重复触发；主开关 `automation.enabled` 一键关停。触发语义为「新窗口聚焦」，
  后台/最小化启动不保证（前台账面提示）。**延迟触发**：每条规则可自定义
  `delay_ms`（默认 120，界面 0–60000 钳制，Rust 侧 `effective_delay_ms` 兜底），
  即窗口取得焦点后等待多久再按键——慢启动程序可留足 UI 构建时间；若延迟期间
  前台已切到别的程序，则**跳过发送**（发送前按目标 pid 复核前台），避免快捷键
  误发到无关窗口。**「选择」按钮**：程序名输入框右侧新增按钮，弹出当前**带窗口
  正在运行的程序**列表（`list_window_programs` —— `EnumWindows` 取可见、有标题、
  非工具窗口，按 exe 去重并排除 Lume 自身，汇总窗口数 + 代表性标题 + 完整路径），
  支持筛选、点选即回填 exe 文件名、Esc 关闭。**抢回焦点**（全局开关，默认关）：
  延迟到点时若目标已不在前台，默认跳过；开启后先用 ALT 轻敲 + `AttachThreadInput`
  尽力把目标窗口拉回前台再发送，失败则跳过（Windows 禁止后台进程抢前台，属尽力而
  为）。**详细日志**：规则以 `程序 → 快捷键` 标识，挂起/发送/跳过/抢回四个决策点
  都记录，进程一律呈现为 `名字 (pid N)`，并指出当时的前台是谁。**「测试」按钮**：
  每条规则可一键立即触发（`test_automation_rule`）——刻意绕过"新窗口才触发"、
  主开关与该规则的延迟，先把目标程序拉到前台再发送，结果以 toast 呈现（命中谁 /
  程序没在运行 / 无法切前台 / 组合键发不出去）。无新增依赖/feature，
  106 单测通过（`matches_rule` / `key_to_vk` / 组合校验 / 延迟默认与钳制 / 窗口程序
  聚合去重 / settings 往返含抢回焦点）。

- **文件秒搜 mode 插件 + 宿主 search 能力** — 统一文件搜索 API 以宿主能力
  `search.files(q, max?)` 开放给插件（桥接 `window.lume.search.files`）；磁盘
  mode 新增 `lume.on.key` 按键转发事件（模式页自实现 ↑↓/Enter 导航）。示例
  `examples/plugins/file-search/`：关键字「秒搜」进入的全盘文件搜索模式页
  （↑↓ 选择 / Enter 打开 / Ctrl+Enter 复制路径 / 后端与构建状态徽标，50 条
  结果）。
- **文件秒搜（ROADMAP #20）** — 统一文件搜索门面 `file_search` + 双后端：
  本机 Everything 在运行时经**纯 Rust WM_COPYDATA IPC** 直连其索引（不依赖
  SDK DLL，单查询实测 7–8ms）；没有 Everything 时由 LumeSVC SYSTEM 服务
  自建 **USN/MFT 全盘索引**（全量 `FSCTL_ENUM_USN_DATA` + 阻塞式 journal
  增量，零空闲 CPU；Everything 在跑则服务自动休眠不留双份索引，消失后
  懒建）。前端搜索网格并行并入文件结果（原生 → 关键字行 → 文件命中 →
  插件 provider，合计封顶 20、路径去重）；后端失败 10s 冷却，挂死的服务
  永不拖住键入。管道协议升级为长度前缀 JSON 多动词（hello/search/status）。
  新增 `scripts/cdp_filesearch_smoke.mjs` 实机冒烟与三个 `#[ignore]` 集成
  测试（Everything 实查 / 管道往返 / 管理员 MFT 实扫）。

- **125 单测通过（+3）** — `agent.rs` 新增 `install_result_parses_ok_and_err` /
  `install_result_round_trips_through_the_file`（安装结果文件解析与往返）、
  `task_xml_omits_the_declaration_schtasks_rejects`（钉住 schtasks 拒绝
  `encoding=` 声明的回归）。注意：`clipboard::tests::merge_skips_duplicate_
  last_piece` 是**既有的间歇性 flaky**（依赖 1500ms 合并窗口计时，偶发失败），
  与本次改动无关（未触碰 clipboard.rs）。

### Fixed

- **自研引擎实机五连修（ROADMAP #20.1）** — Everything UI 关闭但无头服务
  实例存留时引擎永远休眠（休眠探针改按交互会话判定）；USN journal 读报
  1784（READ_USN_JOURNAL_DATA_V0 按 MSDN 实布局 40 字节重写）；索引静默
  截断为 USN=0 记录子集（MFT_ENUM_DATA_V0 的 HighUsn 过滤区间修正为
  [0, NextUsn]）；路径解析 100% 失败（FRN 高 16 位 MFT 序列号掩码）；rename
  循环产生重复条目（order 成员集去重）。修复后实测 82.1 万文件索引、门面
  端到端 110–141ms、新建文件 6s 内可搜。

- **导航页条目失去选中反馈（描边高亮）** — NavigateView 重构引入的 Solid
  响应式陷阱：`<For>` 的回调不是追踪作用域，`zoneActive() && i() ===
  selected()` 作为普通布尔值传入条目组件后，`classList` 在创建时冻结为初
  始值（zone 尚为 "grid"）→ 栏目/网格的选中描边永不更新。改为把选中态以
  **访问器**传入、在 `classList`/`aria-selected` 属性位置求值（搜索网格同
  步受益：选中变化改为细粒度 class 更新，不再整体重建 DOM）。
- **剪贴板键盘导航失效** — 根选中移动（↑/↓）只更新组合根的 `selected` 信
  号，而剪贴板插件持有自己的 `selected`（视图高亮、Enter 激活、预览、滚动
  跟随全读它），两个信号漂移导致方向键看似无反应。`moveSelection`/
  `runSearch`/`clearSearch` 的选中读写改为按模式路由（插件模式走
  ModeInstance 的 `selected`/`setSelected`）。
- **导航页 ↓ 键不换栏** — 连续栏目导航中「下方行不达当前列」（部分末行或
  下方栏目更短）时，↓ 会跳到本栏末尾条目。改为进入下一个栏目（列钳制到其
  宽度）；仍在同一栏的部分末行时保持落栏尾的旧行为。
- **插件模式窗口尺寸继承** — 切进磁盘 mode 插件的 iframe 页时窗口保持上
  一页面的尺寸：磁盘 mode 实现的 `search`/`reset` 未调
  `services.scheduleResize()`（违反 ModeInstance 契约，内置剪贴板插件有
  调），模式切换后没有任何重测。已补调，切入即应用定高模型的正确高度。
- **设置/快捷键：录制按钮文本错误** — 重排时丢失「自定义」标签逻辑：预设
  chip 激活时录制按钮错误地重复显示当前组合键（如 `Tab | Tab`）。恢复为
  预设激活 → 显示「自定义」，自定义组合 → 显示组合键，录制中 → 显示
  「按下新的组合键…」。
- **Tab 无法切换到插件模式** — 切换键硬编码 `apps ⇄ clipboard`。改为在
  全部启用模式间循环（导航 → 剪贴板 → 插件模式 → …，顺序 = 注册序）。
- **关于页贡献者** — 作者行改为「贡献者 = IndexEeve&yitao-baka」。

### Added

- **插件自定窗口尺寸（清单 `height` + RPC `app.resize`）** — ① mode 插件
  清单可声明 `height`（逻辑 px）：`PluginInfo` 透传，sizer 定高分支经
  `ModeInstance.desiredHeight()` 取值，前端钳制到最小高度与工作区高度，未
  声明回退全局 设置 → 窗口大小 → 高度；② 桥接/工厂宿主 API 新增
  `app.resize({width?, height?})`（iframe 页 `lume.app.resize`）：运行时改
  窗口尺寸，省略轴保持当前值（sizer 每次 setSize 上报 `runtimeSize` 基
  线），尺寸保持到下一次内容驱动的 resize。hello-mode 示例演示两者。
- **导航页栏目注册表 + 插件 `navBars` 钩子（ROADMAP #7 第四轮）** — 导航页
  空查询主菜单的三个原生栏（最近使用/已固定/Windows 资源管理器）与插件栏
  统一为 `NavSection` 契约：`navigate.ts` 的 `sections()` 是唯一注册表
  （顺序 = 最近使用 → 已固定 → 插件栏 → 资源管理器栏**结构性固定最下层**），
  `NavigateView` 单一 `SectionView` 渲染，连续网格键盘导航、拖拽排序、
  Delete 软删、展开撑满的 work-area cap 全部走注册表（拖拽按栏目隔离，顺带
  修复拖拽跨栏时误算插入位的隐患）。任意 kind 的磁盘插件可在工厂逻辑里实现
  `navBars()` 贡献栏目：条目 `{name, path, icon?}` 点击/Enter 经 `launch_app`
  打开（文件与 URL 均可）、右键共享 app 菜单、`icon` 缺省走图标管线
  （data:/URL 直通、本地路径转 asset 协议）；每次呼出与插件刷新时重新拉取。
  示例 `examples/plugins/nav-bar/`。
- **插件系统第三轮：mode/service 磁盘加载 + 宿主能力 API（uTools 式）** —
  ① **磁盘 mode 插件**：`kind = "mode"` + `view`（HTML）渲染进同源桥接
  iframe（srcdoc 注入 `window.lume` 桥：Promise RPC + `lume.on.query/show/
  hide` 事件），页面 UI 完全自由；`entry` 可选逻辑钩子；manifest 新增
  `view`/`keywords` 字段。**全局关键字**（uTools 式进入）：`keywords` 与
  Navigate 查询完全一致时出现「进入 <name>」行，激活即切入模式（pill 同步
  出现，禁用回退兼容）。② **磁盘 service 插件**：`kind = "service"` +
  无 UI 生命周期钩子（`onShow`/`onHide`/`onQuery`，异常隔离）。③ **宿主
  能力 API**（`PluginHostApi`，三类插件通用；iframe 经 postMessage RPC 桥）：
  `app.hide/toast/setQuery/openPath`、`clipboard.readText/writeText`（新增
  `get/set_clipboard_text` 命令）、`storage.get/set/remove`（插件私有 KV，
  新增 `plugin_storage_get/set` 命令 + storage.json + 路径穿越消毒）。
  默认导出支持工厂形式 `create(ctx)`，v1 纯对象形式向后兼容。修复
  `import()` 命名空间未取 `default` 导致 provider 不加载、以及 `plugins`
  数组 push 不触发响应式（disk 加载后 clone manifests）两个本轮引入的
  缺陷。验证：cargo test 79（+2 存储/清单）；实测 hello-mode（关键字进入/
  iframe UI/存储跨重启持久化/toast/剪贴板）与 web-search（向后兼容）全通；
  截图 3 张 judge 通过；三套冒烟全过。示例 `examples/plugins/hello-mode/`。

### Added

- **插件系统第二轮：provider 搜索贡献 + 第三方 JS 动态加载 + 插件管理页** —
  ① `provider` 贡献类型：`search(query)` 返回 `{name, path}` 条目，追加在
  Navigate 原生搜索结果之后（path 去重、封顶 20、异常隔离），激活/图标
  走既有管线；② 磁盘插件动态加载：清单 `kind = "provider"` + `entry`
  指向 ES Module，前端经 asset 协议 + blob URL `import()` 加载，默认导出
  `{ search }` 即成为搜索提供者（示例 `examples/plugins/web-search/`，
  开发指南 `docs/PLUGINS.md`；`PluginInfo` 向前端暴露 `entry`/`dir`）；
  ③ 设置新增第 8 分区「插件」（`PluginsPane`）：内置/磁盘插件全部列出
  （类型/来源/版本 chips + 启停 toggle），关闭活动模式插件时启动器自动
  回导航页。截图验证：provider 结果行与插件管理页 judge 通过；
  cdp_feature/settings/clipboard 三套冒烟全过（settings 冒烟断言更新为
  8 分区）。

### Added

- **插件系统 v1（ROADMAP #7）+ 剪贴板/预览插件化** — 插件 = 清单
  （`<base>/plugins/<id>/plugin.toml`：id/name/version/kind/description/
  permissions）+ 前端贡献。Rust 新增 `plugins.rs`：清单解析与目录扫描
  （坏清单跳过、id 回退目录名）、`get_plugins`/`set_plugin_enabled` 命令、
  `settings.plugins.disabled` 启停集（轻量写 + `settings-applied` 刷新）；
  内置插件与磁盘插件走同一注册表路径。前端新增 `src/plugins/`
  （`types.ts` 契约 + `registry.ts` 注册表）：`PluginServices`（toast/入口
  标记/隐藏/搜索管线+搜索令牌/选中来源/右键菜单/模式切换）向插件开放
  组合根能力。**剪贴板**迁移为首个 `mode` 贡献（`src/plugins/clipboard/`：
  store + 视图 + 模式键处理 + 搜索 + 记住页面 + 设置切片），模式 pill 与
  页面由注册表渲染，新增模式不再改壳；**预览窗**迁移为独立的 `service`
  贡献（`src/plugins/preview/`：选中 → 预览请求防抖 show/close + Esc
  优先级），模式只上报 `previewTarget`/`previewEnabled`，窗口生命周期仍在
  核心。行为零变化：cargo test 77（+3 插件单测）、截图 5 组 judge 成对
  等价、cdp_feature_smoke 13 项 + cdp_clipboard_smoke 全过。v1 未做：
  第三方 JS 动态加载、插件管理设置页、provider 搜索贡献（清单/权限面已
  预留）。

### Refactored

- **拆分 App.tsx 为 launcher 模块（零行为变化）** — 2510 行的单文件（`App()`
  单函数 2234 行）拆为 `src/launcher/` 下 11 个职责模块：`types.ts`（共享类型
  + 纯常量）、`clipData.ts`（剪贴板纯函数）、`icons.ts`（图标缓存工厂）、
  `sizing.ts`（窗口自适应/列测量工厂）、`navigate.ts`（最近/固定/Explorer 栏
  信号 + 动作 + 连续导航 + 拖拽重排）、`clipboard.ts`（剪贴板全部信号/动作 +
  虚拟列表窗口数学）、`menu.ts`（右键菜单构造）、`keyboard.ts`（窗口级键盘
  路由 + WebView2 快捷键拦截）、`previewSync.ts`（卫星预览防抖同步）、
  `NavigateView.tsx` / `ClipboardView.tsx`（两模式视图）。`App.tsx` 收敛为
  组合根（787 行）：会话生命周期（搜索召回/模式切换/挂载监听）+ 模块接线。
  跨模块依赖统一走 deps 对象后绑定；模块级可变全局 `lastWindowH` 移入
  sizer 工厂内。为未来插件系统（ROADMAP #7）预备模式边界。验证：tsc +
  build 干净；重构前后截图 5 组成对 judge 验收全部等价（差异仅为捕获期
  鼠标悬停/光标闪烁/相对时间）；`cdp_feature_smoke` 13 项 + `cdp_clipboard_smoke`
  全过（修正 feature smoke 中设置页重排前的过时断言）；新增
  `cdp_launcher_shots.mjs` 截图对比工具。

### Changed

- **设置页分组卡片重排（对齐 Flutter 设置）** — 设置窗口信息架构与
  `feat/flutter-settings` 的 Flutter 独立设置 exe 对齐：顶栏（Lume + 「搜索
  设置」框）+ 7 分区导航（外观 / 导航页 / 剪贴板 / 快捷键 / 搜索 / 系统 /
  关于，删除「插件」占位页）+ 居中 720px 分组卡片内容列 + 底栏
  「恢复默认设置 + 保存并应用」；窗口 720×560 → 940×660。搜索框按分区
  i18n 键清单过滤导航与内容（匹配分区堆叠显示）。**保留 main 版独有项**：
  窗口位置「自定义」、快捷键预设 chips（WebView2 录不到 Alt+Space）+
  `validate_hotkey` 实时校验、用户索引每行「索引文件」开关、刷新索引按钮 +
  toast、恢复备份设置、系统索引中文标签；**新增「记住勾选」到设置页**。
  「恢复默认设置」改两步语义（重置工作副本并标脏，需再点保存才落盘，
  同 Flutter）；`restore_default` 命令保留但不再被设置页调用。
- **档位值对齐 Flutter 版** — 窗口宽度 600/720/840 → 540/720/900、高度
  360/520/720 → 420/520/620、条目框 80/110/140 → 70/110/150、最近使用条数
  新增 50 档（10/20/30/50）；合并复制窗口由 0.5–3s 档位 chips 改为
  500–5000ms 连续滑块（步进 100）。旧的非默认值仍生效，只是对应 chip 不再
  高亮。
- **用户索引改键值结构（settings.toml schema 迁移）** — `index.user_dirs`
  /`user_dirs_no_files`（旧路径列表）→ `index.user_index: [{name, path,
  no_files}]`（显示名 → 目录，仿 Windows 环境变量对话框的编辑器：名称留空
  自动取 basename）。`Index::migrate()` 在读取旧 `settings.toml` 时一次性
  转换（name = basename、`no_files` 继承、遗留字段清空），写回只保留
  `user_index`——与 Flutter 版格式互通。`cache.rs::live_dirs`、
  `dirwatch.rs::watch_dirs` 改读 `user_index`。`cargo test` 74 通过（新增
  `legacy_user_dirs_migrate_to_key_value_index`）；`tsc --noEmit` +
  `vite build` 通过。

## [Pre-26.8] — 2026-08-24

### Changed

- **搜索状态召回（打开即忘 / 5 分钟过期）** — 一次「未打开条目」的搜索在 5 分钟内会被下次呼出
  恢复（`clearSearch` 的 `recall`：未打开 + 未超时 + 当前模式有活跃查询 → 保留当前 mode/query 不动，
  `runSearch` 按它重跑）；**打开条目**（启动 / 回车 / 粘贴 / 开链接 / 开终端等使用条目的路径）即清空
  查询、下次呼出回导航页；**超过 5 分钟未再次呼出**也回导航页（`searchRecallAt` 锚点 + `SEARCH_RECALL_MS`）。
  `remember_last_page` 的只恢复 mode/category（页面偏好），**不受 TTL 限制**，仅被「打开条目」覆盖为导航页。
  `tsc --noEmit` 与 `vite build` 通过。

- **WebView2 闲置内存裁剪（ROADMAP #18）** — 三个常驻 webview（main/settings/preview）即使
  全隐藏也各保有一个 renderer 进程（实测基线 priv-WS **138.1 MB**，renderer ×3 = 58.1）。
  接入 WebView2 官方 `ICoreWebView2_14+::SetMemoryUsageTargetLevel(Low)`：隐藏窗口的闲置内存
  换出到分页文件（页面保活不卸载），**重新激活必须手动设回 Normal**。策略——settings/preview
  **隐藏立即 Low**；main **隐藏满 10s 才 Low**（`trim_main_when_idle`，频繁开关不触发换出，
  热键呼出前 `restore_main` 预热换回）。实现：新增 `webview2-com` 依赖（与 tauri 的 0.38.2
  统一），`Webview::with_webview` 取 COM controller → `cast<ICoreWebView2_19>` →
  `SetMemoryUsageTargetLevel`（tauri 未透出该 API；`Manager::get_webview` 在 `unstable` feature
  后故走 `WebviewWindow::as_ref().with_webview`）。实测：隐藏基线 **138.1 → ~102 MB**（renderer
  58.1 → 23 MB，省 ~36 MB / 26%）；从全 Low 状态热键呼出 **87ms**（可接受）；settings 开关内存
  恢复/回落正常；预览 dock 正常。**实验被否**：`--renderer-process-limit=1` 虽把 renderer ×3
  合并成 ×1（省 ~18 MB），但 WebView2 不支持多 webview + 该开关——settings/preview 窗口创建
  静默失败（HWND 消失、CDP 只剩 1 target、`open_settings` 无窗口）→ **回退**，仅保留 Part 1。
  `cargo test` 73 通过。
- **修复"复制/粘贴旧文件条目，系统剪贴板仍是最新文件"（真正根因，用户复测 + 参考 ZTools）** —
  `set_files_to_clipboard` 只 `SetClipboardData(CF_HDROP)`、**不调 `EmptyClipboard`**。Explorer
  复制文件时剪贴板同时有 `CF_HDROP` + `CF_UNICODETEXT`（最新文件路径文本）；Lume 替换了
  HDROP 但**残留的文本格式仍指向最新文件**，任何文本读取/粘贴（`Get-Clipboard` 默认读文本、
  记事本 Ctrl+V）都看到最新文件——而 HDROP 里其实已是旧文件。文本条目因 arboard `set_text`
  先清空剪贴板而正常。修：`set_files_to_clipboard` 在 `OpenClipboard` 后加 `EmptyClipboard()`
  （照搬 ZTools 原生 `setClipboardFiles` 的做法），剪贴板现在只含该文件列表。隔离副本自动化
  复现：设文本哨兵 → 复制旧文件行 → 修复前 `Get-Clipboard`=哨兵、修复后=空且 FileDropList=旧文件。
- **粘贴后剪贴板保留粘贴内容（用户选「保留」，同 ZTools）** — 移除 `auto_paste` 的"保存→还原"
  （`SavedClipboard`/`save_current_clipboard`/`restore_saved_clipboard` 删除）；粘贴什么剪贴板
  就留着什么，旧条目粘贴后内容可见、可反复粘贴。此改动与 EmptyClipboard 修复互补（ZTools 同样
  不还原剪贴板）。
- **移除剪贴板底部快捷键提示** — 删除 `.shortcut-hint`（App.tsx / App.css / `clipShortcutHint`
  三语文案）；`resizeToContent` 不再测量该 footer。
- **「记住上次所在页面」重启回到初始页** — 开启该开关时，关闭 Lume（托盘「关闭」或「重启」）
  会清除已记住的页面（`last_page`/`last_page_kind` 重置为 `apps`/`all`），下次启动回到初始
  页——记忆只在会话内生效（隐藏/再次呼出保留），跨重启不恢复。后端在 `RunEvent::ExitRequested`
  清理（`settings::clear_last_page`，轻量写盘不碰 backup.toml）；单实例第二进程在进入 Tauri
  生命周期前即退出，不会误清。单测 +2 → `cargo test` **73 通过**。

- **Clipboard image preview / enlarge via asset protocol** — `get_clipboard_image`
  returns the stored PNG's path instead of a base64 data URI; the frontend
  renders it with `convertFileSrc`, so WebView2 decodes the full-size image
  straight from disk (no base64 string through IPC, no second decode in JS).
  This removes the enlarge-preview memory/CPU spike; row thumbnails stay base64.
- **Preview pane shows thumbnails, not full-size images** — selecting an image
  row (or image file) no longer decodes the full-size bitmap into the webview;
  the preview shows the small 200px thumbnail (`item.thumb`, or a new
  `get_file_thumb` command that downscales image files server-side). The
  full-size image decodes only when the user clicks to enlarge. Fixes the
  decoded-bitmap memory spike that lingered in the renderer's image cache after
  closing the preview.

### Added

- **多文件条目列表预览 + 勾选（ROADMAP #17）** — ≥2 文件的剪贴板条目在卫星窗显示
  **文件列表**（复选框 + 逐文件存在性，缺失项划线变灰并禁用勾选），取代"预览第一个
  文件"；复制/粘贴只对**勾选的子集**生效（HDROP 按勾选路径过滤）。「记住勾选」全局开关
  （预览区顶部，默认开）：开 → 勾选持久化到新 `checked` 列（删除/撤销也不丢），关 →
  每次会话重置为"仅勾选存在的文件"。新命令 `check_file_exists` / `set_clipboard_checked`。
- **失效条目划线变灰（ROADMAP #17）** — 文件条目**全部**路径丢失、或图片 PNG 被清理
  后，整行划线变灰、不再展开预览、复制/粘贴拦截并 toast「内容已失效」（后端 `valid`
  字段 + `usable_paths` 双保险）；**所有**复制/粘贴错误现在都弹 toast（修 #17 报告的
  "旧条目复制/粘贴无反应"——此前复制失败只 `console.error`）。
- **「内容去重」开关（`clipboard.dedup`，默认开）** — 关闭后完全相同的内容（文本/文件
  列表）也新增一条；开启保留现状（整条一致时前移不重复）。文本部分唯一索引
  `idx_clipboard_text_unique` 按开关在启动与保存时 DROP/重建。
- **「记住上次所在页面」开关（`appearance.remember_last_page`，默认关）** — 开启后再次
  呼出停留在上次的**模式 + 剪贴板分类**（搜索词仅本会话内记住，不落盘）；命名与已有
  窗口位置的「记住位置」区分。新命令 `save_last_page`（轻量写盘、不碰 backup.toml）。
- **多文件行混合类型 tile** — ≥2 文件且类型**混合**的行显示新 `res/icons/multifiles.svg`；
  全部同类型仍显示该类型图标（音频音符/视频/图片/文本/通用）。
- 新设置：`clipboard.remember_checks`（默认开）、`clipboard.dedup`、`appearance.remember_last_page`
  / `last_page` / `last_page_kind`。剪贴板页加「内容去重」、界面页加「记住上次所在页面」。
- 单测 +7（失效判定、勾选子集、去重开关、checked 存取与撤销携带）→ `cargo test` **71 通过**。

- **PDF 预览（ROADMAP #16，PDF.js）** — `pdfjs-dist` v6 懒加载（Vite 分包，仅首次
  预览 PDF 时进卫星 renderer），手写迷你查看器：翻页 `‹ ›` + 页码 + 缩放 `＋ −`，
  **只渲染当前可见页**（离屏回收，巨型 PDF 不会撑爆卫星窗）；文件经 asset:// 读取，
  无新后端命令。Office 与 压缩包 预览按决策放弃。见 `docs/ROADMAP_HISTORY.md` #16。
- **源码/歌词/字幕归文本** — `fileContent`/`file_content_kind`（前后端两份）新增
  常见编程语言扩展名（`kt swift php rb dart scala cs fs fsx r pl hs zig nim ex exs
  erl clj vue svelte jsx tsx mjs cjs groovy gradle proto gql tex`）、歌词 `.lrc`、
  字幕 `.srt .vtt .ass` —— 归类文本文件并进文本预览。
- **「音乐」分类** — 剪贴板分类区在 图片 和 视频 之间新增「音乐」（音频内容文件过滤）；
  音频行沿用已有的音符 tile。
- **「开启预览」开关（`clipboard.preview`，默认开）** — 设置/剪贴板顶部 Toggle；
  关闭后卫星预览窗从不弹出（前端信号 + 后端 `show_preview` 双门控），列表内缩略图保留。
- **`scripts/cdp_feature_smoke.mjs` / `scripts/cdp_dock_measure.mjs`** — CDP 冒烟
  （PDF 渲染/音乐分类/.lrc 预览/开关门控/设置页开关）与双侧磁吸间距测量工具。

- **截图像素图捕获补齐（照搬 ZTools/Chromium readImage 模式）** — 图片捕获在
  `arboard::get_image()`（只读 CF_DIB/CF_DIBV5）失败时，依次回退：①
  `read_custom_png_image`（枚举剪贴板注册格式，读名字含 png/image/png 的自定义格式，
  已 PNG 直接用、否则重编码）；② `read_cf_bitmap_image`（读 CF_BITMAP 设备相关位图，
  复用 `icons::bitmap_to_png` 转 PNG）——ZTools 剪贴板插件用 Electron `readImage()`
  （Chromium）捕获，它同时接受 DIB/BITMAP/PNG，而 PixPin 等截图工具的「复制」按钮
  常只放 CF_BITMAP，arboard 会漏掉。文本优先于图片的判断（Office 复制带 TIFF 渲染）
  与 ZTools 一致（Lume 本就是文本优先）。单测 `read_custom_png_finds_png_format` +
  `read_cf_bitmap_returns_png` 验证两条回退。**待用户用真实 PixPin 复制实测**（自动化
  种子受剪贴板所有权竞态限制，无法完全模拟）。
- **视频预览封面（poster）** — 预览窗里的 `<video>`（`preload="none"`，播放前原本是
  纯黑）现在显示一帧封面：新命令 `get_video_thumb` 用 `IShellItemImageFactory` +
  `SIIGBF_THUMBNAILONLY` 从 Windows shell 提取视频帧（就是资源管理器显示的缩略图），
  在专用 STA 线程上跑（缩略图提供程序要求 STA；图标走 MTA 不变），返回 base64 PNG，
  前端设成 `<video poster>`。格式无 shell 提供程序时退回占位。CDP 实测 PNG/MKV 均
  返回有效帧。
- **卫星预览窗口（ROADMAP #15）** — 所有剪贴板预览（文本/文本文件/图片/音频/视频）
  移出主 renderer，进一个启动时创建的独立、无边框、非激活（WS_EX_NOACTIVATE）窗口，
  固定挂靠主窗口右缘（宽 320 / 高跟随，`GetClientRect`+`ClientToScreen` 贴齐客户区，
  `Moved`/`Resized` 跟随，右缘溢出贴左）。选中预览行 → 卫星出现；无选中/other 二进制
  → 隐藏并导航 `about:blank`（页面卸载；renderer 进程保留待复用，实测为部分回收）。
  主窗口从此恒为基础宽度、永不为预览变化。关闭经主窗 Esc 或卫星窗 × 按钮。CDP 实测：
  renderer×3、磁吸贴齐、主窗不加宽、图片 asset:// 渲染、Esc 回收全通过。见
  `docs/ROADMAP_HISTORY.md` #15。
- **`scripts/measure-webview-mem.ps1`** — memory-measurement harness that
  snapshots Lume's whole process tree (`lume.exe` + `msedgewebview2` children)
  by process type, reporting private working set / working set / commit, with a
  guided 4-stage run (baseline / clipboard / settings / big-image) and a
  comparison table. No app code involved.

### Fixed

- **Left-dock preview overlap（ROADMAP #16）** — 卫星窗贴主窗左侧时重叠 ~11px
  （150% DPI）。两层根因：① `dock_position` 左分支把位置钳进工作区左缘；② 预览窗
  虽 `decorations(false)` 仍带 ~11px 左不可见边框，而 `set_position` 设外框位置、
  磁吸数学算客户区。`dock_position` 改返回客户区目标 + `Option`（两侧都放不下 →
  隐藏），`redock` 量出 client→outer inset 后偏移，两侧真正对齐；随后加
  `PREVIEW_GAP_LOGICAL`（8 逻辑 px）两侧统一留间距。CDP 实测左/右 gap 均 8.0 CSS px。
- **No stray preview when re-enabling 开启预览 in settings** — 设置窗打开时启动器
  失焦隐藏；在设置里重新开启预览并保存后，前端 sync 会在启动器隐藏时调
  `show_preview`，飘出孤立预览窗。`show_preview` 现在先查主窗可见性，不可见则
  teardown 不显示（也挡住隐藏时新剪贴板行触发 preview 的同款潜在 bug）。
- **`custom-protocol` feature** — tauri 的 `cfg(dev) = !custom_protocol`，裸
  `cargo build --release` 一直出 dev 版（加载 localhost:1420）；已加入 Cargo.toml
  features，cargo 构建即生产版。

- **Clicking the satellite preview keeps the launcher up AND focused** —
  interacting with the preview (video play, image, text) blurred the launcher
  and tripped its blur-to-hide. The blur-hide rule now checks whether the cursor
  is over the visible preview (`preview_has_cursor`): if so, it keeps the
  launcher up and hands focus back to it, so (a) keyboard navigation of the
  list keeps working while the preview is used, and (b) the launcher is left
  properly focused — a later click-away on a different app re-fires the
  blur-to-hide and closes both windows.
- **Preview window closes with the launcher again** — `teardown_preview` used
  Tauri's async `hide()`, which raced the `about:blank` navigation and could
  leave the window on screen. It now hides synchronously via Win32
  `ShowWindow(SW_HIDE)` after tearing the page down.
- **No close × on the preview window** — the satellite has no in-window close
  button; it closes via the launcher's Esc or when the launcher hides.
- **Preview only opens for content** — plain copied text rows never open the
  satellite; file rows with text/audio/video/image content preview everywhere,
  and clipboard image rows (captured screenshots) now preview in every category
  too (previously only inside the 图片 category).
- **Satellite preview font matches the launcher** — `font-size`, `line-height`
  and `-webkit-font-smoothing: antialiased` were missing, so CJK rendered
  differently; now inherited from the same stack as the main window.
- **Satellite preview no longer hides the launcher when shown** — showing the
  preview window with `preview.show()` (SW_SHOW) made the launcher lose focus
  and trip its blur-to-hide, so entering Clipboard mode with a previewable row
  selected made the whole window vanish. The preview is now revealed with Win32
  `ShowWindow(SW_SHOWNOACTIVATE)` — never activates, so the launcher keeps
  focus (it already carries `WS_EX_NOACTIVATE` for clicks).
- **Drag no longer switches back to Navigate** — the launcher reset its state on
  every `onFocusChanged(focused=true)`; dragging the frameless window briefly
  deactivates and refocuses it, so a drag mid-clipboard would wipe the mode.
  The reset now fires only on a real fresh show (a Rust `launcher-shown` event
  emitted in `window::show`), so drags keep the current mode/search intact.
- **Hotkey summon now auto-selects the first entry** — the empty-query main
  menu rested on `zone = "grid"`, and the bar highlight requires `zoneActive`,
  so nothing was highlighted on summon. After a show the zone now settles on
  the recent bar (or pinned) so its first item is selected.
- **Mouse selection persists after leaving the list** — the bars / apps grid /
  clipboard list cleared the selection on `mouseleave` when `selectionSource`
  was mouse, so a click-selected entry despawned the moment the cursor left the
  list. The mouse-leave deselection is removed; a selection stays until another
  one is made.
- **Video/audio preview no longer buffers on selection** — the preview media
  elements now use `preload="none"`, so picking a row doesn't fetch the file
  into the renderer's media cache (which lingered after the preview closed);
  the file loads only when the user presses play.

### Notes

- A lazy settings-window experiment (create on first open, destroy on close)
  cut the idle baseline from 115.4 to 88.1 MB, but was reverted after an
  `AppHangB1` (WebView2 GPU-compositing hang when creating a runtime webview)
  left the app unresponsive. Revisit via WebView2 `additional_browser_args`
  GPU flags when pursuing the idle-memory target again.

## [0.2.17] — 2026-08-13

Clipboard manager phase 3 — preview pane + native drag-out (ROADMAP item 13,
phase 3; completes #13).

### Added

- **Preview pane** — selecting a clipboard row opens a right-side preview
  (the window widens by 320 px, narrowing back when the selection clears).
  Text rows show the full content (scrollable); image rows show the full-size
  image and enlarge on click; file rows show name / size / path / modified
  time per file (`get_clipboard_image` / `get_file_info` commands).
- **Drag-out (native OLE)** — dragging an image or file row out of the launcher
  starts a real `DoDragDrop` with a CF_HDROP data object, so WebView2's
  in-webview-only HTML5 drag can carry files to Explorer. Images drop as a PNG
  copy; files copy to the target folder. Runs on a dedicated thread.

### Fixed

- **Image file path double prefix** (regression from 0.2.14) — reading an image
  row's PNG joined `PictureCache` twice, so copying or previewing an image
  failed with a "file not found" error.
- **Drag-out freeze** — the OLE `DoDragDrop` ran on the launcher's main thread,
  freezing the UI for the whole drag; the drag commands are now async (the
  drag runs on a background thread).
- **Preview pane scope** — the preview now opens for text / file (incl.
  audio/video) rows only; images preview in their own row thumbnail and
  clicking the thumbnail enlarges (no right-side pane, no window widening).
- **Content-type previews** — file rows preview by content kind: text files
  show their text content, audio/video get an in-pane player (via Tauri's
  asset protocol), image files show the image (click to enlarge), and
  arbitrary binaries (`.dll`, `.exe`, …) no longer open the preview pane at
  all. Tile icons distinguish text / audio / video / image / other.
- **Preview reactivity fix** — the preview branch was decided in the component
  body, so SolidJS never re-ran it on selection change (a video row could show
  the previous image). Branches now use reactive `<Switch>/<Match>`.
- **Mouse into preview doesn't close it** — the selection-clearing
  `mouseleave` moved from the list to the whole list+preview container, so
  moving the cursor from the list into the preview pane no longer collapses
  it. Preview scrollbars are hidden (wheel-scroll only).
- **Drag-out removed** — the native OLE drag-out of image/file rows was
  dropped (unused); rows are no longer draggable and the OLE code, commands
  and dependencies are gone.
- **Right-click never changes the window state** — the clipboard context menu
  no longer re-selects the row it opens on (the menu acts on that row's item
  directly), so right-clicking keeps the selection, the preview pane and the
  window width exactly as they were. The preview also stays visible for the
  whole time the menu is open.
- **Content categories** — the clipboard filter tabs are now 全部 / 文本 /
  文本文件 / 图片 / 视频 / 收藏 (the old generic 文件 tab became 视频, and a
  new 文本文件 tab was added). Each filters correctly by content kind (text
  files, images — both image rows and image-file rows — and videos).
- **Content categories keep the preview open** — in the 文本文件 / 图片 /
  视频 tabs the preview pane is always expanded (image rows show their full
  image with click-to-enlarge); the 文本 and 收藏 tabs never open it, and
  全部 opens it on demand.
- **Category switching with arrows** — in Clipboard mode, ← / → cycle the
  category tabs when the search box is empty.
- **Input modality is exclusive** — keyboard navigation disables mouse-hover
  selection (a click re-enables mouse mode), so the two never fight.
- **Text rows no longer open the preview** — the 全部 tab's preview is now
  file rows only; the text-content preview serves the 文本文件 tab.
- **Pin takes effect immediately** — right-clicking → 固定 updates the row's
  badge right away (optimistic), then the re-search moves it to the top.
- **Keyboard navigation auto-scrolls** — the virtual list keeps the selected
  row fully in view when navigating with the arrows (buffered; no longer
  overridden by `scrollIntoView`).
- **File-attributes preview removed** — the name / size / path / modified-time
  preview is gone (along with its `get_file_info` command); right-clicking no
  longer opens the preview either.
- **Click = select, click again = paste** — a first click on an entry selects
  it; clicking the already-selected entry pastes it.
- **No hover-darken on rows** — hovering an entry no longer changes its
  background (the selected state still highlights).
- **Hover-select is a setting** — 剪贴板 settings gains 「悬停选中条目」
  (default off): with it off, a click is the only way to select with the mouse.
- **Favorite / Unfavorite** — the context menu's 固定/取消固定 items are now
  收藏/取消收藏.
- **Favorites on top is a setting** — 「收藏的条目置顶显示」 (default off)
  controls whether favorited entries sort to the top (off = pure recency).

## [0.2.16] — 2026-08-13

Clipboard manager phase 2 — rich text, ignored apps, pause, auto-merge
(ROADMAP item 13, phase 2).

### Added

- **Rich text / plain-text copy** — text copies that carry CF_HTML store it
  (`html` column, 64 KB cap); copy / paste keeps the formatting (HTML + plain
  text), and a new 「复制为纯文本」 context-menu item copies without it.
  Search and the list still use plain text only.
- **Ignored apps** — a 剪贴板 settings list of app names (matched
  case-insensitively against the source app, e.g. "Chrome"); copies from an
  ignored app are never recorded — good for password managers and private
  chats.
- **Pause recording** — a runtime 「暂停记录 / 继续记录」 status-bar toggle
  (not persisted); while paused the recorder skips every change.
- **Auto-merge** — when 合并复制 is on, consecutive text copies within the
  merge window (default 1.5 s) fold into one entry joined by newlines, shown
  as 「合并复制 N 条」. A copy beyond the window, a non-text copy, or a paste
  closes the merge; re-copying the last piece bumps recency instead. Window is
  configurable (0.5–3 s) in the 剪贴板 settings pane.
- **Undo preserves rich text & merge state** — restoring a deleted entry keeps
  its HTML and merged-count.

### Changed

- Schema: `clipboard` gains `html` and `merged_count` columns (in-place
  migration; legacy rows normalized to `merged_count = 1`).
- `copy_clipboard` takes an optional `plain` flag; new
  `set_clipboard_paused` command.

## [0.2.15] — 2026-08-13

Clipboard manager redesign — layout, categories, multi-select merge, undo,
virtual scrolling (ROADMAP item 13, phase 1).

### Added

- **Clipboard page layout** — the clipboard mode is now a full page: category
  tabs (全部 / 文本 / 图片 / 文件 / 收藏), a virtualized history list with
  fixed window height, a status bar (条目计数 + 清空), and a proper empty
  state. The window height is fixed in clipboard mode (the list scrolls
  internally); the apps mode keeps auto-sizing.
- **Richer single rows** — each entry shows a type tile (text T / file icon /
  image thumbnail / link icon / color swatch), a two-line body
  (`来源应用 · 时间`), and hover actions (copy / paste / delete). URLs and
  color values are detected at display time (no network, no schema change).
- **Source-app tracking** — captures the foreground process at copy time and
  shows it on each row (`source_app` column); history is searchable by source
  app too.
- **Multi-select + merge paste** — Space toggles entries into a selection set;
  Enter pastes them merged (text joined by newlines) into the previous app.
- **Undo delete** — deleting plays a 120ms fade-out, shows
  「已删除 1 条 / 撤销」 (3s), and restoring re-inserts the entry (image files
  are kept until the undo window passes).
- **Clear confirmation** — 清空 asks for confirmation and offers 「保留固定
  记录」 (pinned rows and their images survive).
- **Toast + animation spec** — bottom-center toasts (150ms ease-out; 1.6s, 3s
  for undo); hover/focus/menu 100ms, delete 120ms, window open/close 150/120ms.
- **Virtual scrolling** — hand-rolled windowed list (~30 DOM rows + overscan)
  keeps 500+ history rows fluid.
- **Clipboard settings pane** — history limit (100/200/500/1000), record
  images / files, close-after-paste, show source app, relative/absolute time.
  The recorder reads live settings, so toggles take effect immediately.
- **Richer context menu** — link rows get 「打开链接」, file rows get
  「打开文件位置」.

### Changed

- `search_clipboard` takes a `kind` filter; `delete_clipboard` returns the
  deleted row (`DeletedClip`) for the undo buffer; `clear_clipboard` takes
  `keep_pinned`; new `paste_clipboard_multi` and `restore_clipboard`.
- Deleting a row no longer immediately deletes its picture file — orphans are
  swept by the next prune's garbage collection (differs from 0.2.14).

## [0.2.14] — 2026-08-05

Clipboard storage redesign + continuous bar navigation + expand-to-screen
(ROADMAP item 12).

### Changed

- **Clipboard storage** — the DB no longer stores copied data's original form.
  Image rows (screenshots / web bitmaps) now write a PNG into
  `data/PictureCache/<id>.png` and store the relative path; legacy image BLOBs
  are extracted to files on first launch. File/folder copies from Explorer (a
  CF_HDROP path list) are captured verbatim as one newline-joined `file` row —
  the files are never read or copied. Deleting an image row (or clearing all)
  removes its picture file too.
- **File entries work everywhere** — a `file` history row shows 「N 个文件」 (or
  the single file name), is searchable by path fragment, copies back by
  re-assembling a CF_HDROP, and auto-pastes by putting that list on the
  clipboard and sending Ctrl+V (pasting into Explorer copies the files in
  place — expected).
- **Continuous bar navigation** — on the empty-query main menu, ↑/↓ move across
  the 最近使用 / 已固定 bars as one grid, keeping the column when crossing the
  boundary; ←/→ stay within the current row. Works collapsed and expanded.
- **Expand fills the screen** — expanding a bar grows the window to show all of
  its content, capped at the monitor's work area (instead of the
  `window_height` setting) so it never runs off-screen.

## [0.2.13] — 2026-08-05

Clipboard auto-paste + copy button, follow-mouse position, interface extras
(ROADMAP item 11).

### Added

- **Clipboard auto-paste** — Enter on a clipboard entry (or 粘贴回 in the
  context menu) now writes the entry to the system clipboard, hides the
  launcher and sends `Ctrl+V` into the window that had focus **before** the
  launcher appeared (`paste_clipboard`). The pasted entry stays on the system
  clipboard afterwards (like a normal copy — 粘贴什么剪贴板就留着什么, so a
  just-pasted old entry is not masked by the previous content). The target
  window is recorded on every show and validated before pasting; with no target
  it degrades to a plain copy.
- **Per-row copy button** — each clipboard row gains a copy button (next to the
  trash button) that writes the entry back without pasting.
- **Follow-mouse position** — a new window-position preset 「跟随鼠标」 centers
  the launcher at the cursor on show, clamped to the active monitor. While
  active, content-height resizes keep the window at its spot instead of
  re-anchoring it.
- **Expand-pinned setting** — the interface pane gains a 「默认展开已固定」
  toggle (default off); when on, the pinned bar starts expanded on every show.
- **Shift+Enter admin** — the interface pane gains a 「Shift+Enter 以管理员
  身份启动」 toggle (default on); Shift+Enter on a selected app launches it
  elevated.
- **Synchronous settings injection** — Rust serializes the effective settings
  into `window.__LUME_CONFIG__` via a WebView2 initialization script, so the
  very first render reads persisted values (language, sizes, toggles)
  synchronously instead of racing the async settings IPC.

### Fixed

- **Search-grid keyboard navigation** — with a query typed, the arrow keys now
  always navigate the results grid, even when a stale bar `zone` is active, so
  ↑/↓/←/→ and Enter work correctly after returning from the empty-query bars.

## [0.2.12] — 2026-08-05

Recently-used bar + reworked pinned bar + interface settings (ROADMAP item 10).

### Added

- **最近使用 (Recent) bar** — the main menu now has a 「最近使用」 bar above the
  pinned bar, recording the last launches (apps **and** files) via the single
  `launch_app` chokepoint. Opens are deduped by path (re-opening bumps to the
  top) and pruned to a configurable cap (default 20), persisted in SQLite
  (`recent_apps`). The bar shows only one row by default; 展开 reveals the rest
  and the expanded state is **not** persisted — each launcher show resets to
  collapsed.
- **Reworked 「已固定」 bar** — the pinned bar now has the same titled,
  expandable structure: label + 展开/收起 header, one row collapsed, all rows
  expanded. Both bars reuse the main grid's entry-box sizing and columns.
- **Removed the empty-query browse grid** — the main menu is now exactly the two
  bars; typing a query shows the results grid as before. An empty main menu
  (no recents, no pins) shows a blank results area.
- **Remove from recent** — right-clicking a 「最近使用」 entry (or selecting one
  and pressing `Del`) removes it from the list. A soft delete: reopening the
  entry re-adds it, and the file/app itself is untouched. Sits in the context
  menu just before 以管理员身份启动.
- **Single instance** — Lume enforces a single running instance with a named
  mutex; launching a second copy (double-clicking the exe again) exits silently
  instead of starting a second process.
- **Interface settings order** — 「显示最近使用」 moved below 「最近使用条数」.
- **Interface settings** — 「显示最近使用」 toggle (default on), 「最近使用条数」
  cap (10 / 20 / 30), and custom search-box placeholders for the apps and
  clipboard modes (empty = localized default). All `#[serde(default)]`, so old
  settings load unchanged.
- **Keyboard navigation** — on the empty-query main menu, ↑/↓ cycle between the
  two bars and ←/→ move within the active bar; typed search keeps the existing
  grid navigation.

### Tests

- `recent.rs` unit tests for upsert-bump ordering, dedupe-by-path and cap
  pruning (`cargo test`, 35 passing).

## [0.2.11] — 2026-08-04

Live environment-variable synchronization (ROADMAP item 9).

### Added

- **Environment sync** — Lume now listens for system environment changes
  (`WM_SETTINGCHANGE` broadcast + registry-change notification on
  `HKCU\Environment` and the HKLM session-manager environment key) and refreshes
  its own process environment block, so apps and commands launched afterwards
  inherit the **fresh** PATH / variables instead of the ones frozen at startup.
  Event-driven and zero-CPU when idle — there is no registry polling. `PATH` is
  rebuilt as system + user (Windows concatenation order); `REG_EXPAND_SZ`
  values are expanded. Only newly started processes are affected, as Windows
  never rewrites a live process's environment.

## [0.2.10] — 2026-08-02

Auto-sizing launcher window.

### Added

- **Auto-sizing window** — the launcher window height now fits its content:
  few results shrink it, the full app grid grows it to a cap (520px) where it
  scrolls internally, and it stays centered. Width stays 720. Requires the
  `core:window:allow-set-size` / `allow-center` capabilities. The padding
  budget accounts for the results area padding and borders, so content that
  fits is shown **without a scrollbar**.

## [0.2.9] — 2026-08-02

### Changed

- **Removed the `Ctrl+P` pin shortcut** — pinning is now done through the
  right-click context menu (「固定/取消固定」), which existed for both apps
  and clipboard entries. The clipboard shortcut hint now reads just `Del
  delete`.
- **Disabled WebView2 built-in shortcuts** — browser accelerators (Ctrl+F
  find, Ctrl+P print, Ctrl+S save, Ctrl+R/F5 reload, F12/Ctrl+Shift+I
  DevTools, Alt+←/→ history, …) no longer work in the launcher. Lume's own
  keys (Tab, arrows, Enter, Esc, Del) and text editing in the search box
  (Ctrl+C/V/X/A/Z) are unaffected.
- **Removed the default focus outline** from the mode-switch pills and other
  buttons, so no white focus ring appears when Tab lands on them.
- **Auto-scroll only follows the keyboard** — hovering a partially-clipped
  row with the mouse no longer yanks the scroll position; arrow-key navigation
  still scrolls the selection into view.

## [0.2.8] — 2026-08-02

System tray icon with Restart / Exit.

### Added

- **Tray icon** — Lume now lives in the system tray. Left-click toggles the
  launcher; right-click shows a menu with 「重启」/「关闭」 (Chinese systems) or
  Restart / Exit. Restart uses Tauri's built-in `request_restart`; Exit uses
  `app.exit(0)`.

## [0.2.7] — 2026-08-02

Pinyin search for Chinese app names (ROADMAP item 5).

### Added

- **Pinyin search** — Chinese app names are indexed with their full pinyin
  and pinyin initials at scan time. Typing `kuake` or `kk` finds 「夸克」;
  `wanmei` finds 「完美解码」. Pinyin matches are weighted slightly below
  exact name matches. The pinyin fields are search aids only and are not sent
  to the frontend. English search is unaffected.

## [0.2.6] — 2026-08-02

Custom right-click context menu.

### Added

- **Custom context menu** — right-clicking an app box shows 「固定/取消固定 ·
  启动」; right-clicking a clipboard entry shows 「复制回剪贴板 · 固定/取消固定 ·
  删除」. The menu follows the cursor, dismisses on `Esc` / click-outside /
  right-click-outside, and is styled to match the launcher.
- **Default WebView2 menu disabled** — the browser-style context menu no
  longer appears anywhere in the launcher.

## [0.2.5] — 2026-08-02

Navigate pinned bar (ROADMAP item 3) + smaller grid boxes.

### Added

- **Pinned bar** — a distinct strip of pinned apps sits above the Navigate
  main-menu grid. `Ctrl+P` pins/unpins the selected app; `↑` enters the bar
  from the grid's first row, `←`/`→` move within it, `↓` returns to the grid.
  Pins persist in `lume.db` (`pinned_apps` table, WAL-enabled), shown only on
  the empty-query main menu.
- **Smaller grid boxes** — the Navigate grid now uses 6 columns with 48px
  tiles (was 5 × 56px), and the box padding was tightened.

### Fixed

- **Blank Navigate on first launch** — the main-menu grid is now populated in
  `onMount` instead of relying solely on the window-focus event. If the window
  was shown before the webview finished loading (and the async focus listener
  wasn't registered yet), the grid used to stay empty until re-shown.

## [0.2.4] — 2026-08-02

Real application icons (ROADMAP item 2).

### Added

- **Real app icons** — the Navigate grid now shows each app's actual icon
  instead of a colored letter tile. Icons are extracted via the Windows shell
  (`IShellItemImageFactory`) at 64px for HiDPI crispness.
- **In-memory icon cache** — extracted icons live in a process-level cache
  keyed by path (backend `IconCache` + a frontend `Map`), so re-viewing a
  result set never re-extracts. **Icons are not persisted to SQL** (per
  project constraint).
- **Progressive loading** — letter tiles render immediately, then icons load
  in batches of 20 and swap in.
- **Path fix** — Start Menu paths now use consistent backslashes; mixed
  separators broke `SHCreateItemFromParsingName` (E_INVALIDARG) and
  `ShellExecuteW`.
- **Tests** — icon extraction against real Start Menu shortcuts (`cargo test`,
  20 passing).

## [0.2.3] — 2026-08-02

Internationalization (i18n).

### Added

- **i18n** — all UI strings now come from a centralized table in
  `src/i18n.ts` supporting **Simplified Chinese**, **Traditional Chinese** and
  **English**. The active locale is detected from the system language
  (`navigator.language`); `setLocale` is reserved for the future settings
  page. Covers the search placeholder, mode pills, hints, shortcut footer,
  settings/delete tooltips and the clipboard image label.

### Fixed

- **Mode-switch query cross-talk** — each mode now keeps its own independent
  search query, so clearing or typing in Clipboard no longer wipes Navigate's
  view (and vice-versa). Switching back to Navigate no longer shows the full
  main-menu grid when a filtered query was in effect.
- **App index pre-warm** — the Start Menu index is scanned on a background
  thread at startup, so the main-menu grid and first search appear instantly
  instead of after a slow one-time scan.

## [0.2.2] — 2026-08-02

Interaction fixes + Navigate grid + project roadmap.

### Fixed

- **Keyboard & mouse navigation** — results are now selectable with the mouse
  (hover selects, click activates) and keyboard arrows work reliably in both
  modes; the search input is re-focused on every launcher show. Navigation
  keys are handled at the window level, so a stray click that blurs the input
  no longer kills the arrow keys, and the selected result auto-scrolls into
  view.
- **Scrollbars** — the results containers now use a modern thin rounded
  scrollbar instead of the default chunky one.
- **Auto-hide on focus loss** — the launcher dismisses itself whenever it
  loses focus (clicking elsewhere), replacing the toggle-off behavior.
- **Per-entry delete** — the Clear button is gone; each clipboard row now has
  a trash button that deletes that entry.
- **Navigate label** — the first mode pill is now "Navigate".

### Added

- **Navigate grid** — the main menu renders apps as a 5-column grid of
  square boxes (letter tile + name). Empty query browses all apps; arrow keys
  navigate in four directions; hover selects; click launches. Long names are
  clipped, tracks use `minmax(0, 1fr)` so nothing overflows the right edge.
- **Visible selection** — the selected grid box / clipboard row gets an
  accent border and a stronger highlight.
- **Settings button** — a placeholder gear button sits next to the mode
  switch (page comes in a later iteration).
- **Roadmap** — `docs/ROADMAP.md` records upcoming work (i18n, real icons,
  Navigate pinned bar, plugin system).
- **Test** — `search_apps` empty query returns the full name-sorted index
  (`cargo test`, 18 passing).

## [0.2.1] — 2026-08-02

Clipboard enhancements: pin / delete / clear, and image history.

### Added

- **Images** — the listener captures images from the clipboard (RGBA → PNG
  blob stored in SQLite). Image rows show a downscaled thumbnail tile and
  `Enter` writes the original back to the clipboard. Consecutive duplicates
  are skipped via an in-memory hash.
- **Pin** — `Ctrl+P` toggles the pin flag on a clipboard entry. Pinned items
  sort to the top and are exempt from pruning.
- **Delete** — `Del` removes the selected clipboard entry.
- **Clear all** — a "Clear" button (two-step confirm) in clipboard mode wipes
  the history.
- **Schema migration** — the clipboard table gains `kind` / `data` / `pinned`
  columns; existing text history is migrated in place without data loss
  (`content` uniqueness now enforced by a partial index on text rows only).
- **Shortcut hint** — clipboard mode shows a footer with the active keys.
- **Tests** — migration, image round-trip/thumbnail, pin ordering & prune
  exemption, delete and clear (`cargo test`, 17 passing).

## [0.2.0] — 2026-08-02

Clipboard manager. Lume now captures, persists and re-copies clipboard history,
backed by SQLite — the database foundation declared in the README tech stack.

### Added

- **Clipboard capture** — a background thread polls the Windows clipboard
  sequence number (250 ms) and stores new text in SQLite
  (`src-tauri/src/clipboard.rs`). Own writes from `copy_clipboard` are skipped.
- **SQLite persistence** — history lives in `app_data_dir()/lume.db`
  (`rusqlite`, bundled). Re-copying existing text bumps it to the top instead
  of duplicating; the store is pruned to the 300 most recent entries.
- **Clipboard search mode** — `Tab` (or the pills in the search row) toggles
  between **Apps** and **Clipboard** modes. Clipboard mode searches history
  (case-insensitive substring, most recent first); an empty query browses the
  recent history.
- **Copy back** — `Enter` on a clipboard result writes it to the system
  clipboard and hides the launcher.
- **Clipboard UX** — muted clipboard-icon tiles and single-line content
  previews, per-mode placeholder and hint text.
- **Tests** — storage tests for upsert recency, pruning and substring search
  (`cargo test`, 11 passing).

## [0.1.0] — 2026-08-02

First working launcher. Core v0.1 delivers the launcher popup, the global
toggle shortcut and app search & launch — everything needed to use Lume as a
daily driver app launcher.

### Added

- **Global toggle shortcut** — `Alt+Space` preferred, auto-fallbacks to the
  next free combination (`Ctrl+Space`, `Ctrl+Alt+Space`) when another app owns
  the key. The active combo is shown in the launcher hint.
- **Application search** — walks the per-user and all-users Start Menu
  `Programs` folders for `.lnk` shortcuts, deduped by name and name-sorted.
- **Fuzzy matching** — case-insensitive subsequence scorer rewarding prefix,
  word-boundary and consecutive-run matches; returns the top 8 results.
- **Launch** — `.lnk` shortcuts opened via `ShellExecuteW`.
- **Keyboard navigation** — `↑`/`↓` select (wraps), `Enter` launches, `Esc`
  hides.
- **Window lifecycle** — hidden at startup, centered and focused on show,
  Acrylic frosted-glass backdrop, query cleared on each invocation.
- **Documentation** — `CLAUDE.md`, `docs/RULES.md`, `docs/ARCHITECTURE.md`,
  `docs/UI_GUIDELINES.md`, `docs/TESTING.md`.
- **Tests** — Rust unit tests for the fuzzy scorer and the Start Menu scan.
