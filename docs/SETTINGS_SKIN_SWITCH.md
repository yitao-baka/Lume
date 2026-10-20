# 设置窗皮肤切换：Quiet Control Deck ↔ Chromatic Edge

适用范围：设置窗口（Tauri `settings` webview、`src/settings/`）。

本文定义设置窗两套完整视觉语言的共存与切换契约。默认皮肤为
[Quiet Control Deck](SETTINGS_REDESIGN.md)，可选皮肤为
[Chromatic Edge](SETTINGS_REDESIGN_SELECTED.md)。皮肤只改变设置窗的视觉与版面，
不改变字段语义、保存链路、插件权限、系统操作或启动器外观。

本文同时替代旧稿中“实现时只能选一套”“不新增设置字段”的约束。两套皮肤必须
各自完整成立，不能把圆角卡片、直角面板、两套色板或两套控件几何混在同一皮肤里。

## 文档关系

| 文档 | 直接职责 |
|---|---|
| 本文 | 两套皮肤的字段、默认值、首帧应用、切换、保存回滚、共享组件与验收 |
| [SETTINGS_REDESIGN.md](SETTINGS_REDESIGN.md) | Quiet Control Deck 默认皮肤，及两套皮肤共享的信息架构、字段映射和自动保存语义 |
| [SETTINGS_REDESIGN_SELECTED.md](SETTINGS_REDESIGN_SELECTED.md) | Chromatic Edge 可选皮肤，及其直角构图、控件、页面和最终色板 |
| [SETTINGS.md](SETTINGS.md) | 当前功能契约；设计落地后以其字段语义为运行时事实 |

## 目标与边界

- 在「外观」页提供设置窗皮肤选择，用户无需重启即可在 Quiet Control Deck 与
  Chromatic Edge 之间切换。
- 皮肤与明暗模式是两个正交维度：Chromatic Edge 使用浅色 Mineral Paper /
  深色 Charcoal Blush；Quiet Control Deck 使用自己的浅色 / 深色 token。
- 皮肤偏好持久化到 `settings.toml`，并随导入、恢复备份、恢复默认值一起生效。
- 切换过程中保留当前页面、滚动位置、键盘焦点和未提交的本地编辑。
- 设置窗是唯一消费该偏好的表面。启动器、插件页画布、分离插件窗口、托盘图标
  和 DWM 启动器边框继续使用现有主题，不受皮肤选择影响。
- 不新增 Tauri 命令或 capability；复用现有 `get_settings` /
  `save_settings_patch` / `settings-applied` 链路。

## 设置字段

新增一个 `appearance` 字段：

| 键 | 类型 | 值 | 默认值 | 作用域 |
|---|---|---|---|---|
| `appearance.settings_skin` | string | `quiet` / `chromatic` | `quiet` | 仅设置窗口 |

`appearance.color_mode` 保持不变：

| 键 | 类型 | 值 |
|---|---|---|
| `appearance.color_mode` | string | `system` / `dark` / `light` |

运行时组合如下：

| `settings_skin` | `color_mode` | 设置窗结果 |
|---|---|---|
| `quiet` | `system` | Quiet Control Deck，跟随系统明暗 |
| `quiet` | `dark` | Quiet Control Deck 深色 |
| `quiet` | `light` | Quiet Control Deck 浅色 |
| `chromatic` | `system` | Chromatic Edge，跟随系统明暗 |
| `chromatic` | `dark` | Chromatic Edge · Charcoal Blush |
| `chromatic` | `light` | Chromatic Edge · Mineral Paper |

`system` 继续由现有 `prefers-color-scheme` 监听解析，皮肤层不复制系统主题监听。

## 契约修订

旧稿中的以下约束由本文替代：

- [SETTINGS_REDESIGN.md](SETTINGS_REDESIGN.md) 的“不新增设置字段或插件能力”
  改为“除共享的 `appearance.settings_skin` 外，不新增其它设置字段或插件能力”。
- [SETTINGS_REDESIGN_SELECTED.md](SETTINGS_REDESIGN_SELECTED.md) 定义可选的
  Chromatic Edge 皮肤与最终色板；Quiet Control Deck 是默认皮肤。

现有字段映射、自动保存 / 撤销、设置搜索、分层帮助、插件主从视图和系统操作
边界全部沿用重设计稿，皮肤切换不产生功能分支。

## 数据与运行时

### Rust schema

在 `src-tauri/src/settings.rs` 的 `Appearance` 中加入：

```rust
#[serde(default = "default_settings_skin")]
pub settings_skin: String,

fn default_settings_skin() -> String {
    "quiet".into()
}
```

并在 `impl Default for Settings` 中显式写入 `settings_skin: "quiet".into()`，
与 `default.toml` 的生成结果保持一致。

新增统一规范化函数，所有反序列化入口都必须经过它：

```rust
pub fn normalize_settings_skin(value: &str) -> &'static str {
    match value {
        "chromatic" => "chromatic",
        _ => "quiet",
    }
}
```

规范化点：

- `read_settings`：旧配置缺字段时取 `quiet`；未知值回落为 `quiet`。
- `merge_settings_patch`：前端 patch 写入未知值时回落，不让整张设置表读取失败。
- `import_settings`、`restore_default`、`restore_backup`、`save_settings`：解析后
  统一规范化，避免外部 TOML 把设置窗留在无样式状态。
- `get_settings` 返回的永远是规范化后的值。

`settings_skin` 使用 `String` 而不是严格枚举，是为了让未来新增皮肤或外部配置
中的未知值可以安全回落到默认皮肤，而不是触发整张 `Settings` 反序列化失败。

### TypeScript schema

在 `src/settings/types.ts` 中增加：

```ts
export type SettingsSkin = "quiet" | "chromatic";

appearance: {
  // …
  settings_skin: SettingsSkin;
}
```

`DEFAULT_SETTINGS.appearance.settings_skin` 为 `"quiet"`。`diffSettings`
已经按叶子值比较，无需额外逻辑；旧配置缺字段由 Rust 的 `serde(default)` 补齐。

### 单一写入器

新增 `src/settings/skin.ts`，集中处理类型、规范化和 DOM 属性：

```ts
import type { SettingsSkin } from "./types";

export const SETTINGS_SKINS = ["quiet", "chromatic"] as const;
export const DEFAULT_SETTINGS_SKIN: SettingsSkin = "quiet";

export function normalizeSettingsSkin(value: unknown): SettingsSkin {
  return value === "chromatic" ? "chromatic" : DEFAULT_SETTINGS_SKIN;
}

export function applySettingsSkin(value: unknown): SettingsSkin {
  const skin = normalizeSettingsSkin(value);
  document.documentElement.dataset.settingsSkin = skin;
  return skin;
}
```

`applySettingsSkin` 是 `data-settings-skin` 的唯一写入者。组件不得直接写
`document.documentElement.dataset`，避免工作副本、持久化值和 DOM 状态分叉。

### 首帧应用

Tauri 已经在页面加载前把完整设置注入 `window.__LUME_CONFIG__`
（`src-tauri/src/lib.rs` 的 `initialization_script`），因此不增加新的启动 IPC：

1. `src/index.tsx` 先判断当前窗口是否为 `settings`。
2. 是设置窗时，在 `render()` 前调用
   `applySettingsSkin(__LUME_CONFIG__?.appearance?.settings_skin)`。
3. CSS 在首帧即可命中正确的 `html[data-settings-skin="…"]`，避免先显示默认皮肤
   再跳到持久化皮肤。
4. 浏览器预览或缺少配置时使用 `quiet`。

启动器窗口不设置该属性，也不读取该字段。

### 切换、保存与回滚

目标设置窗采用重设计稿的自动保存模型：

1. 用户选择皮肤时，先同步调用 `applySettingsSkin(next)`，再更新工作副本。
   这样属性变化与视觉反馈发生在同一帧，不闪一帧旧皮肤。
2. 自动保存队列按现有字段级合并规则提交
   `{ appearance: { settings_skin: next } }`。
3. 保存成功后更新基线，底栏显示已保存，并提供一次撤销。
4. 保存失败时把工作副本和 DOM 属性一起恢复到最近一次服务端确认值，在皮肤行
   下方显示 `role="alert"` 错误，并保留重试入口。
5. 撤销恢复旧皮肤时走同一条切换与保存路径，不直接改属性绕过队列。
6. 窗口关闭前 flush 待提交值；失败时保持窗口打开和当前焦点。

外部配置变化：

- `settings-applied` 到达时，如果没有本地待提交写入，重新读取设置并应用皮肤。
- 有本地待提交写入时保留本地皮肤，等队列完成后以服务端确认值收敛。
- 自身写入触发的 `settings-applied` 只更新保存基线和状态，不触发整页重读。
- 导入、恢复备份、恢复默认值都属于显式替换：确认后重新读取设置，皮肤属性随
  工作副本一起刷新。

系统明暗变化只触发 `data-theme` 变化，不改变 `data-settings-skin`。

## UI 契约

### 外观页

在现有语言、颜色模式之后增加一行「设置窗皮肤」：

```text
设置窗皮肤                                      [Quiet] [Chromatic]
只改变设置窗口；启动器和插件页面保持现有外观。
```

推荐使用两段式选择或两张带文字的可选预览块：

- `Quiet Control Deck`：圆角卡片、双平面、紧凑导航。
- `Chromatic Edge`：直角面板、编号导航、编辑式页码。
- 选中态同时使用色面、边框或角标，不能只靠颜色。
- 预览块内的文字必须来自 `t()`；不把英文方案名硬编码进可见标签。
- 行摘要明确作用域，避免用户误以为会改变整个应用。

无障碍语义：

- 使用 radio group 或带 `aria-pressed` 的分段控件。
- 左右方向键、Home / End 在两项间移动并切换。
- 当前值有可读名称；焦点环与选中态分离。
- 切换后焦点留在皮肤控件上，不因皮肤结构变化被移走。

新增三语键，至少包括：

```text
settingsSkin
settingsSkinQuiet
settingsSkinChromatic
settingsSkinHint
settingsSkinSaveFailed
```

英文键表以 `languages/en.json` 为准，`zh-CN.json` 与 `zh-TW.json` 同步补齐；
`Messages` 类型由英文键表驱动，缺键必须让 `tsc` 失败。

### 设置搜索

字段目录新增一项：

```ts
{
  id: "appearance.settings_skin",
  section: "appearance",
  path: `${t("navAppearance")} › ${t("settingsSkin")}`,
  label: t("settingsSkin"),
  summary: t("settingsSkinHint"),
  keywords: [
    "skin", "theme", "style",
    "quiet", "chromatic",
    "皮肤", "主题", "风格", "界面",
  ],
  kind: "segmented",
}
```

搜索命中后滚动到皮肤行并聚焦行容器，不直接触发切换。

## 组件与样式架构

### 组件层

皮肤切换依赖重设计稿建议的语义组件，而不是两套复制页面。目标结构：

```text
src/settings/
  Settings.tsx
  skin.ts
  shell/
    SettingsShell.tsx
    SettingsTopBar.tsx
    SettingsNav.tsx
    SettingsPageHeader.tsx
    SettingsStatusBar.tsx
  components/
    SettingGroup.tsx
    SettingRow.tsx
    SegmentedControl.tsx
    HelpBand.tsx
    StatusTicket.tsx
  skins/
    base.css
    quiet.css
    chromatic.css
```

页面文件仍只负责字段和动作。Shell、页面头、导航、分组、行、分段选择、帮助带和
状态票券由共享组件渲染；皮肤只改变这些组件的 token、几何和限定装饰。

### 稳定 DOM

切换皮肤时不得重建整棵页面树：

- 不给 `SettingsBody`、当前页面或 `SettingRow` 使用以皮肤为 key 的
  `<Show>` / `<Switch>`。
- Chrome 专用装饰（Chromatic 的页码、色柱编号、品牌块，Quiet 的双平面背景）
  常驻 DOM，由皮肤 CSS 显示或隐藏；纯装饰内容加 `aria-hidden="true"`。
- 两种皮肤共享同一组控件节点，因此焦点、IME、文本选择和滚动位置保持。
- 不允许两套皮肤各自渲染一份 `id` / `aria-labelledby` / `aria-controls`。

皮肤切换后调用现有滚动边缘测量函数，重新计算内容高度和上下渐隐提示；不重建
内容区。

### CSS 归属

- `skins/base.css`：共享布局骨架、语义 token、焦点与可访问性基础。
- `skins/quiet.css`：只包含
  `html[data-settings-skin="quiet"] .settings` 作用域内的规则。
- `skins/chromatic.css`：只包含
  `html[data-settings-skin="chromatic"] .settings` 作用域内的规则。
- `Settings.tsx` 显式导入以上三份样式；设置窗样式不再依赖启动器入口顺带加载
  `src/App.css`。
- 当前 `src/App.css` 中的设置窗样式迁入上述文件，避免同一选择器在多个位置
  重复覆盖。
- 不在 `:root` 或 `body` 上重写启动器共享的 `--surface`、`--text`、`--accent`
  等全局 token。在 `.settings` 根节点内把 `--surface`、`--text`、
  `--text-secondary`、`--text-muted`、`--border`、`--hover`、`--focus-ring`
  等兼容名映射到 `--settings-*` 语义 token；映射只作用于设置窗子树。
- `TitleBarControls` 在 `.settings` 内继承设置窗的文本、悬停和焦点 token；
  启动器与插件窗的标题栏不受影响。

推荐语义 token：

| Token | 用途 |
|---|---|
| `--settings-canvas` | 内容区主表面 |
| `--settings-rail` | 顶部导航与侧栏 |
| `--settings-panel` | 组卡片、详情面板 |
| `--settings-control` | 输入、分段控件、浮层 |
| `--settings-line` | 行分隔线 |
| `--settings-line-strong` | 面板与控件边框 |
| `--settings-text` | 主文字 |
| `--settings-secondary` | 次级文字 |
| `--settings-muted` | 摘要与元信息 |
| `--settings-structure` | 结构线、图标、焦点环 |
| `--settings-structure-text` | 页码、编号、小字强调 |
| `--settings-selected` | 当前项、选中面、主操作底 |
| `--settings-selected-text` | 选中面文字 |
| `--settings-signal` | 风险与警告边界 |
| `--settings-signal-text` | 错误与危险文字 |
| `--settings-success` | 成功状态 |

### 色板

两套皮肤都必须为浅色 / 深色提供完整映射：

| 角色 | Quiet 深色 | Quiet 浅色 | Chromatic 深色 | Chromatic 浅色 |
|---|---|---|---|---|
| canvas | `#191A1D` | `#F5F6F8` | `#1E1E20` | `#F3EFE6` |
| rail | `#151619` | `#F9FAFB` | `#18181B` | `#DDE5DE` |
| panel | `#1F2024` | `#FFFFFF` | `#262629` | `#FBF8F1` |
| control | `#292A30` | `#F2F3F5` | `#262629` | `#FBF8F1` |
| line | `#2A2B31` | `#ECEEF1` | `rgba(220,216,209,.14)` | `rgba(52,56,50,.16)` |
| line strong | `#303138` | `#DDE1E6` | `rgba(220,216,209,.28)` | `rgba(52,56,50,.34)` |
| text | `#F3F4F6` | `#1B1D21` | `#DCD8D1` | `#343832` |
| secondary | `#A4A7AE` | `#555D68` | `#BBB8B2` | `#4E554F` |
| muted | `#858992` | `#6F7782` | `#96949B` | `#626862` |
| structure | 现有 `--accent` | 现有 `--accent` | `#AC8E97` | `#64796D` |
| structure text | 现有 `--accent-text` | 现有 `--accent-text` | `#C0A4AC` | `#52675B` |
| selected | 现有 `--accent-tint` | 现有 `--accent-tint` | `#372D31` | `#D1DED4` |
| selected text | 现有 `--accent-text` | 现有 `--accent-text` | `#DCD8D1` | `#303A33` |
| signal | 现有 `--danger-border` | 现有 `--danger-border` | `#C09682` | `#B88374` |
| signal text | 现有 `--danger-text` | 现有 `--danger-text` | `#D0A68F` | `#86594D` |
| success | 现有 `--success-text` | 现有 `--success-text` | `#8DAE99` | `#4D6D58` |

Chromatic 的色值与对比度以
[SETTINGS_REDESIGN_SELECTED.md](SETTINGS_REDESIGN_SELECTED.md) 为准。Quiet
沿用[重设计稿](SETTINGS_REDESIGN.md)的建议色和现有品牌强调色，不新增第三种
品牌色。

### 几何

| 项目 | Quiet | Chromatic |
|---|---:|---:|
| 标题栏 | 48px | 52px |
| 侧栏宽 | 208px / 184px / 56px | 224px / 196px / 56px |
| 内容最大宽 | 760px | 760px |
| 页面标题 | 26px | 40px；窄窗 30px |
| 页面页码 | 无 | 96px；导航文字隐藏时隐藏 |
| 组面板圆角 | 10px | 0–2px |
| 控件圆角 | 8px | 0–2px |
| 结构线 | 1px | 1.5px |
| 焦点环 | 2px | 3px 硬边 |

两套皮肤共享 `560×420` 最小窗口和响应式断点语义。Chromatic 在窄窗口隐藏
大号页码和导航文字，Quiet 折叠为 56px 图标栏；两者都不得横向溢出，也不得让
底栏覆盖最后一个导航项。

## 页面适配

皮肤只改变视觉，不改变字段和交互：

- 外观：语言、颜色模式、设置窗皮肤使用同一行语法。
- 启动器：Quiet 使用圆角卡片；Chromatic 使用编号组和直角面板；位置网格与
  条目预览共享同一状态。
- 剪贴板：两种皮肤的列表编辑器共享行数据和校验；风险边界分别使用现有危险色
  或 Chromatic 陶土色。
- 搜索：Quiet 使用圆角搜索框；Chromatic 使用硬边搜索和浮层；结果目录、跳转
  与高亮目标相同。
- 快捷键：Quiet 使用常规组合键按钮；Chromatic 使用大号 keycap，但录制状态机
  完全复用。
- 自动化：Quiet 使用规则卡片；Chromatic 使用编号票券，展开后的字段一致。
- 插件：Quiet 使用主从视图卡片；Chromatic 使用硬边列表与纸面详情，选中、
  筛选和详情状态一致。
- 系统：状态票券与确认对话框共享动作与真实结果，皮肤只改变几何和色彩。
- 关于：共享版本、许可证、贡献者和主页链接，皮肤只改变品牌区构图。

如果某个页面暂时无法用共享 DOM 表达，优先增加可隐藏的装饰节点；不得复制整页
逻辑或在皮肤之间维护两套事件处理。

## 实施任务分解

| 改动面 | 文件 | 内容 |
|---|---|---|
| 文档契约 | `docs/SETTINGS_REDESIGN*.md`、`docs/ROADMAP.md`、本文件 | 允许双皮肤与新增字段，默认 Quiet |
| Rust schema | `src-tauri/src/settings.rs` | 字段、默认值、规范化、反序列化入口、单测 |
| TS schema | `src/settings/types.ts` | 联合类型、`DEFAULT_SETTINGS` |
| 皮肤运行时 | `src/settings/skin.ts`、`src/index.tsx` | 单一写入器、首帧属性 |
| 设置窗状态 | `src/settings/Settings.tsx` | 即时预览、自动保存、失败回滚、外部刷新 |
| 外观页 | `src/settings/AppearancePane.tsx`、`src/settings/catalog.ts` | 皮肤行、搜索目录 |
| 文案 | `src/i18n.ts`、`languages/*.json` | 三语键与搜索关键词 |
| 共享组件 | `src/settings/shell/*`、`src/settings/components/*` | Shell、导航、页头、行、组、分段控件 |
| 视觉实现 | `src/settings/skins/*.css`、`src/App.css` | 两套 token、几何与限定装饰；移除重复设置样式 |
| 窗口壳 | `src-tauri/src/lib.rs` | 重设计默认尺寸 `1040×720`；最小尺寸保持 `560×420` |
| 验证 | `scripts/cdp_settings_skin_verify.mjs`、`docs/TESTING.md` | 切换、持久化、焦点、响应式与视觉断言 |

实现顺序应先完成共享语义组件和选中方向的主壳，再接皮肤切换。直接在旧的
`settings-group` 结构上叠加两套 CSS 只能得到近似效果，无法满足两套稿的导航、
页头、圆角和控件几何契约。

## 测试与验收

### 自动化

Rust：

- 旧 `settings.toml` 缺少 `settings_skin` 时读出 `quiet`。
- `quiet` 与 `chromatic` 写入后 round-trip 保持原值。
- 未知值与空字符串规范化为 `quiet`，不导致整张设置表回退。
- `save_settings_patch` 只改皮肤时，其它 section 与并发轻写保持。
- 导入、恢复默认和恢复备份都走同一规范化路径。

前端：

- `pnpm exec tsc --noEmit`。
- `pnpm run build`。
- `cargo check` 与 `cargo test`。
- 设置目录搜索能命中「设置窗皮肤」。
- 切换皮肤后工作副本、`dataset.settingsSkin` 和保存 patch 一致。
- 保存失败时控件、DOM 属性和工作副本一起回滚。

CDP：

- 启动时 `settings.toml` 为 `quiet`，设置窗首次可见时已是 Quiet，不闪默认皮肤。
- 逐一切换六种组合（两套皮肤 × 跟随系统 / 深色 / 浅色），断言
  `data-settings-skin`、`data-theme` 和关键 computed style。
- Quiet 的关键断言：面板圆角非零、侧栏为双平面、无大号页码。
- Chromatic 的关键断言：结构线为 1.5px、面板直角、页码与编号可见。
- 切换后焦点仍在皮肤控件，滚动位置不重置。
- 隐藏并重新打开设置窗后皮肤保持；重启进程后仍保持。
- `1040×720` 与 `560×420` 下九个页面均无横向溢出。
- 三语下皮肤标签、摘要和搜索无截断。

### 视觉与手工

- 截图覆盖 Quiet 深色 / 浅色与 Chromatic 深色 / 浅色，至少包含启动器页、
  插件页、自动化规则展开和系统操作区。
- 检查没有跨皮肤 token 泄漏：Quiet 不出现页码和陶土结构线，Chromatic 不出现
  圆角卡片或青色胶囊。
- 200% 缩放、键盘遍历、焦点陷阱、帮助展开、搜索跳转和快捷键录制各复核一次。
- 高 DPI 与最小窗口下检查文字换行、底栏、确认对话框和滚动边缘提示。

### 验收标准

- 用户能在外观页即时切换两套皮肤，页面、焦点和滚动位置保持。
- 选择持久化到 `appearance.settings_skin`，默认值为 `quiet`。
- 每套皮肤在浅色与深色下都完整成立，不混用另一套的几何或色板。
- 设置窗之外的启动器、插件页、插件窗口、托盘和 DWM 边框像素不变。
- 所有现有设置、插件、搜索、自动化与系统操作行为不变。
- 旧配置、导入配置和恢复备份不会因皮肤字段缺失或未知而失败。

## 风险与处理

| 风险 | 处理 |
|---|---|
| 两套皮肤长期维护成本翻倍 | 共享语义组件与 token；皮肤文件只承载视觉差异 |
| 全局 token 泄漏到启动器或插件页 | 设置窗根节点内映射；禁止修改全局 `--surface` |
| 皮肤切换导致焦点或滚动丢失 | 稳定 DOM，不按皮肤 key 重建页面树 |
| 首帧闪回默认皮肤 | 用 `__LUME_CONFIG__` 在 `render()` 前写属性 |
| 未知配置导致设置窗无样式 | Rust 与前端双重规范化，未知值回落 `quiet` |
| 自动保存失败后视觉与磁盘不一致 | DOM 属性跟随工作副本回滚，错误留在皮肤行 |
| 窄窗口两套布局互相影响 | 皮肤规则全部作用域化；`560×420` 双皮肤回归 |
| 可搜索性与无障碍退化 | 目录项、三语键、radio 语义和键盘路径进入验收 |

## 非目标

- 不把皮肤选择扩展到启动器或插件页面。
- 不提供逐页面、逐插件的设置窗皮肤覆盖。
- 不引入第三方皮肤包、脚本化主题或在线加载资源。
- 不新增皮肤专属设置字段或改变任何现有字段语义。
- 不根据操作系统版本或明暗模式自动切换 Quiet / Chromatic；明暗模式只决定
  当前皮肤使用哪套色板。
