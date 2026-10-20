# 设置面板审查报告（2026-10-20）

设置窗重构（`4bb15d7` 双皮肤 → `868c58b` 帮助/开关/插件布局 → `b2af1e2` 调色盘与
位置网格）之后的独立审查。本文只记录现象与证据，不描述进度或分期。

- **审查对象**：工作树（`src/settings/**`、`src/settings/skins/**`、`catalog.ts`、
  相关 Rust 命令、`languages/*.json`），debug 独立 exe（`pnpm run tauri build
  --debug --no-bundle`）。
- **方法**：源码走查；既有 CDP 回归脚本（`cdp_settings_smoke` /
  `cdp_settings_skin_verify` / `cdp_settings_accent_verify`）；九页 × 双皮肤 ×
  明暗/窄窗截图矩阵；交互探针（可信鼠标事件、原生文件对话框、只读 `settings.toml`
  保存失败注入、跨页合并保存、撤销、数字预设越界）。
- **环境**：Windows 11 / WebView2 / 150% 显示缩放；设置窗 `1040×720` 与最小
  `560×420`；关键截图归档在 `docs/assets/settings-audit-2026-10-20/`；探针脚本为一次性 scratch（`test/settings-audit*`，不入库），可复跑命令见「本轮回归覆盖」。

## 结论摘要

| #   | 类别  | 现象                              | 严重程度 |
| --- | --- | ------------------------------- | ---- |
| 1   | 视觉  | 设置搜索下拉列表出现原生滚动条（与「滚动条一律移除」契约冲突） | 中等   |
| 2   | 视觉  | 插件列表图标在深色主题下不反色，深色描边图标几乎不可见     | 中等   |
| 3   | 视觉  | 快捷键录制态把同一句提示并排渲染两次              | 轻微   |
| 4   | 行为  | 自定义数字输入清空后失焦，静默写入该字段最小值         | 中等   |
| 5   | 行为  | 关于页复制失败提示在随后复制成功时仍留在页面          | 轻微   |
| 6   | 文案  | 系统页「导入导出与恢复」复用「恢复应用默认值」的范围说明    | 轻微   |
| 7   | 交互  | 宽布局下点击插件详情卡头部即清空选中，右栏回到空态       | 轻微   |
| 8   | 视觉  | 启动器尺寸预览线框在 Quiet 深色下对比度过低       | 轻微   |
| 9   | 视觉  | 剪贴板「忽略应用」条目用地图图标、添加按钮用文件夹图标     | 建议   |

## 详细发现

### 1. 设置搜索下拉列表出现原生滚动条

**现象**：标题栏搜索框展开结果列表后，列表右侧出现带上下箭头的系统原生滚动条
（深色皮肤下尤其显眼），并把结果行挤窄 17–19px。

**证据**：

- `src/settings/skins/base.css:218-231` 的 `.settings-search-results` 只写
  `overflow-y: auto`，没有 `scrollbar-width: none` / `::-webkit-scrollbar` 规则；
  同文件其余滚动容器（`:320-329` 侧栏、`:436-441` 正文、`:824-830` 帮助气泡与
  模态、`:2099-2108` 插件列表与详情、`:2126-2131`）都成对写了隐藏规则。
- 探针实测：Quiet 深色 `1040×720` → `scrollbarWidth: auto`，`offsetWidth 339 /
  clientWidth 322`；Chromatic 深色 → `337 / 318`；`560×420` → `301 / 284`。
- 截图：`assets/settings-audit-2026-10-20/search-results-scrollbar-quiet-dark.png`、
  `assets/settings-audit-2026-10-20/search-results-scrollbar-narrow-en.png`、
  `assets/settings-audit-2026-10-20/search-results-scrollbar-chromatic.png`。

**影响**：`docs/UI_GUIDELINES.md` 的「Scrollbars & sliders」与
`docs/SETTINGS.md` 的滚动约定都以「滚动条一律移除、内容占满整宽」为准；当前这一处
是设置窗里唯一的例外，结果行可用宽度被滚动条吃掉 17–19px，两列栅格与输入框右缘不再对齐。

**建议**：给 `.settings-search-results` 补 `scrollbar-width: none` 与
`::-webkit-scrollbar { width: 0 }`，与其它滚动容器保持一致。

### 2. 插件列表图标在深色主题下不反色

**现象**：插件主从列表左侧图标块里，清单声明的图标（`file-search`、
`hidden-mode`、`translator` 等示例插件）在深色皮肤下几乎看不见，只剩一个空方块；
没有图标的插件才会显示首字回退。

**证据**：

- `src/settings/PluginsPane.tsx:683-685` 渲染 `<img src={icon()!.src}>` 时不带任何
  class；`src/settings/skins/base.css:2194` 与 `src/App.css:2533` 的
  `.plg-tile img` 只声明尺寸，没有 `filter`。
- 对照 `src/App.css:2332-2346` 的 `--icon-filter` 名单（`.icon-btn-icon`、
  `.mode-switch-icon`、`.plugin-list-icon`、`.settings-nav-icon`、
  `.settings-chip-icon` …）与 `src/theme.css:53`（深色 `invert(1)`）。
- 探针实测：设置窗 `.plg-tile img` computed `filter: none`；启动器（同为深色）
  `.mode-switch-icon` computed `filter: invert(1)`。
- 示例图标 `plugins/file-search/file_search.svg`、`plugins/hidden-mode/icon.svg`
  用 `stroke="#333"`；放大截图 `assets/settings-audit-2026-10-20/plugin-tiles-icon-invisible-zoom.png`
  可见深灰描边压在深色 tile 上。

**影响**：同一份图标在启动器里正常、在设置窗里消失，属于跨窗口不一致；深色主题下
插件辨识度明显下降。

**建议**：给该 `<img>` 加 `filter: var(--icon-filter)`（或复用现成的 icon class），
让遗留单色图标与启动器同规则反色；声明式 `icon_light` / `icon_dark` 变体仍应
保持「作者原图不反色」的既有约定。

### 3. 快捷键录制态提示重复

**现象**：点击「更改」进入录制后，keycap 卡内显示青色「按下新的组合键…」，紧邻的
按钮同时把文案换成同一句，两个字符串并排出现，读起来像渲染错位。

**证据**：`src/settings/HotkeysPane.tsx:28`（`settings-recording-hint`）与 `:131`
（按钮 `{recording() ? t("hotkeyRecording") : t("hotkeyChange")}`）；截图
`assets/settings-audit-2026-10-20/hotkey-recorder-duplicate-prompt.png`、放大图
`assets/settings-audit-2026-10-20/hotkey-recorder-duplicate-prompt-zoom.png`。

**建议**：录制态只在 keycap 卡内给提示，按钮保留「更改」或改为「取消」。

### 4. 自定义数字输入清空后静默写入最小值

**现象**：把「更多…」展开的自定义数字框清空再失焦（或按 Enter），字段不会回滚，
而是被钳到该字段最小值并立即保存。

**证据**：`src/settings/controls.tsx:52-60` 的 `commitCustom` 用
`Number(raw)` + `Number.isFinite` 判空——`Number("") === 0` 通过校验后被
`Math.max(n, custom.min)` 抬到下限。探针实测：闲置重置阈值清空 + 失焦后
`appearance.idle_reset_minutes` 由 `30` 变为 `1`（探针随后已还原）。
同源字段：最近使用条数（下限 5）、历史记录条数上限（下限 10）。

**建议**：空串（或非有限值）时不提交并回滚显示值；只有显式输入越界才钳制。

### 5. 关于页复制失败提示不会清除

**现象**：版本号复制失败一次后，之后再复制成功，页面同时显示「已复制」与红色的
「操作失败，详情已写入日志。」。

**证据**：`src/settings/AboutPane.tsx:24-31` 的 `copyVersion` 成功路径不调用
`setError(null)`（只有 `openHomepage` 在入口清空错误）。截图
`assets/settings-audit-2026-10-20/about-copy-stale-error.png`（同一帧内「已复制」+ 错误行）。

**建议**：`copyVersion` 入口清空错误；另外该错误文案对剪贴板失败并不贴切（并没有
写日志），建议改用复制专用文案。

### 6. 系统页「导入导出与恢复」复用恢复默认值的范围说明

**现象**：08.3 分组里，导出 / 导入 / 恢复备份设置 三个按钮上方写着「只恢复外观、
启动器、剪贴板、快捷键、搜索和自动化。」，读起来像在描述这三个按钮的作用域。

**证据**：`src/settings/SystemPane.tsx:465` 使用 `settingsRestoreDefaultsHint`；
同一键在 `src/settings/Settings.tsx:561` 用作「恢复应用默认值」确认框正文。截图
`assets/settings-audit-2026-10-20/system-import-export-hint.png`。

**建议**：为导入导出/备份分组写独立说明（例如「导出/导入完整 `settings.toml`；
恢复备份使用最近一次保存前快照」），把范围句留在恢复默认值入口附近。

### 7. 宽布局下点击插件详情卡头部即清空选中

**现象**：宽布局选中某插件后，点击右栏卡片的标题/图标/描述区域（整块是
`role="button"` 的 `.plg-head`），右栏立刻回到「选择一个插件以查看权限与设置。」。

**证据**：`src/settings/PluginsPane.tsx:592-601` 给详情窗卡片传
`onToggleOpen={() => setOpenId(null)}`；探针点击 `.plg-detail-pane .plg-head` 后
`openId` 归零。宽布局下 `.plg-mobile-back` 的 `display: none`（探针实测），因此没有
「返回列表」按钮可对照，只有这个隐性手势。

**建议**：宽布局下头部不承担关闭职责（或改成显式关闭按钮），避免误点标题丢上下文。

### 8. 启动器尺寸预览线框在 Quiet 深色下对比度过低

**现象**：启动器页「宽度」行右侧的窗口预览线框在 Quiet 深色下几乎是一块纯色矩形，
读不出搜索行与条目网格。

**证据**：`src/settings/skins/base.css:1396-1425` 用 `--settings-line` 描边、
`--settings-canvas` 作底；Quiet 深色 `--settings-line: #2a2b31` 压在
`--settings-canvas: #191a1d` 上。截图
`assets/settings-audit-2026-10-20/launcher-size-preview-contrast.png`。

**建议**：线框换 `--settings-line-strong` 或提高一档对比；该元素是纯装饰
（`aria-hidden`），也可以直接用面板色块表达尺寸。

### 9. 剪贴板「忽略应用」条目使用地图图标

**现象**：忽略列表每行前缀是一枚折页「地图」图标，添加按钮是「文件夹 +」。

**证据**：`src/settings/ClipboardPane.tsx:18`、`:189` 使用
`res/icons/damage-map.svg` 作条目前缀；`:237` 的添加按钮用
`res/icons/folder_plus.svg`。截图 `assets/settings-audit-2026-10-20/clipboard-ignore-app-icons.png`。

**建议**：换成应用/进程类图标，或去掉前缀图标；添加按钮可用 `plus.svg`。

## 其他观察

- **跳转定位裁掉卡片标题**：设置搜索跳转到插件详情后，
  `Settings.tsx` 的 `jumpToResult` 用 `scrollIntoView({ block: "center" })`，详情栏
  会把卡片标题滚出可视区，顶部留半行字形（`assets/settings-audit-2026-10-20/plugin-jump-clipped-title.png`）。
- **`.plg-filter-chips` 的横向滚动**：`src/settings/skins/base.css:2291` 只写
  `overflow-x: auto`，同样没有隐藏滚动条规则。当前中英文在 `560×420` 下都不溢出
  （探针：`scrollWidth === clientWidth`），更长的语言或更窄窗口会露出横向滚动条，
  与第 1 条同源。
- **帮助气泡与模态**：定位、`inert`、焦点返回、Esc、遮罩变暗均符合
  `docs/UI_GUIDELINES.md`，未见异常。

## 本轮回归覆盖（无失败项）

- `pnpm run build`、`pnpm run tauri build --debug --no-bundle`：成功。
- `node scripts/cdp_settings_smoke.mjs`：9 项断言，无失败。
- `node scripts/cdp_settings_skin_verify.mjs`：60 项断言，无失败（双皮肤 × 明暗、
  焦点/滚动保持、只读保存失败回滚、撤销、九页 `560×420` 无横向溢出、插件主从独立
  滚动）。
- `node scripts/cdp_settings_accent_verify.mjs`：34 项断言，无失败（四组合染色、
  对比度、Portal 继承、系统主题重算、进程重启首帧）。
- 额外探针（无失败项）：跨页 50ms 内连续改两项均落盘；6 秒撤销按最后一次保存回滚；
  数字预设越界钳制到上下限；用户索引新增/大小写与分隔符不敏感去重/删除；系统索引
  开关；插件启停写入 `plugins.disabled`；开发者模式与「全部授权」开关及确认框；
  `.lupx` 安装→列表 28→29→卸载回 28（测试插件已清理）；`navigator.clipboard`
  真实点击复制成功；`restore_default` 确认框与范围文案。

## 未覆盖 / 后续建议

- `.lupx` 安装确认卡片（`.plg-install`）的**视觉**未留截图：安装链路已通过原生
  文件对话框走通并成功安装/卸载，但卡片本身的排版未做像素级核对。
- 系统集成动作（服务/代理注册、UAC、开机启动写入注册表）未触发，避免改动本机状态；
  这些仍按 `docs/TESTING.md` 手工清单验证。
- 真实 Win10 方角、非 150% 缩放、多显示器跨屏拖动未覆盖。
- 本文发现项已登记到 `docs/ROADMAP.md` 的开放事项；收口后按仓库流程把验证数据归档到 `docs/ROADMAP_HISTORY.md` 并更新 `CHANGELOG.md`。
