# 双窗口皮肤系统

本文定义主启动器与设置窗口分别选择皮肤、同时共享主题色与明暗模式的运行契约。启动器外壳、导航页、剪贴板页、嵌入插件画布和分离插件窗口跟随主窗口皮肤；设置窗口使用独立皮肤。

字段、迁移规则、surface 来源、插件视觉事件和验证矩阵以本文为准；设置交互见 `SETTINGS.md`，视觉边界见 `UI_GUIDELINES.md`，插件载荷见 `PLUGIN_API.md`。

相关文档：

- [ARCHITECTURE.md](ARCHITECTURE.md)
- [UI_GUIDELINES.md](UI_GUIDELINES.md)
- [SETTINGS.md](SETTINGS.md)
- [PLUGIN_API.md](PLUGIN_API.md)
- [TESTING.md](TESTING.md)
- [History/README.md](History/README.md)（旧设置窗皮肤/主题色设计记录）

## 目标

皮肤是窗口级视觉语言：主窗口和设置窗口可以独立选择 Quiet 或 Chromatic，但同一窗口组内保持统一。

目标模型：

```text
appearance.skin
    ├─ 启动器外壳
    ├─ 导航页
    ├─ 剪贴板页
    ├─ 嵌入插件画布
    └─ 分离插件窗口

appearance.settings_skin
    └─ 设置窗口

appearance.color_mode
    └─ 两个窗口共享的正交明暗维度

appearance.window_color
    └─ 主启动器表面色覆盖（空值跟随 skin）

appearance.window_opacity
    └─ 主启动器整体不透明度（70–100%）

appearance.accent
    └─ 两个窗口共享的强调色身份
```

约束：

- 主窗口皮肤使用 `appearance.skin`，设置窗口皮肤使用 `appearance.settings_skin`。
- 全应用只有一个主题色偏好：`appearance.accent`；空值在各自窗口按自己的皮肤取默认色。
- 颜色模式继续使用 `appearance.color_mode`，两个窗口共享。
- 主启动器可用 `appearance.window_color` 覆盖皮肤表面色，并用
  `appearance.window_opacity` 调整整窗不透明度；设置窗口与分离插件窗口不跟随这两项。
- 导航和剪贴板的 Presenter 选择继续使用 `pages.presenters`，与皮肤正交。
- 皮肤身份、表面颜色和对比度锚点由一份共享元数据定义。
- CSS 负责视觉 token 与 surface 布局，Rust 负责持久化、主窗 DWM 边框和目标窗口的初始表面颜色。
- 两个窗口都在首帧前应用各自皮肤；设置保存后实时同步，不要求重启。
- 内置皮肤由应用自身维护，不允许插件注入任意 CSS 或脚本。

## 非目标

- 不做逐页面皮肤覆盖；`pages.skins` 不进入目标模型。
- 不把 `navigate-list`、`clipboard-compact` 等结构型 Presenter 改名为皮肤。
- 不把设置窗口的侧栏、页码或底栏布局复制到启动器。
- 不为插件自有 DOM 强制换肤；宿主只保证外框、画布和公开视觉变量一致。
- 不开放第三方 CSS/JS 皮肤包。若以后需要扩展，应另立声明式皮肤包契约。
- 不重绘托盘图标、系统原生对话框或 Windows 原生菜单。
- 卫星预览窗口保持现有自包含视觉，不跟随主窗口皮肤或主题色。
- 不改变插件自己的 `lume.theme.set` 明暗覆盖语义。

## 实现结构

### 设置窗口

设置窗口是独立 webview，由 `src/settings/` 渲染。

- `src/index.tsx` 在 `render()` 前按窗口 label 选择 `appearance.settings_skin`。
- `src/skins/runtime.ts` 写入 `data-skin` 与 `--surface`。
- `src/skins/accent.ts` 写入 `data-accent` 与五层 `--ui-*` 强调 token。
- `src/settings/Settings.tsx` 负责即时预览、自动保存、失败回滚和外部刷新。
- 设置窗口的 DWM 边框被清除；其内部 canvas 由设置皮肤 token 定义，根节点
  `--surface` 来自设置皮肤元数据。

### 主启动器

主启动器是单个透明 webview；内容表面由 CSS 绘制。

- `.launcher` 使用有效 `--surface`：`appearance.window_color` 非空时用该色，
  否则用 `appearance.skin` + `appearance.color_mode` 对应的皮肤表面色。
- `appearance.window_opacity` 通过根节点整体透明度作用于整个主窗，包括嵌入
  插件页面；设置窗口和分离插件窗口保持不透明。
- DWM 可见边框区域由 `window::apply_launcher_chrome` 处理：`100%` 时使用同一
  有效表面色，低于 `100%` 时清除边框条（DWM 颜色不支持 alpha）。
- 启动器面板、DWM 与插件默认画布的表面色与 `appearance.settings_skin` 无关。
- 导航页和剪贴板页通过 keep-alive host 挂载在同一个 `.results` 中。
- 搜索行和页面之间不允许出现色差、分隔线或局部圆角；不透明度必须是整窗统一值。

### 导航和剪贴板

两页都已经是 Page Model / Presenter 架构：

- 导航：`navigate-grid`、`navigate-list`
- 剪贴板：`clipboard-list`、`clipboard-compact`

Page Service 持有业务数据和动作，Presenter 只负责 DOM、布局和交互形式。皮肤只影响 Presenter 及其容器使用的视觉 token，不接触 Page Service。

剪贴板 Presenter 还会通过 `viewport.request` 上报行高；虚拟列表的 spacer、窗口偏移、键盘滚动和滚动查询都依赖该值。皮肤若改变行高，必须同步修改这个运行时契约。

### 插件画布与分离插件窗口

- 嵌入主启动器的磁盘插件 Presenter 位于沙箱 iframe 中。
- `src/page-runtime/presenterBridge.tsx` 使用当前窗口的有效 surface 作为 iframe 初始背景，并在 `theme` / `skin` 事件中更新 `--lume-page-bg`、`--lume-page-accent` 与 `data-lume-skin`；主窗使用覆盖色时这里同步使用覆盖色。
- 分离插件窗口由 `src/pluginWindow.tsx` 渲染外壳，由 `plugin_window.rs` 在创建时设置不透明背景色；两者都跟随主窗口的 `appearance.skin`，不跟随主窗颜色覆盖与不透明度。
- 插件自己的 `theme` 事件继续只传 `"light" | "dark"`，不能把字符串载荷改成对象而破坏现有插件。
- 皮肤信息通过附加 `skin` 事件和 `theme.get()` 附加字段提供，不改变 API 2 的 `theme` 字符串载荷。

## 必须保持的不变量

1. **单一面板**：任何一个启动器窗口在任何时刻只有一个连续的启动器表面色。搜索行、页面和 iframe 默认画布必须使用同一有效表面色；`100%` 不透明度时 DWM 边框条也相同。
2. **外层几何不变**：启动器外层仍然没有 CSS border 或 border-radius；圆角、阴影和 `100%` 时的边框条由 DWM 负责。主窗半透明只由 `appearance.window_opacity` 的统一整窗合成产生，不做局部半透明或 backdrop blur。
3. **双窗口皮肤边界**：主窗口皮肤覆盖启动器、导航、剪贴板、嵌入插件画布和分离插件窗口；设置窗口只跟随 `appearance.settings_skin`。
4. **颜色模式正交**：切换皮肤不改变 `appearance.color_mode`；系统模式仍由现有 `prefers-color-scheme` 监听解析。
5. **Presenter 正交**：切换皮肤不重建 Page Service、Page Session 或 Presenter 选择。
6. **首帧一致**：主窗读取 `appearance.skin`，设置窗读取 `appearance.settings_skin`，分离插件窗读取主窗皮肤；都不能先画默认皮肤再跳变。
7. **表面来源一致**：启动器外层表面色由共享皮肤元数据加可选 `window_color` 覆盖同时驱动 CSS、Presenter iframe 默认背景和 Rust DWM 边框；分离插件窗口只使用共享皮肤元数据。
8. **主题色与表面色正交**：自定义主题色只改变交互强调、选中、焦点和链接，不直接改写 `--surface`；主窗表面只由皮肤或 `window_color` 决定。表面覆盖会触发主题色对比度重算。
9. **没有新增权限面**：皮肤、主窗颜色与不透明度、主题色都属于宿主视觉设置，不新增 Tauri capability、插件权限或数据库。
10. **不透明度下限**：`appearance.window_opacity` 限制在 `70..100`，避免整窗淡出后文字和控件不可用。

## 数据模型

### 字段

`appearance` 使用以下字段：

| 键 | 类型 | 默认值 | 作用范围 |
|---|---|---|---|
| `appearance.skin` | string | `quiet` | 启动器、导航、剪贴板、插件外壳与画布、分离插件窗口 |
| `appearance.settings_skin` | string | `chromatic` | 设置窗口 |
| `appearance.window_color` | string | `""` | 主启动器表面色覆盖；空值跟随皮肤 |
| `appearance.window_opacity` | number | `100` | 主启动器整窗不透明度（`70..100`） |
| `appearance.accent` | string | `""` | 全应用交互强调色；空值使用各窗口自身皮肤的默认色 |
| `appearance.accent_custom` | string | `""` | 主题色取色器最后使用的颜色；空值显示纯白色 |

`appearance.color_mode` 保持：

| 键 | 值 |
|---|---|
| `appearance.color_mode` | `system` / `dark` / `light` |

### TOML 形状

```toml
[appearance]
language = "system"
color_mode = "system"
skin = "quiet"
settings_skin = "chromatic"
window_color = ""
window_opacity = 100
accent = ""
accent_custom = ""
```

`pages.presenters` 保持现状：

```toml
[pages.presenters]
apps = "navigate-grid"
clipboard = "clipboard-list"
```

### 规范化

- `skin` / `settings_skin` 只接受注册表中的已知 id；未知值、空值各自回落到 `quiet`。
- 任一皮肤字段缺失时继承另一个，兼容统一皮肤时代只有 `skin` 或更早只有 `settings_skin` 的配置；两个字段都缺失时启动器使用 `quiet`、设置窗使用 `chromatic`；两个字段都存在时独立生效。
- `window_color`、`accent` 与 `accent_custom` 只接受 3 位或 6 位十六进制颜色；
  统一转成小写 `#rrggbb`。`window_color` 非法值回落为空，即跟随皮肤。
- `window_opacity` 在读取、导入、恢复和 patch 合并后限制在 `70..100`。
- 非法主题色回落到 `""`，即跟随当前皮肤默认强调色。
- 所有反序列化入口都必须经过同一规范化函数：读取、patch 合并、导入、恢复默认、恢复备份和整表保存。
- TypeScript 侧重复同样的规范化，防止初始化脚本被手工破坏后留下无样式 DOM。

## 共享皮肤元数据

新增机器可读文件：

```text
src/skins/skins.json
```

它保存 Rust 和前端都必须一致的皮肤身份与启动器表面色，避免 CSS、TypeScript 和 Rust 各自维护一套 DWM 配色。

当前形状：

```json
{
  "version": 1,
  "default": "quiet",
  "skins": {
    "quiet": {
      "surfaces": {
        "dark": "#1e1e20",
        "light": "#f7f3e8"
      },
      "accentAnchors": {
        "dark": "#574e52",
        "light": "#d1ded4"
      },
      "accents": {
        "dark": "#5ac8fa",
        "light": "#0969da"
      }
    },
    "chromatic": {
      "surfaces": {
        "dark": "#1e1e20",
        "light": "#f3efe6"
      },
      "accentAnchors": {
        "dark": "#574e52",
        "light": "#d1ded4"
      },
      "accents": {
        "dark": "#5ac8fa",
        "light": "#64796d"
      }
    }
  }
}
```

规则：

- `surfaces` 是启动器面板、DWM 边框条、嵌入插件默认画布和分离插件窗口画布的权威颜色。
- `accentAnchors` 是自定义主题色做对比度修正时使用的最不利背景锚点。
- `accents` 是该皮肤在对应明暗下的原生强调色，供设置页「默认」色块读取。
- TypeScript 直接导入该 JSON。
- Rust 使用 `include_str!` 编译进二进制，并用 `OnceLock` 解析一次；解析失败时回落到 `quiet` 的静态安全值，不能 panic。
- CSS 只保留默认皮肤的 fallback 表面值；运行时通过内联 CSS 变量把当前皮肤/明暗解析出的表面色写到根节点。

## 模块结构

```text
src/skins/
├── skins.json          # 皮肤 id、启动器表面色、对比锚点
├── registry.ts         # 类型、注册表读取、规范化
├── runtime.ts          # data-skin、--surface、统一应用入口
├── accent.ts           # 主题色规范化、对比度派生、CSS 变量
├── shared.css          # 所有主题窗口共用的 token 与 accent 层
├── launcher.css        # 启动器 / 嵌入 Presenter 的皮肤组件层
├── settings.css        # 独立设置窗的皮肤组件层
├── tokens.css          # 语义 token 契约与默认 fallback
├── quiet/
│   ├── tokens.css      # Quiet 设置窗 token
│   ├── settings.css
│   └── launcher.css
└── chromatic/
    ├── shared.css      # Chromatic 默认 accent（所有窗口共用）
    ├── tokens.css      # Chromatic 设置窗 token
    ├── settings.css
    └── launcher.css
```

入口按窗口职责分别引用：`src/index.tsx` → `launcher.css`，
`src/settings-entry.tsx` → `settings.css`，分离插件窗 →
`shared.css`。设置窗的布局骨架继续放在
`src/settings/skins/base.css`。原 `src/settings/skins/quiet.css`、
`chromatic.css` 中的共享 token 和 surface 专属视觉规则拆到
`src/skins/`，避免设置窗和启动器各维护一份皮肤颜色。

### 单一写入器

`src/skins/runtime.ts` 必须是以下 DOM 状态的唯一写入者：

- `document.documentElement.dataset.skin`
- `document.documentElement.style.getPropertyValue("--surface")`
- 皮肤相关的根节点 class 或 attribute（如后续新增）

`src/skins/accent.ts` 必须是以下状态的唯一写入者：

- `document.documentElement.dataset.accent`
- 自定义主题色对应的根节点 CSS 变量

`src/theme.ts` 继续拥有：

- `data-theme`
- 系统明暗监听
- `themeMode()` 响应式访问器

## 运行时流程

### 首帧

Rust 的初始化脚本继续把完整设置注入 `window.__LUME_CONFIG__`。

主启动器和设置窗共享的 `src/index.tsx` 在 `render()` 前执行：

```text
select window skin (`skin` or `settings_skin`)
normalize accent
apply data-skin
apply color mode
resolve effective light/dark
apply --surface from skins.json
derive and apply accent tokens
render
```

`src/pluginWindow.tsx` 使用同一运行时，但颜色模式按插件的有效模式解析：

```text
host color_mode + plugin color mode override
    → effective mode
    → skin surface for that mode
    → accent tokens for that mode
    → render
```

这样主启动器、设置窗和分离插件窗都不会闪默认皮肤。

### 实时更新

```text
设置窗口修改 skin / settings_skin / accent
    ↓
save_settings_patch
    ↓
Rust 合并、规范化、写 settings.toml
    ↓
window::apply_settings 更新主窗 DWM 边框
    ↓
emit settings-applied
    ↓
主启动器按 `skin`、设置窗按 `settings_skin`、分离插件窗按 `skin` 重新 get_settings
    ↓
各窗口重新应用自己的 data-skin / data-theme / --surface / accent tokens
    ↓
插件 Presenter 收到附加的 skin 视觉事件
```

设置窗的即时预览仍然只改自己的 DOM；主启动器只在保存成功后变化。保存失败时设置窗把 DOM 恢复到 baseline。

### 系统明暗切换

- `applyColorMode("system")` 继续监听 `prefers-color-scheme`。
- 明暗信号变化后，每个窗口必须重新执行：
  1. 解析当前皮肤下的 `--surface`；
  2. 重新计算自定义主题色在当前明暗下的对比度 token；
  3. 重新推送插件画布所需的 surface 与 accent。
- Rust 的 `WindowEvent::ThemeChanged` 路径重新解析 `appearance.skin + appearance.color_mode`，更新主窗 DWM 边框；不读取设置窗皮肤。
- 切换明暗不得改变 `appearance.skin` / `appearance.settings_skin`，也不得重建 Presenter。

## 表面与 DWM

### 共享表面来源

前端 `src/skins/runtime.ts`：

```text
skinSurface(skin, resolvedMode) -> "#rrggbb"
```

Rust `window` 模块：

```text
skin_surface(skin, resolvedMode) -> (u8, u8, u8)
```

两者都从 `src/skins/skins.json` 派生，不允许各自维护另一份皮肤表面表。

### Rust 改动

`window::apply_launcher_chrome(win, appearance)` 解析有效主窗表面色和
`window_opacity`：满不透明度时把 DWM 边框条涂成同一有效表面色，低于 `100%`
时清除边框条。调用点：

- `lib.rs` 主窗创建后的首帧 DWM 边框。
- `lib.rs` 的 `WindowEvent::ThemeChanged` 路径。
- `window::apply_settings`。
- 任何以后新增的主窗重新应用路径。

主窗 WebView 以 `transparent(true)` 创建，不设置原生背景色；`--surface` 与
整窗不透明度由 CSS 绘制。`panel_surface_rgb` 与 `panel_surface_rgb_for` 仍服务
分离插件窗口的不透明背景。

`plugin_window.rs`：

- 从设置快照读取主窗口的 `appearance.skin`。
- 使用插件有效颜色模式解析插件窗口表面。
- 创建窗口时设置对应的不透明 background color。
- 运行中皮肤变化时由 webview CSS 重新绘制，不依赖重建窗口。

### 前端 iframe

`src/page-runtime/presenterBridge.tsx`：

- 注入脚本时使用 `currentSurface(currentThemeMode())`；主窗存在颜色覆盖时返回覆盖色，否则返回皮肤表面色。
- 皮肤、明暗或主窗颜色变化时，把新的有效 surface 写入 iframe 根节点。
- 明暗变化和皮肤变化都要更新同一变量。

### 设置窗口

设置窗口继续清除 DWM 边框。它的 `data-skin` 与 `--surface` 来自 `appearance.settings_skin`，不参与启动器 DWM 表面的逐像素约束。

## 主题色

### 语义

`appearance.accent` 是全局颜色身份，不是某个窗口的私有变量。

它影响：

- 焦点环
- 选中边框和选中背景
- 活动导航项
- 链接和可操作强调文字
- 进度、滑块和开关的活动态
- 设置窗口的强调结构色
- 插件外壳 titlebar 和错误页的强调态

它不影响：

- 启动器外层 `--surface`
- DWM 边框颜色
- 插件自有页面内部未经宿主变量接入的布局
- 原生系统控件和系统对话框

### 默认值与自定义

- `appearance.accent === ""` 且主窗没有颜色覆盖：不写 `data-accent`，不写主题色覆盖变量；皮肤 CSS 提供当前明暗下的默认强调色。
- `appearance.accent === ""` 且主窗有颜色覆盖：写入 `data-accent="surface"`，用皮肤默认强调色按实际表面重算安全 token。
- `appearance.accent === "#rrggbb"`：写入 `data-accent="custom"`，并派生当前表面下的安全 token。
- `appearance.accent_custom` 只记录取色器最后使用的颜色；切换预设或恢复默认不得清除该记忆值。

### 对比度派生

至少派生：

| 变量 | 用途 | 最低对比度 |
|---|---|---|
| `--ui-accent` | 装饰、填充、选中背景原料 | 3:1，用于可交互边界 |
| `--ui-accent-text` | 小字、链接、强调文字 | 4.5:1 |
| `--ui-accent-border` | 可见选中边框 | 3:1 |
| `--ui-accent-on` | 强调色填充上的文字/图标 | 4.5:1 |
| `--ui-focus-ring` | 键盘焦点环 | 3:1 |

未覆盖主窗颜色时，派生背景使用 `skins.json` 对应皮肤的 `accentAnchors[mode]`；存在 `window_color` 时使用该实际表面色。文字层和强调层都按表面的明暗色调选择修正方向。

### CSS token 映射

启动器和插件窗口：

```css
:root {
  --accent: var(--ui-accent);
  --accent-text: var(--ui-accent-text);
  --accent-tint: color-mix(in srgb, var(--ui-accent) 16%, transparent);
  --accent-border: var(--ui-accent-border);
  --accent-on: var(--ui-accent-on);
  --focus-ring: var(--ui-focus-ring);
}
```

设置窗口：

```css
.settings {
  --settings-structure: var(--ui-accent);
  --settings-structure-text: var(--ui-accent-text);
  --settings-selected: color-mix(in oklab, var(--ui-accent) 16%, var(--settings-panel-base));
}
```

设置窗口只把强调色用于 `--settings-selected` 等交互选中态；canvas、rail、panel、control 表面与启动器外层一样不参与染色。这样自定义主题色既能统一身份，也不会让 DWM 边框、设置页底色或 iframe 画布失去稳定来源。

## CSS 契约

### 根属性

- `data-theme="dark|light"`：明暗模式。
- `data-skin="quiet|chromatic"`：当前 webview 的皮肤；主窗与设置窗各自写入。
- `data-surface-tone="dark|light"`：仅在自定义主窗表面与颜色模式色调冲突时写入，用于切换可读调色板。
- `data-accent="custom|surface"`：显式主题色写 `custom`；只有主窗表面覆盖导致默认强调色需重算时写 `surface`。

旧 `data-settings-skin` 和 `data-settings-accent` selector 不再存在；运行时只写 `data-skin` / `data-accent`，避免两套规则并存。

### 共享 token

共享 token 应覆盖：

- 强调色五层：`--ui-accent`、`--ui-accent-text`、`--ui-accent-border`、`--ui-accent-on`、`--ui-focus-ring`
- 结构线：`--ui-line`、`--ui-line-strong`
- 控件几何：`--ui-control-radius`、`--ui-panel-radius`、`--ui-line-width`
- 状态色：危险、警告、成功
- 字体族与基础字号

启动器特有 token 继续放在 `src/theme.css`：

- `--surface`、`--surface-raised`
- `--text*`、`--icon-muted`
- `--hover`、`--selected`
- `--border*`
- 图标过滤

设置窗口特有 token 继续放在设置 surface CSS：

- `--settings-canvas`、`--settings-rail`、`--settings-panel`、`--settings-control`
- `--settings-text*`
- 设置侧栏、页头、组面板和控件几何

### 皮肤视觉方向

Quiet：

- 设置窗口保持圆角卡片、双平面、无页码。浅色画布 / 侧栏 / 面板 /
  控件使用 `#f0ede6` / `#f4f0e8` / `#f8f4ea` / `#ece7dd` 的暖米白层次。
- 启动器内部控件使用较柔和的圆角和低对比结构线。
- 外壳仍由 DWM 负责圆角，不增加 CSS 外框。

Chromatic：

- 设置窗口保持直角、结构线、编辑式页头和页码。浅色侧栏使用
  `#ebe6dc` 暖灰米白，与 `#f3efe6` 画布和 `#fbf8f1` 面板形成克制层次。
- 启动器内部增加直角/近直角控件、1.5px 结构线和编辑式栏目标题。
- 搜索行、页面和 iframe 仍共用同一表面色。
- 不改变外层窗口 CSS border/radius/透明约束。

### 皮肤样式隔离

- 所有皮肤规则必须以 `html[data-skin="..."]` 或对应 surface 容器为作用域。
- Quiet 不得泄漏圆角卡片语义到 Chromatic。
- Chromatic 不得给 `.launcher` 增加可见外框或 CSS 圆角。
- 任何皮肤样式不得修改原生滚动条策略、焦点可见性规则或内容命中区域。

## 导航与剪贴板

### 导航

- `navigate-grid` 和 `navigate-list` 继续消费相同 Page Model。
- 皮肤只改变 Presenter 根节点和内容 token。
- 条目尺寸、网格列数和窗口 fit 高度继续由现有 sizing 逻辑测量。
- 皮肤切换后必须重新测量栏列数和窗口高度，避免 `barCols` 停留在旧几何。

### 剪贴板

- `clipboard-list` 和 `clipboard-compact` 继续消费相同 Page Model。
- 行高成为皮肤契约的一部分，而不是散落在 Presenter 内的固定常量。

目标接口：

```ts
clipboardRowHeight(skin, presenterId): number
```

Presenter 必须使用该值：

- spacer 总高度
- 窗口 offset 计算
- `viewport.request.rowHeight`
- 键盘选中项滚动
- ResizeObserver 重新测量

皮肤切换时：

1. 保留当前选择的 item id。
2. 更新行高和 CSS。
3. 重新上报 viewport。
4. 把选中项滚回可见区域。
5. 不重建 Page Service。

如果某套皮肤不改变行高，也要通过同一接口返回当前固定值，禁止再次硬编码第二份常量。

## 插件表面

### 嵌入插件

宿主给每个 Presenter iframe 注入：

- 当前有效 `data-theme` 对应的画布色
- `--lume-page-bg`
- 主窗口当前皮肤 id
- 当前有效主题色

新增公开视觉事件，保留旧事件：

```text
theme  -> "light" | "dark"        （保持现状）
skin   -> { id, accent, surface } （新增，可忽略）
```

`lume.theme.get()` 返回值增加：

```ts
{
  pref: PluginColorMode;
  mode: ColorMode;
  host: ColorMode;
  skin: SkinId;
  accent: string;
}
```

新增字段属于非破坏性扩展，API 版本仍保持 2。插件可以不消费 `skin`，但必须继续正确接收 `theme` 字符串。

### 分离插件窗口

`src/pluginWindow.tsx`：

- 首帧读取 `__LUME_CONFIG__`，应用主窗口皮肤、主题色和插件有效明暗。
- `settings-applied` 后重新读取设置并重算外壳。
- 把 skin/accent 附加到 `plugin-state` 推送。
- 页面 Presenter 仍通过 `theme` 和新增 `skin` 事件获得有效视觉状态。

`src/pluginWindow.css` 与 `TitleBar.css`：

- 使用共享 token。
- 不直接写死皮肤颜色。
- `--surface` 使用统一运行时算出的插件有效表面。
- titlebar 和 Presenter 画布之间不出现色差。

### 权限

- 不新增插件权限。
- 皮肤 id、主题色和表面色属于非敏感视觉元数据。
- 不允许插件修改主窗口或设置窗口的 skin，也不允许修改全局 accent。
- 不允许插件提供 CSS 注入宿主。

## 设置界面

### 外观页

字段 id 统一为：

- `appearance.skin`
- `appearance.accent`
- `appearance.accent_custom`

交互：

- 主窗口皮肤与设置窗口皮肤各用一组 RadioCards，保留方向键、Home、End 和 roving tabindex。
- 主题色继续使用现有预设和取色器，但文案改为全应用主题色。
- 切换皮肤或主题色不得重建页面、丢失焦点或改变滚动位置。
- 保存失败时同时回滚：
  - `data-skin`
  - `data-theme`
  - `data-accent`
  - `--surface`
  - 所有派生 accent 变量
- 设置搜索项、帮助文案和三语文案同步更新。

### 文案语义

需要明确告诉用户：

- 主窗口皮肤影响启动器、导航、剪贴板、嵌入插件画布和分离插件窗口。
- 设置窗口皮肤只影响设置窗口。
- 主题色影响全应用强调态，但不改变启动器外层表面。
- 插件自绘页面可能只跟随画布和公开变量，不保证内部布局完全重绘。

文案使用 `appearanceSkin*`、`appearanceSettingsSkin*` 与 `appearanceAccent*` 键，三语同步。

## 数据迁移与兼容

### 字段映射

| 旧字段 | 新字段 | 迁移规则 |
|---|---|---|
| 旧 `settings_skin` | `skin` + `settings_skin` | 仅旧字段存在时两窗继承同一值；新 `skin` 存在时设置窗缺省继承主窗 |
| 旧 `settings_accent` | `accent` | 新字段缺失时使用旧值；新字段显式为空时保持空 |
| `settings_accent_custom` | `accent_custom` | 同上 |

### 读取规则

- 新字段存在且合法：以新字段为准；`skin` 与 `settings_skin` 都存在时互不覆盖。
- 新字段缺失：迁移合法旧字段。
- 新字段存在但非法：回落默认值，不让整份设置失败。
- 新字段显式为空（主题色）：保留空的“跟随皮肤”语义，不复活旧主题色。
- 旧字段不参与运行逻辑，只作为读取期的兼容来源。

实现使用可区分“字段缺失”和“显式空值”的迁移结构；Rust 与 TypeScript 都做归一化。

### 写入规则

- `default.toml` 首次生成时写新字段。
- 保存、导入、恢复默认、恢复备份后只序列化新字段。
- 旧字段在下一次写入时被自然移除。
- `get_settings` 只返回规范化后的新字段。
- 不依赖 `meta.version` 触发迁移；所有入口都执行同一 schema 规范化。

### 兼容检查

必须覆盖：

- 只有 `skin` 的配置迁移后两窗都保持该皮肤。
- 只有旧 `settings_skin` 的配置迁移后两窗保持该皮肤。
- 两字段同时存在时分别保留，不被迁移逻辑合并。
- 旧自定义主题色迁移后仍生效。
- 新字段显式清空主题色后不会从旧字段重新出现。
- 手写未知 skin 不导致整份设置回退。
- 旧的 `backup.toml` 可以恢复并完成迁移。
- 导入旧 TOML 后写出新 TOML。

## 文件地图

| 文件 | 改动 |
|---|---|
| `src/skins/skins.json` | 新增皮肤 id、启动器表面色和对比锚点 |
| `src/skins/registry.ts` | 新增皮肤类型、注册表访问、规范化 |
| `src/skins/runtime.ts` | 新增 `data-skin`、`--surface` 与统一应用入口 |
| `src/skins/accent.ts` | 全应用 accent 规范化、对比度派生与 CSS 变量写入 |
| `src/skins/shared.css` | 所有主题窗口共用的 token、双皮肤和 accent 层 |
| `src/skins/launcher.css` | 共享层 + 启动器专属皮肤规则 |
| `src/skins/settings.css` | 共享层 + 设置窗专属皮肤规则 |
| `src/skins/quiet/*` | Quiet 设置窗 token、设置和启动器样式 |
| `src/skins/chromatic/*` | Chromatic 共享 accent、设置窗 token 与各窗口样式 |
| `src/settings/skin.ts` | 删除，改由 `src/skins/runtime.ts` 统一写入 |
| `src/settings/accent.ts` | 删除，改由 `src/skins/accent.ts` 统一写入 |
| `src/settings/skins/base.css` | 使用 `data-skin` 和共享 token |
| `src/theme.css` | 保留启动器基础 token；`--surface` 由统一运行时写入 |
| `src/theme.ts` | 保留 `data-theme` 与系统明暗监听，移除硬编码 surface |
| `src/App.tsx` | 应用运行时皮肤、主题色和表面；皮肤变化后重测布局 |
| `src/index.tsx` | 主窗首帧应用 `skin`，设置窗首帧应用 `settings_skin` |
| `src/App.css` | 增加内部几何 token；保持外层单面板契约 |
| `src/settings/Settings.tsx` | 更新字段、首帧、即时预览、保存回滚和外部刷新 |
| `src/settings/AppearancePane.tsx` | 更新字段 id、文案、预览和取色器 |
| `src/settings/catalog.ts` | 更新搜索目录和关键词 |
| `src/settings/types.ts` | 更新 `SettingsData`、默认值和类型 |
| `src/pluginWindow.tsx` | 首帧跟随主窗口 `skin`；settings-applied 重算；推送 skin 元数据 |
| `src/pluginWindow.css` | 使用统一 surface/token，不写死颜色 |
| `src/components/TitleBar.css` | 共用 accent、surface 和结构 token |
| `src/plugins/types.ts` | 扩展插件颜色状态中的 skin/accent 字段 |
| `src/plugins/registry.ts` | 皮肤/主题色变化时重推插件视觉状态 |
| `src/plugins/pageRuntimeMode.tsx` | 向 Presenter 推送新增 skin 事件 |
| `src/page-runtime/presenterBridge.tsx` | 动态 iframe 表面、skin/accent 变量与事件 |
| `src/presenters/clipboard-list/*` | 使用 `clipboardRowHeight`，保持选择可见并重报 viewport |
| `src/presenters/clipboard-compact/*` | 使用 `clipboardRowHeight`，保持选择可见并重报 viewport |
| `src/App.tsx` | 皮肤切换后重测栏列数与窗口 fit 高度 |
| `src-tauri/src/settings.rs` | 新字段、旧字段迁移、规范化、默认值、测试 |
| `src-tauri/src/window.rs` | 共享表面解析、skin-aware DWM 边框、测试 |
| `src-tauri/src/lib.rs` | 首帧和 ThemeChanged 传入 skin |
| `src-tauri/src/plugin_window.rs` | 分离插件窗口使用 skin + 有效明暗的背景色 |
| `languages/en.json` | 新皮肤/主题色文案 |
| `languages/zh-CN.json` | 同步文案 |
| `languages/zh-TW.json` | 同步文案 |
| `scripts/skin_system_unit_test.mjs` | 注册表、surface、行高与 accent token 单测 |
| `scripts/cdp_skin_system_verify.mjs` | 跨 surface、插件画布、分离窗口、行高与首帧回归 |
| `scripts/cdp_settings_skin_verify.mjs` | 验证设置窗 `settings_skin`、独立性、保存与响应式 |
| `scripts/cdp_settings_accent_verify.mjs` | 验证全局 accent 与启动器 surface 边界 |
| `scripts/cdp_plugin_theme_verify.mjs` | 增加 skin/accent/surface 推送断言 |

## 验证方案

### 编译与静态检查

```bash
pnpm exec tsc --noEmit
pnpm run test:page-runtime
pnpm run test:skin-system
pnpm run build
cd src-tauri
cargo check
cargo test
node scripts/check_i18n.mjs
```

文档改动另做：

- Markdown 相对链接可解析。
- 代码围栏成对。
- `git diff --check` 无尾随空白。
- 活跃文档不出现分期编号和完成状态标志。

### Rust 单元测试

- 缺省 settings 生成 `skin = "quiet"`、`settings_skin = "chromatic"`、空 `window_color`、`window_opacity = 100` 与空 accent。
- 旧 `settings_skin` / `settings_accent` / `settings_accent_custom` 迁移，且两个皮肤字段存在时保持独立。
- 新字段显式空值与旧字段共存的优先级。
- 未知 skin 回落。
- 主窗颜色 3/6 位展开、大小写规范化、非法值回落；不透明度限制在 `70..100`。
- 主题色 3/6 位展开、大小写规范化、非法值回落。
- patch、整表保存、导入、恢复默认和恢复备份都走同一规范化路径。
- `skins.json` 可解析；每个 skin 同时具备 dark/light surface 和 anchor。
- `skin_surface` 对四个 skin/mode 组合返回预期 RGB。
- 未知 skin 使用 `quiet` 表面。

### 前端/CDP 回归

`scripts/cdp_skin_system_verify.mjs` 覆盖：

- 启动即使用已保存皮肤；主窗和设置窗无默认皮肤闪帧。
- 主窗 Quiet + 设置窗 Chromatic、主窗 Chromatic + 设置窗 Quiet 双向独立生效。
- 通过真实设置 UI 切换设置窗皮肤时主窗皮肤不变；切换主窗皮肤时设置窗皮肤不变。
- 重启进程后两个皮肤字段分别保持。
- 未知皮肤值回落 Quiet，不影响其余设置。
- 两套皮肤 × 两种明暗下：
  - `.launcher` 计算背景等于共享 `skins.json` 表面。
  - 搜索行与页面之间同一颜色，无 seam。
  - 页面 iframe 默认画布等于同一表面。
  - 分离插件窗口外壳、iframe 画布和 TitleBar 使用同一表面。
  - 设置窗口使用自己的 surface，不被启动器表面逻辑覆盖。
- 设置窗切换皮肤时焦点和滚动位置保持。
- 皮肤切换后导航栏列数和窗口 fit 高度重新测量。
- 剪贴板两套 Presenter 在各自皮肤下行高、spacer、窗口 offset、键盘滚动和多选状态正确。
- 不出现 `data-settings-skin` 残留或两套皮肤规则同时生效。

### 主题色回归

`scripts/cdp_settings_accent_verify.mjs` 与 `scripts/skin_system_unit_test.mjs` 覆盖：

- 主题色首帧、预设、自定义取色器、持久化和重启。
- Quiet / Chromatic × dark / light × 预设/自定义组合。
- 设置窗、启动器强调态、导航选中、剪贴板选中、插件 TitleBar 使用同一强调色身份。
- 焦点环、强调文字、选中边框、填充文字达到 3:1 / 4.5:1 要求。
- 清空主题色后恢复皮肤默认色，不复活 `accent_custom`。
- 保存失败后所有派生变量和 DOM 属性回滚。
- 自定义主题色不直接改写 `--surface`；主窗颜色覆盖时强调 token 依实际表面重算对比度。
- 主窗颜色覆盖与不透明度经设置页保存、重启保持，并可重置为跟随皮肤 / `100%`。

### 插件回归

- `lume.on.theme` 仍收到 `"light" | "dark"` 字符串。
- 新增 `lume.on.skin` 收到 `{ id, accent, surface }`；嵌入画布使用当前有效 surface。
- `lume.theme.get()` 保留旧字段并增加 skin/accent。
- 插件皮肤事件在嵌入和分离窗口都只作用于本人。
- 插件自有颜色模式仍可固定明暗，皮肤继续跟随主窗口 `appearance.skin`。
- 沙箱 Presenter 的背景像素与宿主表面一致。
- 插件无法调用新的皮肤控制 RPC。

### 手工与视觉检查

- 200% DPI 下检查主窗边缘、DWM 边框条、搜索行和页面接缝。
- Win11 圆角与阴影保持；Chromatic 不给外层窗口增加 CSS 角。
- 浅色 Chromatic 的 Mineral Paper 表面在真实桌面上无透明或残留边框。
- 窗口最小宽度、设置窗窄布局、模式胶囊溢出和长文案截断。
- 真实拖拽、键盘焦点、屏幕阅读器名称和原生取色器。
- 分离插件窗口移动、缩放、重新打开后表面与 chrome 一致。
- 预览窗保持现有自包含视觉，不因主窗口皮肤意外改色。

## 验收标准

验收需同时满足：

1. 用户可以分别选择主窗口与设置窗口皮肤；主窗口皮肤覆盖启动器、导航、剪贴板、嵌入插件画布和分离插件窗口。
2. 皮肤与明暗模式、Presenter 选择、插件颜色模式可以自由组合，互不覆盖。
3. 自定义主题色是全局概念，设置窗、启动器、嵌入插件画布和分离插件窗口的强调态保持一致；启动器外层与设置窗的表面 token 都不被主题色隐式染色。
4. 四个 skin/mode 组合的启动器表面由一份共享元数据同时决定 CSS、iframe 画布、插件窗口背景和 DWM 边框。
5. 主窗、设置窗和分离插件窗首帧无皮肤/主题色闪回。
6. 切换皮肤不丢失设置焦点、导航选择、剪贴板选择、搜索查询或滚动位置。
7. 剪贴板虚拟列表在皮肤行高变化后仍正确显示、按方向键滚动和保持选择。
8. 旧设置、导入文件、备份和恢复默认都不会因字段重命名或未知皮肤值失败。
9. 三语文案、设置搜索和无障碍语义同步。
10. 编译、Rust 测试、Page Runtime 测试、i18n 检查和 CDP 回归全部通过。
11. 没有新增插件权限、Tauri capability、数据库或网络依赖。
12. 活跃文档不出现分期编号或完成状态标志。

## 风险与处理

| 风险 | 处理 |
|---|---|
| Rust、TypeScript 和 CSS 各自维护表面色导致 DWM 色差 | 以 `src/skins/skins.json` 为共享来源；Rust `include_str!`，前端直接 import |
| 自定义 accent 染色 surface 导致 DWM 或设置页底色漂移 | accent 不染启动器外层表面，设置窗只染交互选中态 |
| 设置窗和启动器共享 CSS 导致样式泄漏 | 每个 webview 只写自己的 `data-skin`；皮肤规则按 `data-skin` 和 surface 容器双重作用域 |
| 皮肤切换重建 DOM、丢焦点或滚动 | 只改根属性/CSS 变量；Presenter 不重建 Page Service，必要时显式恢复可见选中项 |
| 剪贴板行高与虚拟窗口不同步 | 行高进入皮肤契约，Presenters 统一使用并重新上报 viewport |
| 插件主题事件对象化破坏旧插件 | 保留 `theme` 字符串；新增 `skin` 事件和附加字段 |
| 旧用户皮肤/主题色丢失 | 读取期兼容旧皮肤/主题色字段；只在任一皮肤缺失时做继承，两个新字段存在时独立保存 |
| 未知配置让窗口无样式 | Rust 与 TypeScript 双重规范化并回落 Quiet |
| Chromatic 破坏启动器外层几何 | 外层仍无 border/radius/透明；变体只作用于内部 |
| 首帧读取异步导致闪屏 | Rust 初始化脚本 + 渲染前同步应用 |
| 插件自行绘制的页面不跟随皮肤 | 只承诺外框、画布和公开变量；插件可选择消费 `skin` 事件 |

## 文档同步

- `docs/SETTINGS.md`：字段、外观页语义、迁移和数据文件。
- `docs/UI_GUIDELINES.md`：启动器连续 surface、DWM、双皮肤、几何和 accent 边界。
- `docs/ARCHITECTURE.md`：`src/skins/`、共享 `skins.json`、DWM 与插件表面流。
- `docs/PLUGIN_API.md`：`theme.get` 附加字段、`skin` 事件、API 2 非破坏性扩展。
- `docs/TESTING.md`：单测、CDP 脚本和手工项。
- `docs/ROADMAP_HISTORY.md` 与 `CHANGELOG.md`：实现细节与验证数据。
- 旧设置窗皮肤/主题色设计记录保存在 `docs/History/`，不再反向定义现状。

## 交付边界

本契约只定义双窗口内置皮肤与全局主题色基础设施，不改变：

- Page Service 的业务逻辑；
- Presenter 的模型契约；
- SQLite schema；
- 插件权限台账；
- 插件 API 版本；
- 网络依赖；
- 启动器的外层 DWM 几何。
