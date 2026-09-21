//! The plugin registry — where launcher capabilities plug in.
//!
//! The composition root creates the shared `PluginServices`, then each
//! first-party module registers itself: `definePlugin(clipboardPlugin)`,
//! `definePlugin(previewPlugin)`. Modes are created eagerly (their signals
//! must exist inside the component's reactive owner); the enabled set comes
//! from the Rust `get_plugins` command (`settings.plugins.disabled`) and is
//! refreshed on `settings-applied`. Disabled mode plugins vanish from the
//! mode pills and Tab cycling; a disabled preview plugin never opens the
//! satellite.

import { createSignal } from "solid-js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { FeatureEnterInfo, LauncherPlugin, ModeId, ModeInstance, NavBarContribution, PluginFeature, PluginManifest, PluginServices, ProviderInstance, ProviderResult } from "./types";
import { createHostApi } from "./hostApi";
import { createIframeView, injectBridge } from "./iframeBridge";
import { plog } from "./log";
import { setPermissionSource } from "./permissions";
export {
  APPS_MODE,
  type LauncherPlugin,
  type ModeId,
  type ModeInstance,
  type PluginManifest,
  type PluginServices,
} from "./types";

const plugins: LauncherPlugin[] = [];
const [manifests, setManifests] = createSignal<PluginManifest[]>([]);

/** Register a plugin. Call once per plugin at composition time. */
export function definePlugin(plugin: LauncherPlugin) {
  plog.debug(plugin.id, "register:", [
    plugin.mode && "mode",
    plugin.provider && "provider",
    plugin.preview && "preview",
    plugin.lifecycle && "lifecycle",
    plugin.navBars && "navBars",
  ]
    .filter(Boolean)
    .join("/"));
  plugins.push(plugin);
}

/** Refresh manifests (builtin + disk) + enabled state from the backend, then
 * load any newly discovered disk plugins. */
export async function refreshPlugins() {
  try {
    const list = await invoke<PluginManifest[]>("get_plugins");
    plog.info(
      null,
      `manifests refreshed: ${list.length} (builtin ${list.filter((m) => m.builtin).length}, ` +
        `disk ${list.filter((m) => !m.builtin).length})`
    );
    for (const m of list) {
      plog.debug(
        m.id,
        `manifest: kind=${m.kind} enabled=${m.enabled} builtin=${m.builtin}` +
          (m.entry ? ` entry=${m.entry}` : "") +
          (m.view ? ` view=${m.view}` : "") +
          (m.keywords.length ? ` keywords=[${m.keywords.join(",")}]` : "")
      );
    }
    setManifests(list);
    await loadDiskPlugins();
  } catch (err) {
    plog.error(null, "get_plugins failed — keeping previous state:", err);
  }
}

function isEnabled(id: string): boolean {
  const m = manifests().find((x) => x.id === id);
  return m ? m.enabled : true; // unknown → enabled (fail-open, like built-ins pre-list)
}

/** All registered plugins (enabled or not). */
export function allPlugins(): LauncherPlugin[] {
  return plugins;
}

/** Enabled provider instances (contributed by registered and disk plugins). */
export function providerPlugins(): { id: string; instance: ProviderInstance }[] {
  return plugins
    .filter((p) => p.provider && isEnabled(p.id))
    .map((p) => ({ id: p.id, instance: p.provider! }));
}

// ── Third-party JS plugin loading (v2: provider / mode / service) ──
//
// A disk plugin's entry is a standard ES Module. Its default export is either
// a plain object (legacy provider form: `{ search }`) or a **factory**
// `create(ctx)` receiving the host capability API (`PluginHostApi`) and
// returning the logic object. `kind` picks the contribution:
// - provider: `{ search(query) → [{name, path}] }` — appended to Navigate results
// - mode:     optional hooks + a `view` HTML page rendered in a bridged iframe
// - service:  headless lifecycle hooks `{ onShow, onHide, onQuery }`
//
// Executing third-party JS is arbitrary code in this webview: the user opts
// in by placing the plugin in plugins/ (the `permissions` manifest field is
// reserved for a future enforcement layer). The mode view iframe is
// same-origin (srcdoc) — no sandbox beyond that trust decision.
const loadedDiskIds = new Set<string>();
/** Ids that this module actually registered into `plugins` (disk loads only)
 * — unload removes exactly these, never a built-in that happens to share an
 * id with a disk manifest. */
const registeredDiskIds = new Set<string>();
let pluginServices: PluginServices | null = null;

/** Wire the composition-root services (the host API needs them). Call once
 * before the first refreshPlugins(). */
export function setPluginServices(services: PluginServices) {
  pluginServices = services;
}

// ── Multi-file ESM module loader (P0.4) ──
//
// A disk entry may be a single ES Module file or a bundled multi-file build
// (e.g. an esbuild/vite product — the Rust side resolves an `entry` directory
// to `index.js` inside it). Relative imports (`./x.js`, `../y.js`) are
// rewritten to blob URLs: every referenced file is fetched via the asset
// protocol, compiled the same way (recursively, cached by path), and the
// specifier is replaced with its blob URL before `import()`. Bare package
// names are NOT resolved — bundle the dependencies in (standard practice for
// launcher plugins; no node_modules on disk).

/** Static `from "..."` / bare `import "..."` / dynamic `import("...")` with a
 * relative specifier. */
const RELATIVE_IMPORT_RE =
  /(from\s*|import\s*\(\s*|import\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

/** One blob-imported module: its URL (for parent rewrites) + namespace. */
interface CompiledModule {
  url: string;
  mod: unknown;
}

/** Path → compiled module promise. Cache across loads within a session;
 * cleared on plugin reload so re-imported code is re-read from disk. */
const moduleCache = new Map<string, Promise<CompiledModule>>();

/** Normalized cache key for a module path. */
function moduleKey(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

/** The directory part of a Windows path (any separator mix). */
function parentDir(p: string): string {
  const norm = p.replace(/\//g, "\\");
  const i = norm.lastIndexOf("\\");
  return i > 0 ? norm.slice(0, i) : norm;
}

/** Resolve `dir` + relative `spec` (`./x.js`, `../../y/z.js`) to a plain
 * Windows path without drive-dependent logic. */
function resolveRelative(dir: string, spec: string): string {
  const parts = (dir + "\\" + spec.replace(/\//g, "\\")).split("\\");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("\\");
}

/** Fetch a module file's text. Without an extension, `.js` then
 * `<dir>/index.js` are tried (extensionless relative imports). */
async function fetchModuleText(path: string): Promise<string> {
  const candidates = /\.[a-zA-Z0-9]+$/.test(path)
    ? [path]
    : [path + ".js", path + "\\index.js"];
  let lastErr: unknown;
  for (const c of candidates) {
    try {
      return await fetchDiskFile(c);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error(`module not found: ${path}`);
}

/** Compile one module (and, recursively, its relative imports) from disk. */
function compileDiskModule(absPath: string): Promise<CompiledModule> {
  const key = moduleKey(absPath);
  const cached = moduleCache.get(key);
  if (cached) return cached;
  const compiled = (async (): Promise<CompiledModule> => {
    const text = await fetchModuleText(absPath);
    const dir = parentDir(absPath);
    const deps = new Map<string, Promise<string>>(); // specifier → blob URL
    for (const m of text.matchAll(RELATIVE_IMPORT_RE)) {
      const spec = m[3];
      if (!deps.has(spec)) {
        deps.set(
          spec,
          compileDiskModule(resolveRelative(dir, spec)).then((c) => c.url)
        );
      }
    }
    const urls = new Map<string, string>(
      await Promise.all(
        [...deps.entries()].map(
          async ([s, pr]) => [s, await pr] as [string, string]
        )
      )
    );
    const rewritten = text.replace(RELATIVE_IMPORT_RE, (m, pre, q, spec) => {
      const url = urls.get(spec);
      return url ? pre + q + url + q : m;
    });
    const url = URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" }));
    return { url, mod: await import(url) };
  })();
  moduleCache.set(key, compiled);
  return compiled;
}

async function importDiskModule(dir: string, entry: string): Promise<any> {
  const joined = dir + "\\" + entry.replace(/\//g, "\\");
  return (await compileDiskModule(joined)).mod;
}

async function fetchDiskFile(path: string): Promise<string> {
  const text = await fetch(convertFileSrc(path)).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  return text;
}

/** Accepts both the legacy plain-object form and the v2 factory form.
 * `def` may also be a module namespace — the default export is used. */
function resolveLogic(def: unknown, api: ReturnType<typeof createHostApi>): Record<string, unknown> {
  const ns = def as { default?: unknown } | null;
  if (ns && typeof ns === "object" && "default" in ns && !("search" in ns)) {
    def = ns.default;
  }
  if (typeof def === "function") {
    const produced = (def as (ctx: unknown) => unknown)(api);
    return (produced && typeof produced === "object" ? produced : {}) as Record<string, unknown>;
  }
  return (def && typeof def === "object" ? def : {}) as Record<string, unknown>;
}

function callHook(id: string, logic: Record<string, unknown>, name: string, ...args: unknown[]) {
  const fn = logic[name];
  if (typeof fn === "function") {
    try {
      return (fn as (...a: unknown[]) => unknown)(...args);
    } catch (err) {
      plog.error(id, `hook ${name} failed:`, err);
    }
  }
  return undefined;
}

/** data:/http(s):/asset:/blob: URIs pass through untouched; anything else in
 * an item's `icon` is a file path (absolute, or relative to `base` — a
 * manifest icon is relative to the plugin dir) → asset URL. */
function resolvePluginIcon(icon: unknown, base?: string): string | undefined {
  if (typeof icon !== "string" || icon === "") return undefined;
  if (/^(data:|https?:|asset:|blob:)/i.test(icon)) return icon;
  if (base && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(icon)) {
    return convertFileSrc(base + "\\" + icon);
  }
  return convertFileSrc(icon);
}

/** Validate + normalize a plugin's `navBars()` return: prefix bar ids with
 * the plugin id (the zone-key namespace), resolve icons, cap items per bar.
 * Malformed bars/entries are dropped with a console error. */
function normalizeNavBarContributions(pluginId: string, raw: unknown): NavBarContribution[] {
  if (!Array.isArray(raw)) return [];
  const out: NavBarContribution[] = [];
  for (const bar of raw) {
    const b = bar as { id?: unknown; title?: unknown; items?: unknown } | null;
    if (
      !b ||
      typeof b.id !== "string" ||
      b.id === "" ||
      typeof b.title !== "string" ||
      !Array.isArray(b.items)
    ) {
      plog.error(pluginId, "bad navBars entry (dropped):", b);
      continue;
    }
    const items = b.items
      .slice(0, 50) // keep the bar grid sane, like the provider result cap
      .filter((it): it is { name: string; path: string; icon?: string } => {
        const x = it as { name?: unknown; path?: unknown; icon?: unknown } | null;
        return (
          !!x &&
          typeof x.name === "string" &&
          typeof x.path === "string" &&
          (x.icon === undefined || typeof x.icon === "string")
        );
      })
      .map((it) => ({ name: it.name, path: it.path, icon: resolvePluginIcon(it.icon) }));
    out.push({ id: `${pluginId}:${b.id}`, title: b.title, items });
  }
  return out;
}

/** The plugin's optional `navBars` hook as a LauncherPlugin contribution —
 * undefined when the logic object doesn't provide one. */
function navBarsContribution(
  pluginId: string,
  logic: Record<string, unknown>
): (() => Promise<NavBarContribution[]> | NavBarContribution[]) | undefined {
  if (typeof logic.navBars !== "function") return undefined;
  return () => {
    try {
      return Promise.resolve(
        normalizeNavBarContributions(
          pluginId,
          (logic.navBars as () => unknown)()
        )
      );
    } catch (err) {
      console.error("[plugins] navBars failed:", pluginId, err);
      return Promise.resolve([]);
    }
  };
}

// ── Capability permissions (P3.2) ──
//
// The ledger, the fail-closed check and the guard that applies it to every
// host API live in `permissions.ts`; this module only wires the manifest
// lookup the check consults (the manifests signal is owned here). The guard
// runs inside `createHostApi`, so both paths a disk plugin has — its logic in
// this window and its mode page over the bridge — are covered.
setPermissionSource((id) => manifests().find((x) => x.id === id));

/** Route a bridge RPC ("app.hide" / "storage.get" / …) to the host API. */
async function execHostRpc(
  id: string,
  method: string,
  args: Record<string, unknown>
): Promise<unknown> {
  plog.debug(id, "rpc →", method, args);
  const api = createHostApi(id, pluginServices!);
  const a = args as Record<string, string>;
  switch (method) {
    case "app.hide":
      return api.app.hide();
    case "app.toast":
      return api.app.toast(a.text, a.opts as never);
    case "app.setQuery":
      return api.app.setQuery(a.q);
    case "app.setPlaceholder":
      return api.app.setPlaceholder(a.text);
    case "app.openPath":
      return api.app.openPath(a.path);
    case "app.revealPath":
      return api.app.revealPath(a.path);
    case "app.trash":
      return api.app.trash(args.paths as string[]);
    case "app.resize":
      return api.app.resize({
        width: args.width as number | undefined,
        height: args.height as number | undefined,
      });
    case "app.notify":
      return api.app.notify(a.title, a.body);
    case "app.setSubInput":
      return api.app.setSubInput(args.opts as { placeholder?: string; value?: string } | undefined);
    case "app.removeSubInput":
      return api.app.removeSubInput();
    case "app.redirect":
      return api.app.redirect(String((args as { pluginId?: string }).pluginId ?? ""), {
        code: (args as { code?: string }).code,
        payload: (args as { payload?: string }).payload,
      });
    case "clipboard.writeImage":
      return api.clipboard.writeImage(a.data);
    case "clipboard.writeFiles":
      return api.clipboard.writeFiles(args.paths as string[]);
    case "clipboard.readFiles":
      return api.clipboard.readFiles();
    case "clipboard.paste":
      return api.clipboard.paste({
        text: args.text as string | undefined,
        image: args.image as string | undefined,
        files: args.files as string[] | undefined,
      });
    case "http.request": {
      const req = args.req as Record<string, unknown>;
      return api.http.request({
        url: String(req?.url ?? ""),
        method: req?.method as string | undefined,
        headers: req?.headers as Record<string, string> | undefined,
        body: req?.body as string | undefined,
        bodyBase64: req?.bodyBase64 as string | undefined,
        timeoutMs: req?.timeoutMs as number | undefined,
      });
    }
    case "dialog.open":
      return api.dialog.open(args.opts as never);
    case "dialog.save":
      return api.dialog.save(args.opts as never);
    case "screen.cursor":
      return api.screen.cursor();
    case "screen.displays":
      return api.screen.displays();
    case "fs.readText":
      return api.fs.readText(a.path);
    case "fs.thumb":
      return api.fs.thumb(a.path);
    case "fs.videoPoster":
      return api.fs.videoPoster(a.path);
    case "fs.icon":
      return api.fs.icon(args.paths as string[]);
    case "clipboard.readText":
      return api.clipboard.readText();
    case "clipboard.writeText":
      return api.clipboard.writeText(a.text);
    case "storage.get":
      return api.storage.get(a.key);
    case "storage.set":
      return api.storage.set(a.key, (args as { value: unknown }).value);
    case "storage.remove":
      return api.storage.remove(a.key);
    // The bridge ships a document's body already stringified (it strips the
    // `_id`/`_rev` bookkeeping on its side); these cases rebuild the document
    // the host API takes, so the Rust command contract stays the only wire.
    case "db.get":
      return api.db.get(a.docId);
    case "db.put":
      return api.db.put({
        ...(JSON.parse(String(args.json ?? "{}")) as Record<string, unknown>),
        _id: a.docId,
        ...(args.rev == null ? {} : { _rev: args.rev as number }),
      });
    case "db.remove":
      return api.db.remove(a.docId, args.rev as number);
    case "db.allDocs":
      return api.db.allDocs(args.opts as { idStartsWith?: string; limit?: number } | undefined);
    case "db.bulkDocs": {
      const rows = (args.docs ?? []) as { docId: string; json: string; rev?: number | null }[];
      return api.db.bulkDocs(
        rows.map((r) => ({
          ...(JSON.parse(r.json || "{}") as Record<string, unknown>),
          _id: r.docId,
          ...(r.rev == null ? {} : { _rev: r.rev }),
        }))
      );
    }
    case "settings.all":
      return api.settings.all();
    case "settings.get":
      return api.settings.get(a.key);
    case "fs.writeText":
      return api.fs.writeText(a.name, a.text);
    case "fs.writeBytes":
      return api.fs.writeBytes(a.name, a.data);
    case "fs.readPrivate":
      return api.fs.readPrivate(a.name);
    case "fs.listPrivate":
      return api.fs.listPrivate();
    case "fs.privatePath":
      return api.fs.privatePath(a.name);
    case "fs.removePrivate":
      return api.fs.removePrivate(a.name);
    case "fs.writeFile":
      return api.fs.writeFile(a.path, a.text);
    case "search.files": {
      // Second arg: legacy number (= max) or { offset, max, sort }.
      const o = args.opts as { offset?: number; max?: number; sort?: string } | undefined;
      return api.search.files(a.q, o);
    }
    default:
      plog.error(id, "unknown lume rpc:", method);
      throw new Error(`unknown lume rpc: ${method}`);
  }
}

/** Build the ModeInstance for a disk mode plugin (bridged iframe UI). */
function createDiskModeInstance(
  m: PluginManifest,
  logic: Record<string, unknown>,
  services: PluginServices
): ModeInstance {
  const [query, setQuerySig] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const hook = (name: string, ...args: unknown[]) => callHook(m.id, logic, name, ...args);
  // How this page was entered (`[[features]]` payload / redirect). Kept until
  // the mode resets and REPLAYED on every ready handshake: the View mounts
  // (and the srcdoc document loads) only when the mode becomes active, so an
  // enter delivered while the document is still loading would be lost — and
  // a fresh document needs the payload again the way it needs query/show.
  let enterPayload: FeatureEnterInfo | null = null;
  // Declarative settings (P3.4) delivered to this page. Kept so the ready
  // handshake can replay them: the pane may change a value while the mode is
  // not active (the srcdoc document doesn't exist yet), and a fresh document
  // needs the current values again.
  let settingsValues: Record<string, unknown> | null = null;
  const { View, post } = createIframeView(
    (method, args) => execHostRpc(m.id, method, args),
    () => {
      // The page's bridge is live and its handlers are assigned: push the
      // current state (this also covers the initial load, where the loader
      // raced the srcdoc document).
      postEv("query", query());
      postEv("show");
      if (enterPayload) postEv("enter", enterPayload);
      if (settingsValues) postEv("settings", settingsValues);
    }
  );
  // Events (query/show/hide) mirror into the plugin log so a silent page is
  // distinguishable from one that never received anything.
  const postEv = (type: string, payload?: unknown) => {
    plog.debug(m.id, `event → ${type}`, payload ?? "");
    post(type, payload);
  };
  let viewReady = false;

  // Fetch + bridge the view page, then mark ready and deliver the current
  // query (the page may already have assigned lume.on.query).
  plog.info(m.id, "mode view fetching:", m.view);
  void fetchDiskFile(m.dir + "\\" + m.view)
    .then((html) => {
      plog.info(m.id, "mode view ready (html", html.length, "bytes)");
      viewReady = true;
      View.setHtml(injectBridge(html));
      // query/show are NOT posted here: setting the srcdoc only starts the
      // document load, so the bridge has no listener yet. The ready handshake
      // (see the onReady callback above) delivers the page state once live.
    })
    .catch((err) => {
      plog.error(m.id, "view load failed:", err);
      View.setHtml(
        `<body style="font:13px sans-serif;color:#f66;padding:16px">plugin view load failed: ${String(
          err
        )}</body>`
      );
    });

  return {
    query,
    setQuery: (q) => {
      setQuerySig(q);
      if (viewReady) postEv("query", q);
      hook("onQuery", q);
    },
    search: async (q) => {
      if (viewReady) postEv("query", q);
      hook("onQuery", q);
      // ModeInstance contract: every search ends with a resize request —
      // without it the window keeps the previous page's size after a mode
      // switch (the fixed-height model differs per mode).
      services.scheduleResize();
    },
    reset: () => {
      setSelected(0);
      // A fresh summon starts a new page state — the previous entry payload
      // no longer describes how this round began.
      enterPayload = null;
      if (viewReady) postEv("show");
      hook("onShow");
      services.scheduleResize();
    },
    selected,
    setSelected,
    rows: () => [],
    activate: () => {},
    onKey: (e) => {
      // Forward every key to the iframe (`lume.on.key`) — plugin pages
      // implement their own arrow/Enter handling. Never consumed: rows() is
      // empty, so the root's own grid bindings are no-ops anyway.
      if (viewReady) {
        post("key", {
          key: e.key,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        });
      }
      return false;
    },
    onEscape: () => false,
    previewTarget: () => null,
    previewEnabled: () => false,
    measureViewport: () => {},
    // Manifest `height` — the mode's preferred fixed window height.
    desiredHeight: () => (m.height != null && m.height > 0 ? m.height : null),
    pageKind: () => "main",
    restorePage: () => {},
    applySettings: () => {},
    onHide: () => {
      if (viewReady) postEv("hide");
      hook("onHide");
    },
    onEnter: (info) => {
      enterPayload = info;
      if (viewReady) postEv("enter", info);
      hook("onEnter", info);
    },
    onSubInput: (text) => {
      if (viewReady) postEv("subInput", text);
      hook("onSubInput", text);
    },
    onSettings: (values) => {
      settingsValues = values;
      if (viewReady) postEv("settings", values);
      hook("onSettings", values);
    },
    View,
  };
}

/** Unload one disk plugin's contributions (hot reload, P0.3): drop its
 * registrations, forget its load attempt and clear the module cache so a
 * re-import re-reads the code from disk. (The cache is global — already-
 * imported modules of other plugins stay alive; only future loads recompile.)
 * Returns false when the id was never loaded from disk. */
export async function unloadDiskPlugin(id: string): Promise<boolean> {
  if (!registeredDiskIds.has(id)) return false;
  registeredDiskIds.delete(id);
  loadedDiskIds.delete(id);
  for (let i = plugins.length - 1; i >= 0; i--) {
    if (plugins[i].id === id) plugins.splice(i, 1);
  }
  moduleCache.clear();
  return true;
}

/** Hot-reload one disk plugin (settings-pane 重载 button → `plugin-reload`
 * event). Re-reads manifests so manifest edits apply too; unknown ids are
 * reported back as false. */
export async function reloadDiskPlugin(id: string): Promise<boolean> {
  const had = await unloadDiskPlugin(id);
  // Re-read manifests first: a renamed/removed plugin must not be resurrected
  // from a stale manifest list, and new keywords/features need a fresh read.
  try {
    setManifests(await invoke<PluginManifest[]>("get_plugins"));
  } catch (err) {
    plog.error(null, "reload: get_plugins failed:", err);
  }
  await loadDiskPlugins();
  return had;
}

/** Load every not-yet-loaded, enabled disk plugin from the manifests.
 * Manifests flagged `development` are unloaded first, so editing their code
 * takes effect on the next refresh (settings-applied) without a restart. */
export async function loadDiskPlugins() {
  const services = pluginServices;
  let loadedAny = false;
  for (const m of manifests()) {
    if (m.builtin || !m.enabled || !m.dir) {
      plog.debug(
        m.id,
        "skip load:",
        m.builtin ? "builtin" : !m.enabled ? "disabled in settings" : "no dir"
      );
      continue;
    }
    if (m.development) await unloadDiskPlugin(m.id);
    if (loadedDiskIds.has(m.id)) {
      plog.debug(m.id, "skip load: already loaded this session");
      continue;
    }
    loadedDiskIds.add(m.id); // mark regardless of outcome — never retry-spam
    try {
      if (m.kind === "provider" && m.entry) {
        const def = await importDiskModule(m.dir, m.entry);
        const logic = resolveLogic(def, createHostApi(m.id, services!));
        const search = logic.search;
        if (typeof search !== "function") {
          plog.error(m.id, "provider needs search() — got", typeof search);
          continue;
        }
        const navBars = navBarsContribution(m.id, logic);
        const rawOnEnter = logic.onEnter;
        const rawOnFeature = logic.onFeature;
        const rawSelect = logic.select;
        const rawFilter = logic.filter;
        const rawOnSettings = logic.onSettings;
        definePlugin({
          id: m.id,
          features: m.features ?? [],
          dir: m.dir,
          provider: {
            search: (q) => {
              try {
                return Promise.resolve(
                  (search as (q: string) => Promise<{ name: string; path: string }[]>)(q)
                );
              } catch (err) {
                return Promise.reject(err);
              }
            },
            ...(typeof rawOnEnter === "function"
              ? {
                  onEnter: (item: ProviderResult) => {
                    try {
                      (rawOnEnter as (it: ProviderResult) => void)(item);
                    } catch (err) {
                      plog.error(m.id, "provider onEnter failed:", err);
                    }
                  },
                }
              : {}),
            ...(typeof rawOnFeature === "function"
              ? {
                  onFeature: (info: FeatureEnterInfo) => {
                    try {
                      (rawOnFeature as (i: FeatureEnterInfo) => void)(info);
                    } catch (err) {
                      plog.error(m.id, "provider onFeature failed:", err);
                    }
                  },
                }
              : {}),
            ...(typeof rawSelect === "function"
              ? {
                  select: async (item: ProviderResult) => {
                    const rows = await (
                      rawSelect as (it: ProviderResult) => Promise<ProviderResult[]> | ProviderResult[]
                    )(item);
                    return Array.isArray(rows) ? rows : [];
                  },
                }
              : {}),
            ...(typeof rawFilter === "function"
              ? {
                  filter: async (item: ProviderResult, q: string) => {
                    const rows = await (
                      rawFilter as (
                        it: ProviderResult,
                        q: string
                      ) => Promise<ProviderResult[]> | ProviderResult[]
                    )(item, q);
                    return Array.isArray(rows) ? rows : [];
                  },
                }
              : {}),
            ...(typeof rawOnSettings === "function"
              ? {
                  onSettings: (values: Record<string, unknown>) => {
                    try {
                      (rawOnSettings as (v: Record<string, unknown>) => void)(values);
                    } catch (err) {
                      plog.error(m.id, "provider onSettings failed:", err);
                    }
                  },
                }
              : {}),
          },
          ...(navBars ? { navBars } : {}),
        });
        registeredDiskIds.add(m.id);
        // Declarative settings (P3.4): hand the plugin its effective values
        // now, so a logic hook can act on them without waiting for a change.
        void applyPluginSettings(m.id);
        loadedAny = true;
        plog.info(
          m.id,
          `loaded provider (entry=${m.entry}${navBars ? ", navBars" : ""}` +
            `${typeof rawOnEnter === "function" ? ", onEnter" : ""}` +
            `${typeof rawOnFeature === "function" ? ", onFeature" : ""}` +
            `${typeof rawSelect === "function" ? ", select" : ""}` +
            `${typeof rawFilter === "function" ? ", filter" : ""}` +
            `${m.features?.length ? `, ${m.features.length} feature(s)` : ""})`
        );
      } else if (m.kind === "mode" && m.view) {
        const logic = m.entry
          ? resolveLogic(await importDiskModule(m.dir, m.entry), createHostApi(m.id, services!))
          : {};
        const instance = createDiskModeInstance(m, logic, services!);
        const navBars = navBarsContribution(m.id, logic);
        definePlugin({
          id: m.id,
          modeMeta: {
            labelKey: "",
            placeholderKey: "",
            icon: resolvePluginIcon(m.icon, m.dir) ?? "",
            label: m.name || m.id,
          },
          keywords: m.keywords,
          keywordsPinyin: m.keywordsPinyin ?? [],
          features: m.features ?? [],
          dir: m.dir,
          pluginName: m.name || m.id,
          mode: instance,
          ...(navBars ? { navBars } : {}),
        });
        registeredDiskIds.add(m.id);
        // Declarative settings (P3.4): hand the plugin its effective values
        // now, so a logic hook can act on them without waiting for a change.
        void applyPluginSettings(m.id);
        loadedAny = true;
        plog.info(
          m.id,
          `loaded mode (view=${m.view}${m.entry ? `, entry=${m.entry}` : ""}` +
            `${m.height != null ? `, height=${m.height}` : ""}${navBars ? ", navBars" : ""})`
        );
      } else if (m.kind === "service" && m.entry) {
        const def = await importDiskModule(m.dir, m.entry);
        const logic = resolveLogic(def, createHostApi(m.id, services!));
        const navBars = navBarsContribution(m.id, logic);
        definePlugin({
          id: m.id,
          lifecycle: {
            onShow: () => void callHook(m.id, logic, "onShow"),
            onHide: () => void callHook(m.id, logic, "onHide"),
            onQuery: (q) => void callHook(m.id, logic, "onQuery", q),
            onFeature: (info) => void callHook(m.id, logic, "onFeature", info),
            onSubInput: (text) => void callHook(m.id, logic, "onSubInput", text),
            onSettings: (values) => void callHook(m.id, logic, "onSettings", values),
          },
          features: m.features ?? [],
          dir: m.dir,
          ...(navBars ? { navBars } : {}),
        });
        registeredDiskIds.add(m.id);
        // Declarative settings (P3.4): hand the plugin its effective values
        // now, so a logic hook can act on them without waiting for a change.
        void applyPluginSettings(m.id);
        loadedAny = true;
        plog.info(m.id, `loaded service (entry=${m.entry}${navBars ? ", navBars" : ""})`);
      } else {
        plog.error(
          m.id,
          `unusable manifest: kind=${m.kind}` +
            (m.kind === "provider" && !m.entry ? " — provider requires `entry`" : "") +
            (m.kind === "mode" && !m.view ? " — mode requires `view`" : "") +
            (m.kind === "service" && !m.entry ? " — service requires `entry`" : "")
        );
      }
    } catch (err) {
      plog.error(m.id, "load failed:", err);
    }
  }
  if (loadedAny) plog.info(null, "disk plugins loaded; manifests signal refreshed");
  // The `plugins` array is plain — clone the manifests signal so reactive
  // consumers (mode pills, provider merge) re-run after disk loads.
  if (loadedAny) setManifests((prev) => [...prev]);
}

/** Load a plugin's effective settings (P3.4) and hand them to its
 * contribution hooks. Called when a disk plugin is loaded and whenever the
 * settings window changes a value (the Rust `plugin-settings` event) — the
 * plugin instance lives in this window, the pane lives in the settings one, so
 * the values have to be pushed across. */
export async function applyPluginSettings(id: string): Promise<void> {
  const p = plugins.find((x) => x.id === id);
  if (!p) return;
  let values: Record<string, unknown>;
  try {
    values = (await invoke<Record<string, unknown>>("plugin_settings_get", { id })) ?? {};
  } catch (err) {
    plog.error(id, "settings load failed:", err);
    return;
  }
  plog.debug(id, "settings →", values);
  try {
    p.mode?.onSettings?.(values);
    p.provider?.onSettings?.(values);
    p.lifecycle?.onSettings?.(values);
  } catch (err) {
    plog.error(id, "onSettings failed:", err);
  }
}

/** Global keywords (uTools-style) of enabled mode plugins → Navigate offers
 * an 「进入 <name>」 row when the query matches one. Matching tiers, best
 * first: exact (case-insensitive) → prefix → pinyin initials prefix → full
 * pinyin prefix. Pinyin comes precomputed from the backend (`keywordsPinyin`)
 * — the frontend has no pinyin table of its own. */
export function modeKeywordMatches(q: string): { id: ModeId; name: string }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: { id: ModeId; name: string; tier: number }[] = [];
  for (const p of plugins) {
    if (!p.mode || !isEnabled(p.id)) continue;
    const kws = (p as { keywords?: string[] }).keywords ?? [];
    const pys = (p as { keywordsPinyin?: { full: string; initials: string }[] })
      .keywordsPinyin ?? [];
    let best = Infinity;
    kws.forEach((k, i) => {
      const kl = k.trim().toLowerCase();
      let tier = Infinity;
      if (kl === needle) tier = 0;
      else if (kl.startsWith(needle)) tier = 1;
      else {
        const py = pys[i];
        if (py) {
          if (py.initials.startsWith(needle)) tier = 2;
          else if (py.full.startsWith(needle)) tier = 3;
        }
      }
      if (tier < best) best = tier;
    });
    if (best < Infinity) {
      hits.push({
        id: p.id,
        name: (p as { pluginName?: string }).pluginName ?? p.id,
        tier: best,
      });
    }
  }
  hits.sort((a, b) => a.tier - b.tier);
  return hits.map(({ id, name }) => ({ id, name }));
}

/** Enabled plugins contributing Navigate bars (栏目), in registration
 * order. The composition root calls each `navBars()` on show/refresh and
 * feeds the results into the navigate store's section registry. */
export function navBarPlugins(): {
  id: string;
  navBars: () => Promise<NavBarContribution[]> | NavBarContribution[];
}[] {
  return plugins
    .filter((p) => p.navBars && isEnabled(p.id))
    .map((p) => ({ id: p.id, navBars: p.navBars! }));
}

/** Enabled mode plugins, in registration order (id + instance + pill meta). */
export function modePlugins(): {
  id: ModeId;
  instance: ModeInstance;
  modeMeta?: { labelKey: string; placeholderKey: string; icon: string; label?: string };
}[] {
  return plugins
    .filter((p) => p.mode && isEnabled(p.id))
    .map((p) => ({ id: p.id, instance: p.mode!, modeMeta: p.modeMeta }));
}

// ── Declarative entry rules (P2.1: `[[features]]` in the manifest) ──
//
// A feature matches the query text and offers an 「<label>」 row whose
// activation enters the plugin with the text as payload. Matching happens
// here (JS RegExp); the manifest only carries the pattern. Compiled patterns
// are cached per plugin+index; a pattern matching the empty string is
// dropped (it would fire on every keystroke — the same rule uTools applies).

const featureRegexCache = new Map<string, RegExp | null>();

function compileFeatureRegex(pluginId: string, idx: number, pattern: string): RegExp | null {
  const key = `${pluginId}#${idx}`;
  const hit = featureRegexCache.get(key);
  if (hit !== undefined) return hit;
  let out: RegExp | null = null;
  try {
    const re = new RegExp(pattern, "i");
    if (re.test("")) {
      plog.warn(pluginId, `feature[${idx}] regex matches the empty string — ignored`);
    } else {
      out = re;
    }
  } catch (err) {
    plog.error(pluginId, `feature[${idx}] bad regex "${pattern}":`, err);
  }
  featureRegexCache.set(key, out);
  return out;
}

/** A fired entry rule: the row data + what the plugin receives on enter. */
export interface FeatureMatch extends FeatureEnterInfo {
  pluginId: string;
  label: string;
  icon?: string;
}

/** Entry rules of enabled plugins matching a query (empty query → none). */
export function featureMatches(q: string): FeatureMatch[] {
  const query = q.trim();
  if (!query) return [];
  const out: FeatureMatch[] = [];
  for (const p of plugins) {
    if (!isEnabled(p.id)) continue;
    const feats = (p as { features?: PluginFeature[] }).features ?? [];
    feats.forEach((f, i) => {
      if (!f?.code) return;
      const len = query.length;
      if (f.minLength != null && len < f.minLength) return;
      if (f.maxLength != null && len > f.maxLength) return;
      let type: FeatureEnterInfo["type"] = "over";
      if (f.regex) {
        const re = compileFeatureRegex(p.id, i, f.regex);
        if (!re || !re.test(query)) return;
        type = "regex";
      } else if (!f.over) {
        return; // a rule with neither regex nor over never matches
      }
      out.push({
        pluginId: p.id,
        code: f.code,
        type,
        payload: query,
        label: f.label || (p as { pluginName?: string }).pluginName || p.id,
        ...(f.icon ? { icon: resolvePluginIcon(f.icon, (p as { dir?: string }).dir) } : {}),
      });
    });
  }
  return out;
}

/** Route a declarative entry payload to its plugin: a mode receives
 * `onEnter` (the root switches to it first), a provider/service its
 * `onFeature`. Returns false when nothing consumed it (unknown id or no
 * handler) so the caller can tell the user. */
export function deliverFeature(pluginId: string, info: FeatureEnterInfo): boolean {
  const p = plugins.find((x) => x.id === pluginId);
  if (!p || !isEnabled(pluginId)) return false;
  const label = (p as { pluginName?: string }).pluginName ?? pluginId;
  try {
    if (p.mode?.onEnter) {
      p.mode.onEnter(info);
      return true;
    }
    if (p.provider?.onFeature) {
      p.provider.onFeature(info);
      return true;
    }
    if (p.lifecycle?.onFeature) {
      p.lifecycle.onFeature(info);
      return true;
    }
  } catch (err) {
    plog.error(pluginId, "feature enter failed:", err);
    return true; // the handler ran (and threw) — not an "unhandled" case
  }
  plog.warn(pluginId, `no feature handler for code="${info.code}" (${label})`);
  return false;
}

/** Deliver one keystroke to the plugin owning the search box (P2.3). */
export function deliverSubInput(pluginId: string, text: string): boolean {
  const p = plugins.find((x) => x.id === pluginId);
  if (!p || !isEnabled(pluginId)) return false;
  try {
    if (p.mode?.onSubInput) {
      p.mode.onSubInput(text);
      return true;
    }
    if (p.lifecycle?.onSubInput) {
      p.lifecycle.onSubInput(text);
      return true;
    }
  } catch (err) {
    plog.error(pluginId, "onSubInput failed:", err);
    return true;
  }
  plog.warn(pluginId, "sub-input text dropped: no onSubInput handler");
  return false;
}

/** The contribution kind a plugin registered (for feature/redirect targets). */
export function pluginKind(id: string): "mode" | "provider" | "service" | null {
  const p = plugins.find((x) => x.id === id);
  if (!p || !isEnabled(id)) return null;
  if (p.mode) return "mode";
  if (p.provider) return "provider";
  if (p.lifecycle) return "service";
  return null;
}

/** Find a plugin's mode instance by id (undefined when disabled/absent). */
export function modeById(id: ModeId): ModeInstance | undefined {
  const p = plugins.find((x) => x.id === id);
  return p && p.mode && isEnabled(p.id) ? p.mode : undefined;
}

export function previewPlugins(): LauncherPlugin[] {
  return plugins.filter((p) => p.preview && isEnabled(p.id));
}

export { isEnabled as pluginEnabled };
