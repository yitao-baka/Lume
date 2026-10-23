//! Clipboard Page Service — wraps the existing Rust-backed store and exposes a
//! windowed lume.clipboard/v1 model. The Presenter never receives the store or
//! invokes Tauri commands.

import { t } from "../../i18n";
import type { ClipboardItem, ClipKind } from "../../launcher/types";
import { previewTarget as clipPreviewTarget } from "../../launcher/clipData";
import { CLIP_CATS } from "../../launcher/types";
import type { IntentResult, JsonValue, PageIntent, PageModel, PageService, ResourceRef } from "../../page-runtime/contracts";
import { CLIPBOARD_SCHEMA, type ClipboardCategory, type ClipboardModel, type ClipboardRowModel } from "../../page-runtime/schemas";
import type { PluginServices } from "../../plugins/types";
import { createClipboardStore, type ClipboardStore } from "../../plugins/clipboard/store";

export interface ClipboardPageDeps {
  services: PluginServices;
}

function clipTargetId(item: ClipboardItem): string {
  return "clip:" + item.id;
}

function thumbRef(item: ClipboardItem): ResourceRef | undefined {
  return item.thumb ? { kind: "thumbnail", src: item.thumb } : undefined;
}

function row(item: ClipboardItem, timeAbsolute: boolean, showSource: boolean): ClipboardRowModel {
  return {
    id: clipTargetId(item),
    numericId: item.id,
    kind: item.kind,
    title: item.kind === "text" ? item.content.slice(0, 160) : item.kind === "file" ? item.content.split(/\r?\n/).filter(Boolean)[0] ?? "File" : "Image",
    ...(showSource && item.source_app ? { description: item.source_app } : {}),
    content: item.content,
    createdAt: item.created_at,
    ...(thumbRef(item) ? { thumb: thumbRef(item) } : {}),
    pinned: item.pinned,
    ...(showSource ? { sourceApp: item.source_app } : {}),
    timeLabel: timeAbsolute ? new Date(item.created_at).toLocaleString() : new Date(item.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    hasHtml: item.has_html,
    mergedCount: item.merged_count,
    valid: item.valid,
    checked: item.checked,
    actions: [
      "copy",
      ...(item.has_html ? ["copy-plain"] : []),
      "paste",
      "pin",
      "unpin",
      "delete",
      "preview",
      "menu",
      "toggle-multi",
    ],
    ...(item.valid ? {} : { disabled: true }),
  };
}

export function createClipboardPageService(deps: ClipboardPageDeps): {
  store: ClipboardStore;
  service: PageService;
  snapshot: () => PageModel;
  onKey: (event: KeyboardEvent, ctx: { editing: boolean; hasResults: boolean }) => boolean;
  openContextMenu: () => boolean;
  previewTarget: () => unknown;
  ready: () => boolean;
  modal: () => boolean;
  applySettings: (settings: unknown) => void;
} {
  const store = createClipboardStore(deps.services);
  let revision = 0;

  function snapshot(): PageModel {
    const all = store.clips();
    const start = Math.max(0, store.clipStart());
    const end = Math.min(all.length, Math.max(start + 1, store.clipEnd()));
    const visible = all.slice(start, end);
    const selected = store.selected();
    const multi = store.multiIds();
    const selectedIds = [...multi].map((id) => "clip:" + id);
    if (selectedIds.length === 0 && all[selected]) selectedIds.push(clipTargetId(all[selected]));
    const selectedId = all[selected] ? clipTargetId(all[selected]) : undefined;
    const categories: ClipboardCategory[] = CLIP_CATS.map((category) => ({
      id: category.kind,
      label: t(category.label),
      count: category.kind === "all"
        ? all.length
        : category.kind === "favorites"
          ? all.filter((item) => item.pinned).length
          : all.filter((item) => item.kind === category.kind).length,
    }));
    const model: ClipboardModel = {
      query: store.clipQuery(),
      categories,
      activeCategory: store.clipKind(),
      items: visible.map((item) => row(item, store.timeDisplayAbs(), store.showSourceApp())),
      total: all.length,
      window: { offset: start, limit: end - start },
      selectedIds,
      ...(selectedId ? { primaryId: selectedId } : {}),
      paused: store.clipPaused(),
      status: {
        total: all.length,
        selected: multi.size,
        text: multi.size > 0 ? t("clipSelected", { count: multi.size }) : t("clipTotal", { count: all.length }),
      },
      clearState: { open: store.clearOpen(), keepPinned: store.keepPinned() },
      showSourceApp: store.showSourceApp(),
      timeDisplay: store.timeDisplayAbs() ? "absolute" : "relative",
      hoverSelect: store.hoverSelect(),
      previewEnabled: store.previewEnabled(),
      emptyText: store.clipQuery() ? t("noResults") : t("noClipboardHistory"),
    };
    revision++;
    return {
      runtime: "lume.page/v1",
      schema: CLIPBOARD_SCHEMA,
      revision,
      status: !store.loaded() ? "loading" : all.length === 0 ? "empty" : "ready",
      data: model as unknown as JsonValue,
      selection: {
        ...(selectedId ? { primaryId: selectedId } : {}),
        selectedIds,
      },
      ...(() => {
        const preview = store.previewEnabled() ? clipPreviewTarget(all[selected], store.rememberChecks()) : null;
        if (!preview || !selectedId) return {};
        return {
          preview: {
            kind: preview.kind,
            targetId: selectedId,
            payload: preview as unknown as JsonValue,
          },
        };
      })(),
    };
  }

  function findItem(targetId?: string): { item: ClipboardItem; index: number } | null {
    if (!targetId?.startsWith("clip:")) return null;
    const id = Number(targetId.slice(5));
    const index = store.clips().findIndex((item) => item.id === id);
    return index >= 0 ? { item: store.clips()[index], index } : null;
  }

  async function onIntent(intent: PageIntent): Promise<IntentResult> {
    const found = findItem(intent.targetId);
    const action = intent.actionId ?? "";
    switch (intent.type) {
      case "selection.set": {
        const ids = (intent.payload as { selectedIds?: string[] } | undefined)?.selectedIds ?? [];
        const first = findItem(ids[0]);
        if (first) store.setSelected(first.index);
        return { status: "completed" };
      }
      case "selection.move": {
        const delta = Number((intent.payload as { delta?: number } | undefined)?.delta ?? 0);
        const max = Math.max(0, store.clips().length - 1);
        store.setSelected(Math.max(0, Math.min(max, store.selected() + delta)));
        return { status: "completed" };
      }
      case "item.activate":
      case "item.action": {
        if (!found) return { status: "failed", code: "target.missing", message: "Clipboard row is missing" };
        store.setSelected(found.index);
        switch (intent.type === "item.activate" ? "paste" : action) {
          case "copy": store.copyOnly(found.item); return { status: "completed" };
          case "copy-plain": store.copyPlain(found.item); return { status: "completed" };
          case "paste": store.pasteClip(found.item); return { status: "completed" };
          case "pin":
          case "unpin": await store.toggleClipPin(found.item); return { status: "completed" };
          case "delete": await store.deleteItem(found.item.id); return { status: "completed" };
          case "preview": return { status: "completed" };
          case "toggle-multi": store.toggleMulti(found.index); return { status: "completed" };
          case "menu": {
            const pos = (intent.payload as { x?: number; y?: number } | undefined) ?? {};
            deps.services.openMenu({ kind: "clip", x: Number(pos.x ?? window.innerWidth / 2), y: Number(pos.y ?? window.innerHeight / 2), item: found.item });
            return { status: "completed" };
          }
          default: return { status: "failed", code: "action.unsupported", message: action };
        }
      }
      case "category.select": {
        const kind = String((intent.payload as { kind?: string } | undefined)?.kind ?? "");
        if (CLIP_CATS.some((cat) => cat.kind === kind)) store.setClipKindAndSearch(kind as ClipKind);
        return { status: "completed" };
      }
      case "clear.open":
        store.setClearOpen(true);
        return { status: "completed" };
      case "clear.close":
        store.setClearOpen(false);
        return { status: "completed" };
      case "clear.keep-pinned":
        store.setKeepPinned(Boolean((intent.payload as { keepPinned?: boolean } | undefined)?.keepPinned));
        return { status: "completed" };
      case "clear.confirm":
        await store.doClear();
        return { status: "completed" };
      case "page.pause":
        store.toggleClipPause();
        return { status: "completed" };
      case "selection.clear":
        store.onEscape();
        return { status: "completed" };
      case "viewport.request": {
        const payload = intent.payload as { scrollTop?: number; viewportHeight?: number } | undefined;
        store.setClipScrollTop(Number(payload?.scrollTop ?? 0));
        const viewportHeight = Number(payload?.viewportHeight ?? 0);
        if (Number.isFinite(viewportHeight) && viewportHeight > 0) store.setClipViewportH(viewportHeight);
        return { status: "completed" };
      }
      case "query.submit": {
        const query = String((intent.payload as { query?: string } | undefined)?.query ?? "");
        store.setClipQuery(query);
        await store.search(query);
        return { status: "completed" };
      }
      case "page.escape":
        return { status: store.onEscape() ? "completed" : "accepted" };
      case "page.refresh": {
        await store.search(store.clipQuery());
        return { status: "completed" };
      }
      default:
        return { status: "accepted" };
    }
  }

  const service: PageService = {
    getModel: snapshot,
    onIntent,
    async onQuery(query) {
      store.setClipQuery(query);
      await store.search(query);
    },
    async onShow() { await store.search(store.clipQuery()); },
    onHide() {},
  };

  function onKey(event: KeyboardEvent, ctx: { editing: boolean; hasResults: boolean }): boolean {
    if (event.isComposing) return false;
    if (store.clearOpen()) {
      if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
      }
      return true;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (store.clipQuery() === "") {
        event.preventDefault();
        store.switchCategory(event.key === "ArrowLeft" ? -1 : 1);
        return true;
      }
      return false;
    }
    if (event.key === " " && !ctx.editing && ctx.hasResults) {
      event.preventDefault();
      store.toggleMulti(store.selected());
      return true;
    }
    if (event.key === "Delete" && !ctx.editing && ctx.hasResults) {
      event.preventDefault();
      void store.deleteSelected();
      return true;
    }
    return false;
  }

  function openContextMenu(): boolean {
    const item = store.clips()[store.selected()];
    if (!item) return false;
    const el = document.querySelector<HTMLElement>(".clip-row[aria-selected='true']");
    const rect = el?.getBoundingClientRect();
    deps.services.openMenu({
      kind: "clip",
      x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
      y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
      item,
    });
    return true;
  }

  return {
    store,
    service,
    snapshot,
    onKey,
    openContextMenu,
    previewTarget: () => store.clips()[store.selected()] ? {
      kind: store.clips()[store.selected()].kind,
      content: store.clips()[store.selected()].content,
      path: store.clips()[store.selected()].content,
      id: store.clips()[store.selected()].id,
      remember_checks: store.rememberChecks(),
    } : null,
    ready: store.loaded,
    modal: store.clearOpen,
    applySettings: (settings) => store.applySettings(settings as never),
  };
}
