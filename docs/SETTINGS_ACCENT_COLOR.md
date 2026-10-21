# 设置窗主题色：强调色 + 轻量表面着色

适用范围：设置窗口（Tauri `settings` webview、`src/settings/`）。

本文定义设置窗主题色的目标契约、实现边界、颜色派生规则与验收口径。主题色
只作用于设置窗口，启动器、插件页画布、分离插件窗口、托盘图标和启动器 DWM
边框保持现状。

## 1. 目标与边界

### 1.1 目标

- 在「外观」页提供设置窗主题色选择，用户可选预设色或自定义颜色。
- 让强调色同时影响选中态、焦点、开关、链接、页码结构线和少量表面色。
- 保持 Quiet Control Deck 与 Chromatic Edge 的版面、几何和控件语义。
- 主题色与 `appearance.color_mode` 正交：深色 / 浅色各自使用经过对比度修正的
  强调色，跟随系统时随 `prefers-color-scheme` 实时更新。
- 复用现有 `get_settings` / `save_settings_patch` / `settings-applied` 链路，
  接入自动保存、失败回滚、撤销、恢复默认值、导入和恢复备份。
- 首帧直接使用持久化值，不出现默认色闪烁。
- 不新增 SQLite 表、Tauri 命令、capability 或插件权限。

### 1.2 非目标

- 不修改启动器面板、插件页画布、插件窗口、托盘或 DWM 边框。
- 不开放画布、面板、文字、边框、危险色、警告色和成功色的逐 token 编辑。
- 不引入主题包、脚本化主题、在线主题或第三方皮肤加载。
- 不提供透明度、渐变、亚克力或按页面单独配色。
- 不提供表面染色强度滑块。表面染色使用固定低比例，保证设置项最小化。
- 不根据强调色自动改变 Quiet / Chromatic 的皮肤选择。

## 2. 现有基础

设置窗已经具备以下可直接复用的结构：

- `appearance.color_mode` 控制设置窗与启动器的深色 / 浅色 / 跟随系统模式。
- `appearance.settings_skin` 只控制设置窗皮肤，默认 `quiet`。
- 设置窗皮肤 token 位于 `src/settings/skins/quiet.css` 与
  `src/settings/skins/chromatic.css`。
- `src/settings/skins/base.css` 在 `.settings` 根节点把 `--settings-*` 映射为
  `--surface`、`--accent`、`--accent-text`、`--focus-ring` 等语义 token。
- `src/index.tsx` 在 `render()` 前读取 Rust 注入的 `window.__LUME_CONFIG__`，
  已能在首帧应用皮肤与明暗模式。
- `Settings.tsx` 已提供自动保存、失败回滚、六秒撤销、恢复默认值与外部刷新。
- 外观页已有主题预览卡与皮肤选择卡，设置搜索目录也能逐行定位。
- `scripts/cdp_settings_skin_verify.mjs` 已覆盖双皮肤、明暗组合、首帧属性、
  焦点 / 滚动保持、保存失败回滚与窄窗口布局。

设置窗会清除 DWM 原生边框，因此自定义颜色不需要同步原生窗口参数。颜色变化
只发生在 webview 文档内。

## 3. 运行时组合

新增设置字段后，最终视觉由三个正交维度决定：

| 维度 | 取值 | 作用 |
|---|---|---|
| `appearance.color_mode` | `system` / `dark` / `light` | 选择深色或浅色 token 组 |
| `appearance.settings_skin` | `quiet` / `chromatic` | 选择版面、几何与基础中性色 |
| `appearance.settings_accent` | `""` / `#rrggbb` | 覆盖强调色并轻度染入表面 |

运行结果：

| 主题色 | 行为 |
|---|---|
| 空字符串 | 完全使用当前皮肤原生的强调色、表面色与选中色 |
| 合法十六进制色 | 用该色派生强调色与表面染色，覆盖当前皮肤对应的 token |

皮肤原生强调色：Quiet 深色 / 浅色为 `#5ac8fa` / `#0969da`；Chromatic 深色为
湖蓝 `#5ac8fa`（该皮肤的原色 `#ac8e97` 移到调色盘首格，见 §7.2），浅色为
`#64796d`。深色 Chromatic 的 `--settings-selected` 直接写成同一套 16% 混色，
让「默认」与显式选中湖蓝在视觉上一致。

主题色为空时必须与现有视觉逐像素一致。自定义值不能改变皮肤几何、字号、圆角、
边框宽度、布局或组件结构。

## 4. 设置字段

### 4.1 Rust schema

在 `src-tauri/src/settings.rs` 的 `Appearance` 中新增：

```rust
/// 设置窗主题色：空字符串表示跟随当前皮肤，否则为规范化后的 #rrggbb。
#[serde(default)]
pub settings_accent: String,
/// 取色器最后一次提交的颜色；与 settings_accent 解耦，空值 = 显示皮肤默认色。
#[serde(default)]
pub settings_accent_custom: String,
```

`impl Default for Settings` 中显式写入空字符串：

```rust
settings_accent: String::new(),
settings_accent_custom: String::new(),
```

默认值使用空字符串而不是 Quiet 的青色，原因是 Chromatic 有独立的原生强调色。
空值让两种皮肤都能保留自己的默认视觉。

字段不改变 `meta.version`。旧配置缺少字段时由 `#[serde(default)]` 读为空值；
新增字段只影响设置窗，不触发设置表迁移。

### 4.2 规范化

新增统一函数：

```rust
fn normalize_settings_accent(value: &str) -> String
```

规则：

- 去除首尾空白。
- 空字符串保持为空。
- 接受可选的 `#`，接受三位或六位十六进制。
- 三位值展开为六位，例如 `#5cf` → `#55ccff`。
- 输出统一为小写 `#rrggbb`。
- 拒绝四位或八位带 alpha 的值、颜色名、`rgb()`、`hsl()`、`var()` 和任意
  CSS 片段。
- 无法识别时回落为空字符串。

`Settings::normalize()` 加入：

```rust
self.appearance.settings_accent =
    normalize_settings_accent(&self.appearance.settings_accent);
self.appearance.settings_accent_custom =
    normalize_settings_accent(&self.appearance.settings_accent_custom);
```

`normalize()` 已在读取、补丁合并、导入、恢复默认值、恢复备份和整表保存路径
统一执行。Rust 单元测试覆盖旧配置缺字段、默认空值、短格式展开、大小写归一、
非法值回落、补丁合并与往返写入。

### 4.3 TypeScript schema

`src/settings/types.ts` 的 `SettingsData.appearance` 增加：

```ts
/** 设置窗主题色；空字符串表示跟随当前皮肤，否则为 #rrggbb。 */
settings_accent: string;
/** 取色器记忆的颜色；空字符串表示尚未选过自定义色。 */
settings_accent_custom: string;
```

`DEFAULT_SETTINGS.appearance` 增加：

```ts
settings_accent: "",
settings_accent_custom: "",
```

前端再次执行同样的归一化，防止手写配置、旧缓存或测试桩绕过 Rust 校验后留下
不可用值。前端归一化不承担持久化校验职责，Rust 仍是最终边界。

## 5. 视觉模型

### 5.1 表面染色比例

主题色只以低比例混入中性表面。深色模式使用稍高比例避免颜色不可见，浅色模式
使用更低比例避免页面发黄、发粉或发灰。

| 设置窗 token | 深色混入 | 浅色混入 | 用途 |
|---|---:|---:|---|
| `--settings-canvas` | 5% | 3% | 页面主画布 |
| `--settings-rail` | 7% | 5% | 顶部栏与导航栏 |
| `--settings-panel` | 4% | 2% | 设置组、控件面板、浮层 |
| `--settings-control` | 6% | 3% | 输入框、分段控件底板 |
| `--settings-selected` | 16% | 12% | 选中背景；与 `--settings-panel-base` 混合 |

未列出的 token 保持当前皮肤值：

- `--settings-text`
- `--settings-secondary`
- `--settings-muted`
- `--settings-line`
- `--settings-line-strong`
- `--settings-hover`
- `--settings-signal`
- `--settings-signal-text`
- `--settings-signal-tint`
- `--settings-success`
- `--settings-overlay-shadow`

选中态继续同时使用强调色边框、底边或位置变化，不依赖颜色单独表达状态。

### 5.2 强调色对比度修正

原始强调色不能直接用于文字和焦点环。`#ffff00`、`#000000`、低饱和中间色都可能
在某个主题下低于可读阈值。运行时必须从同一输入色派生两个 token：

| token | 最低对比度 | 用途 |
|---|---:|---|
| `--settings-structure` | 3:1 | 焦点环、边框、页码结构线、装饰 |
| `--settings-structure-text` | 4.5:1 | 小字、链接、当前值、引导文案 |

算法：

1. 将输入色解析为 sRGB。
2. 使用 WCAG 相对亮度公式计算对比度：
   `(L1 + 0.05) / (L2 + 0.05)`。
3. 深色模式以保守深色背景锚点计算；浅色模式以保守浅色背景锚点计算。锚点取
   当前皮肤在染色后可能出现的较不利表面，保证强调文字在画布、面板和导航栏上
   都可读。
4. 若输入色已满足目标对比度，保留原色。
5. 深色模式不满足时向白色混合，浅色模式不满足时向黑色混合，以 1% 步长提升，
   直到达到目标比例。
6. 两档分别计算，不使用同一个修正结果：装饰色按 3:1 修正，文字色按 4.5:1
   修正。
7. 极端输入无法在保持可见的情况下达到目标时，回落到纯白或纯黑的安全值。

推荐在 `src/settings/accent.ts` 中实现纯函数：

```ts
type AccentTokens = {
  structure: string;
  structureText: string;
};

function deriveAccentTokens(accent: string, mode: "dark" | "light"): AccentTokens;
```

纯函数输入输出均为十六进制字符串，便于通过 CDP 探针直接断言。

### 5.3 选中背景与文字

`--settings-selected` 使用固定比例与当前皮肤的 `--settings-panel-base` 混合。
`--settings-selected-text` 保持皮肤原生文字色，不跟随用户强调色变化。

实现后必须验证以下组合：

- Quiet 深色 / 浅色。
- Chromatic 深色 / 浅色。
- 明亮、深暗、低饱和三组自定义强调色。

选中文字在染色后的背景上保持 4.5:1；选中背景边界使用
`--settings-structure`，并保留现有边框、底边或页码结构，不使用纯色填充作为唯一
状态信号。

### 5.4 运行时 CSS 变量

运行时只写入以下变量：

```css
--settings-user-accent: #rrggbb;
--settings-user-structure: #rrggbb;
--settings-user-structure-text: #rrggbb;
```

`data-settings-accent="custom"` 表示启用染色层。主题色为空时移除该属性并清除
上述内联变量，让皮肤原生 token 重新生效。

全局 `src/theme.css` 的 `--accent`、`--surface`、`--focus-ring` 不修改。设置窗
只在自身文档内通过 `--settings-*` 覆盖。

## 6. 首帧、运行时与保存链

### 6.1 首帧

`src/index.tsx` 的设置窗分支读取：

```ts
{
  appearance?: {
    settings_skin?: string;
    color_mode?: string;
    settings_accent?: string;
  }
}
```

应用顺序固定为：

1. `applySettingsSkin(...)`
2. `applyColorMode(...)`
3. `applySettingsAccent(...)`

`applySettingsAccent` 必须在 `render()` 前完成，避免先绘制原生皮肤再跳到自定义
颜色。Rust 注入逻辑已序列化完整 `Settings`，新增字段会自动进入
`window.__LUME_CONFIG__`，不需要新 IPC。

### 6.2 单一写入器

新增 `src/settings/accent.ts`，作为以下状态的唯一写入器：

- `document.documentElement.dataset.settingsAccent`
- `--settings-user-accent`
- `--settings-user-structure`
- `--settings-user-structure-text`

模块导出：

```ts
export function normalizeSettingsAccent(value: unknown): string;
export function applySettingsAccent(value: unknown): void;
```

禁止在 `AppearancePane`、CSS 内联样式或其他组件中直接写这些状态。这样保存失败、
撤销、恢复默认和系统明暗切换都走同一条应用路径。

### 6.3 系统明暗切换

`Settings.tsx` 新增一个独立 effect，读取 `themeMode()` 与设置快照：

```ts
createEffect(() => {
  const value = settings();
  if (!value) return;
  themeMode();
  applySettingsAccent(value.appearance.settings_accent);
});
```

`themeMode()` 的读取让系统主题翻转时重新计算 `structure` 与 `structure-text`。
effect 的声明位置必须在现有颜色模式 / 皮肤 effect 之后，保证 `data-theme` 已更新。

### 6.4 即时预览与保存节流

预设色点击：

- 立即调用 `applySettingsAccent` 预览。
- 立即更新工作副本。
- 走现有 `queueSave`。

原生颜色输入：

- `input` 事件用于连续预览，不逐帧写入整个设置快照。
- `change` 事件提交最终值到工作副本并排队保存。
- `saveDelayFor` 对 `appearance.settings_accent` 返回 250ms，避免拖动取色器时
  连续写 TOML 和备份文件。
- 设置窗关闭路径会先 flush 待保存队列；颜色输入尚在打开时，最终值以最近一次
  `change` 为准。

预设色与自定义值最终都保存为同一十六进制字段，不持久化预设 ID。后续调整预设
列表不会让旧配置无法读取。

### 6.5 保存失败与回滚

`performSave` 失败时：

- 若 patch 包含 `appearance.settings_accent`，在主题色行显示
  `settingsAccentSaveFailed`。
- 工作副本回到已确认的基线。
- 调用 `applySettingsAccent(base.appearance.settings_accent)` 恢复 DOM。
- 底栏继续显示通用保存失败状态与重试入口。

以下路径都必须重新应用主题色：

- `loadSettings` 完成。
- `retrySave` 恢复失败快照。
- `undoLast` 应用反向 patch。
- `restore_default` 重新读取默认设置。
- 恢复备份与导入后的 `settings-applied` 刷新。
- 保存失败回滚。

`settings-applied` 的现有规则不变：文本输入或颜色输入获得焦点、保存队列尚未
清空或处于错误状态时，不覆盖当前编辑。

## 7. 交互与无障碍

### 7.1 放置位置

在「外观」页新增分组「设置窗配色」，编号 `01.4`，位于设置窗皮肤之后。

设置行：

- id：`appearance.settings_accent`
- 标签：设置窗主题色
- 摘要：为设置窗的选中态、焦点和表面加入一种强调色。
- 详情：只影响设置窗口；自动修正文字和焦点对比度；启动器与插件页面不变。

### 7.2 预设色

预设使用单选语义：

- 默认 `settingsAccentDefault`
- 靛蓝 `#6f7cff`
- 紫罗兰 `#a678ff`
- 玫瑰 `#d96c95`
- 翡翠 `#3fb98b`
- 琥珀 `#e0a33a`
- 浅粉 `#ac8e97`（仅 Chromatic，占首格）

首格是唯一随皮肤变化的预设，位置与「湖蓝」在 Quiet 下的位置相同：

| 皮肤 | 首格色 | 标签 |
|---|---|---|
| Quiet | 湖蓝 `#5ac8fa` | `settingsAccentPresetAqua` |
| Chromatic | 浅粉 `#ac8e97` | `settingsAccentPresetBlush` |

「默认」项的色块固定显示当前皮肤、当前明暗下的默认色：它从 `<html>` 上读取
`--settings-structure`（染色层只覆盖 `body.settings-window` 与 `.settings`），
所以正在使用别的主题色时也不会跟着变。

Chromatic 深色的原生强调色改成湖蓝后，湖蓝预设不再单列；原色（浅粉 `#ac8e97`）
因此占住首格，仍然一键可达。选中的十六进制值若出现在当前皮肤的预设里，就点亮
对应预设。

每个选项同时显示色块和文字标签，不能只靠颜色表达选中状态。选中项使用
`--settings-structure` 边框或底边，并暴露 `role="radio"` 与 `aria-checked`。

预设组支持方向键、Home、End 和 roving tabindex，复用现有设置分段控件 / 主题预览
的键盘契约。点击预设后焦点留在原控件。

### 7.3 自定义颜色

自定义入口是「原生 `<input type="color">` 色块 + 名称按钮」的一行：

- 色块保留 32×32px 以上的命中区，点击打开系统取色器。
- 名称按钮（含当前规范化十六进制值）点击即应用记忆值，不打开取色器，行为与预设
  一致；尚未保存过颜色时应用纯白 `#ffffff`。
- 两个控件都可由键盘聚焦，按钮暴露 `aria-pressed` 选中状态。

取色器显示的初始值：

1. 已有合法 `settings_accent_custom` 时使用该值。
2. 否则统一为纯白 `#ffffff`（不随皮肤或明暗变化）。

取色器拥有自己的值：切换预设或「默认」都不改写 `settings_accent_custom`，输入框
始终显示这份记忆值，因此不会跟着正在使用的颜色跑。提交自定义色时同时写入
`settings_accent`（立即生效）与 `settings_accent_custom`（记忆），`input` 阶段
仍然只做预览。

当前生效值等于某个预设时，预设项显示选中；不等于任何预设时，自定义入口显示选中
状态。颜色输入只写合法 `#rrggbb`。

### 7.4 预览

设置行内提供一块紧凑预览：

- 一条结构色边线。
- 一个选中导航行。
- 一个开启态开关。
- 一段使用 `--settings-structure-text` 的小字。

预览使用与真实控件相同的 CSS token，不单独维护颜色。预览在预设点击和颜色输入
`input` 事件中即时更新。

### 7.5 文案与搜索

新增三语键：

- `groupAppearanceAccent`
- `settingsAccent`
- `settingsAccentHint`
- `settingsAccentDetail`
- `settingsAccentDefault`
- `settingsAccentCustom`
- `settingsAccentPresetAqua`
- `settingsAccentPresetIndigo`
- `settingsAccentPresetViolet`
- `settingsAccentPresetRose`
- `settingsAccentPresetEmerald`
- `settingsAccentPresetAmber`
- `settingsAccentSaveFailed`
- `settingsAccentPreviewLabel`

`languages/en.json`、`zh-CN.json`、`zh-TW.json` 必须同步。设置目录新增
`SettingKind = "palette"` 描述项，关键词包含：

`color`、`accent`、`palette`、`theme`、`主题色`、`強調色`、`调色盘`、
`調色盤`、`配色`。

搜索命中后跳转到 `appearance.settings_accent` 行并聚焦其容器；现有跳转高亮和
`data-setting-id` 契约不变。

## 8. CSS 实现

### 8.1 基础 token

Quiet 与 Chromatic 的 token 块增加可混合的基础色变量：

```css
html[data-settings-skin="quiet"] {
  --settings-canvas-base: #191a1d;
  --settings-rail-base: #151619;
  --settings-panel-base: #1f2024;
  --settings-control-base: #292a30;

  --settings-canvas: var(--settings-canvas-base);
  --settings-rail: var(--settings-rail-base);
  --settings-panel: var(--settings-panel-base);
  --settings-control: var(--settings-control-base);
}
```

浅色块执行同样映射。Chromatic 使用自己的基础值。这样 `color-mix()` 引用的是
未覆盖的基色，不会与正在派生的 `--settings-canvas` 形成自引用。

### 8.2 染色层

新增 `src/settings/skins/accent.css`，在 `base.css`、`quiet.css`、
`chromatic.css` 之后导入。深色规则：

```css
html[data-settings-accent] .settings {
  --settings-structure: var(--settings-user-structure);
  --settings-structure-text: var(--settings-user-structure-text);
}

html[data-settings-accent][data-theme="dark"] .settings {
  --settings-canvas: color-mix(in oklab, var(--settings-user-accent) 5%, var(--settings-canvas-base));
  --settings-rail: color-mix(in oklab, var(--settings-user-accent) 7%, var(--settings-rail-base));
  --settings-panel: color-mix(in oklab, var(--settings-user-accent) 4%, var(--settings-panel-base));
  --settings-control: color-mix(in oklab, var(--settings-user-accent) 6%, var(--settings-control-base));
  --settings-selected: color-mix(in oklab, var(--settings-user-accent) 16%, var(--settings-panel-base));
}
```

浅色规则使用本文 5.1 的比例。皮肤文件只提供基础 token；染色层只覆盖派生 token。

### 8.3 作用域

- 所有选择器必须带 `html[data-settings-accent]` 或 `.settings` 前缀。Portal
  帮助提示 / 模态由 `body.settings-window` 承接同一组 accent 变量，仍只作用于
  设置文档。
- 不修改 `src/theme.css`。
- 不修改 `.launcher`、插件画布、预览窗或分离插件窗口的样式。
- 所有混色结果为不透明色；设置窗继续使用实体背景。
- 颜色变化不添加 transition，避免取色时出现拖影。

### 8.4 原生皮肤回退

`data-settings-accent` 不存在时，`accent.css` 不得命中任何规则。Quiet 与
Chromatic 继续使用各自原始的强调色、表面色和选中色。

## 9. 文件改动地图

| 文件 | 改动 |
|---|---|
| `src-tauri/src/settings.rs` | `Appearance.settings_accent`、默认值、规范化、单元测试 |
| `src/settings/types.ts` | TypeScript 字段、`DEFAULT_SETTINGS` |
| `src/settings/accent.ts` | 归一化、对比度派生、单一写入器 |
| `src/index.tsx` | 首帧读取并应用主题色 |
| `src/settings/Settings.tsx` | effect、保存节流、错误文案、回滚、撤销与恢复默认接线 |
| `src/settings/AppearancePane.tsx` | 主题色设置行、预设、自定义输入、预览 |
| `src/settings/catalog.ts` | `palette` 类型与可搜索描述项 |
| `languages/en.json` | 英文文案与搜索关键词 |
| `languages/zh-CN.json` | 简体中文文案与搜索关键词 |
| `languages/zh-TW.json` | 繁体中文文案与搜索关键词 |
| `src/settings/skins/quiet.css` | 基础 token 与派生 token 映射 |
| `src/settings/skins/chromatic.css` | 基础 token 与派生 token 映射 |
| `src/settings/skins/accent.css` | 表面染色与强调色覆盖层 |
| `scripts/cdp_settings_accent_verify.mjs` | 主题色首帧、持久化、回滚、对比度与视觉回归 |
| `docs/SETTINGS.md` | 功能落地后补字段、交互与验证契约 |
| `docs/UI_GUIDELINES.md` | 功能落地后补设置窗配色与对比度约束 |
| `docs/ARCHITECTURE.md` | 功能落地后补设置窗主题色运行时 |
| `docs/TESTING.md` | 功能落地后补自动化与手工检查项 |
| `docs/ROADMAP.md` | 开放事项入口；收尾时移除 |
| `CHANGELOG.md` | 文档与实现分别记录到 `[Unreleased]` |

明确不改：

- `src/App.tsx`、`src/App.css`、`src/theme.ts`、`src/theme.css`
- `src/pluginWindow.tsx`、`src/pluginWindow.css`
- `src/preview.tsx`、`src/preview.css`
- `src-tauri/capabilities/*.json`
- SQLite 数据库和插件存储

## 10. 自动化与手工验收

### 10.1 Rust

- 旧 `settings.toml` 缺少 `settings_accent` 时读出空字符串。
- 默认 `default.toml` 生成后包含空字符串字段。
- `#5cf` 归一为 `#55ccff`。
- `#AABBCC` 归一为 `#aabbcc`。
- 空字符串、空白字符串和缺失字段保持空值。
- `#abcd`、`#aabbccdd`、`red`、`rgb(0 0 0)`、`var(--x)` 和任意非法片段
  回落为空字符串。
- 合法值经 `write_settings` / `read_settings` 往返保持。
- `merge_settings_patch` 的非法值不会让整张设置表读取失败。
- 导入、恢复默认值、恢复备份和整表保存都经过同一规范化。
- 主题色 patch 不改变 `appearance.settings_skin`、`color_mode` 或其他 section。

### 10.2 TypeScript 与构建

```bash
pnpm exec tsc --noEmit
pnpm run build
cd src-tauri && cargo check
cd src-tauri && cargo test
```

类型检查需覆盖：

- `SettingsData.appearance.settings_accent` 必填。
- `DEFAULT_SETTINGS` 同步。
- `SettingKind` 包含 `palette`。
- `applySettingsAccent` 的调用参数允许未知输入并在内部归一化。

### 10.3 CDP 回归

新增 `scripts/cdp_settings_accent_verify.mjs`，沿用现有设置窗脚本的启动、
进程清理、设置文件读写、截图与 `PASS / FAIL` 输出方式。

启动前写入：

```toml
[appearance]
settings_skin = "quiet"
color_mode = "dark"
settings_accent = "#6f7cff"
```

检查项：

- 设置窗首帧存在 `data-settings-accent="custom"`。
- 首帧 `--settings-user-accent` 为规范化值。
- 首帧计算出的 `--settings-structure-text` 达到 4.5:1。
- 首帧计算出的 `--settings-structure` 达到 3:1。
- 画布、导航、面板、控件与选中背景不同于原生皮肤，且保持不透明。
- Quiet / Chromatic × 深色 / 浅色四种组合都能应用同一主题色。
- 切换皮肤后版面、圆角、线宽和页码可见性不变。
- 切换深色 / 浅色后强调色派生值随模式变化。
- 选择预设色后控件、DOM 和工作副本一致。
- 自定义颜色输入提交后保存为规范化十六进制。
- 重新加载设置窗与重启进程后主题色保持。
- 恢复默认值后 `settings_accent` 为空，`data-settings-accent` 被移除，计算样式
  回到皮肤原生值。
- 撤销主题色修改后 DOM 与工作副本同时回到上一值。
- 只读 `settings.toml` 导致保存失败时，控件、DOM 与工作副本回滚，并显示
  行内错误。
- 设置搜索可命中「设置窗主题色」「调色盘」「強調色」。
- 1040×720 与 560×420 下主题色行、预览、色板和自定义颜色输入无横向溢出。
- 启动器计算样式与 `window.__LUME_CONFIG__` 中的主题色不参与启动器渲染；
  启动器 `--accent` 保持其原有值。
- Chromatic 页码、Quiet 圆角卡片、开关几何和帮助模态在主题色修改后保持原状。

现有 `scripts/cdp_settings_skin_verify.mjs` 继续运行，保证默认空主题色下既有
双皮肤矩阵不回归。实现后在该脚本中增加一项默认主题色的计算样式快照对比。

### 10.4 视觉与手工检查

- Quiet 深色、Quiet 浅色、Chromatic 深色、Chromatic 浅色各截一张外观页与
  一张插件页截图。
- 检查明亮黄、深黑、低饱和灰三组自定义色的：
  - 正文与次级文字可读性。
  - 焦点环可见性。
  - 选中背景与选中文字的边界。
  - 开关、页码、链接和警告行的可读性。
- 在 100% 与 200% 缩放下打开系统取色器，确认交互和命中区正常。
- 键盘遍历预设、颜色输入、帮助按钮和底栏按钮，焦点顺序稳定。
- 打开设置窗后切换 Windows 应用主题，确认跟随系统模式下强调色重新派生。
- 通过截图对比确认启动器、插件页、预览窗、分离插件窗口、托盘和 DWM 边框
  没有变化。

## 11. 风险与处理

| 风险 | 处理 |
|---|---|
| 自定义色导致小字对比度不足 | 文字 token 单独按 4.5:1 派生；焦点与装饰按 3:1 派生 |
| 表面染色过重破坏 Quiet / Chromatic 识别 | 固定低比例混色，不提供强度滑块，不覆盖中性文字与语义色 |
| 染色后选中文字不可读 | `--settings-selected-text` 保持皮肤原生值，选中背景固定低比例；四种组合逐一验证 |
| 颜色值被手写配置注入任意 CSS | Rust 只接受三位 / 六位十六进制并统一输出小写 `#rrggbb` |
| 首帧闪回原生皮肤 | 在 `render()` 前从 `__LUME_CONFIG__` 应用主题色 |
| 系统明暗切换后强调色不再可读 | effect 读取 `themeMode()`，主题翻转时重新派生 |
| 拖动取色器造成频繁写盘 | `input` 只预览，`change` 提交；保存队列使用 250ms 延迟 |
| 保存失败后 DOM 与工作副本分叉 | 所有失败、撤销、重试和恢复路径统一调用 `applySettingsAccent` |
| CSS 自引用导致颜色失效 | 皮肤提供 `--settings-*-base`，染色层引用基色而不是被覆盖的派生 token |
| 皮肤 token 漂移 | 基础色集中在各皮肤 token 块，染色层只定义固定混色规则 |
| 自定义色与预设名称不一致 | 预设只作为写入快捷方式，持久化始终是十六进制值 |
| 取色器跟着预设 / 皮肤跑 | 记忆值单独存 `settings_accent_custom`，只在取色器提交或自定义入口点击时改写；空值为纯白 `#ffffff` |
| 「默认」色块跟着在用颜色跑 | 色块从 `<html>` 读取皮肤原生 `--settings-structure`（染色层只覆盖 body 与 `.settings`），并读取 `themeMode()` 以跟随明暗 |
| Chromatic 默认色改动后原色不可达 | 原色 `#ac8e97` 占据该皮肤调色盘首格，标签 `settingsAccentPresetBlush`（浅粉） |
| 取色器系统界面与应用视觉不同 | 使用 WebView2 原生颜色输入，优先保证可访问性与系统行为一致 |
| 启动器意外继承颜色 | 所有规则限定在 `html[data-settings-accent] .settings`；不修改全局 token |

## 12. 验收标准

- 外观页可选择默认、六个预设色和自定义颜色；首格预设随皮肤取色。
- 自定义颜色即时预览，并在 250ms 内进入保存队列。
- 取色器显示 `settings_accent_custom`（未设置时为纯白 `#ffffff`），切换预设不改写它。
- 「默认」项的色块固定在当前皮肤的默认色上，不随正在使用的主题色变化。
- 点击自定义入口的名称直接应用记忆值（未保存过时为纯白），点击色块才打开取色器。
- 深色 Chromatic 的原生强调色为湖蓝，选中背景与显式湖蓝主题色一致。
- 主题色为空时，设置窗计算样式与现有 Quiet / Chromatic 原生值一致。
- 非空主题色同时影响结构色、文字强调色、选中背景与少量表面色。
- 所有自定义色在深色 / 浅色和两套皮肤下满足：
  - `--settings-structure-text` 对相关表面的对比度不低于 4.5:1。
  - `--settings-structure` 对相关表面的对比度不低于 3:1。
  - 选中文字对选中背景的对比度不低于 4.5:1。
- 主题色保存到 `appearance.settings_accent`，旧配置、导入和恢复备份不失败。
- 自动保存、失败回滚、六秒撤销、恢复默认值、窗口重开和进程重启后行为一致。
- 设置窗首帧无默认色闪烁。
- 跟随系统模式下，Windows 明暗切换会更新派生强调色。
- 设置搜索能定位该设置行；三语文案和键盘路径完整。
- 1040×720 与 560×420 下无横向溢出。
- 启动器、插件页、插件窗口、预览窗、托盘与 DWM 边框像素不变。
- 不新增 Tauri 命令、capability、SQLite 表或插件权限。

## 13. 落地顺序

1. 在 Rust schema 中加入字段、默认值、规范化与单元测试。
2. 在 TypeScript schema 与 `DEFAULT_SETTINGS` 中加入字段。
3. 实现 `src/settings/accent.ts` 的归一化、对比度派生和单一写入器。
4. 在 `index.tsx` 接入首帧应用，在 `Settings.tsx` 接入运行 effect 与保存链。
5. 为 Quiet / Chromatic 增加基础 token，并新增 `accent.css` 染色层。
6. 在外观页实现预设、自定义颜色输入和预览，补齐目录搜索与三语文案。
7. 扩展 Rust / CDP / 视觉验收，确认默认空值不回归。
8. 同步 `SETTINGS.md`、`UI_GUIDELINES.md`、`ARCHITECTURE.md`、`TESTING.md`、
   `ROADMAP.md` 与 `CHANGELOG.md`。

## 14. 实现时的文档同步

功能落地时按现有文档职责更新：

- `docs/SETTINGS.md`：新增 `appearance.settings_accent` 字段、外观页交互、
  自动保存与恢复默认语义。
- `docs/UI_GUIDELINES.md`：新增设置窗主题色的表面染色比例、强调色对比度、
  选中态和预览约束。
- `docs/ARCHITECTURE.md`：说明 `settings.skin.ts` / `settings.accent.ts` 的
  单一写入器、首帧注入与系统明暗重算。
- `docs/TESTING.md`：加入 CDP 脚本、手工取色器、200% 缩放和主题切换检查。
- `docs/ROADMAP.md`：从开放事项移除该条。
- `docs/ROADMAP_HISTORY.md`：记录实现决策、踩坑与验证数据。
- `CHANGELOG.md`：在 `[Unreleased]` 按仓库条目风格记录实现和文档变更。

活跃文档不得出现分期编号或完成状态标志；历史进度只进入
`CHANGELOG.md` 与 `docs/ROADMAP_HISTORY.md`。

## 15. 后续边界

若后续需要让主题色同时影响启动器和插件页，应拆成独立方案处理，因为还会涉及：

- 启动器 `--surface` 与 DWM 边框条同步。
- 插件页画布 `--lume-page-bg` 与主题事件。
- 分离插件窗口的 chrome、任务栏图标和预览窗边界。
- 启动器搜索、结果选中态和插件权限页的独立对比度验收。

设置窗主题色不预留跨窗口传播字段，也不让插件读取该偏好。后续跨窗口扩展必须
重新定义数据作用域和视觉契约。
