# Lume 交互逻辑专项审计（第 4 份）

> 基线：`main` @ `13d7f7e`，版本 `2.8.0`，审计日期 2026-10-17。
>
> 范围：启动器主窗口、空查询栏目、搜索结果、剪贴板、设置窗口、自动化选择器、设置导入/恢复、插件页与现有 CDP 回归。
>
> 方法：阅读 `ARCHITECTURE.md` / `UI_GUIDELINES.md` / `SETTINGS.md` / `PLUGIN_API.md` / `TESTING.md`；用当前源码构建 debug/release exe；通过 CDP 发送真实鼠标与键盘事件、隔离测试夹具和可回滚设置文件复现；同时做状态机与异步链路静态审计。`test/` 下的探针属于本机 scratch，不入库。

## 结论摘要

| 编号 | 严重度 | 问题 | 证据 |
|---|---|---|---|
| 交互-01 | 高 | 栏目收起后仍保留第二行的隐藏选择，`Enter` 会启动不可见条目 | 运行复现 |
| 交互-02 | 高 | 设置草稿保存时会覆盖期间发生的实时插件开关和其他轻量写入 | 运行复现 |
| 交互-03 | 高 | 导入设置 / 恢复备份没有触发热应用，设置页与实际运行状态分裂 | 运行复现 |
| 交互-04 | 高 | 启动、粘贴、终端、复制路径先隐藏再等待结果，失败提示不可见 | 运行复现 + 代码确认 |
| 交互-05 | 中 | 点击模式胶囊、剪贴板分类、展开按钮后搜索框失焦，后续直接输入丢失 | 运行复现 |
| 交互-06 | 中 | 全局占用 `Tab`，键盘用户无法把焦点移到设置、分类、暂停/清空、撤销等控件 | 代码确认 |
| 交互-07 | 中 | 自动化程序选择器的焦点可逃到背景，关闭后也不返回触发按钮 | 运行复现 |
| 交互-08 | 中 | 文件搜索后端不可用提示会被「无结果」覆盖 | 静态确认 |
| 交互-09 | 低 | 自动化快捷键录制取消缺少代次保护，校验结果可能在取消后提交 | 静态确认，时序窗口窄 |

整体判断：当前实现的功能覆盖和既有自动化回归较强，但存在两类系统性问题。

1. **“视图状态”和“真实状态”可能分离**：隐藏选择仍可执行、设置草稿覆盖实时写入、导入后启动器不刷新。
2. **“交互完成后由谁持有焦点/何时关闭”没有统一契约**：鼠标控件抢焦点、全局 Tab 又阻断焦点导航；动作先隐藏、结果后返回，失败只能写进不可见日志或已隐藏窗口的 toast。

---

## 交互-01 收起栏目后仍可启动隐藏条目

**严重度：高。是可导致“看不见的目标被启动/执行”的状态越界。**

### 复现

1. 准备 9 个固定应用，使已固定栏在 720px 窗口下每行 6 个、共两行。
2. 展开「已固定」栏。
3. 鼠标移到第二行第 1 个条目，使其成为选中项。
4. 点击「收起」。
5. 不移动鼠标，直接按 `Enter`。

### 实测

```json
{
  "firstRowCount": 6,
  "visibleExpanded": 9,
  "selectedSecondRow": 6,
  "afterCollapse": {
    "rendered": 6,
    "selected": -1,
    "focus": "BUTTON:bar-expand"
  },
  "physicalMarkerExists": "launched-6"
}
```

收起后 DOM 只剩 6 个条目，没有任何高亮；但 `Enter` 仍执行了索引 6 的隐藏条目。夹具用 `.cmd` 写入标记文件，未启动真实用户程序。

### 根因

- `src/plugins/navigate/store.ts:179`、`:206`、`:236` 的展开切换只翻转信号，没有收缩该栏的 selection。
- `src/plugins/navigate/store.ts:282` 的 `activeSection()` 仍返回该栏。
- `src/plugins/navigate/search.ts:394` 的 `activate()` 直接执行 `sec.activate(sec.selected(), elevated)`。
- `src/plugins/navigate/store.ts:545` 的键盘移动虽然会在移动时用 `reach()` 收缩，但“收起”本身不会触发这次修正。

### 建议

- 为每个栏目定义唯一的 `visibleReach()`，在展开切换、列表刷新、插件栏重载、窗口列数变化和激活前都使用它。
- 收起时把 selection 收缩到 `0 .. visibleReach-1`；如果当前项被隐藏，建议回到当前栏第一项。
- 激活前再校验一次 `selected < visibleReach`，避免任何未来入口重新引入同类越界。
- 回归用例应直接断言“收起后 Enter 不产生 launch 调用”，而不是只检查 DOM 高亮。

---

## 交互-02 设置草稿覆盖实时插件开关

**严重度：高。用户会看到一次操作先生效、保存后又被静默撤销。**

### 复现

1. 打开设置 → 外观，切换颜色模式，使页脚「保存并应用」变为可用。
2. 不保存，切到「插件」。
3. 把内置「卫星预览」从启用切到停用（插件启停是即时轻量写）。
4. 点击「保存并应用」。

### 实测

```json
{
  "dirty": true,
  "afterToggle": { "color": "light", "disabled": ["preview"] },
  "saveEnabled": true,
  "afterSave": { "color": "dark", "disabled": [] },
  "pluginAfterSave": true
}
```

颜色从 `light` 变为 `dark`，证明保存确实成功；但刚停用的 `preview` 又被重新启用。原因是保存的是打开设置时的旧完整快照。

### 根因

- `src/settings/Settings.tsx:294` 的 `saveAndClose()` 把整个 `settings()` 工作副本交给 `save_settings`。
- `src/settings/PluginsPane.tsx:202` 的插件启停走 `set_plugin_enabled`，直接写当前后端状态并广播刷新，但不会更新 `Settings` 组件里的工作副本。
- `src-tauri/src/settings.rs:725` 的 `save_settings` 用传入的 `new` 整包覆盖内存和文件。

同类风险还覆盖 `plugins.dev_mode`、`plugins.trust_all`、`keep_session_overrides`、插件窗口几何、插件主题偏好，以及运行期间由其他窗口触发的 `save_last_page`、`set_remember_checks` 等轻量写。

### 相关交互问题

设置窗口点击右上角关闭后仍保留 `dirty=true` 和工作副本；再次打开不会重载，页脚仍显示「保存并应用」可用。这会让用户以为旧草稿只是暂时关闭，后续一次保存却可能覆盖期间发生的即时修改。语言和主题又会在草稿态即时预览，导致设置窗与启动器出现不同外观。

### 建议

- 根治方式是拆分写接口：外观、快捷键、索引、剪贴板、自动化各自 patch，不再由设置窗覆盖整张表。
- 最低成本修复：`save_settings` 只合并设置窗实际编辑过的 section；或者在任何轻量写发生后同步更新设置窗工作副本，并保留 revision / mtime 冲突检查。
- 关闭有未保存改动的设置窗口时应明确提示“保存 / 丢弃 / 继续编辑”，不要既保留草稿又不提示。
- 回归覆盖“改外观 → 即时停用插件 → 保存”的顺序，断言插件仍停用。

---

## 交互-03 导入设置与恢复备份不热应用

**严重度：高。设置页会报告成功，但启动器仍按旧配置运行。**

### 复现

1. 准备一份 `entry_size = 200` 的完整设置文件。
2. 启动器当前 `entry_size = 110`，根元素 CSS 变量为 `110px`。
3. 调用设置页的导入命令。
4. 等待 1.8 秒后同时读取后端设置与启动器 CSS 变量。

### 实测

```json
{
  "before": { "persisted": 110, "css": "110px" },
  "afterImport": { "persisted": 200, "css": "110px" },
  "afterDelay": { "persisted": 200, "css": "110px" }
}
```

后端已经是 200，启动器仍按 110px 渲染。没有延迟到达的刷新事件。

### 根因

- `src-tauri/src/settings.rs:774` 的 `import_settings` 只写文件并替换 `SettingsState`，没有 `AppHandle`、没有发射 `settings-applied`。
- `src-tauri/src/settings.rs:799` 的 `restore_backup` 同样只替换文件和内存。
- `src/settings/SystemPane.tsx:225`、`:254` 只调用 `props.onReload()`，重载的是设置窗自己的工作副本，不会刷新主窗口、热键、索引 watcher、dedup 索引或窗口几何。
- 对比 `src-tauri/src/settings.rs:725` 的 `save_settings`，真正的应用副作用都在保存路径里。

### 建议

- 抽出统一的 `apply_runtime_settings`：写盘后执行窗口宽度/位置、热键重注册、dedup 索引重建、索引刷新、目录 watcher、插件 dev watcher，最后广播 `settings-applied`。
- `save_settings`、`import_settings`、`restore_backup` 全部复用该收口；不要只补一行事件而遗漏热键和索引副作用。
- 导入/恢复前若设置窗有脏草稿，应先提示冲突，避免刚导入的配置又被旧草稿覆盖。
- 回归应覆盖主题、字号、宽度、呼出热键、索引目录五类导入值。

---

## 交互-04 操作先隐藏后校验，失败不可见

**严重度：高。用户会把“启动器消失”理解为操作成功。**

### 已复现：应用打开失败

把不存在的路径固定到「已固定」栏，点击该磁贴：

```json
{
  "visibleBefore": true,
  "found": true,
  "visibleAfter": false,
  "toast": null,
  "toastUndo": false
}
```

`launch_app` 实际返回 `ShellExecuteW failed with code 2`，但主窗口已隐藏，界面没有任何错误提示。

### 代码中的同类路径

- `src/plugins/navigate/store.ts:489` 的非提权启动：发起 `launch_app` 后立即 `resetAndHide()`，没有 `catch` 或错误 toast。
- `src/plugins/clipboard/store.ts:184` 的单条粘贴、`:201` 的合并粘贴：无论后端成功或失败，只要「粘贴后关闭」开启就立即隐藏；后端失败 toast 会出现在已经隐藏的窗口里。
- `src/plugins/clipboard/store.ts:241` 的链接打开也没有等待结果。
- `src/plugins/navigate/store.ts:518` 的资源管理器栏：注释写明“复制路径保持打开并显示 toast”，但代码在发起 `copy_path` 后无条件 `resetAndHide()`；成功和失败提示都不可见。
- 终端打开失败只写 `console.error`，同样先隐藏。

粘贴还有一个语义问题：后端在没有可粘贴目标窗口时会降级为“只复制”，但前端仍显示「已粘贴」并按成功路径关闭窗口。用户无法知道内容没有进入目标应用。

### 建议

- 将动作统一改成“先执行、后关闭”：成功且属于启动类动作才隐藏；失败时保持窗口并显示可操作错误。
- 复制类动作（复制路径、复制剪贴板条目、链接管理）默认保持启动器打开；即使产品决定复制后关闭，也必须先显示清楚的结果或设置明确的关闭策略。
- 后端返回结构化结果，至少区分 `pasted`、`copied_without_target`、`launch_failed`、`uac_canceled`，不要只依赖字符串或裸异常。
- 为 `launch_app`、`paste_clipboard`、`copy_path`、`open_terminal_in_folder` 补失败分支回归；可通过无效路径和夹具进程安全测试。

---

## 交互-05 点击控件后搜索框失焦，直接输入丢失

**严重度：中。启动器的核心交互是“呼出后直接键入”，焦点丢失会直接打断工作流。**

### 复现与实测

启动器呼出时焦点在 `#search-input`。用真实鼠标点击：

- 「剪贴板」模式胶囊后：`document.activeElement` 变为 `BODY`；随后输入 `def`，搜索框仍为旧值。
- 剪贴板「文本」分类后：焦点变为对应的 `.clip-cat` 按钮；随后输入 `ghi`，搜索框仍为旧值。
- 栏目「展开 / 收起」后：焦点落在 `.bar-expand`，同样无法继续直接搜索。

### 根因

模式胶囊、剪贴板分类、栏目展开按钮只处理 `onClick`，没有在动作后归还搜索框焦点；主窗口只有呼出、上下文菜单关闭等少数路径会调用 `search-input.focus()`（`src/App.tsx:431`、`:957`、`:1080`）。

### 建议

- 定义统一的“命令型控件”契约：鼠标完成模式切换、分类切换、展开/收起、暂停/清空、撤销后，由外壳恢复搜索框焦点。
- 对确实需要保留焦点的控件（输入框、确认对话框、程序选择器）显式标记为焦点作用域，不要全局抢回。
- 可在搜索行与页面空白区域增加 pointerdown 兜底：非交互区域被点击时焦点回到搜索框。
- 回归使用真实 `Input.dispatchMouseEvent` + 真实 `Input.dispatchKeyEvent`，不能只用 `element.click()` 和 `Input.insertText`，后者会把文字送进最后的文本输入框，从而掩盖焦点丢失。

---

## 交互-06 全局 `Tab` 阻断键盘焦点导航

**严重度：中。键盘优先的启动器目前无法仅靠键盘到达多个必要控件。**

`src/launcher/keyboard.ts:106` 先把 `Tab` 当作模式切换键并 `preventDefault()`；`src/launcher/types.ts:174` 又把 `Tab` 列为应用自有键，浏览器默认焦点遍历不会执行。

结果是键盘用户无法按常规方式到达：

- 设置齿轮；
- 模式胶囊；
- 剪贴板分类按钮；
- 「暂停 / 恢复记录」「清空历史」；
- 删除后的「撤销」按钮；
- 栏目「展开 / 收起」；
- 右键菜单中的固定、打开位置、以管理员身份启动等动作（菜单本身也没有键盘打开入口）。

部分功能有方向键替代，但暂停、清空、撤销和设置没有等价入口。`Shift+Tab` 也仍按普通 `Tab` 匹配，无法反向遍历。

### 建议

- 保留单键 `Tab` 作为可选快捷切换，但提供不占用浏览器焦点遍历的模式；例如默认改为 `Ctrl+Tab`，或增加 `F6` 在“搜索框 / 模式栏 / 页面控件”之间循环。
- `Shift+Tab` 至少要能反向移动，不能继续触发正向模式切换。
- 为清空、暂停、撤销、打开设置提供明确快捷键，并让右键菜单可由 `Shift+F10` 或专用键打开。
- 如果继续占用 `Tab`，应在设置中明确这是无障碍取舍，并补完整的键盘替代路径。

---

## 交互-07 自动化程序选择器焦点逃逸且不返回

**严重度：中。模态层看起来覆盖了页面，但键盘实际仍可操作背景。**

### 复现

1. 设置 → 自动化 → 「选择」。
2. 选择器打开后焦点在筛选框。
3. 连续按 `Tab`。

### 实测

焦点顺序为先经过关闭按钮、程序行，然后在第 7 次 `Tab` 时离开 `.picker`，落到背景页脚的「恢复默认设置」。按 `Esc` 关闭后，焦点仍停在背景页脚按钮，没有返回触发「选择」的按钮。

### 根因

`src/settings/ProgramPicker.tsx:31` 只做了初始聚焦和 `Escape` 监听；没有焦点圈定、背景 `inert`/`aria-hidden`、关闭后的焦点恢复，也没有 `aria-modal="true"`。

### 建议

- 复用剪贴板清空确认框的焦点陷阱思路，首尾循环 `Tab` / `Shift+Tab`。
- 打开时记录 trigger，关闭时无条件恢复；背景设置内容设置 `inert` 或等价屏蔽。
- 给程序列表补方向键移动与 `Enter` 选择，避免只能连续按 Tab。
- 回归应检查“最后一个可聚焦元素之后按 Tab 仍留在对话框内”和“Esc 后 activeElement === trigger”。

---

## 交互-08 文件搜索后端不可用提示被「无结果」覆盖

**严重度：中。用户无法区分“没有匹配文件”和“搜索后端不可用”。**

`examples/plugins/file-search/view.html:99` 在 `backend === "none"` 时设置提示文案和 `hint.style.display = "block"`，但紧接着调用 `render()`。`render()` 在 `:69` 先执行 `hint.style.display = "none"`，再在 `:71` 把列表内容替换成「无结果」。

因此后端为 `none` 时，用户看到的是「无结果」，而真正可操作的「需要运行 Everything 或启动 LumeSVC」被隐藏。

### 建议

- 将“空态原因”作为显式状态值传给 `render(reason)`，不要在设置 DOM 文案后再次调用一个会无条件覆盖它的函数。
- 后端不可用、索引构建中、搜索中、查询无匹配应是四个独立空态。
- 补一个 `search.files -> { backend: "none" }` 的夹具回归，并按渲染文本断言，而不是只看行数。

---

## 交互-09 自动化快捷键录制的取消竞态

**严重度：低到中。时序窗口窄，但取消语义不可靠。**

`src/settings/ComboRecorder.tsx:36` 的 `stop()` 只清除 `recording` 和 `error`；`:48` 发起异步 `validate_auto_combo`，回调在 `:55` 直接 `props.onCommit(combo)`，没有检查录制是否已经被 Esc、失焦或第二次点击取消。

同一仓库的 `src/settings/HotkeysPane.tsx:36` 已使用 `captureSeq`：停止时递增、异步返回后比较代次。自动化录制器缺少这层保护，因此校验较慢时可能在取消后仍提交，甚至把错误写回已经关闭的录制态。

### 建议

- 给 `ComboRecorder` 补与 `HotkeysPane` 相同的 `captureSeq`；`stop()`、再次点击、失焦和组件卸载都递增。
- 异步回调在成功、失败和异常三个分支都先检查代次。
- 测试可给 `validate_auto_combo` 注入延迟，断言取消后不会调用 `onCommit`。

---

## 建议处理顺序

1. 先修交互-01：隐藏选择可执行是 state 越界，风险高于普通易用性问题。
2. 再修交互-02、交互-03：它们会造成配置被静默回滚或“设置成功但没生效”，排障成本最高。
3. 接着修交互-04：把“先隐藏后执行”改成统一结果模型，能一次修复多条动作链路。
4. 然后建立焦点契约并修交互-05、交互-06、交互-07。
5. 最后处理交互-08、交互-09 与下述待复核项。

## 回归建议

- 为栏目收起补“隐藏选择不可激活”测试，覆盖最近使用、已固定、推荐使用和插件贡献栏。
- 为设置工作副本补“脏草稿 + 任一即时轻量写 + 保存”的冲突测试。
- 为导入、恢复备份补“文件值已变且启动器首帧已刷新”的端到端测试。
- 为所有命令型鼠标控件补真实鼠标点击后直接键入的焦点测试。
- 为自动化程序选择器补焦点陷阱和焦点返回测试。
- 对启动、粘贴、复制路径、终端打开分别构造失败，断言窗口保持打开且错误可见。
- 保留现有 CDP 回归作为基线，但新增测试要优先断言“用户可见结果”和“后端实际状态”，不能只断言 DOM 类名或静态行数。

## 验证覆盖

### 构建与静态检查

- `pnpm exec tsc --noEmit`：无报错。
- `pnpm run build`：通过。
- `cd src-tauri && cargo check`：通过。
- `cd src-tauri && cargo test`：220 passed / 9 ignored / 0 failed。
- `pnpm run tauri build --debug --no-bundle`：通过。
- `pnpm run tauri build --no-bundle`：通过。

### 既有 CDP 回归

- `node scripts/cdp_settings_smoke.mjs`：全部检查项无失败。
- `node scripts/cdp_clipboard_smoke.mjs`：完成分类、虚拟列表、多选和空态检查。
- `node scripts/cdp_mode_query_verify.mjs`：47/47。
- `node scripts/cdp_plugin_state_verify.mjs`：54/54。
- `node scripts/cdp_plugin_window_verify.mjs`：16/16。

### 新增本机探针

- `test/audit_collapse_activation3.mjs`：收起栏目后按 Enter 触发隐藏条目标记文件。
- `test/audit_settings_draft_probe.mjs`：脏草稿保存覆盖即时插件停用。
- `test/audit_import_apply.mjs`：导入后持久值 200、启动器 CSS 仍为 110。
- `test/audit_launch_failure.mjs`：无效启动路径导致窗口隐藏且无 toast。
- `test/audit_interaction_probe2.mjs`：模式胶囊与分类点击后真实键入丢失。
- `test/audit_picker_focus.mjs`：程序选择器 Tab 逃逸与关闭后焦点不返回。
- `test/audit_combo_cancel_race.mjs`：录制器取消链路的时序探针。

## 待手工复核

- **UAC 取消与失焦自动隐藏**：`src-tauri/src/lib.rs:248` 的失焦即隐藏逻辑只豁免窗口拖动、粘贴关闭抑制和预览点击；提权启动路径没有设置抑制。`docs/TESTING.md` 的手工项要求“取消 UAC 后不隐藏启动器”，两者存在冲突，建议在真实 UAC 桌面下复核取消与拒绝两种路径。
- **发行版热键冲突反馈**：`src-tauri/src/hotkey.rs:52` 在注册失败时只写 `eprintln!`；release exe 无控制台，普通用户只能看到“呼出键没反应”。托盘 → 设置仍可达，但建议增加托盘气泡或设置页顶部持续状态，而不是只依赖日志。
- **应用级本地化一致性**：托盘菜单仍只按系统语言在简体中文/英文间选择；预览窗口的 PDF 控件标题存在硬编码中文。它们不影响上述交互链路，但会放大“界面语言已切换”的不一致感。

## 备注

本报告不包含业务代码修改。所有运行探针均已尽力恢复设置文件、固定项与进程；生成的本机截图和夹具位于 gitignored 的 `test/`。


