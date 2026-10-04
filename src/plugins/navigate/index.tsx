//! Navigate plugin — the built-in **home page** (mode contribution, id
//! "apps"). This is the launcher's own page below the search box, registered
//! through the same registry path as every plugin mode (固有组件插件化):
//! bars (最近使用 / 已固定 / plugin bars / Explorer), the merged search grid
//! and the page's own key handling. The id "apps" is persisted in
//! `appearance.last_page` and must never change.

import { createSignal } from "solid-js";
import { t } from "../../i18n";
import navigateIcon from "../../../res/icons/navigate.svg";
import type { SettingsData } from "../../settings/types";
import type { AppEntry, MenuState } from "../../launcher/types";
import type {
  LauncherPlugin,
  ModeInstance,
  ModeKeyContext,
  PluginServices,
} from "../types";
import { navBarPlugins } from "../registry";
import {
  createNavigateStore,
  GRID_ZONE,
  type ContributedBar,
  type NavigateStore,
} from "./store";
import { createNavigateSearch } from "./search";
import { NavigateView } from "./NavigateView";

/** The home page id — persisted as `appearance.last_page = "apps"`. */
export const NAVIGATE_MODE_ID = "apps";

/** Shell-side extras the home page needs (not part of PluginServices): the
 * icon pipeline, the sizer's measured bar column count and the work-area
 * invalidation on expand toggles. */
export interface NavigateHost {
  icons: {
    loadIcons(apps: AppEntry[]): Promise<void>;
    iconFor(path: string): string | undefined;
  };
  /** Measured column count of a bar grid (one row when collapsed). */
  barCols: () => number;
  /** An expand/collapse or bar-list change re-measures against the work area. */
  invalidateWorkArea: () => void;
}

export function createNavigatePlugin(
  services: PluginServices,
  host: NavigateHost
): LauncherPlugin & { refreshBars(): Promise<void> } {
  // ── Initial config (synchronous, injected by Rust before page load) ──
  const cfg = (window as any).__LUME_CONFIG__?.appearance;
  /** Settings-driven: show the 「最近使用」 bar (display-only toggle). */
  const [showRecent, setShowRecent] = createSignal(cfg?.show_recent ?? true);
  /** Settings-driven: show the 「Windows 资源管理器」 bar. */
  const [showExplorerBar, setShowExplorerBar] = createSignal(cfg?.show_explorer_bar ?? true);
  /** Settings-driven: start the 「已固定」 bar expanded. */
  const [expandPinned, setExpandPinned] = createSignal(cfg?.expand_pinned ?? false);
  /** Settings-driven: custom search placeholder ("" = default text). */
  const [placeholderApps, setPlaceholderApps] = createSignal(cfg?.search_placeholder_apps || "");

  const nav = createNavigateStore({
    showRecent,
    showExplorerBar,
    barCols: host.barCols,
    icons: host.icons,
    scheduleResize: () => services.scheduleResize(),
    invalidateWorkArea: host.invalidateWorkArea,
    openMenu: (m: MenuState) => {
      if (m) services.openMenu(m);
    },
    showToast: (text, opts) => services.showToast(text, opts),
    markEntryOpened: () => services.markEntryOpened(),
    resetAndHide: () => void services.resetAndHide(),
  });

  const search = createNavigateSearch({
    id: NAVIGATE_MODE_ID,
    services,
    nav,
    icons: host.icons,
  });

  /** Pull plugin-contributed Navigate bars (the `navBars` hook) into the
   * section registry. Runs on composition and whenever the plugin set
   * changes (启停 / reload). */
  async function refreshBars() {
    const contribs: ContributedBar[] = [];
    for (const p of navBarPlugins()) {
      try {
        const bars = await p.navBars();
        if (Array.isArray(bars)) contribs.push(...bars);
      } catch (err) {
        console.error("navBars failed:", p.id, err);
      }
    }
    nav.setPluginBars(contribs);
  }

  /** Summon-scoped refresh: bar data, the Explorer folder context and the
   * captured foreground window (feature rows), then auto-select the first
   * section of the empty-query main menu. */
  async function onShow() {
    await Promise.all([nav.refreshRecent(), nav.refreshPins()]);
    await refreshBars();
    await nav.refreshFolderCtx();
    search.fetchFgContext();
    // Auto-select the first entry of the empty-query main menu: the first
    // section in the registry (最近使用 when visible, else 已固定, else a
    // plugin bar, else the explorer bar). (The bars' highlight requires
    // `zoneActive`, so a resting zone of "grid" would leave nothing selected
    // on summon.)
    if (search.appsQuery() === "" && nav.zone() === GRID_ZONE) {
      const first = nav.sections()[0];
      if (first) nav.setZone(first.id);
    }
  }

  /** Page-owned keys: grid arrows while a query/feature rows are up, the
   * continuous section-grid navigation on the empty main menu. Enter and the
   * shared ↑/↓ fall through to the shell's generic bindings. */
  function onKey(e: KeyboardEvent, ctx: ModeKeyContext): boolean {
    // P2.2: a file drop / clipboard-image row set replaces the bars even on
    // an empty query — the grid keys (and selection) apply.
    const empty = search.appsQuery() === "" && !search.forceGrid();
    if (!empty) {
      // Grid navigation always wins when there is a query, regardless of
      // `zone` — the zone signal belongs to the bar view and may carry a
      // stale value from a prior empty-query interaction.
      if (!ctx.hasResults) return false;
      if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowRight" ||
        e.key === "ArrowDown" ||
        e.key === "ArrowUp"
      ) {
        e.preventDefault();
        ctx.markKeyboard();
        const delta =
          e.key === "ArrowLeft"
            ? -1
            : e.key === "ArrowRight"
              ? 1
              : e.key === "ArrowDown"
                ? ctx.gridCols()
                : -ctx.gridCols();
        ctx.moveSelection(delta);
        return true;
      }
      return false;
    }
    // ── empty-query bar navigation (the section registry, one continuous grid)
    if (nav.sections().length === 0) return false;
    if (
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowUp"
    ) {
      ctx.markKeyboard();
      e.preventDefault();
      nav.moveBarSelection(
        e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0,
        e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0
      );
      return true;
    }
    if (e.key === "Delete") {
      // Remove the selected entry of a section that supports it (最近使用's
      // soft delete). In the grid zone (typing) Delete falls through to text
      // editing in the search input.
      const sec = nav.activeSection();
      if (sec?.onDelete) {
        e.preventDefault();
        sec.onDelete(sec.selected());
        return true;
      }
    }
    return false;
  }

  function reset() {
    search.resetState();
    nav.setZone(GRID_ZONE);
    nav.resetSelections();
    nav.setRecentExpanded(false); // don't persist the expanded state across shows
    nav.setPinnedExpanded(expandPinned());
    nav.setNavHidden(false); // fresh show always starts with the nav box visible
  }

  const instance: ModeInstance = {
    query: search.appsQuery,
    setQuery: search.setAppsQuery,
    search: search.search,
    reset,
    selected: search.selected,
    setSelected: (i) => {
      search.setSelected(i);
      nav.setNavHidden(false); // arrow nav reveals the highlight
    },
    rows: search.apps,
    activate: search.activate,
    onKey,
    handleQuery: search.handleQuery,
    onEscape: () => search.popDrill(),
    previewTarget: () => null,
    previewEnabled: () => false,
    measureViewport: () => {},
    // The home page auto-fits its content (bars / grid); every other page
    // uses the fixed-height model below the search box.
    heightPolicy: () => "fit",
    anyExpanded: nav.anyExpanded,
    home: true,
    placeholder: () => placeholderApps() || t("searchApps"),
    pageKind: () => "all",
    restorePage: () => {},
    applySettings: (s) => {
      const a = (s as SettingsData).appearance;
      setShowRecent(a.show_recent);
      setShowExplorerBar(a.show_explorer_bar ?? true);
      setExpandPinned(a.expand_pinned || false);
      setPlaceholderApps(a.search_placeholder_apps || "");
    },
    onShow,
    onFilesDropped: search.onFilesDropped,
    // The shared context menu's app/folder actions (the store satisfies the
    // narrow `NavMenuActions` interface menu.ts declares).
    menuActions: () => nav as unknown,
    View: () => (
      <NavigateView
        apps={search.apps}
        appsQuery={search.appsQuery}
        selected={search.selected}
        nav={nav as NavigateStore}
        barCols={host.barCols}
        iconFor={host.icons.iconFor}
        activate={() => search.activate()}
        markMouse={() => services.markMouse()}
        openMenu={(m) => {
          if (m) services.openMenu(m);
        }}
        setSelected={search.setSelected}
        forceGrid={search.forceGrid}
      />
    ),
  };

  // Terminal icons for the Explorer bar tiles and the pointer listeners for
  // pinned-bar reordering (window-lifetime document listeners).
  void nav.refreshTermIcons();
  nav.installDragReorder();

  return {
    id: NAVIGATE_MODE_ID,
    modeMeta: {
      labelKey: "navigate",
      placeholderKey: "",
      icon: navigateIcon,
    },
    mode: instance,
    refreshBars,
  };
}
