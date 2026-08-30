import { createEffect, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Dynamic } from "solid-js/web";
import { resolveLocale, setLocale, t, type Messages } from "./i18n";
import { applyColorMode } from "./theme";
import type { SettingsData } from "./settings/types";
import settingsIcon from "../res/icons/settings.svg";
import navigateIcon from "../res/icons/navigate.svg";
import "./App.css";
import type {
  AppEntry,
  ClipboardItem,
  ClipKind,
  MenuState,
} from "./launcher/types";
import {
  TOAST_MS,
  TOAST_UNDO_MS,
} from "./launcher/types";
import { createIconStore } from "./launcher/icons";
import { createWindowSizer } from "./launcher/sizing";
import { createNavigateStore } from "./launcher/navigate";
import { buildMenuItems } from "./launcher/menu";
import { createKeyRouter } from "./launcher/keyboard";
import { NavigateView } from "./launcher/NavigateView";
import {
  APPS_MODE,
  allPlugins,
  definePlugin,
  modeById,
  modeKeywordMatches,
  modePlugins,
  providerPlugins,
  refreshPlugins,
  setPluginServices,
  type ModeId,
  type PluginServices,
} from "./plugins/registry";
import { createClipboardPlugin } from "./plugins/clipboard";
import { createPreviewPlugin } from "./plugins/preview";

function App() {
  const [appsQuery, setAppsQuery] = createSignal("");
  const [mode, setMode] = createSignal<ModeId>(APPS_MODE);
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
  /** Settings-driven: show the 「Windows 资源管理器」 bar (Explorer folder context). */
  const [showExplorerBar, setShowExplorerBar] = createSignal(_a?.show_explorer_bar ?? true);
  /** Settings-driven: Shift+Enter launches with administrator privileges. */
  const [shiftEnterAdmin, setShiftEnterAdmin] = createSignal(_a?.shift_enter_admin !== false);
  /** Settings-driven: entry-box edge length (a CSS var — mirrored as a signal
   * so bar column measurement re-runs when it changes). */
  const [entrySize, setEntrySize] = createSignal(_a?.entry_size ?? 110);
  /** Settings-driven: custom search placeholder per mode ("" = default text). */
  const [placeholderApps, setPlaceholderApps] = createSignal(_a?.search_placeholder_apps || "");
  const [placeholderClipboard, setPlaceholderClipboard] = createSignal(_a?.search_placeholder_clipboard || "");
  /** Settings-driven: 记住上次所在页面 — restore the last page (mode + clipboard
   * category) on the next summon instead of always starting on Navigate. */
  const [rememberLastPage, setRememberLastPage] = createSignal(_a?.remember_last_page ?? false);
  /** Last shown mode ("apps" | "clipboard"), restored when 记住上次所在页面 is on. */
  const [lastPageMode, setLastPageMode] = createSignal<ModeId>(
    _a?.last_page === "clipboard" ? "clipboard" : APPS_MODE
  );
  /** Last clipboard category when the last page was Clipboard. */
  const [lastPageKind, setLastPageKind] = createSignal<ClipKind>(
    (_a?.last_page_kind as ClipKind) ?? "all"
  );

  // Apply imperative config immediately (locale + theme are not signal-driven).
  setLocale(resolveLocale(_a?.language ?? "system"));
  applyColorMode(_a?.color_mode ?? "system");
  /** Measured column count of a bar grid — drives "one row" (collapsed slice)
   * and the 展开 button's visibility. */
  const [barCols, setBarCols] = createSignal(6);


  // Each mode keeps its own query, so clearing one never resets the other.
  // Plugin modes live in the registry; the root reads through accessors.
  const activeMode = () => modeById(mode());
  const query = (): string =>
    mode() === APPS_MODE ? appsQuery() : (activeMode()?.query() ?? "");
  const setQuery = (q: string) => {
    if (mode() === APPS_MODE) setAppsQuery(q);
    else activeMode()?.setQuery(q);
  };
  const [apps, setApps] = createSignal<AppEntry[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [menu, setMenu] = createSignal<MenuState>(null);

  // ── Shared launcher state ──
  // The toast is shared with every plugin action; plugin modes own their
  // rows/selection/viewport internally (see src/plugins/*/).
  const [toast, setToast] = createSignal<{ text: string; undo?: () => void } | null>(null);
  let toastTimer: number | undefined;

  // Monotonic counter guards against out-of-order search responses.
  let requestSeq = 0;
  // Where the last selection change came from: only keyboard navigation
  // auto-scrolls (mouse hover on a clipped row must not force a scroll).
  let selectionSource: "keyboard" | "mouse" | "other" = "other";

  /** Results for the current mode (reactive). */
  const currentResults = (): (AppEntry | ClipboardItem)[] =>
    mode() === APPS_MODE ? apps() : (activeMode()?.rows() ?? []);

  // 搜索状态记忆: 一次「未打开条目」的搜索会保留到下次呼出 (热键重呼出恢复);
  // 但 5 分钟未再次呼出, 或打开过条目, 则清空查询。记住上次所在页面 (mode/category)
  // 不受 TTL 限制, 只在「打开条目」时被强制覆盖为导航页。查询仅内存, 重启即空。
  const SEARCH_RECALL_MS = 5 * 60 * 1000; // 5 分钟
  let searchRecallAt = 0; // 上次「决定搜索状态」的时间戳 (锚点, 供下呼出算 TTL)
  let entryOpened = false; // 本所示期内是否打开过条目 (打开即清空搜索记忆)

  function clearSearch() {
    const now = Date.now();
    const opened = entryOpened;
    const fresh = now - searchRecallAt <= SEARCH_RECALL_MS;
    entryOpened = false;
    searchRecallAt = now; // 锚定 TTL, 供下次呼出计算 5 分钟间隔
    // 用恢复前的 mode 判定本模式是否有活跃搜索 (决定是否保留查询)。
    const recall = !opened && fresh && query().trim() !== "";

    if (!recall) {
      // 未保留搜索 (打开过条目 / 超过 5 分钟 / 无活跃搜索) → 重置页面与查询。
      if (opened) {
        // 打开条目 → 回到导航页 (apps 空查询)。记住上次所在页面在此被覆盖。
        setMode(APPS_MODE);
        modeById("clipboard")?.restorePage("all");
      } else if (rememberLastPage()) {
        // 记住上次所在页面 → 恢复它记住的 mode/category (页面偏好, 不受 TTL 限制)。
        const next: ModeId = lastPageMode();
        setMode(next);
        if (next !== APPS_MODE) modeById(next)?.restorePage(lastPageKind());
      } else {
        // 未记住页面 → 导航页。
        setMode(APPS_MODE);
        modeById("clipboard")?.restorePage("all");
      }
      // 查询一律清空, 落在该页面的默认空态。
      setAppsQuery("");
      for (const p of allPlugins()) p.mode?.setQuery("");
    }
    // recall: 保留当前 mode/kind/query 不动, 热键重呼出即恢复这次搜索结果。

    setApps([]);
    setSelected(0);
    nav.setZone("grid");
    nav.setPinnedSelected(0);
    nav.setRecentSelected(0);
    nav.setRecentExpanded(false); // don't persist the expanded state across shows
    nav.setPinnedExpanded(expandPinned());
    setMenu(null);
    for (const p of allPlugins()) p.mode?.reset();
    nav.setNavHidden(false); // fresh show always starts with the nav box visible
    sizer.invalidate(); // force a re-measure on the next show (mode may have changed)
  }

  /** 记住上次所在页面: debounce-persist the current page (mode + clipboard
   * category). Only fires when the toggle is on; a light settings write that
   * never touches backup.toml. */
  let lastPageTimer: number | undefined;
  function persistLastPage() {
    if (!rememberLastPage()) return;
    const m = mode();
    const kind = m === APPS_MODE ? "all" : (activeMode()?.pageKind() ?? "all");
    // Update frontend signals so clearSearch() reads the correct values on the
    // next launcher show (the Rust backend writes to file + in-memory, but
    // does not emit settings-applied — so the signals would stay stale).
    setLastPageMode(m);
    setLastPageKind(kind as ClipKind);
    window.clearTimeout(lastPageTimer);
    lastPageTimer = window.setTimeout(() => {
      void invoke("save_last_page", { mode: m, kind }).catch(() => {});
    }, 400);
  }

  // Icon cache + window sizing live in their own modules; the deps object is
  // read at call time, so later-created state (clipScrollEl) is safe to close
  // over here.
  const icons = createIconStore();
  const sizer = createWindowSizer({
    // Plugin modes use the fixed-height model; Navigate auto-fits.
    fixedHeight: () => mode() !== APPS_MODE,
    windowHeight,
    windowWidth,
    // The expand flags live in the navigate store (created below) — read
    // through wrappers; the sizer only calls them at resize time.
    recentExpanded: () => nav.recentExpanded(),
    pinnedExpanded: () => nav.pinnedExpanded(),
    workAreaH,
    setWorkAreaH,
    barCols,
    setBarCols,
    measureModeViewport: () => activeMode()?.measureViewport(),
  });
  // Navigate-mode store: deps methods are hoisted function declarations in
  // this scope, so referencing them here is safe even though they run later.
  const nav = createNavigateStore({
    showRecent,
    showExplorerBar,
    barCols,
    icons,
    scheduleResize: () => sizer.scheduleResize(),
    showToast,
    markEntryOpened: () => {
      entryOpened = true;
    },
    resetAndHide: () => void resetAndHide(),
  });

  // The services every plugin receives — late-bound like the nav deps.
  const services: PluginServices = {
    showToast,
    markEntryOpened: () => {
      entryOpened = true;
    },
    resetAndHide: () => void resetAndHide(),
    persistLastPage,
    scheduleResize: () => sizer.scheduleResize(),
    searchToken: () => requestSeq,
    selectionSource: () => selectionSource,
    markMouse,
    openMenu: setMenu,
    mode,
    requestMode: (id) => void switchMode(id),
    runSearch,
    setQuery,
  };
  setPluginServices(services);
  // Plugin registration — first-party plugins exercise every v1 contract.
  const preview = createPreviewPlugin({
    previewTarget: () =>
      mode() === APPS_MODE ? null : (activeMode()?.previewTarget() ?? null),
    enabled: () =>
      mode() === APPS_MODE ? false : (activeMode()?.previewEnabled() ?? true),
  });
  const clipboardPlugin = createClipboardPlugin(services);
  definePlugin(clipboardPlugin);
  definePlugin(preview);
  void refreshPlugins();
  function markKeyboard() {
    selectionSource = "keyboard";
  }
  function markMouse() {
    selectionSource = "mouse";
  }
  /** Expanded-bar toggles invalidate the cached work area, then re-measure. */
  function invalidateWorkArea() {
    setWorkAreaH(null);
    sizer.scheduleResize();
  }
  const router = createKeyRouter({
    mode,
    appsQuery,
    switchKey,
    shiftEnterAdmin,
    showRecent,
    selected,
    menu,
    currentResults,
    currentPreview: preview.preview!.currentPreview,
    setCurrentPreview: (v) => {
      if (!v) preview.preview!.clear();
    },
    markKeyboard,
    nav,
    activeMode,
    onModeEscape: () => activeMode()?.onEscape() ?? false,
    gridCols: () => sizer.gridCols(),
    moveSelection,
    activate,
    activateAdmin,
    switchMode,
    resetAndHide: () => void resetAndHide(),
    closeMenu,
  });
  // Handle navigation keys at the window level so they work regardless of
  // which element inside the launcher has focus (e.g. after a stray click).
  createEffect(() => {
    onCleanup(router.install());
  });

  /** Show a transient toast at the bottom of the launcher (auto-dismisses). */
  function showToast(text: string, opts?: { undo?: () => void; duration?: number }) {
    window.clearTimeout(toastTimer);
    setToast({ text, undo: opts?.undo });
    toastTimer = window.setTimeout(
      () => setToast(null),
      opts?.duration ?? (opts?.undo ? TOAST_UNDO_MS : TOAST_MS)
    );
  }

  /** Close the custom context menu. */
  function closeMenu() {
    setMenu(null);
  }


  async function resetAndHide() {
    // Lifecycle: the active mode + disk services learn about the hide first.
    activeMode()?.onHide?.();
    for (const p of allPlugins()) p.lifecycle?.onHide?.();
    clearSearch();
    await invoke("hide_launcher");
  }

  /** Search the active mode's index, dropping stale responses. */
  async function runSearch(q: string) {
    setSelected(0);
    nav.setNavHidden(false); // typing reveals the first entry's highlight
    nav.setZone("grid");
    const id = ++requestSeq;
    if (mode() === "apps") {
      if (q.trim() === "") {
        // Empty query shows the two bars (最近使用 / 已固定), not a browse grid.
        setApps([]);
        sizer.scheduleResize();
        return;
      }
      const res = (await invoke("search_apps", { query: q })) as AppEntry[];
      if (id === requestSeq) {
        // Provider results (registry + disk plugins) append after the native
        // index — deduped by path, capped to keep the grid sane.
        const extra: AppEntry[] = [];
        const seen = new Set(res.map((r) => r.path));
        // 全局关键字（uTools 式）: exact match offers an 「进入 <name>」 row.
        for (const kw of modeKeywordMatches(q)) {
          extra.push({ id: -1, name: `进入 ${kw.name}`, path: `lume-mode://${kw.id}` });
        }
        for (const p of providerPlugins()) {
          try {
            const items = await p.instance.search(q);
            if (id !== requestSeq) return;
            for (const it of items ?? []) {
              if (res.length + extra.length >= 20) break;
              if (!it?.name || !it?.path || seen.has(it.path)) continue;
              seen.add(it.path);
              extra.push({ id: 0, name: it.name, path: it.path });
            }
          } catch (err) {
            console.error("provider search failed:", p.id, err);
          }
        }
        const merged = [...res, ...extra];
        setApps(merged);
        void icons.loadIcons(merged);
        sizer.scheduleResize();
      }
    } else {
      // Plugin modes run their own search (stale-guarded by searchToken).
      void id;
      void activeMode()?.search(q);
    }
  }

  async function onInput(e: Event) {
    const q = (e.currentTarget as HTMLInputElement).value;
    setQuery(q);
    // Disk service plugins see every Navigate keystroke (non-empty).
    if (q.trim()) for (const p of allPlugins()) p.lifecycle?.onQuery?.(q);
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
      setShowExplorerBar(s.appearance.show_explorer_bar ?? true);
      setExpandPinned(s.appearance.expand_pinned || false);
      setShiftEnterAdmin(s.appearance.shift_enter_admin !== false);
      setPlaceholderApps(s.appearance.search_placeholder_apps || "");
      setPlaceholderClipboard(s.appearance.search_placeholder_clipboard || "");
      setWindowHeight(s.appearance.window_height);
      setWindowWidth(s.appearance.window_width);
      setSwitchKey(s.hotkeys.switch_mode || "Tab");
      // Each plugin applies its own settings slice (clipboard display flags…);
      // the plugin list itself refreshes too (启停 changes land here). If the
      // ACTIVE mode was just disabled, fall back to Navigate.
      for (const p of allPlugins()) p.mode?.applySettings(s);
      void refreshPlugins().then(() => {
        if (mode() !== APPS_MODE && !modeById(mode())) {
          setMode(APPS_MODE);
          setAppsQuery("");
          void runSearch("");
        }
      });
      setRememberLastPage(s.appearance.remember_last_page ?? false);
      setLastPageMode(s.appearance.last_page === "clipboard" ? "clipboard" : "apps");
      setLastPageKind((s.appearance.last_page_kind as ClipKind) ?? "all");
    } catch {
      // Keep defaults if settings can't be read.
    }
  }

  async function switchMode(m: ModeId) {
    if (m === mode()) return;
    setMode(m);
    // A plugin mode always starts from a clean page (All category, no
    // multi-select) with its own (independent) query.
    const inst = modeById(m);
    if (m !== APPS_MODE && inst) {
      inst.restorePage("all");
      inst.reset();
    }
    sizer.invalidate(); // the fixed-height model differs per mode — force a resize
    persistLastPage();
    // Re-search the target mode with its own (independent) query.
    await runSearch(m === APPS_MODE ? appsQuery() : (inst?.query() ?? ""));
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
    entryOpened = true; // Enter/点击打开条目 (启动或粘贴) → 清空搜索记忆
    if (mode() === "apps") {
      let item: AppEntry | undefined;
      if (nav.zone() === "recent") item = nav.recentApps()[nav.recentSelected()];
      else if (nav.zone() === "pinned") item = nav.pinnedApps()[nav.pinnedSelected()];
      else if (nav.zone() === "folder") {
        nav.activateFolder(nav.folderSelected(), elevated);
        return;
      } else item = apps()[selected()];
      if (!item) return;
      // 全局关键字行：进入对应插件模式（不隐藏，不记为已使用条目）。
      if (item.path.startsWith("lume-mode://")) {
        void switchMode(item.path.slice("lume-mode://".length));
        return;
      }
      void invoke("launch_app", { path: item.path, name: item.name, elevated });
      void resetAndHide();
    } else {
      // Plugin mode: the mode's own activation (merge-paste the selection,
      // else paste the single entry).
      activeMode()?.activate();
    }
  }

  /** Move the selection by `delta` steps, clamped to the result bounds. */
  function moveSelection(delta: number) {
    const len = currentResults().length;
    if (len === 0) return;
    selectionSource = "keyboard";
    nav.setNavHidden(false); // arrow nav reveals the highlight from its hidden position
    setSelected(Math.min(Math.max(selected() + delta, 0), len - 1));
  }

  // Keep the selected result visible while navigating with the keyboard.
  // Mouse hover selects too, but must not scroll the list (a clipped row
  // hovering would otherwise yank the scroll position).
  createEffect(() => {
    selected();
    // The apps grid keeps the selected box in view natively; plugin modes
    // scroll their own lists (scrollIntoView would override their buffered
    // positions).
    if (mode() === APPS_MODE && selectionSource === "keyboard") {
      document
        .querySelector(".result-selected")
        ?.scrollIntoView({ block: "nearest" });
    }
  });

  // Re-measure the active mode's internal viewport whenever the mode or
  // window height changes (the launcher isn't user-resizable, so the only
  // size changes are ours). Idempotent — settles once the measurement matches.
  createEffect(() => {
    void mode();
    void windowHeight();
    requestAnimationFrame(() => activeMode()?.measureViewport());
  });

  onCleanup(() => clearTimeout(lastPageTimer));

  onMount(async () => {
    // Suppress the WebView2 default (browser-style) context menu everywhere.
    document.addEventListener("contextmenu", (e) => e.preventDefault());

    // cmd.exe / powershell.exe icons for the Explorer bar tiles (once).
    void nav.refreshTermIcons();

    // Hide the selection highlight while the cursor rests on empty space (a
    // place with no entry) — mouse navigation is "suspended" until the cursor
    // touches an entry again or an arrow key resumes keyboard navigation. The
    // selection index is retained, so arrow nav reappears from the position it
    // was hidden at (see moveSelection / moveBarSelection). Navigate mode only:
    // the clipboard page keeps its row highlight + satellite preview in sync
    // with the actual selection instead.
    document.addEventListener("mousemove", () => {
      // The last-selected entry stays highlighted even when the cursor rests on
      // empty space inside the window — selection only moves on hover over an
      // entry or an arrow key, and never "disappears" mid-interaction.
      nav.setNavHidden(false);
    });

    // Native drag-and-drop for pinned-bar reordering (raw document listeners
    // live inside the navigate store).
    nav.installDragReorder();

    // Apply persisted settings FIRST — CSS variables and signals must be
    // ready before the bars render, otherwise the initial paint shows wrong
    // sizes / collapsed state / missing icons.
    // Initial config is already in the signals (window.__LUME_CONFIG__).
    // Runtime settings changes (from the settings window) arrive via the
    // "settings-applied" event and `applyRuntimeSettings`.
    clearSearch();
    void nav.refreshRecent();
    void nav.refreshPins();
    // 记住上次所在页面: a remembered Clipboard page must load history on mount
    // too (the window starts hidden and the first show may restore Clipboard).
    void runSearch(mode() === APPS_MODE ? appsQuery() : (activeMode()?.query() ?? ""));
    sizer.scheduleResize();
    document.getElementById("search-input")?.focus();

    const unlistenSettings = await listen("settings-applied", () => {
      void applyRuntimeSettings();
    });
    onCleanup(() => unlistenSettings());

    // The launcher stays hidden between toggles. On every fresh show (hotkey /
    // tray toggle) reset to the Navigate main menu, re-focus the input, and
    // repopulate the grid. This listens to the Rust `launcher-shown` event, not
    // `onFocusChanged`: dragging the frameless window briefly deactivates and
    // refocuses it (Rust `is_mid_drag` suppresses the hide on that side), and a
    // reset there would wipe the current mode/search mid-drag.
    const unlisten = await getCurrentWindow().listen("launcher-shown", async () => {
      for (const p of allPlugins()) p.lifecycle?.onShow?.();
      clearSearch();
      await Promise.all([nav.refreshRecent(), nav.refreshPins()]);
      // 记住上次所在页面: a restored Clipboard page must load its history; an
      // apps page re-runs its (session) query or shows the bars.
      await runSearch(mode() === APPS_MODE ? appsQuery() : (activeMode()?.query() ?? ""));
      // Resolve the Explorer folder context (foreground window at summon) so the
      // 「Windows 资源管理器」 bar can appear on the empty-query menu. Fetched
      // before the auto-select below so a folder-only menu still gets a zone.
      await nav.refreshFolderCtx();
      // Auto-select the first entry of the empty-query main menu: the recent
      // bar's first item when it has any, else the pinned bar's, else the folder
      // bar's. (The bars' highlight requires `zoneActive`, so a resting zone of
      // "grid" would leave nothing selected on summon.)
      if (mode() === "apps" && appsQuery() === "" && nav.zone() === "grid") {
        if (showRecent() && nav.recentApps().length > 0) nav.setZone("recent");
        else if (nav.pinnedApps().length > 0) nav.setZone("pinned");
        else if (nav.folderCtx()) nav.setZone("folder");
      }
      queueMicrotask(() => document.getElementById("search-input")?.focus());
    });
    onCleanup(() => unlisten());

    // The satellite preview's × button (or any Rust-side teardown) clears our
    // Esc-priority state — without this, Esc would think the preview is still
    // open and close a window that is already gone.
    const unlistenPreviewClosed = await getCurrentWindow().listen("preview-closed", () => {
      preview.preview?.clear();
    });
    onCleanup(() => unlistenPreviewClosed());
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
    requestAnimationFrame(sizer.measureBarCols);
  });

  return (
    <div class="launcher" classList={{ "nav-hidden": nav.navHidden() }}>
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
            mode() === APPS_MODE
              ? placeholderApps() || t("searchApps")
              : placeholderClipboard() || t("searchClipboard")
          }
          spellcheck={false}
          autocomplete="off"
        />
        <div class="mode-switch" role="tablist" aria-label="Search mode">
          <button
            class="mode-switch-item"
            classList={{ active: mode() === APPS_MODE }}
            role="tab"
            aria-selected={mode() === APPS_MODE}
            onClick={() => void switchMode(APPS_MODE)}
          >
            <img class="mode-switch-icon" src={navigateIcon} alt="" draggable={false} />
            {t("navigate")}
          </button>
          <For each={modePlugins()}>
            {(m) => (
              <button
                class="mode-switch-item"
                classList={{ active: mode() === m.id }}
                role="tab"
                aria-selected={mode() === m.id}
                onClick={() => void switchMode(m.id)}
              >
                <img
                  class="mode-switch-icon"
                  src={m.modeMeta?.icon}
                  alt=""
                  draggable={false}
                />
                {m.modeMeta?.label ?? t((m.modeMeta?.labelKey ?? m.id) as keyof Messages)}
              </button>
            )}
          </For>
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
        {mode() === APPS_MODE ? (
          <NavigateView
            apps={apps}
            appsQuery={appsQuery}
            selected={selected}
            nav={nav}
            barCols={barCols}
            iconFor={icons.iconFor}
            showRecent={showRecent}
            activate={activate}
            markMouse={markMouse}
            openMenu={setMenu}
            setSelected={setSelected}
            invalidateWorkArea={invalidateWorkArea}
          />
        ) : (
          <Dynamic component={activeMode()?.View} />
        )}
      </div>
      <Show when={toast()}>
        <div class="toast" classList={{ "toast-undo": !!toast()?.undo }}>
          <span class="toast-text">{toast()?.text}</span>
          <Show when={toast()?.undo}>
            <button
              class="toast-undo-btn"
              onClick={() => {
                const undo = toast()?.undo;
                setToast(null);
                undo?.();
              }}
            >
              {t("undo")}
            </button>
          </Show>
        </div>
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
            <For
              each={buildMenuItems(
                { nav, clip: clipboardPlugin.clipMenuActions!() as Parameters<typeof buildMenuItems>[0]["clip"] },
                menu()!
              )}
            >
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
