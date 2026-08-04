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
  kind: "text" | "image";
  content: string;
  pinned: boolean;
  created_at: number;
  thumb: string | null;
}

/** Open custom context menu: app or clipboard item, positioned at the cursor. */
type MenuState =
  | { kind: "app"; x: number; y: number; app: AppEntry }
  | { kind: "clip"; x: number; y: number; item: ClipboardItem }
  | null;

/** Display label for a clipboard entry (images get their capture time). */
function clipLabel(item: ClipboardItem): string {
  return item.kind === "image"
    ? t("imageLabel", { time: new Date(item.created_at).toLocaleString() })
    : item.content;
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
const MAX_RESULTS_H = 400; // results area content cap (scrolls beyond this)
const MIN_WINDOW_H = 90; // empty-state minimum
// `.results` padding (6+6) + launcher border (2) + 1px gutters (2) + buffer.
const WINDOW_PAD = 20;
let lastWindowH = 0; // avoid resize/center loops

function App() {
  const [appsQuery, setAppsQuery] = createSignal("");
  const [clipQuery, setClipQuery] = createSignal("");
  const [mode, setMode] = createSignal<Mode>("apps");
  /** Max launcher height for auto-sizing (settings → 窗口大小 → 高度). */
  const [windowHeight, setWindowHeight] = createSignal(520);
  /** Launcher width, from settings — the source of truth for resizing (never
   * re-read from the window, which drifts on DPI rounding). */
  const [windowWidth, setWindowWidth] = createSignal(720);
  /** Key that switches Navigate/Clipboard modes (settings → 系统 → 快捷键). */
  const [switchKey, setSwitchKey] = createSignal("Tab");


  // Each mode keeps its own query, so clearing one never resets the other.
  const query = () => (mode() === "apps" ? appsQuery() : clipQuery());
  const setQuery = (q: string) =>
    mode() === "apps" ? setAppsQuery(q) : setClipQuery(q);
  const [apps, setApps] = createSignal<AppEntry[]>([]);
  const [clips, setClips] = createSignal<ClipboardItem[]>([]);
  const [selected, setSelected] = createSignal(0);
  const [iconTick, setIconTick] = createSignal(0);
  const [pinnedApps, setPinnedApps] = createSignal<AppEntry[]>([]);
  const [zone, setZone] = createSignal<"grid" | "bar">("grid");
  const [pinnedSelected, setPinnedSelected] = createSignal(0);
  const [menu, setMenu] = createSignal<MenuState>(null);

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
    setMenu(null);
  }

  /** Reload the pinned-apps bar from the store. */
  async function refreshPins() {
    try {
      const pins = (await invoke("get_pinned_apps")) as AppEntry[];
      setPinnedApps(pins);
      if (pinnedSelected() >= pins.length) setPinnedSelected(0);
      void loadIcons(pins);
      scheduleResize();
    } catch (err) {
      console.error("get_pinned_apps failed", err);
    }
  }

  /** Fit the launcher window height to the current content, then re-center. */
  async function resizeToContent() {
    const search = document.querySelector(".search") as HTMLElement | null;
    const footer = document.querySelector(".shortcut-hint") as HTMLElement | null;
    const pinnedBar = document.querySelector(".pinned-bar") as HTMLElement | null;
    const container =
      (document.querySelector(".result-grid") as HTMLElement | null) ??
      (document.querySelector(".result-list") as HTMLElement | null);
    if (!container) return;

    const searchH = search?.offsetHeight ?? 0;
    const footerH = footer?.offsetHeight ?? 0;
    const pinnedH = pinnedBar ? pinnedBar.getBoundingClientRect().height : 0;

    // Measure the content's natural height from the last child (scrollHeight
    // would clamp to the current viewport for short lists). Correct for any
    // existing scroll so the measurement is scroll-independent.
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
    contentH += pinnedH;

    const targetH = Math.max(
      MIN_WINDOW_H,
      Math.min(searchH + contentH + footerH + WINDOW_PAD, windowHeight()),
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
          await invoke("launch_app", { path: app.path, elevated: true });
          void resetAndHide();
        } catch (err) {
          if (String(err).includes("canceled")) return; // user dismissed UAC
          console.error("launch failed", err);
          void resetAndHide();
        }
      })();
      return;
    }
    void invoke("launch_app", { path: app.path, elevated: false });
    void resetAndHide();
  }

  /** Reveal an app's file in Explorer, keeping the launcher open. */
  function revealInFolder(app: AppEntry) {
    void invoke("reveal_in_folder", { path: app.path }).catch((err) =>
      console.error("reveal failed", err)
    );
  }

  /** Copy a specific clipboard entry back and hide the launcher. */
  function copyClip(item: ClipboardItem) {
    void invoke("copy_clipboard", { id: item.id });
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
      return [
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
        {
          label: t("launchAsAdmin"),
          icon: administratorRunIcon,
          action: () => launchApp(m.app, true),
        },
      ];
    }
    const isPinned = m.item.pinned;
    return [
      { label: t("copyBack"), icon: clipboardIcon, action: () => copyClip(m.item) },
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

  /** Activate the selected entry: launch an app or copy a clipboard entry. */
  function activate() {
    if (mode() === "apps") {
      const item =
        zone() === "bar" ? pinnedApps()[pinnedSelected()] : apps()[selected()];
      if (!item) return;
      void invoke("launch_app", { path: item.path, elevated: false });
      void resetAndHide();
    } else {
      const item = clips()[selected()];
      if (!item) return;
      void invoke("copy_clipboard", { id: item.id });
      void resetAndHide();
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
      // The pinned bar is only present on the empty-query main menu.
      const hasBar = appsQuery() === "" && pinnedApps().length > 0;
      if (!hasResults && !hasBar) return;
      if (e.key === "ArrowLeft") {
        selectionSource = "keyboard";
        e.preventDefault();
        if (zone() === "bar") setPinnedSelected(Math.max(0, pinnedSelected() - 1));
        else moveSelection(-1);
      } else if (e.key === "ArrowRight") {
        selectionSource = "keyboard";
        e.preventDefault();
        if (zone() === "bar")
          setPinnedSelected(Math.min(pinnedApps().length - 1, pinnedSelected() + 1));
        else moveSelection(1);
      } else if (e.key === "ArrowDown") {
        selectionSource = "keyboard";
        e.preventDefault();
        if (zone() === "bar") {
          setZone("grid");
          setSelected(0);
        } else {
          moveSelection(gridCols());
        }
      } else if (e.key === "ArrowUp") {
        selectionSource = "keyboard";
        e.preventDefault();
        const cols = gridCols();
        if (zone() === "grid" && hasBar && selected() < cols) {
          setZone("bar");
          setPinnedSelected(pinnedApps().length - 1);
        } else if (zone() === "grid") {
          moveSelection(-cols);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        activate();
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

  function hintText(): string {
    if (mode() === "apps") {
      // The app index is empty until the file-search iteration lands — point
      // the user at the settings 系统索引 instead of a dead "type to search".
      return query() ? t("noResults") : t("indexEmpty");
    }
    return query() ? t("noResults") : t("noClipboardHistory");
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

    // Load the Navigate pinned bar.
    void refreshPins();

    // Populate the main-menu grid immediately. Without this, the very first
    // show can be blank if the window appears before the webview finishes
    // loading and the focus event is missed (the listener below is async).
    void runSearch("");

    // Focus the search input as soon as the launcher appears.
    document.getElementById("search-input")?.focus();

    // Apply the persisted language + entry-box size, and re-apply whenever the
    // settings window saves / applies (Rust emits `settings-applied`).
    void applyRuntimeSettings();
    const unlistenSettings = await listen("settings-applied", () => {
      void applyRuntimeSettings();
    });
    onCleanup(() => unlistenSettings());

    // The launcher stays hidden between toggles. On every re-show, reset to
    // the Navigate main menu, re-focus the input, and repopulate the grid.
    const unlisten = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) {
        clearSearch();
        void runSearch("");
        queueMicrotask(() => document.getElementById("search-input")?.focus());
      }
    });
    onCleanup(() => unlisten());
  });

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
          placeholder={mode() === "apps" ? t("searchApps") : t("searchClipboard")}
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
        <Show
          when={currentResults().length > 0}
          fallback={<span class="hint">{hintText()}</span>}
        >
          {mode() === "apps" ? (
            <>
              <Show when={appsQuery() === "" && pinnedApps().length > 0}>
                <div class="pinned-bar">
                  <For each={pinnedApps()}>
                    {(app, i) => (
                      <div
                        class="pinned-item"
                        classList={{
                          "result-selected": zone() === "bar" && i() === pinnedSelected(),
                        }}
                        role="option"
                        aria-selected={zone() === "bar" && i() === pinnedSelected()}
                        onMouseMove={() => {
                          selectionSource = "mouse";
                          setZone("bar");
                          setPinnedSelected(i());
                        }}
                        onClick={activate}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setZone("bar");
                          setPinnedSelected(i());
                          setMenu({ kind: "app", x: e.clientX, y: e.clientY, app });
                        }}
                      >
                        <span class="pinned-item-tile">
                          <Show
                            when={iconFor(app.path)}
                            fallback={<img class="pinned-item-img icon-unknown" src={unknownIcon} alt="" />}
                          >
                            <img class="pinned-item-img" src={iconFor(app.path)} alt="" />
                          </Show>
                        </span>
                        <span class="pinned-item-name">{app.name}</span>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
              <div class="result-grid" role="grid">
              <For each={apps()}>
                {(app, i) => (
                  <div
                    class="result-box"
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
                      setZone("grid");
                      setMenu({ kind: "app", x: e.clientX, y: e.clientY, app });
                    }}
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
                )}
              </For>
            </div>
            </>
          ) : (
            <div class="result-list" role="listbox">
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
          )}
        </Show>
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
