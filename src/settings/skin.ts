//! Settings-window skin runtime — the single writer for
//! `document.documentElement.dataset.settingsSkin`.
//!
//! Rust already normalizes the persisted value; this module repeats the
//! normalization before first paint and on every local/remote update so a
//! malformed injected config can never leave the settings webview unstyled.

import type { SettingsSkin } from "./types";

export const SETTINGS_SKINS = ["quiet", "chromatic"] as const;
export const DEFAULT_SETTINGS_SKIN: SettingsSkin = "quiet";

export function normalizeSettingsSkin(value: unknown): SettingsSkin {
  return value === "chromatic" ? "chromatic" : DEFAULT_SETTINGS_SKIN;
}

/** Apply a skin value to the document and return its normalized form. */
export function applySettingsSkin(value: unknown): SettingsSkin {
  const skin = normalizeSettingsSkin(value);
  document.documentElement.dataset.settingsSkin = skin;
  return skin;
}
