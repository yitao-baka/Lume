//! Global accent runtime — normalizes the persisted color, derives the five
//! semantic tiers against the active surface, and owns every custom-accent
//! root variable.

import { themeMode } from "../theme";
import { contrastRatio, mixHex, normalizeHexColor, surfaceToneFor } from "./color";
import {
  normalizeSkin,
  skinAccentAnchor,
  skinDefaultAccent,
  skinSurface,
  type ResolvedColorMode,
  type SkinId,
} from "./registry";
import { currentSkin, currentSurface, onSurfaceChange } from "./runtime";

export const ACCENT_PRESETS = [
  { value: "#5ac8fa", labelKey: "appearanceAccentPresetAqua" },
  { value: "#6f7cff", labelKey: "appearanceAccentPresetIndigo" },
  { value: "#a678ff", labelKey: "appearanceAccentPresetViolet" },
  { value: "#d96c95", labelKey: "appearanceAccentPresetRose" },
  { value: "#3fb98b", labelKey: "appearanceAccentPresetEmerald" },
  { value: "#e0a33a", labelKey: "appearanceAccentPresetAmber" },
] as const;

const ACCENT_PRESET_CHROMATIC = {
  value: "#ac8e97",
  labelKey: "appearanceAccentPresetBlush",
} as const;

export const ACCENT_CUSTOM_FALLBACK = "#ffffff";

export type AccentTokens = {
  raw: string;
  accent: string;
  text: string;
  border: string;
  on: string;
  focus: string;
};

let activeAccent = "";
const listeners = new Set<(accent: string) => void>();

export function accentPresets(skin: SkinId) {
  return skin === "chromatic"
    ? [ACCENT_PRESET_CHROMATIC, ...ACCENT_PRESETS.slice(1)]
    : ACCENT_PRESETS;
}

export function nativeAccent(skin: SkinId, mode: ResolvedColorMode = themeMode()): string {
  return skinDefaultAccent(normalizeSkin(skin), mode);
}

export const normalizeAccent = normalizeHexColor;
export const accentContrast = contrastRatio;

function correctContrast(
  accent: string,
  background: string,
  minimum: number,
  target: "#ffffff" | "#000000",
): string {
  if (accentContrast(accent, background) >= minimum) return accent;
  for (let percent = 1; percent <= 100; percent++) {
    const candidate = mixHex(accent, target, percent);
    if (accentContrast(candidate, background) >= minimum) return candidate;
  }
  return target;
}

function bestForeground(background: string): "#ffffff" | "#000000" {
  return accentContrast("#ffffff", background) >= accentContrast("#000000", background)
    ? "#ffffff"
    : "#000000";
}

/** Derive every accent tier for one skin / resolved mode combination. A
 * custom launcher surface replaces the skin's worst-case contrast anchor. */
export function deriveAccentTokens(
  accent: string,
  mode: ResolvedColorMode,
  skin: SkinId = currentSkin(),
  background?: string,
): AccentTokens | null {
  const raw = normalizeAccent(accent);
  if (!raw) return null;
  const anchor = background ?? skinAccentAnchor(skin, mode);
  const target = surfaceToneFor(anchor) === "light" ? "#000000" : "#ffffff";
  const safeAccent = correctContrast(raw, anchor, 3, target);
  return {
    raw,
    accent: safeAccent,
    text: correctContrast(raw, anchor, 4.5, target),
    border: correctContrast(raw, anchor, 3, target),
    on: bestForeground(safeAccent),
    focus: safeAccent,
  };
}

function writeAccent(): void {
  const root = document.documentElement;
  const skin = currentSkin();
  const mode = themeMode();
  const surface = currentSurface(mode, skin);
  const customSurface = normalizeHexColor(surface) !== skinSurface(skin, mode);
  if (!activeAccent && !customSurface) {
    delete root.dataset.accent;
    for (const name of [
      "--ui-accent-raw",
      "--ui-accent",
      "--ui-accent-text",
      "--ui-accent-border",
      "--ui-accent-on",
      "--ui-focus-ring",
    ]) {
      root.style.removeProperty(name);
    }
    return;
  }
  const tokens = deriveAccentTokens(
    activeAccent || nativeAccent(skin, mode),
    mode,
    skin,
    customSurface ? surface : undefined,
  );
  if (!tokens) return;
  // `surface` marks auto-derived skin accents contrast-corrected for a custom
  // surface; only an explicit accent uses the settings-window "custom" hooks.
  root.dataset.accent = activeAccent ? "custom" : "surface";
  root.style.setProperty("--ui-accent-raw", tokens.raw);
  root.style.setProperty("--ui-accent", tokens.accent);
  root.style.setProperty("--ui-accent-text", tokens.text);
  root.style.setProperty("--ui-accent-border", tokens.border);
  root.style.setProperty("--ui-accent-on", tokens.on);
  root.style.setProperty("--ui-focus-ring", tokens.focus);
}

export function applyAccent(value: unknown): string {
  activeAccent = normalizeAccent(value);
  writeAccent();
  for (const listener of listeners) listener(activeAccent);
  return activeAccent;
}

export function onAccentChange(listener: (accent: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function currentAccent(): string {
  return activeAccent;
}

onSurfaceChange(writeAccent);
