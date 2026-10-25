//! Global accent runtime — normalizes the persisted color, derives the five
//! semantic tiers against the active skin's contrast anchors, and owns every
//! custom-accent root variable.

import { onThemeModeChange, themeMode } from "../theme";
import {
  normalizeSkin,
  skinAccentAnchor,
  skinDefaultAccent,
  type ResolvedColorMode,
  type SkinId,
} from "./registry";
import { currentSkin, onSkinChange } from "./runtime";

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

export function accentPresets(skin: SkinId) {
  return skin === "chromatic"
    ? [ACCENT_PRESET_CHROMATIC, ...ACCENT_PRESETS.slice(1)]
    : ACCENT_PRESETS;
}

export function nativeAccent(skin: SkinId, mode: ResolvedColorMode = themeMode()): string {
  return skinDefaultAccent(normalizeSkin(skin), mode);
}

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
export function normalizeAccent(value: unknown): string {
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

function bestForeground(background: string): "#ffffff" | "#000000" {
  return accentContrast("#ffffff", background) >= accentContrast("#000000", background)
    ? "#ffffff"
    : "#000000";
}

/** Derive every accent tier for one skin / resolved mode combination. */
export function deriveAccentTokens(
  accent: string,
  mode: ResolvedColorMode,
  skin: SkinId = currentSkin(),
): AccentTokens | null {
  const raw = normalizeAccent(accent);
  if (!raw) return null;
  const anchor = skinAccentAnchor(skin, mode);
  const target = mode === "light" ? "#000000" : "#ffffff";
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
  if (!activeAccent) {
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
  const tokens = deriveAccentTokens(activeAccent, themeMode());
  if (!tokens) return;
  root.dataset.accent = "custom";
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
  return activeAccent;
}

export function currentAccent(): string {
  return activeAccent;
}

onThemeModeChange(writeAccent);
onSkinChange(writeAccent);
