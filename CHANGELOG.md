# Changelog

All notable changes to Lume are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versions follow
[semantic versioning](https://semver.org/).

## [Unreleased]

### Added

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

### Fixed

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
  无新后端命令。Office 与 压缩包 预览按决策放弃。见 `docs/ROADMAP.md` #16。
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
  `docs/ROADMAP.md` #15。
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
