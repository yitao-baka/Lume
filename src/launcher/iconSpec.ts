//! Plugin icon specs (ROADMAP #44) — resolve raw `icon` inputs into a
//! light/dark/legacy set and pick one per surface theme.
//!
//! A plugin can hand the host artwork three ways:
//! - manifest/feature `icon_light` / `icon_dark` (explicit variants);
//! - a runtime row `icon: { light, dark }` object (provider results, navBars
//!   items, list-template rows);
//! - the legacy single `icon` (string) — dark mode keeps the historical
//!   `--icon-filter` inversion on the surfaces that always inverted it.
//!
//! Choice rule (exact variant → legacy → other variant), applied against the
//! **surface's** effective mode: launcher/settings rows follow their own
//! document, a detached window's taskbar icon follows the plugin's effective
//! mode (Rust-side, `appicon.rs`). Reads go through `themeMode()`, so a
//! theme flip re-renders host-rendered icons without re-running a search.

import { convertFileSrc } from "@tauri-apps/api/core";
import { themeMode } from "../theme";
import type { ColorMode } from "../theme";
import type { PickedIcon, PluginIconSpec } from "./types";

/** data:/http(s):/asset:/blob: URIs pass through untouched; anything else is
 * a file path (absolute, or relative to `base` — a manifest icon is relative
 * to the plugin dir) → asset URL. */
export function resolveIconUrl(icon: unknown, base?: string): string | undefined {
  if (typeof icon !== "string" || icon === "") return undefined;
  if (/^(data:|https?:|asset:|blob:)/i.test(icon)) return icon;
  if (base && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(icon)) {
    return convertFileSrc(base + "\\" + icon);
  }
  return convertFileSrc(icon);
}

/** Resolve one raw `icon` input (a manifest field, a row's explicit icon) to
 * a spec. A plain string is the legacy single-icon form; an object carries
 * explicit variants. Empty/unknown shapes → undefined (caller falls through
 * to the next level: row → plugin → the path pipeline). */
export function resolveIconInput(icon: unknown, base?: string): PluginIconSpec | undefined {
  if (typeof icon === "string") {
    const legacy = resolveIconUrl(icon, base);
    return legacy ? { legacy } : undefined;
  }
  if (icon && typeof icon === "object") {
    const x = icon as { light?: unknown; dark?: unknown };
    const light = resolveIconUrl(x.light, base);
    const dark = resolveIconUrl(x.dark, base);
    return light || dark ? { light, dark } : undefined;
  }
  return undefined;
}

/** A manifest/feature-level spec from its three fields: explicit variants
 * win over the legacy single icon; undefined when all are empty. */
export function resolveThemedIcon(
  icon: unknown,
  iconLight: unknown,
  iconDark: unknown,
  base?: string
): PluginIconSpec | undefined {
  const light = resolveIconUrl(iconLight, base);
  const dark = resolveIconUrl(iconDark, base);
  const legacy = resolveIconUrl(icon, base);
  return light || dark || legacy ? { light, dark, legacy } : undefined;
}

/** Pick the URL for one color mode: the exact variant → the legacy single
 * icon → the other variant (an author who shipped only one variant gets it
 * everywhere). `legacy` flags a legacy pick so render sites that always
 * inverted plugin icons (mode pill, list template) can keep the filter for
 * it and suppress it for explicit variants. Defaults to the current
 * document's mode — reading the reactive signal is what makes a themed icon
 * follow theme flips. */
export function pickIcon(
  icon: PluginIconSpec | string | undefined,
  mode: ColorMode = themeMode()
): PickedIcon | undefined {
  if (!icon) return undefined;
  if (typeof icon === "string") return { src: icon, legacy: true };
  const primary = mode === "dark" ? icon.dark : icon.light;
  if (primary) return { src: primary, legacy: false };
  if (icon.legacy) return { src: icon.legacy, legacy: true };
  const other = mode === "dark" ? icon.light : icon.dark;
  return other ? { src: other, legacy: false } : undefined;
}
