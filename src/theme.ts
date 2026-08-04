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
