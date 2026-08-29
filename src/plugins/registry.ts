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
import { invoke } from "@tauri-apps/api/core";
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

/** Refresh manifests (builtin + disk) + enabled state from the backend. */
export async function refreshPlugins() {
  try {
    setManifests(await invoke<PluginManifest[]>("get_plugins"));
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
