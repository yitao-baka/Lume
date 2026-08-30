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
  /** Entry JS file (disk plugins, relative to the plugin dir). */
  entry: string;
  /** View HTML file (disk mode plugins, relative to the plugin dir). */
  view: string;
  /** Global keywords (uTools-style mode entry). */
  keywords: string[];
  /** Absolute plugin directory (disk plugins; empty for built-ins). */
  dir: string;
}

/** The capability surface handed to disk plugin factories (v2, uTools-
 * inspired). First-party plugins get the same shape via `createHostApi`. */
export interface PluginHostApi {
  app: {
    /** Hide the launcher (equivalent to Esc/blur). */
    hide(): void;
    /** Bottom toast (1.6s, or 3s when opts.undo is set). */
    toast(text: string, opts?: { undo?: () => void; duration?: number }): void;
    /** Overwrite the launcher search-box query. */
    setQuery(q: string): void;
    /** Open a file path or URL via launch_app (ShellExecuteW). */
    openPath(path: string): void;
  };
  clipboard: {
    /** Current system clipboard text (null = non-text/empty). */
    readText(): Promise<string | null>;
    /** Write plain text to the system clipboard. */
    writeText(text: string): Promise<void>;
  };
  /** Plugin-scoped key/value store persisted to
   * `<base>/plugins/<id>/storage.json` (values are JSON-serialized). */
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

/** Optional lifecycle hooks for disk **service** plugins (headless). */
export interface ServiceHooks {
  onShow?(): void;
  onHide?(): void;
  /** Every Navigate keystroke (non-empty query). */
  onQuery?(q: string): void;
}

/** What a disk **mode** plugin's factory returns. The page UI lives in
 * `view` (HTML); the logic object only feeds it events and may transform
 * queries. All members optional. */
export interface DiskModeLogic {
  /** Called on every query keystroke while the mode is active. */
  onQuery?(q: string): void;
  /** Called each time the launcher shows with this mode active. */
  onShow?(): void;
  /** Called when the launcher hides with this mode active. */
  onHide?(): void;
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
  /** Overwrite the launcher search-box query (the active mode's query). */
  setQuery(q: string): void;
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
  /** Launcher hidden with this mode active (lifecycle hook, optional). */
  onHide?(): void;
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
  modeMeta?: {
    labelKey: string;
    placeholderKey: string;
    icon: string;
    /** Raw display label (disk modes have no i18n key). */
    label?: string;
  };
  mode?: ModeInstance;
  preview?: PreviewService;
  provider?: ProviderInstance;
  /** Global keywords + display name (uTools-style mode entry). */
  keywords?: string[];
  pluginName?: string;
  /** Headless lifecycle hooks (disk service plugins). */
  lifecycle?: ServiceHooks;
  /** Actions for the shared context menu (structural — menu.ts declares the
   * narrow interface it needs). */
  clipMenuActions?: () => unknown;
}

/** Mode ids are strings; "apps" is the built-in Navigate mode (not a plugin)
 * and shares the id space with plugin modes (persisted in 记住上次所在页面). */
export type ModeId = string;
export const APPS_MODE: ModeId = "apps";
