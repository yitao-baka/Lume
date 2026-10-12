//! Per-plugin color-mode preferences (`lume.theme.set`, ROADMAP #36).
//!
//! The launcher owns the color mode; a plugin may **pin its own surfaces**
//! (`"light"` / `"dark"`) without touching the launcher, or leave `"system"`
//! to follow it. The durable value is `settings.plugins.color_modes` (Rust,
//! written by `set_plugin_color_mode`); this module is the in-process mirror
//! both hosts read **synchronously** — the registry whenever it pushes `theme`
//! to a page, and `pluginWindow.tsx` before the detached window's first paint
//! (the window chrome must never open in the wrong theme and flip).
//!
//! Every consumer derives the plugin's *effective* mode through
//! `pluginColorMode`; nothing here ever touches the launcher's own
//! `data-theme` (that is the whole point of the feature).

import {
  pluginEffectiveColorMode,
  normalizePluginColorMode,
  type ColorMode,
  type PluginColorMode,
} from "../theme";

const prefs = new Map<string, PluginColorMode>();

/** Who wrote a preference — diagnostics only (`__pluginThemes`). `"main"` = the
 * launcher window answered `theme.set` itself, `"window"` = a detached plugin
 * window or the plugin's logic host, `"settings"` = a settings snapshot
 * (boot / `settings-applied`), `"launcher"` = the value arrived in the
 * launcher's `plugin-state` push. */
export type PluginColorSource = "main" | "window" | "settings" | "launcher";

/** Diagnostic tap (docs/PLUGIN_API.md §10): one line per write. The mode a
 * plugin pinned is invisible from outside — the sandboxed page is unreachable
 * and the detached window's `data-theme` only shows the current value — so
 * probes read the intent *and* its source from here. */
function tap(id: string, pref: PluginColorMode, source: PluginColorSource): void {
  const w = window as unknown as { __pluginThemes?: unknown[] };
  (w.__pluginThemes ??= []).push({ id, pref, source });
  if (w.__pluginThemes.length > 60) (w.__pluginThemes ?? []).shift();
}

/** Seed/replace the mirror from a settings snapshot
 * (`settings.plugins.color_modes`) — boot (`__LUME_CONFIG__`) and every
 * `settings-applied`, so a value written elsewhere (or by a hand-edited
 * `settings.toml`) lands here too. Entries that are not a valid mode are
 * dropped: `theme.set` validates its input, so a bad value means a bad file,
 * not a preference. */
export function seedPluginColorPrefs(src: unknown): void {
  const next = new Map<string, PluginColorMode>();
  if (src && typeof src === "object") {
    for (const [id, v] of Object.entries(src as Record<string, unknown>)) {
      const pref = normalizePluginColorMode(v);
      if (pref) next.set(id, pref);
    }
  }
  for (const [id, pref] of next) {
    if (prefs.get(id) !== pref) tap(id, pref, "settings");
  }
  prefs.clear();
  for (const [id, pref] of next) prefs.set(id, pref);
}

/** This plugin's own preference; `"system"` (follow the launcher) when it
 * never set one. */
export function pluginColorPref(id: string): PluginColorMode {
  return prefs.get(id) ?? "system";
}

/** Record one plugin's preference locally (the caller has persisted it or
 * received it from the launcher). */
export function setPluginColorPref(
  id: string,
  pref: PluginColorMode,
  source: PluginColorSource = "main"
): void {
  if (prefs.get(id) === pref) return;
  prefs.set(id, pref);
  tap(id, pref, source);
}

/** The mode this plugin's surfaces render in right now. */
export function pluginColorMode(id: string, host: ColorMode): ColorMode {
  return pluginEffectiveColorMode(pluginColorPref(id), host);
}
