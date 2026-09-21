//! The host capability API (v2, uTools-inspired) — one instance per plugin
//! id. First-party factories receive it as their `ctx`; disk plugin iframe
//! pages reach the same surface through the postMessage bridge (§ iframe).

import { invoke } from "@tauri-apps/api/core";
import type {
  FileSearchOut,
  PluginFileSearchOptions,
  PluginHostApi,
  PluginServices,
} from "./types";
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
      revealPath: (path) => {
        plog.debug(id, "app.revealPath:", path);
        // No markEntryOpened, no hide: after "open location" the user usually
        // keeps searching — the plugin decides when to hide itself.
        void invoke("reveal_in_folder", { path }).catch((err) =>
          plog.error(id, "app.revealPath failed:", err)
        );
      },
      trash: (paths) => {
        plog.debug(id, "app.trash:", paths.length, "path(s)");
        // The plugin owns the confirmation (toast / UI double-confirm); the
        // host shows none. Recycle-bin only — no permanent-delete fallback.
        void invoke("trash_to_recycle", { paths }).catch((err) =>
          plog.error(id, "app.trash failed:", err)
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
    fs: {
      readText: (path: string) => {
        plog.debug(id, "fs.readText:", path);
        // >512KB rejects (Rust side) — the plugin shows a "preview first
        // 512KB" message; binary content comes back lossy-UTF8 decoded.
        return invoke<string>("get_file_text", { path });
      },
      thumb: (path: string) => {
        plog.debug(id, "fs.thumb:", path);
        return invoke<string>("get_file_thumb", { path }); // base64 PNG data URI
      },
      videoPoster: (path: string) => {
        plog.debug(id, "fs.videoPoster:", path);
        return invoke<string>("get_video_thumb", { path }); // base64 PNG data URI
      },
      icon: (paths: string[]) => {
        plog.debug(id, "fs.icon:", paths.length, "path(s)");
        return invoke<{ path: string; icon: string | null }[]>("get_app_icons", { paths });
      },
    },
    search: {
      files: (q: string, opts?: number | PluginFileSearchOptions) => {
        // Legacy callers pass a bare number (max); new callers an object.
        const o: PluginFileSearchOptions = typeof opts === "number" ? { max: opts } : (opts ?? {});
        plog.debug(id, "search.files:", q, o);
        return invoke<FileSearchOut>("file_search", {
          query: q,
          max: o.max,
          offset: o.offset,
          sort: o.sort,
          exts: o.exts,
          folder: o.folder,
        });
      },
    },
  };
}
