//! Navigate-mode store — the 最近使用 / 已固定 bars, the Explorer-folder bar,
//! their data refresh, app actions (launch / reveal / pin / remove-from-recent)
//! and the continuous bar-grid keyboard navigation. Also owns the pinned-bar
//! drag-reorder listeners.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { AppEntry } from "./types";

export interface NavigateDeps {
  /** Settings: show the 「最近使用」 bar (display-only toggle). */
  showRecent: () => boolean;
  /** Settings: show the 「Windows 资源管理器」 bar. */
  showExplorerBar: () => boolean;
  /** Measured column count of a bar grid (one row when collapsed). */
  barCols: () => number;
  icons: { loadIcons(apps: AppEntry[]): Promise<void> };
  scheduleResize: () => void;
  showToast: (text: string, opts?: { undo?: () => void; duration?: number }) => void;
  /** Marks that an entry was opened (launch / terminal) — clears search recall. */
  markEntryOpened: () => void;
  resetAndHide: () => void;
}

export function createNavigateStore(deps: NavigateDeps) {
  const [pinnedApps, setPinnedApps] = createSignal<AppEntry[]>([]);
  const [recentApps, setRecentApps] = createSignal<AppEntry[]>([]);
  /** Which area owns the selection on the empty-query main menu. */
  const [zone, setZone] = createSignal<"recent" | "pinned" | "folder" | "grid">("grid");
  const [pinnedSelected, setPinnedSelected] = createSignal(0);
  const [recentSelected, setRecentSelected] = createSignal(0);
  /** Explorer-folder context: the folder the launcher was summoned from (or
   * `null` when the foreground window wasn't an Explorer folder view). */
  const [folderCtx, setFolderCtx] = createSignal<{ path: string } | null>(null);
  /** Selected tile in the 「Windows 资源管理器」 bar: 0=CMD, 1=PowerShell, 2=copy. */
  const [folderSelected, setFolderSelected] = createSignal(0);
  /** cmd.exe / powershell.exe icons (base64 data URIs) for the bar tiles. */
  const [termIcons, setTermIcons] = createSignal<{ cmd: string | null; powershell: string | null }>({
    cmd: null,
    powershell: null,
  });
  const [recentExpanded, setRecentExpanded] = createSignal(false);
  const [pinnedExpanded, setPinnedExpanded] = createSignal(false);
  /** True while the cursor rests on empty space (a place with no entry) — the
   * selection highlight is hidden, but the selection index is retained. Moving
   * back over an entry or pressing an arrow key reveals it again (arrow nav
   * reappears from the position it was hidden at). Applies to the Navigate
   * main menu / results grid only. */
  const [navHidden, setNavHidden] = createSignal(false);

  // ── Native drag-and-drop for pinned-bar reordering ──
  // Use a plain ref (not a SolidJS signal) so drag event handlers never
  // trigger reactive re-renders that would destroy the dragged DOM element.
  let dragRef: { item: AppEntry; fromIndex: number; overIndex: number } | null = null;

  /** Reload the pinned-apps bar from the store. */
  async function refreshPins() {
    try {
      const pins = (await invoke("get_pinned_apps")) as AppEntry[];
      setPinnedApps(pins);
      if (pinnedSelected() >= pins.length) setPinnedSelected(0);
      if (pins.length === 0 && zone() === "pinned") {
        setZone(recentApps().length > 0 ? "recent" : "grid");
      }
      void deps.icons.loadIcons(pins);
      deps.scheduleResize();
    } catch (err) {
      console.error("get_pinned_apps failed", err);
    }
  }

  /** Reload the recent-opens bar from the store. */
  async function refreshRecent() {
    try {
      const recents = (await invoke("get_recent_apps")) as AppEntry[];
      setRecentApps(recents);
      if (recentSelected() >= recents.length) setRecentSelected(0);
      if (recents.length === 0 && zone() === "recent") {
        setZone(pinnedApps().length > 0 ? "pinned" : "grid");
      }
      void deps.icons.loadIcons(recents);
      deps.scheduleResize();
    } catch (err) {
      console.error("get_recent_apps failed", err);
    }
  }

  /** Fetch the Explorer folder the launcher was summoned from (the foreground
   * window at capture time). Sets the 「Windows 资源管理器」 bar context, or
   * clears it when the foreground window wasn't an Explorer folder view. */
  async function refreshFolderCtx() {
    // Setting off → never show the bar (no IPC, no capture).
    if (!deps.showExplorerBar()) {
      setFolderCtx(null);
      return;
    }
    try {
      const ctx = (await invoke("get_foreground_context")) as {
        path: string | null;
        is_explorer: boolean;
      };
      if (ctx.is_explorer && ctx.path) {
        setFolderCtx({ path: ctx.path });
      } else {
        setFolderCtx(null);
      }
      // The new (or removed) bar changes the content height — re-measure.
      deps.scheduleResize();
    } catch (err) {
      console.error("get_foreground_context failed", err);
      setFolderCtx(null);
    }
  }

  /** Fetch the cmd.exe / powershell.exe icons for the 「Windows 资源管理器」 bar
   * tiles (their own icons, not the bundled icon set). Called once on mount. */
  async function refreshTermIcons() {
    try {
      const icons = (await invoke("get_terminal_icons")) as {
        cmd: string | null;
        powershell: string | null;
      };
      setTermIcons({ cmd: icons.cmd ?? null, powershell: icons.powershell ?? null });
    } catch (err) {
      console.error("get_terminal_icons failed", err);
    }
  }

  /** Pin/unpin an app for the Navigate bar (Ctrl+P). */
  async function toggleAppPin(app: AppEntry) {
    const isPinned = pinnedApps().some((p) => p.path === app.path);
    try {
      if (isPinned) {
        await invoke("unpin_app", { path: app.path });
      } else {
        await invoke("pin_app", { path: app.path, name: app.name });
      }
    } catch (err) {
      console.error("pin toggle failed", err);
    }
    await refreshPins();
  }

  /** Remove an entry from the recent-opens bar (soft delete — reopening the
   * entry re-adds it; the file/app itself is untouched). */
  async function deleteRecent(app: AppEntry) {
    try {
      await invoke("delete_recent", { path: app.path });
    } catch (err) {
      console.error("delete_recent failed", err);
    }
    await refreshRecent();
  }

  /** Launch a specific app and hide the launcher. When elevated, waits for the
   * UAC prompt so a cancellation keeps the launcher open instead of hiding. */
  function launchApp(app: AppEntry, elevated = false) {
    deps.markEntryOpened(); // 打开条目 → 清空搜索记忆, 下次呼出回导航页
    if (elevated) {
      void (async () => {
        try {
          await invoke("launch_app", { path: app.path, name: app.name, elevated: true });
          void deps.resetAndHide();
        } catch (err) {
          if (String(err).includes("canceled")) return; // user dismissed UAC
          console.error("launch failed", err);
          void deps.resetAndHide();
        }
      })();
      return;
    }
    void invoke("launch_app", { path: app.path, name: app.name, elevated: false });
    void deps.resetAndHide();
  }

  /** Reveal an app's file in Explorer, keeping the launcher open. */
  function revealInFolder(app: AppEntry) {
    void invoke("reveal_in_folder", { path: app.path }).catch((err) =>
      console.error("reveal failed", err)
    );
  }

  /** Activate a tile in the 「Windows 资源管理器」 bar. `idx`: 0=CMD, 1=PowerShell,
   * 2=copy path. A terminal hides the launcher after launching; a path copy
   * keeps it open and shows a toast. */
  function activateFolder(idx: number, elevated: boolean) {
    const ctx = folderCtx();
    if (!ctx) return;
    if (idx >= 2) {
      void invoke("copy_path", { path: ctx.path })
        .then(() => deps.showToast(t("copied")))
        .catch((err) => {
          console.error("copy failed", err);
          deps.showToast(t("copyFailed"));
        });
      void deps.resetAndHide();
      return;
    }
    const shell = idx === 1 ? "powershell" : "cmd";
    deps.markEntryOpened(); // 打开终端即使用条目 → 清空搜索记忆
    void invoke("open_terminal_in_folder", { path: ctx.path, shell, elevated }).catch((err) =>
      console.error("open terminal failed", err),
    );
    void deps.resetAndHide();
  }

  /** Bars currently visible on the empty-query main menu, top to bottom. */
  function visibleBars(): ("recent" | "pinned" | "folder")[] {
    const bars: ("recent" | "pinned" | "folder")[] = [];
    if (deps.showRecent() && recentApps().length > 0) bars.push("recent");
    if (pinnedApps().length > 0) bars.push("pinned");
    // The Explorer-folder bar sits at the bottom and only appears when a path
    // was captured at summon time.
    if (folderCtx()) bars.push("folder");
    return bars;
  }

  /** Move the bar selection across the two bars treated as one continuous
   * grid. `↓`/`↑` move to the next/previous row that actually has an item at
   * the current column — a collapsed bar contributes exactly one row (only its
   * visible items are reachable), and crossing a bar boundary keeps the column
   * instead of landing on the bar's end. `←`/`→` move within the current row
   * (clamped, no wrap). */
  function moveBarSelection(dc: number, dr: number) {
    const bars = visibleBars();
    if (bars.length === 0) return;
    setNavHidden(false); // arrow nav reveals the highlight from its hidden position
    const cols = Math.max(deps.barCols(), 1);

    const len = (k: "recent" | "pinned" | "folder") =>
      k === "recent" ? recentApps().length : k === "pinned" ? pinnedApps().length : 3;
    const expanded = (k: "recent" | "pinned" | "folder") =>
      k === "recent" ? recentExpanded() : k === "pinned" ? pinnedExpanded() : true;
    // Navigation rows of a bar: one when collapsed, every row when expanded.
    const rows = (k: "recent" | "pinned" | "folder") =>
      expanded(k) ? Math.ceil(len(k) / cols) : 1;
    // Items a collapsed bar exposes to navigation: only its first row.
    const reach = (k: "recent" | "pinned" | "folder") =>
      expanded(k) ? len(k) : Math.min(len(k), cols);

    // The stacked grid, top to bottom: each visible bar contributes its rows.
    const grid: { bar: "recent" | "pinned" | "folder"; local: number }[] = [];
    for (const k of bars) for (let r = 0; r < rows(k); r++) grid.push({ bar: k, local: r });

    const setIdx = (k: "recent" | "pinned" | "folder", v: number) => {
      if (k === "recent") setRecentSelected(v);
      else if (k === "pinned") setPinnedSelected(v);
      else setFolderSelected(v);
    };
    const getIdx = (k: "recent" | "pinned" | "folder") =>
      k === "recent" ? recentSelected() : k === "pinned" ? pinnedSelected() : folderSelected();

    // Resolve the current position to a (gridRow, col); with no bar active,
    // start at the top bar.
    let bi = bars.indexOf(zone() as "recent" | "pinned" | "folder");
    let idx = bi >= 0 ? getIdx(bars[bi]) : 0;
    if (bi < 0) bi = 0;
    const curReach = reach(bars[bi]);
    idx = Math.min(idx, Math.max(0, curReach - 1));
    let gridRow = 0;
    for (let i = 0; i < bi; i++) gridRow += rows(bars[i]);
    gridRow += Math.floor(idx / cols);
    const col = idx % cols;

    // Whether the item at grid row `r`, current column, exists.
    const hasItem = (r: number) => {
      const { bar, local } = grid[r];
      return local * cols + col < reach(bar);
    };
    const commitGrid = (r: number) => {
      const { bar, local } = grid[r];
      const target = Math.min(Math.max(local * cols + col, 0), reach(bar) - 1);
      setIdx(bar, target);
      setZone(bar);
    };

    if (dr === 0) {
      // Horizontal: stay in the current row of the current bar, clamped to the
      // row's real extent (a partial last row, or a collapsed bar's one row).
      const rowStart = Math.floor(idx / cols) * cols;
      const rowEnd = Math.min(rowStart + cols, curReach) - 1;
      setIdx(bars[bi], Math.min(Math.max(idx + dc, rowStart), rowEnd));
      setZone(bars[bi]);
      return;
    }
    if (dr > 0) {
      // Down: the next row that has an item at this column.
      let r = gridRow + 1;
      while (r < grid.length && !hasItem(r)) r++;
      if (r < grid.length) {
        commitGrid(r);
      } else if (gridRow === grid.length - 1) {
        // Already on the last row: loop back to the top of this column.
        r = 0;
        while (r < grid.length && !hasItem(r)) r++;
        if (r >= grid.length) return;
        commitGrid(r);
      } else {
        // A lower row exists but doesn't reach this column (a partial last
        // row): jump to the current bar's last item (the section end).
        setIdx(bars[bi], reach(bars[bi]) - 1);
        setZone(bars[bi]);
      }
    } else {
      // Up: the previous row that has an item at this column, wrapping to the
      // bottom. Skips a partial last row that doesn't reach the column.
      let r = gridRow - 1;
      while (r >= 0 && !hasItem(r)) r--;
      if (r < 0) {
        r = grid.length - 1;
        while (r >= 0 && !hasItem(r)) r--;
        if (r < 0) return;
      }
      commitGrid(r);
    }
  }

  /** Start a pinned-bar drag (called from the row's onDragStart handler). */
  function beginDrag(item: AppEntry, fromIndex: number) {
    dragRef = { item, fromIndex, overIndex: fromIndex };
  }

  /** Install the document-level drag listeners for pinned-bar reordering.
   * Raw DOM listeners (not Solid events) so preventDefault() always reaches
   * the native event. Listeners live for the window's lifetime. */
  function installDragReorder() {
    document.addEventListener("dragover", (e) => {
      const target = (e.target as HTMLElement).closest(".bar-grid") as HTMLElement | null;
      if (!target || !dragRef) return;
      e.preventDefault();
      // Group items by row (same top ≈ same row), then find which row the
      // cursor is on. Within that row, find the horizontal insertion point.
      // When the cursor is below all rows, insert at the very end.
      const boxes = Array.from(target.querySelectorAll(".result-box")) as HTMLElement[];
      const rows: { top: number; bottom: number; indices: number[] }[] = [];
      for (let idx = 0; idx < boxes.length; idx++) {
        const r = boxes[idx].getBoundingClientRect();
        const last = rows[rows.length - 1];
        if (last && Math.abs(r.top - last.top) < 10) {
          last.indices.push(idx);
          last.bottom = Math.max(last.bottom, r.bottom);
        } else {
          rows.push({ top: r.top, bottom: r.bottom, indices: [idx] });
        }
      }
      let overIndex = boxes.length;
      let targetRow = rows[rows.length - 1]; // default to last row
      for (const row of rows) {
        if (e.clientY < row.bottom) { targetRow = row; break; }
      }
      if (e.clientY > targetRow.bottom) {
        overIndex = boxes.length; // below all rows → end
      } else {
        for (const idx of targetRow.indices) {
          const r = boxes[idx].getBoundingClientRect();
          if (e.clientX < r.left + r.width / 2) { overIndex = idx; break; }
        }
        if (overIndex === boxes.length) {
          overIndex = targetRow.indices[targetRow.indices.length - 1] + 1;
        }
      }
      // Update insertion indicator classes on result-box elements.
      boxes.forEach((b) => b.classList.remove("result-insert-before", "result-insert-after"));
      if (overIndex !== dragRef.fromIndex && overIndex !== dragRef.fromIndex + 1) {
        if (overIndex < boxes.length) {
          boxes[overIndex].classList.add("result-insert-before");
        } else {
          boxes[boxes.length - 1].classList.add("result-insert-after");
        }
      }
      dragRef.overIndex = overIndex;
    });

    // Clear drag styling from every box. Query the whole document rather than
    // just the first .bar-grid: with both bars visible the draggable pinned
    // items live in the *second* grid, and a scoped query would miss them,
    // leaving the dragged item dimmed after a cancelled drag.
    const clearDragStyling = () => {
      document
        .querySelectorAll(
          ".result-box.result-dragging,.result-box.result-insert-before,.result-box.result-insert-after"
        )
        .forEach((c) =>
          c.classList.remove("result-dragging", "result-insert-before", "result-insert-after")
        );
    };

    // Safety net: a drop that ends without a dragend (WebView2 quirk) must
    // still clear the styling.
    document.addEventListener("drop", clearDragStyling);

    document.addEventListener("dragend", (e) => {
      clearDragStyling();
      const dr = dragRef;
      dragRef = null;
      if (!dr || (e as DragEvent).dataTransfer?.dropEffect === "none") return;
      if (dr.overIndex === dr.fromIndex || dr.overIndex === dr.fromIndex + 1) return;
      const items = pinnedApps();
      const reordered = items.filter((_, idx) => idx !== dr.fromIndex);
      const insertAt = Math.min(dr.overIndex > dr.fromIndex ? dr.overIndex - 1 : dr.overIndex, reordered.length);
      reordered.splice(insertAt, 0, items[dr.fromIndex]);
      invoke("reorder_pins", { paths: reordered.map((p) => p.path) })
        .then(() => void refreshPins())
        .catch((err) => console.error("reorder_pins failed", err));
    });
  }

  return {
    // signals
    pinnedApps,
    recentApps,
    zone,
    setZone,
    pinnedSelected,
    setPinnedSelected,
    recentSelected,
    setRecentSelected,
    folderCtx,
    folderSelected,
    setFolderSelected,
    termIcons,
    recentExpanded,
    setRecentExpanded,
    pinnedExpanded,
    setPinnedExpanded,
    navHidden,
    setNavHidden,
    // actions
    refreshPins,
    refreshRecent,
    refreshFolderCtx,
    refreshTermIcons,
    toggleAppPin,
    deleteRecent,
    launchApp,
    revealInFolder,
    activateFolder,
    visibleBars,
    moveBarSelection,
    beginDrag,
    installDragReorder,
  };
}

export type NavigateStore = ReturnType<typeof createNavigateStore>;
