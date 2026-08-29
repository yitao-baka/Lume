//! Clipboard-mode store — the state machine behind the clipboard plugin.
//! Owns the history rows, the selected index, the virtual-list windowing and
//! every display-only clipboard setting. All mutations go through the plugin
//! services (toasts, entry-opened marking, root search pipeline).

import { createEffect, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../../i18n";
import type { SettingsData } from "../../settings/types";
import {
  CLIP_CATS,
  CLIP_OVERSCAN,
  CLIP_ROW_H,
  DELETE_ANIM_MS,
  TOAST_UNDO_MS,
  type ClipKind,
  type ClipboardItem,
  type DeletedClip,
} from "../../launcher/types";
import type { PluginServices } from "../../plugins/types";

export function createClipboardStore(services: PluginServices) {
  // ── Initial config (synchronous, injected by Rust before page load) ──
  const clipCfg = (window as any).__LUME_CONFIG__?.clipboard;

  // ── This mode's own query (independent, like the apps query) ──
  const [clipQuery, setClipQuery] = createSignal("");

  // ── Rows + selection (plugin-owned; the root reads via ModeInstance) ──
  const [clips, setClips] = createSignal<ClipboardItem[]>([]);
  const [selected, setSelected] = createSignal(0);

  /** Active history filter category. */
  const [clipKind, setClipKind] = createSignal<ClipKind>("all");
  /** Ids toggled with Space — Enter merges-pastes exactly this set. */
  const [multiIds, setMultiIds] = createSignal<Set<number>>(new Set());
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
  /** Settings-driven: show the satellite preview window (设置/剪贴板 → 开启预览).
   * Off = no preview ever pops; inline row thumbnails stay. */
  const [previewEnabled, setPreviewEnabled] = createSignal(clipCfg?.preview ?? true);
  /** Settings-driven: 记住勾选 — persist each multi-file entry's checked files
   * across sessions (toggled in the file-list preview area). */
  const [rememberChecks, setRememberChecks] = createSignal(clipCfg?.remember_checks ?? true);

  // ── Virtual list state ──
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

  /** Re-read the virtual list's viewport height (idempotent; sizer hook). */
  function measureViewport() {
    const el = clipScrollEl;
    if (!el) return;
    const h = el.clientHeight;
    if (h !== clipViewportH()) setClipViewportH(h);
  }

  /** Map a copy/paste backend error to a user-facing toast: the sentinels for
   * an invalid row / an unchecked-everything multi-file row get specific text;
   * anything else falls back to the generic copy/paste failure message. */
  function clipErrorToast(err: string, fallback: string): string {
    if (err.includes("CLIP_INVALID")) return t("clipInvalid");
    if (err.includes("CLIP_NO_FILES")) return t("clipNoFilesChecked");
    return fallback;
  }

  /** This mode's search — fetch + swap the rows (stale-token guarded).
   * Internal refreshes go through the root pipeline (`services.runSearch`),
   * which ends up here after its own selection/zone resets. */
  async function search(q: string) {
    const token = services.searchToken();
    const res = (await invoke("search_clipboard", {
      query: q,
      kind: clipKind(),
    })) as ClipboardItem[];
    if (token !== services.searchToken()) return;
    setClips(res);
    setSelected(0);
    setClipScrollTop(0);
    services.scheduleResize();
  }

  /** Switch the history category and re-search. */
  function setClipKindAndSearch(k: ClipKind) {
    setMultiIds(new Set<number>());
    setClipKind(k);
    void services.runSearch(clipQuery());
    services.persistLastPage();
  }

  /** Move to the previous/next category (Left/Right arrows on an empty query). */
  function switchCategory(delta: number) {
    const idx = CLIP_CATS.findIndex((c) => c.kind === clipKind());
    const next = CLIP_CATS[(idx + delta + CLIP_CATS.length) % CLIP_CATS.length];
    setClipKindAndSearch(next.kind);
  }

  /** Copy a specific clipboard item to the system clipboard. The launcher
   * stays open (copy ≠ paste), with a "Copied" toast. An invalid row (content
   * gone) is blocked with a clear toast — never a silent failure. */
  function copyOnly(item: ClipboardItem) {
    if (item.valid === false) {
      services.showToast(t("clipInvalid"));
      return;
    }
    void invoke("copy_clipboard", { id: item.id })
      .then(() => services.showToast(t("copied")))
      .catch((err) => {
        console.error("copy failed", err);
        services.showToast(clipErrorToast(String(err), t("copyFailed")));
      });
  }

  /** Copy a rich-text row as plain text only (strips HTML formatting). */
  function copyPlain(item: ClipboardItem) {
    if (item.valid === false) {
      services.showToast(t("clipInvalid"));
      return;
    }
    void invoke("copy_clipboard", { id: item.id, plain: true })
      .then(() => services.showToast(t("copied")))
      .catch((err) => {
        console.error("copy plain failed", err);
        services.showToast(clipErrorToast(String(err), t("copyFailed")));
      });
  }

  /** Paste a clipboard entry into the previous foreground window. Closes the
   * launcher when 粘贴后关闭 is enabled (default). Invalid rows are blocked with
   * a toast and keep the launcher open. */
  function pasteClip(item: ClipboardItem) {
    services.markEntryOpened(); // 粘贴即使用该条目 → 清空搜索记忆
    if (item.valid === false) {
      services.showToast(t("clipInvalid"));
      return;
    }
    void invoke("paste_clipboard", { id: item.id })
      .then(() => {
        if (pasteClose()) services.showToast(t("pasted"));
      })
      .catch((err) => {
        console.error("paste failed", err);
        services.showToast(clipErrorToast(String(err), t("pasteFailed")));
      });
    if (pasteClose()) void services.resetAndHide();
  }
  /** Merge-paste every Space-selected entry (Enter with a non-empty set). */
  function pasteClipMulti() {
    services.markEntryOpened(); // 合并粘贴即使用条目 → 清空搜索记忆
    const ids = clips()
      .filter((c) => multiIds().has(c.id))
      .map((c) => c.id);
    if (ids.length === 0) return;
    void invoke("paste_clipboard_multi", { ids })
      .then(() => {
        if (pasteClose()) services.showToast(t("pasted"));
      })
      .catch((err) => {
        console.error("merge paste failed", err);
        services.showToast(t("pasteFailed"));
      });
    if (pasteClose()) void services.resetAndHide();
  }

  /** Activate the selected row (Enter): merge-paste the selection, else paste
   * the single entry. */
  function activate() {
    if (multiIds().size > 0) {
      pasteClipMulti();
      return;
    }
    const item = clips()[selected()];
    if (!item) return;
    pasteClip(item);
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
    services.markEntryOpened(); // 打开链接即使用条目 → 清空搜索记忆
    void invoke("launch_app", { path: item.content, name: item.content, elevated: false });
    void services.resetAndHide();
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
      .finally(() => void services.runSearch(clipQuery()));
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
      .then(() => services.showToast(t("clipCleared")))
      .catch((err) => console.error("clear failed", err));
    setKeepPinned(false);
    void services.runSearch(clipQuery());
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
    await services.runSearch(clipQuery());
  }

  /** Delete a clipboard entry by id, hold it for undo, then refresh results. */
  async function deleteItem(id: number) {
    try {
      const deleted = await invoke<DeletedClip>("delete_clipboard", { id });
      setUndoBuf(deleted);
      services.showToast(t("clipDeletedOne"), { undo: undoDelete, duration: TOAST_UNDO_MS });
    } catch (err) {
      console.error("delete failed", err);
    }
    await services.runSearch(clipQuery());
  }

  /** Delete the selected clipboard entry (Del key), with the collapse animation. */
  function deleteSelected() {
    const item = clips()[selected()];
    if (item) requestDelete(item.id);
  }

  // Virtual list: keep the selected row in the rendered window while
  // navigating with the keyboard (the row may not be in the DOM otherwise).
  // A small buffer keeps the row clearly inside the viewport (aligning exactly
  // to the bottom edge left it a fraction of a pixel out of view).
  createEffect(() => {
    selected();
    void clipViewportH(); // re-scroll when the viewport is resized
    const el = clipScrollEl;
    if (!el || services.selectionSource() !== "keyboard") return;
    const top = selected() * CLIP_ROW_H;
    const bottom = top + CLIP_ROW_H;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight + 8;
    }
  });

  /** Clear per-show state (clearSearch hook). */
  function reset() {
    setMultiIds(new Set<number>());
    setDeletingId(null);
    setClearOpen(false);
  }

  /** 记住上次所在页面 — the clipboard page kind is the filter category. */
  function pageKind(): string {
    return clipKind();
  }
  function restorePage(kind: string) {
    setClipKind(kind as ClipKind);
  }

  /** Apply the settings slice this mode renders live. */
  function applySettings(s: SettingsData) {
    setShowSourceApp(s.clipboard?.show_source_app ?? true);
    setTimeDisplayAbs(s.clipboard?.time_display === "absolute");
    setPasteClose(s.clipboard?.paste_close ?? true);
    setHoverSelect(s.clipboard?.hover_select ?? false);
    setPreviewEnabled(s.clipboard?.preview ?? true);
    setRememberChecks(s.clipboard?.remember_checks ?? true);
  }

  return {
    // query
    clipQuery,
    setClipQuery,
    // rows + selection
    clips,
    setClips,
    selected,
    setSelected,
    // category + page persistence
    clipKind,
    pageKind,
    restorePage,
    // view state
    multiIds,
    undoBuf,
    deletingId,
    clearOpen,
    setClearOpen,
    keepPinned,
    setKeepPinned,
    showSourceApp,
    timeDisplayAbs,
    hoverSelect,
    clipPaused,
    previewEnabled,
    rememberChecks,
    clipScrollTop,
    setClipScrollTop,
    clipStart,
    clipEnd,
    bindScrollEl: (el: HTMLDivElement) => {
      clipScrollEl = el;
    },
    measureViewport,
    // actions
    search,
    activate,
    onEscape: () => {
      if (multiIds().size > 0) {
        setMultiIds(new Set<number>()); // leave multi-select without hiding
        return true;
      }
      return false;
    },
    copyOnly,
    copyPlain,
    pasteClip,
    pasteClipMulti,
    toggleMulti,
    openClipLink,
    revealClipFile,
    undoDelete,
    requestDelete,
    toggleClipPause,
    doClear,
    toggleClipPin,
    deleteItem,
    deleteSelected,
    reset,
    applySettings,
    setClipKindAndSearch,
    switchCategory,
  };
}

export type ClipboardStore = ReturnType<typeof createClipboardStore>;
