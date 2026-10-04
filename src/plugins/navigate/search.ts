//! Navigate home-page search — the merge pipeline behind the home page's grid
//! (native index → 全局关键字 rows → declarative feature rows → file-search
//! hits → plugin providers), the summon-scoped feature-row state (OS file
//! drops, the clipboard image, the captured foreground window) and the
//! provider drill-down. Lived in the composition root until the navigate page
//! became a built-in plugin.

import { createEffect, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import { plog } from "../log";
import type { AppEntry, FileSearchOut } from "../../launcher/types";
import type { ForegroundInfo, PluginServices, ProviderInstance, ProviderResult } from "../types";
import type { FeatureMatch } from "../registry";
import {
  featureMatches,
  fileFeatureMatches,
  hasWindowFeatures,
  imgFeatureMatches,
  modeKeywordMatches,
  providerPlugins,
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
  const [selected, setSelected] = createSignal(0);
  // P2.2 — plugin entry rows for OS file drops (paths arrive via the Tauri
  // drag-drop handler) and for the clipboard image. Cleared on hide/summon.
  // `droppedFileKinds` runs parallel to `droppedFiles` (P4, ROADMAP #28):
  // "file" | "folder" | "missing" per path, so `fileType` rules can tell a
  // directory from a file with one attributes query per drop.
  const [droppedFiles, setDroppedFiles] = createSignal<string[]>([]);
  const [droppedFileKinds, setDroppedFileKinds] = createSignal<string[]>([]);
  /** The window that had focus before this summon (P4, ROADMAP #29) — feeds
   * the `type = "window"` feature rows on the empty-query menu. `null` when
   * no window was captured or no window features exist. */
  const [fgContext, setFgContext] = createSignal<ForegroundInfo | null>(null);
  const [clipboardImgOk, setClipboardImgOk] = createSignal(false);
  /** Provider drill-down level (P2.4): the row we descended into plus the
   * rows of the level above, so Esc can pop back. */
  const [drill, setDrill] = createSignal<{
    pluginId: string;
    item: unknown;
    parent: AppEntry[];
    filterable: boolean;
  } | null>(null);

  /** P4: the empty-query menu switches to the grid when any plugin rows are
   * on offer — dropped files, a **matched** window rule, or the clipboard
   * image (a captured foreground context alone doesn't force the grid). */
  const forceGrid = () =>
    droppedFiles().length > 0 ||
    windowFeatureMatches(fgContext()).length > 0 ||
    (clipboardImgOk() && imgFeatureMatches().length > 0);

  /** Convert one provider result into a grid entry — shared by the search
   * merge and by drilled levels (P2.4). `seq` only feeds the synthetic dedup
   * key used for rows that open nothing. */
  function providerRowToEntry(
    pluginId: string,
    instance: ProviderInstance,
    it: ProviderResult,
    seq: number
  ): AppEntry | null {
    if (!it?.name) return null;
    const key = it.path || `lume-plugin://${pluginId}/${seq}`;
    return {
      id: 0,
      name: it.name,
      path: key,
      ...(it.description ? { description: it.description } : {}),
      ...(it.icon ? { icon: it.icon } : {}),
      ...(it.enter ? { providerEnter: { pluginId, item: it } } : {}),
      ...(it.drill && instance.select
        ? {
            providerDrill: {
              pluginId,
              item: it,
              filterable: typeof instance.filter === "function",
            },
          }
        : {}),
    };
  }

  /** P2.2 files/img feature rows → grid entries. The name composes the
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
    pluginId: string,
    instance: ProviderInstance,
    rows: ProviderResult[]
  ): AppEntry[] {
    const out: AppEntry[] = [];
    rows.forEach((r, i) => {
      const e = providerRowToEntry(pluginId, instance, r, i);
      if (e) out.push(e);
    });
    return out;
  }

  /** Leave a drilled level (P2.4): restore the parent rows, release the
   * search box if this provider claimed it. Returns false when not drilled. */
  function popDrill(): boolean {
    const d = drill();
    if (!d) return false;
    setDrill(null);
    setApps(d.parent);
    if (services.subInputOwner() === d.pluginId) services.setSubInput(d.pluginId, null);
    setSelected(0);
    services.scheduleResize();
    return true;
  }

  /** The home page's search — the merge pipeline, dropping stale responses by
   * the root's search token (the shell bumps it before every dispatch). */
  async function search(q: string) {
    nav.setNavHidden(false); // typing reveals the first entry's highlight
    nav.setZone("grid");
    if (drill()) setDrill(null); // a fresh search leaves the drilled level
    const token = services.searchToken();
    if (q.trim() === "") {
      // Empty query shows the two bars (最近使用 / 已固定), not a browse grid —
      // unless P2.2 plugin rows are on offer: a fresh file drop and/or the
      // clipboard holding an image with an img feature declared. Then the
      // grid shows exactly those rows (uTools-style drop menu; NavigateView
      // and the key router both leave the bar zone while forceGrid is true).
      const rebuildEmpty = (feats: FeatureMatch[]) => {
        setApps(feats.map(featureRowToEntry));
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
    // Merge order: native index → 全局关键字 rows (never crowded out) →
    // file-search hits (Everything or the LumeSVC engine) → plugin
    // providers — deduped by path, capped to keep the grid sane.
    const extra: AppEntry[] = [];
    const seen = new Set(res.map((r) => r.path));
    for (const kw of modeKeywordMatches(q)) {
      extra.push({ id: -1, name: `进入 ${kw.name}`, path: `lume-mode://${kw.id}` });
    }
    // 声明式进入（features，P2.1）：正则/任意文本命中 → 「<label>」行，
    // 激活把当前查询作为 payload 投递给插件（mode 先切页再 onEnter）。
    // 与关键字行同级：都在文件命中与 provider 之前，不被挤掉。
    for (const f of featureMatches(q)) {
      extra.push({
        id: -1,
        name: f.label,
        path: `lume-feature://${f.pluginId}/${f.code}`,
        ...(f.icon ? { icon: f.icon } : {}),
        featureEnter: { pluginId: f.pluginId, code: f.code, type: f.type, payload: f.payload },
      });
    }
    // P2.2: a file dropped while a query is up also offers its rows.
    for (const f of fileFeatureMatches(droppedFiles(), droppedFileKinds())) {
      extra.push(featureRowToEntry(f));
    }
    for (const f of files?.entries ?? []) {
      if (res.length + extra.length >= 20) break;
      if (!f?.name || !f?.path || seen.has(f.path)) continue;
      seen.add(f.path);
      extra.push(f);
    }
    for (const p of providerPlugins()) {
      try {
        const items = await p.instance.search(q);
        if (token !== services.searchToken()) return;
        for (const it of items ?? []) {
          if (res.length + extra.length >= 20) break;
          const key = it.path || `lume-plugin://${p.id}/${extra.length}`;
          if (seen.has(key)) continue;
          const entry = providerRowToEntry(p.id, p.instance, it, extra.length);
          if (!entry) continue;
          seen.add(key);
          extra.push(entry);
        }
      } catch (err) {
        console.error("provider search failed:", p.id, err);
      }
    }
    const merged = [...res, ...extra];
    setApps(merged);
    // Rows with an explicit icon or a plugin-enter action don't go through
    // the icon pipeline (icon is already resolved / path is synthetic).
    void deps.icons.loadIcons(
      merged.filter((a) => !a.icon && !a.providerEnter && !a.featureEnter)
    );
    services.scheduleResize();
  }

  /** Intercept the drill-filter keystrokes (P2.4): while drilled into a
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
        setApps(rowsToEntries(d.pluginId, p!.instance, rows ?? []));
        setSelected(0);
        services.scheduleResize();
      } catch (err) {
        console.error("provider filter failed:", d.pluginId, err);
      }
    })();
    return true;
  }

  /** Activate the selected entry: a bar tile, a feature/keyword row, a
   * provider action/drill row, or a plain launch. */
  function activate(opts?: { elevated?: boolean }): void {
    services.markEntryOpened(); // Enter/点击打开条目 → 清空搜索记忆
    const elevated = opts?.elevated ?? false;
    // Bar zone: the owning section activates its selected item — a plain app
    // launch (recent/pinned/plugin bars), an explorer action tile, or
    // anything else a section contract defines.
    const sec = nav.activeSection();
    if (sec) {
      sec.activate(sec.selected(), elevated);
      return;
    }
    const item = apps()[selected()];
    if (!item) return;
    // 声明式进入行（features/P2.1）：把查询作为 payload 投递给插件。
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
    // 二级下钻行（P2.4）：provider.select 的返回行替换网格，Esc 回上一级。
    if (item.providerDrill) {
      const d = item.providerDrill;
      const p = providerPlugins().find((x) => x.id === d.pluginId);
      if (!p?.instance.select) return;
      const parent = apps();
      void (async () => {
        try {
          const rows = await p.instance.select!(d.item as never);
          setApps(rowsToEntries(d.pluginId, p.instance, rows ?? []));
          setDrill({ pluginId: d.pluginId, item: d.item, parent, filterable: d.filterable });
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

  /** OS file drop (P2.2): record the paths for the feature rows. The kinds
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
        if (services.mode() === deps.id) void services.runSearch(appsQuery());
      });
  }

  /** The window that had focus before this summon (P4, ROADMAP #29) —
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

  /** Per-show reset (clearSearch hook): rows, drill level and the one-shot
   * feature-row state. */
  function resetState() {
    setDrill(null);
    setDroppedFiles([]);
    setDroppedFileKinds([]);
    setFgContext(null);
    setClipboardImgOk(false);
    setApps([]);
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
    appsQuery,
    setAppsQuery,
    selected,
    setSelected,
    forceGrid,
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
