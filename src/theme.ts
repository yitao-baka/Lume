//! Color-mode application (docs/SETTINGS.md 界面页 颜色模式).
//!
//! The palette lives in CSS custom properties under `:root[data-theme="dark"]`
//! / `:root[data-theme="light"]` (src/App.css). This module sets that attribute
//! per the setting (`"system" | "dark" | "light"`); `"system"` follows the OS
//! `prefers-color-scheme` live.
//!
//! Plugin surfaces (a mode page's canvas, a detached plugin window's own
//! chrome) additionally honour a **per-plugin** preference
//! (`lume.theme.set`, `src/plugins/themePrefs.ts`): `"light"`/`"dark"` pin that
//! plugin's surfaces, `"system"` follows the launcher. The launcher's own
//! `data-theme` is never derived from a plugin preference.

let systemMedia: MediaQueryList | null = null;

/**
 * Apply the color mode to the current document. Called on startup (with the
 * setting after `get_settings`) and whenever the setting changes.
 */
export function applyColorMode(mode: string): void {
  if (systemMedia) {
    systemMedia.removeEventListener("change", onSystemChange);
    systemMedia = null;
  }
  if (mode === "system") {
    systemMedia = window.matchMedia("(prefers-color-scheme: light)");
    systemMedia.addEventListener("change", onSystemChange);
    onSystemChange();
  } else {
    document.documentElement.dataset.theme = mode;
  }
}

function onSystemChange(): void {
  document.documentElement.dataset.theme = systemMedia?.matches
    ? "light"
    : "dark";
}

/** A color-mode *setting* resolved to the mode it currently means — the same
 * resolution `applyColorMode` performs, as a value. Needed where the mode has
 * to be reported or combined (a plugin's `theme.get`, a detached window whose
 * own document is pinned to the plugin and therefore no longer holds the
 * launcher's mode). */
export function resolveColorMode(setting: string): "light" | "dark" {
  if (setting === "light" || setting === "dark") return setting;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** The document's current color mode — the single source of truth for anything
 * that must hand a theme value to another surface (plugin page canvases). */
export function currentThemeMode(): "light" | "dark" {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

/** The theme's solid panel surface per color mode (`--surface` in theme.css).
 * One value shared by the launcher panel, the DWM frame strip (window.rs), the
 * default plugin-page canvas (`injectBridge`) and the settings window — the
 * seam/corner uniformity contract. */
export const PANEL_SURFACE_BG = { dark: "#1e1e20", light: "#fbfbfd" } as const;

/** One plugin's color-mode preference (`lume.theme.set`): `"system"` follows
 * the launcher's effective mode, `"light"` / `"dark"` pin the plugin's own
 * surfaces regardless of the launcher. */
export type PluginColorMode = "system" | "light" | "dark";

/** The launcher's effective color mode — what `"system"` resolves to. */
export type ColorMode = "light" | "dark";

/** Validate an untrusted value (a page's `theme.set` argument, a settings
 * entry) into a `PluginColorMode`; `null` = not one of the three. */
export function normalizePluginColorMode(v: unknown): PluginColorMode | null {
  return v === "system" || v === "light" || v === "dark" ? v : null;
}

/** The mode a plugin's surfaces must render in: an explicit preference wins,
 * anything else (including `"system"`) follows the launcher. */
export function pluginEffectiveColorMode(
  pref: PluginColorMode | null | undefined,
  host: ColorMode
): ColorMode {
  return pref === "light" || pref === "dark" ? pref : host;
}

/** Apply a **plugin's** effective color mode to the current document — the
 * detached plugin window's chrome (`TitleBar`) and theme tokens. `hostSetting`
 * is the launcher's `appearance.color_mode`; `pref` the plugin's own
 * preference. An override pins the document; otherwise this is exactly
 * `applyColorMode(hostSetting)`, OS following included — so re-call it
 * whenever either input changes. */
export function applyPluginColorMode(
  hostSetting: string,
  pref: PluginColorMode | null | undefined
): void {
  applyColorMode(pref === "light" || pref === "dark" ? pref : hostSetting);
}
