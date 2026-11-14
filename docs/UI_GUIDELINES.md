# UI Guidelines

The visual contract for the Lume launcher surface (`src/App.css`). The
surface is a frameless, always-on-top window; Win11 owns its rounded corners
and drop shadow (`shadow(true)`, DWM), never CSS.

## Surface

- **One-color launcher surface**: `.launcher` fills the client area edge to
  edge with the active skin's `--surface` — Quiet is `#1e1e20` dark /
  `#f7f3e8` light, Chromatic is `#1e1e20` dark / `#f3efe6` light. A custom
  `appearance.window_color` replaces that color in both tones; empty follows
  the active skin. There is **no** border, **no** `border-radius` and no
  backdrop blur. `appearance.window_opacity` applies one uniform opacity to the
  whole launcher window, including embedded plugin pages, in the `70–100%`
  range. Settings and detached plugin windows remain opaque and keep their own
  skin surface.
- **Native transparency and DWM**: the main WebView is created transparent so
  the CSS opacity can reveal the desktop. At `100%` the DWM visible-frame strip
  (`window::apply_launcher_chrome`) is painted the effective surface color; at
  lower opacity it is cleared because DWM border colors cannot carry alpha.
  The shadow and Win11 rounded corners stay OS-owned either way.
- No gutter: the panel reaches the window's client edge (`#root` padding 0) —
  any transparent inset would show as a ring around the launcher.
- No hairline: the panel used to draw `border: 1px solid
  rgba(255,255,255,0.08)` around itself; at any DPI it reads as a bright ring,
  and at the corners its arc is an artifact against DWM's arc. Chips that must
  read as raised on the panel use `--surface-raised` (`.detach-btn`).
- **One continuous panel (uTools splice)**: the search row and the page below
  it are the same surface — no divider line under the search row, no inset
  around the page area. The page area starts at the search row's bottom edge
  and runs to the panel border on the left/right/bottom; inner padding belongs
  to the page (see ARCHITECTURE 拼接几何). A frame or tint step at that seam
  is a bug, not a style.
- **Plugin surfaces**: embedded Presenter iframes receive the launcher's
  effective `--lume-page-bg`, `--lume-page-accent` and `data-lume-skin`; the
  legacy `theme` event remains a `"light" | "dark"` string and the additive
  `skin` event carries `{id, accent, surface}`. Detached plugin windows use
  their skin surface for chrome and canvas. A plugin that paints its own
  background still wins.
- **Nothing to show = the search row alone**: an empty home menu (no bar
  sections) collapses the window to the search row — no reserved empty strip.
  A "no results" hint renders in its own `.page-hint` row (the fit window
  shrinks to search row + hint), never centered inside a tall empty page area.
- **Native chrome is never part of the surface**: the WebView2 default context
  menu, autofill/zoom/gesture chrome and release DevTools stay disabled, and the
  Win32 window system menu is swallowed even though Tao gives frameless windows
  `WS_SYSMENU`. `Alt+Space`, `Shift+F10`, the Menu key and non-client right-click
  must not paint native Windows UI. Lume's own DOM context menu remains the only
  keyboard/mouse menu.
- **Loading gate**: a page that is not loaded yet is *not shown* —
  `.results` is hidden and the mode's pill carries the feedback (label tinted
  to `--accent-text`, a spinner ring over the icon). A fit page collapses to
  the search row; a fixed page keeps its target height. `ModeInstance.ready`
  decides; the home page is always ready. See docs/ARCHITECTURE.md (sizing).
- **Terminal page errors are content, not loading**: the search row stays a
  non-shrinking header, and an error page keeps the current fit-page height or
  grows enough to show its title, hint, detail and action. It must never collapse
  back to the loading gate's search-row-only geometry or paint over the search
  controls during a resize.
- Font: `"Segoe UI Variable Text", "Segoe UI", system-ui`; base 16px;
  antialiased; `user-select: none`.

## Colors

Shared skin metadata lives in `src/skins/skins.json`; semantic accent and
surface variables are applied by `src/skins/{runtime,accent}.ts`. The launcher
palette remains in `src/theme.css` so launcher, settings and detached-plugin
surfaces consume one set of `--surface`, text and control tokens. The light
theme does not reuse the dark theme's cyan as text: small text and focus
indicators get their own contrast-safe tiers.

| Role | Quiet dark / light | Chromatic dark / light |
|---|---|---|
| Surface | `#1e1e20` / `#f7f3e8` | `#1e1e20` / `#f3efe6` |
| Native accent decoration | `#5ac8fa` / `#0969da` | `#5ac8fa` / `#64796d` |
| Native accent text | `#5ac8fa` / `#0757b8` | `#5ac8fa` / `#52675b` |
| Focus ring | `#5ac8fa` / `#0969da` | `#5ac8fa` / `#64796d` |

Primary/secondary/muted text, danger/warning/success tiers and raised surfaces
follow the resolved light/dark palette. Custom accent overrides derive all five
accent tiers from the current skin's `accentAnchors` in the shared metadata.

- Every text token clears `4.5:1` on `--surface`. The focus ring and selected
  borders clear `3:1`; `--danger-fill` keeps white button text above `4.5:1`.
- `--accent` is for decoration and fills, `--accent-text` for small text and
  links, `--accent-tint` for selected backgrounds, `--accent-border` for
  visible selection edges, and `--focus-ring` for keyboard focus.
- Use `--icon-muted` for actionable icons. Decorative glyphs may still recede;
  informational metadata uses `--text-secondary`.
- Selection highlight remains `rgba(255,255,255,0.09)` in dark mode and
  `rgba(31,35,40,0.08)` in light mode; hairlines use `--border` /
  `--border-strong`.

## Search row

- 20px magnifier glyph, `rgba(242,242,242,0.45)`, 12px gap before the input.
- Input: transparent, 22px, accent caret. No border, no focus ring.
- Mode pills (home + plugin modes, before the gear): icon + name; 设置 →
  导航页 → `mode_switch_icons_only` switches them to icon-only (the tooltip
  carries the name). Pill height is identical in both presentations — the
  search row must not resize on the toggle. The strip owns only the width left
  after the input and gear. Its viewport is sized to the natural width of at
  most the first three pills, capped at `min(44%, 320px)`. If those three fit,
  they keep their natural widths; only when their combined width exceeds the cap
  do they shrink and ellipsize. Later pills stay in the hidden-scrollbar strip:
  wheel/trackpad scrolls them, and keyboard mode changes scroll the active pill
  into view. Icon-only presentation follows the same natural-first rule inside
  its `104px` cap, leaving the rest of the row to the search input. The input
  never drops below its 120px usable floor.
- At narrow launcher widths (`<=640px`) the strip automatically falls back to
  the same icon-only presentation even when the persistent setting is off;
  `title` / `aria-label` still carry every name. If the icon strip itself
  overflows, it simply clips at its edges — no scrollbar, fade or arrow
  control; wheel/trackpad scrolling still works, and switching modes scrolls
  the active pill into view.
- When the search input is narrower than 160px, its placeholder switches to
  the localized short form (`Search…` / `搜索…` / `搜尋…`); the full page
  placeholder remains available as the input's tooltip and accessible name.

## Results

- List: barless scrolling with `6px` inset padding.
- Row: 34px icon tile + 12px gap + 15px name; selected row gets the
  `0.09` white overlay highlight (rounded 8px).
- App artwork is rendered as-is by default: no circular crop, mask or tinted
  backing tile. While extraction is pending or after it fails, the row uses
  the shared `res/icons/unknow_universal.svg` fallback; a successful icon
  replaces it.
- 设置 → 导航页 → 网格 → `round_app_icons` (default off) is the only circle
  contract. On, `.launcher.circle-app-icons` applies a `50%` radius and clips
  the same result artwork; off restores the unmasked presentation.
- Truncated result names and descriptions expose their complete value through
  the native `title` tooltip.
- The compact Navigate Presenter is a titled single-column list, not a text
  dump: each section header carries its item count and disclosure chevron,
  rows keep the same app artwork and path/description hierarchy as the grid,
  and keyboard movement keeps the selected row inside the scroll viewport.
  Collapsed sections expose exactly one row in list form; collapsing must
  clamp the page selection to that row so `Enter` can never activate a hidden
  item. It has no native scrollbar and shows fading edges only when content
  continues beyond a viewport edge.
- The compact Clipboard Presenter uses a 44px virtual-row rhythm: a 28px
  content tile, one-line title, and a secondary `kind · source · time` line.
  Pinned, multi-selected and invalid rows retain the full list's visual cues.
  Hover selection still obeys 设置 → 剪贴板 → 悬停选中; when it is off the first
  click only selects and the second activates. Both clipboard Presenters
  report their painted row height with the viewport intent so the Page Service
  can return the correct virtual slice, and keyboard selection scrolls the
  active row into view without a native scrollbar.

## Window chrome

- The settings window and the detached plugin windows are **frameless**
  (`decorations(false)` + `shadow(true)`, opaque) and draw their own
  titlebar with the shared `src/components/TitleBar.tsx`: the settings
  topbar embeds `<TitleBarControls>`, plugin windows use the standalone
  `<TitleBar>` row.
- Opaque on purpose — Win11 rounds the corners via DWM and tao keeps its
  native invisible resize borders (a transparent resizable window would
  turn those borders into a visible dead zone). Win10 gets square corners.
- Dragging: `data-tauri-drag-region` on the chrome row (direct clicks only
  — buttons/inputs keep their own semantics). Double-click maximize/restore
  is Tauri's built-in drag-region behavior (`internal_toggle_maximize`,
  granted by `core:default`); minimize / pin / close run through
  `window_minimize` / `window_toggle_maximize` (maximize button) /
  `window_toggle_pin` / each window's own close path.
- Controls follow the `.icon-btn` language (34×30 hover target, 6px
  radius, `--text-muted` → `--text` on hover, `--hover` fill); close
  flashes the Windows caption red `#e81123`.
- Palette tokens live in `src/theme.css`, shared by every themed surface;
  the preview window stays self-contained (always dark).
- The satellite preview keeps a 36px header with the filename or content type
  and an in-window close button that invokes `close_preview`. It remains
  `WS_EX_NOACTIVATE`; clicking close does not activate the window or steal the
  launcher's focus. A one-pixel inset edge separates the always-dark media
  canvas from a light launcher without adding a themed native border.
- At the settings window's `560×420` minimum, the navigation rail compacts its
  rows and remains independently scrollable. The footer never overlaps a
  navigation hit target; the last section stays fully visible and clickable.
- `appearance.skin` controls the launcher family; `appearance.settings_skin`
  controls the settings window independently. Quiet uses rounded cards, soft
  internal controls and quiet structure; Chromatic uses square editorial
  controls, 1.5px structural rules and numbered settings pages. Both skins share
  the same semantic components, DOM identity and responsive layout. Switching a
  window's skin preserves its focus, selection and scroll position, and never
  adds a CSS border, radius, extra translucency or shadow to the launcher's
  outer window. Whole-window opacity only comes from `appearance.window_opacity`.
- The launcher inner rhythm is skin-owned: Quiet keeps rounded result/clipboard
  rows; Chromatic uses near-square controls, stronger rules and editorial
  section titles. Search row, page and iframe remain one `--surface`; no skin
  may introduce a divider at that seam.
- Clipboard row height is part of the skin contract:
  `quiet/clipboard-list` = 52px, `chromatic/clipboard-list` = 56px,
  `quiet/clipboard-compact` = 44px, `chromatic/clipboard-compact` = 48px.
  Presenters publish the value through `viewport.request`; the Page Service
  uses it for spacer/window math and keeps the selected item visible.
- `appearance.accent` overlays a user accent without changing skin geometry.
  Empty means each window's own skin-native accent. For dark Chromatic that is
  湖蓝 (`#5ac8fa`). Custom values derive `--ui-accent`, `--ui-accent-text`,
  `--ui-accent-border`, `--ui-accent-on` and `--ui-focus-ring`; neither the
  outer launcher `--surface` nor any settings canvas / rail / panel / control
  surface is tinted.
- The settings document applies a custom accent only to interactive selection:
  `--settings-selected` uses a 16% accent mix, while text, semantic, warning,
  danger, success and overlay-shadow tokens stay unchanged. The selection
  override adds no transitions, and Portal surfaces keep the native settings
  panel color.
- Accent decoration, small text and foreground-on-accent are derived separately
  with 3:1, 4.5:1 and 4.5:1 floors. Selection also keeps its border, underline
  or numbered-page cue so color never carries state alone.
- The compact accent preview uses the same CSS tokens as real controls: a
  structure rule, selected navigation row, on-state switch and small accent
  text. Presets pair every swatch with a localized label; the first preset slot
  is skin-dependent (Quiet leads with Aqua, Chromatic with `#ac8e97`) and stays
  pinned to the settings-window skin default while another color is applied.
  The native color input keeps a hit area of at least 32×32px.
- The color input shows the remembered `appearance.accent_custom`, or pure
  white before one is stored. Picking a preset or switching either skin never
  rewrites it. The entry name applies that color immediately; only the swatch opens the
  native picker.
- The About brand block shows the product mark itself — the transparent app
  icon, inverted per `--icon-filter` like the topbar brand, at 104px (78px at
  narrow widths) with no plate, frame or letter monogram around it.
- Settings help buttons never expand inline: hover/focus shows a fixed-position
  tooltip without changing row geometry, and click opens a portaled modal with
  the full explanation. The modal makes the settings body inert, traps focus on
  its controls, closes on Esc/backdrop, and returns focus to the `i` button.
- The plugin manager's master/detail frame is bounded by the available viewport;
  the list and detail panes each scroll independently with hidden scrollbars.
  A long plugin list must never move the selected detail off-screen. List rows
  carry no disclosure glyph: the head is the click/keyboard target and the
  detail pane states the selection.
- The `.lupx` install confirmation is the shared confirm dialog: the inspected
  package facts (name / version / kind, localized capability chips, payload
  stats, signature or SHA-256, overwrite relation) render between the hint and
  the actions, and a long facts block scrolls inside the dialog instead of
  growing it.
- Settings confirmations and the program picker are owned by the separate
  settings entry's `src/settings/skins/base.css`; they must not depend on the
  launcher-only `src/App.css`. Their fixed backdrop owns viewport coverage and
  centering, while `settings-dialog-in` moves only the dialog vertically.
- Launcher centered dialogs animate with `confirm-in`, which keeps their
  `translate(-50%, -50%)` centering while easing in from 8px below center. The
  bottom toast's `toast-in` keyframes only carry the X centering — reusing them
  makes a dialog appear half a height too low and snap up on the last frame.
- All three toast surfaces (launcher, settings commands, detached plugins) stay
  inside the viewport, wrap arbitrary long strings, and use one readable dwell
  policy: 4s minimum, longer text extends the dwell time, undo has a 6s minimum,
  and automatic durations cap at 12s. An explicit `duration` can lengthen but
  cannot undercut those floors.
- Settings command results (automation 测试 / 代理预检, service and agent
  registration) report through one shared bottom notice: panel colour, skin
  radius and shadow, centred above the 32px footer, with failures keeping
  the signal tone. It is portaled to `document.body` —
  `.settings-page-content` keeps `transform: translateY(0)` from its page-in
  animation (`fill: both`), so a `position: fixed` box inside it would anchor
  to that page box instead of the window.
- Position preset marks and every help/tooltip surface must remain legible in
  both Quiet/Chromatic and light/dark combinations.

## Behavior

- The launcher is content — never the point. No decorative motion, no
  animations on open/close beyond the OS default.
- **Focus contract**: command-style controls (mode pills, category tabs,
  expand/collapse, pause/clear, undo) return focus to the search box after a
  mouse click so typing can continue. Text inputs, confirm dialogs, the
  context menu and modal scopes keep their own focus. `Tab` switches modes
  only while the search box is focused; elsewhere it traverses natively.
  `F6` / `Shift+F6` cycles search box → mode bar → page control → settings,
  and every command control shows a visible `:focus-visible` outline. The
  `.results` page shell can receive blank-area clicks and serves as the `F6`
  fallback when a page has no controls, but it stays borderless — no
  container-wide focus ring. The selected row/tile border is the page-level
  position cue.

- **Native control keys win**: page-level clipboard `Space` multi-select only
  applies when focus is outside buttons, links, tabs, inputs, textareas,
  selects and contenteditable regions. Category, pause, clear and row-action
  buttons therefore keep their native Space activation and visible focus.
  `Delete` remains a page shortcut only outside text editing.
## Accessibility & targets

- Every switch carries a non-empty accessible name derived from its visible
  row label. Launcher option pills expose `aria-pressed`; settings segmented
  controls and accent presets use radio semantics with arrow/Home/End
  navigation and roving tabindex. The native color input remains separately
  keyboard-focusable and named. Range inputs have labels; settings navigation
  uses tab/tabpanel relationships and roving tabindex. The document `lang`
  follows the resolved UI locale.
- Confirm dialogs are real keyboard scopes: focus enters on the safe
  cancel action, background regions become `inert`, Tab and
  Shift+Tab cycle inside, Esc dismisses, and focus returns to the trigger.
- Plugin card headers are Enter/Space-expandable buttons with
  `aria-expanded` and an `aria-controls` detail panel; their inner controls
  remain independently reachable.
- Reversible settings autosave and show status/undo in the settings footer.
  Service/agent registration, import, backup restore, default restore, plugin
  uninstall, and trust-all are explicit commands with confirmation and real
  progress/results instead of sharing the autosave path.
- Click targets meet accessibility floors: settings switches use a fixed 44×36px
  hit box with a 16×16px knob centered inside the track (`left: 6px` off,
  `left: 22px` on), icon buttons at least 30px, and text links at least 24px.
  Numeric presets may reveal a free-form input without shrinking the preset hit
  targets; leaving that box with an unchanged value (blank click, blur, or
  Enter) folds it back into the `更多…` chip instead of leaving an input
  behind.

## Components

- Every component should look modern and polished: clean hierarchy, restrained
  color, rounded corners, natural transitions.
- The bundled application icon uses a rounded-square plate with a transparent
  mask at roughly 22% of its side length. `src-tauri/icons/icon.png` is the
  generation source, and every platform derivative keeps the same alpha
  silhouette. The in-app brand mark remains the unplated transparent bird art.
- If hand-rolled components can't meet a need, an external component library
  may be adopted — keep it consistent with the palette and the
  "launcher is content" rule.

## Scrollbars & sliders

- **Scrollbars are removed entirely** (`scrollbar-width: none` + zero-width
  webkit scrollbar): containers scroll on wheel/trackpad with no visible bar,
  and content fills the full width (the native scrollbar otherwise reserves
  ~10px and leaves a right-side gap in the app grid).
- Long clipboard and settings content add a top/bottom fading edge only while
  more rows exist beyond that edge. The fade is a discoverability cue, not a
  persistent scrollbar and not a reserved gutter.
- Range sliders use a custom thin track with a rounded `--accent` thumb and a
  filled portion (`--fill` custom property).
