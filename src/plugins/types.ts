//! Plugin contracts (ROADMAP #7, v1).
//!
//! A plugin pairs a manifest (Rust `plugins.rs`) with one or more
//! *contributions* in the frontend registry. v1 ships two first-party
//! plugins that exercise every contract:
//! - `clipboard` — a **mode** contribution (a full launcher page with its
//!   own query, view, key handling and search).
//! - `preview` — a **service** contribution (the satellite preview window
//!   routing, shared by every mode that exposes previewable rows).
//!
//! Built-ins are compiled into the bundle; on-disk plugins under
//! `<base>/plugins/<id>/` are discovered by the Rust side and surfaced
//! through `get_plugins` (dynamic third-party loading is future work —
//! the manifest/permission surfaces exist so the loader can slot in).

import type { Component } from "solid-js";
import type { ClipboardItem, PreviewReq } from "../launcher/types";

/** Manifest as reported by the Rust `get_plugins` command. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  permissions: string[];
  builtin: boolean;
  enabled: boolean;
  /** Entry JS file (disk provider plugins, relative to the plugin dir). */
  entry: string;
  /** Absolute plugin directory (disk plugins; empty for built-ins). */
  dir: string;
}

/** Services the composition root provides to every plugin. */
export interface PluginServices {
  showToast(text: string, opts?: { undo?: () => void; duration?: number }): void;
  /** Marks that an entry was used (launch/paste/…) — clears search recall. */
  markEntryOpened(): void;
  resetAndHide(): void;
  /** Debounced 记住上次所在页面 write. */
  persistLastPage(): void;
  /** Run the root search pipeline (selection reset + mode dispatch). */
  runSearch(q: string): Promise<void>;
  /** Defer a window re-measure to the next frame. */
  scheduleResize(): void;
  /** Monotonic token — bump on every root-level search; drop stale results. */
  searchToken(): number;
  /** Where the last selection change came from. */
  selectionSource(): "keyboard" | "mouse" | "other";
  /** selectionSource = "mouse" (hover/click takes over from keyboard nav). */
  markMouse(): void;
  /** Open the shared context menu (the root renders it). */
  openMenu(m: MenuStateLike): void;
  /** The launcher's active mode id ("apps" or a plugin mode id). */
  mode(): string;
  /** Request that the root switches to the given mode id. */
  requestMode(id: string): void;
}

/** Structural subset of the shared MenuState (avoids a launcher import). */
export interface MenuStateLike {
  kind: string;
  x: number;
  y: number;
  item?: unknown;
}

export interface ModeKeyContext {
  hasResults: boolean;
  moveSelection(delta: number): void;
}

/** A full launcher page contributed by a plugin (the clipboard is v1's). */
export interface ModeInstance {
  /** This mode's own query — independent per mode, like apps. */
  query: () => string;
  setQuery(q: string): void;
  /** Run this mode's search (results are the mode's own concern). */
  search(q: string): Promise<void>;
  /** Clear per-show state (multi-select, dialogs, …). */
  reset(): void;
  /** Selected row index within this mode's rows (root auto-scrolls/activates). */
  selected: () => number;
  setSelected(i: number): void;
  /** Current rows (Enter/activate operates on these). */
  rows: () => ClipboardItem[];
  /** Activate the selected row (paste / merge-paste). */
  activate(): void;
  /** Handle a key while this mode is active; true = consumed. */
  onKey(e: KeyboardEvent, ctx: ModeKeyContext): boolean;
  /** Consume Esc (e.g. leave multi-select); true = handled, root won't hide. */
  onEscape(): boolean;
  /** Satellite preview request for the selected row (null = hide). */
  previewTarget(): PreviewReq | null;
  /** Whether this mode currently wants the satellite (设置 → 开启预览). */
  previewEnabled(): boolean;
  /** Re-measure this mode's internal viewport (window sizer hook). */
  measureViewport(): void;
  /** 记住上次所在页面: the mode's current page kind + restore. */
  pageKind(): string;
  restorePage(kind: string): void;
  /** Apply the settings slice this mode renders live. */
  applySettings(s: unknown): void;
  /** The full-page view. */
  View: Component;
}

/** A mode contribution — `create` is called once by the composition root. */
export interface ModeContribution {
  /** Stable mode id — persisted in 记住上次所在页面 ("clipboard"). */
  id: string;
  /** i18n keys + icon for the mode pill. */
  labelKey: string;
  placeholderKey: string;
  icon: string;
  create(services: PluginServices): ModeInstance;
}

/** The satellite-preview service contributed by the preview plugin. */
export interface PreviewService {
  /** The pending (synchronously tracked) preview request — Esc priority. */
  currentPreview: () => PreviewReq | null;
  /** Clear without debounce (satellite × / Rust teardown). */
  clear(): void;
}

/** A search result contributed by a provider — AppEntry-shaped, so the
 * results grid, activation (launch_app opens files AND URLs) and the icon
 * pipeline treat provider rows exactly like app rows. */
export interface ProviderResult {
  name: string;
  path: string;
}

/** A `provider` contribution: feeds extra results into Navigate search
 * (appended after the native index, deduped by path). */
export interface ProviderInstance {
  search(query: string): Promise<ProviderResult[]>;
}

/** A plugin: manifest identity + its already-created contributions.
 * First-party plugins export a `create*(services)` factory; the composition
 * root calls it once (inside its reactive owner) and registers the result. */
export interface LauncherPlugin {
  id: string;
  /** Pill metadata when the plugin contributes a mode. */
  modeMeta?: { labelKey: string; placeholderKey: string; icon: string };
  mode?: ModeInstance;
  preview?: PreviewService;
  provider?: ProviderInstance;
  /** Actions for the shared context menu (structural — menu.ts declares the
   * narrow interface it needs). */
  clipMenuActions?: () => unknown;
}

/** Mode ids are strings; "apps" is the built-in Navigate mode (not a plugin)
 * and shares the id space with plugin modes (persisted in 记住上次所在页面). */
export type ModeId = string;
export const APPS_MODE: ModeId = "apps";
