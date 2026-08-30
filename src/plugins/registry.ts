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
import type { LauncherPlugin, ModeId, ModeInstance, PluginManifest, PluginServices } from "./types";
import { createHostApi } from "./hostApi";
import { createIframeView, injectBridge } from "./iframeBridge";
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
  plugins.push(plugin);
}

/** Refresh manifests (builtin + disk) + enabled state from the backend, then
 * load any newly discovered disk plugins. */
export async function refreshPlugins() {
  try {
    setManifests(await invoke<PluginManifest[]>("get_plugins"));
    await loadDiskPlugins();
  } catch {
    // Keep the previous state — plugins are optional by design.
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
export function providerPlugins(): {
  id: string;
  instance: { search(query: string): Promise<{ name: string; path: string }[]> };
}[] {
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
let pluginServices: PluginServices | null = null;

/** Wire the composition-root services (the host API needs them). Call once
 * before the first refreshPlugins(). */
export function setPluginServices(services: PluginServices) {
  pluginServices = services;
}

async function importDiskModule(dir: string, entry: string): Promise<any> {
  const url = convertFileSrc(dir + "\\" + entry);
  const text = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  const blob = new Blob([text], { type: "text/javascript" });
  return import(URL.createObjectURL(blob));
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

function callHook(logic: Record<string, unknown>, name: string, ...args: unknown[]) {
  const fn = logic[name];
  if (typeof fn === "function") {
    try {
      return (fn as (...a: unknown[]) => unknown)(...args);
    } catch (err) {
      console.error(`[plugins] ${name} failed:`, err);
    }
  }
  return undefined;
}

/** Route a bridge RPC ("app.hide" / "storage.get" / …) to the host API. */
async function execHostRpc(
  id: string,
  method: string,
  args: Record<string, unknown>
): Promise<unknown> {
  const api = createHostApi(id, pluginServices!);
  const a = args as Record<string, string>;
  switch (method) {
    case "app.hide":
      return api.app.hide();
    case "app.toast":
      return api.app.toast(a.text, a.opts as never);
    case "app.setQuery":
      return api.app.setQuery(a.q);
    case "app.openPath":
      return api.app.openPath(a.path);
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
    default:
      throw new Error(`unknown lume rpc: ${method}`);
  }
}

/** Build the ModeInstance for a disk mode plugin (bridged iframe UI). */
function createDiskModeInstance(m: PluginManifest, logic: Record<string, unknown>): ModeInstance {
  const [query, setQuerySig] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const hook = (name: string, ...args: unknown[]) => callHook(logic, name, ...args);
  const { View, post } = createIframeView((method, args) => execHostRpc(m.id, method, args));
  let viewReady = false;

  // Fetch + bridge the view page, then mark ready and deliver the current
  // query (the page may already have assigned lume.on.query).
  void fetchDiskFile(m.dir + "\\" + m.view)
    .then((html) => {
      viewReady = true;
      View.setHtml(injectBridge(html));
      post("query", query());
      post("show");
    })
    .catch((err) => {
      console.error("[plugins] view load failed:", m.id, err);
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
      if (viewReady) post("query", q);
      hook("onQuery", q);
    },
    search: async (q) => {
      if (viewReady) post("query", q);
      hook("onQuery", q);
    },
    reset: () => {
      setSelected(0);
      if (viewReady) post("show");
      hook("onShow");
    },
    selected,
    setSelected,
    rows: () => [],
    activate: () => {},
    onKey: () => false,
    onEscape: () => false,
    previewTarget: () => null,
    previewEnabled: () => false,
    measureViewport: () => {},
    pageKind: () => "main",
    restorePage: () => {},
    applySettings: () => {},
    onHide: () => {
      if (viewReady) post("hide");
      hook("onHide");
    },
    View,
  };
}

/** Load every not-yet-loaded, enabled disk plugin from the manifests. */
export async function loadDiskPlugins() {
  const services = pluginServices;
  let loadedAny = false;
  for (const m of manifests()) {
    if (loadedDiskIds.has(m.id)) continue;
    loadedDiskIds.add(m.id); // mark regardless of outcome — never retry-spam
    if (m.builtin || !m.enabled || !m.dir) continue;

    try {
      if (m.kind === "provider" && m.entry) {
        const def = await importDiskModule(m.dir, m.entry);
        const logic = resolveLogic(def, createHostApi(m.id, services!));
        const search = logic.search;
        if (typeof search !== "function") {
          console.error("[plugins] provider needs search():", m.id);
          continue;
        }
        definePlugin({
          id: m.id,
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
          },
        });
        loadedAny = true;
        console.log("[plugins] loaded provider:", m.id);
      } else if (m.kind === "mode" && m.view) {
        const logic = m.entry
          ? resolveLogic(await importDiskModule(m.dir, m.entry), createHostApi(m.id, services!))
          : {};
        const instance = createDiskModeInstance(m, logic);
        definePlugin({
          id: m.id,
          modeMeta: {
            labelKey: "",
            placeholderKey: "",
            icon: "",
            label: m.name || m.id,
          },
          keywords: m.keywords,
          pluginName: m.name || m.id,
          mode: instance,
        });
        loadedAny = true;
        console.log("[plugins] loaded mode:", m.id);
      } else if (m.kind === "service" && m.entry) {
        const def = await importDiskModule(m.dir, m.entry);
        const logic = resolveLogic(def, createHostApi(m.id, services!));
        definePlugin({
          id: m.id,
          lifecycle: {
            onShow: () => void callHook(logic, "onShow"),
            onHide: () => void callHook(logic, "onHide"),
            onQuery: (q) => void callHook(logic, "onQuery", q),
          },
        });
        loadedAny = true;
        console.log("[plugins] loaded service:", m.id);
      } else {
        console.error("[plugins] unusable manifest (kind/entry/view):", m.id, m.kind);
      }
    } catch (err) {
      console.error("[plugins] load failed:", m.id, err);
    }
  }
  // The `plugins` array is plain — clone the manifests signal so reactive
  // consumers (mode pills, provider merge) re-run after disk loads.
  if (loadedAny) setManifests((prev) => [...prev]);
}

/** Global keywords (uTools-style) of enabled mode plugins → Navigate offers
 * an 「进入 <name>」 row when the query matches one exactly. */
export function modeKeywordMatches(q: string): { id: ModeId; name: string }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return plugins
    .filter((p) => p.mode && isEnabled(p.id))
    .filter((p) =>
      ((p as { keywords?: string[] }).keywords ?? []).some(
        (k) => k.trim().toLowerCase() === needle
      )
    )
    .map((p) => ({
      id: p.id,
      name: (p as { pluginName?: string }).pluginName ?? p.id,
    }));
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

/** Find a plugin's mode instance by id (undefined when disabled/absent). */
export function modeById(id: ModeId): ModeInstance | undefined {
  const p = plugins.find((x) => x.id === id);
  return p && p.mode && isEnabled(p.id) ? p.mode : undefined;
}

export function previewPlugins(): LauncherPlugin[] {
  return plugins.filter((p) => p.preview && isEnabled(p.id));
}

export { isEnabled as pluginEnabled };
