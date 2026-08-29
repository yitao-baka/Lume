import { createEffect, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { resolveLocale, setLocale, t } from "./i18n";
import { applyColorMode } from "./theme";
import type { SettingsData } from "./settings/types";
import settingsIcon from "../res/icons/settings.svg";
import navigateIcon from "../res/icons/navigate.svg";
import clipboardIcon from "../res/icons/clipboard.svg";
import "./App.css";
import type {
  AppEntry,
  ClipboardItem,
  ClipKind,
  MenuState,
  Mode,
} from "./launcher/types";
import {
  CLIP_ROW_H,
  TOAST_MS,
  TOAST_UNDO_MS,
} from "./launcher/types";
import { createIconStore } from "./launcher/icons";
import { createWindowSizer } from "./launcher/sizing";
import { createNavigateStore } from "./launcher/navigate";
import { createClipboardStore } from "./launcher/clipboard";
import { buildMenuItems } from "./launcher/menu";
import { createKeyRouter } from "./launcher/keyboard";
import { createPreviewSync } from "./launcher/previewSync";
import { NavigateView } from "./launcher/NavigateView";
import { ClipboardView } from "./launcher/ClipboardView";

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
  const [lastPageMode, setLastPageMode] = createSignal<Mode>(
    _a?.last_page === "clipboard" ? "clipboard" : "apps"
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
  const query = () => (mode() === "apps" ? appsQuery() : clipQuery());
  const setQuery = (q: string) =>
    mode() === "apps" ? setAppsQuery(q) : setClipQuery(q);
  const [apps, setApps] = createSignal<AppEntry[]>([]);
  const [clips, setClips] = createSignal<ClipboardItem[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [menu, setMenu] = createSignal<MenuState>(null);

  // ── Clipboard-mode state ──
  // Signals and actions live in the clipboard store (created after the nav
  // store below); the toast + virtual-list container stay here — the toast is
  // shared with Navigate actions and the sizer measures the list viewport.
  const clipCfg = (window as any).__LUME_CONFIG__?.clipboard;
  const [toast, setToast] = createSignal<{ text: string; undo?: () => void } | null>(null);
  let toastTimer: number | undefined;
  /** Virtual-list scroll container + its viewport height (sizer-measured). */
  let clipScrollEl: HTMLDivElement | undefined;
  const [clipViewportH, setClipViewportH] = createSignal(0);

  // Monotonic counter guards against out-of-order search responses.
  let requestSeq = 0;
  // Where the last selection change came from: only keyboard navigation
  // auto-scrolls (mouse hover on a clipped row must not force a scroll).
  let selectionSource: "keyboard" | "mouse" | "other" = "other";

  /** Results for the current mode (reactive). */
  const currentResults = (): (AppEntry | ClipboardItem)[] =>
    mode() === "apps" ? apps() : clips();

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
        setMode("apps");
        clip.setClipKind("all");
      } else if (rememberLastPage()) {
        // 记住上次所在页面 → 恢复它记住的 mode/category (页面偏好, 不受 TTL 限制)。
        const next: Mode = lastPageMode() === "clipboard" ? "clipboard" : "apps";
        setMode(next);
        if (next === "clipboard") clip.setClipKind(lastPageKind() as ClipKind);
      } else {
        // 未记住页面 → 导航页。
        setMode("apps");
        clip.setClipKind("all");
      }
      // 查询一律清空, 落在该页面的默认空态。
      setAppsQuery("");
      setClipQuery("");
    }
    // recall: 保留当前 mode/kind/query 不动, 热键重呼出即恢复这次搜索结果。

    setApps([]);
    setClips([]);
    setSelected(0);
    nav.setZone("grid");
    nav.setPinnedSelected(0);
    nav.setRecentSelected(0);
    nav.setRecentExpanded(false); // don't persist the expanded state across shows
    nav.setPinnedExpanded(expandPinned());
    setMenu(null);
    clip.setMultiIds(new Set<number>());
    clip.setDeletingId(null);
    clip.setClearOpen(false);
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
    const kind = m === "clipboard" ? clip.clipKind() : "all";
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
    mode,
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
    clipViewportH,
    setClipViewportH,
    clipScrollEl: () => clipScrollEl,
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
  const clip = createClipboardStore(
    {
      clips,
      setClips,
      selected,
      query,
      clipQuery,
      clipViewportH,
      showToast,
      markEntryOpened: () => {
        entryOpened = true;
      },
      resetAndHide: () => void resetAndHide(),
      runSearch,
      persistLastPage,
    },
    {
      showSourceApp: clipCfg?.show_source_app ?? true,
      timeDisplayAbs: clipCfg?.time_display === "absolute",
      pasteClose: clipCfg?.paste_close ?? true,
      hoverSelect: clipCfg?.hover_select ?? false,
      previewEnabled: clipCfg?.preview ?? true,
      rememberChecks: clipCfg?.remember_checks ?? true,
    }
  );
  // Satellite-preview sync + window-level keyboard routing.
  const preview = createPreviewSync({
    mode,
    clipKind: clip.clipKind,
    clips,
    selected,
    previewEnabled: clip.previewEnabled,
    rememberChecks: clip.rememberChecks,
  });
  function markKeyboard() {
    selectionSource = "keyboard";
  }
  function markMouse() {
    selectionSource = "mouse";
  }
  function isKeyboard() {
    return selectionSource === "keyboard";
  }
  /** Expanded-bar toggles invalidate the cached work area, then re-measure. */
  function invalidateWorkArea() {
    setWorkAreaH(null);
    sizer.scheduleResize();
  }
  const router = createKeyRouter({
    mode,
    appsQuery,
    clipQuery,
    switchKey,
    shiftEnterAdmin,
    showRecent,
    selected,
    menu,
    currentResults,
    currentPreview: preview.currentPreview,
    setCurrentPreview: preview.setCurrentPreview,
    markKeyboard,
    nav,
    clip,
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
        setApps(res);
        void icons.loadIcons(res);
        sizer.scheduleResize();
      }
    } else {
      const res = (await invoke("search_clipboard", {
        query: q,
        kind: clip.clipKind(),
      })) as ClipboardItem[];
      if (id === requestSeq) {
        setClips(res);
        setSelected(0);
        clip.setClipScrollTop(0);
        sizer.scheduleResize();
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
      setShowExplorerBar(s.appearance.show_explorer_bar ?? true);
      setExpandPinned(s.appearance.expand_pinned || false);
      setShiftEnterAdmin(s.appearance.shift_enter_admin !== false);
      setPlaceholderApps(s.appearance.search_placeholder_apps || "");
      setPlaceholderClipboard(s.appearance.search_placeholder_clipboard || "");
      setWindowHeight(s.appearance.window_height);
      setWindowWidth(s.appearance.window_width);
      setSwitchKey(s.hotkeys.switch_mode || "Tab");
      clip.setShowSourceApp(s.clipboard?.show_source_app ?? true);
      clip.setTimeDisplayAbs(s.clipboard?.time_display === "absolute");
      clip.setPasteClose(s.clipboard?.paste_close ?? true);
      clip.setHoverSelect(s.clipboard?.hover_select ?? false);
      clip.setPreviewEnabled(s.clipboard?.preview ?? true);
      clip.setRememberChecks(s.clipboard?.remember_checks ?? true);
      setRememberLastPage(s.appearance.remember_last_page ?? false);
      setLastPageMode(s.appearance.last_page === "clipboard" ? "clipboard" : "apps");
      setLastPageKind((s.appearance.last_page_kind as ClipKind) ?? "all");
    } catch {
      // Keep defaults if settings can't be read.
    }
  }

  async function switchMode(m: Mode) {
    if (m === mode()) return;
    setMode(m);
    // Clipboard mode always starts on the All category with no multi-select.
    if (m === "clipboard") {
      clip.setClipKind("all");
      clip.setMultiIds(new Set<number>());
      clip.setDeletingId(null);
    }
    sizer.invalidate(); // the fixed-height model differs per mode — force a resize
    persistLastPage();
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
      void invoke("launch_app", { path: item.path, name: item.name, elevated });
      void resetAndHide();
    } else {
      // A non-empty multi-select merges; otherwise paste the single entry.
      if (clip.multiIds().size > 0) {
        clip.pasteClipMulti();
        return;
      }
      const item = clips()[selected()];
      if (!item) return;
      clip.pasteClip(item);
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
    // The apps grid keeps the selected box in view natively; the clipboard
    // list is virtualized and scrolls via its own effect below (scrollIntoView
    // would override the buffered position there).
    if (mode() !== "clipboard" && selectionSource === "keyboard") {
      document
        .querySelector(".result-selected")
        ?.scrollIntoView({ block: "nearest" });
    }
  });

  // Re-measure the virtual list viewport whenever the mode or window height
  // changes (the launcher isn't user-resizable, so the only size changes are
  // ours). Idempotent — settles once the measured height matches.
  createEffect(() => {
    void mode();
    void windowHeight();
    requestAnimationFrame(sizer.measureClipViewport);
  });

  onCleanup(() => clearTimeout(lastPageTimer));

  // Virtual list: keep the selected row in the rendered window while
  // navigating with the keyboard (the row may not be in the DOM otherwise).
  // A small buffer keeps the row clearly inside the viewport (aligning exactly
  // to the bottom edge left it a fraction of a pixel out of view).
  createEffect(() => {
    if (mode() !== "clipboard") return;
    selected();
    void clipViewportH(); // re-scroll when the viewport is resized
    const el = clipScrollEl;
    if (!el || selectionSource !== "keyboard") return;
    const top = selected() * CLIP_ROW_H;
    const bottom = top + CLIP_ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight + 8;
    }
  });

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
    void runSearch(mode() === "apps" ? appsQuery() : clipQuery());
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
      clearSearch();
      await Promise.all([nav.refreshRecent(), nav.refreshPins()]);
      // 记住上次所在页面: a restored Clipboard page must load its history; an
      // apps page re-runs its (session) query or shows the bars.
      await runSearch(mode() === "apps" ? appsQuery() : clipQuery());
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
      preview.setCurrentPreview(null);
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
          <ClipboardView
            clips={clips}
            selected={selected}
            clipQuery={clipQuery}
            clip={clip}
            activate={activate}
            markMouse={markMouse}
            isKeyboard={isKeyboard}
            openMenu={setMenu}
            setSelected={setSelected}
            refScrollEl={(el) => (clipScrollEl = el)}
          />
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
      <Show when={clip.clearOpen()}>
        <div class="clip-confirm">
          <p class="clip-confirm-title">{t("clipClearConfirm")}</p>
          <label class="clip-confirm-check">
            <input
              type="checkbox"
              checked={clip.keepPinned()}
              onChange={(e) =>
                clip.setKeepPinned((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>{t("keepPinned")}</span>
          </label>
          <div class="clip-confirm-actions">
            <button class="clip-confirm-cancel" onClick={() => clip.setClearOpen(false)}>
              {t("cancel")}
            </button>
            <button class="clip-confirm-ok" onClick={clip.doClear}>
              {t("clipClear")}
            </button>
          </div>
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
            <For each={buildMenuItems({ nav, clip }, menu()!)}>
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
