/** Shared toast dwell-time policy.
 *
 * A toast is only useful if it stays long enough to finish reading. Short
 * confirmations keep a predictable floor, while longer localized messages get
 * extra time based on their approximate reading weight. CJK characters carry
 * more information per glyph than Latin characters, so the estimate weights
 * them separately.
 */

export const TOAST_MIN_MS = 4_000;
export const TOAST_UNDO_MIN_MS = 6_000;
export const TOAST_MAX_AUTO_MS = 12_000;

const CJK_READING_MS = 180;
const OTHER_READING_MS = 60;
const READING_GRACE_MS = 1_500;
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export interface ToastDurationOptions {
  /** Undo toasts need enough time to notice and activate the action. */
  undo?: boolean;
  /** Explicit plugin override. The readable minimum still wins. */
  duration?: number;
  /** Per-surface floor; the global normal/undo floors still apply. */
  minDuration?: number;
}

/** Return the auto-dismiss delay for a toast containing `text`. */
export function toastDurationMs(text: string, opts: ToastDurationOptions = {}): number {
  let cjkChars = 0;
  let otherChars = 0;
  for (const char of String(text)) {
    if (!char.trim()) continue;
    if (CJK_CHARACTER.test(char)) cjkChars++;
    else otherChars++;
  }

  const readingMs = READING_GRACE_MS + cjkChars * CJK_READING_MS + otherChars * OTHER_READING_MS;
  const minimum = Math.max(
    opts.minDuration ?? 0,
    opts.undo ? TOAST_UNDO_MIN_MS : TOAST_MIN_MS,
  );
  const autoMs = Math.min(TOAST_MAX_AUTO_MS, Math.max(minimum, readingMs));
  const requestedMs = Number.isFinite(opts.duration) ? Math.max(0, opts.duration ?? 0) : 0;
  return Math.round(Math.max(autoMs, requestedMs));
}
