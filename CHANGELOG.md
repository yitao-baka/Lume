# Changelog

All notable changes to Lume are documented here. Format based on
[Keep a Changelog](https://keepachangelog.com/), versions follow
[semantic versioning](https://semver.org/).

## [0.2.11] — 2026-08-04

Live environment-variable synchronization (ROADMAP item 9).

### Added

- **Environment sync** — Lume now listens for system environment changes
  (`WM_SETTINGCHANGE` broadcast + registry-change notification on
  `HKCU\Environment` and the HKLM session-manager environment key) and refreshes
  its own process environment block, so apps and commands launched afterwards
  inherit the **fresh** PATH / variables instead of the ones frozen at startup.
  Event-driven and zero-CPU when idle — there is no registry polling. `PATH` is
  rebuilt as system + user (Windows concatenation order); `REG_EXPAND_SZ`
  values are expanded. Only newly started processes are affected, as Windows
  never rewrites a live process's environment.

## [0.2.10] — 2026-08-02

Auto-sizing launcher window.

### Added

- **Auto-sizing window** — the launcher window height now fits its content:
  few results shrink it, the full app grid grows it to a cap (520px) where it
  scrolls internally, and it stays centered. Width stays 720. Requires the
  `core:window:allow-set-size` / `allow-center` capabilities. The padding
  budget accounts for the results area padding and borders, so content that
  fits is shown **without a scrollbar**.

## [0.2.9] — 2026-08-02

### Changed

- **Removed the `Ctrl+P` pin shortcut** — pinning is now done through the
  right-click context menu (「固定/取消固定」), which existed for both apps
  and clipboard entries. The clipboard shortcut hint now reads just `Del
  delete`.
- **Disabled WebView2 built-in shortcuts** — browser accelerators (Ctrl+F
  find, Ctrl+P print, Ctrl+S save, Ctrl+R/F5 reload, F12/Ctrl+Shift+I
  DevTools, Alt+←/→ history, …) no longer work in the launcher. Lume's own
  keys (Tab, arrows, Enter, Esc, Del) and text editing in the search box
  (Ctrl+C/V/X/A/Z) are unaffected.
- **Removed the default focus outline** from the mode-switch pills and other
  buttons, so no white focus ring appears when Tab lands on them.
- **Auto-scroll only follows the keyboard** — hovering a partially-clipped
  row with the mouse no longer yanks the scroll position; arrow-key navigation
  still scrolls the selection into view.

## [0.2.8] — 2026-08-02

System tray icon with Restart / Exit.

### Added

- **Tray icon** — Lume now lives in the system tray. Left-click toggles the
  launcher; right-click shows a menu with 「重启」/「关闭」 (Chinese systems) or
  Restart / Exit. Restart uses Tauri's built-in `request_restart`; Exit uses
  `app.exit(0)`.

## [0.2.7] — 2026-08-02

Pinyin search for Chinese app names (ROADMAP item 5).

### Added

- **Pinyin search** — Chinese app names are indexed with their full pinyin
  and pinyin initials at scan time. Typing `kuake` or `kk` finds 「夸克」;
  `wanmei` finds 「完美解码」. Pinyin matches are weighted slightly below
  exact name matches. The pinyin fields are search aids only and are not sent
  to the frontend. English search is unaffected.

## [0.2.6] — 2026-08-02

Custom right-click context menu.

### Added

- **Custom context menu** — right-clicking an app box shows 「固定/取消固定 ·
  启动」; right-clicking a clipboard entry shows 「复制回剪贴板 · 固定/取消固定 ·
  删除」. The menu follows the cursor, dismisses on `Esc` / click-outside /
  right-click-outside, and is styled to match the launcher.
- **Default WebView2 menu disabled** — the browser-style context menu no
  longer appears anywhere in the launcher.

## [0.2.5] — 2026-08-02

Navigate pinned bar (ROADMAP item 3) + smaller grid boxes.

### Added

- **Pinned bar** — a distinct strip of pinned apps sits above the Navigate
  main-menu grid. `Ctrl+P` pins/unpins the selected app; `↑` enters the bar
  from the grid's first row, `←`/`→` move within it, `↓` returns to the grid.
  Pins persist in `lume.db` (`pinned_apps` table, WAL-enabled), shown only on
  the empty-query main menu.
- **Smaller grid boxes** — the Navigate grid now uses 6 columns with 48px
  tiles (was 5 × 56px), and the box padding was tightened.

### Fixed

- **Blank Navigate on first launch** — the main-menu grid is now populated in
  `onMount` instead of relying solely on the window-focus event. If the window
  was shown before the webview finished loading (and the async focus listener
  wasn't registered yet), the grid used to stay empty until re-shown.

## [0.2.4] — 2026-08-02

Real application icons (ROADMAP item 2).

### Added

- **Real app icons** — the Navigate grid now shows each app's actual icon
  instead of a colored letter tile. Icons are extracted via the Windows shell
  (`IShellItemImageFactory`) at 64px for HiDPI crispness.
- **In-memory icon cache** — extracted icons live in a process-level cache
  keyed by path (backend `IconCache` + a frontend `Map`), so re-viewing a
  result set never re-extracts. **Icons are not persisted to SQL** (per
  project constraint).
- **Progressive loading** — letter tiles render immediately, then icons load
  in batches of 20 and swap in.
- **Path fix** — Start Menu paths now use consistent backslashes; mixed
  separators broke `SHCreateItemFromParsingName` (E_INVALIDARG) and
  `ShellExecuteW`.
- **Tests** — icon extraction against real Start Menu shortcuts (`cargo test`,
  20 passing).

## [0.2.3] — 2026-08-02

Internationalization (i18n).

### Added

- **i18n** — all UI strings now come from a centralized table in
  `src/i18n.ts` supporting **Simplified Chinese**, **Traditional Chinese** and
  **English**. The active locale is detected from the system language
  (`navigator.language`); `setLocale` is reserved for the future settings
  page. Covers the search placeholder, mode pills, hints, shortcut footer,
  settings/delete tooltips and the clipboard image label.

### Fixed

- **Mode-switch query cross-talk** — each mode now keeps its own independent
  search query, so clearing or typing in Clipboard no longer wipes Navigate's
  view (and vice-versa). Switching back to Navigate no longer shows the full
  main-menu grid when a filtered query was in effect.
- **App index pre-warm** — the Start Menu index is scanned on a background
  thread at startup, so the main-menu grid and first search appear instantly
  instead of after a slow one-time scan.

## [0.2.2] — 2026-08-02

Interaction fixes + Navigate grid + project roadmap.

### Fixed

- **Keyboard & mouse navigation** — results are now selectable with the mouse
  (hover selects, click activates) and keyboard arrows work reliably in both
  modes; the search input is re-focused on every launcher show. Navigation
  keys are handled at the window level, so a stray click that blurs the input
  no longer kills the arrow keys, and the selected result auto-scrolls into
  view.
- **Scrollbars** — the results containers now use a modern thin rounded
  scrollbar instead of the default chunky one.
- **Auto-hide on focus loss** — the launcher dismisses itself whenever it
  loses focus (clicking elsewhere), replacing the toggle-off behavior.
- **Per-entry delete** — the Clear button is gone; each clipboard row now has
  a trash button that deletes that entry.
- **Navigate label** — the first mode pill is now "Navigate".

### Added

- **Navigate grid** — the main menu renders apps as a 5-column grid of
  square boxes (letter tile + name). Empty query browses all apps; arrow keys
  navigate in four directions; hover selects; click launches. Long names are
  clipped, tracks use `minmax(0, 1fr)` so nothing overflows the right edge.
- **Visible selection** — the selected grid box / clipboard row gets an
  accent border and a stronger highlight.
- **Settings button** — a placeholder gear button sits next to the mode
  switch (page comes in a later iteration).
- **Roadmap** — `docs/ROADMAP.md` records upcoming work (i18n, real icons,
  Navigate pinned bar, plugin system).
- **Test** — `search_apps` empty query returns the full name-sorted index
  (`cargo test`, 18 passing).

## [0.2.1] — 2026-08-02

Clipboard enhancements: pin / delete / clear, and image history.

### Added

- **Images** — the listener captures images from the clipboard (RGBA → PNG
  blob stored in SQLite). Image rows show a downscaled thumbnail tile and
  `Enter` writes the original back to the clipboard. Consecutive duplicates
  are skipped via an in-memory hash.
- **Pin** — `Ctrl+P` toggles the pin flag on a clipboard entry. Pinned items
  sort to the top and are exempt from pruning.
- **Delete** — `Del` removes the selected clipboard entry.
- **Clear all** — a "Clear" button (two-step confirm) in clipboard mode wipes
  the history.
- **Schema migration** — the clipboard table gains `kind` / `data` / `pinned`
  columns; existing text history is migrated in place without data loss
  (`content` uniqueness now enforced by a partial index on text rows only).
- **Shortcut hint** — clipboard mode shows a footer with the active keys.
- **Tests** — migration, image round-trip/thumbnail, pin ordering & prune
  exemption, delete and clear (`cargo test`, 17 passing).

## [0.2.0] — 2026-08-02

Clipboard manager. Lume now captures, persists and re-copies clipboard history,
backed by SQLite — the database foundation declared in the README tech stack.

### Added

- **Clipboard capture** — a background thread polls the Windows clipboard
  sequence number (250 ms) and stores new text in SQLite
  (`src-tauri/src/clipboard.rs`). Own writes from `copy_clipboard` are skipped.
- **SQLite persistence** — history lives in `app_data_dir()/lume.db`
  (`rusqlite`, bundled). Re-copying existing text bumps it to the top instead
  of duplicating; the store is pruned to the 300 most recent entries.
- **Clipboard search mode** — `Tab` (or the pills in the search row) toggles
  between **Apps** and **Clipboard** modes. Clipboard mode searches history
  (case-insensitive substring, most recent first); an empty query browses the
  recent history.
- **Copy back** — `Enter` on a clipboard result writes it to the system
  clipboard and hides the launcher.
- **Clipboard UX** — muted clipboard-icon tiles and single-line content
  previews, per-mode placeholder and hint text.
- **Tests** — storage tests for upsert recency, pruning and substring search
  (`cargo test`, 11 passing).

## [0.1.0] — 2026-08-02

First working launcher. Core v0.1 delivers the launcher popup, the global
toggle shortcut and app search & launch — everything needed to use Lume as a
daily driver app launcher.

### Added

- **Global toggle shortcut** — `Alt+Space` preferred, auto-fallbacks to the
  next free combination (`Ctrl+Space`, `Ctrl+Alt+Space`) when another app owns
  the key. The active combo is shown in the launcher hint.
- **Application search** — walks the per-user and all-users Start Menu
  `Programs` folders for `.lnk` shortcuts, deduped by name and name-sorted.
- **Fuzzy matching** — case-insensitive subsequence scorer rewarding prefix,
  word-boundary and consecutive-run matches; returns the top 8 results.
- **Launch** — `.lnk` shortcuts opened via `ShellExecuteW`.
- **Keyboard navigation** — `↑`/`↓` select (wraps), `Enter` launches, `Esc`
  hides.
- **Window lifecycle** — hidden at startup, centered and focused on show,
  Acrylic frosted-glass backdrop, query cleared on each invocation.
- **Documentation** — `CLAUDE.md`, `docs/RULES.md`, `docs/ARCHITECTURE.md`,
  `docs/UI_GUIDELINES.md`, `docs/TESTING.md`.
- **Tests** — Rust unit tests for the fuzzy scorer and the Start Menu scan.
