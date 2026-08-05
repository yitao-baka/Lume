import { createEffect, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { resolveLocale, setLocale, t } from "./i18n";
import { applyColorMode } from "./theme";
import type { SettingsData } from "./settings/types";
import settingsIcon from "../res/icons/settings.svg";
import navigateIcon from "../res/icons/navigate.svg";
import clipboardIcon from "../res/icons/clipboard.svg";
import runIcon from "../res/icons/normal_run.svg";
import administratorRunIcon from "../res/icons/administrator_run.svg";
import folderOpenIcon from "../res/icons/folder_open.svg";
import pinIcon from "../res/icons/pin.svg";
import pinnedIcon from "../res/icons/pinned.svg";
import deleteIcon from "../res/icons/delete.svg";
import unknownIcon from "../res/icons/unknow_universal.svg";
import "./App.css";

/** Search modes, toggled with Tab or the pills in the search row. */
type Mode = "apps" | "clipboard";

/** A launcher entry as returned by the Rust `search_apps` command. */
interface AppEntry {
  id: number;
  name: string;
  path: string;
}

/** A history entry as returned by the Rust `search_clipboard` command. */
interface ClipboardItem {
  id: number;
  kind: "text" | "image" | "file";
  content: string;
  pinned: boolean;
  created_at: number;
  thumb: string | null;
}

/** Last path segment (handles both `/` and `\` separators). */
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** Open custom context menu: app or clipboard item, positioned at the cursor.
 * `fromRecent` marks an app opened from the 「最近使用」 bar, which adds a
 * soft-delete (remove-from-recent) menu action. */
type MenuState =
  | { kind: "app"; x: number; y: number; app: AppEntry; fromRecent?: boolean }
  | { kind: "clip"; x: number; y: number; item: ClipboardItem }
  | null;

/** Display label for a clipboard entry: images get their capture time, file
 * lists show the single file name or a "N files" count. */
function clipLabel(item: ClipboardItem): string {
  if (item.kind === "image") {
    return t("imageLabel", { time: new Date(item.created_at).toLocaleString() });
  }
  if (item.kind === "file") {
    const paths = item.content.split("\n").filter(Boolean);
    if (paths.length === 1) return basename(paths[0]);
    return t("fileCount", { count: String(paths.length) });
  }
  return item.content;
}

/**
 * In-memory app-icon cache (path → base64 data URI). Mirrors the backend's
 * `IconCache` so re-viewing a result set never re-extracts or re-fetches.
 */
const iconCache = new Map<string, string>();

/** Icons are requested in batches to avoid one huge blocking IPC. */
const ICON_BATCH = 20;

/** Keys the launcher itself handles — the WebView2 blocker never blocks these. */
const APP_KEYS = new Set([
  "Tab", "Enter", "Escape", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

/** Text-editing accelerators allowed inside the search input. */
const EDIT_KEYS = new Set(["c", "v", "x", "a", "z", "y"]);

/** Auto-sizing the launcher window to its content (height only). */
const MIN_WINDOW_H = 90; // empty-state minimum
// `.results` padding (6+6) + launcher border (2) + 1px gutters (2) + buffer.
const WINDOW_PAD = 20;
/** Breathing room kept around the window when an expanded bar fills the screen. */
const SCREEN_MARGIN = 32;
let lastWindowH = 0; // avoid resize/center loops

function App() {
  const [appsQuery, setAppsQuery] = createSignal("");
  const [clipQuery, setClipQuery] = createSignal("");
  const [mode, setMode] = createSignal<Mode>("apps");
  // ── Synchronous initial config from Rust initialization_script ──
  // Window starts hidden; the Rust setup() reads settings.toml and injects
  // it as window.__LUME_CONFIG__ before the webview loads. If missing (very
  // first run, dev), fall back to defaults matching Settings::default().
  const _cfg = (window as any).__LUME_CONFIG__ as SettingsData | undefined;
  const _a = _cfg?.appearance;

  /** Max launcher height for auto-sizing (settings → 窗口大小 → 高度). */
  const [windowHeight, setWindowHeight] = createSignal(_a?.window_height ?? 520);
  /** Logical work-area height of the current monitor (`null` until fetched) —
   * the cap when a bar is expanded. Invalidated on every expand toggle. */
  const [workAreaH, setWorkAreaH] = createSignal<number | null>(null);
  /** Launcher width, from settings — the source of truth for resizing (never
   * re-read from the window, which drifts on DPI rounding). */
  const [windowWidth, setWindowWidth] = createSignal(_a?.window_width ?? 720);
  /** Key that switches Navigate/Clipboard modes (settings → 系统 → 快捷键). */
  const [switchKey, setSwitchKey] = createSignal(_cfg?.hotkeys?.switch_mode || "Tab");
  /** Settings-driven: show the 「最近使用」 bar (display-only toggle). */
  const [showRecent, setShowRecent] = createSignal(_a?.show_recent ?? true);
  /** Settings-driven: start the 「已固定」 bar expanded. */
  const [expandPinned, setExpandPinned] = createSignal(_a?.expand_pinned ?? false);
  /** Settings-driven: Shift+Enter launches with administrator privileges. */
  const [shiftEnterAdmin, setShiftEnterAdmin] = createSignal(_a?.shift_enter_admin !== false);
  /** Settings-driven: entry-box edge length (a CSS var — mirrored as a signal
   * so bar column measurement re-runs when it changes). */
  const [entrySize, setEntrySize] = createSignal(_a?.entry_size ?? 110);
  /** Settings-driven: custom search placeholder per mode ("" = default text). */
  const [placeholderApps, setPlaceholderApps] = createSignal(_a?.search_placeholder_apps || "");
  const [placeholderClipboard, setPlaceholderClipboard] = createSignal(_a?.search_placeholder_clipboard || "");

  // Apply imperative config immediately (locale + theme are not signal-driven).
  setLocale(resolveLocale(_a?.language ?? "system"));
  applyColorMode(_a?.color_mode ?? "system");
  /** Measured column count of a bar grid — drives "one row" (collapsed slice)
   * and the 展开 button's visibility. */
  const [barCols, setBarCols] = createSignal(6);


  // Each mode keeps its own query, so clearing one never resets the other.
  const query = () => (mode() === "apps" ? appsQuery() : clipQuery());
  const setQuery = (q: string) =>
    mode() === "apps" ? setAppsQuery(q) : setClipQuery(q);
  const [apps, setApps] = createSignal<AppEntry[]>([]);
  const [clips, setClips] = createSignal<ClipboardItem[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [iconTick, setIconTick] = createSignal(0);
  const [pinnedApps, setPinnedApps] = createSignal<AppEntry[]>([]);
  const [recentApps, setRecentApps] = createSignal<AppEntry[]>([]);
  const [zone, setZone] = createSignal<"recent" | "pinned" | "grid">("grid");
  const [pinnedSelected, setPinnedSelected] = createSignal(0);
  const [recentSelected, setRecentSelected] = createSignal(0);
  const [recentExpanded, setRecentExpanded] = createSignal(false);
  const [pinnedExpanded, setPinnedExpanded] = createSignal(false);
  const [menu, setMenu] = createSignal<MenuState>(null);

  // ── Drag-and-drop for pinned bar reordering ──
  // Use a plain ref (not a SolidJS signal) so drag event handlers never
  // trigger reactive re-renders that would destroy the dragged DOM element.
  let dragRef: { item: AppEntry; fromIndex: number; overIndex: number } | null = null;

  // Monotonic counter guards against out-of-order search responses.
  let requestSeq = 0;
  // Where the last selection change came from: only keyboard navigation
  // auto-scrolls (mouse hover on a clipped row must not force a scroll).
  let selectionSource: "keyboard" | "mouse" | "other" = "other";

  /** Results for the current mode (reactive). */
  const currentResults = (): (AppEntry | ClipboardItem)[] =>
    mode() === "apps" ? apps() : clips();

  function clearSearch() {
    setAppsQuery("");
    setClipQuery("");
    setApps([]);
    setClips([]);
    setSelected(0);
    setMode("apps");
    setZone("grid");
    setPinnedSelected(0);
    setRecentSelected(0);
    setRecentExpanded(false); // don't persist the expanded state across shows
    setPinnedExpanded(expandPinned());
    setMenu(null);
  }

  /** Reload the pinned-apps bar from the store. */
  async function refreshPins() {
    try {
      const pins = (await invoke("get_pinned_apps")) as AppEntry[];
      setPinnedApps(pins);
      if (pinnedSelected() >= pins.length) setPinnedSelected(0);
      if (pins.length === 0 && zone() === "pinned") {
        setZone(recentApps().length > 0 ? "recent" : "grid");
      }
      void loadIcons(pins);
      scheduleResize();
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
      void loadIcons(recents);
      scheduleResize();
    } catch (err) {
      console.error("get_recent_apps failed", err);
    }
  }

  /** Measure the bar grid's column count (drives the collapsed one-row slice
   * and the 展开 button visibility). auto-fill tracks reflect the container
   * width regardless of how many items are rendered, so this is stable. */
  function measureBarCols() {
    const barGrid = document.querySelector(".bar-grid") as HTMLElement | null;
    if (!barGrid) return;
    const cols = getComputedStyle(barGrid)
      .gridTemplateColumns.split(" ")
      .filter((t) => t.trim() !== "").length;
    if (cols && cols !== barCols()) {
      setBarCols(cols);
      // The collapsed slice changed → re-measure the window against the
      // corrected one-row height (terminates: barCols is now stable).
      scheduleResize();
    }
  }

  /** Fetch the current monitor's logical work-area height once (0/unknown →
   * `null`). Cached until an expand toggle clears it. */
  async function ensureWorkArea() {
    if (workAreaH() != null) return;
    try {
      const h = await invoke<number>("get_work_area");
      setWorkAreaH(h > 0 ? h : null);
    } catch {
      setWorkAreaH(null);
    }
  }

  /** Fit the launcher window height to the current content, then re-center. */
  async function resizeToContent() {
    const search = document.querySelector(".search") as HTMLElement | null;
    const footer = document.querySelector(".shortcut-hint") as HTMLElement | null;
    const container =
      (document.querySelector(".result-grid") as HTMLElement | null) ??
      (document.querySelector(".result-list") as HTMLElement | null) ??
      (document.querySelector(".bar-list") as HTMLElement | null);
    if (!container) return;

    measureBarCols();

    const searchH = search?.offsetHeight ?? 0;
    const footerH = footer?.offsetHeight ?? 0;

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
    let cap = windowHeight();
    if (recentExpanded() || pinnedExpanded()) {
      await ensureWorkArea();
      const screen = workAreaH();
      if (screen) cap = Math.max(windowHeight(), screen - SCREEN_MARGIN);
    }
    const targetH = Math.max(
      MIN_WINDOW_H,
      Math.min(searchH + contentH + footerH + WINDOW_PAD, cap),
    );
    if (targetH === lastWindowH) return;
    lastWindowH = targetH;
    // Set the configured width (from settings) rather than re-reading the
    // current window width: a physical→logical→physical round trip drifts on
    // DPI scaling and the window grows wider on every resize.
    await getCurrentWindow().setSize(new LogicalSize(windowWidth(), targetH));
    await invoke("apply_position");
  }

  /** Defer a resize to the next frame so the DOM has rendered first. */
  function scheduleResize() {
    requestAnimationFrame(() => void resizeToContent());
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

  /** Close the custom context menu. */
  function closeMenu() {
    setMenu(null);
  }

  /** Launch a specific app and hide the launcher. When elevated, waits for the
   * UAC prompt so a cancellation keeps the launcher open instead of hiding. */
  function launchApp(app: AppEntry, elevated = false) {
    if (elevated) {
      void (async () => {
        try {
          await invoke("launch_app", { path: app.path, name: app.name, elevated: true });
          void resetAndHide();
        } catch (err) {
          if (String(err).includes("canceled")) return; // user dismissed UAC
          console.error("launch failed", err);
          void resetAndHide();
        }
      })();
      return;
    }
    void invoke("launch_app", { path: app.path, name: app.name, elevated: false });
    void resetAndHide();
  }

  /** Reveal an app's file in Explorer, keeping the launcher open. */
  function revealInFolder(app: AppEntry) {
    void invoke("reveal_in_folder", { path: app.path }).catch((err) =>
      console.error("reveal failed", err)
    );
  }

  /** Copy a specific clipboard item to the system clipboard and hide. */
  function copyOnly(item: ClipboardItem) {
    void invoke("copy_clipboard", { id: item.id });
    void resetAndHide();
  }

  /** Paste a clipboard entry into the previous foreground window and hide. */
  function pasteClip(item: ClipboardItem) {
    void invoke("paste_clipboard", { id: item.id });
    void resetAndHide();
  }

  /** Pin/unpin a specific clipboard entry (context-menu action). */
  async function toggleClipPin(item: ClipboardItem) {
    try {
      await invoke("pin_clipboard", { id: item.id, pinned: !item.pinned });
    } catch (err) {
      console.error("pin failed", err);
    }
    await runSearch(clipQuery());
  }

  /** Menu entries for the open context menu. */
  function menuItems(m: MenuState): { label: string; icon: string; action: () => void }[] {
    if (!m) return [];
    if (m.kind === "app") {
      const isPinned = pinnedApps().some((p) => p.path === m.app.path);
      const items = [
        {
          label: isPinned ? t("unpin") : t("pin"),
          icon: isPinned ? pinnedIcon : pinIcon,
          action: () => void toggleAppPin(m.app),
        },
        { label: t("launch"), icon: runIcon, action: () => launchApp(m.app) },
        {
          label: t("openFileLocation"),
          icon: folderOpenIcon,
          action: () => revealInFolder(m.app),
        },
      ];
      // The 「最近使用」 bar inserts a soft-delete (remove-from-recent) just
      // before the admin action.
      if (m.fromRecent) {
        items.push({
          label: t("removeFromRecent"),
          icon: deleteIcon,
          action: () => void deleteRecent(m.app),
        });
      }
      items.push({
        label: t("launchAsAdmin"),
        icon: administratorRunIcon,
        action: () => launchApp(m.app, true),
      });
      return items;
    }
    const isPinned = m.item.pinned;
    return [
      { label: t("copyBack"), icon: clipboardIcon, action: () => copyOnly(m.item) },
      { label: t("pasteBack"), icon: clipboardIcon, action: () => pasteClip(m.item) },
      {
        label: isPinned ? t("unpin") : t("pin"),
        icon: isPinned ? pinnedIcon : pinIcon,
        action: () => void toggleClipPin(m.item),
      },
      { label: t("delete"), icon: deleteIcon, action: () => void deleteItem(m.item.id) },
    ];
  }

  async function resetAndHide() {
    clearSearch();
    await invoke("hide_launcher");
  }

  /** Search the active mode's index, dropping stale responses. */
  async function runSearch(q: string) {
    setSelected(0);
    setZone("grid");
    const id = ++requestSeq;
    if (mode() === "apps") {
      if (q.trim() === "") {
        // Empty query shows the two bars (最近使用 / 已固定), not a browse grid.
        setApps([]);
        scheduleResize();
        return;
      }
      const res = (await invoke("search_apps", { query: q })) as AppEntry[];
      if (id === requestSeq) {
        setApps(res);
        void loadIcons(res);
        scheduleResize();
      }
    } else {
      const res = (await invoke("search_clipboard", { query: q })) as ClipboardItem[];
      if (id === requestSeq) {
        setClips(res);
        scheduleResize();
      }
    }
  }

  /** Cached icon for an app path; reactive via `iconTick`. */
  function iconFor(path: string): string | undefined {
    iconTick(); // subscribe the render to icon loading
    return iconCache.get(path);
  }

  /** Fetch icons for the given apps in batches, swapping letter tiles as they arrive. */
  async function loadIcons(apps: AppEntry[]) {
    const missing = apps.map((a) => a.path).filter((p) => !iconCache.has(p));
    for (let i = 0; i < missing.length; i += ICON_BATCH) {
      const batch = missing.slice(i, i + ICON_BATCH);
      try {
        const icons = (await invoke("get_app_icons", { paths: batch })) as {
          path: string;
          icon: string | null;
        }[];
        for (const { path, icon } of icons) {
          if (icon) iconCache.set(path, icon);
        }
        setIconTick((t) => t + 1);
      } catch (err) {
        console.error("loadIcons failed", err);
      }
    }
  }

  async function onInput(e: Event) {
    const q = (e.currentTarget as HTMLInputElement).value;
    setQuery(q);
    await runSearch(q);
  }

  /** Open the settings window (gear button). */
  async function openSettings() {
    try {
      await invoke("open_settings");
    } catch {
      // Settings window missing — ignore.
    }
  }

  /** Apply the persisted settings the launcher renders live: the UI language,
   * the color mode (theme), the entry-box size (a CSS variable) and the max
   * window height. Width/position are Rust-owned. */
  async function applyRuntimeSettings() {
    try {
      const s = await invoke<SettingsData>("get_settings");
      setLocale(resolveLocale(s.appearance.language));
      applyColorMode(s.appearance.color_mode);
      document.documentElement.style.setProperty(
        "--entry-size",
        s.appearance.entry_size + "px"
      );
      setEntrySize(s.appearance.entry_size);
      setShowRecent(s.appearance.show_recent);
      setExpandPinned(s.appearance.expand_pinned || false);
      setShiftEnterAdmin(s.appearance.shift_enter_admin !== false);
      setPlaceholderApps(s.appearance.search_placeholder_apps || "");
      setPlaceholderClipboard(s.appearance.search_placeholder_clipboard || "");
      setWindowHeight(s.appearance.window_height);
      setWindowWidth(s.appearance.window_width);
      setSwitchKey(s.hotkeys.switch_mode || "Tab");
    } catch {
      // Keep defaults if settings can't be read.
    }
  }

  /** True when `e` matches a mode-switch shortcut (a single key like "Tab" or
   * a modifier combo like "Ctrl+Q"). */
  function matchesSwitchKey(e: KeyboardEvent, combo: string): boolean {
    if (!combo) return false;
    const parts = combo.split("+");
    const key = parts[parts.length - 1];
    const mods = parts.slice(0, -1);
    if (mods.length === 0) return e.key === combo;
    if (e.ctrlKey !== mods.includes("Ctrl")) return false;
    if (e.altKey !== mods.includes("Alt")) return false;
    if (e.shiftKey !== mods.includes("Shift")) return false;
    if (e.metaKey !== mods.includes("Super")) return false;
    return e.key.toLowerCase() === key.toLowerCase();
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

  async function switchMode(m: Mode) {
    if (m === mode()) return;
    setMode(m);
    // Re-search the target mode with its own (independent) query.
    await runSearch(m === "apps" ? appsQuery() : clipQuery());
  }

  /** Activate the selected entry: launch an app or paste a clipboard entry. */
  function activate() {
    activateApp(false);
  }

  /** Like activate(), but forces administrator elevation on app launch. */
  function activateAdmin() {
    activateApp(true);
  }

  function activateApp(elevated: boolean) {
    if (mode() === "apps") {
      let item: AppEntry | undefined;
      if (zone() === "recent") item = recentApps()[recentSelected()];
      else if (zone() === "pinned") item = pinnedApps()[pinnedSelected()];
      else item = apps()[selected()];
      if (!item) return;
      void invoke("launch_app", { path: item.path, name: item.name, elevated });
      void resetAndHide();
    } else {
      const item = clips()[selected()];
      if (!item) return;
      pasteClip(item);
    }
  }

  /** Move the selection by `delta` steps, clamped to the result bounds. */
  function moveSelection(delta: number) {
    const len = currentResults().length;
    if (len === 0) return;
    selectionSource = "keyboard";
    setSelected(Math.min(Math.max(selected() + delta, 0), len - 1));
  }

  /** Delete a clipboard entry by id, then refresh results. */
  async function deleteItem(id: number) {
    try {
      await invoke("delete_clipboard", { id });
    } catch (err) {
      console.error("delete failed", err);
    }
    await runSearch(query());
  }

  /** Delete the selected clipboard entry (Del key). */
  async function deleteSelected() {
    const item = clips()[selected()];
    if (item) await deleteItem(item.id);
  }

  /** Bars currently visible on the empty-query main menu, top to bottom. */
  function visibleBars(): ("recent" | "pinned")[] {
    const bars: ("recent" | "pinned")[] = [];
    if (showRecent() && recentApps().length > 0) bars.push("recent");
    if (pinnedApps().length > 0) bars.push("pinned");
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
    const cols = Math.max(barCols(), 1);

    const len = (k: "recent" | "pinned") =>
      (k === "recent" ? recentApps() : pinnedApps()).length;
    const expanded = (k: "recent" | "pinned") =>
      k === "recent" ? recentExpanded() : pinnedExpanded();
    // Navigation rows of a bar: one when collapsed, every row when expanded.
    const rows = (k: "recent" | "pinned") =>
      expanded(k) ? Math.ceil(len(k) / cols) : 1;
    // Items a collapsed bar exposes to navigation: only its first row.
    const reach = (k: "recent" | "pinned") =>
      expanded(k) ? len(k) : Math.min(len(k), cols);

    // The stacked grid, top to bottom: each visible bar contributes its rows.
    const grid: { bar: "recent" | "pinned"; local: number }[] = [];
    for (const k of bars) for (let r = 0; r < rows(k); r++) grid.push({ bar: k, local: r });

    const setIdx = (k: "recent" | "pinned", v: number) =>
      k === "recent" ? setRecentSelected(v) : setPinnedSelected(v);
    const getIdx = (k: "recent" | "pinned") =>
      k === "recent" ? recentSelected() : pinnedSelected();

    // Resolve the current position to a (gridRow, col); with no bar active,
    // start at the top bar.
    let bi = bars.indexOf(zone() as "recent" | "pinned");
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
      // Down: the next row that has an item at this column, wrapping to the top.
      let r = gridRow + 1;
      while (r < grid.length && !hasItem(r)) r++;
      if (r >= grid.length) {
        r = 0;
        while (r < grid.length && !hasItem(r)) r++;
        if (r >= grid.length) return;
      }
      commitGrid(r);
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

  function onKeyDown(e: KeyboardEvent) {
    const hasResults = currentResults().length > 0;
    if (e.key === "Escape") {
      e.preventDefault();
      if (menu()) {
        closeMenu();
      } else {
        void resetAndHide();
      }
    } else if (matchesSwitchKey(e, switchKey())) {
      e.preventDefault();
      void switchMode(mode() === "apps" ? "clipboard" : "apps");
    } else if (mode() === "apps") {
      const empty = appsQuery() === "";
      // ── search results grid (non-empty query) ──
      // Grid navigation always wins when there is a query, regardless of
      // `zone` — the zone signal belongs to the bar view and may carry a
      // stale value from a prior empty-query interaction.
      if (!empty) {
        if (!hasResults) return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          selectionSource = "keyboard";
          moveSelection(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          selectionSource = "keyboard";
          moveSelection(1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          selectionSource = "keyboard";
          moveSelection(gridCols());
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          selectionSource = "keyboard";
          moveSelection(-gridCols());
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey && shiftEnterAdmin()) activateAdmin();
          else activate();
        }
        return;
      }
      // ── empty-query bar navigation (最近使用 / 已固定, one continuous grid) ──
      const hasBars = (showRecent() && recentApps().length > 0) || pinnedApps().length > 0;
      if (!hasBars) return;
      if (e.key === "ArrowLeft") {
        selectionSource = "keyboard";
        e.preventDefault();
        moveBarSelection(-1, 0);
      } else if (e.key === "ArrowRight") {
        selectionSource = "keyboard";
        e.preventDefault();
        moveBarSelection(1, 0);
      } else if (e.key === "ArrowDown") {
        selectionSource = "keyboard";
        e.preventDefault();
        moveBarSelection(0, 1);
      } else if (e.key === "ArrowUp") {
        selectionSource = "keyboard";
        e.preventDefault();
        moveBarSelection(0, -1);
      } else if (e.key === "Delete") {
        // Remove the selected recent entry (soft delete). In the grid zone
        // (typing) Delete falls through to text editing in the search input.
        if (zone() === "recent") {
          e.preventDefault();
          const item = recentApps()[recentSelected()];
          if (item) void deleteRecent(item);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey && shiftEnterAdmin()) activateAdmin();
        else activate();
      }
    } else {
      // Clipboard list navigation.
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (hasResults) {
          e.preventDefault();
          moveSelection(e.key === "ArrowDown" ? 1 : -1);
        }
      } else if (e.key === "Delete") {
        e.preventDefault();
        void deleteSelected();
      } else if (e.key === "Enter") {
        e.preventDefault();
        activate();
      }
    }
  }

  // Handle navigation keys at the window level so they work regardless of
  // which element inside the launcher has focus (e.g. after a stray click).
  createEffect(() => {
    const handler = (e: KeyboardEvent) => onKeyDown(e);
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  // Block every WebView2/Chromium built-in accelerator (Find, Print, Reload,
  // DevTools, history navigation, …) except the keys Lume handles and text
  // editing inside the search input.
  createEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (APP_KEYS.has(e.key)) return; // launcher's own keys
      const input = document.getElementById("search-input");
      const editing = e.ctrlKey && input === document.activeElement;
      if (editing && EDIT_KEYS.has(e.key.toLowerCase())) return; // Ctrl+C/V/… in the input
      if (e.ctrlKey || e.altKey || e.metaKey || /^F\d{1,2}$/.test(e.key)) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));
  });

  // Keep the selected result visible while navigating with the keyboard.
  // Mouse hover selects too, but must not scroll the list (a clipped row
  // hovering would otherwise yank the scroll position).
  createEffect(() => {
    selected();
    if (selectionSource === "keyboard") {
      document
        .querySelector(".result-selected")
        ?.scrollIntoView({ block: "nearest" });
    }
  });

  onMount(async () => {
    // Suppress the WebView2 default (browser-style) context menu everywhere.
    document.addEventListener("contextmenu", (e) => e.preventDefault());

    // ── Native drag-and-drop for pinned-bar reordering ──
    // SolidJS event delegation can interfere with drag events; use raw DOM
    // listeners so preventDefault() always reaches the native event.
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

    document.addEventListener("dragend", (e) => {
      const grid = document.querySelector(".bar-grid") as HTMLElement | null;
      grid?.querySelectorAll(".result-dragging,.result-insert-before,.result-insert-after")
        .forEach((c) => c.classList.remove("result-dragging", "result-insert-before", "result-insert-after"));
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

    // Apply persisted settings FIRST — CSS variables and signals must be
    // ready before the bars render, otherwise the initial paint shows wrong
    // sizes / collapsed state / missing icons.
    // Initial config is already in the signals (window.__LUME_CONFIG__).
    // Runtime settings changes (from the settings window) arrive via the
    // "settings-applied" event and `applyRuntimeSettings`.
    clearSearch();
    void refreshRecent();
    void refreshPins();
    scheduleResize();
    document.getElementById("search-input")?.focus();

    const unlistenSettings = await listen("settings-applied", () => {
      void applyRuntimeSettings();
    });
    onCleanup(() => unlistenSettings());

    // The launcher stays hidden between toggles. On every re-show, reset to
    // the Navigate main menu, re-focus the input, and repopulate the grid.
    // Focus the input now so the first show starts with the cursor in place.
    const unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        clearSearch();
        void refreshRecent();
        void refreshPins();
        queueMicrotask(() => document.getElementById("search-input")?.focus());
      }
    });
    onCleanup(() => unlisten());
  });

  // Sync the entry-size CSS variable whenever the setting changes — decoupled
  // from applyRuntimeSettings timing so the first render always picks up the
  // persisted value.
  createEffect(() => {
    document.documentElement.style.setProperty("--entry-size", entrySize() + "px");
  });

  // Re-measure the bar column count whenever the layout-affecting settings
  // (window width / entry size) change, so "one row" and the 展开 button stay
  // correct. Data-driven re-measurement happens inside resizeToContent.
  createEffect(() => {
    void windowWidth();
    void entrySize();
    requestAnimationFrame(measureBarCols);
  });

  /** A single app box (grid or bar) with a cached icon + unknown-icon fallback. */
  function appBox(
    app: AppEntry,
    selected: boolean,
    handlers: {
      onActivate: () => void;
      onSelect: () => void;
      onContext: (e: MouseEvent) => void;
      draggable?: boolean;
      onDragStart?: (e: DragEvent) => void;
    }
  ) {
    return (
      <div
        class="result-box"
        classList={{
          "result-selected": selected,
        }}
        role="option"
        aria-selected={selected}
        draggable={handlers.draggable ?? false}
        onMouseMove={handlers.onSelect}
        onClick={handlers.onActivate}
        onContextMenu={(e) => {
          e.preventDefault();
          handlers.onContext(e);
        }}
        onDragStart={handlers.onDragStart}
      >
        <Show
          when={iconFor(app.path)}
          fallback={
            <span class="result-box-tile result-box-icon">
              <img class="result-box-img icon-unknown" src={unknownIcon} alt="" />
            </span>
          }
        >
          <span class="result-box-tile result-box-icon">
            <img class="result-box-img" src={iconFor(app.path)} alt="" />
          </span>
        </Show>
        <span class="result-box-name">{app.name}</span>
      </div>
    );
  }

  /** A titled, expandable bar (最近使用 / 已固定) on the empty-query main menu.
   * Collapsed = the measured column count (one row); expanded = everything.
   * The 展开 button only appears when content exceeds one row. */
  function barSection(opts: {
    title: string;
    items: AppEntry[];
    expanded: boolean;
    zoneActive: boolean;
    selected: number;
    draggable?: boolean;
    onToggle: () => void;
    onActivate: () => void;
    onSelect: (i: number) => void;
    onContext: (e: MouseEvent, app: AppEntry) => void;
    onDragStart?: (i: number, e: DragEvent) => void;
  }) {
    const cols = Math.max(barCols(), 1);
    const shown = opts.expanded ? opts.items : opts.items.slice(0, cols);

    return (
      <div class="bar-section">
        <div class="bar-header">
          <span class="bar-title">{opts.title}</span>
          <Show when={opts.items.length > cols}>
            <button class="bar-expand" onClick={opts.onToggle}>
              {opts.expanded ? t("collapse") : t("expand")}
            </button>
          </Show>
        </div>
        <div class="bar-grid" classList={{ collapsed: !opts.expanded }}
          onMouseLeave={() => {
            if (selectionSource === "mouse") opts.onSelect(-1);
          }}
        >
          <For each={shown}>
            {(app, i) =>
              appBox(app, opts.zoneActive && i() === opts.selected, {
                onActivate: opts.onActivate,
                onSelect: () => opts.onSelect(i()),
                onContext: (e) => opts.onContext(e, app),
                draggable: opts.draggable,
                onDragStart: opts.onDragStart ? (e) => opts.onDragStart!(i(), e) : undefined,
              })
            }
          </For>
        </div>
      </div>
    );
  }

  return (
    <div class="launcher">
      {/* The frameless window is draggable from the search row's empty space
          (direct clicks only — the input/pills/gear are clickable and block
          it, per Tauri's data-tauri-drag-region semantics). */}
      <div class="search" data-tauri-drag-region>
        <svg
          class="search-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <input
          id="search-input"
          class="search-input"
          type="text"
          value={query()}
          onInput={onInput}
          placeholder={
            mode() === "apps"
              ? placeholderApps() || t("searchApps")
              : placeholderClipboard() || t("searchClipboard")
          }
          spellcheck={false}
          autocomplete="off"
        />
        <div class="mode-switch" role="tablist" aria-label="Search mode">
          <button
            class="mode-switch-item"
            classList={{ active: mode() === "apps" }}
            role="tab"
            aria-selected={mode() === "apps"}
            onClick={() => void switchMode("apps")}
          >
            <img class="mode-switch-icon" src={navigateIcon} alt="" draggable={false} />
            {t("navigate")}
          </button>
          <button
            class="mode-switch-item"
            classList={{ active: mode() === "clipboard" }}
            role="tab"
            aria-selected={mode() === "clipboard"}
            onClick={() => void switchMode("clipboard")}
          >
            <img class="mode-switch-icon" src={clipboardIcon} alt="" draggable={false} />
            {t("clipboard")}
          </button>
        </div>
        <button
          class="icon-btn"
          title={t("settings")}
          aria-label={t("settings")}
          onClick={() => void openSettings()}
        >
          <img class="icon-btn-icon" src={settingsIcon} alt="" draggable={false} />
        </button>
      </div>
      <div class="results">
        {mode() === "apps" ? (
          appsQuery() === "" ? (
            <div class="bar-list">
              <Show when={showRecent() && recentApps().length > 0}>
                {barSection({
                  title: t("recent"),
                  items: recentApps(),
                  expanded: recentExpanded(),
                  zoneActive: zone() === "recent",
                  selected: recentSelected(),
                  onToggle: () => {
                    setRecentExpanded(!recentExpanded());
                    setWorkAreaH(null); // re-measure the current monitor
                    scheduleResize(); // grow/shrink the window to the bars
                  },
                  onActivate: activate,
                  onSelect: (i) => {
                    selectionSource = "mouse";
                    setZone("recent");
                    setRecentSelected(i);
                  },
                  onContext: (e, app) => {
                    setZone("recent");
                    setRecentSelected(recentApps().findIndex((r) => r.path === app.path));
                    setMenu({ kind: "app", x: e.clientX, y: e.clientY, app, fromRecent: true });
                  },
                })}
              </Show>
              <Show when={pinnedApps().length > 0}>
                {barSection({
                  title: t("pinned"),
                  items: pinnedApps(),
                  expanded: pinnedExpanded(),
                  zoneActive: zone() === "pinned",
                  selected: pinnedSelected(),
                  draggable: true,
                  onToggle: () => {
                    setPinnedExpanded(!pinnedExpanded());
                    setWorkAreaH(null);
                    scheduleResize();
                  },
                  onActivate: activate,
                  onSelect: (i) => {
                    selectionSource = "mouse";
                    setZone("pinned");
                    setPinnedSelected(i);
                  },
                  onContext: (e, app) => {
                    setZone("pinned");
                    setPinnedSelected(pinnedApps().findIndex((p) => p.path === app.path));
                    setMenu({ kind: "app", x: e.clientX, y: e.clientY, app });
                  },
                  onDragStart: (i, e) => {
                    const items = pinnedApps();
                    dragRef = { item: items[i], fromIndex: i, overIndex: i };
                    const src = e.currentTarget as HTMLElement;
                    src.classList.add("result-dragging");
                    if (e.dataTransfer) {
                      e.dataTransfer.setData("text/plain", "");
                      e.dataTransfer.effectAllowed = "move";
                      const clone = src.cloneNode(true) as HTMLElement;
                      clone.style.opacity = "0.6";
                      clone.style.position = "absolute";
                      clone.style.top = "-9999px";
                      clone.style.pointerEvents = "none";
                      document.body.appendChild(clone);
                      const rect = src.getBoundingClientRect();
                      e.dataTransfer.setDragImage(clone, rect.width / 2, rect.height / 2);
                      setTimeout(() => clone.remove(), 0);
                    }
                  },
                })}
              </Show>
            </div>
          ) : (
            <Show when={apps().length > 0} fallback={<span class="hint">{t("noResults")}</span>}>
              <div class="result-grid" role="grid" onMouseLeave={() => { if (selectionSource === "mouse") setSelected(-1); }}>
                {apps().map((app, i) =>
                  appBox(app, i === selected(), {
                    onActivate: activate,
                    onSelect: () => {
                      selectionSource = "mouse";
                      setSelected(i);
                    },
                    onContext: (e) => {
                      setSelected(i);
                      setZone("grid");
                      setMenu({ kind: "app", x: e.clientX, y: e.clientY, app });
                    },
                  })
                )}
              </div>
            </Show>
          )
        ) : (
          <Show when={clips().length > 0} fallback={<span class="hint">{clipQuery() ? t("noResults") : t("noClipboardHistory")}</span>}>
            <div class="result-list" role="listbox" onMouseLeave={() => { if (selectionSource === "mouse") setSelected(-1); }}>
              <For each={clips()}>
                {(item, i) => (
                  <div
                    class="result-item"
                    classList={{ "result-selected": i() === selected() }}
                    role="option"
                    aria-selected={i() === selected()}
                    onMouseMove={() => {
                      selectionSource = "mouse";
                      setSelected(i());
                    }}
                    onClick={activate}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(i());
                      setMenu({ kind: "clip", x: e.clientX, y: e.clientY, item });
                    }}
                  >
                    <Show
                      when={item.kind === "image" && item.thumb}
                      fallback={
                        <span class="result-tile result-tile-clip">
                          {item.kind === "file" ? (
                            <svg
                              class="result-tile-icon"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                              <polyline points="14 2 14 8 20 8" />
                            </svg>
                          ) : (
                            <svg
                              class="result-tile-icon"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              stroke-width="2"
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                              <rect x="8" y="2" width="8" height="4" rx="1" />
                            </svg>
                          )}
                        </span>
                      }
                    >
                      <span class="result-tile result-tile-clip result-tile-image">
                        <img class="result-tile-img" src={item.thumb ?? undefined} alt="" />
                      </span>
                    </Show>
                    <span class="result-content">{clipLabel(item)}</span>
                    <Show when={item.pinned}>
                      <svg
                        class="result-pin"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M12 17v5" />
                        <path d="M9 3h6l1 4H8l1-4z" />
                        <path d="M10 7v4l-2 3h8l-2-3V7" />
                      </svg>
                    </Show>
                    <button
                      class="result-copy"
                      title={t("copyToClipboard")}
                      aria-label={t("copyToClipboard")}
                      onClick={(e) => {
                        e.stopPropagation();
                        copyOnly(item);
                      }}
                    >
                      <svg
                        class="result-copy-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                    <button
                      class="result-delete"
                      title={t("delete")}
                      aria-label={t("delete")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteItem(item.id);
                      }}
                    >
                      <svg
                        class="result-delete-icon"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                        <line x1="10" y1="11" x2="10" y2="17" />
                        <line x1="14" y1="11" x2="14" y2="17" />
                      </svg>
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
        )}
      </div>
      <Show when={mode() === "clipboard"}>
        <div class="shortcut-hint">{t("shortcutHint")}</div>
      </Show>
      <Show when={menu()}>
        <>
          <div
            class="ctx-overlay"
            onClick={closeMenu}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
          />
          <div
            class="ctx-menu"
            style={{
              left: `${Math.min(menu()!.x, window.innerWidth - 170)}px`,
              top: `${Math.min(menu()!.y, window.innerHeight - 140)}px`,
            }}
          >
            <For each={menuItems(menu()!)}>
              {(item) => (
                <button
                  class="ctx-item"
                  onClick={() => {
                    item.action();
                    closeMenu();
                  }}
                >
                  <img class="ctx-item-icon" src={item.icon} alt="" draggable={false} />
                  {item.label}
                </button>
              )}
            </For>
          </div>
        </>
      </Show>
    </div>
  );
}

export default App;
