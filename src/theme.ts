//! Color-mode application (docs/SETTINGS.md 界面页 颜色模式).
//!
//! The palette lives in CSS custom properties under the default `:root` (dark)
//! and `:root[data-theme="light"]` (src/theme.css). This module sets that
//! attribute per the setting (`"system" | "dark" | "light"`); `"system"`
//! follows the OS `prefers-color-scheme` live.
//!
//! Plugin surfaces (a mode page's canvas, a detached plugin window's own
//! chrome) additionally honour a **per-plugin** preference
//! (`lume.theme.set`, `src/plugins/themePrefs.ts`): `"light"`/`"dark"` pin that
//! plugin's surfaces, `"system"` follows the launcher. The launcher's own
//! `data-theme` is never derived from a plugin preference.
//!
//! #44: `themeMode()` exposes the current document's mode as a **reactive**
//! signal — host-rendered plugin icons pick their variant through it, so a
//! theme flip (setting change or the OS in system mode) re-renders them
//! without re-running a search. `writeColorMode` is the single writer.

import { createSignal } from "solid-js";

let systemMedia: MediaQueryList | null = null;

/** Reactive color-mode accessor; reads track flips. Outside a Solid tracking
 * scope (Rust-facing pushes, rasterizers) it is simply the current value. */
const [themeModeSignal, setThemeModeSignal] = createSignal<"light" | "dark">("dark");

/** The document's current color mode, reactive. */
export function themeMode(): "light" | "dark" {
  return themeModeSignal();
}

/** One writer for the attribute + the signal — they must never diverge. */
function writeColorMode(mode: "light" | "dark"): void {
  document.documentElement.dataset.theme = mode;
  setThemeModeSignal(mode);
}

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
    writeColorMode(mode === "light" ? "light" : "dark");
  }
}

function onSystemChange(): void {
  writeColorMode(systemMedia?.matches ? "light" : "dark");
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
 * that must hand a theme value to another surface (plugin page canvases).
 * Non-reactive by contract; use `themeMode()` where a render must track
 * flips (host-rendered plugin icons, #44). */
export function currentThemeMode(): "light" | "dark" {
  return themeMode();
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
