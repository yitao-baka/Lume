//! Application skin registry. `skins.json` is the single source shared with
//! Rust for panel surfaces and accent contrast anchors.

import registry from "./skins.json";

export type SkinId = "quiet" | "chromatic";
export type ResolvedColorMode = "light" | "dark";

interface SkinDefinition {
  surfaces: Record<ResolvedColorMode, string>;
  accentAnchors: Record<ResolvedColorMode, string>;
  accents: Record<ResolvedColorMode, string>;
}

interface SkinRegistry {
  version: number;
  default: SkinId;
  skins: Record<SkinId, SkinDefinition>;
}

const data = registry as SkinRegistry;

export const SKIN_IDS = Object.freeze(Object.keys(data.skins) as SkinId[]);
export const DEFAULT_SKIN: SkinId = normalizeSkin(data.default);

export function isSkinId(value: unknown): value is SkinId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(data.skins, value);
}

export function normalizeSkin(value: unknown): SkinId {
  return isSkinId(value) ? value : DEFAULT_SKIN;
}

export function skinDefinition(skin: unknown): SkinDefinition {
  return data.skins[normalizeSkin(skin)];
}

/** The opaque launcher surface shared by CSS, iframe canvases, detached
 * windows and the Rust DWM border. */
export function skinSurface(skin: unknown, mode: ResolvedColorMode): string {
  return skinDefinition(skin).surfaces[mode];
}

/** Worst-case background used when correcting custom accent contrast. */
export function skinAccentAnchor(skin: unknown, mode: ResolvedColorMode): string {
  return skinDefinition(skin).accentAnchors[mode];
}

/** The skin's native accent for the settings default swatch. */
export function skinDefaultAccent(skin: unknown, mode: ResolvedColorMode): string {
  return skinDefinition(skin).accents[mode];
}

/** The skin-owned virtual row rhythm. Both clipboard Presenters read this
 * instead of carrying their own fixed height constants. */
export function clipboardRowHeight(skin: unknown, presenterId: string): number {
  const chromatic = normalizeSkin(skin) === "chromatic";
  if (presenterId === "clipboard-compact") return chromatic ? 48 : 44;
  return chromatic ? 56 : 52;
}