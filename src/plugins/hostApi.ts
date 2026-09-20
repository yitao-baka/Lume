//! The host capability API (v2, uTools-inspired) — one instance per plugin
//! id. First-party factories receive it as their `ctx`; disk plugin iframe
//! pages reach the same surface through the postMessage bridge (§ iframe).

import { invoke } from "@tauri-apps/api/core";
import type { FileSearchOut, PluginHostApi, PluginServices } from "./types";
import { plog } from "./log";

/** Build the capability surface for one plugin id. `services` comes from the
 * composition root; every storage call is scoped by the plugin id (the Rust
 * side enforces the directory containment). */
export function createHostApi(id: string, services: PluginServices): PluginHostApi {
  return {
    app: {
      hide: () => {
        plog.debug(id, "app.hide");
        services.resetAndHide();
      },
      toast: (text, opts) => {
        plog.debug(id, "app.toast:", text);
        services.showToast(text, opts);
      },
      setQuery: (q) => {
        plog.debug(id, "app.setQuery:", q);
        services.setQuery(q);
      },
      setPlaceholder: (text) => {
        plog.debug(id, "app.setPlaceholder:", text);
        services.setModePlaceholder(id, text);
      },
      openPath: (path) => {
        plog.debug(id, "app.openPath:", path);
        services.markEntryOpened(); // opening a target = using an entry
        void invoke("launch_app", { path, name: path, elevated: false }).catch((err) =>
          plog.error(id, "app.openPath failed:", err)
        );
      },
      resize: (size) => {
        plog.debug(id, "app.resize:", size);
        services.resizeWindow(size ?? {});
      },
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
      set: async (key, value) => {
        await invoke("plugin_storage_set", { id, key, value: JSON.stringify(value ?? null) });
      },
      remove: async (key) => {
        await invoke("plugin_storage_set", { id, key, value: null });
      },
    },
    search: {
      files: (q: string, max?: number) =>
        invoke<FileSearchOut>("file_search", { query: q, max }),
    },
  };
}
