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
import type { ClipboardItem, FileSearchOut, PreviewReq } from "../launcher/types";

export type { FileSearchOut };

/** Manifest as reported by the Rust `get_plugins` command. */
export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  kind: string;
  description: string;
  /** Capability words the plugin declares (`permissions = [...]` in the
   * manifest). Enforced since P3.2: an RPC whose permission is missing here
   * is refused (unless `trusted`). See `docs/PLUGIN_API.md` §6D.6. */
  permissions: string[];
  builtin: boolean;
  /** 「全部授权」 (settings `plugins.trusted`): every capability check passes,
   * declared or not. Built-ins are never in this list (they are compiled in). */
  trusted: boolean;
  enabled: boolean;
  /** Entry JS file (disk plugins, relative to the plugin dir). */
  entry: string;
  /** View HTML file (disk mode plugins, relative to the plugin dir). */
  view: string;
  /** Mode plugins: `"list"` = the built-in list template renders the plugin's
   * rows (no `view` needed; the plugin ships only `entry` logic). */
  template: string;
  /** Global keywords (uTools-style mode entry). */
  keywords: string[];
  /** Mode plugins: the mode page's preferred window height (logical px);
   * null = use the global 设置 → 窗口大小 → 高度. */
  height: number | null;
  /** Mode plugins: pill icon (relative to the plugin dir; resolved to a
   * URL by the registry). Empty = no pill image. */
  icon: string;
  /** Development flag (manifest `development`): the registry reloads the
   * plugin from disk on every refresh (settings-applied) — code edits take
   * effect without a restart. */
  development: boolean;
  /** Backend-computed pinyin of `keywords` (same order) — lets the frontend
   * match "miao"/"ms" against the Chinese keyword 「秒搜」 without a pinyin
   * library. Empty entries when the plugin has no keywords. */
  keywordsPinyin: { full: string; initials: string }[];
  /** Declarative entry rules (`[[features]]` in the manifest, any kind):
   * a query the rule matches offers an 「<label>」 row that enters the plugin
   * with the query text as payload. See `PluginFeature`. */
  features: PluginFeature[];
  /** Declarative settings (`[[settings]]`, P3.4) — rendered by 设置 → 插件;
   * the values live in the plugin's `__settings` document and reach the
   * plugin through `settings.all()` / `settings.get()` + `onSettings`. */
  settings: PluginSetting[];
  /** Absolute plugin directory (disk plugins; empty for built-ins). */
  dir: string;
}

/** One manifest-declared setting (P3.4). The manifest is the schema: only
 * declared keys can be written, so a renamed key cannot leave stale values. */
export interface PluginSetting {
  /** Key the plugin reads (`settings.get(key)`). */
  key: string;
  /** Pane label (the manifest's `label`, falling back to the key). */
  label: string;
  /** Input kind: `"toggle"` | `"select"` | `"text"` (unknown → text). */
  type: "toggle" | "select" | "text" | string;
  /** Value in effect until the user changes it. */
  default: unknown;
  /** `select` choices (`label` empty → the value is shown). */
  options: { value: string; label: string }[];
}

/** A stored document (P3.1): the plugin's own fields plus the store's
 * bookkeeping. `_rev` is the optimistic lock a write must present. */
export type PluginDoc = Record<string, unknown> & { _id: string; _rev: number };

/** A document to write: no `_rev` = "this is new" (an existing document then
 * conflicts), `_rev` = "replace exactly the version I read". */
export type PluginDocInput = Record<string, unknown> & { _id: string; _rev?: number };

/** One `bulkDocs` outcome — a conflict is reported per entry. */
export interface BulkDocResult {
  _id: string;
  _rev: number | null;
  error: string | null;
}

/** One declarative entry rule (uTools-style feature). `regex` is compiled and
 * matched **in the frontend** (JS `RegExp`, case-insensitive, cached per
 * plugin+rule); a pattern that matches the empty string is ignored (it would
 * fire on every keystroke — the same rule uTools applies to catch-all
 * patterns). */
export interface PluginFeature {
  /** Unique code inside the plugin — delivered on enter. */
  code: string;
  /** `text` (default) | `files` | `img`. A `text` rule matches query text; a
   * `files` rule matches OS drag-dropped files by `extensions`; an `img`
   * rule matches the clipboard holding an image (read via
   * `clipboard.readImage()`). */
  type: "text" | "files" | "img";
  /** `files` rules: accepted extensions (case-insensitive; empty = any). */
  extensions: string[];
  /** Row label; empty → the plugin name is used. */
  label: string;
  /** Regex matched against the query text. */
  regex: string;
  /** Match any non-empty text (used when `regex` is empty). */
  over: boolean;
  /** Optional bounds (characters for text rules; file counts for `files`). */
  minLength: number | null;
  maxLength: number | null;
  /** Optional row icon (relative to the plugin dir). */
  icon: string;
}

/** Payload delivered when a declarative entry rule fires. */
export interface FeatureEnterInfo {
  /** The rule's `code`. */
  code: string;
  /** How the entry was reached: a manifest rule, `app.redirect`, dropped
   * files (`files`) or the clipboard image (`img`). */
  type: "regex" | "over" | "redirect" | "files" | "img";
  /** The matched query text (or the redirect payload; "" for files/img). */
  payload: string;
  /** `files` rules: the dropped file paths (the matched subset). */
  paths?: string[];
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
    /** Customize the search box placeholder shown while this plugin's mode
     * page is active. `""` restores the default text. Non-mode plugins may
     * call it, but the text is only ever displayed for a mode with the
     * plugin's own id. */
    setPlaceholder(text: string): void;
    /** Open a file path or URL via launch_app (ShellExecuteW). */
    openPath(path: string): void;
    /** Reveal a file/folder in Explorer (located and selected). Unlike
     * openPath this does NOT mark the entry opened and does NOT hide the
     * launcher — after "open location" the user usually keeps searching;
     * the plugin hides itself when it wants. */
    revealPath(path: string): void;
    /** Move files/folders to the Recycle Bin (fire-and-forget; failures are
     * logged). No permanent-delete fallback. The host shows no confirmation
     * — the plugin owns it (toast / UI double-confirm) before calling. */
    trash(paths: string[]): void;
    /** Resize the launcher window (logical px). Omitted axes keep their
     * current size; height is clamped to the launcher minimum. The size
     * holds until the next content-driven resize (Navigate auto-fit or a
     * mode switch re-applies the configured size). */
    resize(size: { width?: number; height?: number }): void;
    /** System notification (P1.2) — reaches the user while the launcher is
     * hidden (the in-app toast cannot). Rendered through the shell's
     * notification area; title/body are truncated by the shell's field
     * widths. */
    notify(title: string, body: string): Promise<void>;
    /** Take over the launcher's search box (P2.3): subsequent keystrokes are
     * delivered to this plugin's `onSubInput` instead of running a search.
     * `placeholder` replaces the box's hint while owned; `value` writes an
     * initial text. The host clears ownership on mode switch / next summon. */
    setSubInput(opts?: { placeholder?: string; value?: string }): void;
    /** Give the search box back to the host. */
    removeSubInput(): void;
    /** Jump to another plugin (P2.5): a mode is switched to and receives an
     * `enter` with `type: "redirect"`; providers/services get
     * `onFeature(info)`. Unknown ids are reported with a toast. */
    redirect(pluginId: string, opts?: { code?: string; payload?: string }): void;
  };
  clipboard: {
    /** Current system clipboard text (null = non-text/empty). */
    readText(): Promise<string | null>;
    /** Write plain text to the system clipboard. */
    writeText(text: string): Promise<void>;
    /** Put a PNG on the clipboard (base64 or a `data:image/png;base64,…` URI). */
    writeImage(data: string): Promise<void>;
    /** Put a file/folder list on the clipboard as CF_HDROP (Explorer-style
     * copy). */
    writeFiles(paths: string[]): Promise<void>;
    /** The clipboard's current file list (empty when it holds something
     * else). */
    readFiles(): Promise<string[]>;
    /** The clipboard's image as a `data:image/png;base64,…` URI (null when it
     * holds no decodable image). Same sources the clipboard mode captures:
     * CF_DIB/DIBV5, screenshot tools' custom PNG, CF_BITMAP. */
    readImage(): Promise<string | null>;
    /** Write one payload and paste it into the window that had focus before
     * the launcher appeared (hide → Ctrl+V). Exactly one field. The payload
     * stays on the clipboard afterwards, like a normal copy. */
    paste(payload: { text?: string; image?: string; files?: string[] }): Promise<void>;
  };
  /** Host-side HTTP (P1.1) — no CORS: the request runs in a Rust worker via
   * WinHTTP (Schannel TLS, automatic system proxy). http/https only, default
   * timeout 10s (≤60s), response truncated at 4 MiB with `truncated` set. */
  http: {
    request(req: HttpRequest): Promise<HttpResponse>;
  };
  /** Native file pickers (P1.4). Cancelling resolves to `[]` / `null` — not
   * an error, the plugin decides what to say. */
  dialog: {
    open(opts?: DialogOptions): Promise<string[]>;
    save(opts?: DialogOptions): Promise<string | null>;
  };
  /** Screen geometry (P1.5) in **physical** pixels. */
  screen: {
    cursor(): Promise<{ x: number; y: number }>;
    displays(): Promise<DisplayInfo[]>;
  };
  /** Plugin-scoped key/value store persisted to
   * `<base>/plugins/<id>/storage.json` (values are JSON-serialized). */
  storage: {
    get<T = unknown>(key: string): Promise<T | null>;
    set(key: string, value: unknown): Promise<void>;
    remove(key: string): Promise<void>;
  };
  /** Plugin-scoped **document** store (P3.1) — `<base>/data/plugin_store.db`,
   * a separate SQLite database so a plugin's data can be dropped wholesale.
   * uTools/CouchDB-shaped: documents carry `_rev`, and a write that presents a
   * stale one rejects with a message starting `conflict:` so the plugin can
   * re-read and retry. `storage` stays as the v1 key/value shim.
   *
   * Caps: 512 KB per document, 2000 documents per plugin (also the
   * `allDocs` limit), 1000 documents per `bulkDocs` call. Ids starting with
   * `__` are host-owned and refused (they back `settings` and `storage`). */
  db: {
    /** The document, or null when it doesn't exist. */
    get(id: string): Promise<PluginDoc | null>;
    /** Create (no `_rev`) or replace (matching `_rev`); resolves with the
     * stored `_id`/`_rev`, rejects with a `conflict: …` message otherwise. */
    put(doc: PluginDocInput): Promise<{ _id: string; _rev: number }>;
    /** Delete what you read — pass the document (its `_rev` is used) or an
     * id plus the rev you read. */
    remove(doc: PluginDoc | string, rev?: number): Promise<void>;
    /** This plugin's documents, id-ordered; `__`-prefixed (host) documents
     * are never listed. */
    allDocs(opts?: { idStartsWith?: string; limit?: number }): Promise<PluginDoc[]>;
    /** One transaction, per-document outcomes: a conflict is reported for
     * that entry while the rest of the batch still lands. */
    bulkDocs(docs: PluginDocInput[]): Promise<BulkDocResult[]>;
  };
  /** Declarative settings (P3.4). The manifest's `[[settings]]` block is the
   * schema — the settings pane renders it and these calls read the values.
   * `all()` is the natural call on page load; `onSettings` fires on change. */
  settings: {
    /** Every declared setting with its effective value (defaults ⊕ user). */
    all(): Promise<Record<string, unknown>>;
    /** One setting's effective value (null when it isn't declared). */
    get<T = unknown>(key: string): Promise<T | null>;
  };
  /** Filesystem reads for preview-style plugins. Arbitrary-path access is
   * part of the v1 trust model (§9 安全模型: 显式放置即信任) — since P3.2 the
   * host enforces the declared `fs.read` permission; a plugin's **own**
   * `files/` dir needs none. */
  fs: {
    /** Text file preview, lossy-UTF8 decoded; rejects for files > 512KB —
     * show a "preview first 512KB" style message on rejection. */
    readText(path: string): Promise<string>;
    /** Shell thumbnail as a base64 PNG data URI (usable in `<img src>`).
     * Rejects when the shell has no thumbnail provider for the file. */
    thumb(path: string): Promise<string>;
    /** Video poster frame as a base64 PNG data URI. Rejects without a
     * shell thumbnail provider. */
    videoPoster(path: string): Promise<string>;
    /** Shell icons for a batch of paths — same shape as `get_app_icons`
     * (`icon` is a data/asset URI or null when extraction failed). */
    icon(paths: string[]): Promise<{ path: string; icon: string | null }[]>;
    /** Write text into the plugin's own `files/` dir (P3.3) — no permission
     * needed, the directory belongs to the plugin. Resolves with the absolute
     * path (handy for `openPath` / `paste` / an `<img src>`). `name` is a file
     * name, never a path; ≤10 MiB. */
    writeText(name: string, text: string): Promise<string>;
    /** Write base64 bytes into `files/` (attachments, images; a
     * `data:…;base64,` prefix is accepted). Resolves with the path. */
    writeBytes(name: string, base64: string): Promise<string>;
    /** Read one of the plugin's own files (lossy UTF-8). */
    readPrivate(name: string): Promise<string>;
    /** The plugin's own `files/` dir (empty when nothing was written yet). */
    listPrivate(): Promise<{ name: string; size: number; mtime: number }[]>;
    /** Absolute path of a file in `files/` without reading or writing it. */
    privatePath(name: string): Promise<string>;
    /** Delete one of the plugin's own files (a missing file is not an error). */
    removePrivate(name: string): Promise<void>;
    /** Write text to an **arbitrary** absolute path — the `fs.write`
     * capability, refused unless the manifest declares it (or the plugin is
     * 全部授权). The parent directory must exist; ≤10 MiB. */
    writeFile(path: string, text: string): Promise<void>;
  };
  /** Whole-drive file search — the unified `file_search` facade (ROADMAP
   * #20): a running Everything when present, the LumeSVC self-hosted USN
   * index otherwise. `max` defaults to 12, clamped 1..=100. Legacy callers
   * pass a bare number (max); opts objects add `offset` (0-based page start)
   * and `sort` ("name" | "path" | "size" | "mtime" | "name_desc" |
   * "path_desc" | "size_desc" | "mtime_desc"; invalid = engine default).
   *
   * `exts`/`folder` are the name-level filter a category sidebar sends.
   * Everything receives it as its own `ext:`/`folder:` syntax; the USN engine
   * tests it during the scan (its name ranking buries such matches thousands
   * of hits deep, so a client-side filter over one page cannot find them).
   * The reply echoes `filter` only when a backend really applied it — treat a
   * missing echo as "not filtered". */
  search: {
    files(q: string, opts?: number | PluginFileSearchOptions): Promise<FileSearchOut>;
  };
}

/** Options for `search.files` (see the doc comment above). */
export interface PluginFileSearchOptions {
  offset?: number;
  max?: number;
  sort?: string;
  /** Lowercase extensions without the dot (e.g. ["png", "jpg"]). */
  exts?: string[];
  /** Restrict to directories. */
  folder?: boolean;
}

/** One request for `http.request` (P1.1). */
export interface HttpRequest {
  /** Absolute http/https URL. */
  url: string;
  /** HTTP verb (default GET). Alphabetic only. */
  method?: string;
  headers?: Record<string, string>;
  /** UTF-8 request body. */
  body?: string;
  /** Binary request body (base64); wins over `body`. */
  bodyBase64?: string;
  /** 1000–60000 ms (default 10000). */
  timeoutMs?: number;
}

/** `http.request` reply. `body` is base64 (decode with `atob`) — the
 * convenience wrapper the plugins see also carries `text()`/`json()`. */
export interface HttpResponse {
  status: number;
  /** Response headers, keys lowercased. */
  headers: Record<string, string>;
  body: string;
  /** True when the 4 MiB cap cut the body short. */
  truncated: boolean;
}

/** Shared picker options for `dialog.open` / `dialog.save` (P1.4). */
export interface DialogOptions {
  title?: string;
  /** Directory the picker opens in. */
  defaultPath?: string;
  /** Pre-filled file name. */
  fileName?: string;
  /** `extensions` without dots; an empty list means "all files". */
  filters?: { name: string; extensions: string[] }[];
  /** `dialog.open` only: allow several files (default false). */
  multiple?: boolean;
  /** `dialog.open` only: pick directories instead of files. */
  folder?: boolean;
}

/** One monitor (P1.5), physical pixels. */
export interface DisplayInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  /** Work area (the monitor minus the taskbar). */
  workX: number;
  workY: number;
  workWidth: number;
  workHeight: number;
  primary: boolean;
}

/** Optional lifecycle hooks for disk **service** plugins (headless). */
export interface ServiceHooks {
  onShow?(): void;
  onHide?(): void;
  /** Every Navigate keystroke (non-empty query). */
  onQuery?(q: string): void;
  /** A declarative entry rule of this plugin fired (P2.1) — the headless
   * handler runs without any UI (e.g. transform the text and copy it). */
  onFeature?(info: FeatureEnterInfo): void;
  /** The service took over the search box (`app.setSubInput`) — keystrokes
   * arrive here (P2.3). */
  onSubInput?(text: string): void;
  /** The user changed this plugin's declared settings (P3.4) — `values` is
   * the effective set (`settings.all()`), delivered on change. */
  onSettings?(values: Record<string, unknown>): void;
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
  /** Set the search box placeholder for one plugin's mode page ("" =
   * default). The plugin id is the caller's own — `createHostApi` supplies
   * it — so one plugin can never restyle another's mode. */
  setModePlaceholder(pluginId: string, text: string): void;
  /** Resize the launcher window (logical px; omitted axes keep their size).
   * Backs the disk-plugin `app.resize` bridge RPC. */
  resizeWindow(size: { width?: number; height?: number }): void;
  /** Search-box ownership (P2.3): `opts` claims it for `pluginId`, `null`
   * releases it. Only the active mode's owner receives keystrokes. */
  setSubInput(pluginId: string, opts: { placeholder?: string; value?: string } | null): void;
  /** The plugin id currently owning the search box (null = the host owns it). */
  subInputOwner(): string | null;
  /** Switch to a plugin's mode and/or deliver a declarative entry payload
   * (P2.1 features + P2.5 redirect). Returns false when the target is
   * unknown or unloaded. */
  enterPlugin(pluginId: string, info: FeatureEnterInfo): boolean;
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
  /** A declarative entry rule targeted this mode (P2.1) — the payload is the
   * matched query text. Called after the mode is switched to. */
  onEnter?(info: FeatureEnterInfo): void;
  /** The mode took over the search box (`app.setSubInput`): every keystroke
   * arrives here instead of running the mode's own search (P2.3). */
  onSubInput?(text: string): void;
  /** The user changed this plugin's settings (P3.4); disk mode pages get the
   * same values as a `lume.on.settings` event. */
  onSettings?(values: Record<string, unknown>): void;
  /** Consume Esc (e.g. leave multi-select); true = handled, root won't hide. */
  onEscape(): boolean;
  /** Satellite preview request for the selected row (null = hide). */
  previewTarget(): PreviewReq | null;
  /** Whether this mode currently wants the satellite (设置 → 开启预览). */
  previewEnabled(): boolean;
  /** Re-measure this mode's internal viewport (window sizer hook). */
  measureViewport(): void;
  /** This mode's preferred fixed window height (manifest `height`), or null
   * to use the global 设置 → 窗口大小 → 高度. Read by the sizer's
   * fixed-height branch (plugin modes). */
  desiredHeight?: () => number | null;
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

/** A search result contributed by a provider. Plain `{name, path}` rows
 * activate exactly like native results (launch_app opens files AND URLs);
 * the optional fields turn a row into a richer or plugin-activated entry. */
export interface ProviderResult {
  name: string;
  /** File path or URL opened on activation. Optional when `enter` is set
   * (an action row that doesn't open anything) — the host generates a
   * synthetic unique key for deduplication. */
  path?: string;
  /** Optional second line rendered under the name in the results grid. */
  description?: string;
  /** Explicit icon: data:/http(s):/asset:/blob: URIs pass through, anything
   * else is treated as a file path (resolved via the asset protocol).
   * Omitted → the regular icon pipeline for `path`. */
  icon?: string;
  /** Marker: activating this row calls the provider's `onEnter(item)`
   * instead of launch_app. The launcher stays open — the plugin decides
   * when to hide itself (ctx.app.hide). */
  enter?: boolean;
  /** Marker: activating this row drills down — calls the provider's
   * `select(item)` and replaces the grid with its rows (Esc returns to the
   * parent level). Requires the provider to implement `select`. */
  drill?: boolean;
}

/** A Navigate-page bar (栏目) contributed by a plugin — rendered on the
 * empty-query main menu between 已固定 and the explorer bar (which always
 * stays last). Items activate exactly like native bar entries: `launch_app`
 * opens files AND URLs, and the shared app context menu (pin / launch /
 * open location / admin) works on them. */
export interface NavBarContribution {
  /** Plugin-unique bar id — the host prefixes the plugin id, so the
   * keyboard-navigation zone key is namespaced. */
  id: string;
  /** Rendered title — the plugin localizes it itself. */
  title: string;
  /** Bar entries. `icon` is optional: data:/http(s): URIs pass through,
   * anything else is treated as a file path (resolved via the asset
   * protocol); omitted → the regular icon pipeline (real icons for file
   * paths, unknown-icon fallback otherwise). */
  items: { name: string; path: string; icon?: string }[];
}

/** A `provider` contribution: feeds extra results into Navigate search
 * (appended after the native index, deduped by path). */
export interface ProviderInstance {
  search(query: string): Promise<ProviderResult[]>;
  /** Called when the user activates a row whose `enter` was set. The same
   * result object `search` returned comes back (extra plugin fields are
   * preserved). Exceptions are logged and isolated like search errors. */
  onEnter?(item: ProviderResult): void;
  /** Called when a declarative entry rule of this plugin fires (P2.1). */
  onFeature?(info: FeatureEnterInfo): void;
  /** Drill-down (P2.4): the rows one level below `item`. Activating a row
   * marked `drill` calls this; its rows become the grid content and Esc
   * returns to the previous level. */
  select?(item: ProviderResult): Promise<ProviderResult[]> | ProviderResult[];
  /** Optional: while drilled into `item`, typing in the search box asks for
   * matching rows instead of running a normal search. Without it the box
   * keeps its usual meaning and typing leaves the drilled level. */
  filter?(item: ProviderResult, query: string): Promise<ProviderResult[]> | ProviderResult[];
  /** The user changed this plugin's declared settings (P3.4). */
  onSettings?(values: Record<string, unknown>): void;
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
  /** Navigate-page bars (栏目) — optional, any plugin kind may contribute
   * them. Called by the host on every launcher show + plugin refresh; return
   * the (possibly empty) bar list. */
  navBars?: () => Promise<NavBarContribution[]> | NavBarContribution[];
  /** Global keywords + display name (uTools-style mode entry). */
  keywords?: string[];
  /** Backend-computed pinyin of `keywords` (same order) — consumed by
   * `modeKeywordMatches` for the tiered (exact → prefix → initials → full
   * pinyin) matching. */
  keywordsPinyin?: { full: string; initials: string }[];
  /** Declarative entry rules (P2.1) — consumed by `featureMatches`. */
  features?: PluginFeature[];
  /** Absolute plugin directory (disk plugins) — used to resolve relative
   * feature icons. */
  dir?: string;
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
