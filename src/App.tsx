//! Composition root / shell — owns the session lifecycle (keep-alive session
//! continuation, mode switching, summon-scoped re-arms) and wires the
//! `PluginServices` every page gets.
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
import { applyColorMode, currentThemeMode, normalizePluginColorMode } from "./theme";
import { pluginColorMode, pluginColorPref } from "./plugins/themePrefs";
import type { SettingsData } from "./settings/types";
import "./App.css";
import type { ClipKind, MenuState } from "./launcher/types";
import { MIN_WINDOW_H, TOAST_MS, TOAST_UNDO_MS } from "./launcher/types";
import type { MenuStateLike, ModeId, PageRow, PluginServices } from "./plugins/types";
import { createIconStore } from "./launcher/icons";
import { pickIcon } from "./launcher/iconSpec";
import { createWindowSizer } from "./launcher/sizing";
import { buildMenuItems, type ClipMenuActions, type NavMenuActions } from "./launcher/menu";
import { createKeyRouter } from "./launcher/keyboard";
import { SearchBox, type SearchBoxPage } from "./shell/SearchBox";
import {
  allPlugins,
  applyPluginColorMode,
  applyPluginColorPrefsFromSettings,
  applyPluginSettings,
  definePlugin,
  deliverFeature,
  deliverSubInput,
  detachedPluginIds,
  isPluginDetached,
  showsBuiltinDetachButton,
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
import { createHostStack, dropSessionFrame, dropSessionFrames, putSessionFrame } from "./launcher/session";
import { createNavigatePlugin, NAVIGATE_MODE_ID } from "./plugins/navigate";
import { createClipboardPlugin } from "./plugins/clipboard";
import { createPreviewPlugin } from "./plugins/preview";
import { rasterizePluginIcon } from "./plugins/windowIcon";

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
  /** Settings-driven: 模式切换栏仅显示图标 (docs/ROADMAP_HISTORY.md #47, default off —
   * pills keep icon + name). */
  const [modeIconsOnly, setModeIconsOnly] = createSignal(_a?.mode_switch_icons_only ?? false);
  /** Settings-driven: 各模式使用独立搜索词 (docs/ROADMAP_HISTORY.md #48, default off — every
   * mode shares one search-box value and the latest input wins). */
  const [perModeQuery, setPerModeQuery] = createSignal(_a?.per_mode_query ?? false);
  /** Settings-driven: Shift+Enter launches with administrator privileges. */
  const [shiftEnterAdmin, setShiftEnterAdmin] = createSignal(_a?.shift_enter_admin !== false);
  /** Settings-driven: entry-box edge length (a CSS var — mirrored as a signal
   * so bar column measurement re-runs when it changes). */
  const [entrySize, setEntrySize] = createSignal(_a?.entry_size ?? 110);
  /** Plugin-driven placeholders keyed by plugin id (app.setPlaceholder) —
   * shown while that plugin's mode page is active, "" = default text. */
  const [modePlaceholders, setModePlaceholders] = createSignal<Record<string, string>>({});
  /** Search-box ownership : the plugin currently receiving keystrokes
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
  /** Settings-driven: 闲置重置 (docs/ROADMAP_HISTORY.md #46) — after the launcher stayed
   * hidden for this long, the next summon starts clean. */
  const [idleResetEnabled, setIdleResetEnabled] = createSignal(_a?.idle_reset_enabled ?? true);
  const [idleResetMinutes, setIdleResetMinutes] = createSignal(_a?.idle_reset_minutes ?? 30);
  /** Per-plugin exemptions (user override wins over manifest keep_session). */
  const [keepSessionOverrides, setKeepSessionOverrides] = createSignal<Record<string, boolean>>(
    _cfg?.plugins?.keep_session_overrides ?? {}
  );

  // Apply imperative config immediately (locale + theme are not signal-driven).
  setLocale(resolveLocale(_a?.language ?? "system"));
  applyColorMode(_a?.color_mode ?? "system");
  // Per-plugin color-mode overrides (docs/ROADMAP_HISTORY.md #36) before any page renders —
  // the first push into a plugin page's iframe must already be its effective
  // mode, not the launcher's.
  applyPluginColorPrefsFromSettings(_cfg?.plugins?.color_modes);
  /** Measured column count of a bar grid — drives "one row" (collapsed slice)
   * and the 展开 button's visibility. */
  const [barCols, setBarCols] = createSignal(6);

  // Search-box routing (#48): by default every mode shares ONE query — the
  // latest input wins and is mirrored into the active page; the per-mode
  // toggle keeps each page's own in-session query instead. Pages live in the
  // registry; the shell reads through the accessors.
  const activeMode = () => modeById(mode());
  const [sharedQuery, setSharedQuery] = createSignal("");
  /** CDP tap (scripts/cdp_mode_query_verify.mjs) — query routing is otherwise
   * only observable through the final box text. */
  const queryRoute = (entry: Record<string, unknown>) => {
    const w = window as unknown as { __queryRoute?: unknown[] };
    const tap = (w.__queryRoute ??= []);
    tap.push({ at: Date.now(), mode: mode(), ...entry });
    tap.splice(0, Math.max(0, tap.length - 80));
  };
  const query = (): string => (perModeQuery() ? activeMode()?.query() ?? "" : sharedQuery());
  const setQuery = (q: string) => {
    if (!perModeQuery()) setSharedQuery(q);
    activeMode()?.setQuery(q);
    queryRoute({ ev: "set", q, perMode: perModeQuery() });
  };
  /** Clear the box: the shared value (default) plus the active page's mirror;
   * other pages adopt whatever is current when they are activated. */
  function clearActiveQuery(ev: "clear" | "consume" = "clear") {
    if (!perModeQuery()) setSharedQuery("");
    activeMode()?.setQuery("");
    queryRoute({ ev });
  }
  /** #48: a row entry (keyword row / feature payload / mode jump) consumes the
   * shared query — the text is the trigger for the action, not a filter for
   * the page being entered. Per-mode mode keeps every page's own query. */
  function consumeSharedQuery() {
    if (!perModeQuery()) clearActiveQuery("consume");
  }

  // Keep-alive host stack (docs/ROADMAP_HISTORY.md #40): every visited page stays mounted
  // (hidden) so its DOM/JS state survives mode switches and hides; over the
  // cap the LRU page is snapshotted and unmounted, remount restores it.
  const hostStack = createHostStack({
    mode,
    instance: (id) => modeById(id),
    evictable: (id) => !(modeById(id)?.home ?? false),
    maxLive: 8,
  });
  const ensureHost = (id: ModeId) => hostStack.ensure(id);

  /** Retire hosts whose instance was replaced/removed (plugin reload or
   * disable), then make sure the active page still has a live host. */
  function pruneHosts() {
    hostStack.prune((id, inst) => modeById(id) === inst && !isPluginDetached(id));
    if (!isPluginDetached(mode()) && modeById(mode())) ensureHost(mode());
  }

  /** D2 (#40): a user-closed detached window re-docks to that page — state
   * comes back through the session frames on the ready handshake. Runs even
   * while the launcher is hidden, so the next summon lands right there. */
  async function redockMode(id: ModeId) {
    if (!modeById(id) || isPluginDetached(id)) return;
    ensureHost(id);
    setMode(id);
    setSubInput(null);
    // #48: the closed window's final query is the latest input — it becomes
    // the one shared value (the registry already restored the page mirror).
    if (!perModeQuery()) {
      setSharedQuery(modeById(id)?.query() ?? sharedQuery());
      queryRoute({ ev: "adopt", q: sharedQuery() });
    }
    sizer.invalidate();
    await runSearch(query());
  }

  /** D3 (#40): with 记住上次所在页面 on, restore the persisted page across
   * restarts too (the exit-time bookmark clear is gone). Disk mode ids only
   * resolve after the first refreshPlugins() lands, hence the boot hook. */
  let bootRestored = false;
  function restoreLastPageOnBoot() {
    if (bootRestored) return;
    bootRestored = true;
    if (!rememberLastPage()) return;
    const m = lastPageMode();
    if (!m || m === NAVIGATE_MODE_ID || !modeById(m) || isPluginDetached(m)) return;
    ensureHost(m);
    setMode(m);
    modeById(m)?.restorePage(lastPageKind());
    activeMode()?.reset?.();
    void runSearch(query());
    sizer.invalidate();
  }

  const [menu, setMenu] = createSignal<MenuState>(null);
  const [menuIndex, setMenuIndex] = createSignal(0);
  const [menuPos, setMenuPos] = createSignal({ left: 0, top: 0, ready: false });
  let contextMenuEl: HTMLDivElement | undefined;
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

  /** Loading gate: the active page hasn't finished loading yet (its `ready()`
   * reports false). While true, `.results` is hidden, the sizer collapses the
   * window to the search row and the mode's pill shows the loading state —
   * a half-loaded page is never shown. Pages without a `ready` accessor (the
   * home page) are always ready. */
  const pageLoading = (): boolean => !(activeMode()?.ready?.() ?? true);

  // ── 会话续存（docs/ROADMAP_HISTORY.md #40）──
  // hide/show、模式切换与分离回流都不再重置页面：已访问页面保活（隐藏而非
  // 卸载），超上限按 LRU 淘汰并先抓快照；只有显式动作（禁用/重载、首页打开
  // 条目后的查询清空）会动状态。查询与页面状态仅内存，重启不保留。
  let entryOpened = false; // 最近一次条目是否从首页打开（只有首页下次清查询）
  // Idle-reset anchor (docs/ROADMAP_HISTORY.md #46): set from the Rust `launcher-hidden`
  // event, which every hide path emits. 0 = not hidden since boot.
  let lastHiddenAt = 0;

  function markEntryOpened() {
    entryOpened = true;
  }

  /** Idle-reset exemption: the user override wins over the manifest default.
   * The home page is never exempt (it is the reset target). */
  function idleResetExempt(id: ModeId, manifestKeep: boolean): boolean {
    const override = keepSessionOverrides()[id];
    return override !== undefined ? override : manifestKeep;
  }

  /** Whether the launcher was hidden long enough to reset on this show. */
  function idleResetDue(): boolean {
    if (!idleResetEnabled() || lastHiddenAt <= 0) return false;
    const minutes = Math.min(1440, Math.max(1, idleResetMinutes() || 30));
    return Date.now() - lastHiddenAt >= minutes * 60_000;
  }

  /** 闲置重置 (docs/ROADMAP_HISTORY.md #46) — complete reset: home page, empty home query,
   * and every non-exempt plugin page factory-reset (query + page kind +
   * summon state + DOM host + session frames). Exempt pages keep everything
   * (manifest `keep_session` or the user override). A detached window is its
   * own single authority and is never touched here. */
  function applyIdleReset() {
    ensureHost(NAVIGATE_MODE_ID);
    setMode(NAVIGATE_MODE_ID);
    // #48: the shared value is part of the reset — clear it up front so every
    // page adopts the empty state when it is entered next.
    if (!perModeQuery()) setSharedQuery("");
    const home = modeById(NAVIGATE_MODE_ID);
    home?.setQuery("");
    const reset: ModeId[] = [];
    const kept: ModeId[] = [];
    for (const mp of modePlugins()) {
      if (mp.id === NAVIGATE_MODE_ID) continue;
      if (isPluginDetached(mp.id)) {
        kept.push(mp.id);
        continue;
      }
      if (idleResetExempt(mp.id, mp.keepSession)) {
        kept.push(mp.id);
        continue;
      }
      // The query lives in the mode instance (not the iframe), so clear it
      // explicitly — retiring the host alone would resurrect the old query
      // the next time the page is entered.
      mp.instance.setQuery("");
      mp.instance.restorePage("all");
      mp.instance.reset?.();
      dropSessionFrames(mp.id);
      hostStack.retire(mp.id);
      reset.push(mp.id);
    }
    entryOpened = false;
    persistLastPage();
    // CDP tap (scripts/cdp_idle_reset_verify.mjs): what the reset decided.
    const w = window as unknown as { __idleReset?: unknown[] };
    const tap = (w.__idleReset ??= []);
    tap.push({ at: Date.now(), reset, kept });
    tap.splice(0, Math.max(0, tap.length - 40));
  }

  /** Hide-time bookkeeping — summon-scoped state only; pages keep everything. */
  function endSummon() {
    activeMode()?.onHide?.();
    for (const p of allPlugins()) p.lifecycle?.onHide?.();
    setMenu(null);
    setSubInput(null);
  }

  /** Show-time restore (D1): a home-page entry clears the home query only;
   * plugin pages keep query + page state. Invalid active modes fall home. */
  function beginSummon() {
    if (idleResetDue()) {
      lastHiddenAt = 0;
      applyIdleReset();
    }
    if (!modeById(mode())) {
      ensureHost(NAVIGATE_MODE_ID);
      setMode(NAVIGATE_MODE_ID);
    }
    if (entryOpened && mode() === NAVIGATE_MODE_ID) {
      // D1 (#40): a home entry consumed the query — clear it. #48: in shared
      // mode this clears the one value every page adopts on activation.
      if (query() !== "") {
        clearActiveQuery();
        activeMode()?.reset?.();
      }
    }
    entryOpened = false;
    setMenu(null);
    setSubInput(null);
    activeMode()?.setSelected(0);
    activeMode()?.reset?.(); // page-level show (posts `show`; clears enter payload)
    sizer.invalidate();
  }
  /** 记住上次所在页面: debounce-persist the current page (page id + kind)
   * for the NEXT BOOT (in-session continuation is always on, #40). Only
   * fires when the toggle is on; a light settings write that never touches
   * backup.toml. */
  let lastPageTimer: number | undefined;
  function persistLastPage() {
    if (!rememberLastPage()) return;
    const m = mode();
    const kind = activeMode()?.pageKind() ?? "all";
    // Update frontend signals alongside the write (the Rust backend writes to
    // file + in-memory, but does not emit settings-applied — the signals
    // would stay stale for the current process).
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
    // Loading gate: a page that isn't ready collapses the window to the
    // search row (see pageLoading) — checked before the height models below.
    loading: pageLoading,
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
    // Page measurements are scoped to the active keep-alive host (#40).
    activeHost: () => document.querySelector<HTMLElement>(".mode-host.active"),
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
    queryRoute({ ev: "search", q });
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
    if (!menu()) return;
    setMenu(null);
    // The menu is a temporary focus scope; give the caret back to the search
    // box unless the chosen action moves focus itself.
    queueMicrotask(() => document.getElementById("search-input")?.focus());
  }

  /** Open the menu at the pointer with a fresh keyboard selection. */
  function openMenu(state: MenuStateLike) {
    setMenuIndex(0);
    setMenuPos({ left: state.x, top: state.y, ready: false });
    setMenu(state as Exclude<MenuState, null>);
  }

  async function resetAndHide() {
    // Lifecycle first, then hide — no mode/query/page reset (session keep).
    endSummon();
    await invoke("hide_launcher");
  }

  // The services every plugin receives — late-bound like the sizer deps.
  const services: PluginServices = {
    showToast,
    markEntryOpened: () => markEntryOpened(),
    resetAndHide: () => void resetAndHide(),
    detachMode: (pluginId) => void detachMode(pluginId),
    setPluginColorMode: async (pluginId, mode) => {
      // docs/ROADMAP_HISTORY.md #36 — the plugin pins its OWN color mode. Persist first (the
      // write is the contract: a resolved promise means the value survives a
      // restart), then move the live surfaces. Daemon errors reach the page
      // through the bridge reply, so a failed write never looks applied.
      await invoke("set_plugin_color_mode", { id: pluginId, mode });
      applyPluginColorMode(pluginId, mode);
    },
    pluginColorState: (pluginId) => {
      const host = currentThemeMode();
      return { pref: pluginColorPref(pluginId), mode: pluginColorMode(pluginId, host), host };
    },
    persistLastPage,
    scheduleResize: () => sizer.scheduleResize(),
    searchToken: () => requestSeq,
    nextSearchToken: () => ++requestSeq,
    selectionSource: () => selectionSource,
    markMouse,
    openMenu,
    mode,
    requestMode: (id) => {
      // #48: entering a mode from a row consumes the query (see below).
      consumeSharedQuery();
      void switchMode(id);
    },
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
      // — one owner at a time; `null` releases. Releasing is a no-op when
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
        // #48: a payload entry consumes the box — the target page must not be
        // filtered by the entry trigger (matches the pre-#48 empty box).
        consumeSharedQuery();
        // The mode is detached: deliver the payload into its window and
        // raise it — no page switch happens here .
        if (isPluginDetached(pluginId)) {
          // Raise/focus first (its shown event replays `show`), then deliver
          // the payload — onEnter pushes it into the window either way. The
          // icon rides along: this path also covers a stale detached flag
          // whose window is gone and would be recreated .
          pluginWindowIcons(pluginId)
            .then((icons) => invoke("plugin_window_open", { id: pluginId, ...icons }))
            .then(() => deliverFeature(pluginId, info))
            .catch((err) => console.error("plugin_window_open failed:", err));
          return true;
        }
        // Switch first (the mode's page must exist), then deliver the payload.
        void switchMode(pluginId).then(() => {
          deliverFeature(pluginId, info);
          // The payload may have changed the mode's row source (e.g. a list
          // template's quick-add); re-run its search so rows reflect it.
          // `query()` is the box text: the shared value (#48) or, in per-mode
          // mode, the page's own query (active mode = pluginId here).
          if (modeById(pluginId)) void runSearch(query());
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

  /** Context-menu rows for the current target. All labels/actions are rebuilt
   * from the same pure builder the view renders, so keyboard activation can
   * never run a different item than the one highlighted. */
  function menuItems(): ReturnType<typeof buildMenuItems> {
    const m = menu();
    if (!m) return [];
    return buildMenuItems(
      {
        nav: navigatePlugin.mode!.menuActions!() as NavMenuActions,
        clip: clipboardPlugin.mode!.menuActions!() as ClipMenuActions,
      },
      m
    );
  }

  function handleMenuKey(e: KeyboardEvent) {
    const items = menuItems();
    if (items.length === 0) {
      closeMenu();
      return;
    }
    const last = items.length - 1;
    const move = (next: number) => {
      e.preventDefault();
      setMenuIndex(Math.min(Math.max(next, 0), last));
    };
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      move(menuIndex() >= last ? 0 : menuIndex() + 1);
    } else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      move(menuIndex() <= 0 ? last : menuIndex() - 1);
    } else if (e.key === "Home") {
      move(0);
    } else if (e.key === "End") {
      move(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const item = items[menuIndex()];
      closeMenu();
      item?.action();
    }
  }

  /** Measure the rendered menu and flip it around the pointer when either
   * axis would leave the viewport. CSS caps the height; this only chooses the
   * anchor corner using the real size, never a guessed constant. */
  function positionContextMenu() {
    const m = menu();
    const el = contextMenuEl;
    if (!m || !el) return;
    const margin = 6;
    const rect = el.getBoundingClientRect();
    let left = m.x;
    let top = m.y;
    if (left + rect.width > window.innerWidth - margin) left = m.x - rect.width;
    if (top + rect.height > window.innerHeight - margin) top = m.y - rect.height;
    left = Math.max(margin, Math.min(left, window.innerWidth - rect.width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - rect.height - margin));
    setMenuPos({ left, top, ready: true });
  }

  createEffect(() => {
    const m = menu();
    if (!m) return;
    setMenuPos({ left: m.x, top: m.y, ready: false });
    requestAnimationFrame(positionContextMenu);
    const onResize = () => positionContextMenu();
    window.addEventListener("resize", onResize);
    onCleanup(() => window.removeEventListener("resize", onResize));
  });

  // Focus follows the keyboard highlight so screen readers and native button
  // activation agree with the visual menu state.
  createEffect(() => {
    if (!menu()) return;
    const idx = menuIndex();
    requestAnimationFrame(() => {
      const items = contextMenuEl?.querySelectorAll<HTMLButtonElement>(".ctx-item");
      items?.[idx]?.focus({ preventScroll: true });
    });
  });

  void refreshPlugins().then(() => {
    void navigatePlugin.refreshBars();
    restoreLastPageOnBoot();
  });

  const router = createKeyRouter({
    mode,
    switchKey,
    // Hidden modes (manifest `hidden`) are not part of the switch cycle —
    // their entry is the Navigate search row. A hidden ACTIVE mode is not in
    // this list; the router then starts the cycle from the home page.
    modeIds: () => modePlugins().filter((m) => !m.hidden).map((m) => m.id),
    shiftEnterAdmin,
    menu,
    currentResults,
    currentPreview: preview.preview!.currentPreview,
    setCurrentPreview: (v) => {
      if (!v) preview.preview!.clear();
    },
    markKeyboard,
    handleMenuKey,
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

  /** Search-box placeholder for the active page : subInput ownership wins,
   * then the page's own placeholder, then the plugin `setPlaceholder` map. */
  const placeholder = () => {
    const si = subInput();
    if (si && si.pluginId === mode() && si.placeholder) return si.placeholder;
    return activeMode()?.placeholder?.() ?? (modePlaceholders()[mode()] || t("searchGeneric"));
  };

  /** Page pills, in registry order (the home page registers first). Only the
   * active pill can be loading — the spinner belongs to the page being
   * switched to, not to a page that merely hasn't been opened yet. Modes
   * declared `hidden` in their manifest never render a pill (their entry is
   * the Navigate search row); while such a mode is active no pill is
   * highlighted. */
  const pages = (): SearchBoxPage[] =>
    modePlugins()
      .filter((m) => !m.hidden)
      .map((m) => ({
        id: m.id,
        label: m.modeMeta?.label ?? t((m.modeMeta?.labelKey ?? m.id) as keyof Messages),
        icon: m.modeMeta?.icon,
        active: mode() === m.id,
        loading: mode() === m.id && pageLoading(),
      }));

  async function handleInput(text: string) {
    setQuery(text);
    // Page-specific interception first (the home page's provider drill-down
    // filter), then search-box ownership : the owner receives
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
      // Per-plugin color modes ride every settings refresh: the settings
      // window's 「恢复默认设置」, a hand-edited settings.toml and our own
      // `theme.set` writes all land here, and a changed entry re-pushes the
      // plugin's effective mode onto its live surfaces.
      applyPluginColorPrefsFromSettings(s.plugins?.color_modes);
      document.documentElement.style.setProperty(
        "--entry-size",
        s.appearance.entry_size + "px"
      );
      setEntrySize(s.appearance.entry_size);
      setShiftEnterAdmin(s.appearance.shift_enter_admin !== false);
      setModeIconsOnly(s.appearance.mode_switch_icons_only);
      // #48: toggling 各模式独立搜索词 keeps the on-screen text stable.
      // off→on: seed every loaded page with the current shared text (they
      // diverge from there); on→off: the active page's text becomes the one
      // shared value.
      const nextPerMode = s.appearance.per_mode_query ?? false;
      if (nextPerMode !== perModeQuery()) {
        if (nextPerMode) {
          const q = sharedQuery();
          for (const mp of modePlugins()) mp.instance.setQuery(q);
        } else {
          setSharedQuery(activeMode()?.query() ?? "");
        }
        setPerModeQuery(nextPerMode);
        queryRoute({ ev: "toggle", perMode: nextPerMode });
      }
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
        // linger — close them ( consistency).
        for (const id of detachedPluginIds()) {
          if (!modeById(id)) {
            setPluginDetached(id, false);
            void invoke("plugin_window_close", { id }).catch(() => {});
          }
        }
        pruneHosts();
        if (!modeById(mode())) {
          ensureHost(NAVIGATE_MODE_ID);
          setMode(NAVIGATE_MODE_ID);
          clearActiveQuery();
          void runSearch(query());
        }
      });
      setRememberLastPage(s.appearance.remember_last_page ?? false);
      setLastPageMode(s.appearance.last_page || NAVIGATE_MODE_ID);
      setLastPageKind((s.appearance.last_page_kind as ClipKind) ?? "all");
      setIdleResetEnabled(s.appearance.idle_reset_enabled !== false);
      setIdleResetMinutes(s.appearance.idle_reset_minutes ?? 30);
      setKeepSessionOverrides({ ...(s.plugins?.keep_session_overrides ?? {}) });
    } catch {
      // Keep defaults if settings can't be read.
    }
  }

  /** Detach the current mode page into its own window (#40): snapshot
   * the launcher page BEFORE the window exists, hand the frames to the
   * window on its ready push, then retire the launcher host — single
   * authority: from here on the window owns the page until it closes. */
  /** Rasterized taskbar icons for a detached plugin window (themed
   * variants #44): the resolved light/dark set plus whether the plugin
   * declared explicit variants. `plugin_window_open` then picks per the
   * window's effective mode (and never inverts explicit variants); a legacy
   * single icon uploads one PNG and keeps the historical Rust-side
   * inversion. No icon at all leaves the window on the Lume theme icon. */
  async function pluginWindowIcons(
    id: ModeId
  ): Promise<{ iconPng?: string; iconPngDark?: string; iconThemed: boolean }> {
    const spec = modePlugins().find((p) => p.id === id)?.modeMeta?.icon;
    if (!spec) return { iconThemed: false };
    const themed =
      typeof spec === "object" && (spec.light !== undefined || spec.dark !== undefined);
    if (!themed) {
      // Legacy single icon (or a compiled-in built-in URL): one upload, the
      // Rust side inverts it for the dark window variant.
      const legacy = pickIcon(spec, "light");
      const iconPng = legacy ? await rasterizePluginIcon(legacy.src) : undefined;
      return { iconPng, iconThemed: false };
    }
    const light = pickIcon(spec, "light");
    const dark = pickIcon(spec, "dark");
    const [iconPng, iconPngDark] = await Promise.all([
      light ? rasterizePluginIcon(light.src) : Promise.resolve(undefined),
      dark ? rasterizePluginIcon(dark.src) : Promise.resolve(undefined),
    ]);
    return { iconPng, iconPngDark, iconThemed: true };
  }

  async function detachMode(m: ModeId) {
    let stored = false;
    try {
      let snapshot: unknown = null;
      try {
        snapshot = (await modeById(m)?.snapshot?.()) ?? null;
      } catch {
        // 页面快照失败不阻塞 detach —— 退化为仅回放宿主状态。
      }
      // Store BEFORE opening: the window's ready handshake may consume it
      // the moment the page is up (the old order raced that handshake).
      if (snapshot != null) stored = putSessionFrame(m, "view", snapshot);
      await invoke("plugin_window_open", { id: m, ...(await pluginWindowIcons(m)) });
    } catch (err) {
      if (stored) dropSessionFrame(m, "view"); // the live page stays authoritative
      console.error("plugin_window_open failed:", err);
      showToast(t("pluginWindowOpenFailed", { id: m }));
      return;
    }
    setPluginDetached(m, true);
    hostStack.retire(m); // single authority: the window owns the page now
    if (mode() === m) setMode(NAVIGATE_MODE_ID); // launcher stays on a valid page
    services.resetAndHide();
  }

  async function switchMode(m: ModeId) {
    if (m === mode()) return;
    // A detached mode has no page here anymore — activating it raises its
    // window and puts the launcher away, like any app launch.
    if (isPluginDetached(m)) {
      await detachMode(m);
      return;
    }
    ensureHost(m); // keep-alive: mount lazily, then leave it mounted
    setMode(m);
    // 搜索框所有权属于上一个页面：切模式即交还宿主。
    setSubInput(null);
    // #48: in shared mode the incoming page adopts the one query — mirror it
    // into the page before searching so its own query-driven logic (empty
    // state, ←/→ keys) agrees with the box. Per-mode mode keeps its state.
    if (!perModeQuery()) {
      modeById(m)?.setQuery(sharedQuery());
      queryRoute({ ev: "switch", to: m, q: sharedQuery(), mirror: modeById(m)?.query() ?? "" });
    }
    // #40: the target page keeps its session state (query, category, scroll,
    // page JS state) — only explicit resets (reload/disable/home entry) move it.
    sizer.invalidate(); // the height model differs per page — force a resize
    persistLastPage();
    // Re-search with the shared value (#48) or the page's own query.
    await runSearch(query());
  }

  /** Activate the selected entry via the active page (Shift+Enter = admin). */
  function activate(opts?: { elevated?: boolean }) {
    markEntryOpened(); // D1: 只有首页会在下次呼出清空自己的查询
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

  // The loading gate changes the height model (search row alone vs the page's
  // own height): re-measure whenever it flips — into the loading state AND
  // back out of it, so the page appears at its proper size (disk pages push
  // their manifest height, the clipboard the settings height).
  createEffect(() => {
    void pageLoading();
    sizer.scheduleResize();
  });


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
    ensureHost(mode());
    activeMode()?.reset?.();
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
      void reloadDiskPlugin(e.payload).then(() => {
        void navigatePlugin.refreshBars();
        pruneHosts();
      });
    });
    onCleanup(() => unlistenPluginReload());

    // Dev-mode plugin directory watch (#32.7): editing code under plugins/
    // triggers this (the Rust side debounces the burst); refreshPlugins
    // reloads exactly the manifests flagged `development` — the same path as
    // the settings-pane button, minus per-plugin targeting.
    const unlistenDevChanged = await listen("plugin-dev-changed", () => {
      void refreshPlugins().then(() => {
        void navigatePlugin.refreshBars();
        pruneHosts();
      });
    });
    onCleanup(() => unlistenDevChanged());

    // Detached plugin windows: state handshakes + lifecycle. The
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
    const unlistenPwClosed = await listen<{
      id: string;
      snapshot?: unknown;
      query?: string | null;
      user?: boolean;
    }>("plugin-window-closed", (e) => {
      const resumed = onPluginWindowClosed(e.payload);
      if (resumed) void redockMode(resumed); // D2: user close re-docks
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
    // `theme.set` from another window (a detached plugin window, or the
    // plugin's logic iframe): the write is already durable in Rust, but this
    // window owns the preference mirror every `theme` push derives from —
    // without this the launcher would keep pushing the pre-change mode after
    // the plugin comes back from its detached window (docs/ROADMAP_HISTORY.md #36).
    const unlistenPluginColorMode = await listen<{ id: string; mode: string }>(
      "plugin-color-mode",
      (e) => {
        const pref = normalizePluginColorMode(e.payload?.mode);
        if (!pref) {
          console.error("[plugins] bad color mode from a plugin window:", e.payload?.mode);
          return;
        }
        applyPluginColorMode(e.payload.id, pref, "window");
      }
    );
    onCleanup(() => unlistenPluginColorMode());

    // Settings-pane plugin settings (plugin_store::plugin_settings_put →
    // "plugin-settings"): the values changed in the settings window, hand the
    // new set to the plugin instance living here .
    const unlistenPluginSettings = await listen<string>("plugin-settings", (e) => {
      void applyPluginSettings(e.payload);
    });
    onCleanup(() => unlistenPluginSettings());

    // OS file drop : the Tauri drag-drop handler (enabled on this
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
    // tray toggle) the session RESUMES (docs/ROADMAP_HISTORY.md #40): the last page, its
    // query and its page state stay; only summon-scoped bits are re-armed.
    // This listens to the Rust `launcher-shown` event, not `onFocusChanged`:
    // dragging the frameless window briefly deactivates and refocuses it
    // (Rust `is_mid_drag` suppresses the hide on that side), and re-arming
    // there would clear summon-scoped state mid-drag.
    const unlisten = await getCurrentWindow().listen("launcher-shown", async () => {
      for (const p of allPlugins()) p.lifecycle?.onShow?.();
      beginSummon();
      await runSearch(query());
      // Summon-scoped page refresh (bars, folder context, feature rows) and
      // the empty-menu auto-select land after the summon search.
      for (const p of modePlugins()) await p.instance.onShow?.();
      queueMicrotask(() => document.getElementById("search-input")?.focus());
    });
    onCleanup(() => unlisten());

    // Idle-reset anchor (docs/ROADMAP_HISTORY.md #46): every hide path in Rust funnels
    // through `window::hide_main`, which emits this event. The next show
    // compares `Date.now() - lastHiddenAt` — no background timer, so
    // sleep/hibernate count correctly and the hidden webview's throttled
    // timers never matter.
    const unlistenHidden = await getCurrentWindow().listen("launcher-hidden", () => {
      lastHiddenAt = Date.now();
    });
    onCleanup(() => unlistenHidden());

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
        iconsOnly={modeIconsOnly}
        onInput={(text) => void handleInput(text)}
        onSwitchPage={(id) => void switchMode(id)}
        onOpenSettings={() => void openSettings()}
      />
      <div class="results" classList={{ "results-loading": pageLoading() }}>
        {/* Keep-alive pages (#40): every visited mode stays mounted; only the
            active host is laid out (display:contents), the rest are hidden. */}
        <For each={hostStack.hosts()}>
          {(h) => (
            <div class="mode-host" classList={{ active: h.id === mode() }} data-mode={h.id}>
              <Dynamic component={h.inst.View} />
            </div>
          )}
        </For>
        {/* 分离为独立窗口— detachable 磁盘 mode 的悬停显现按钮。
            自绘按钮形态的插件（清单 `detach_button = false`，如 translator）
            不渲染它：右上角让给插件页面，分离走 `app.detach` 桥接接口。 */}
        <Show when={showsBuiltinDetachButton(mode())}>
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
            ref={(el) => (contextMenuEl = el)}
            role="menu"
            style={{
              left: `${menuPos().left}px`,
              top: `${menuPos().top}px`,
              visibility: menuPos().ready ? "visible" : "hidden",
            }}
          >
            <For
              each={menuItems()}
            >
              {(item, idx) => (
                <button
                  class="ctx-item"
                  classList={{ active: menuIndex() === idx() }}
                  role="menuitem"
                  tabIndex={-1}
                  onMouseEnter={() => setMenuIndex(idx())}
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
