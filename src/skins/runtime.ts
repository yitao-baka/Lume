//! Application skin runtime — the single writer for `data-skin`, `--surface`
//! and the skin's native accent metadata.

import { createSignal } from "solid-js";
import { onThemeModeChange, themeMode } from "../theme";
import {
  DEFAULT_SKIN,
  normalizeSkin,
  skinDefaultAccent,
  skinSurface,
  type ResolvedColorMode,
  type SkinId,
} from "./registry";

const [skinSignal, setSkinSignal] = createSignal<SkinId>(DEFAULT_SKIN);
const listeners = new Set<(skin: SkinId) => void>();
let activeSkin: SkinId = DEFAULT_SKIN;

function writeSurface(mode: ResolvedColorMode): void {
  const root = document.documentElement;
  root.style.setProperty("--surface", skinSurface(activeSkin, mode));
  root.style.setProperty("--skin-accent", skinDefaultAccent(activeSkin, mode));
}

/** Apply a skin before first paint and whenever settings change. */
export function applySkin(value: unknown): SkinId {
  activeSkin = normalizeSkin(value);
  document.documentElement.dataset.skin = activeSkin;
  writeSurface(themeMode());
  setSkinSignal(activeSkin);
  for (const listener of listeners) listener(activeSkin);
  return activeSkin;
}

/** Refresh the derived surface after a resolved light/dark flip. */
export function refreshSkinSurface(mode: ResolvedColorMode = themeMode()): void {
  writeSurface(mode);
}

export function currentSkin(): SkinId {
  return skinSignal();
}

export function onSkinChange(listener: (skin: SkinId) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

onThemeModeChange((mode) => writeSurface(mode));
