# UI Guidelines

The visual contract for the Lume launcher surface (`src/App.css`). The
surface is a frameless, transparent, always-on-top window with a Windows
**Acrylic** blur backdrop applied by Rust (`lib.rs`).

## Surface

- One 1px transparent gutter around the panel so the Acrylic blur glows
  around the rounded edge.
- Panel: `border-radius: 12px`, semi-transparent dark fill
  (`rgba(30, 30, 32, 0.75)`), hairline border `rgba(255,255,255,0.08)`,
  soft shadow `0 8px 40px rgba(0,0,0,0.35)`.
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
