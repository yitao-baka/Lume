import { createEffect, createSignal, onCleanup, onMount, Show, For } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { resolveLocale, setLocale, t, type Messages } from "./i18n";
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
  /** Display name of the app that owned the foreground window at capture. */
  source_app: string;
  /** True when the row carries rich-text HTML (offers 「复制为纯文本」). */
  has_html: boolean;
  /** Number of copy pieces merged into this row (1 = single copy). */
  merged_count: number;
}

/** A deleted entry returned by `delete_clipboard`, kept for the undo buffer. */
interface DeletedClip {
  kind: string;
  content: string;
  path: string | null;
  pinned: boolean;
  created_at: number;
  source_app: string;
}

/** A clipboard filter category (`favorites` = pinned only). 文本文件/图片/视频
 * are content-kind filters over file rows (图片 also includes image rows). */
type ClipKind = "all" | "text" | "textfile" | "image" | "video" | "favorites";

/** Payload pushed to the satellite preview window (mirrors the Rust
 * `PreviewRequest` in window.rs). */
interface PreviewReq {
  kind: "text" | "textfile" | "image" | "audio" | "video";
  content: string | null;
  path: string | null;
  id: number | null;
}

/** Last path segment (handles both `/` and `\` separators). */
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

// ── Text subtype detection (URL / color) — display-time classification ──
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_RE =
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)$/;
const HSL_RE =
  /^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*[\d.]+)?\s*\)$/;

function isUrl(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/\S+/i.test(t) || /^www\.\S+/i.test(t);
}

/** A color value when the whole (trimmed) text is a supported color. */
function detectColor(text: string): string | null {
  const t = text.trim();
  if (HEX_RE.test(t) || RGB_RE.test(t) || HSL_RE.test(t)) return t;
  return null;
}

/** First line of a clipboard row: image/file label, a merged-copy title, the
 * color value, or text/URL. */
function clipTitle(item: ClipboardItem): string {
  if (item.kind === "image") return t("imageTitle");
  if (item.kind === "file") {
    const paths = item.content.split("\n").filter(Boolean);
    if (paths.length === 1) return basename(paths[0]);
    return t("fileCount", { count: String(paths.length) });
  }
  // 合并复制 N 条 — the full joined text stays available on hover / paste.
  if (item.merged_count >= 2) {
    return t("clipMergedCount", { count: String(item.merged_count) });
  }
  return item.content;
}

/** Relative ("3 min ago") or absolute timestamp, driven by settings. */
function clipTime(ts: number, absolute: boolean): string {
  if (absolute) return new Date(ts).toLocaleString();
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return t("timeJustNow");
  if (min < 60) return t("timeMinutes", { n: String(min) });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t("timeHours", { n: String(hr) });
  return t("timeDays", { n: String(Math.floor(hr / 24)) });
}

/** Second line of a clipboard row: source app · time (source toggleable). */
function clipMeta(item: ClipboardItem, showSource: boolean, absolute: boolean): string {
  const time = clipTime(item.created_at, absolute);
  if (showSource && item.source_app) return `${item.source_app} · ${time}`;
  return time;
}

/** A file's content kind (by extension) — drives the tile icon and whether
 * the preview pane opens. `"other"` (binaries like .dll/.exe/.zip) never opens
 * the preview pane. */
type FileContent = "text" | "audio" | "video" | "image" | "other";
const TEXT_EXTS = new Set([
  "txt","md","log","json","rs","toml","ini","cfg","py","js","ts","html","css",
  "xml","yaml","yml","csv","sh","bat","ps1","sql","c","cpp","h","java","go","lua",
]);
const AUDIO_EXTS = new Set(["mp3","wav","flac","ogg","m4a","aac","wma","opus","mid","midi"]);
const VIDEO_EXTS = new Set(["mp4","mkv","webm","mov","avi","wmv","flv","m4v","mpg","mpeg"]);
const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","bmp","webp","ico","svg","tif","tiff"]);

function fileContent(name: string): FileContent {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_EXTS.has(ext)) return "text";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  return "other";
}

/** Build the satellite-preview payload for a row, or null when no preview
 * should show (the window then hides). Only *content* previews: file rows whose
 * content kind (by extension) is text/audio/video/image, plus clipboard image
 * rows (`kind === "image"` — a captured screenshot) which preview in every
 * category. Plain copied text (kind `"text"`) never opens the satellite, and
 * "other" binaries (.dll/.exe/.zip…) never do. Image-kind rows carry an `id`
 * resolved via `get_clipboard_image`; image-file rows a `path`. */
function previewTarget(item: ClipboardItem | undefined): PreviewReq | null {
  if (!item) return null;
  if (item.kind === "text") return null; // plain copied text — never previews
  if (item.kind === "image") return { kind: "image", content: null, path: null, id: item.id };
  const first = item.content.split("\n").find(Boolean) ?? "";
  const fc = fileContent(basename(first));
  if (fc === "text") return { kind: "textfile", content: null, path: first, id: null };
  if (fc === "audio") return { kind: "audio", content: null, path: first, id: null };
  if (fc === "video") return { kind: "video", content: null, path: first, id: null };
  if (fc === "image") return { kind: "image", content: null, path: first, id: null };
  return null; // "other" — binary; no preview
}

/** Open custom context menu: app or clipboard item, positioned at the cursor.
 * `fromRecent` marks an app opened from the 「最近使用」 bar, which adds a
 * soft-delete (remove-from-recent) menu action. */
type MenuState =
  | { kind: "app"; x: number; y: number; app: AppEntry; fromRecent?: boolean }
  | { kind: "clip"; x: number; y: number; item: ClipboardItem }
  | null;

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
/** Fixed row height of a clipboard row (44–52px per the redesign spec). */
const CLIP_ROW_H = 52;
/** Extra rows rendered above/below the visible window in the virtual list. */
const CLIP_OVERSCAN = 4;
/** How long the delete-collapse animation runs before the row is removed. */
const DELETE_ANIM_MS = 120;

/** The clipboard filter tabs, in display order (labels are i18n keys). */
const CLIP_CATS: { kind: ClipKind; label: string }[] = [
  { kind: "all", label: "clipCategoryAll" },
  { kind: "text", label: "clipCategoryText" },
  { kind: "textfile", label: "clipCategoryTextFile" },
  { kind: "image", label: "clipCategoryImage" },
  { kind: "video", label: "clipCategoryVideo" },
  { kind: "favorites", label: "clipCategoryFavorites" },
];
/** Default toast dwell (ms); undo toasts get a longer window. */
const TOAST_MS = 1600;
const TOAST_UNDO_MS = 3000;
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

  // ── Clipboard-mode state (redesign: categories, multi-select, undo, toast) ──
  const clipCfg = (window as any).__LUME_CONFIG__?.clipboard;
  /** Active history filter category. */
  const [clipKind, setClipKind] = createSignal<ClipKind>("all");
  /** Ids toggled with Space — Enter merges-pastes exactly this set. */
  const [multiIds, setMultiIds] = createSignal<Set<number>>(new Set());
  /** Bottom toast; `undo` (delete) restores the last deletion. */
  const [toast, setToast] = createSignal<{ text: string; undo?: () => void } | null>(null);
  /** The last deleted entry, held for the undo button. */
  const [undoBuf, setUndoBuf] = createSignal<DeletedClip | null>(null);
  /** Id whose row is animating out (delete-in-progress). */
  const [deletingId, setDeletingId] = createSignal<number | null>(null);
  /** Clear-all confirm dialog visibility. */
  const [clearOpen, setClearOpen] = createSignal(false);
  /** 清空 → keep pinned rows (confirm-dialog checkbox). */
  const [keepPinned, setKeepPinned] = createSignal(false);
  /** Settings-driven: show the source app in the second line. */
  const [showSourceApp, setShowSourceApp] = createSignal(clipCfg?.show_source_app ?? true);
  /** Settings-driven: absolute timestamps instead of relative. */
  const [timeDisplayAbs, setTimeDisplayAbs] = createSignal(clipCfg?.time_display === "absolute");
  /** Settings-driven: hide the launcher after a paste. */
  const [pasteClose, setPasteClose] = createSignal(clipCfg?.paste_close ?? true);
  /** Settings-driven: mouse hover selects entries (default off — a click is
   * the only way to select with the mouse when off). */
  const [hoverSelect, setHoverSelect] = createSignal(clipCfg?.hover_select ?? false);
  /** Runtime pause for clipboard recording (status-bar toggle, not persisted). */
  const [clipPaused, setClipPaused] = createSignal(false);
  let toastTimer: number | undefined;
  /** Virtual-list scroll container + its scroll/viewport state. */
  let clipScrollEl: HTMLDivElement | undefined;
  const [clipScrollTop, setClipScrollTop] = createSignal(0);
  const [clipViewportH, setClipViewportH] = createSignal(0);
  /** First/last rendered row of the windowed clipboard list. */
  const clipStart = () =>
    Math.max(0, Math.floor(clipScrollTop() / CLIP_ROW_H) - CLIP_OVERSCAN);
  const clipEnd = () =>
    Math.min(
      clips().length,
      Math.ceil((clipScrollTop() + Math.max(clipViewportH(), 160)) / CLIP_ROW_H) +
        CLIP_OVERSCAN
    );
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
    setMultiIds(new Set<number>());
    setDeletingId(null);
    setClearOpen(false);
    lastWindowH = 0; // force a re-measure on the next show (mode may have changed)
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
    // Clipboard mode uses a fixed window height (设置 → 窗口大小 → 高度); the
    // list viewport scrolls internally, so no content-based fitting applies.
    // Previews live in the satellite window now, so the launcher never widens.
    if (mode() === "clipboard") {
      if (windowHeight() !== lastWindowH) {
        lastWindowH = windowHeight();
        await getCurrentWindow().setSize(new LogicalSize(windowWidth(), windowHeight()));
        await invoke("apply_position");
      }
      requestAnimationFrame(measureClipViewport);
      return;
    }
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
    // The bar-expand cap only applies on the Navigate page — the Clipboard page
    // must not inherit a bar's expanded size when switching modes.
    let cap = windowHeight();
    if (mode() === "apps" && (recentExpanded() || pinnedExpanded())) {
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

  /** Re-read the virtual list's viewport height (idempotent). */
  function measureClipViewport() {
    const el = clipScrollEl;
    if (!el) return;
    const h = el.clientHeight;
    if (h !== clipViewportH()) setClipViewportH(h);
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

  /** Show a transient toast at the bottom of the launcher (auto-dismisses). */
  function showToast(text: string, opts?: { undo?: () => void; duration?: number }) {
    window.clearTimeout(toastTimer);
    setToast({ text, undo: opts?.undo });
    toastTimer = window.setTimeout(
      () => setToast(null),
      opts?.duration ?? (opts?.undo ? TOAST_UNDO_MS : TOAST_MS)
    );
  }

  /** Copy a specific clipboard item to the system clipboard. The launcher
   * stays open (copy ≠ paste), with a "Copied" toast. */
  function copyOnly(item: ClipboardItem) {
    void invoke("copy_clipboard", { id: item.id })
      .then(() => showToast(t("copied")))
      .catch((err) => console.error("copy failed", err));
  }

  /** Copy a rich-text row as plain text only (strips HTML formatting). */
  function copyPlain(item: ClipboardItem) {
    void invoke("copy_clipboard", { id: item.id, plain: true })
      .then(() => showToast(t("copied")))
      .catch((err) => console.error("copy plain failed", err));
  }

  /** Paste a clipboard entry into the previous foreground window. Closes the
   * launcher when 粘贴后关闭 is enabled (default). */
  function pasteClip(item: ClipboardItem) {
    void invoke("paste_clipboard", { id: item.id })
      .then(() => {
        if (pasteClose()) showToast(t("pasted"));
      })
      .catch((err) => {
        console.error("paste failed", err);
        showToast(t("pasteFailed"));
      });
    if (pasteClose()) void resetAndHide();
  }

  /** Merge-paste every Space-selected entry (Enter with a non-empty set). */
  function pasteClipMulti() {
    const ids = clips()
      .filter((c) => multiIds().has(c.id))
      .map((c) => c.id);
    if (ids.length === 0) return;
    void invoke("paste_clipboard_multi", { ids })
      .then(() => {
        if (pasteClose()) showToast(t("pasted"));
      })
      .catch((err) => {
        console.error("merge paste failed", err);
        showToast(t("pasteFailed"));
      });
    if (pasteClose()) void resetAndHide();
  }

  /** Toggle a row into/out of the multi-select set (Space). */
  function toggleMulti(idx: number) {
    const item = clips()[idx];
    if (!item) return;
    const next = new Set(multiIds());
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    setMultiIds(next);
  }

  /** Open a link row in the default browser (ShellExecuteW via launch_app). */
  function openClipLink(item: ClipboardItem) {
    void invoke("launch_app", { path: item.content, name: item.content, elevated: false });
    void resetAndHide();
  }

  /** Reveal the first path of a file row in Explorer (launcher stays open). */
  function revealClipFile(path: string) {
    void invoke("reveal_in_folder", { path }).catch((err) =>
      console.error("reveal failed", err)
    );
  }

  /** Restore the last deletion from the undo buffer. */
  function undoDelete() {
    const d = undoBuf();
    if (!d) return;
    setUndoBuf(null);
    void invoke("restore_clipboard", { item: d })
      .catch((err) => console.error("restore failed", err))
      .finally(() => void runSearch(query()));
  }

  /** Start the delete animation, then actually delete once it finishes. */
  function requestDelete(id: number) {
    if (deletingId() !== null) return;
    setDeletingId(id);
    window.setTimeout(() => {
      setDeletingId(null);
      void deleteItem(id);
    }, DELETE_ANIM_MS);
  }

  /** Toggle the runtime recording pause (status-bar button). */
  function toggleClipPause() {
    const next = !clipPaused();
    setClipPaused(next);
    void invoke("set_clipboard_paused", { paused: next }).catch((err) =>
      console.error("set_clipboard_paused failed", err)
    );
  }

  /** Confirm dialog → clear the whole history (optionally keeping pinned). */
  function doClear() {
    setClearOpen(false);
    void invoke("clear_clipboard", { keepPinned: keepPinned() })
      .then(() => showToast(t("clipCleared")))
      .catch((err) => console.error("clear failed", err));
    setKeepPinned(false);
    void runSearch(query());
  }

  /** Pin/unpin a specific clipboard entry (context-menu action). Updates the
   * row optimistically so the pin badge appears immediately; the re-search
   * then re-orders pinned rows to the top. */
  async function toggleClipPin(item: ClipboardItem) {
    const pinned = !item.pinned;
    setClips((cs) =>
      cs.map((c) => (c.id === item.id ? { ...c, pinned } : c))
    );
    try {
      await invoke("pin_clipboard", { id: item.id, pinned });
    } catch (err) {
      console.error("pin failed", err);
      setClips((cs) => cs.map((c) => (c.id === item.id ? { ...c, pinned: !pinned } : c)));
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
    const items = [
      { label: t("copyBack"), icon: clipboardIcon, action: () => copyOnly(m.item) },
      { label: t("pasteBack"), icon: clipboardIcon, action: () => pasteClip(m.item) },
      {
        label: isPinned ? t("unpin") : t("pin"),
        icon: isPinned ? pinnedIcon : pinIcon,
        action: () => void toggleClipPin(m.item),
      },
    ];
    // Rich-text rows offer a plain-text copy that strips the formatting.
    if (m.item.kind === "text" && m.item.has_html) {
      items.push({
        label: t("copyPlainText"),
        icon: clipboardIcon,
        action: () => copyPlain(m.item),
      });
    }
    // Link rows open in the browser; file rows reveal in Explorer.
    if (m.item.kind === "text" && isUrl(m.item.content)) {
      items.push({
        label: t("openLink"),
        icon: runIcon,
        action: () => openClipLink(m.item),
      });
    }
    if (m.item.kind === "file") {
      const first = m.item.content.split("\n").find(Boolean);
      if (first) {
        items.push({
          label: t("openFileLocation"),
          icon: folderOpenIcon,
          action: () => revealClipFile(first),
        });
      }
    }
    items.push({
      label: t("delete"),
      icon: deleteIcon,
      action: () => requestDelete(m.item.id),
    });
    return items;
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
      const res = (await invoke("search_clipboard", {
        query: q,
        kind: clipKind(),
      })) as ClipboardItem[];
      if (id === requestSeq) {
        setClips(res);
        setSelected(0);
        setClipScrollTop(0);
        scheduleResize();
      }
    }
  }

  /** Switch the history category and re-search. */
  function setClipKindAndSearch(k: ClipKind) {
    setMultiIds(new Set<number>());
    setClipKind(k);
    void runSearch(query());
  }

  /** Move to the previous/next category (Left/Right arrows on an empty query). */
  function switchCategory(delta: number) {
    const idx = CLIP_CATS.findIndex((c) => c.kind === clipKind());
    const next = CLIP_CATS[(idx + delta + CLIP_CATS.length) % CLIP_CATS.length];
    setClipKindAndSearch(next.kind);
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
      setShowSourceApp(s.clipboard?.show_source_app ?? true);
      setTimeDisplayAbs(s.clipboard?.time_display === "absolute");
      setPasteClose(s.clipboard?.paste_close ?? true);
      setHoverSelect(s.clipboard?.hover_select ?? false);
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
    // Clipboard mode always starts on the All category with no multi-select.
    if (m === "clipboard") {
      setClipKind("all");
      setMultiIds(new Set<number>());
      setDeletingId(null);
    }
    lastWindowH = 0; // the fixed-height model differs per mode — force a resize
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
      // A non-empty multi-select merges; otherwise paste the single entry.
      if (multiIds().size > 0) {
        pasteClipMulti();
        return;
      }
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

  /** Delete a clipboard entry by id, hold it for undo, then refresh results. */
  async function deleteItem(id: number) {
    try {
      const deleted = await invoke<DeletedClip>("delete_clipboard", { id });
      setUndoBuf(deleted);
      showToast(t("clipDeletedOne"), { undo: undoDelete, duration: TOAST_UNDO_MS });
    } catch (err) {
      console.error("delete failed", err);
    }
    await runSearch(query());
  }

  /** Delete the selected clipboard entry (Del key), with the collapse animation. */
  async function deleteSelected() {
    const item = clips()[selected()];
    if (item) requestDelete(item.id);
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

  function onKeyDown(e: KeyboardEvent) {
    const hasResults = currentResults().length > 0;
    if (e.key === "Escape") {
      e.preventDefault();
      if (menu()) {
        closeMenu();
      } else if (mode() === "clipboard" && multiIds().size > 0) {
        setMultiIds(new Set<number>()); // leave multi-select mode without hiding
      } else if (currentPreview()) {
        // Close the satellite preview without hiding the launcher. The preview
        // window is WS_EX_NOACTIVATE and can never receive the key itself, so
        // Esc is routed here in the main window.
        setCurrentPreview(null);
        void invoke("close_preview");
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
      // Clipboard list navigation. Space toggles multi-select (merge paste
      // via Enter); ↓/↑ move; ←/→ switch categories (on an empty query, so
      // text editing in the search box still works); Del deletes.
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        if (clipQuery() === "") {
          e.preventDefault();
          switchCategory(e.key === "ArrowLeft" ? -1 : 1);
        }
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (hasResults) {
          e.preventDefault();
          moveSelection(e.key === "ArrowDown" ? 1 : -1);
        }
      } else if (e.key === " ") {
        if (hasResults) {
          e.preventDefault();
          toggleMulti(selected());
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
    requestAnimationFrame(measureClipViewport);
  });

  // Satellite preview sync (ROADMAP #15): every selection / category / mode
  // change re-evaluates what the preview window should show, but the actual
  // show/hide is debounced (~100ms) so fast keyboard scrolling through rows
  // (esp. "other" binaries between previewable ones) doesn't thrash the window.
  // `currentPreview` tracks the pending request synchronously so Esc knows to
  // close the preview before hiding the launcher.
  const [currentPreview, setCurrentPreview] = createSignal<PreviewReq | null>(null);
  let previewTimer: number | undefined;
  createEffect(() => {
    void mode();
    void clipKind();
    void clips();
    void selected();
    const item = mode() === "clipboard" ? clips()[selected()] : undefined;
    const req = item ? previewTarget(item) : null;
    setCurrentPreview(req);
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      if (req) void invoke("show_preview", { req });
      else void invoke("close_preview");
    }, 100);
  });
  onCleanup(() => clearTimeout(previewTimer));

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

    // The launcher stays hidden between toggles. On every fresh show (hotkey /
    // tray toggle) reset to the Navigate main menu, re-focus the input, and
    // repopulate the grid. This listens to the Rust `launcher-shown` event, not
    // `onFocusChanged`: dragging the frameless window briefly deactivates and
    // refocuses it (Rust `is_mid_drag` suppresses the hide on that side), and a
    // reset there would wipe the current mode/search mid-drag.
    const unlisten = await getCurrentWindow().listen("launcher-shown", async () => {
      clearSearch();
      await Promise.all([refreshRecent(), refreshPins()]);
      // Auto-select the first entry of the empty-query main menu: the recent
      // bar's first item when it has any, else the pinned bar's. (The bars'
      // highlight requires `zoneActive`, so a resting zone of "grid" would
      // leave nothing selected on summon.)
      if (mode() === "apps" && appsQuery() === "" && zone() === "grid") {
        if (showRecent() && recentApps().length > 0) setZone("recent");
        else if (pinnedApps().length > 0) setZone("pinned");
      }
      queueMicrotask(() => document.getElementById("search-input")?.focus());
    });
    onCleanup(() => unlisten());

    // The satellite preview's × button (or any Rust-side teardown) clears our
    // Esc-priority state — without this, Esc would think the preview is still
    // open and close a window that is already gone.
    const unlistenPreviewClosed = await getCurrentWindow().listen("preview-closed", () => {
      setCurrentPreview(null);
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
    requestAnimationFrame(measureBarCols);
  });

  /** Left tile of a clipboard row: image thumb is rendered by the caller; the
   * file / link / color / plain-text fallbacks live here. */
  function clipTile(item: ClipboardItem, color: string | null, link: boolean) {
    if (item.kind === "file") {
      const first = item.content.split("\n").find(Boolean) ?? "";
      const content = fileContent(basename(first));
      if (content === "audio") {
        return (
          <span class="clip-row-tile">
            <svg class="clip-row-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </span>
        );
      }
      if (content === "video") {
        return (
          <span class="clip-row-tile">
            <svg class="clip-row-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polygon points="23 7 16 12 23 17 23 7" />
              <rect x="1" y="5" width="15" height="14" rx="2" />
            </svg>
          </span>
        );
      }
      if (content === "image") {
        return (
          <span class="clip-row-tile">
            <svg class="clip-row-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </span>
        );
      }
      if (content === "text") {
        return (
          <span class="clip-row-tile">
            <svg class="clip-row-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="4 7 4 4 20 4 20 7" />
              <line x1="9" y1="20" x2="15" y2="20" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
          </span>
        );
      }
      return (
        <span class="clip-row-tile">
          <svg
            class="clip-row-tile-icon"
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
        </span>
      );
    }
    if (link) {
      return (
        <span class="clip-row-tile">
          <svg
            class="clip-row-tile-icon"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
        </span>
      );
    }
    if (color) {
      return <span class="clip-row-tile clip-row-tile-color" style={{ background: color }} />;
    }
    return <span class="clip-row-tile clip-row-tile-text">T</span>;
  }

  /** A single clipboard history row: tile, two-line body, hover actions. */
  function clipRow(item: ClipboardItem, idx: number) {
    const isSelected = idx === selected();
    const color = item.kind === "text" ? detectColor(item.content) : null;
    const link = item.kind === "text" && isUrl(item.content);
    return (
      <div
        class="clip-row"
        classList={{
          "result-selected": isSelected,
          "clip-row-deleting": deletingId() === item.id,
          "clip-row-multi": multiIds().has(item.id),
        }}
        role="option"
        aria-selected={isSelected}
        onMouseMove={() => {
          // Hover-selection is a setting (default off — then only a click
          // selects). It is also ignored while keyboard nav is active.
          if (!hoverSelect() || selectionSource === "keyboard") return;
          selectionSource = "mouse";
          setSelected(idx);
        }}
        onClick={() => {
          selectionSource = "mouse";
          // First click selects the entry; a second click on the already
          // selected row pastes it.
          if (selected() === idx) {
            activate();
          } else {
            setSelected(idx);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // Right-click must leave the window state (selection → preview pane
          // → window width) unchanged: the menu acts on `item` directly, so we
          // don't re-select the row here.
          setMenu({ kind: "clip", x: e.clientX, y: e.clientY, item });
        }}
      >
        <div class="clip-row-tile-box">
          <Show when={item.kind === "image" && item.thumb} fallback={clipTile(item, color, link)}>
            <span class="clip-row-tile">
              <img class="clip-row-img" src={item.thumb ?? undefined} alt="" draggable={false} />
            </span>
          </Show>
        </div>
        <div class="clip-row-body">
          <div class="clip-row-title" title={item.content}>
            {clipTitle(item)}
          </div>
          <div class="clip-row-meta">{clipMeta(item, showSourceApp(), timeDisplayAbs())}</div>
        </div>
        <Show when={item.pinned}>
          <svg
            class="clip-row-pin"
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
        <div class="clip-row-actions">
          <button
            class="clip-act"
            title={t("copyToClipboard")}
            aria-label={t("copyToClipboard")}
            onClick={(e) => {
              e.stopPropagation();
              copyOnly(item);
            }}
          >
            <svg
              class="clip-act-icon"
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
            class="clip-act"
            title={t("paste")}
            aria-label={t("paste")}
            onClick={(e) => {
              e.stopPropagation();
              pasteClip(item);
            }}
          >
            <svg
              class="clip-act-icon"
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
          </button>
          <button
            class="clip-act clip-act-danger"
            title={t("delete")}
            aria-label={t("delete")}
            onClick={(e) => {
              e.stopPropagation();
              requestDelete(item.id);
            }}
          >
            <svg
              class="clip-act-icon"
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
        <Show when={multiIds().has(item.id)}>
          <span class="clip-row-check">✓</span>
        </Show>
      </div>
    );
  }

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
        <div class="bar-grid" classList={{ collapsed: !opts.expanded }}>
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
              <div class="result-grid" role="grid">
                {apps().map((app, i) =>
                  appBox(app, i === selected(), {
                    onActivate: activate,
                    onSelect: () => {
                      // Hover-selection is a setting (default off); keyboard
                      // nav also takes precedence until a click.
                      if (!hoverSelect() || selectionSource === "keyboard") return;
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
          <div class="clip-page">
            <div class="clip-cats" role="tablist" aria-label="Clipboard category">
              {CLIP_CATS.map((c) => (
                <button
                  class="clip-cat"
                  classList={{ active: clipKind() === c.kind }}
                  role="tab"
                  aria-selected={clipKind() === c.kind}
                  onClick={() => setClipKindAndSearch(c.kind)}
                >
                  {t(c.label as keyof Messages)}
                </button>
              ))}
            </div>
            <div class="clip-main">
            <Show
              when={clips().length > 0}
              fallback={
                <div class="clip-empty">
                  <img
                    class="clip-empty-icon"
                    src={clipboardIcon}
                    alt=""
                    draggable={false}
                  />
                  <p class="clip-empty-title">
                    {clipQuery() ? t("noResults") : t("noClipboardHistory")}
                  </p>
                  <Show when={!clipQuery()}>
                    <p class="clip-empty-hint">{t("clipEmptyHint")}</p>
                  </Show>
                </div>
              }
            >
              <div
                class="clip-list"
                ref={clipScrollEl}
                role="listbox"
                onScroll={(e) =>
                  setClipScrollTop((e.currentTarget as HTMLDivElement).scrollTop)
                }
              >
                <div
                  class="clip-spacer"
                  style={{
                    height: `${clips().length * CLIP_ROW_H}px`,
                    position: "relative",
                  }}
                >
                  <div
                    class="clip-window"
                    style={{
                      position: "absolute",
                      top: `${clipStart() * CLIP_ROW_H}px`,
                      left: 0,
                      right: 0,
                    }}
                  >
                    {clips()
                      .slice(clipStart(), clipEnd())
                      .map((item, i) => clipRow(item, clipStart() + i))}
                  </div>
                </div>
              </div>
            </Show>
            </div>
            <div class="clip-statusbar">
              <span class="clip-status-count">
                {multiIds().size > 0
                  ? t("clipSelected", { count: String(multiIds().size) })
                  : t("clipTotal", { count: String(clips().length) })}
              </span>
              <div class="clip-status-actions">
                <button
                  class="clip-status-btn"
                  classList={{ paused: clipPaused() }}
                  title={clipPaused() ? t("clipResume") : t("clipPause")}
                  onClick={toggleClipPause}
                >
                  {clipPaused() ? t("clipResume") : t("clipPause")}
                </button>
                <button class="clip-clear-btn" onClick={() => setClearOpen(true)}>
                  {t("clipClear")}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
      <Show when={mode() === "clipboard"}>
        <div class="shortcut-hint">{t("clipShortcutHint")}</div>
      </Show>
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
      <Show when={clearOpen()}>
        <div class="clip-confirm">
          <p class="clip-confirm-title">{t("clipClearConfirm")}</p>
          <label class="clip-confirm-check">
            <input
              type="checkbox"
              checked={keepPinned()}
              onChange={(e) =>
                setKeepPinned((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>{t("keepPinned")}</span>
          </label>
          <div class="clip-confirm-actions">
            <button class="clip-confirm-cancel" onClick={() => setClearOpen(false)}>
              {t("cancel")}
            </button>
            <button class="clip-confirm-ok" onClick={doClear}>
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
