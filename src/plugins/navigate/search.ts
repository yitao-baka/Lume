//! Navigate home-page search — the merge pipeline behind the home page's grid
//! (native index → 全局关键字 rows → declarative feature rows → file-search
//! hits → plugin providers), the summon-scoped feature-row state (OS file
//! drops, the clipboard image, the captured foreground window) that feeds the
//! empty-query 「推荐使用」 section, and the provider drill-down. Lived in the
//! composition root until the navigate page became a built-in plugin.

import { createEffect, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { plog } from "../log";
import type { AppEntry, FileSearchOut } from "../../launcher/types";
import type {
  ForegroundInfo,
  PluginIconSpec,
  PluginServices,
  ProviderInstance,
  ProviderResult,
} from "../types";
import type { FeatureMatch } from "../registry";
import {
  featureMatches,
  fileFeatureMatches,
  hasWindowFeatures,
  imgFeatureMatches,
  modeKeywordMatches,
  providerPlugins,
  resolvePluginIcon,
  windowFeatureMatches,
} from "../registry";
import type { NavigateStore } from "./store";

export interface NavigateSearchDeps {
  /** This page's own mode id ("apps") — activity checks against `services.mode()`. */
  id: string;
  services: PluginServices;
  nav: NavigateStore;
  icons: { loadIcons(apps: AppEntry[]): Promise<void> };
}

export function createNavigateSearch(deps: NavigateSearchDeps) {
  const { services, nav } = deps;

  const [appsQuery, setAppsQuery] = createSignal("");
  const [apps, setApps] = createSignal<AppEntry[]>([]);
  /** Boundary in `apps`: rows from this index on are plugin-appended and
   * render in the 「推荐使用」 block below the normal results (#43). */
  const [pluginStart, setPluginStart] = createSignal(0);
  const [selected, setSelected] = createSignal(0);
  // — plugin entry rows for OS file drops (paths arrive via the Tauri
  // drag-drop handler) and for the clipboard image. Cleared on hide/summon.
  // `droppedFileKinds` runs parallel to `droppedFiles` (docs/ROADMAP_HISTORY.md #28):
  // "file" | "folder" | "missing" per path, so `fileType` rules can tell a
  // directory from a file with one attributes query per drop.
  const [droppedFiles, setDroppedFiles] = createSignal<string[]>([]);
  const [droppedFileKinds, setDroppedFileKinds] = createSignal<string[]>([]);
  /** The window that had focus before this summon (docs/ROADMAP_HISTORY.md #29) — feeds
   * the `type = "window"` feature rows on the empty-query menu. `null` when
   * no window was captured or no window features exist. */
  const [fgContext, setFgContext] = createSignal<ForegroundInfo | null>(null);
  const [clipboardImgOk, setClipboardImgOk] = createSignal(false);
  /** Provider drill-down level : the row we descended into plus the
   * rows of the level above, so Esc can pop back. */
  const [drill, setDrill] = createSignal<{
    pluginId: string;
    item: unknown;
    parent: AppEntry[];
    /** The parent level's normal/plugin boundary (restored on Esc). */
    parentPluginStart: number;
    filterable: boolean;
  } | null>(null);
  /** Convert one provider result into a grid entry — shared by the search
   * merge and by drilled levels. `seq` only feeds the synthetic dedup
   * key used for rows that open nothing. Icon rule: the result's explicit
   * `icon` (a URI / plugin-relative path, or a `{light,dark}` pair; #44)
   * wins; a row without one shows the plugin's own icon set; with neither,
   * the regular path pipeline (unknown-icon fallback) applies. */
  function providerRowToEntry(
    p: { id: string; instance: ProviderInstance; dir?: string; icon?: PluginIconSpec },
    it: ProviderResult,
    seq: number
  ): AppEntry | null {
    if (!it?.name) return null;
    const key = it.path || `lume-plugin://${p.id}/${seq}`;
    const icon = resolvePluginIcon(it.icon, p.dir) ?? p.icon;
    return {
      id: 0,
      name: it.name,
      path: key,
      ...(it.description ? { description: it.description } : {}),
      ...(icon ? { icon } : {}),
      ...(it.enter ? { providerEnter: { pluginId: p.id, item: it } } : {}),
      ...(it.drill && p.instance.select
        ? {
            providerDrill: {
              pluginId: p.id,
              item: it,
              filterable: typeof p.instance.filter === "function",
            },
          }
        : {}),
    };
  }

  /** files/img feature rows → grid entries. The name composes the
   * manifest label with the file count (files only); the payload keeps the
   * matched paths for the plugin. */
  function featureRowToEntry(f: FeatureMatch): AppEntry {
    const name =
      f.type === "files"
        ? t("pluginFeatureFiles", { label: f.label, count: String(f.paths?.length ?? 0) })
        : f.label;
    return {
      id: -1,
      name,
      path: `lume-feature://${f.pluginId}/${f.code}`,
      ...(f.icon ? { icon: f.icon } : {}),
      featureEnter: {
        pluginId: f.pluginId,
        code: f.code,
        type: f.type,
        payload: f.payload,
        ...(f.paths ? { paths: f.paths } : {}),
        ...(f.window ? { window: f.window } : {}),
      },
    };
  }

  /** Provider rows → grid entries (drop malformed ones). */
  function rowsToEntries(
    p: { id: string; instance: ProviderInstance; dir?: string; icon?: PluginIconSpec },
    rows: ProviderResult[]
  ): AppEntry[] {
    const out: AppEntry[] = [];
    rows.forEach((r, i) => {
      const e = providerRowToEntry(p, r, i);
      if (e) out.push(e);
    });
    return out;
  }

  /** Leave a drilled level : restore the parent rows, release the
   * search box if this provider claimed it. Returns false when not drilled. */
  function popDrill(): boolean {
    const d = drill();
    if (!d) return false;
    setDrill(null);
    setApps(d.parent);
    setPluginStart(d.parentPluginStart);
    if (services.subInputOwner() === d.pluginId) services.setSubInput(d.pluginId, null);
    setSelected(0);
    services.scheduleResize();
    return true;
  }

  /** The home page's search — the merge pipeline, dropping stale responses by
   * the root's search token (the shell bumps it before every dispatch). */
  async function search(q: string) {
    nav.setNavHidden(false); // typing reveals the first entry's highlight
    if (drill()) setDrill(null); // a fresh search leaves the drilled level
    const token = services.searchToken();
    if (q.trim() === "") {
      // Keep the zone: the empty menu re-runs this search for its async
      // feature refreshes (foreground context / clipboard probe) and must not
      // drop the bar highlight the summon auto-selected.
      // Empty query shows the main-menu bars (最近使用 / 已固定 / 推荐使用 /
      // plugin bars / Explorer), never a browse grid. Plugin rows for the
      // current context — a fresh file drop, the clipboard holding an image
      // with an img rule declared, a matched foreground-window rule — land in
      // the 「推荐使用」 section (#43), so they no longer replace the bars.
      const rebuildEmpty = (feats: FeatureMatch[]) => {
        const entries = feats.map(featureRowToEntry);
        setApps([]);
        setPluginStart(0);
        nav.setRecommended(
          entries.length > 0
            ? {
                items: entries.map((e) => ({
                  id: e.id,
                  name: e.name,
                  path: e.path,
                  ...(e.icon ? { icon: e.icon } : {}),
                })),
                activate: (idx) => {
                  const item = entries[idx];
                  if (item) activateEntry(item, false);
                },
              }
            : null
        );
        services.scheduleResize();
      };
      const feats = () => [
        ...windowFeatureMatches(fgContext()),
        ...fileFeatureMatches(droppedFiles(), droppedFileKinds()),
        ...(clipboardImgOk() ? imgFeatureMatches() : []),
      ];
      rebuildEmpty(feats());
      if (imgFeatureMatches().length > 0) {
        // One cheap probe per empty render (OpenClipboard + format check) —
        // a screenshot taken while the menu is up makes the row appear, and
        // the clipboard changing back to text drops it. Stale-guarded by
        // the request token.
        void invoke<boolean>("plugin_clipboard_has_image")
          .then((ok) => {
            if (token !== services.searchToken()) return;
            setClipboardImgOk(!!ok);
            // Rebuild either way: the probe may have ADDED the row (image
            // appeared) or must DROP a stale one (clipboard changed back).
            rebuildEmpty([
              ...windowFeatureMatches(fgContext()),
              ...fileFeatureMatches(droppedFiles(), droppedFileKinds()),
              ...(ok ? imgFeatureMatches() : []),
            ]);
          })
          .catch(() => {});
      }
      return;
    }
    // A query owns the selection: the grid, not a bar — and it hides the
    // empty-menu section. Plugin-appended rows (全局关键字 / feature /
    // file-drop / providers) collect below the normal results in the
    // 「推荐使用」 block, split at `pluginStart` (#43).
    nav.setZone("grid");
    nav.setRecommended(null);
    // Native index and the unified file-search backend race in parallel;
    // both are stale-guarded by the same request token below.
    const [res, files] = (await Promise.all([
      invoke("search_apps", { query: q }),
      invoke<FileSearchOut>("file_search", { query: q }).catch((err) => {
        console.error("file_search failed:", err);
        return null;
      }),
    ])) as [AppEntry[], FileSearchOut | null];
    if (token !== services.searchToken()) return;
    // Merge into two blocks: the normal results (native index → file-search
    // hits; deduped by path, capped to keep the grid sane) and the plugin-
    // appended rows (全局关键字 → feature rows → file-drop rows → providers,
    // never crowded out) rendered under the 「推荐使用」 divider.
    const normal: AppEntry[] = [...res];
    const plugin: AppEntry[] = [];
    const seen = new Set(res.map((r) => r.path));
    for (const kw of modeKeywordMatches(q)) {
      plugin.push({
        id: -1,
        name: `进入 ${kw.name}`,
        path: `lume-mode://${kw.id}`,
        ...(kw.icon ? { icon: kw.icon } : {}),
      });
    }
    // 声明式进入（features）：正则/任意文本命中 → 「<label>」行，
    // 激活把当前查询作为 payload 投递给插件（mode 先切页再 onEnter）。
    for (const f of featureMatches(q)) {
      plugin.push({
        id: -1,
        name: f.label,
        path: `lume-feature://${f.pluginId}/${f.code}`,
        ...(f.icon ? { icon: f.icon } : {}),
        featureEnter: { pluginId: f.pluginId, code: f.code, type: f.type, payload: f.payload },
      });
    }
    // : a file dropped while a query is up also offers its rows.
    for (const f of fileFeatureMatches(droppedFiles(), droppedFileKinds())) {
      plugin.push(featureRowToEntry(f));
    }
    for (const f of files?.entries ?? []) {
      if (normal.length + plugin.length >= 20) break;
      if (!f?.name || !f?.path || seen.has(f.path)) continue;
      seen.add(f.path);
      normal.push(f);
    }
    for (const p of providerPlugins()) {
      try {
        const items = await p.instance.search(q);
        if (token !== services.searchToken()) return;
        for (const it of items ?? []) {
          if (normal.length + plugin.length >= 20) break;
          const key = it.path || `lume-plugin://${p.id}/${plugin.length}`;
          if (seen.has(key)) continue;
          const entry = providerRowToEntry(p, it, plugin.length);
          if (!entry) continue;
          seen.add(key);
          plugin.push(entry);
        }
      } catch (err) {
        console.error("provider search failed:", p.id, err);
      }
    }
    const merged = [...normal, ...plugin];
    setApps(merged);
    setPluginStart(normal.length);
    // Rows with an explicit icon or a plugin-enter action don't go through
    // the icon pipeline (icon is already resolved / path is synthetic).
    void deps.icons.loadIcons(
      merged.filter((a) => !a.icon && !a.providerEnter && !a.featureEnter)
    );
    services.scheduleResize();
  }

  /** Intercept the drill-filter keystrokes : while drilled into a
   * filterable provider row, typing feeds the current level instead of
   * running a search. Returns false when not drilled. */
  function handleQuery(q: string): boolean {
    const d = drill();
    const owner = services.subInputOwner();
    if (!d?.filterable || d.pluginId !== owner) return false;
    const p = providerPlugins().find((x) => x.id === d.pluginId);
    const token = services.nextSearchToken();
    void (async () => {
      try {
        const rows = await p?.instance.filter?.(d.item as never, q);
        if (token !== services.searchToken()) return;
        setApps(rowsToEntries(p!, rows ?? []));
        setPluginStart(0); // filtered level = the whole grid
        setSelected(0);
        services.scheduleResize();
      } catch (err) {
        console.error("provider filter failed:", d.pluginId, err);
      }
    })();
    return true;
  }

  /** Activate one entry: a feature/keyword row, a provider action/drill row,
   * or a plain launch. Shared by the results grid and the 「推荐使用」 section
   * (the section contract calls it back with its own index). */
  function activateEntry(item: AppEntry, elevated: boolean): void {
    // 声明式进入行（features/）：把查询作为 payload 投递给插件。
    // mode 目标先切页再 onEnter；provider/service 直接 onFeature。
    if (item.featureEnter) {
      const fe = item.featureEnter;
      const ok = services.enterPlugin(fe.pluginId, {
        code: fe.code,
        type: fe.type,
        payload: fe.payload,
        ...(fe.paths ? { paths: fe.paths } : {}),
        ...(fe.window ? { window: fe.window } : {}),
      });
      if (!ok) services.showToast(t("pluginActionUnavailable", { id: item.featureEnter.pluginId }));
      return;
    }
    // 二级下钻行：provider.select 的返回行替换网格，Esc 回上一级。
    if (item.providerDrill) {
      const d = item.providerDrill;
      const p = providerPlugins().find((x) => x.id === d.pluginId);
      if (!p?.instance.select) return;
      const parent = apps();
      const parentPluginStart = pluginStart();
      void (async () => {
        try {
          const rows = await p.instance.select!(d.item as never);
          setApps(rowsToEntries(p, rows ?? []));
          setPluginStart(0); // a drilled level replaces the whole grid
          setDrill({
            pluginId: d.pluginId,
            item: d.item,
            parent,
            parentPluginStart,
            filterable: d.filterable,
          });
          if (d.filterable) services.setSubInput(d.pluginId, { placeholder: t("searchGeneric") });
          setSelected(0);
          services.scheduleResize();
        } catch (err) {
          console.error("provider select failed:", d.pluginId, err);
          services.showToast(t("pluginActionUnavailable", { id: d.pluginId }));
        }
      })();
      return;
    }
    // Provider action row (manifest of `enter`): hand the original result
    // object back to the plugin's onEnter instead of launching anything.
    // The launcher stays open — the plugin hides itself when done.
    if (item.providerEnter) {
      const p = providerPlugins().find((x) => x.id === item.providerEnter!.pluginId);
      try {
        p?.instance.onEnter?.(item.providerEnter.item as never);
      } catch (err) {
        console.error("provider onEnter failed:", p?.id ?? item.providerEnter.pluginId, err);
      }
      return;
    }
    // 全局关键字行：进入对应插件模式（不隐藏，不记为已使用条目）。
    if (item.path.startsWith("lume-mode://")) {
      services.requestMode(item.path.slice("lume-mode://".length));
      return;
    }
    void invoke("launch_app", { path: item.path, name: item.name, elevated });
    void services.resetAndHide();
  }

  /** Activate the selected entry — a bar/section tile (section contract) or
   * the grid row at `selected()`. */
  function activate(opts?: { elevated?: boolean }): void {
    services.markEntryOpened(); // Enter/点击打开条目 → 首页下次呼出清查询（#40）
    const elevated = opts?.elevated ?? false;
    // Bar zone: the owning section activates its selected item — a plain app
    // launch (recent/pinned/plugin bars), a 推荐使用 feature row, an explorer
    // action tile, or anything else a section contract defines.
    const sec = nav.activeSection();
    if (sec) {
      sec.activate(sec.selected(), elevated);
      return;
    }
    const item = apps()[selected()];
    if (!item) return;
    activateEntry(item, elevated);
  }

  /** OS file drop : record the paths for the feature rows. The kinds
   * query and the follow-up search only run while this page is active (the
   * old root behavior: a drop elsewhere still records the paths). */
  function onFilesDropped(paths: string[]) {
    setDroppedFiles(paths);
    setClipboardImgOk(false);
    if (services.mode() !== deps.id) return;
    // Kinds before the search: the drop is async to begin with, so one
    // attributes query keeps `fileType` rules from racing the first render.
    void invoke<string[]>("file_kinds", { paths })
      .then((kinds) => {
        if (paths !== droppedFiles()) return; // a newer drop replaced this one
        setDroppedFileKinds(kinds);
      })
      .catch(() => setDroppedFileKinds(paths.map(() => "file")))
      .finally(() => {
        if (services.mode() !== deps.id) return;
        const focusRows = appsQuery() === "";
        void services.runSearch(appsQuery()).then(() => {
          // The drop's rows are the primary action of this menu — focus the
          // fresh 「推荐使用」 section (no-op when nothing matched).
          if (focusRows) nav.focusRecommended();
        });
      });
  }

  /** The window that had focus before this summon (docs/ROADMAP_HISTORY.md #29) —
   * fetched only when some plugin declares a `type = "window"` rule (zero
   * IPC otherwise). Non-blocking on purpose: the COM hop behind this command
   * can stall for longer than a summon may wait, so the fetch lands whenever
   * it lands and re-renders the empty menu then (the img-probe pattern). */
  function fetchFgContext() {
    if (!hasWindowFeatures()) {
      setFgContext(null);
      return;
    }
    void invoke<{
      process: string;
      className: string;
      title: string;
      path: string | null;
    }>("get_foreground_context")
      .then((ctx) => {
        const mapped =
          ctx && (ctx.process || ctx.className || ctx.title || ctx.path)
            ? {
                process: ctx.process,
                className: ctx.className,
                title: ctx.title,
                ...(ctx.path ? { path: ctx.path } : {}),
              }
            : null;
        plog.debug(null, "foreground context:", JSON.stringify(mapped));
        setFgContext(mapped);
        if (services.mode() === deps.id) void services.runSearch(appsQuery());
      })
      .catch(() => {
        plog.warn(null, "foreground context fetch failed");
        setFgContext(null);
      });
  }

  /** Per-show reset (the summon-time reset hook): rows, drill level and the
   * one-shot feature-row state. */
  function resetState() {
    setDrill(null);
    setDroppedFiles([]);
    setDroppedFileKinds([]);
    setFgContext(null);
    setClipboardImgOk(false);
    setApps([]);
    setPluginStart(0);
    nav.setRecommended(null);
    setSelected(0);
  }

  // Keep the selected result visible while navigating with the keyboard.
  // Mouse hover selects too, but must not scroll the list (a clipped row
  // hovering would otherwise yank the scroll position). Only this page's own
  // grid: clipboard rows share the `.result-selected` class.
  createEffect(() => {
    selected();
    if (services.mode() !== deps.id) return;
    if (services.selectionSource() === "keyboard") {
      document.querySelector(".result-selected")?.scrollIntoView({ block: "nearest" });
    }
  });

  return {
    apps,
    pluginStart,
    appsQuery,
    setAppsQuery,
    selected,
    setSelected,
    search,
    handleQuery,
    activate,
    popDrill,
    resetState,
    onFilesDropped,
    fetchFgContext,
  };
}

export type NavigateSearch = ReturnType<typeof createNavigateSearch>;
