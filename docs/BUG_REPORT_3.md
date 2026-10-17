# Lume UI 独立缺陷报告（第 3 份）

> 审查基线：`main` / `7dc0cb0`（2026-10-17）
> 审查范围：启动器搜索行、导航页、剪贴板页、设置窗口、上下文菜单、模式栏、插件启停后的界面状态
> 环境：Windows 11 build 26200，150% DPI，简体中文界面；release 与 debug 内嵌前端均用于实测
> 说明：按要求不把既有 `docs/BUG_REPORT.md`、`docs/BUG_REPORT_2.md` 的问题混入本报告。本轮未改动业务代码，结论来自静态审查和可重复的界面探针。

## 结论摘要

本轮确认 12 个可复现的 UI/交互问题，其中 4 个会造成明显误操作或数据风险：

- 剪贴板页的 `Space`、`Delete` 会从搜索框夺走编辑语义；`Delete` 会直接删除剪贴板历史条目。
- 输入法组合态没有隔离，`Space`、方向键、`Enter` 可能在候选词尚未提交时触发启动器动作。
- 插件清单刷新没有“新请求覆盖旧请求”的保护；启动早期启用插件时，界面可能永远看不到新 mode 与关键词入口，直到再次刷新或重启。
- 上下文菜单与“清空剪贴板”确认框没有隔离后台键盘路由；菜单打开时方向键会移动后台选中项，确认框打开时 `Esc` 不会关闭确认框。

| 编号 | 严重度 | 区域 | 问题 |
|---|---|---|---|
| UI-01 | 高 | 剪贴板搜索 | `Space` / `Delete` 被页面快捷键劫持，`Delete` 会删除历史条目 |
| UI-02 | 高 | 输入法 | 组合态未忽略，候选词提交键会触发页面动作 |
| UI-03 | 高 | 插件 UI | 并发清单刷新可让已启用插件在界面中消失 |
| UI-04 | 高 | 浮层键盘 | 上下文菜单与确认框不隔离后台操作 |
| UI-05 | 中 | 上下文菜单 | 底部弹出时按固定高度夹取，菜单被窗口裁切 |
| UI-06 | 中 | 设置窗口 | 最小宽度下自动化规则行横向溢出，右侧控件不可见 |
| UI-07 | 中 | 模式栏 | 插件较多或名称较长时，模式栏把搜索框和设置按钮挤出窗口 |
| UI-08 | 中 | 剪贴板多选 | 删除已选条目后仍保留“已选 N 条”的陈旧状态 |
| UI-09 | 中 | 快捷键录制 | 录制器失焦后仍拦截设置搜索框输入 |
| UI-10 | 中 | 文本编辑 | `Ctrl+Backspace` 等标准编辑键被浏览器快捷键拦截器误杀 |
| UI-11 | 中 | 设置搜索 | 多个新增设置项搜不到，且无“无匹配结果”提示 |
| UI-12 | 低 | 剪贴板悬停 | 键盘导航后，悬停选中无法恢复，直到用户点击 |

---

## UI-01 剪贴板搜索框中的 `Space` / `Delete` 被页面快捷键劫持

**严重度：高。`Delete` 会造成历史记录误删。**

### 现象

在剪贴板模式中，搜索框获得焦点时：

- 按 `Space` 不输入空格，而是把当前行加入多选。
- 按 `Delete` 不执行文本前向删除，而是删除当前选中的剪贴板历史条目。

### 复现

1. 呼出启动器，切到“剪贴板”。
2. 在搜索框输入一个能命中结果的词，例如 `e`。
3. 保持搜索框焦点，按 `Space`。
4. 清空/改写搜索词，按 `Delete`。

### 实测结果

- `Space` 后输入框仍然是 `e`，状态栏变成“已选 1 条”，出现 1 个多选标记。
- `Delete` 后输入框仍是 `LUME`，同时出现“已删除 1 条 撤销”提示，证明删除的是剪贴板条目而不是搜索文字。
- 复现脚本随后点击“撤销”恢复了被删除条目。

### 代码依据

- `src/plugins/clipboard/index.tsx:23-45`：`onKey` 对 `Space` 和 `Delete` 直接处理，没有检查事件目标是否为输入框。
- `src/launcher/keyboard.ts:78-97`：全局键盘路由先调用页面 `onKey`，再处理共享按键，没有“可编辑目标”例外。
- `src/shell/SearchBox.tsx:63-72`：搜索框使用全局 `#search-input`，按键会冒泡到窗口路由。

### 建议修复

在全局路由与页面 `onKey` 的入口统一判断：

```ts
const editing =
  e.target instanceof HTMLInputElement ||
  e.target instanceof HTMLTextAreaElement ||
  (e.target instanceof HTMLElement && e.target.isContentEditable);
```

编辑搜索框时，页面快捷键只应处理启动器明确保留的动作（如 `ArrowUp/Down` 切换结果、`Enter` 激活）；`Space`、`Delete`、`Backspace`、方向键等编辑语义应保留给输入框。更稳妥的做法是给 `ModeKeyContext` 增加 `editing` 字段，由根路由计算并传入。

---

## UI-02 输入法组合态未隔离

**严重度：高，影响中文、日文、韩文等 IME 用户。**

### 现象

键盘路由没有检查 `KeyboardEvent.isComposing`。在输入法候选词尚未提交时：

- `Space` 可能被剪贴板页当作多选键。
- `Enter` 可能直接激活当前结果。
- 方向键可能移动结果选择而不是在候选词列表中导航。

### 复现

向搜索框派发一个 `isComposing=true` 的空格键事件：

- 事件被 `preventDefault()`，返回 `notPrevented=false`。
- 剪贴板页从“未选择”变成“已选 1 条”。

### 实测结果

```json
{
  "notPrevented": false,
  "count": "已选 2 条",
  "badges": 1,
  "isComposing": true
}
```

### 代码依据

- `src/launcher/keyboard.ts:49-99`：没有 `e.isComposing` 判断。
- `src/plugins/clipboard/index.tsx:23-45`：页面快捷键同样没有组合态判断。
- `src/launcher/types.ts:174-180`：已把多组动作键列为启动器保留键，但组合态不在判定条件中。

### 建议修复

在全局键盘路由顶部增加统一守卫：

```ts
if (e.isComposing || e.keyCode === 229) return;
```

页面级 `onKey` 也应采用同一守卫，避免未来新增模式重复犯错。输入框的普通文本输入不应被拦截。

---

## UI-03 插件清单刷新存在旧响应覆盖新状态

**严重度：高。插件在设置中显示已启用，但 UI 中完全不出现。**

### 现象

应用启动早期启用一个原本停用的 mode 插件后：

- 后端 `get_plugins` 返回 `enabled=true`。
- 前端仍没有该 mode 的胶囊，也没有它的关键词入口。
- 等待数秒后状态仍不恢复。
- 同样的操作如果延迟到初始化完成后再执行，则表现正常。

### 复现与对照

使用一个合法的临时 mode 插件，启动时保持其停用：

| 操作 | 后端报告启用 | 模式胶囊 | 关键词入口 |
|---|---:|---:|---:|
| 启动后立即启用 | 是 | 不出现 | 不出现 |
| 启动 3 秒后启用 | 是 | 出现 | 出现 |

该对照重复执行后结果一致。

### 对既有验证的影响

`node scripts/cdp_mode_query_verify.mjs` 连续两次得到 41/47，其中 6 项失败集中在“启用临时 mode 后的关键词行进入”流程。失败项包括关键词行不存在、无法激活目标 mode、共享查询未被消耗。这个失败与上述刷新竞态吻合。

### 代码依据

- `src/plugins/registry.ts:63-88`：`refreshPlugins()` 直接 `await get_plugins`，没有请求序号、取消或“只接受最新响应”的校验。
- `src/App.tsx:561-564`：启动时会发起一次刷新。
- `src/App.tsx:688-706`：`settings-applied` 又会发起刷新。
- `src/App.tsx:862-864`：设置事件进入 `applyRuntimeSettings()`。

两个 `get_plugins` 请求可以交错完成。较早发起、较晚返回的旧清单可能把较新的 `enabled` 状态覆盖回去；随后 `modePlugins()`、`modeKeywordMatches()` 都按旧状态过滤，界面就看不到刚启用的插件。

### 建议修复

为插件清单刷新增加单调序号，只允许最新请求落地：

```ts
let refreshSeq = 0;

export async function refreshPlugins() {
  const seq = ++refreshSeq;
  const list = await invoke<PluginManifest[]>("get_plugins");
  if (seq !== refreshSeq) return;
  setManifests(list);
  await loadDiskPlugins();
}
```

同时给 `loadDiskPlugins()` 增加串行化或同样的代际校验，并补充“启动时立即启用插件”的 CDP 回归用例。

---

## UI-04 上下文菜单与确认框不隔离后台键盘路由

**严重度：高。用户可能误操作后台条目。**

### 现象

上下文菜单打开时，方向键仍会移动后台列表的选中项。实测：

- 菜单保持打开。
- 后台剪贴板选中项从第一条移动到另一条。

“清空剪贴板”确认框打开时，`Esc` 不会关闭确认框；根路由会继续向下执行，最终隐藏整个启动器。确认框中的 `Enter`、`Space` 等按键也没有被确认框接管，仍有触发后台粘贴/多选/删除的风险。

### 代码依据

- `src/launcher/keyboard.ts:52-67`：只有 `Esc` 分支检查 `deps.menu()`；其他按键照常进入页面处理。
- `src/plugins/clipboard/store.ts:404-410`：`onEscape` 只处理多选集合，不处理 `clearOpen`。
- `src/plugins/clipboard/ClipboardView.tsx:363-385`：确认框没有焦点捕获、键盘作用域或遮罩层。
- `src/App.tsx:1083-1123`：上下文菜单只渲染按钮，没有菜单级键盘状态。

### 建议修复

让浮层成为独立输入作用域：

- 菜单打开时，方向键、`Home/End`、`Enter`、`Esc` 只由菜单处理；未实现键盘导航前，至少吞掉动作键，禁止后台激活。
- 确认框打开时，`Esc` 关闭确认框，`Enter` 只确认当前对话框动作，禁止页面快捷键。
- 给确认框补 `role="dialog"`、`aria-modal="true"`、初始焦点和焦点圈定。

---

## UI-05 上下文菜单在窗口底部被裁切

**严重度：中。**

### 现象

菜单位置使用固定 `140px` 高度余量：

```ts
top: Math.min(menu().y, window.innerHeight - 140)
```

实测一个 5 项的应用菜单高度为 `170.32px`，在视口底部打开时：

- 菜单顶部：`248`
- 菜单底部：`418.32`
- 视口高度：`388`
- 超出：`30.32px`

结果是最下方一项被窗口裁掉，用户无法点击“以管理员身份运行”等操作。

### 代码依据

- `src/App.tsx:1093-1098`：硬编码 `140` 作为垂直余量。
- `src/App.css:1017-1025`：菜单最小宽度、内边距和边框共同决定真实尺寸。

### 建议修复

渲染后读取菜单实际 `getBoundingClientRect()`，再做翻转或夹取：

- 下方空间不足时向上展开。
- 左右空间不足时向另一侧展开。
- 不要用固定高度/宽度常量估算菜单尺寸。

---

## UI-06 设置窗口最小宽度下自动化规则行横向溢出

**严重度：中。**

### 现象

设置窗口的最小内容尺寸为 `560×420`。在真实的 `560px` 内容宽度下切换到“自动化”：

- `.settings-body` 可见宽度 `400px`，内容滚动宽度 `433px`。
- 自动化规则行可见宽度约 `311px`，内容滚动宽度 `389px`。
- 行尾的开关和删除按钮被推到窗口右侧之外。

### 实测结果

```json
{
  "innerWidth": 560,
  "body": { "client": 400, "scroll": 433 },
  "automationRow": { "client": 311, "scroll": 389 }
}
```

截图中“延迟”“开关”“删除”等右侧控件不可见，用户只能通过隐藏的横向滚动区域访问。

### 代码依据

- `src/App.css:1547-1553`：`.settings-row-between` 为单行 flex，没有 `flex-wrap`。
- `src/App.css:1561-1569`：列表行只缩小路径，不处理其余固定宽度控件。
- `src/settings/AutomationPane.tsx:177-209`：程序名、录制按钮、测试、延迟、开关、删除同时放在一行。

### 建议修复

为自动化规则行增加响应式布局：

- 允许 `flex-wrap: wrap`，或在中窄宽度下把行拆成两行。
- 给程序名设置 `min-width: 0` 和截断。
- 窄宽度下把延迟、开关、删除放到第二行右侧。
- 增加一个以最小尺寸运行的设置页布局回归。

---

## UI-07 模式栏无溢出策略，插件多时挤出搜索框和设置按钮

**严重度：中。**

### 现象

模式栏默认是“图标 + 名称”，且 `.mode-switch` 使用 `flex: none`。搜索框虽然可以缩到 0，但模式栏本身不会换行、滚动或折叠。

用一个临时的合法 mode 插件夹具扩充到 9 个模式后，在 `720px` 窗口中实测：

- `.mode-switch` 右边界：`1677.68`
- 设置按钮右边界：`1715.68`
- 窗口宽度：`720`
- 搜索输入框宽度：`4px`

设置按钮完全跑到窗口外，用户无法点击；搜索框只剩不可用宽度。

### 代码依据

- `src/shell/SearchBox.tsx:73-114`：模式栏渲染全部胶囊，没有溢出菜单或折叠逻辑。
- `src/App.css:1070-1113`：`.mode-switch` 为 `flex: none`，没有 `max-width`、`overflow-x` 或换行。
- `src/App.css:77-86`：搜索输入允许缩到 0，但没有最小可用宽度约束。

### 建议修复

- 为模式栏设置可用最大宽度和横向滚动，或把溢出的模式收进“更多”菜单。
- 在空间不足时自动退化为仅图标模式，即使设置未开启。
- 给搜索框保留最小可用宽度，避免模式栏把它压缩到不可输入。

---

## UI-08 删除多选条目后多选状态残留

**严重度：中。可能导致下一次 `Enter` 合并粘贴失败。**

### 现象

1. 在剪贴板页按 `Space` 选中一条。
2. 状态栏显示“已选 1 条”。
3. 按 `Delete` 删除当前条目并等待刷新。
4. 列表行已经消失，多选标记也消失，但状态栏仍显示“已选 1 条”。

此时按 `Enter` 会走多选合并粘贴路径，而集合中仍保留已删除条目的 id，用户会得到失败或不可预期的粘贴结果。

### 实测结果

```json
{
  "before": { "count": "已选 1 条", "badges": 1 },
  "after":  { "count": "已选 1 条", "badges": 0, "toast": "已删除 1 条 撤销" }
}
```

### 代码依据

- `src/plugins/clipboard/store.ts:257-264`：删除动画只记录 `deletingId`。
- `src/plugins/clipboard/store.ts:302-317`：`deleteItem()` 删除后重新搜索，但没有从 `multiIds` 移除该 id。
- `src/plugins/clipboard/store.ts:109-125`：`search()` 会重置 `selected`，但不会清理多选集合。

### 建议修复

删除成功后从 `multiIds` 移除对应 id；每次搜索/分类切换后也应将 `multiIds` 与当前结果集求交集，避免隐藏条目继续参与合并粘贴。

---

## UI-09 快捷键录制器失焦后仍拦截设置搜索

**严重度：中。**

### 现象

在“设置 → 快捷键”点击自定义录制按钮，再把焦点移到设置搜索框并输入：

- 搜索框没有收到字符。
- 录制器仍保持激活状态。
- 输入被当成快捷键尝试，产生“需要至少一个修饰键”的错误。

### 实测结果

```json
{
  "search": "",
  "recording": true,
  "label": "按下新的组合键…",
  "error": "需要至少一个修饰键（Ctrl/Alt/Shift/Win）"
}
```

### 代码依据

- `src/settings/HotkeysPane.tsx:37-68`：录制期间在 `window` 上注册 `keydown`，没有失焦取消。
- `src/settings/ComboRecorder.tsx:78-85`：另一个录制器已经实现了 `onBlur` 取消，可作为对照。

### 建议修复

给快捷键录制器增加与 `ComboRecorder` 相同的失焦取消逻辑，或把监听器绑定到录制按钮本身。点击其他输入框、切换分区、打开对话框时应立即退出录制。

---

## UI-10 标准文本编辑快捷键被浏览器拦截器误杀

**严重度：中。**

### 现象

搜索框聚焦时，`Ctrl+Backspace`、`Ctrl+Home`、`Ctrl+End` 等标准 Windows 文本编辑快捷键被阻止。实测：

- 初始值：`hello world`
- 光标在末尾按 `Ctrl+Backspace`
- 结果仍是 `hello world`

### 代码依据

- `src/launcher/keyboard.ts:104-111`：仅把 `c/v/x/a/z/y` 视为输入框编辑快捷键。
- `src/launcher/types.ts:174-180`：浏览器保留键清单与编辑键清单分离。

### 建议修复

输入框聚焦时不要用固定短名单拦截所有带修饰键的组合；应允许浏览器原生的文本编辑集合，或至少加入 `Backspace`、`Delete`、`Home`、`End` 与方向键的修饰组合。

---

## UI-11 设置搜索漏掉多个新增设置项，且无匹配时是空白页

**严重度：中。**

### 现象

以下实际出现在设置界面中的文案，在设置搜索框输入后返回空导航栏、空内容区和空提示：

- “闲置重置”
- “模式切换栏仅显示图标”
- “各模式使用独立搜索词”
- “强制聚焦”

实测结构：

```json
{ "nav": [], "sections": [], "body": "" }
```

用户会以为设置页损坏，而不是“没有匹配结果”。

### 代码依据

- `src/settings/Settings.tsx:84-118`：`SECTION_SEARCH_KEYS` 只维护一份手写键清单，未包含 `modeSwitchIconsOnly`、`perModeQuery`、`idleReset`、`autoForceFocus` 等新增字段。
- `src/settings/LauncherPane.tsx:93-175`：这些控件已经存在。
- `src/settings/Settings.tsx:286-317`：搜索无匹配时没有 fallback/空态。

### 建议修复

- 让每个 pane 导出自己的可搜索文案键，由 `Settings` 汇总，避免新增字段忘记登记。
- 增加“没有匹配的设置”空态，并提供清空搜索的按钮。
- 把这组查询加入设置搜索回归。

---

## UI-12 键盘导航后悬停选中无法恢复

**严重度：低到中。**

### 现象

开启“悬停选中条目”后：

1. 用方向键把选中项移动到第 2 条。
2. 鼠标移动到第 4 条。

选中项仍停在第 2 条；继续移动鼠标也不会恢复，只能先点击一次。

### 实测结果

```json
{
  "rows": 12,
  "before": 1,
  "after": 1,
  "hoverWorks": false
}
```

### 代码依据

- `src/plugins/clipboard/ClipboardView.tsx:145-151`：鼠标移动时若 `selectionSource() === "keyboard"` 直接返回，永远没有机会调用 `markMouse()`。
- `src/plugins/navigate/NavigateView.tsx:178-183`：导航页的处理相反，鼠标移动会主动接管选择，可作为一致性参考。

### 建议修复

在真实鼠标移动事件中先调用 `markMouse()`，再更新选中项；如担心误触，可加入很小的移动阈值或防抖。键盘导航只应阻止“无移动的悬停”，不应永久冻结鼠标来源。

---

## 其他改进建议

1. **设置保存失败缺少反馈**：`src/settings/Settings.tsx:224-239` 的 `saveAndClose()` 在写入失败时直接返回，界面没有错误提示。建议在 footer 或 toast 中显示“保存失败，仍停留在此页”。
2. **可访问性文案仍为英文硬编码**：`src/shell/SearchBox.tsx:77` 的 `aria-label="Search mode"` 与 `src/plugins/clipboard/ClipboardView.tsx:281` 的 `aria-label="Clipboard category"` 未走 `t()`，与项目三语约束不一致。
3. **键盘可达性**：模式胶囊与设置齿轮被 `Tab` 模式切换占用，普通键盘用户无法通过 Tab 到达这些按钮。可考虑给模式栏保留 `Ctrl+Tab` 专用切换键，把 `Tab` 还给焦点导航。
4. **对话框/菜单焦点管理**：建议统一封装浮层焦点作用域，避免每个页面重复实现 `Esc`、`Enter`、焦点圈定和返回焦点。
5. **上下文菜单尺寸计算**：建议以实际 DOM 尺寸做四向自动翻转，同时覆盖长标签、窄窗口和窗口底部三种情况。

---

## 验证覆盖

### 构建与静态检查

- `pnpm exec tsc --noEmit`：无报错。
- `pnpm run build`：成功生成 `dist/`。
- `cd src-tauri && cargo check`：成功。
- `cd src-tauri && cargo test`：220 项符合预期，9 项按设计忽略，0 项失败。
- 三语 JSON 键、空值、占位符一致性检查：未发现缺键或占位符不一致。

### 界面探针

- `node scripts/cdp_settings_smoke.mjs`：设置布局与搜索基础流程正常。
- `node scripts/cdp_p2b_verify.mjs`：29 项符合预期。
- `node scripts/cdp_window_feature_verify.mjs`：全部符合预期。
- `node scripts/cdp_plugin_window_verify.mjs`：16 项符合预期。
- `node scripts/cdp_idle_reset_verify.mjs`：48 项符合预期。
- `node scripts/cdp_mode_bar_icons_verify.mjs`：22 项符合预期。
- `node scripts/cdp_plugins_pane_verify.mjs`：全部符合预期。
- `node scripts/cdp_mode_query_verify.mjs`：连续两次为 41/47，6 项不符合预期，集中在插件启用后的 mode 关键词入口；与 UI-03 的刷新竞态一致。

本机复现脚本位于 `test/ui_audit_probe*.mjs`、`test/q48_*.mjs`、`test/ui_many_modes_probe.mjs`，截图位于 `test/ui-audit-shots/`。这些属于本地 scratch 产物，不进入版本库。

## 建议处理顺序

1. 先修复 UI-01、UI-02、UI-04：它们直接决定输入是否安全，分别涉及误删历史、输入法误触和浮层误操作。
2. 再修复 UI-03：它会让“插件已启用但界面没有”成为难以排查的状态。
3. 随后处理 UI-05、UI-06、UI-07：都是可测量的布局损坏，修复后应补最小窗口和多模式夹具回归。
4. 最后处理 UI-08 至 UI-12 与可访问性改进，补状态一致性、编辑快捷键和设置搜索清单的回归。
