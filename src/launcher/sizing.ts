//! Launcher window sizing — fit the window height to its content (Navigate
//! mode), keep a fixed height (Clipboard mode), and measure the layout-dependent
//! column counts. Owns the `lastWindowH` loop guard (deliberately NOT a module
//! global — one instance per launcher window).

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { MIN_WINDOW_H, SCREEN_MARGIN, WINDOW_PAD, type Mode } from "./types";

/** Everything the sizer reads from the composition root. Accessors are Solid
 * signal getters; the whole object is read at call time (late-bound deps). */
export interface SizerDeps {
  mode: () => Mode;
  windowHeight: () => number;
  windowWidth: () => number;
  recentExpanded: () => boolean;
  pinnedExpanded: () => boolean;
  workAreaH: () => number | null;
  setWorkAreaH: (v: number | null) => void;
  barCols: () => number;
  setBarCols: (v: number) => void;
  clipViewportH: () => number;
  setClipViewportH: (v: number) => void;
  clipScrollEl: () => HTMLDivElement | undefined;
}

export function createWindowSizer(deps: SizerDeps) {
  /** Last height we set — avoids resize/center loops. */
  let lastWindowH = 0;

  /** Measure the bar grid's column count (drives the collapsed one-row slice
   * and the 展开 button's visibility). auto-fill tracks reflect the container
   * width regardless of how many items are rendered, so this is stable. */
  function measureBarCols() {
    const barGrid = document.querySelector(".bar-grid") as HTMLElement | null;
    if (!barGrid) return;
    const cols = getComputedStyle(barGrid)
      .gridTemplateColumns.split(" ")
      .filter((t) => t.trim() !== "").length;
    if (cols && cols !== deps.barCols()) {
      deps.setBarCols(cols);
      // The collapsed slice changed → re-measure the window against the
      // corrected one-row height (terminates: barCols is now stable).
      scheduleResize();
    }
  }

  /** Current column count of the app grid (driven by 条目框大小). */
  function gridCols(): number {
    const grid = document.querySelector(".result-grid") as HTMLElement | null;
    if (!grid) return 6;
    const count = getComputedStyle(grid)
      .gridTemplateColumns.split(" ")
      .filter((t) => t.trim() !== "").length;
    return count || 6;
  }

  /** Fetch the current monitor's logical work-area height once (0/unknown →
   * `null`). Cached until an expand toggle clears it. */
  async function ensureWorkArea() {
    if (deps.workAreaH() != null) return;
    try {
      const h = await invoke<number>("get_work_area");
      deps.setWorkAreaH(h > 0 ? h : null);
    } catch {
      deps.setWorkAreaH(null);
    }
  }

  /** Re-read the virtual list's viewport height (idempotent). */
  function measureClipViewport() {
    const el = deps.clipScrollEl();
    if (!el) return;
    const h = el.clientHeight;
    if (h !== deps.clipViewportH()) deps.setClipViewportH(h);
  }

  /** Fit the launcher window height to the current content, then re-center. */
  async function resizeToContent() {
    // Clipboard mode uses a fixed window height (设置 → 窗口大小 → 高度); the
    // list viewport scrolls internally, so no content-based fitting applies.
    // Previews live in the satellite window now, so the launcher never widens.
    if (deps.mode() === "clipboard") {
      if (deps.windowHeight() !== lastWindowH) {
        lastWindowH = deps.windowHeight();
        await getCurrentWindow().setSize(new LogicalSize(deps.windowWidth(), deps.windowHeight()));
        await invoke("apply_position");
      }
      requestAnimationFrame(measureClipViewport);
      return;
    }
    const search = document.querySelector(".search") as HTMLElement | null;
    const container =
      (document.querySelector(".result-grid") as HTMLElement | null) ??
      (document.querySelector(".result-list") as HTMLElement | null) ??
      (document.querySelector(".bar-list") as HTMLElement | null);
    if (!container) return;

    measureBarCols();

    const searchH = search?.offsetHeight ?? 0;

    // Measure the content's natural height from the last child (scrollHeight
    // would clamp to the current viewport for short lists). Correct for any
    // existing scroll so the measurement is scroll-independent. The bars live
    // inside the container (bar-sections), so no separate bar height is added.
    const last = container.lastElementChild as HTMLElement | null;
    let contentH = 0;
    if (last) {
      const cr = container.getBoundingClientRect();
      const lr = last.getBoundingClientRect();
      const padBottom = parseFloat(getComputedStyle(container).paddingBottom) || 0;
      contentH = lr.bottom - cr.top + container.scrollTop + padBottom;
    } else {
      contentH = 56; // empty-state hint
    }

    // Height cap: an expanded bar fills the screen (up to the work area, minus
    // a margin); a collapsed bar stays under the configured window_height.
    // The bar-expand cap only applies on the Navigate page — the Clipboard page
    // must not inherit a bar's expanded size when switching modes.
    let cap = deps.windowHeight();
    if (deps.mode() === "apps" && (deps.recentExpanded() || deps.pinnedExpanded())) {
      await ensureWorkArea();
      const screen = deps.workAreaH();
      if (screen) cap = Math.max(deps.windowHeight(), screen - SCREEN_MARGIN);
    }
    const targetH = Math.max(
      MIN_WINDOW_H,
      Math.min(searchH + contentH + WINDOW_PAD, cap),
    );
    if (targetH === lastWindowH) return;
    lastWindowH = targetH;
    // Set the configured width (from settings) rather than re-reading the
    // current window width: a physical→logical→physical round trip drifts on
    // DPI scaling and the window grows wider on every resize.
    await getCurrentWindow().setSize(new LogicalSize(deps.windowWidth(), targetH));
    await invoke("apply_position");
  }

  /** Defer a resize to the next frame so the DOM has rendered first. */
  function scheduleResize() {
    requestAnimationFrame(() => void resizeToContent());
  }

  /** Force the next resize to apply even if the height matches (mode switches
   * and fresh shows — the fixed-height model differs per mode). */
  function invalidate() {
    lastWindowH = 0;
  }

  return {
    resizeToContent,
    scheduleResize,
    measureBarCols,
    gridCols,
    measureClipViewport,
    invalidate,
  };
}
