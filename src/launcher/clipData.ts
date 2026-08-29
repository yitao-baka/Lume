//! Pure clipboard-data helpers — display-time classification and formatting
//! with no signals, no IPC and no DOM. Everything here is deterministic given
//! its arguments (timestamps excepted, which the caller supplies).

import { t } from "../i18n";
import type { ClipboardItem, FileContent, PreviewReq } from "./types";

/** Last path segment (handles both `/` and `\` separators). */
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

// ── Text subtype detection (URL / color) — display-time classification ──
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RGB_RE =
  /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*[\d.]+)?\s*\)$/;
const HSL_RE =
  /^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%(?:\s*,\s*[\d.]+)?\s*\)$/;

export function isUrl(text: string): boolean {
  const t = text.trim();
  return /^https?:\/\/\S+/i.test(t) || /^www\.\S+/i.test(t);
}

/** A color value when the whole (trimmed) text is a supported color. */
export function detectColor(text: string): string | null {
  const t = text.trim();
  if (HEX_RE.test(t) || RGB_RE.test(t) || HSL_RE.test(t)) return t;
  return null;
}

/** First line of a clipboard row: image/file label, a merged-copy title, the
 * color value, or text/URL. */
export function clipTitle(item: ClipboardItem): string {
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
export function clipTime(ts: number, absolute: boolean): string {
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
export function clipMeta(
  item: ClipboardItem,
  showSource: boolean,
  absolute: boolean
): string {
  const time = clipTime(item.created_at, absolute);
  if (showSource && item.source_app) return `${item.source_app} · ${time}`;
  return time;
}

const TEXT_EXTS = new Set([
  // Markup / data
  "txt","md","log","json","toml","ini","cfg","yaml","yml","csv",
  "html","css","xml","sh","bat","ps1","sql","tex",
  // Source code (common programming languages)
  "rs","py","js","ts","jsx","tsx","mjs","cjs","c","cpp","h","java","go","lua",
  "kt","swift","php","rb","dart","scala","cs","fs","fsx","r","pl","hs","zig","nim",
  "ex","exs","erl","clj","vue","svelte","groovy","gradle","proto","gql",
  // Lyrics & subtitles
  "lrc","srt","vtt","ass",
]);
const AUDIO_EXTS = new Set(["mp3","wav","flac","ogg","m4a","aac","wma","opus","mid","midi"]);
const VIDEO_EXTS = new Set(["mp4","mkv","webm","mov","avi","wmv","flv","m4v","mpg","mpeg"]);
const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","bmp","webp","ico","svg","tif","tiff"]);
const PDF_EXTS = new Set(["pdf"]);

export function fileContent(name: string): FileContent {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (TEXT_EXTS.has(ext)) return "text";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (PDF_EXTS.has(ext)) return "pdf";
  return "other";
}

/** Build the satellite-preview payload for a row, or null when no preview
 * should show (the window then hides). Only *content* previews: file rows whose
 * content kind (by extension) is text/audio/video/image, plus clipboard image
 * rows (`kind === "image"` — a captured screenshot) which preview in every
 * category. Plain copied text (kind `"text"`) never opens the satellite, and
 * "other" binaries (.dll/.exe/.zip…) never do. Image-kind rows carry an `id`
 * resolved via `get_clipboard_image`; image-file rows a `path`.
 *
 * Two additions (ROADMAP #17): ① an **invalid** row (content gone) never opens
 * the preview; ② a **multi-file** row (≥2 paths) always shows the file LIST —
 * with checkboxes and per-file existence — instead of previewing one of its
 * files. */
export function previewTarget(
  item: ClipboardItem | undefined,
  rememberChecks: boolean
): PreviewReq | null {
  if (!item) return null;
  // 失效条目 (item 7): the content is gone → never expand the preview.
  if (item.valid === false) return null;
  if (item.kind === "text") return null; // plain copied text — never previews
  if (item.kind === "image") return { kind: "image", content: null, path: null, id: item.id };
  const paths = item.content.split("\n").filter(Boolean);
  // 多文件条目 (item 2): always the file list, never a single-file preview.
  if (paths.length >= 2) {
    return {
      kind: "filelist",
      content: null,
      path: null,
      id: item.id,
      paths,
      checked: item.checked ?? null,
      remember_checks: rememberChecks,
    };
  }
  const first = paths[0] ?? "";
  const fc = fileContent(basename(first));
  if (fc === "text") return { kind: "textfile", content: null, path: first, id: null };
  if (fc === "audio") return { kind: "audio", content: null, path: first, id: null };
  if (fc === "video") return { kind: "video", content: null, path: first, id: null };
  if (fc === "image") return { kind: "image", content: null, path: first, id: null };
  if (fc === "pdf") return { kind: "pdf", content: null, path: first, id: null };
  return null; // "other" — binary; no preview
}
