//! The host RPC router — one `switch` mapping a bridge method name
//! ("app.hide" / "storage.get" / …) to the host API call.
//!
//! Shared by two hosts of a plugin page: the **launcher window** (mode page
//! inside the results area, `registry.ts`) and a **detached plugin window**
//! (`pluginWindow.tsx`). Both build the same `PluginHostApi` for the plugin
//! id — only the `PluginServices` differ (the detached window answers
//! window-locally where it can and forwards launcher-bound actions).

import type { PluginServices } from "./types";
import { createHostApi } from "./hostApi";
import { plog } from "./log";

export async function execHostRpc(
  id: string,
  method: string,
  args: Record<string, unknown>,
  services: PluginServices
): Promise<unknown> {
  plog.debug(id, "rpc →", method, args);
  const api = createHostApi(id, services);
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
    case "app.foreground":
      return api.app.foreground();
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
    case "fs.bytes":
      return api.fs.bytes(a.path);
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
