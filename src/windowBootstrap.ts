//! First-frame setup shared by the launcher and settings entries. The Rust
//! initialization script has already injected the effective settings, so the
//! correct color mode, skin and surface are applied before Solid's first paint.

import { applyColorMode } from "./theme";
import { applySkin, applyWindowSurface } from "./skins/runtime";
import { applyAccent } from "./skins/accent";
import { prepareLocale, resolveLocale } from "./i18n";
import "./skins/index.css";

export interface InjectedAppearance {
  skin?: string;
  settings_skin?: string;
  color_mode?: string;
  accent?: string;
  window_color?: string;
  window_opacity?: number;
  language?: string;
}

export interface InjectedConfig {
  appearance?: InjectedAppearance;
}

export type WindowKind = "launcher" | "settings";

export async function prepareWindow(kind: WindowKind): Promise<InjectedConfig | undefined> {
  const cfg = (window as { __LUME_CONFIG__?: InjectedConfig }).__LUME_CONFIG__;
  const appearance = cfg?.appearance;
  const settings = kind === "settings";

  document.documentElement.dataset.windowKind = kind;
  if (settings) document.body.classList.add("settings-window");

  await prepareLocale(resolveLocale(appearance?.language ?? "system"));
  applyColorMode(appearance?.color_mode ?? "system");
  applySkin(
    settings
      ? appearance?.settings_skin ?? appearance?.skin ?? "chromatic"
      : appearance?.skin ?? appearance?.settings_skin,
  );
  if (!settings) {
    applyWindowSurface(appearance?.window_color, appearance?.window_opacity);
  }
  applyAccent(appearance?.accent);
  return cfg;
}
