//! Navigate contribution: a Page Service owns bars/search/actions, while the
//! selected built-in Presenter renders the shared lume.navigate/v1 model.

import { createEffect, createSignal, Show } from "solid-js";
import { t } from "../../i18n";
import navigateIcon from "../../../res/icons/navigate.svg";
import type { SettingsData } from "../../settings/types";
import { NAVIGATE_SCHEMA, type NavigateModel } from "../../page-runtime/schemas";
import { PageSession } from "../../page-runtime/session";
import type { PageIntent, PageModel, PresenterDescriptor } from "../../page-runtime/contracts";
import { pushDiagnostic } from "../../page-runtime/diagnostics";
import type { AppEntry } from "../../launcher/types";
import type { LauncherPlugin, ModeInstance, ModeKeyContext, PageRow, PluginServices } from "../types";
import { navBarPlugins, rememberPageModel } from "../registry";
import { createNavigatePageService } from "../../page-services/navigate/service";
import { NavigateGridPresenter } from "../../presenters/navigate-grid/NavigateGridPresenter";
import { NavigateListPresenter } from "../../presenters/navigate-list/NavigateListPresenter";

export const NAVIGATE_MODE_ID = "apps";

const NAVIGATE_PRESENTERS: PresenterDescriptor[] = [
  { id: "navigate-grid", name: "Grid", models: [NAVIGATE_SCHEMA], builtin: true },
  { id: "navigate-list", name: "List", models: [NAVIGATE_SCHEMA], builtin: true },
];

export interface NavigateHost {
  icons: { loadIcons(apps: AppEntry[]): Promise<void>; iconFor(path: string): string | undefined };
  barCols: () => number;
  invalidateWorkArea: () => void;
}

export function createNavigatePlugin(
  services: PluginServices,
  host: NavigateHost
): LauncherPlugin & { refreshBars(): Promise<void> } {
  const cfg = (window as any).__LUME_CONFIG__ as SettingsData | undefined;
  const [showRecent, setShowRecent] = createSignal(cfg?.appearance?.show_recent ?? true);
  const [showExplorerBar, setShowExplorerBar] = createSignal(cfg?.appearance?.show_explorer_bar ?? true);
  const [expandPinned, setExpandPinned] = createSignal(cfg?.appearance?.expand_pinned ?? false);
  const [placeholderApps, setPlaceholderApps] = createSignal(cfg?.appearance?.search_placeholder_apps || "");
  const [fullDriveSearch, setFullDriveSearch] = createSignal(cfg?.index?.full_drive_search ?? false);
  const [presenterId, setPresenterId] = createSignal(cfg?.pages?.presenters?.apps || "navigate-grid");
  const [model, setModel] = createSignal<PageModel>();

  const page = createNavigatePageService({
    services,
    showRecent,
    showExplorerBar,
    icons: host.icons,
    barCols: host.barCols,
    scheduleResize: () => services.scheduleResize(),
    invalidateWorkArea: host.invalidateWorkArea,
    placeholderApps,
    expandPinned,
    fullDriveSearch,
    navBarPlugins,
  });

  const session = new PageSession({
    pageId: NAVIGATE_MODE_ID,
    schema: NAVIGATE_SCHEMA,
    presenters: NAVIGATE_PRESENTERS,
    presenterId: presenterId(),
    onModel: (next) => { setModel(next); rememberPageModel(NAVIGATE_MODE_ID, next); },
  });
  void session.start(page.service);
  createEffect(() => {
    const next = page.snapshot();
    session.publish(next);
  });
  createEffect(() => pushDiagnostic("__presenterStates", { pageId: NAVIGATE_MODE_ID, presenterId: presenterId(), status: "ready" }));
  void page.store.refreshTermIcons();
  page.store.installDragReorder();

  const rows = (): PageRow[] => {
    const section = page.store.activeSection();
    return (section ? section.items : page.search.apps()) as unknown as PageRow[];
  };
  const selected = () => {
    const section = page.store.activeSection();
    return section ? section.selected() : page.search.selected();
  };

  const instance: ModeInstance = {
    query: page.search.appsQuery,
    setQuery: (q) => {
      // Mirror only. App.setQuery runs before handleQuery; provider drill
      // filters must get the keystroke before the normal search pipeline.
      page.search.setAppsQuery(q);
    },
    search: async (q) => {
      await session.setQuery(q);
      services.scheduleResize();
    },
    reset: () => {
      page.reset();
    },
    selected,
    setSelected: (index) => {
      const section = page.store.activeSection();
      if (section) section.setSelected(index);
      else page.search.setSelected(index);
      page.store.setNavHidden(false);
    },
    rows,
    activate: () => {
      const id = model()?.selection?.primaryId;
      if (id) void session.dispatch({ type: "item.activate", targetId: id });
    },
    handleQuery: page.search.handleQuery,
    onKey: (event: KeyboardEvent, ctx: ModeKeyContext) =>
      page.onKey(event, ctx, presenterId() === "navigate-list" ? "list" : "grid"),
    openContextMenu: page.openContextMenu,
    onEscape: () => page.search.popDrill(),
    // Navigate's fit height is data-driven (`page.store` / `search` schedule a
    // resize when rows change). Geometry commits must not schedule another
    // resize from here or the two paths form a hidden RAF feedback loop.
    measureViewport: () => {},
    heightPolicy: () => "fit",
    anyExpanded: page.store.anyExpanded,
    home: true,
    placeholder: () => placeholderApps() || t("searchApps"),
    pageKind: () => "all",
    restorePage: () => {},
    applySettings: (s) => {
      const next = s as SettingsData;
      const a = next.appearance;
      setShowRecent(a.show_recent);
      setShowExplorerBar(a.show_explorer_bar ?? true);
      setExpandPinned(a.expand_pinned || false);
      setPlaceholderApps(a.search_placeholder_apps || "");
      const nextFullDrive = next.index?.full_drive_search ?? false;
      const fullDriveChanged = nextFullDrive !== fullDriveSearch();
      setFullDriveSearch(nextFullDrive);
      if (fullDriveChanged && services.mode() === NAVIGATE_MODE_ID) {
        void services.runSearch(page.search.appsQuery());
      }
      const chosen = next.pages?.presenters?.apps;
      if (chosen && NAVIGATE_PRESENTERS.some((p) => p.id === chosen)) setPresenterId(chosen);
    },
    onShow: async () => { await session.show(); },
    onHide: async () => { await session.hide(); },
    onFilesDropped: (paths) => { void session.filesDropped(paths); },
    menuActions: () => ({
      ...page.store,
      activateEntry: (app: AppEntry) => page.search.activateEntry(app),
    }),
    snapshot: () => Promise.resolve({ pageRuntime: model() }),
    View: () => (
      <Show
        when={model()?.status === "error"}
        fallback={
          <Show
            when={presenterId() === "navigate-list"}
            fallback={
              <NavigateGridPresenter
                data={() => model()?.data as NavigateModel | undefined}
                selectedId={() => model()?.selection?.primaryId}
                barCols={host.barCols}
                iconFor={host.icons.iconFor}
                dispatch={(intent: { type: string; targetId?: string; actionId?: string; payload?: unknown }) => session.dispatch(intent as PageIntent)}
                markMouse={() => services.markMouse()}
                selectionSource={() => services.selectionSource()}
              />
            }
          >
            <NavigateListPresenter
              data={() => model()?.data as NavigateModel | undefined}
              selectedId={() => model()?.selection?.primaryId}
              barCols={host.barCols}
              iconFor={host.icons.iconFor}
              dispatch={(intent: { type: string; targetId?: string; actionId?: string; payload?: unknown }) => session.dispatch(intent as PageIntent)}
              markMouse={() => services.markMouse()}
              selectionSource={() => services.selectionSource()}
            />
          </Show>
        }
      >
        <div class="presenter-error" role="alert">
          <div class="presenter-error-title">{t("pageModelInvalid")}</div>
          <div class="presenter-error-detail">{t("pageModelInvalidHint")}</div>
          <Show when={model()?.error?.message}>
            <div class="presenter-error-detail">{model()?.error?.message}</div>
          </Show>
          <button class="presenter-error-retry" type="button" onClick={() => services.openSettings()}>
            {t("openSettings")}
          </button>
        </div>
      </Show>
    ),  };

  return {
    id: NAVIGATE_MODE_ID,
    modeMeta: { labelKey: "navigate", placeholderKey: "", icon: navigateIcon },
    mode: instance,
    refreshBars: page.refreshBars,
  };
}
