//! Temporary adapter for built-in pages that have not migrated their data
//! ownership yet. It is internal and removed when the ModeInstance shell
//! contract closes; it is not a public compatibility layer.

import type { JsonValue, PageIntent, PageModel, PageService } from "./contracts";
import type { ModeInstance, PageRow } from "../plugins/types";
import { COLLECTION_SCHEMA, type CollectionItem, type CollectionModel } from "./schemas";

function rowId(row: PageRow): string {
  return `row:${String(row.id)}`;
}

function rowLabel(row: PageRow): string {
  if ("name" in row) return row.name;
  if (row.kind === "file") return row.content.split(/\r?\n/).filter(Boolean)[0] || "File";
  if (row.kind === "image") return "Image";
  return row.content.slice(0, 120);
}

function rowDescription(row: PageRow): string | undefined {
  if ("description" in row && row.description) return row.description;
  if ("source_app" in row && row.source_app) return row.source_app;
  return undefined;
}

function rowActions(row: PageRow): string[] {
  return "path" in row
    ? ["open", "open-as-admin", "reveal"]
    : ["copy", "paste", "pin", "delete", "preview"];
}

export interface MigrationPageAdapter {
  service: PageService;
  snapshot(): PageModel;
}

/** Wrap the old mode contract without making Page Model depend on Solid or
 * on the page's internal store type. */
export function createMigrationPageAdapter(
  instance: ModeInstance,
  pageId: string
): MigrationPageAdapter {
  let revision = 0;

  const snapshot = (): PageModel => {
    const rows = instance.rows();
    const selected = instance.selected();
    const status = instance.ready && !instance.ready()
      ? "loading"
      : rows.length > 0
        ? "ready"
        : "empty";
    const items: CollectionItem[] = rows.map((row) => ({
      id: rowId(row),
      label: rowLabel(row),
      ...(rowDescription(row) ? { description: rowDescription(row) } : {}),
      actions: rowActions(row),
    }));
    const data: CollectionModel = {
      title: pageId,
      items,
      total: items.length,
      window: { offset: 0, limit: Math.max(items.length, 1) },
      emptyText: "",
    };
    revision++;
    return {
      runtime: "lume.page/v1",
      schema: COLLECTION_SCHEMA,
      revision,
      status,
      data: data as unknown as JsonValue,
      selection: {
        ...(items[selected] ? { primaryId: items[selected].id } : {}),
        selectedIds: items[selected] ? [items[selected].id] : [],
      },
      ...(instance.previewTarget() ? { preview: instance.previewTarget() as unknown as PageModel["preview"] } : {}),
    };
  };

  const service: PageService = {
    getModel: snapshot,
    async onIntent(intent: PageIntent) {
      switch (intent.type) {
        case "selection.set": {
          const selectedIds = (intent.payload as { selectedIds?: string[] } | undefined)?.selectedIds ?? [];
          const rows = instance.rows();
          const idx = rows.findIndex((row) => rowId(row) === selectedIds[0]);
          if (idx >= 0) instance.setSelected(idx);
          return { status: "completed" };
        }
        case "selection.move": {
          const delta = (intent.payload as { delta?: number } | undefined)?.delta ?? 0;
          const rows = instance.rows();
          if (rows.length > 0) {
            const next = Math.max(0, Math.min(rows.length - 1, instance.selected() + delta));
            instance.setSelected(next);
          }
          return { status: "completed" };
        }
        case "item.activate":
          instance.activate();
          return { status: "completed" };
        case "item.action":
          if (intent.actionId === "open" || intent.actionId === "paste" || intent.actionId === "copy") {
            instance.activate();
            return { status: "completed" };
          }
          if (intent.actionId === "menu" && instance.openContextMenu?.()) {
            return { status: "completed" };
          }
          return { status: "failed", code: "action.unsupported", message: String(intent.actionId) };
        case "query.submit":
          await instance.search(String((intent.payload as { query?: string } | undefined)?.query ?? ""));
          return { status: "completed" };
        case "page.escape":
          return { status: instance.onEscape() ? "completed" : "accepted" };
        case "page.refresh":
        case "page.retry":
          await instance.search(instance.query());
          return { status: "completed" };
        default:
          return { status: "accepted" };
      }
    },
    onQuery(query) {
      void instance.search(query);
    },
    async onShow() { await instance.onShow?.(); },
    onHide() { instance.onHide?.(); },
    onEnter(info) { instance.onEnter?.(info as never); },
    onFilesDropped(paths) { instance.onFilesDropped?.(paths); },
    onSettings(values) { instance.applySettings(values); },
  };

  return { service, snapshot };
}
