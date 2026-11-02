//! Bounded lazy-thumbnail bookkeeping for the clipboard page. Search returns
//! rows immediately; only image ids inside the rendered window ask the Rust
//! side for a decoded thumbnail.

import type { ClipboardItem } from "../../launcher/types";

export const CLIPBOARD_THUMB_BATCH_SIZE = 32;
export const CLIPBOARD_THUMB_CACHE_LIMIT = 64;

export interface ClipboardThumbnailUpdate {
  id: number;
  thumb: string | null;
}

export type ClipboardThumbCache = ReadonlyMap<number, string | null>;

/** Pick the uncached image rows in the visible slice, in visual order. The
 * backend command rejects batches above 32 ids, so this helper is the single
 * place that enforces both relevance and the request bound. */
export function clipboardThumbnailRequestIds(
  items: readonly ClipboardItem[],
  start: number,
  end: number,
  cache: ClipboardThumbCache,
  pending: ReadonlySet<number>,
  limit = CLIPBOARD_THUMB_BATCH_SIZE,
): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  const from = Math.max(0, Math.min(items.length, start));
  const to = Math.max(from, Math.min(items.length, end));
  for (let index = from; index < to && ids.length < limit; index++) {
    const item = items[index];
    if (
      item.kind !== "image" ||
      item.thumb ||
      seen.has(item.id) ||
      pending.has(item.id) ||
      cache.has(item.id)
    ) {
      continue;
    }
    seen.add(item.id);
    ids.push(item.id);
  }
  return ids;
}

/** Merge one batch without letting the base64 cache grow with the history.
 * Visible ids are retained preferentially; otherwise insertion order acts as
 * the LRU order (re-inserting an id refreshes it). */
export function mergeClipboardThumbnails(
  cache: ClipboardThumbCache,
  updates: readonly ClipboardThumbnailUpdate[],
  visibleIds: ReadonlySet<number>,
  limit = CLIPBOARD_THUMB_CACHE_LIMIT,
): Map<number, string | null> {
  const next = new Map(cache);
  for (const update of updates) {
    if (!Number.isSafeInteger(update.id) || update.id <= 0) continue;
    next.delete(update.id);
    next.set(update.id, update.thumb);
  }
  while (next.size > Math.max(0, limit)) {
    const victim = [...next.keys()].find((id) => !visibleIds.has(id)) ?? next.keys().next().value;
    if (victim === undefined) break;
    next.delete(victim);
  }
  return next;
}
