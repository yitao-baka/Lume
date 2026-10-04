//! Composition root / shell — owns the session lifecycle (search recall, mode
//! switching, summon resets) and wires the `PluginServices` every page gets.
//! The surface is the uTools-style splice: the `SearchBox` widget on top, the
//! active page widget (`ModeInstance.View`) below it, and the shared overlays
//! (toast, context menu). Every page below the search box is a plugin — the
//! navigate home page, the clipboard page and disk mode pages all register
//! through the same registry path.

import { createEffect, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { Dynamic } from "solid-js/web";
import { resolveLocale, setLocale, t, type Messages } from "./i18n";
import { applyColorMode } from "./theme";
import type { SettingsData } from "./settings/types";
import "./App.css";
import type { ClipKind, MenuState } from "./launcher/types";
import { MIN_WINDOW_H, TOAST_MS, TOAST_UNDO_MS } from "./launcher/types";
import type { ModeId, PageRow, PluginServices } from "./plugins/types";
import { createIconStore } from "./launcher/icons";
import { createWindowSizer } from "./launcher/sizing";
import { buildMenuItems, type ClipMenuActions, type NavMenuActions } from "./launcher/menu";
import { createKeyRouter } from "./launcher/keyboard";
import { SearchBox, type SearchBoxPage } from "./shell/SearchBox";
import {
  allPlugins,
  applyPluginSettings,
  definePlugin,
  deliverFeature,
  deliverSubInput,
  detachedPluginIds,
  isPluginDetached,
  isPluginDetachable,
  modeById,
  modePlugins,
  onPluginWindowClosed,
  onPluginWindowReady,
  onPluginWindowShown,
  pluginKind,
  refreshPlugins,
  reloadDiskPlugin,
  setPluginDetached,
  setPluginServices,
} from "./plugins/registry";
import { createNavigatePlugin, NAVIGATE_MODE_ID } from "./plugins/navigate";
import { createClipboardPlugin } from "./plugins/clipboard";
import { createPreviewPlugin } from "./plugins/preview";

function App() {
  const [mode, setMode] = createSignal<ModeId>(NAVIGATE_MODE_ID);
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
  /** The size we last applied ourselves (logical px) — the baseline for
   * plugin `app.resize` calls (omitted axes keep "current"). The sizer
   * reports every setSize through it; plugin resize writes it too. */
  const [runtimeSize, setRuntimeSize] = createSignal({
    w: _a?.window_width ?? 720,
    h: _a?.window_height ?? 520,
  });
  /** Key that switches pages (settings → 系统 → 快捷键). */
  const [switchKey, setSwitchKey] = createSignal(_cfg?.hotkeys?.switch_mode || "Tab");
  /** Settings-driven: Shift+Enter launches with administrator privileges. */
  const [shiftEnterAdmin, setShiftEnterAdmin] = createSignal(_a?.shift_enter_admin !== false);
  /** Settings-driven: entry-box edge length (a CSS var — mirrored as a signal
   * so bar column measurement re-runs when it changes). */
  const [entrySize, setEntrySize] = createSignal(_a?.entry_size ?? 110);
  /** Plugin-driven placeholders keyed by plugin id (app.setPlaceholder) —
   * shown while that plugin's mode page is active, "" = default text. */
  const [modePlaceholders, setModePlaceholders] = createSignal<Record<string, string>>({});
  /** Search-box ownership (P2.3): the plugin currently receiving keystrokes
   * instead of a normal search. Cleared on every summon, mode switch and
   * plugin reload — ownership is session state, never persisted. */
  const [subInput, setSubInput] = createSignal<{ pluginId: string; placeholder: string } | null>(null);
  /** Settings-driven: 记住上次所在页面 — restore the last page on the next
   * summon instead of always starting on the home page. */
  const [rememberLastPage, setRememberLastPage] = createSignal(_a?.remember_last_page ?? false);
  /** Last shown page id, restored when 记住上次所在页面 is on. */
  const [lastPageMode, setLastPageMode] = createSignal<ModeId>(_a?.last_page || NAVIGATE_MODE_ID);
  /** Last page kind when the remembered page has one (e.g. the clipboard
   * category). */
  const [lastPageKind, setLastPageKind] = createSignal<ClipKind>(
    (_a?.last_page_kind as ClipKind) ?? "all"
  );

  // Apply imperative config immediately (locale + theme are not signal-driven).
  setLocale(resolveLocale(_a?.language ?? "system"));
  applyColorMode(_a?.color_mode ?? "system");
  /** Measured column count of a bar grid — drives "one row" (collapsed slice)
   * and the 展开 button's visibility. */
  const [barCols, setBarCols] = createSignal(6);

  // Each page keeps its own query, so clearing one never resets the other.
  // Pages live in the registry; the shell reads through the accessors.
  const activeMode = () => modeById(mode());
  const query = (): string => activeMode()?.query() ?? "";
  const setQuery = (q: string) => {
    activeMode()?.setQuery(q);
  };

  const [menu, setMenu] = createSignal<MenuState>(null);
  // ── Shared launcher state ──
  // The toast is shared with every plugin action; pages own their
  // rows/selection/viewport internally (see src/plugins/*/).
  const [toast, setToast] = createSignal<{ text: string; undo?: () => void } | null>(null);
  let toastTimer: number | undefined;

  // Monotonic counter guards against out-of-order search responses.
  let requestSeq = 0;
  // Where the last selection change came from: only keyboard navigation
  // auto-scrolls (mouse hover on a clipped row must not force a scroll).
  let selectionSource: "keyboard" | "mouse" | "other" = "other";

  /** Results for the active page (reactive). */
  const currentResults = (): PageRow[] => activeMode()?.rows() ?? [];

  // 搜索状态记忆: 一次「未打开条目」的搜索会保留到下次呼出 (热键重呼出恢复);
  // 但 5 分钟未再次呼出, 或打开过条目, 则清空查询。记住上次所在页面 (page/kind)
  // 不受 TTL 限制, 只在「打开条目」时被强制覆盖为导航页。查询仅内存, 重启即空。
  const SEARCH_RECALL_MS = 5 * 60 * 1000; // 5 分钟
  let searchRecallAt = 0; // 上次「决定搜索状态」的时间戳 (锚点, 供下呼出算 TTL)
  let entryOpened = false; // 本所示期内是否打开过条目 (打开即清空搜索记忆)

  /** Every page except the home page starts from its default page ("all"). */
  function resetNonHomePages() {
    for (const p of modePlugins()) {
      if (!p.instance.home) p.instance.restorePage("all");
    }
  }

  function clearSearch() {
    const now = Date.now();
    const opened = entryOpened;
    const fresh = now - searchRecallAt <= SEARCH_RECALL_MS;
    entryOpened = false;
    searchRecallAt = now; // 锚定 TTL, 供下次呼出计算 5 分钟间隔
    // 用恢复前的 mode 判定本页面是否有活跃搜索 (决定是否保留查询)。
    const recall = !opened && fresh && query().trim() !== "";

    if (!recall) {
      // 未保留搜索 (打开过条目 / 超过 5 分钟 / 无活跃搜索) → 重置页面与查询。
      if (opened) {
        // 打开条目 → 回到导航页 (空查询)。记住上次所在页面在此被覆盖。
        setMode(NAVIGATE_MODE_ID);
        resetNonHomePages();
      } else if (rememberLastPage()) {
        // 记住上次所在页面 → 恢复它记住的 page/kind (页面偏好, 不受 TTL 限制)。
        let next: ModeId = lastPageMode();
        if (next !== NAVIGATE_MODE_ID && !modeById(next)) next = NAVIGATE_MODE_ID;
        setMode(next);
        if (next !== NAVIGATE_MODE_ID) modeById(next)?.restorePage(lastPageKind());
      } else {
        // 未记住页面 → 导航页。
        setMode(NAVIGATE_MODE_ID);
        resetNonHomePages();
      }
      // 查询一律清空, 落在该页面的默认空态。
      for (const p of allPlugins()) p.mode?.setQuery("");
    }
    // recall: 保留当前 mode/kind/query 不动, 热键重呼出即恢复这次搜索结果。

    activeMode()?.setSelected(0);
    for (const p of allPlugins()) p.mode?.reset();
    setMenu(null);
    // 子输入框是「本次呼出」级状态：新的一次召唤由宿主拥有搜索框。
    setSubInput(null);
    sizer.invalidate(); // force a re-measure on the next show (mode may have changed)
  }

  /** 记住上次所在页面: debounce-persist the current page (page id + kind).
   * Only fires when the toggle is on; a light settings write that never
   * touches backup.toml. */
  let lastPageTimer: number | undefined;
  function persistLastPage() {
    if (!rememberLastPage()) return;
    const m = mode();
    const kind = activeMode()?.pageKind() ?? "all";
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
  // read at call time, so later-created state is safe to close over here.
  const icons = createIconStore();
  const sizer = createWindowSizer({
    // Fit pages (the navigate home) auto-size to content; every other page
    // splices in under the search box at a fixed height.
    fixedHeight: () => (activeMode()?.heightPolicy?.() ?? "fixed") !== "fit",
    windowHeight,
    windowWidth,
    // A page's manifest `height` (desiredHeight) overrides the global setting.
    modeHeight: () => activeMode()?.desiredHeight?.() ?? null,
    setRuntimeSize: (w, h) => setRuntimeSize({ w, h }),
    // The expand flags live in the home page's bar store — read through the
    // page contract; the sizer only calls it at resize time.
    anyExpanded: () => activeMode()?.anyExpanded?.() ?? false,
    workAreaH,
    setWorkAreaH,
    barCols,
    setBarCols,
    measureModeViewport: () => activeMode()?.measureViewport(),
  });

  function markKeyboard() {
    selectionSource = "keyboard";
  }
  function markMouse() {
    selectionSource = "mouse";
  }

  /** Search the active page's index, dropping stale responses (the token
   * bumps on every dispatch; pages compare against `services.searchToken()`). */
  async function runSearch(q: string) {
    activeMode()?.setSelected(0);
    requestSeq++;
    await activeMode()?.search(q);
  }

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

  // The services every plugin receives — late-bound like the sizer deps.
  const services: PluginServices = {
    showToast,
    markEntryOpened: () => {
      entryOpened = true;
    },
    resetAndHide: () => void resetAndHide(),
    persistLastPage,
    scheduleResize: () => sizer.scheduleResize(),
    searchToken: () => requestSeq,
    nextSearchToken: () => ++requestSeq,
    selectionSource: () => selectionSource,
    markMouse,
    openMenu: setMenu,
    mode,
    requestMode: (id) => void switchMode(id),
    runSearch,
    setQuery,
    setModePlaceholder: (pluginId, text) => {
      // Scoped to the caller's own mode id (createHostApi supplies the id) —
      // one plugin can never restyle another's search box.
      setModePlaceholders((prev) => {
        if ((prev[pluginId] ?? "") === text) return prev; // avoid a churn write
        return { ...prev, [pluginId]: text };
      });
    },
    resizeWindow: (size) => {
      // Logical px; omitted axes keep the current size. Height is clamped to
      // the launcher minimum; the size holds until the next content-driven
      // resize (mode switch / Navigate auto-fit re-applies the configured one).
      const cur = runtimeSize();
      const w = Math.max(240, Math.round(size.width ?? cur.w));
      const h = Math.max(MIN_WINDOW_H, Math.round(size.height ?? cur.h));
      setRuntimeSize({ w, h });
      void getCurrentWindow()
        .setSize(new LogicalSize(w, h))
        .then(() => invoke("apply_position"))
        .catch((err) => console.error("resize failed:", err));
    },
    dragWindow: () => {
      // Drag the launcher itself from plugin content (same as the search
      // row's drag region). Needs a user gesture to be useful.
      void getCurrentWindow().startDragging();
    },
    setSubInput: (pluginId, opts) => {
      // P2.3 — one owner at a time; `null` releases. Releasing is a no-op when
      // some other plugin holds the box (a plugin can never steal or drop
      // another's ownership by accident).
      setSubInput((prev) => {
        if (!opts) return prev?.pluginId === pluginId ? null : prev;
        if (prev && prev.pluginId !== pluginId) return prev;
        return { pluginId, placeholder: opts.placeholder ?? "" };
      });
      if (opts && typeof opts.value === "string") {
        setQuery(opts.value);
        if (pluginId === mode()) deliverSubInput(pluginId, opts.value);
      }
    },
    subInputOwner: () => subInput()?.pluginId ?? null,
    enterPlugin: (pluginId, info) => {
      const kind = pluginKind(pluginId);
      if (!kind) return false;
      if (kind === "mode") {
        // The mode is detached: deliver the payload into its window and
        // raise it — no page switch happens here (P6).
        if (isPluginDetached(pluginId)) {
          // Raise/focus first (its shown event replays `show`), then deliver
          // the payload — onEnter pushes it into the window either way.
          void invoke("plugin_window_open", { id: pluginId })
            .then(() => deliverFeature(pluginId, info))
            .catch((err) => console.error("plugin_window_open failed:", err));
          return true;
        }
        // Switch first (the mode's page must exist), then deliver the payload.
        void switchMode(pluginId).then(() => {
          deliverFeature(pluginId, info);
          // The payload may have changed the mode's row source (e.g. a list
          // template's quick-add); re-run its search so rows reflect it.
          const inst = modeById(pluginId);
          if (inst) void runSearch(inst.query());
        });
        return true;
      }
      return deliverFeature(pluginId, info);
    },
  };
  setPluginServices(services);

  // Plugin registration — first-party plugins exercise every v1 contract. The
  // navigate home page registers first so it leads the pill/Tab order.
  const navigatePlugin = createNavigatePlugin(services, {
    icons,
    barCols,
    invalidateWorkArea: () => {
      setWorkAreaH(null);
      sizer.scheduleResize();
    },
  });
  const clipboardPlugin = createClipboardPlugin(services);
  const preview = createPreviewPlugin({
    previewTarget: () => activeMode()?.previewTarget() ?? null,
    enabled: () => activeMode()?.previewEnabled() ?? true,
  });
  definePlugin(navigatePlugin);
  definePlugin(clipboardPlugin);
  definePlugin(preview);
  void refreshPlugins().then(() => void navigatePlugin.refreshBars());

  const router = createKeyRouter({
    mode,
    switchKey,
    modeIds: () => modePlugins().map((m) => m.id),
    shiftEnterAdmin,
    menu,
    currentResults,
    currentPreview: preview.preview!.currentPreview,
    setCurrentPreview: (v) => {
      if (!v) preview.preview!.clear();
    },
    markKeyboard,
    activeMode,
    gridCols: () => sizer.gridCols(),
    moveSelection,
    activate,
    switchMode,
    resetAndHide: () => void resetAndHide(),
    closeMenu,
  });
  // Handle navigation keys at the window level so they work regardless of
  // which element inside the launcher has focus (e.g. after a stray click).
  createEffect(() => {
    onCleanup(router.install());
  });

  /** Search-box placeholder for the active page (P1): subInput ownership wins,
   * then the page's own placeholder, then the plugin `setPlaceholder` map. */
  const placeholder = () => {
    const si = subInput();
    if (si && si.pluginId === mode() && si.placeholder) return si.placeholder;
    return activeMode()?.placeholder?.() ?? (modePlaceholders()[mode()] || t("searchGeneric"));
  };

  /** Page pills, in registry order (the home page registers first). */
  const pages = (): SearchBoxPage[] =>
    modePlugins().map((m) => ({
      id: m.id,
      label: m.modeMeta?.label ?? t((m.modeMeta?.labelKey ?? m.id) as keyof Messages),
      icon: m.modeMeta?.icon,
      active: mode() === m.id,
    }));

  async function handleInput(text: string) {
    setQuery(text);
    // Page-specific interception first (the home page's provider drill-down
    // filter, P2.4), then search-box ownership (P2.3): the owner receives
    // keystrokes through its own onSubInput instead of a normal search.
    if (activeMode()?.handleQuery?.(text)) return;
    const owner = subInput()?.pluginId ?? null;
    if (owner && owner === mode()) {
      deliverSubInput(owner, text);
      return;
    }
    // Disk service plugins see every Navigate keystroke (non-empty).
    if (text.trim()) for (const p of allPlugins()) p.lifecycle?.onQuery?.(text);
    await runSearch(text);
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
      setShiftEnterAdmin(s.appearance.shift_enter_admin !== false);
      setWindowHeight(s.appearance.window_height);
      setWindowWidth(s.appearance.window_width);
      setSwitchKey(s.hotkeys.switch_mode || "Tab");
      // Each page applies its own settings slice (bar visibility, clipboard
      // display flags, placeholders…); the plugin list itself refreshes too
      // (启停 changes land here). If the ACTIVE page was just disabled or
      // removed, fall back to the home page.
      for (const p of allPlugins()) p.mode?.applySettings(s);
      void refreshPlugins().then(() => {
        // Plugin bars ride the same refresh (启停 toggles add/remove bars).
        void navigatePlugin.refreshBars();
        // Detached windows of disabled/removed/reloaded plugins must not
        // linger — close them (P6 consistency).
        for (const id of detachedPluginIds()) {
          if (!modeById(id)) {
            setPluginDetached(id, false);
            void invoke("plugin_window_close", { id }).catch(() => {});
          }
        }
        if (!modeById(mode())) {
          setMode(NAVIGATE_MODE_ID);
          activeMode()?.setQuery("");
          void runSearch("");
        }
      });
      setRememberLastPage(s.appearance.remember_last_page ?? false);
      setLastPageMode(s.appearance.last_page || NAVIGATE_MODE_ID);
      setLastPageKind((s.appearance.last_page_kind as ClipKind) ?? "all");
    } catch {
      // Keep defaults if settings can't be read.
    }
  }

  /** Detach the current mode page into its own window (P6): open (or focus)
   * the `plugin-<id>` window, mark the registry, and hide the launcher —
   * the detached window becomes the mode's home until it is closed. */
  async function detachMode(m: ModeId) {
    try {
      await invoke("plugin_window_open", { id: m });
      setPluginDetached(m, true);
      services.resetAndHide();
    } catch (err) {
      console.error("plugin_window_open failed:", err);
      showToast(t("pluginWindowOpenFailed", { id: m }));
    }
  }

  async function switchMode(m: ModeId) {
    if (m === mode()) return;
    // A detached mode has no page here anymore — activating it raises its
    // window and puts the launcher away, like any app launch.
    if (isPluginDetached(m)) {
      await detachMode(m);
      return;
    }
    setMode(m);
    // 搜索框所有权属于上一个页面：切模式即交还宿主（P2.3）。
    setSubInput(null);
    // Non-home pages always start from a clean page (All category, no
    // multi-select) with their own (independent) query. The home page keeps
    // its session state — search recall depends on it (`home: true`).
    const inst = modeById(m);
    if (inst && !inst.home) {
      inst.restorePage("all");
      inst.reset();
    }
    sizer.invalidate(); // the height model differs per page — force a resize
    persistLastPage();
    // Re-search the target page with its own (independent) query.
    await runSearch(query());
  }

  /** Activate the selected entry via the active page (Shift+Enter = admin). */
  function activate(opts?: { elevated?: boolean }) {
    entryOpened = true; // Enter/点击打开条目 (启动或粘贴) → 清空搜索记忆
    activeMode()?.activate(opts);
  }

  /** Move the selection by `delta` steps, clamped to the result bounds. Pages
   * own their selection signal — reads AND writes must go through the page's
   * accessors, or the root signal drifts apart from what the page's view
   * highlights/activates (this exact drift is what killed clipboard ↑/↓
   * navigation once). */
  function moveSelection(delta: number) {
    const inst = activeMode();
    const len = inst?.rows().length ?? 0;
    if (!inst || len === 0) return;
    selectionSource = "keyboard";
    inst.setSelected(Math.min(Math.max(inst.selected() + delta, 0), len - 1));
  }

  // Re-measure the active page's internal viewport whenever the page or
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

    // Apply persisted settings FIRST — CSS variables and signals must be
    // ready before the bars render, otherwise the initial paint shows wrong
    // sizes / collapsed state / missing icons.
    // Initial config is already in the signals (window.__LUME_CONFIG__).
    // Runtime settings changes (from the settings window) arrive via the
    // "settings-applied" event and `applyRuntimeSettings`.
    clearSearch();
    void runSearch(query());
    // Warm summon-scoped data at mount too (the window starts hidden and the
    // first show may restore a remembered page).
    for (const p of modePlugins()) void p.instance.onShow?.();
    sizer.scheduleResize();
    document.getElementById("search-input")?.focus();

    const unlistenSettings = await listen("settings-applied", () => {
      void applyRuntimeSettings();
    });
    onCleanup(() => unlistenSettings());

    // Settings-pane 重载 button (plugins::reload_plugin): re-import one disk
    // plugin from disk. Bars ride along (a reload may add/remove navBars).
    // A detached window of that plugin is closed first — the reload replaces
    // the whole instance and the user re-detaches.
    const unlistenPluginReload = await listen<string>("plugin-reload", (e) => {
      if (isPluginDetached(e.payload)) {
        setPluginDetached(e.payload, false);
        void invoke("plugin_window_close", { id: e.payload }).catch(() => {});
      }
      void reloadDiskPlugin(e.payload).then(() => navigatePlugin.refreshBars());
    });
    onCleanup(() => unlistenPluginReload());

    // Detached plugin windows (P6): state handshakes + lifecycle. The
    // registry owns the per-plugin push suppliers; these listeners just
    // forward the window events.
    const unlistenPwReady = await listen<string>("plugin-window-ready", (e) => {
      onPluginWindowReady(e.payload);
    });
    onCleanup(() => unlistenPwReady());
    const unlistenPwShown = await listen<string>("plugin-window-shown", (e) => {
      onPluginWindowShown(e.payload);
    });
    onCleanup(() => unlistenPwShown());
    const unlistenPwClosed = await listen<string>("plugin-window-closed", (e) => {
      onPluginWindowClosed(e.payload);
    });
    onCleanup(() => unlistenPwClosed());
    // `app.redirect` from a detached page: route it like any feature entry.
    const unlistenPwRedirect = await listen<{
      from: string;
      pluginId: string;
      info: { code: string; type: string; payload: string };
    }>("plugin-window-redirect", (e) => {
      const { pluginId, info } = e.payload;
      const ok = services.enterPlugin(pluginId, {
        code: info.code,
        type: info.type as "redirect",
        payload: info.payload,
      });
      if (!ok) showToast(t("pluginActionUnavailable", { id: pluginId }));
    });
    onCleanup(() => unlistenPwRedirect());

    // Settings-pane plugin settings (plugin_store::plugin_settings_put →
    // "plugin-settings"): the values changed in the settings window, hand the
    // new set to the plugin instance living here (P3.4).
    const unlistenPluginSettings = await listen<string>("plugin-settings", (e) => {
      void applyPluginSettings(e.payload);
    });
    onCleanup(() => unlistenPluginSettings());

    // OS file drop (P2.2): the Tauri drag-drop handler (enabled on this
    // window only) delivers real paths — WebView2's HTML5 drop never exposes
    // them. Pages own their drop rows (the home page offers matching plugin
    // features); the state clears on the next hide/summon.
    const unlistenDrag = await getCurrentWebview().onDragDropEvent((ev) => {
      if (ev.payload.type !== "drop") return;
      const paths = ev.payload.paths ?? [];
      if (paths.length === 0) return;
      for (const p of modePlugins()) p.instance.onFilesDropped?.(paths);
    });
    onCleanup(() => unlistenDrag());

    // The launcher stays hidden between toggles. On every fresh show (hotkey /
    // tray toggle) reset to the home page, re-focus the input, and repopulate
    // the grid. This listens to the Rust `launcher-shown` event, not
    // `onFocusChanged`: dragging the frameless window briefly deactivates and
    // refocuses it (Rust `is_mid_drag` suppresses the hide on that side), and
    // a reset there would wipe the current mode/search mid-drag.
    const unlisten = await getCurrentWindow().listen("launcher-shown", async () => {
      for (const p of allPlugins()) p.lifecycle?.onShow?.();
      clearSearch();
      // 记住上次所在页面: a restored Clipboard page must load its history; an
      // apps page re-runs its (session) query or shows the bars.
      await runSearch(query());
      // Summon-scoped page refresh (bars, folder context, feature rows) and
      // the empty-menu auto-select land after the summon search.
      for (const p of modePlugins()) await p.instance.onShow?.();
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
    <div class="launcher">
      <SearchBox
        query={query}
        placeholder={placeholder}
        pages={pages}
        onInput={(text) => void handleInput(text)}
        onSwitchPage={(id) => void switchMode(id)}
        onOpenSettings={() => void openSettings()}
      />
      <div class="results">
        <Dynamic component={activeMode()?.View} />
        {/* 分离为独立窗口（P6）— detachable 磁盘 mode 的悬停显现按钮。 */}
        <Show when={isPluginDetachable(mode())}>
          <button
            class="detach-btn"
            title={t("pluginDetach")}
            onClick={() => void detachMode(mode())}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path
                d="M6 3H3.5A1.5 1.5 0 0 0 2 4.5v8A1.5 1.5 0 0 0 3.5 14h8a1.5 1.5 0 0 0 1.5-1.5V10M9.5 2H14v4.5M14 2 7.5 8.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
            {t("pluginDetach")}
          </button>
        </Show>
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
                {
                  nav: navigatePlugin.mode!.menuActions!() as NavMenuActions,
                  clip: clipboardPlugin.mode!.menuActions!() as ClipMenuActions,
                },
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
