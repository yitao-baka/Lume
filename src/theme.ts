//! Color-mode application (docs/SETTINGS.md 界面页 颜色模式).
//!
//! The palette lives in CSS custom properties under `:root[data-theme="dark"]`
//! / `:root[data-theme="light"]` (src/App.css). This module sets that attribute
//! per the setting (`"system" | "dark" | "light"`); `"system"` follows the OS
//! `prefers-color-scheme` live.

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
