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
import type { LauncherPlugin, ModeId, ModeInstance, PluginManifest } from "./types";
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
 * load any newly discovered disk providers. */
export async function refreshPlugins() {
  try {
    setManifests(await invoke<PluginManifest[]>("get_plugins"));
    await loadDiskProviders();
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
export function providerPlugins(): { id: string; instance: { search(query: string): Promise<{ name: string; path: string }[]> } }[] {
  return plugins
    .filter((p) => p.provider && isEnabled(p.id))
    .map((p) => ({ id: p.id, instance: p.provider! }));
}

// ── Third-party JS plugin loading ──
// A disk plugin (`<base>/plugins/<id>/`) with `kind = "provider"` and an
// `entry` JS file is fetched through the asset protocol and imported from a
// blob URL (CSP is null). The module's default export must be
// `{ search(query): Promise<{name, path}[]> }` — the provider contract.
// Executing third-party JS is arbitrary code in this webview: the user opts
// in by placing the plugin in plugins/ (the `permissions` manifest field is
// reserved for a future enforcement layer).
const loadedDiskIds = new Set<string>();

async function importProviderModule(dir: string, entry: string): Promise<unknown> {
  const url = convertFileSrc(dir + "\\" + entry);
  const text = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  const blob = new Blob([text], { type: "text/javascript" });
  return import(URL.createObjectURL(blob));
}

/** Load every not-yet-loaded, enabled disk provider from the manifests. */
export async function loadDiskProviders() {
  for (const m of manifests()) {
    if (loadedDiskIds.has(m.id)) continue;
    loadedDiskIds.add(m.id); // mark regardless of outcome — never retry-spam
    if (m.builtin || m.kind !== "provider" || !m.enabled || !m.entry || !m.dir) {
      continue;
    }
    try {
      const mod = (await importProviderModule(m.dir, m.entry)) as {
        default?: { search?: unknown };
      };
      const def = mod?.default;
      if (def && typeof def.search === "function") {
        const search = def.search as (q: string) => Promise<{ name: string; path: string }[]>;
        definePlugin({
          id: m.id,
          provider: {
            search: (q) => {
              try {
                return Promise.resolve(search(q)) as Promise<{ name: string; path: string }[]>;
              } catch (err) {
                return Promise.reject(err);
              }
            },
          },
        });
        console.log("[plugins] loaded provider:", m.id);
      } else {
        console.error("[plugins] bad default export (need search()):", m.id);
      }
    } catch (err) {
      console.error("[plugins] load failed:", m.id, err);
    }
  }
}

/** Enabled mode plugins, in registration order (id + instance + pill meta). */
export function modePlugins(): {
  id: ModeId;
  instance: ModeInstance;
  modeMeta?: { labelKey: string; placeholderKey: string; icon: string };
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
