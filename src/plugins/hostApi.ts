//! The host capability API (v2, uTools-inspired) — one instance per plugin
//! id. First-party factories receive it as their `ctx`; disk plugin iframe
//! pages reach the same surface through the postMessage bridge (§ iframe).

import { invoke } from "@tauri-apps/api/core";
import type { PluginHostApi, PluginServices } from "./types";

/** Build the capability surface for one plugin id. `services` comes from the
 * composition root; every storage call is scoped by the plugin id (the Rust
 * side enforces the directory containment). */
export function createHostApi(id: string, services: PluginServices): PluginHostApi {
  return {
    app: {
      hide: () => services.resetAndHide(),
      toast: (text, opts) => services.showToast(text, opts),
      setQuery: (q) => services.setQuery(q),
      openPath: (path) => {
        services.markEntryOpened(); // opening a target = using an entry
        void invoke("launch_app", { path, name: path, elevated: false }).catch((err) =>
          console.error("[plugins] openPath failed:", id, err)
        );
      },
      resize: (size) => services.resizeWindow(size ?? {}),
    },
    clipboard: {
      readText: () => invoke<string | null>("get_clipboard_text"),
      writeText: async (text) => {
        await invoke("set_clipboard_text", { text });
      },
    },
    storage: {
      get: async <T,>(key: string) => {
        const raw = await invoke<string | null>("plugin_storage_get", { id, key });
        return raw == null ? null : (JSON.parse(raw) as T);
      },
      set: async (key: string, value: unknown) => {
        await invoke("plugin_storage_set", { id, key, value: JSON.stringify(value ?? null) });
      },
      remove: async (key: string) => {
        await invoke("plugin_storage_set", { id, key, value: null });
      },
    },
  };
}
