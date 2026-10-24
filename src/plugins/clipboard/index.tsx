//! Clipboard contribution: Rust-backed ClipboardStore is owned by the Page
//! Service; default and compact Presenters consume lume.clipboard/v1.

import { createEffect, createSignal, Show } from "solid-js";
import clipboardIconUrl from "../../../res/icons/clipboard.svg";
import type { SettingsData } from "../../settings/types";
import { CLIPBOARD_SCHEMA, type ClipboardModel } from "../../page-runtime/schemas";
import { PageSession } from "../../page-runtime/session";
import type { PageIntent, PageModel, PresenterDescriptor } from "../../page-runtime/contracts";
import { pushDiagnostic } from "../../page-runtime/diagnostics";
import type { LauncherPlugin, ModeInstance, ModeKeyContext, PageRow, PluginServices } from "../types";
import { createClipboardPageService } from "../../page-services/clipboard/service";
import { rememberPageModel } from "../registry";
import { ClipboardListPresenter } from "../../presenters/clipboard-list/ClipboardListPresenter";
import { ClipboardCompactPresenter } from "../../presenters/clipboard-compact/ClipboardCompactPresenter";

const CLIPBOARD_PRESENTERS: PresenterDescriptor[] = [
  { id: "clipboard-list", name: "History list", models: [CLIPBOARD_SCHEMA], builtin: true },
  { id: "clipboard-compact", name: "Compact history", models: [CLIPBOARD_SCHEMA], builtin: true },
];

export function createClipboardPlugin(services: PluginServices): LauncherPlugin {
  const cfg = (window as any).__LUME_CONFIG__ as SettingsData | undefined;
  const [presenterId, setPresenterId] = createSignal(cfg?.pages?.presenters?.clipboard || "clipboard-list");
  const [model, setModel] = createSignal<PageModel>();
  const page = createClipboardPageService({ services });
  const session = new PageSession({
    pageId: "clipboard",
    schema: CLIPBOARD_SCHEMA,
    presenters: CLIPBOARD_PRESENTERS,
    presenterId: presenterId(),
    onModel: (next) => { setModel(next); rememberPageModel("clipboard", next); },
  });
  void session.start(page.service);
  createEffect(() => session.publish(page.snapshot()));
  createEffect(() => pushDiagnostic("__presenterStates", { pageId: "clipboard", presenterId: presenterId(), status: "ready" }));

  const instance: ModeInstance = {
    query: page.store.clipQuery,
    setQuery: (query) => { page.store.setClipQuery(query); },
    search: async (query) => { await session.setQuery(query); },
    reset: page.store.reset,
    selected: page.store.selected,
    setSelected: page.store.setSelected,
    rows: () => page.store.clips() as PageRow[],
    activate: () => {
      const id = model()?.selection?.primaryId;
      if (id) void session.dispatch({ type: "item.activate", targetId: id });
    },
    onKey: (event: KeyboardEvent, ctx: ModeKeyContext) => page.onKey(event, ctx),
    openContextMenu: page.openContextMenu,
    onEscape: page.store.onEscape,
    modal: page.modal,
    previewTarget: () => (model()?.preview?.payload as never) ?? null,
    previewEnabled: page.store.previewEnabled,
    measureViewport: page.store.measureViewport,
    ready: page.ready,
    placeholder: page.store.placeholder,
    pageKind: page.store.pageKind,
    restorePage: page.store.restorePage,
    applySettings: (settings) => {
      page.applySettings(settings);
      const chosen = (settings as SettingsData).pages?.presenters?.clipboard;
      if (chosen && CLIPBOARD_PRESENTERS.some((p) => p.id === chosen)) setPresenterId(chosen);
    },
    onShow: async () => { await session.show(); },
    menuActions: () => page.store as unknown,
    snapshot: () => Promise.resolve({ pageRuntime: model() }),
    View: () => (
      <Show
        when={presenterId() === "clipboard-compact"}
        fallback={
          <ClipboardListPresenter
            data={() => model()?.data as ClipboardModel | undefined}
            selectedId={() => model()?.selection?.primaryId}
            dispatch={(intent: { type: string; targetId?: string; actionId?: string; payload?: unknown }) => session.dispatch(intent as PageIntent)}
            markMouse={() => services.markMouse()}
            selectionSource={() => services.selectionSource()}
          />
        }
      >
        <ClipboardCompactPresenter
          data={() => model()?.data as ClipboardModel | undefined}
          selectedId={() => model()?.selection?.primaryId}
          dispatch={(intent: { type: string; targetId?: string; actionId?: string; payload?: unknown }) => session.dispatch(intent as PageIntent)}
          markMouse={() => services.markMouse()}
          selectionSource={() => services.selectionSource()}
        />
      </Show>
    ),
  };

  return {
    id: "clipboard",
    modeMeta: {
      labelKey: "clipboard",
      placeholderKey: "placeholderClipboard",
      icon: clipboardIconUrl,
    },
    mode: instance,
  };
}
