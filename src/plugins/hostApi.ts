//! The host capability API (v2, uTools-inspired) — one instance per plugin
//! id. First-party factories receive it as their `ctx`; disk plugin iframe
//! pages reach the same surface through the postMessage bridge (§ iframe).

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type {
  BulkDocResult,
  DialogOptions,
  DisplayInfo,
  FileSearchOut,
  ForegroundInfo,
  HttpRequest,
  HttpResponse,
  PluginDoc,
  PluginDocInput,
  PluginFileSearchOptions,
  PluginHostApi,
  PluginServices,
} from "./types";
import { plog } from "./log";
import { guardHostApi } from "./permissions";

/** One document row as the Rust store returns it. */
interface DbDocRow {
  id: string;
  rev: number;
  json: string;
}

/** A stored row → the document a plugin sees (`_id`/`_rev` on the parsed body). */
function withBookkeeping(row: DbDocRow): PluginDoc {
  return {
    ...(JSON.parse(row.json) as Record<string, unknown>),
    _id: row.id,
    _rev: row.rev,
  };
}

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
 * side enforces the directory containment).
 *
 * The result is wrapped by `guardHostApi` (P3.2): every capability the
 * permission ledger lists is refused unless the manifest declares it — for
 * the launcher-window logic path and the iframe bridge alike, since both go
 * through here. */
export function createHostApi(id: string, services: PluginServices): PluginHostApi {
  return guardHostApi(id, {    app: {
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
        // pluginId rides along for the Rust-side `trash` permission check.
        void invoke("trash_to_recycle", { paths, pluginId: id }).catch((err) =>
          plog.error(id, "app.trash failed:", err)
        );
      },
      resize: (size) => {
        plog.debug(id, "app.resize:", size);
        services.resizeWindow(size ?? {});
      },
      dragWindow: () => {
        plog.debug(id, "app.dragWindow");
        services.dragWindow();
      },
      notify: async (title, body) => {
        plog.debug(id, "app.notify:", title);
        await invoke("plugin_notify", { title, body, pluginId: id });
      },setSubInput: (opts) => {
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
      foreground: () => {
        plog.debug(id, "app.foreground");
        // The snapshot of the window that had focus before the summon; the
        // Rust side gates the call on the `window` capability.
        return invoke<ForegroundInfo | null>("plugin_foreground_context", { pluginId: id });
      },
    },
    clipboard: {
      readText: () => invoke<string | null>("get_clipboard_text"),
      writeText: async (text) => {
        await invoke("set_clipboard_text", { text });
      },
      writeImage: async (data) => {
        plog.debug(id, "clipboard.writeImage:", data.length, "bytes");
        await invoke("plugin_clipboard_write_image", { data, pluginId: id });
      },
      writeFiles: async (paths) => {
        plog.debug(id, "clipboard.writeFiles:", paths.length, "path(s)");
        await invoke("plugin_clipboard_write_files", { paths, pluginId: id });
      },
      readFiles: () => invoke<string[]>("plugin_clipboard_read_files", { pluginId: id }),
      readImage: () => {
        plog.debug(id, "clipboard.readImage");
        return invoke<string | null>("plugin_clipboard_read_image", { pluginId: id });
      },
      paste: async (payload) => {
        plog.debug(id, "clipboard.paste:", Object.keys(payload ?? {}).join("/"));
        await invoke("plugin_clipboard_paste", {
          text: payload?.text,
          image: payload?.image,
          files: payload?.files,
          pluginId: id,
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
          pluginId: id,
        });
        return decorateHttpResponse(raw);
      },
    },
    dialog: {
      open: async (opts?: DialogOptions) => {
        plog.debug(id, "dialog.open:", opts?.title ?? "");
        return invoke<string[]>("plugin_dialog_open", { params: dialogParams(opts), pluginId: id });
      },
      save: async (opts?: DialogOptions) => {
        plog.debug(id, "dialog.save:", opts?.title ?? "");
        return invoke<string | null>("plugin_dialog_save", { params: dialogParams(opts), pluginId: id });
      },
    },
    screen: {
      cursor: () => invoke<{ x: number; y: number }>("plugin_cursor_pos", { pluginId: id }),
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
        >("plugin_displays", { pluginId: id });
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
    db: {
      get: async (docId) => {
        const row = await invoke<DbDocRow | null>("plugin_db_get", { id, docId });
        return row ? withBookkeeping(row) : null;
      },
      put: async (doc: PluginDocInput) => {
        const { _id, _rev, ...body } = doc ?? ({} as PluginDocInput);
        if (!_id) throw new Error("db.put needs a document with an _id");
        const rev = await invoke<number>("plugin_db_put", {
          id,
          docId: _id,
          json: JSON.stringify(body),
          rev: _rev ?? null,
        });
        plog.debug(id, `db.put ${_id} ${_rev == null ? "(new)" : `(rev ${_rev})`} → rev ${rev}`);
        return { _id, _rev: rev };
      },
      remove: async (docOrId: PluginDoc | string, rev?: number) => {
        const isDoc = typeof docOrId === "object" && docOrId !== null;
        const docId = isDoc ? String((docOrId as PluginDoc)._id ?? "") : String(docOrId);
        const r = isDoc ? (docOrId as PluginDoc)._rev : rev;
        if (!docId) throw new Error("db.remove needs a document id");
        if (r == null) {
          // Fail loudly instead of deleting whatever is there: without the rev
          // this is not a delete of what the plugin read.
          throw new Error(`db.remove(${docId}) needs the doc's _rev — pass the document you read`);
        }
        await invoke("plugin_db_remove", { id, docId, rev: r });
        plog.debug(id, `db.remove ${docId} (rev ${r})`);
      },
      allDocs: async (opts) => {
        const rows = await invoke<DbDocRow[]>("plugin_db_all_docs", {
          id,
          prefix: opts?.idStartsWith ?? null,
          limit: opts?.limit ?? null,
        });
        plog.debug(id, `db.allDocs ${opts?.idStartsWith ?? "*"} → ${rows.length} doc(s)`);
        return rows.map(withBookkeeping);
      },
      bulkDocs: async (docs: PluginDocInput[]) => {
        const payload = (docs ?? []).map((d) => {
          const { _id, _rev, ...body } = d ?? ({} as PluginDocInput);
          if (!_id) throw new Error("db.bulkDocs: every document needs an _id");
          return { docId: _id, json: JSON.stringify(body), rev: _rev ?? null };
        });
        const res = await invoke<{ id: string; rev: number | null; error: string | null }[]>(
          "plugin_db_bulk_docs",
          { id, docs: payload }
        );
        const applied = res.filter((r) => r.error == null).length;
        plog.debug(id, `db.bulkDocs ${res.length} → ${applied} applied`);
        return res.map(
          (r): BulkDocResult => ({ _id: r.id, _rev: r.rev, error: r.error })
        );
      },
    },
    settings: {
      all: async () => (await invoke<Record<string, unknown>>("plugin_settings_get", { id })) ?? {},
      get: async <T,>(key: string) => {
        const values = await invoke<Record<string, unknown>>("plugin_settings_get", { id });
        const v = values?.[key];
        return v === undefined ? null : (v as T);
      },
    },
    fs: {
      readText: (path: string) => {
        plog.debug(id, "fs.readText:", path);
        // >512KB rejects (Rust side) — the plugin shows a "preview first
        // 512KB" message; binary content comes back lossy-UTF8 decoded.
        return invoke<string>("get_file_text", { path });
      },
      bytes: (path: string) => {
        plog.debug(id, "fs.bytes:", path);
        // Raw bytes, base64 (≤32 MB, Rust side). The P5 sandbox made plugin
        // pages opaque origins, so fetch(asset://) is CORS-refused there —
        // binary preview renderers (pdf.js / SheetJS) get their bytes here.
        return invoke<string>("get_file_bytes", { path });
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
      writeText: (name, text) => {
        plog.debug(id, "fs.writeText:", name, text.length, "chars");
        return invoke<string>("plugin_fs_private_write", { id, name, text });
      },
      writeBytes: (name, base64) => {
        plog.debug(id, "fs.writeBytes:", name, base64.length, "base64 chars");
        return invoke<string>("plugin_fs_private_write_b64", { id, name, data: base64 });
      },
      readPrivate: (name) => {
        plog.debug(id, "fs.readPrivate:", name);
        return invoke<string>("plugin_fs_private_read", { id, name });
      },
      listPrivate: () =>
        invoke<{ name: string; size: number; mtime: number }[]>("plugin_fs_private_list", { id }),
      privatePath: (name) => invoke<string>("plugin_fs_private_path", { id, name }),
      removePrivate: async (name) => {
        plog.debug(id, "fs.removePrivate:", name);
        await invoke("plugin_fs_private_remove", { id, name });
      },
      writeFile: (path, text) => {
        plog.debug(id, "fs.writeFile:", path, text.length, "chars");
        return invoke<void>("plugin_fs_write_any", { id, path, text });
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
          pluginId: id,
        });
      },
    },
  });
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
