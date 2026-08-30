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
import type { LauncherPlugin, ModeId, ModeInstance, NavBarContribution, PluginManifest, PluginServices } from "./types";
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

/** data:/http(s):/asset:/blob: URIs pass through untouched; anything else in
 * an item's `icon` is a file path (e.g. inside the plugin dir) → asset URL. */
function resolvePluginIcon(icon: unknown): string | undefined {
  if (typeof icon !== "string" || icon === "") return undefined;
  if (/^(data:|https?:|asset:|blob:)/i.test(icon)) return icon;
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
      console.error("[plugins] bad navBars entry:", pluginId);
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
    case "app.resize":
      return api.app.resize({
        width: args.width as number | undefined,
        height: args.height as number | undefined,
      });
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
    case "search.files":
      return api.search.files(a.q, args.max as number | undefined);
    default:
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
      // ModeInstance contract: every search ends with a resize request —
      // without it the window keeps the previous page's size after a mode
      // switch (the fixed-height model differs per mode).
      services.scheduleResize();
    },
    reset: () => {
      setSelected(0);
      if (viewReady) post("show");
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
        const navBars = navBarsContribution(m.id, logic);
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
          ...(navBars ? { navBars } : {}),
        });
        loadedAny = true;
        console.log("[plugins] loaded provider:", m.id);
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
            icon: "",
            label: m.name || m.id,
          },
          keywords: m.keywords,
          pluginName: m.name || m.id,
          mode: instance,
          ...(navBars ? { navBars } : {}),
        });
        loadedAny = true;
        console.log("[plugins] loaded mode:", m.id);
      } else if (m.kind === "service" && m.entry) {
        const def = await importDiskModule(m.dir, m.entry);
        const logic = resolveLogic(def, createHostApi(m.id, services!));
        const navBars = navBarsContribution(m.id, logic);
        definePlugin({
          id: m.id,
          lifecycle: {
            onShow: () => void callHook(logic, "onShow"),
            onHide: () => void callHook(logic, "onHide"),
            onQuery: (q) => void callHook(logic, "onQuery", q),
          },
          ...(navBars ? { navBars } : {}),
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

/** Find a plugin's mode instance by id (undefined when disabled/absent). */
export function modeById(id: ModeId): ModeInstance | undefined {
  const p = plugins.find((x) => x.id === id);
  return p && p.mode && isEnabled(p.id) ? p.mode : undefined;
}

export function previewPlugins(): LauncherPlugin[] {
  return plugins.filter((p) => p.preview && isEnabled(p.id));
}

export { isEnabled as pluginEnabled };
