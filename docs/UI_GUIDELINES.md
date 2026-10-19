# UI Guidelines

The visual contract for the Lume launcher surface (`src/App.css`). The
surface is a frameless, always-on-top window; Win11 owns its rounded corners
and drop shadow (`shadow(true)`, DWM), never CSS.

## Surface

- **Opaque panel, one color**: `.launcher` fills the client area edge to edge
  with solid `--surface` (dark `#1e1e20` / light `#fbfbfd`) — **no** border,
  **no** `border-radius`, **no** translucent fill and no backdrop effect
  (Acrylic was removed in `lib.rs`). The same value paints DWM's visible frame
  border strip (`window::set_panel_frame_border` → `DWMWA_BORDER_COLOR` per
  颜色模式) and is the default plugin-page canvas (`injectBridge`), so panel /
  strip / page / four corners are exactly one surface: no ring, no hairline,
  no tint step. A CSS radius only exposes the window backdrop in the crescent
  outside its arc, and a translucent panel can never be reproduced by the
  opaque strip over an arbitrary wallpaper. The other windows are opaque and
  clear their DWM border (`clear_dwm_border`).
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
- **Nothing to show = the search row alone**: an empty home menu (no bar
  sections) collapses the window to the search row — no reserved empty strip.
  A "no results" hint renders in its own `.page-hint` row (the fit window
  shrinks to search row + hint), never centered inside a tall empty page area.
- **Loading gate**: a page that is not loaded yet is *not shown* — the window
  collapses to the search row, `.results` is hidden, and the mode's pill
  carries the feedback (label tinted to `--accent-text`, a spinner ring
  over the icon). `ModeInstance.ready` decides; the home page is always ready.
  See docs/ARCHITECTURE.md (sizing).
- Font: `"Segoe UI Variable Text", "Segoe UI", system-ui`; base 16px;
  antialiased; `user-select: none`.

## Colors

Palette tokens live in `src/theme.css` and are shared by the launcher,
settings and detached-plugin surfaces. The light theme does not reuse the
dark theme's cyan as text: small text and focus indicators get their own
contrast-safe tiers.

| Role | Dark | Light |
|---|---|---|
| Surface / raised | `#1e1e20` / `rgba(38,38,40,.97)` | `#fbfbfd` / `#ffffff` |
| Primary / secondary / muted text | `0.68` / `0.58` / `0.49` white | `0.72` / `0.66` / `0.64` ink |
| Accent decoration / text | `#5ac8fa` / `#5ac8fa` | `#0969da` / `#0757b8` |
| Focus ring | `#5ac8fa` | `#0969da` |
| Danger / warning / success text | `#ff7b72` / `#ffb020` / `#4cc38a` | `#b42318` / `#9a6700` / `#1a7f37` |

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
  after the input and gear: when modes overflow it scrolls horizontally (no
  visible scrollbar), long labels ellipsize, and the active pill is kept in
  view. Its cap is about three named pills (`320px`); icon-only presentation
  uses about three icons (`104px`), leaving the rest of the row to the search
  input. The input never drops below its 120px usable floor.
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
- 设置 → 导航页 → 条目框 → `round_app_icons` (default off) is the only circle
  contract. On, `.launcher.circle-app-icons` applies a `50%` radius and clips
  the same result artwork; off restores the unmasked presentation.
- Truncated result names and descriptions expose their complete value through
  the native `title` tooltip.

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

## Accessibility & targets

- Every switch carries a non-empty accessible name derived from its visible
  row label. Selectable option pills expose `aria-pressed`; range inputs have
  labels; settings navigation uses tab/tabpanel relationships, roving
  tabindex and arrow/Home/End navigation. The document `lang` follows the
  resolved UI locale.
- Confirm dialogs are real keyboard scopes: focus enters on the safe
  “continue editing” action, background regions become `inert`, Tab and
  Shift+Tab cycle inside, Esc dismisses, and focus returns to the trigger.
- Plugin card headers are Enter/Space-expandable buttons with
  `aria-expanded` and an `aria-controls` detail panel; their inner controls
  remain independently reachable.
- Immediate-write controls and groups carry a visible “immediate effect”
  badge. The unsaved prompt explicitly says these values survive a draft
  discard and uses scoped wording such as “discard unsaved draft”.
- Click targets meet accessibility floors: switches are at least 24px high,
  icon buttons at least 30px, and text links at least 24px high. Numeric
  presets may reveal a free-form input without shrinking the preset hit
  targets.

## Components

- Every component should look modern and polished: clean hierarchy, restrained
  color, rounded corners, natural transitions.
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
