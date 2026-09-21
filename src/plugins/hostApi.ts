//! The host capability API (v2, uTools-inspired) — one instance per plugin
//! id. First-party factories receive it as their `ctx`; disk plugin iframe
//! pages reach the same surface through the postMessage bridge (§ iframe).

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type {
  DialogOptions,
  DisplayInfo,
  FileSearchOut,
  HttpRequest,
  HttpResponse,
  PluginFileSearchOptions,
  PluginHostApi,
  PluginServices,
} from "./types";
import { plog } from "./log";

/** The richer reply `ctx.http.request` resolves to: the raw fields plus
 * decoded-body conveniences (the bridge transports JSON, so helpers are
 * re-attached on each side rather than serialized). */
export type HttpResult = HttpResponse & {
  /** Body decoded as UTF-8 text (lossy for binary payloads). */
  text(): string;
  /** Body parsed as JSON (throws on malformed JSON). */
  json<T = unknown>(): T;
};

/** Decode a base64 body into a string without Buffer (webview-safe). */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Attach the body helpers to a raw `http.request` reply. */
export function decorateHttpResponse(raw: HttpResponse): HttpResult {
  return {
    ...raw,
    text: () => decodeBase64Utf8(raw.body ?? ""),
    json: <T,>() => JSON.parse(decodeBase64Utf8(raw.body ?? "")) as T,
  };
}

/** Build the capability surface for one plugin id. `services` comes from the
 * composition root; every storage call is scoped by the plugin id (the Rust
 * side enforces the directory containment). */
export function createHostApi(id: string, services: PluginServices): PluginHostApi {
  return {    app: {
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
      notify: async (title, body) => {
        plog.debug(id, "app.notify:", title);
        await invoke("plugin_notify", { title, body, pluginId: id });
      },
      setSubInput: (opts) => {
        plog.debug(id, "app.setSubInput:", opts?.placeholder ?? "");
        services.setSubInput(id, opts ?? {});
      },
      removeSubInput: () => {
        plog.debug(id, "app.removeSubInput");
        services.setSubInput(id, null);
      },
      redirect: (pluginId, opts) => {
        plog.debug(id, "app.redirect →", pluginId, opts?.code ?? "");
        const target = String(pluginId ?? "");
        const ok = services.enterPlugin(target, {
          code: opts?.code ?? "",
          type: "redirect",
          payload: opts?.payload ?? "",
        });
        if (!ok) {
          plog.warn(id, `redirect target unavailable: ${target}`);
          services.showToast(t("pluginActionUnavailable", { id: target }));
        }
      },
    },
    clipboard: {
      readText: () => invoke<string | null>("get_clipboard_text"),
      writeText: async (text) => {
        await invoke("set_clipboard_text", { text });
      },
      writeImage: async (data) => {
        plog.debug(id, "clipboard.writeImage:", data.length, "bytes");
        await invoke("plugin_clipboard_write_image", { data });
      },
      writeFiles: async (paths) => {
        plog.debug(id, "clipboard.writeFiles:", paths.length, "path(s)");
        await invoke("plugin_clipboard_write_files", { paths });
      },
      readFiles: () => invoke<string[]>("plugin_clipboard_read_files"),
      paste: async (payload) => {
        plog.debug(id, "clipboard.paste:", Object.keys(payload ?? {}).join("/"));
        await invoke("plugin_clipboard_paste", {
          text: payload?.text,
          image: payload?.image,
          files: payload?.files,
        });
      },
    },
    http: {
      request: async (req: HttpRequest) => {
        plog.debug(id, "http.request:", req?.method ?? "GET", req?.url);
        const raw = await invoke<HttpResponse>("plugin_http_fetch", {
          req: {
            url: req?.url,
            method: req?.method,
            headers: req?.headers,
            body: req?.body,
            body_base64: req?.bodyBase64,
            timeout_ms: req?.timeoutMs,
          },
        });
        return decorateHttpResponse(raw);
      },
    },
    dialog: {
      open: async (opts?: DialogOptions) => {
        plog.debug(id, "dialog.open:", opts?.title ?? "");
        return invoke<string[]>("plugin_dialog_open", { params: dialogParams(opts) });
      },
      save: async (opts?: DialogOptions) => {
        plog.debug(id, "dialog.save:", opts?.title ?? "");
        return invoke<string | null>("plugin_dialog_save", { params: dialogParams(opts) });
      },
    },
    screen: {
      cursor: () => invoke<{ x: number; y: number }>("plugin_cursor_pos"),
      displays: async () => {
        const raw = await invoke<
          {
            x: number;
            y: number;
            width: number;
            height: number;
            work_x: number;
            work_y: number;
            work_width: number;
            work_height: number;
            primary: boolean;
          }[]
        >("plugin_displays");
        return raw.map(
          (d): DisplayInfo => ({
            x: d.x,
            y: d.y,
            width: d.width,
            height: d.height,
            workX: d.work_x,
            workY: d.work_y,
            workWidth: d.work_width,
            workHeight: d.work_height,
            primary: d.primary,
          })
        );
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

/** Map camelCase dialog options to the snake_case params the Rust command
 * deserializes (`extensions` stays camel-free). */
function dialogParams(opts?: DialogOptions) {
  const o = opts ?? {};
  return {
    title: o.title,
    default_path: o.defaultPath,
    file_name: o.fileName,
    filters: o.filters,
    multiple: o.multiple ?? false,
    folder: o.folder ?? false,
  };
}
