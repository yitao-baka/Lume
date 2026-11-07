//! Navigate Page Service — owns bars, merged search, actions and the stable
//! lume.navigate/v1 snapshot consumed by every Presenter.

import { isSyntheticAppEntry, type AppEntry, type MenuState, type PluginIconSpec } from "../../launcher/types";
import type { IntentResult, JsonValue, PageIntent, PageModel, PageService, ResourceRef } from "../../page-runtime/contracts";
import { NAVIGATE_SCHEMA, type NavigateItem, type NavigateModel, type NavigateSection } from "../../page-runtime/schemas";
import type { ModeKeyContext, PluginServices } from "../../plugins/types";
import { createNavigateStore, GRID_ZONE, type ContributedBar, type NavItem, type NavSection, type NavigateStore } from "../../plugins/navigate/store";
import { createNavigateSearch, type NavigateSearch } from "../../plugins/navigate/search";
import { fitNavBarPageBudget } from "../../plugins/contributionBudget";
import { plog } from "../../plugins/log";
import { pushBoundedDiagnostic } from "../../page-runtime/diagnostics";

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
  fullDriveSearch: () => boolean;
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
  const src = icon.light || icon.dark || icon.legacy;
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
  if (section.id === "recommended") return ["open", "menu"];
  return ["open", "open-as-admin", "reveal", "pin", "unpin", "remove-recent", "menu"];
}

/** Stable short target id. Full paths stay in the model's `path` field; the
 * Intent Router only needs an opaque key below its 256-character limit. */
function targetId(kind: string, key: string, index: number, used: Set<string>): string {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const base = `${kind}:${(hash >>> 0).toString(36)}:${index.toString(36)}`;
  let id = base;
  let salt = 0;
  while (used.has(id)) id = `${base}:${(++salt).toString(36)}`;
  used.add(id);
  return id;
}

function asAppEntry(item: NavItem): AppEntry {
  return {
    id: item.id,
    name: item.name,
    path: item.path,
    ...(item.icon ? { icon: item.icon } : {}),
    ...(item.rowKind ? { rowKind: item.rowKind } : {}),
    ...(item.providerEnter ? { providerEnter: item.providerEnter } : {}),
    ...(item.providerDrill ? { providerDrill: item.providerDrill } : {}),
    ...(item.featureEnter ? { featureEnter: item.featureEnter } : {}),
  };
}

function resultActionList(app: AppEntry): string[] {
  return isSyntheticAppEntry(app) ? ["open", "menu"] : ["open", "open-as-admin", "reveal", "pin", "unpin", "menu"];
}

export function createNavigatePageService(deps: NavigatePageDeps): {
  store: NavigateStore;
  search: NavigateSearch;
  service: PageService;
  snapshot: () => PageModel;
  refreshBars: () => Promise<void>;
  onShow: () => Promise<void>;
  reset: () => void;
  onKey: (e: KeyboardEvent, ctx: ModeKeyContext, layout?: "grid" | "list") => boolean;
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
    fullDriveSearch: deps.fullDriveSearch,
  });

  let revision = 0;
  let barsRefreshSeq = 0;
  const targets = new Map<string, NavigateTarget>();

  async function refreshBars(): Promise<void> {
    const seq = ++barsRefreshSeq;
    const results = await Promise.allSettled(
      deps.navBarPlugins().map(async (p) => ({ id: p.id, bars: await p.navBars() }))
    );
    const contribs: ContributedBar[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (Array.isArray(result.value.bars)) contribs.push(...result.value.bars);
      } else {
        console.error("navBars failed:", result.reason);
      }
    }
    const budgeted = fitNavBarPageBudget(contribs);
    if (budgeted.droppedRows || budgeted.droppedItems || budgeted.truncated) {
      plog.warn(
        "apps",
        `navBars page budget applied: bars=${budgeted.droppedRows} items=${budgeted.droppedItems}` +
          (budgeted.truncated ? " (truncated)" : "")
      );
    }
    const applied = seq === barsRefreshSeq;
    pushBoundedDiagnostic(
      "__navBarsProbe",
      { seq, ids: budgeted.value.map((bar) => bar.id), applied },
      40,
      32 * 1024,
    );
    if (applied) nav.setPluginBars(budgeted.value);
  }

  function snapshot(): PageModel {
    targets.clear();
    const usedTargetIds = new Set<string>();
    const barIds = new Map<string, string>();
    const sections: NavigateSection[] = nav.sections().map((section) => {
      const items = section.items.map((item, index) => {
        const id = targetId("bar", `${section.id}\u0000${item.id}\u0000${item.path}`, index, usedTargetIds);
        barIds.set(`${section.id}:${index}`, id);
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
    const resultIds: string[] = [];
    const results = search.apps().map((app, index) => {
      const id = targetId("result", `${app.path || app.name}\u0000${app.name}`, index, usedTargetIds);
      resultIds[index] = id;
      targets.set(id, { kind: "result", index, app });
      const source = app.rowKind === "provider-enter" || app.rowKind === "provider-drill"
        ? "provider" as const
        : app.rowKind === "feature" || app.rowKind === "mode"
          ? "feature" as const
          : "app" as const;
      return {
        id,
        label: app.name,
        path: app.path,
        source,
        actions: resultActionList(app),
        ...(iconRef(app.icon) ? { icon: iconRef(app.icon) } : {}),
      } satisfies NavigateItem;
    });
    const section = nav.activeSection();
    const query = search.appsQuery();
    const selectedId =
      section?.items[section.selected()]
        ? barIds.get(`${section.id}:${section.selected()}`)
        : resultIds[search.selected()];
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
      search.invalidateAsync();
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
          const app = targetApp(target);
          if (app && isSyntheticAppEntry(app) &&
              (intent.actionId === "reveal" || intent.actionId === "pin" ||
               intent.actionId === "unpin" || intent.actionId === "remove-recent" ||
               intent.actionId === "open-as-admin")) {
            return { status: "failed", code: "action.unsupported", message: "Synthetic rows only support activation" };
          }
          if (intent.actionId === "open" || intent.actionId === "activate") {
            await activateTarget(target);
            return { status: "completed" };
          }
          if (intent.actionId === "open-as-admin") {
            await activateTarget(target, true);
            return { status: "completed" };
          }
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
          const clientX = Number(payload.clientX ?? 0);
          const clientY = Number(payload.clientY ?? 0);
          const source = document
            .elementFromPoint(clientX, clientY)
            ?.closest<HTMLElement>(".result-box, .nav-list-row") ?? null;
          nav.beginDrag(payload.sectionId, Number(payload.from), {
            clientX,
            clientY,
            currentTarget: source,
          } as unknown as PointerEvent);
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

  /** Flatten the rows the compact list actually paints. A collapsed section
   * contributes only its first row in list form (the grid contributes one
   * column-wide row instead). */
  function moveListSelection(delta: number): boolean {
    const query = search.appsQuery();
    if (query !== "") {
      const items = search.apps();
      if (items.length === 0) return false;
      const next = Math.max(0, Math.min(items.length - 1, search.selected() + delta));
      search.setSelected(next);
      nav.setZone(GRID_ZONE);
      return true;
    }

    const rows: { section: NavSection; index: number; item: NavItem }[] = [];
    for (const section of nav.sections()) {
      const limit = section.expandable && !section.expanded() ? Math.min(1, section.items.length) : section.items.length;
      for (let index = 0; index < limit; index++) {
        const item = section.items[index];
        if (item) rows.push({ section, index, item });
      }
    }
    if (rows.length === 0) return false;
    const current = rows.findIndex((row) => row.section.id === nav.zone() && row.index === row.section.selected());
    const next = current < 0
      ? (delta > 0 ? 0 : rows.length - 1)
      : Math.max(0, Math.min(rows.length - 1, current + delta));
    const target = rows[next];
    selectTarget({ kind: "bar", section: target.section, index: target.index, item: target.item });
    return true;
  }

  function onKey(e: KeyboardEvent, ctx: ModeKeyContext, layout: "grid" | "list" = "grid"): boolean {
    if (e.isComposing) return false;
    const empty = search.appsQuery() === "";
    const vertical = e.key === "ArrowUp" || e.key === "ArrowDown";
    const horizontal = e.key === "ArrowLeft" || e.key === "ArrowRight";
    const arrow = vertical || horizontal;
    if (arrow) {
      if (!empty) {
        if (!ctx.hasResults) return false;
        // In list form left/right belongs to the search caret; up/down walks
        // the flat result list. The grid keeps the original two-dimensional
        // movement across every result and plugin-appended row.
        if (layout === "list" && horizontal) return false;
        e.preventDefault();
        ctx.markKeyboard();
        if (layout === "list") return moveListSelection(vertical ? (e.key === "ArrowDown" ? 1 : -1) : 0);
        const delta = e.key === "ArrowLeft"
          ? -1
          : e.key === "ArrowRight"
            ? 1
            : e.key === "ArrowDown"
              ? ctx.gridCols()
              : -ctx.gridCols();
        ctx.moveSelection(delta);
        return true;
      }
      if (nav.sections().length === 0) return false;
      if (layout === "list" && horizontal) return false;
      e.preventDefault();
      ctx.markKeyboard();
      if (layout === "list") return moveListSelection(e.key === "ArrowDown" ? 1 : -1);
      nav.moveBarSelection(
        e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0,
        e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
      );
      return true;
    }
    if (e.key === "Enter") {
      if (ctx.hasResults) {
        e.preventDefault();
        const section = nav.activeSection();
        if (section) {
          const index = layout === "list" && section.expandable && !section.expanded()
            ? 0
            : nav.activateIndex(section);
          const item = section.items[index];
          if (item) void activateTarget({ kind: "bar", section, index, item });
        } else {
          const item = search.apps()[search.selected()];
          if (item) void activateTarget({ kind: "result", index: search.selected(), app: item });
        }
        return true;
      }
      return false;
    }
    if (e.key === "Delete" && !ctx.editing) {
      const section = nav.activeSection();
      if (section?.onDelete) {
        e.preventDefault();
        const index = layout === "list" && section.expandable && !section.expanded() ? 0 : section.selected();
        section.onDelete(index);
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
    const activeIndex = section ? nav.activateIndex(section) : search.selected();
    const targetId = [...targets.entries()].find(([, target]) =>
      section
        ? target.kind === "bar" && target.section.id === section.id && target.index === activeIndex
        : target.kind === "result" && target.index === activeIndex
    )?.[0];
    if (!targetId) return false;
    const host = document.querySelector(".mode-host.active") ?? document;
    const anchor = [...host.querySelectorAll<HTMLElement>("[data-target-id]")]
      .find((el) => el.dataset.targetId === targetId);
    const rect = anchor?.getBoundingClientRect();
    void service.onIntent?.({
      type: "item.action",
      targetId,
      actionId: "menu",
      payload: {
        x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
        y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
      },
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
