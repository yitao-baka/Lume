//! Per-window skin runtime — the single writer for `data-skin`, `--surface`,
//! the launcher window opacity and the active window skin's native accent
//! metadata.

import { createSignal } from "solid-js";
import { onThemeModeChange, themeMode } from "../theme";
import {
  normalizeHexColor,
  surfaceToneFor,
  type SurfaceTone,
} from "./color";
import {
  DEFAULT_SKIN,
  normalizeSkin,
  skinDefaultAccent,
  skinSurface,
  type ResolvedColorMode,
  type SkinId,
} from "./registry";

export const WINDOW_OPACITY_MIN = 70;
export const WINDOW_OPACITY_MAX = 100;

const [skinSignal, setSkinSignal] = createSignal<SkinId>(DEFAULT_SKIN);

const [surfaceToneSignal, setSurfaceToneSignal] =
  createSignal<SurfaceTone>("dark");
const listeners = new Set<(skin: SkinId) => void>();
const surfaceListeners = new Set<(surface: string, tone: SurfaceTone) => void>();
let activeSkin: SkinId = DEFAULT_SKIN;
let activeWindowColor = "";
let activeWindowOpacity = WINDOW_OPACITY_MAX;

function normalizeWindowOpacity(value: unknown): number {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(numeric)) return WINDOW_OPACITY_MAX;
  return Math.min(
    WINDOW_OPACITY_MAX,
    Math.max(WINDOW_OPACITY_MIN, Math.round(numeric)),
  );
}

function writeSurface(mode: ResolvedColorMode): void {
  const root = document.documentElement;
  const surface = activeWindowColor || skinSurface(activeSkin, mode);
  const tone = surfaceToneFor(surface);
  root.style.setProperty("--surface", surface);
  root.style.setProperty("--skin-accent", skinDefaultAccent(activeSkin, mode));
  root.style.setProperty(
    "--main-window-opacity",
    String(activeWindowOpacity / WINDOW_OPACITY_MAX),
  );
  // `data-theme` remains the user's color-mode choice. Only a conflicting
  // custom surface needs a palette override; matching surfaces keep the
  // existing theme selectors as the single source.
  if (activeWindowColor && tone !== mode) {
    root.dataset.surfaceTone = tone;
  } else {
    delete root.dataset.surfaceTone;
  }

  setSurfaceToneSignal(tone);
  for (const listener of surfaceListeners) listener(surface, tone);
}

/** Apply an appearance skin before first paint and whenever settings change. */
export function applySkin(value: unknown): SkinId {
  activeSkin = normalizeSkin(value);
  document.documentElement.dataset.skin = activeSkin;
  writeSurface(themeMode());
  setSkinSignal(activeSkin);
  for (const listener of listeners) listener(activeSkin);
  return activeSkin;
}

/** Apply the launcher-only surface override. Settings and detached plugin
 * windows never call this, so they keep their skin's opaque surface. */
export function applyWindowSurface(color: unknown, opacity: unknown): void {
  activeWindowColor = normalizeHexColor(color);
  activeWindowOpacity = normalizeWindowOpacity(opacity);
  writeSurface(themeMode());
}

/** Refresh the derived surface after a resolved light/dark flip. */
export function refreshSkinSurface(mode: ResolvedColorMode = themeMode()): void {
  writeSurface(mode);
}

export function currentSkin(): SkinId {
  return skinSignal();
}

/** The effective surface for a window. A custom launcher color is intentionally
 * mode-independent; detached windows have no custom color and receive their
 * skin surface for the requested mode. */
export function currentSurface(
  mode: ResolvedColorMode = themeMode(),
  skin: SkinId = activeSkin,
): string {
  return activeWindowColor || skinSurface(skin, mode);
}

export function currentSurfaceTone(): SurfaceTone {
  return surfaceToneSignal();
}

/** The tone a plugin page must render with for one requested mode. Without a
 * custom launcher color this is the requested skin tone; a `window_color`
 * override makes launcher-embedded pages follow the actual surface. */
export function currentSurfaceToneFor(mode: ResolvedColorMode): SurfaceTone {
  return surfaceToneFor(currentSurface(mode));
}

export function onSkinChange(listener: (skin: SkinId) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function onSurfaceChange(
  listener: (surface: string, tone: SurfaceTone) => void,
): () => void {
  surfaceListeners.add(listener);
  return () => surfaceListeners.delete(listener);
}

onThemeModeChange((mode) => writeSurface(mode));
