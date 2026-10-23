//! Navigate Page Service — owns bars, merged search, actions and the stable
//! lume.navigate/v1 snapshot consumed by every Presenter.

import type { AppEntry, MenuState, PluginIconSpec } from "../../launcher/types";
import type { IntentResult, JsonValue, PageIntent, PageModel, PageService, ResourceRef } from "../../page-runtime/contracts";
import { NAVIGATE_SCHEMA, type NavigateItem, type NavigateModel, type NavigateSection } from "../../page-runtime/schemas";
import type { PluginServices } from "../../plugins/types";
import { createNavigateStore, GRID_ZONE, type ContributedBar, type NavItem, type NavSection, type NavigateStore } from "../../plugins/navigate/store";
import { createNavigateSearch, type NavigateSearch } from "../../plugins/navigate/search";

export interface NavigatePageDeps {
  services: PluginServices;
  showRecent: () => boolean;
  showExplorerBar: () => boolean;
  icons: {
    loadIcons(apps: AppEntry[]): Promise<void>;
    iconFor(path: string): string | undefined;
  };
  barCols: () => number;
  scheduleResize: () => void;
  invalidateWorkArea: () => void;
  placeholderApps: () => string;
  expandPinned: () => boolean;
  navBarPlugins: () => { id: string; navBars: () => Promise<ContributedBar[]> | ContributedBar[] }[];
}

interface BarTarget {
  kind: "bar";
  section: NavSection;
  index: number;
  item: NavItem;
}
interface ResultTarget {
  kind: "result";
  index: number;
  app: AppEntry;
}
type NavigateTarget = BarTarget | ResultTarget;

function iconRef(icon: string | PluginIconSpec | undefined): ResourceRef | undefined {
  if (!icon) return undefined;
  if (typeof icon === "string") return { kind: "url", src: icon };
  const src = icon.light || icon.dark;
  if (!src) return undefined;
  return {
    kind: "url",
    src,
    ...(icon.light ? { light: icon.light } : {}),
    ...(icon.dark ? { dark: icon.dark } : {}),
  };
}

function barActionList(section: NavSection): string[] {
  if (section.id === "folder") return ["activate", "menu"];
  return ["open", "open-as-admin", "reveal", "pin", "unpin", "remove-recent", "menu"];
}

function itemId(sectionId: string, item: NavItem, index: number): string {
  return "bar:" + sectionId + ":" + index + ":" + item.id;
}

function resultId(app: AppEntry, index: number): string {
  return "result:" + (app.path || app.name) + ":" + index;
}

function asAppEntry(item: NavItem): AppEntry {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    ...(item.icon ? { icon: item.icon } : {}),
  };
}

export function createNavigatePageService(deps: NavigatePageDeps): {
  store: NavigateStore;
  search: NavigateSearch;
  service: PageService;
  snapshot: () => PageModel;
  refreshBars: () => Promise<void>;
  onShow: () => Promise<void>;
  reset: () => void;
  onKey: (e: KeyboardEvent, ctx: { editing: boolean; hasResults: boolean }) => boolean;
  openContextMenu: () => boolean;
  applySettings: (s: unknown) => void;
} {
  const nav = createNavigateStore({
    showRecent: deps.showRecent,
    showExplorerBar: deps.showExplorerBar,
    barCols: deps.barCols,
    icons: deps.icons,
    scheduleResize: deps.scheduleResize,
    invalidateWorkArea: deps.invalidateWorkArea,
    openMenu: (m: MenuState) => { if (m) deps.services.openMenu(m); },
    showToast: (text, opts) => deps.services.showToast(text, opts),
    markEntryOpened: deps.services.markEntryOpened,
    resetAndHide: () => void deps.services.resetAndHide(),
  });
  const search = createNavigateSearch({
    id: "apps",
    services: deps.services,
    nav,
    icons: deps.icons,
  });

  let revision = 0;
  const targets = new Map<string, NavigateTarget>();

  async function refreshBars(): Promise<void> {
    const contribs: ContributedBar[] = [];
    for (const p of deps.navBarPlugins()) {
      try {
        const bars = await p.navBars();
        if (Array.isArray(bars)) contribs.push(...bars);
      } catch (err) {
        console.error("navBars failed:", p.id, err);
      }
    }
    nav.setPluginBars(contribs);
  }

  function snapshot(): PageModel {
    targets.clear();
    const sections: NavigateSection[] = nav.sections().map((section) => {
      const items = section.items.map((item, index) => {
        const id = itemId(section.id, item, index);
        targets.set(id, { kind: "bar", section, index, item });
        return {
          id,
          label: item.name,
          path: item.path,
          source: section.id === "folder" ? "explorer" as const : "app" as const,
          actions: barActionList(section),
          ...(iconRef(item.icon) ? { icon: iconRef(item.icon) } : {}),
          ...(item.mono ? { mono: true } : {}),
        } satisfies NavigateItem;
      });
      return {
        id: section.id,
        title: section.title,
        items,
        actions: ["toggle", "reorder"],
        expandable: section.expandable,
        expanded: section.expanded(),
        selectedIndex: section.selected(),
        ...(section.draggable ? { draggable: true } : {}),
        ...(section.wrap ? { wrap: true } : {}),
      };
    });
    const results = search.apps().map((app, index) => {
      const id = resultId(app, index);
      targets.set(id, { kind: "result", index, app });
      return {
        id,
        label: app.name,
        path: app.path,
        source: app.providerEnter ? "provider" as const : app.providerDrill ? "feature" as const : "app" as const,
        actions: ["open", "open-as-admin", "reveal", "pin", "unpin", "menu"],
        ...(iconRef(app.icon) ? { icon: iconRef(app.icon) } : {}),
      } satisfies NavigateItem;
    });
    const section = nav.activeSection();
    const query = search.appsQuery();
    const selectedId =
      section?.items[section.selected()]
        ? itemId(section.id, section.items[section.selected()], section.selected())
        : results[search.selected()]?.id;
    const data: NavigateModel = {
      query,
      sections,
      results: { items: results, pluginStart: search.pluginStart(), total: results.length },
      ...(section ? { selectedSectionId: section.id } : {}),
      navHidden: nav.navHidden(),
      emptyText: query ? "" : "",
    };
    revision++;
    return {
      runtime: "lume.page/v1",
      schema: NAVIGATE_SCHEMA,
      revision,
      status: query && results.length === 0 ? "empty" : "ready",
      data: data as unknown as JsonValue,
      selection: {
        ...(selectedId ? { primaryId: selectedId } : {}),
        ...(selectedId ? { selectedIds: [selectedId] } : {}),
      },
      actions: [
        { id: "open", label: "Open", kind: "default" },
        { id: "open-as-admin", label: "Open as administrator" },
        { id: "reveal", label: "Open location" },
        { id: "pin", label: "Pin" },
        { id: "unpin", label: "Unpin" },
        { id: "remove-recent", label: "Remove from recent" },
        { id: "menu", label: "More actions" },
      ],
    };
  }

  function selectTarget(target: NavigateTarget): void {
    if (target.kind === "bar") {
      nav.setZone(target.section.id);
      target.section.setSelected(target.index);
    } else {
      nav.setZone(GRID_ZONE);
      search.setSelected(target.index);
    }
  }

  async function activateTarget(target: NavigateTarget, elevated = false): Promise<void> {
    selectTarget(target);
    if (target.kind === "bar" && target.section.id === "folder") {
      target.section.activate(target.index, elevated);
      return;
    }
    search.activate({ elevated });
  }

  function targetApp(target: NavigateTarget): AppEntry | null {
    if (target.kind === "result") return target.app;
    if (target.section.id === "folder") return null;
    return asAppEntry(target.item);
  }

  const service: PageService = {
    getModel: snapshot,
    async onQuery(query) {
      search.setAppsQuery(query);
      await search.search(query);
    },
    async onShow() { await onShow(); },
    onHide() {
      deps.services.markMouse();
    },
    async onFilesDropped(paths) { search.onFilesDropped(paths); },
    async onIntent(intent: PageIntent): Promise<IntentResult> {
      const target = intent.targetId ? targets.get(intent.targetId) : undefined;
      switch (intent.type) {
        case "selection.set": {
          const ids = (intent.payload as { selectedIds?: string[] } | undefined)?.selectedIds ?? [];
          const next = ids[0] ? targets.get(ids[0]) : undefined;
          if (next) selectTarget(next);
          return { status: "completed" };
        }
        case "selection.move": {
          const delta = Number((intent.payload as { delta?: number } | undefined)?.delta ?? 0);
          const section = nav.activeSection();
          if (section) {
            const next = Math.max(0, Math.min(section.items.length - 1, section.selected() + delta));
            section.setSelected(next);
          } else {
            const max = Math.max(0, search.apps().length - 1);
            search.setSelected(Math.max(0, Math.min(max, search.selected() + delta)));
          }
          return { status: "completed" };
        }
        case "item.activate":
          if (!target) return { status: "failed", code: "target.missing", message: "Target is missing" };
          await activateTarget(target);
          return { status: "completed" };
        case "item.action": {
          if (!target) return { status: "failed", code: "target.missing", message: "Target is missing" };
          if (intent.actionId === "open" || intent.actionId === "activate") {
            await activateTarget(target);
            return { status: "completed" };
          }
          if (intent.actionId === "open-as-admin") {
            await activateTarget(target, true);
            return { status: "completed" };
          }
          const app = targetApp(target);
          if (intent.actionId === "reveal" && app) {
            nav.revealInFolder(app);
            return { status: "completed" };
          }
          if ((intent.actionId === "pin" || intent.actionId === "unpin") && app) {
            await nav.toggleAppPin(app);
            return { status: "completed" };
          }
          if (intent.actionId === "remove-recent" && app) {
            await nav.deleteRecent(app);
            return { status: "completed" };
          }
          if (intent.actionId === "menu") {
            const pos = (intent.payload as { x?: number; y?: number } | undefined) ?? {};
            selectTarget(target);
            if (target.kind === "bar") {
              deps.services.openMenu({
                kind: target.section.id === "folder" ? "folder" : "app",
                x: Number(pos.x ?? window.innerWidth / 2),
                y: Number(pos.y ?? window.innerHeight / 2),
                idx: target.index,
                ...(target.section.id === "folder"
                  ? {}
                  : { app: asAppEntry(target.item), fromRecent: target.section.id === "recent" }),
              });
            } else {
              deps.services.openMenu({
                kind: "app",
                x: Number(pos.x ?? window.innerWidth / 2),
                y: Number(pos.y ?? window.innerHeight / 2),
                app: target.app,
              });
            }
            return { status: "completed" };
          }
          return { status: "failed", code: "action.unsupported", message: String(intent.actionId) };
        }
        case "section.toggle": {
          const section = intent.targetId ? nav.sectionById(intent.targetId) : undefined;
          section?.toggleExpanded();
          return { status: section ? "completed" : "failed" };
        }
        case "section.reorder.start": {
          const payload = intent.payload as { sectionId?: string; from?: number; clientX?: number; clientY?: number } | undefined;
          if (!payload?.sectionId || !Number.isInteger(payload.from)) {
            return { status: "failed", code: "reorder.invalid", message: "Invalid reorder start" };
          }
          nav.beginDrag(payload.sectionId, Number(payload.from), {
            clientX: Number(payload.clientX ?? 0),
            clientY: Number(payload.clientY ?? 0),
          } as PointerEvent);
          return { status: "accepted" };
        }
        case "section.reorder": {
          const payload = intent.payload as { sectionId?: string; from?: number; to?: number } | undefined;
          const section = payload?.sectionId ? nav.sectionById(payload.sectionId) : undefined;
          if (section?.onReorder && Number.isInteger(payload?.from) && Number.isInteger(payload?.to)) {
            section.onReorder(Number(payload!.from), Number(payload!.to));
            return { status: "completed" };
          }
          return { status: "failed", code: "reorder.invalid", message: "Invalid reorder request" };
        }
        case "query.submit": {
          const query = String((intent.payload as { query?: string } | undefined)?.query ?? "");
          search.setAppsQuery(query);
          await search.search(query);
          return { status: "completed" };
        }
        case "page.refresh":
          await nav.refreshRecent();
          await nav.refreshPins();
          await refreshBars();
          await nav.refreshFolderCtx();
          await search.search(search.appsQuery());
          return { status: "completed" };
        case "page.escape":
          return { status: search.popDrill() ? "completed" : "accepted" };
        case "viewport.request":
          deps.scheduleResize();
          return { status: "completed" };
        default:
          return { status: "accepted" };
      }
    },
  };

  async function onShow(): Promise<void> {
    await Promise.all([nav.refreshRecent(), nav.refreshPins()]);
    await refreshBars();
    await nav.refreshFolderCtx();
    search.fetchFgContext();
    if (search.appsQuery() === "" && nav.zone() === GRID_ZONE) {
      const first = nav.sections()[0];
      if (first) nav.setZone(first.id);
    }
  }

  function reset(): void {
    search.resetState();
    nav.setZone(GRID_ZONE);
    nav.resetSelections();
    nav.setRecentExpanded(false);
    nav.setPinnedExpanded(deps.expandPinned());
    nav.setRecommendedExpanded(false);
    nav.setNavHidden(false);
  }

  function onKey(e: KeyboardEvent, ctx: { editing: boolean; hasResults: boolean }): boolean {
    if (e.isComposing) return false;
    if (e.key === "Enter") {
      if (ctx.hasResults) {
        e.preventDefault();
        void activateTarget(
          nav.activeSection()
            ? { kind: "bar", section: nav.activeSection()!, index: nav.activateIndex(nav.activeSection()!), item: nav.activeSection()!.items[nav.activateIndex(nav.activeSection()!)] }
            : { kind: "result", index: search.selected(), app: search.apps()[search.selected()] }
        );
        return true;
      }
      return false;
    }
    if (e.key === "Delete" && !ctx.editing) {
      const section = nav.activeSection();
      if (section?.onDelete) {
        e.preventDefault();
        section.onDelete(section.selected());
        return true;
      }
    }
    return false;
  }

  function openContextMenu(): boolean {
    const section = nav.activeSection() ?? (search.appsQuery() === "" ? nav.sections()[0] : undefined);
    if (section) {
      const index = nav.activateIndex(section);
      if (index < 0) return false;
      const item = section.items[index];
      if (!item) return false;
      selectTarget({ kind: "bar", section, index, item });
    } else if (!search.apps()[search.selected()]) return false;
    void deps.services;
    void service.onIntent?.({
      type: "item.action",
      targetId: section
        ? itemId(section.id, section.items[nav.activateIndex(section)], nav.activateIndex(section))
        : resultId(search.apps()[search.selected()], search.selected()),
      actionId: "menu",
      payload: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
    });
    return true;
  }

  return {
    store: nav,
    search,
    service,
    snapshot,
    refreshBars,
    onShow,
    reset,
    onKey,
    openContextMenu,
    applySettings: () => {},
  };
}
