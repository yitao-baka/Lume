import { themeMode } from "../theme";
import type { SettingsSkin } from "./types";

/** Canonical preset colors. Persistence always stores the hex value. */
export const SETTINGS_ACCENT_PRESETS = [
  { value: "#5ac8fa", labelKey: "settingsAccentPresetAqua" },
  { value: "#6f7cff", labelKey: "settingsAccentPresetIndigo" },
  { value: "#a678ff", labelKey: "settingsAccentPresetViolet" },
  { value: "#d96c95", labelKey: "settingsAccentPresetRose" },
  { value: "#3fb98b", labelKey: "settingsAccentPresetEmerald" },
  { value: "#e0a33a", labelKey: "settingsAccentPresetAmber" },
] as const;

/**
 * Chromatic Edge's signature 浅粉. The skin's dark default is 湖蓝 (Aqua), so its
 * own color takes the slot Aqua holds for the other skin — it stays one click
 * away instead of disappearing from the palette.
 */
const SETTINGS_ACCENT_PRESET_CHROMATIC = {
  value: "#ac8e97",
  labelKey: "settingsAccentPresetBlush",
} as const;

/**
 * The preset row for one skin. Only the first slot differs: Quiet leads with
 * 湖蓝, Chromatic with its own signature color; the rest of the row is shared.
 */
export function settingsAccentPresets(skin: SettingsSkin) {
  return skin === "chromatic"
    ? [SETTINGS_ACCENT_PRESET_CHROMATIC, ...SETTINGS_ACCENT_PRESETS.slice(1)]
    : SETTINGS_ACCENT_PRESETS;
}

/**
 * The custom picker's color while nothing has been stored yet: pure white, in
 * every skin and mode. Applying the custom entry with no saved color writes
 * this value instead of falling back to the skin's own accent.
 */
export const SETTINGS_ACCENT_CUSTOM_FALLBACK = "#ffffff";

export type AccentTokens = {
  structure: string;
  structureText: string;
};

/*
 * Contrast anchors are deliberately more conservative than the lightest dark
 * surface / darkest light surface in either skin. The selected background is
 * included because Chromatic paints its active page index with the structure
 * text token on top of it.
 */
const DARK_ANCHOR = "#574e52";
const LIGHT_ANCHOR = "#d1ded4";

function parseHex(value: string): [number, number, number] | null {
  const match = /^#([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  const raw = match[1];
  return [
    Number.parseInt(raw.slice(0, 2), 16),
    Number.parseInt(raw.slice(2, 4), 16),
    Number.parseInt(raw.slice(4, 6), 16),
  ];
}

function toHex(rgb: [number, number, number]): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/** Normalize an untrusted value to `""` or a lowercase `#rrggbb`. */
export function normalizeSettingsAccent(value: unknown): string {
  if (typeof value !== "string") return "";
  let raw = value.trim();
  if (!raw) return "";
  if (raw.startsWith("#")) raw = raw.slice(1);
  if (/^[0-9a-f]{3}$/i.test(raw)) {
    raw = raw
      .split("")
      .map((character) => character + character)
      .join("");
  }
  if (!/^[0-9a-f]{6}$/i.test(raw)) return "";
  return `#${raw.toLowerCase()}`;
}

/** WCAG relative luminance of an sRGB color. */
function luminance(hex: string): number {
  const parsed = parseHex(hex);
  if (!parsed) return 0;
  const [red, green, blue] = parsed.map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function accentContrast(foreground: string, background: string): number {
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function mix(color: string, target: string, percent: number): string {
  const left = parseHex(color);
  const right = parseHex(target);
  if (!left || !right) return color;
  const ratio = Math.min(100, Math.max(0, percent)) / 100;
  return toHex(
    left.map((channel, index) =>
      Math.round(channel * (1 - ratio) + right[index] * ratio),
    ) as [number, number, number],
  );
}

function correctContrast(
  accent: string,
  background: string,
  minimum: number,
  target: "#ffffff" | "#000000",
): string {
  if (accentContrast(accent, background) >= minimum) return accent;
  for (let percent = 1; percent <= 100; percent++) {
    const candidate = mix(accent, target, percent);
    if (accentContrast(candidate, background) >= minimum) return candidate;
  }
  return target;
}

/** Derive the decoration and small-text accent tiers for one light/dark mode. */
export function deriveAccentTokens(
  accent: string,
  mode: "dark" | "light",
): AccentTokens {
  const normalized = normalizeSettingsAccent(accent);
  if (!normalized) return { structure: "", structureText: "" };
  const anchor = mode === "light" ? LIGHT_ANCHOR : DARK_ANCHOR;
  const target = mode === "light" ? "#000000" : "#ffffff";
  return {
    structure: correctContrast(normalized, anchor, 3, target),
    structureText: correctContrast(normalized, anchor, 4.5, target),
  };
}

/**
 * Single writer for the settings-window accent state. Empty or malformed values
 * clear the override so the current skin's native tokens apply untouched.
 */
export function applySettingsAccent(value: unknown): string {
  const accent = normalizeSettingsAccent(value);
  const root = document.documentElement;
  if (!accent) {
    delete root.dataset.settingsAccent;
    root.style.removeProperty("--settings-user-accent");
    root.style.removeProperty("--settings-user-structure");
    root.style.removeProperty("--settings-user-structure-text");
    return "";
  }
  const tokens = deriveAccentTokens(accent, themeMode());
  root.dataset.settingsAccent = "custom";
  root.style.setProperty("--settings-user-accent", accent);
  root.style.setProperty("--settings-user-structure", tokens.structure);
  root.style.setProperty("--settings-user-structure-text", tokens.structureText);
  return accent;
}
