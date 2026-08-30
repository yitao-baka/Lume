//! Shared launcher types and pure constants — imported by every launcher
//! module and the App composition root. No runtime behavior lives here beyond
//! the constant tables themselves.

import type { Messages } from "../i18n";

/** Search modes, toggled with Tab or the pills in the search row. "apps" is
 * the built-in Navigate mode; plugin modes register string ids ("clipboard")
 * through the plugin registry (src/plugins). */
export type Mode = string;

/** A launcher entry as returned by the Rust `search_apps` command. */
export interface AppEntry {
  id: number;
  name: string;
  path: string;
}

/** Reply of the Rust `file_search` command — the unified file-search facade
 * (backend "everything" = voidtools Everything via its WM_COPYDATA IPC; "svc"
 * = the LumeSVC self-hosted USN index; "none" = neither backend available).
 * `status` "building" means the service index is still scanning and the
 * results are partial. */
export interface FileSearchOut {
  backend: "everything" | "svc" | "none";
  status: "ready" | "building" | "unavailable";
  entries: AppEntry[];
}

/** A history entry as returned by the Rust `search_clipboard` command. */
export interface ClipboardItem {
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
  /** False when the content is gone (image PNG missing, or every file of a
   * multi-file row missing) — the row shows strikethrough+gray and copy/paste
   * is blocked. */
  valid: boolean;
  /** Indices (into the newline-joined `content`) of the files checked in the
   * multi-file preview; `null` = no override (every existing file checked). */
  checked: number[] | null;
}

/** A deleted entry returned by `delete_clipboard`, kept for the undo buffer. */
export interface DeletedClip {
  kind: string;
  content: string;
  path: string | null;
  pinned: boolean;
  created_at: number;
  source_app: string;
  /** Raw JSON of the multi-file checked indices (restored with the row). */
  checked: string | null;
}

/** A clipboard filter category (`favorites` = pinned only). 文本文件/音乐/图片/视频
 * are content-kind filters over file rows (图片 also includes image rows). */
export type ClipKind = "all" | "text" | "textfile" | "image" | "music" | "video" | "favorites";

/** Payload pushed to the satellite preview window (mirrors the Rust
 * `PreviewRequest` in window.rs). */
export interface PreviewReq {
  kind: "text" | "textfile" | "image" | "audio" | "video" | "pdf" | "filelist";
  content: string | null;
  path: string | null;
  id: number | null;
  /** Multi-file rows (`filelist`): every recorded path. */
  paths?: string[];
  /** Stored checked-file indices for the list (null = no override). */
  checked?: number[] | null;
  /** 记住勾选 at request time — the satellite shows the toggle state. */
  remember_checks?: boolean;
}

/** A file's content kind (by extension) — drives the tile icon and whether
 * the preview pane opens. `"other"` (binaries like .dll/.exe/.zip) never opens
 * the preview pane. */
export type FileContent = "text" | "audio" | "video" | "image" | "pdf" | "other";

/** Open custom context menu: app or clipboard item, positioned at the cursor.
 * `fromRecent` marks an app opened from the 「最近使用」 bar, which adds a
 * soft-delete (remove-from-recent) menu action. */
export type MenuState =
  | { kind: "app"; x: number; y: number; app: AppEntry; fromRecent?: boolean }
  | { kind: "clip"; x: number; y: number; item: ClipboardItem }
  | { kind: "folder"; x: number; y: number; idx: number }
  | null;

/** Keys the launcher itself handles — the WebView2 blocker never blocks these. */
export const APP_KEYS = new Set([
  "Tab", "Enter", "Escape", "Delete",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
]);

/** Text-editing accelerators allowed inside the search input. */
export const EDIT_KEYS = new Set(["c", "v", "x", "a", "z", "y"]);

/** Auto-sizing the launcher window to its content (height only). */
export const MIN_WINDOW_H = 90; // empty-state minimum
// `.results` padding (6+6) + launcher border (2) + 1px gutters (2) + buffer.
export const WINDOW_PAD = 20;
/** Breathing room kept around the window when an expanded bar fills the screen. */
export const SCREEN_MARGIN = 32;
/** Fixed row height of a clipboard row (44–52px per the redesign spec). */
export const CLIP_ROW_H = 52;
/** Extra rows rendered above/below the visible window in the virtual list. */
export const CLIP_OVERSCAN = 4;
/** How long the delete-collapse animation runs before the row is removed. */
export const DELETE_ANIM_MS = 120;
/** Default toast dwell (ms); undo toasts get a longer window. */
export const TOAST_MS = 1600;
export const TOAST_UNDO_MS = 3000;

/** The clipboard filter tabs, in display order (labels are i18n keys). */
export const CLIP_CATS: { kind: ClipKind; label: keyof Messages }[] = [
  { kind: "all", label: "clipCategoryAll" },
  { kind: "text", label: "clipCategoryText" },
  { kind: "textfile", label: "clipCategoryTextFile" },
  { kind: "image", label: "clipCategoryImage" },
  { kind: "music", label: "clipCategoryMusic" },
  { kind: "video", label: "clipCategoryVideo" },
  { kind: "favorites", label: "clipCategoryFavorites" },
];
