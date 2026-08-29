//! Clipboard-mode store — history filter categories, multi-select merge paste,
//! delete with undo, clear-with-confirm, pause recording, pin, and the virtual
//! list windowing math. Display-only settings (source app / time display /
//! paste-close / hover-select / preview / remember-checks) live here too.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import {
  CLIP_CATS,
  CLIP_OVERSCAN,
  CLIP_ROW_H,
  DELETE_ANIM_MS,
  TOAST_UNDO_MS,
  type ClipKind,
  type ClipboardItem,
  type DeletedClip,
} from "./types";

export interface ClipboardDeps {
  /** Current history rows (owned by the composition root's search). */
  clips: () => ClipboardItem[];
  /** Replace the history rows (optimistic pin updates). */
  setClips: (fn: (cs: ClipboardItem[]) => ClipboardItem[]) => void;
  selected: () => number;
  /** Active-mode query (for refresh-after-mutation searches). */
  query: () => string;
  /** Clipboard-mode query (pin refresh keeps the clipboard query). */
  clipQuery: () => string;
  /** Virtual list viewport height (measured by the window sizer). */
  clipViewportH: () => number;
  showToast: (text: string, opts?: { undo?: () => void; duration?: number }) => void;
  markEntryOpened: () => void;
  resetAndHide: () => void;
  runSearch: (q: string) => Promise<void>;
  /** Debounced 记住上次所在页面 write (composition root). */
  persistLastPage: () => void;
}

/** Initial values for the settings-driven signals (from `__LUME_CONFIG__`). */
export interface ClipboardInit {
  showSourceApp: boolean;
  timeDisplayAbs: boolean;
  pasteClose: boolean;
  hoverSelect: boolean;
  previewEnabled: boolean;
  rememberChecks: boolean;
}

export function createClipboardStore(deps: ClipboardDeps, init: ClipboardInit) {
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
  const [showSourceApp, setShowSourceApp] = createSignal(init.showSourceApp);
  /** Settings-driven: absolute timestamps instead of relative. */
  const [timeDisplayAbs, setTimeDisplayAbs] = createSignal(init.timeDisplayAbs);
  /** Settings-driven: hide the launcher after a paste. */
  const [pasteClose, setPasteClose] = createSignal(init.pasteClose);
  /** Settings-driven: mouse hover selects entries (default off — a click is
   * the only way to select with the mouse when off). */
  const [hoverSelect, setHoverSelect] = createSignal(init.hoverSelect);
  /** Runtime pause for clipboard recording (status-bar toggle, not persisted). */
  const [clipPaused, setClipPaused] = createSignal(false);
  /** Settings-driven: show the satellite preview window (设置/剪贴板 → 开启预览).
   * Off = no preview ever pops; inline row thumbnails stay. */
  const [previewEnabled, setPreviewEnabled] = createSignal(init.previewEnabled);
  /** Settings-driven: 记住勾选 — persist each multi-file entry's checked files
   * across sessions (toggled in the file-list preview area). */
  const [rememberChecks, setRememberChecks] = createSignal(init.rememberChecks);
  /** Virtual list scroll offset (the container element + viewport height stay
   * in the composition root — the window sizer measures them). */
  const [clipScrollTop, setClipScrollTop] = createSignal(0);

  /** First/last rendered row of the windowed clipboard list. */
  const clipStart = () =>
    Math.max(0, Math.floor(clipScrollTop() / CLIP_ROW_H) - CLIP_OVERSCAN);
  const clipEnd = () =>
    Math.min(
      deps.clips().length,
      Math.ceil((clipScrollTop() + Math.max(deps.clipViewportH(), 160)) / CLIP_ROW_H) +
        CLIP_OVERSCAN
    );

  /** Map a copy/paste backend error to a user-facing toast: the sentinels for
   * an invalid row / an unchecked-everything multi-file row get specific text;
   * anything else falls back to the generic copy/paste failure message. */
  function clipErrorToast(err: string, fallback: string): string {
    if (err.includes("CLIP_INVALID")) return t("clipInvalid");
    if (err.includes("CLIP_NO_FILES")) return t("clipNoFilesChecked");
    return fallback;
  }

  /** Copy a specific clipboard item to the system clipboard. The launcher
   * stays open (copy ≠ paste), with a "Copied" toast. An invalid row (content
   * gone) is blocked with a clear toast — never a silent failure. */
  function copyOnly(item: ClipboardItem) {
    if (item.valid === false) {
      deps.showToast(t("clipInvalid"));
      return;
    }
    void invoke("copy_clipboard", { id: item.id })
      .then(() => deps.showToast(t("copied")))
      .catch((err) => {
        console.error("copy failed", err);
        deps.showToast(clipErrorToast(String(err), t("copyFailed")));
      });
  }

  /** Copy a rich-text row as plain text only (strips HTML formatting). */
  function copyPlain(item: ClipboardItem) {
    if (item.valid === false) {
      deps.showToast(t("clipInvalid"));
      return;
    }
    void invoke("copy_clipboard", { id: item.id, plain: true })
      .then(() => deps.showToast(t("copied")))
      .catch((err) => {
        console.error("copy plain failed", err);
        deps.showToast(clipErrorToast(String(err), t("copyFailed")));
      });
  }

  /** Paste a clipboard entry into the previous foreground window. Closes the
   * launcher when 粘贴后关闭 is enabled (default). Invalid rows are blocked with
   * a toast and keep the launcher open. */
  function pasteClip(item: ClipboardItem) {
    deps.markEntryOpened(); // 粘贴即使用该条目 → 清空搜索记忆
    if (item.valid === false) {
      deps.showToast(t("clipInvalid"));
      return;
    }
    void invoke("paste_clipboard", { id: item.id })
      .then(() => {
        if (pasteClose()) deps.showToast(t("pasted"));
      })
      .catch((err) => {
        console.error("paste failed", err);
        deps.showToast(clipErrorToast(String(err), t("pasteFailed")));
      });
    if (pasteClose()) void deps.resetAndHide();
  }

  /** Merge-paste every Space-selected entry (Enter with a non-empty set). */
  function pasteClipMulti() {
    deps.markEntryOpened(); // 合并粘贴即使用条目 → 清空搜索记忆
    const ids = deps
      .clips()
      .filter((c) => multiIds().has(c.id))
      .map((c) => c.id);
    if (ids.length === 0) return;
    void invoke("paste_clipboard_multi", { ids })
      .then(() => {
        if (pasteClose()) deps.showToast(t("pasted"));
      })
      .catch((err) => {
        console.error("merge paste failed", err);
        deps.showToast(t("pasteFailed"));
      });
    if (pasteClose()) void deps.resetAndHide();
  }

  /** Toggle a row into/out of the multi-select set (Space). */
  function toggleMulti(idx: number) {
    const item = deps.clips()[idx];
    if (!item) return;
    const next = new Set(multiIds());
    if (next.has(item.id)) next.delete(item.id);
    else next.add(item.id);
    setMultiIds(next);
  }

  /** Open a link row in the default browser (ShellExecuteW via launch_app). */
  function openClipLink(item: ClipboardItem) {
    deps.markEntryOpened(); // 打开链接即使用条目 → 清空搜索记忆
    void invoke("launch_app", { path: item.content, name: item.content, elevated: false });
    void deps.resetAndHide();
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
      .finally(() => void deps.runSearch(deps.query()));
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
      .then(() => deps.showToast(t("clipCleared")))
      .catch((err) => console.error("clear failed", err));
    setKeepPinned(false);
    void deps.runSearch(deps.query());
  }

  /** Pin/unpin a specific clipboard entry (context-menu action). Updates the
   * row optimistically so the pin badge appears immediately; the re-search
   * then re-orders pinned rows to the top. */
  async function toggleClipPin(item: ClipboardItem) {
    const pinned = !item.pinned;
    deps.setClips((cs) =>
      cs.map((c) => (c.id === item.id ? { ...c, pinned } : c))
    );
    try {
      await invoke("pin_clipboard", { id: item.id, pinned });
    } catch (err) {
      console.error("pin failed", err);
      deps.setClips((cs) => cs.map((c) => (c.id === item.id ? { ...c, pinned: !pinned } : c)));
    }
    await deps.runSearch(deps.clipQuery());
  }

  /** Delete a clipboard entry by id, hold it for undo, then refresh results. */
  async function deleteItem(id: number) {
    try {
      const deleted = await invoke<DeletedClip>("delete_clipboard", { id });
      setUndoBuf(deleted);
      deps.showToast(t("clipDeletedOne"), { undo: undoDelete, duration: TOAST_UNDO_MS });
    } catch (err) {
      console.error("delete failed", err);
    }
    await deps.runSearch(deps.query());
  }

  /** Delete the selected clipboard entry (Del key), with the collapse animation. */
  function deleteSelected() {
    const item = deps.clips()[deps.selected()];
    if (item) requestDelete(item.id);
  }

  /** Switch the history category and re-search. */
  function setClipKindAndSearch(k: ClipKind) {
    setMultiIds(new Set<number>());
    setClipKind(k);
    void deps.runSearch(deps.query());
    deps.persistLastPage();
  }

  /** Move to the previous/next category (Left/Right arrows on an empty query). */
  function switchCategory(delta: number) {
    const idx = CLIP_CATS.findIndex((c) => c.kind === clipKind());
    const next = CLIP_CATS[(idx + delta + CLIP_CATS.length) % CLIP_CATS.length];
    setClipKindAndSearch(next.kind);
  }

  return {
    // signals
    clipKind,
    setClipKind,
    multiIds,
    setMultiIds,
    undoBuf,
    deletingId,
    setDeletingId,
    clearOpen,
    setClearOpen,
    keepPinned,
    setKeepPinned,
    showSourceApp,
    setShowSourceApp,
    timeDisplayAbs,
    setTimeDisplayAbs,
    pasteClose,
    setPasteClose,
    hoverSelect,
    setHoverSelect,
    clipPaused,
    previewEnabled,
    setPreviewEnabled,
    rememberChecks,
    setRememberChecks,
    clipScrollTop,
    setClipScrollTop,
    clipStart,
    clipEnd,
    // actions
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
    setClipKindAndSearch,
    switchCategory,
  };
}

export type ClipboardStore = ReturnType<typeof createClipboardStore>;
