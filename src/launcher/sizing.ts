//! Launcher window sizing — fit the window height to its content (Navigate
//! mode), keep a fixed height (Clipboard mode), and measure the layout-dependent
//! column counts. Owns the `lastWindowH` loop guard (deliberately NOT a module
//! global — one instance per launcher window).

import { invoke } from "@tauri-apps/api/core";
import { MIN_WINDOW_H, SCREEN_MARGIN, WINDOW_PAD } from "./types";

const ERROR_PAGE_MIN_CONTENT_H = 220;

/** A terminal page error must not reuse the loading gate's search-row-only
 * height. Preserve the current page size when possible; if the preceding fit
 * page was shorter, leave enough room for the title, hint, detail and action. */
export function errorPageTargetHeight(
  searchH: number,
  currentH: number,
  maxH: number
): number {
  const safeSearchH = Number.isFinite(searchH) ? Math.max(0, searchH) : 0;
  const minimum = Math.max(
    MIN_WINDOW_H,
    Math.round(safeSearchH + ERROR_PAGE_MIN_CONTENT_H + WINDOW_PAD)
  );
  const current = Number.isFinite(currentH) ? Math.round(currentH) : minimum;
  const cap = Math.max(
    MIN_WINDOW_H,
    Number.isFinite(maxH) ? Math.round(maxH) : minimum
  );
  return Math.min(Math.max(current, minimum), cap);
}

/** Everything the sizer reads from the composition root. Accessors are Solid
 * signal getters; the whole object is read at call time (late-bound deps). */
export interface SizerDeps {
  /** Fixed-height model (plugin modes) vs auto-fit (Navigate). */
  fixedHeight: () => boolean;
  /** The active page has not finished loading (`ModeInstance.ready` is false).
   * A fit page collapses to the search row; a fixed page keeps its target
   * height and only the shell visibility gate hides content. */
  loading: () => boolean;
  windowHeight: () => number;
  windowWidth: () => number;
  /** The active mode's preferred fixed height (manifest `height`) — wins over
   * windowHeight when set; the sizer clamps it to the work area. */
  modeHeight: () => number | null;
  /** Presenter-reported page-area height for `heightPolicy() === "fit"`.
   * `null` falls back to DOM measurement for built-in fit pages. */
  fitContentHeight: () => number | null;
  /** A geometry command succeeded — this is the only place the composition
   * root advances the plugin `app.resize` baseline. */
  setRuntimeSize: (w: number, h: number) => void;
  /** Whether any expandable Navigate bar is expanded (work-area cap). */
  anyExpanded: () => boolean;
  workAreaH: () => number | null;
  setWorkAreaH: (v: number | null) => void;
  barCols: () => number;
  setBarCols: (v: number) => void;
  /** Plugin modes measure their own viewport (the sizer only triggers it). */
  measureModeViewport: () => void;
  /** The show handshake generation, when the caller is preparing a hidden show. */
  prepareGeneration: () => number | null;
  /** The active keep-alive host element (docs/ROADMAP_HISTORY.md #40). Page-content queries
   * are scoped to it: hidden pages stay mounted, so a document-wide query
   * could measure the wrong (invisible) page. */
  activeHost: () => HTMLElement | null;
}

export function createWindowSizer(deps: SizerDeps) {
  /** Query page content inside the ACTIVE host (fallback: document, for the
   * first frames before the host mounts). The search row stays global. */
  const pageQuery = <T extends Element>(sel: string): T | null =>
    ((deps.activeHost() ?? document).querySelector(sel) as T | null);

  /** Measure the bar grid's column count (drives the collapsed one-row slice
   * and the 展开 button's visibility). auto-fill tracks reflect the container
   * width regardless of how many items are rendered, so this is stable. */
  function measureBarCols() {
    const barGrid = pageQuery<HTMLElement>(".bar-grid");
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

  /** Current column count of the app grid (driven by 网格大小). */
  function gridCols(): number {
    const grid = pageQuery<HTMLElement>(".result-grid");
    if (!grid) return 6;
    const count = getComputedStyle(grid)
      .gridTemplateColumns.split(" ")
      .filter((t) => t.trim() !== "").length;
    return count || 6;
  }

  /** Last successfully committed logical size. A failed command never advances
   * this baseline, so the next identical request retries rather than skipping. */
  let committed: { w: number; h: number } | null = null;
  /** Renderer generation for the current page/monitor context. Any async
   * measurement that captures an older value must not submit. */
  let generation = 0;
  let running: Promise<void> | null = null;
  let pending = false;
  let waiters: Array<() => void> = [];

  /** Fetch the current monitor's logical work-area height without keeping a
   * long-lived cache. The geometry command re-reads the authoritative Rust
   * work area again for the final clamp. */
  async function ensureWorkArea() {
    try {
      const h = await invoke<number>("get_work_area");
      deps.setWorkAreaH(h > 0 ? h : null);
      return h > 0 ? h : null;
    } catch {
      deps.setWorkAreaH(null);
      return null;
    }
  }

  function invalidate() {
    generation++;
  }

  function targetFromDeps(): number {
    if (deps.fixedHeight()) {
      const declared = deps.modeHeight();
      const configured = Number.isFinite(deps.windowHeight()) ? deps.windowHeight() : 520;
      return Math.max(MIN_WINDOW_H, Math.round(declared ?? configured));
    }
    if (deps.loading()) {
      const searchH =
        (document.querySelector(".search") as HTMLElement | null)?.offsetHeight ?? 0;
      return Math.max(MIN_WINDOW_H, Math.round(searchH));
    }
    if (pageQuery<HTMLElement>(".presenter-error")) {
      const searchH =
        (document.querySelector(".search") as HTMLElement | null)?.offsetHeight ?? 0;
      return errorPageTargetHeight(searchH, window.innerHeight, deps.windowHeight());
    }
    const reportedContentH = deps.fitContentHeight();
    if (reportedContentH != null && Number.isFinite(reportedContentH) && reportedContentH > 0) {
      const searchH =
        (document.querySelector(".search") as HTMLElement | null)?.offsetHeight ?? 0;
      return Math.max(
        MIN_WINDOW_H,
        Math.round(searchH + reportedContentH + WINDOW_PAD),
      );
    }
    const searchH =
      (document.querySelector(".search") as HTMLElement | null)?.offsetHeight ?? 0;
    const container =
      pageQuery<HTMLElement>(".result-grid") ??
      pageQuery<HTMLElement>(".result-list") ??
      pageQuery<HTMLElement>(".bar-list") ??
      pageQuery<HTMLElement>(".nav-list-scroll") ??
      pageQuery<HTMLElement>(".page-hint");
    if (!container) return Math.max(MIN_WINDOW_H, Math.round(searchH));
    measureBarCols();
    const last = container.lastElementChild as HTMLElement | null;
    let contentH = 0;
    if (last) {
      const cr = container.getBoundingClientRect();
      const lr = last.getBoundingClientRect();
      const padBottom = parseFloat(getComputedStyle(container).paddingBottom) || 0;
      contentH = lr.bottom - cr.top + container.scrollTop + padBottom;
    }
    return Math.max(
      MIN_WINDOW_H,
      Math.round(searchH + (contentH > 0 ? contentH + WINDOW_PAD : 0)),
    );
  }

  /** One actual request. It reads the latest deps in one turn after the queue
   * drains, so a burst of triggers collapses to the last page state. */
  async function applyLatest(): Promise<void> {
    const requestGeneration = generation;
    const h = targetFromDeps();
    let cap = deps.windowHeight();
    if (!deps.fixedHeight()) {
      const work = await ensureWorkArea();
      if (requestGeneration !== generation) return;
      if (work) {
        cap = deps.anyExpanded()
          ? Math.max(cap, work - SCREEN_MARGIN)
          : Math.min(cap, work - SCREEN_MARGIN);
      }
    }
    // A fixed page's declared height intentionally overrides the global
    // window-height preference; Rust still clamps it to the live work area.
    // Only fit pages use `window_height` as their content cap.
    const targetH = deps.fixedHeight()
      ? Math.max(MIN_WINDOW_H, Math.round(h))
      : Math.max(MIN_WINDOW_H, Math.min(h, Math.round(cap)));
    const width = Math.round(deps.windowWidth());
    const prepareGeneration = deps.prepareGeneration();
    // A hidden-show preparation MUST reach Rust even when the target equals the
    // current size: the command is also the generation acknowledgement that
    // releases the reveal. Only ordinary visible measurements may dedupe.
    if (prepareGeneration == null && committed?.w === width && committed.h === targetH) {
      requestAnimationFrame(deps.measureModeViewport);
      return;
    }
    try {
      const result = await invoke<{ width: number; height: number }>(
        "apply_launcher_geometry",
        {
          request: {
            width,
            height: targetH,
            expanded: deps.anyExpanded(),
          },
          generation: prepareGeneration,
        },
      );
      if (requestGeneration !== generation) return;
      committed = { w: Math.round(result.width), h: Math.round(result.height) };
      deps.setRuntimeSize(committed.w, committed.h);
      requestAnimationFrame(deps.measureModeViewport);
    } catch (error) {
      // A stale generation is expected during rapid page/monitor changes. A
      // real failure leaves `committed` untouched so retrying is possible.
      if (requestGeneration === generation) {
        console.error("launcher geometry failed:", error);
      }
    }
  }

  /** Serialize geometry commands. While one is in flight, every additional
   * trigger only marks a rerun; the rerun re-reads the latest page state.
   * This is latest-wins coalescing, not an unbounded FIFO. */
  function resizeToContent(): Promise<void> {
    pending = true;
    return new Promise<void>((resolve) => {
      waiters.push(resolve);
      if (!running) {
        running = (async () => {
          let first = true;
          try {
            while (first || pending) {
              first = false;
              pending = false;
              await applyLatest();
            }
          } finally {
            running = null;
            const release = waiters;
            waiters = [];
            for (const resolve of release) resolve();
          }
        })();
      }
    });
  }

  /** Defer a resize to the next frame so the DOM has rendered first. */
  function scheduleResize() {
    requestAnimationFrame(() => void resizeToContent());
  }

  return {
    resizeToContent,
    scheduleResize,
    measureBarCols,
    gridCols,
    invalidate,
  };
}
