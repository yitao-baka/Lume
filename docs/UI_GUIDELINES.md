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
  carries the feedback (label tinted to the accent `#5ac8fa`, a spinner ring
  over the icon). `ModeInstance.ready` decides; the home page is always ready.
  See ROADMAP #30.7.
- Font: `"Segoe UI Variable Text", "Segoe UI", system-ui`; base 16px;
  antialiased; `user-select: none`.

## Colors

- Text: `#f2f2f2`
- Placeholder / hint text: `rgba(242, 242, 242, 0.4)`
- Accent (caret + selected tile hues): `#5ac8fa`
- Selection highlight: `rgba(255, 255, 255, 0.09)`
- Hairlines: `rgba(255, 255, 255, 0.06)` / `0.08`

## Search row

- 20px magnifier glyph, `rgba(242,242,242,0.45)`, 12px gap before the input.
- Input: transparent, 22px, accent caret. No border, no focus ring.

## Results

- List: thin scrollbar, `6px` inset padding.
- Row: 34px icon tile + 12px gap + 15px name; selected row gets the
  `0.09` white overlay highlight (rounded 8px).
- Letter tiles: deterministic 10-color palette, dark-on-light text, rounded
  8px — an interim stand-in for real app icons.

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

## Behavior

- The launcher is content — never the point. No decorative motion, no
  animations on open/close beyond the OS default.

## Components

- Every component should look modern and polished: clean hierarchy, restrained
  color, rounded corners, natural transitions.
- If hand-rolled components can't meet a need, an external component library
  may be adopted (docs/NORMS.md) — keep it consistent with the palette and the
  "launcher is content" rule.

## Scrollbars & sliders

- **Scrollbars are removed entirely** (`scrollbar-width: none` + zero-width
  webkit scrollbar): containers scroll on wheel/trackpad with no visible bar,
  and content fills the full width (the native scrollbar otherwise reserves
  ~10px and leaves a right-side gap in the app grid).
- Range sliders use a custom thin track with a rounded `#5ac8fa` thumb and a
  filled portion (`--fill` custom property), matching the dark theme.
