//! Bounded clipboard Page Model helpers. The Page Runtime rejects snapshots
//! over 1 MiB; the clipboard service therefore budgets rows before publishing
//! rather than letting one screenshot history turn the whole page into an
//! empty error state.

import { DEFAULT_MODEL_MAX_BYTES } from "../../page-runtime/modelStore";

/** Display-only preview kept in the window. Full clipboard content stays in
 * the Page Service and is reached through actions/preview by target id. */
export const CLIPBOARD_CONTENT_PREVIEW_CHARS = 4096;

/** Leave a small serialization margin for runtime-owned wrapper fields. */
export const CLIPBOARD_MODEL_MAX_BYTES = DEFAULT_MODEL_MAX_BYTES - 1024;

export interface ModelWindowCandidate<T> {
  /** Preferred row (includes an inline image thumbnail when available). */
  full: T;
  /** Same row with the large visual resource removed. */
  compact: T;
}

export interface ModelWindowResult<T> {
  items: T[];
  bytes: number;
}

export function clipContentPreview(content: string): string {
  return content.length > CLIPBOARD_CONTENT_PREVIEW_CHARS
    ? content.slice(0, CLIPBOARD_CONTENT_PREVIEW_CHARS)
    : content;
}

function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

/** Bound the optional multi-file preview independently from the row window.
 * The complete checked set stays in the store; only the preview copy is
 * shortened by entries and serialized bytes. */
export function fitClipboardFileListPreview(
  paths: string[],
  checked: number[] | null,
  maxEntries = 256,
  maxBytes = Math.floor(CLIPBOARD_MODEL_MAX_BYTES / 2),
): { paths: string[]; checked: number[] | null } {
  const head = paths.slice(0, Math.max(0, maxEntries));
  const checkedWithin = (count: number) =>
    checked ? checked.filter((index) => Number.isInteger(index) && index >= 0 && index < count) : null;
  let count = head.length;
  while (count > 0) {
    const candidate = { paths: head.slice(0, count), checked: checkedWithin(count) };
    if (serializedBytes(candidate) <= maxBytes) return candidate;
    count = Math.floor(count / 2);
  }
  return { paths: [], checked: checkedWithin(0) };
}

/** Add contiguous rows until the next one no longer fits. A row is first
 * tried with its thumbnail; oversized visuals fall back to its compact form
 * without dropping the row from the visible window. */
export function fitClipboardModelWindow<T>(
  candidates: ModelWindowCandidate<T>[],
  buildModel: (items: T[]) => unknown,
  maxBytes = CLIPBOARD_MODEL_MAX_BYTES,
): ModelWindowResult<T> {
  let items: T[] = [];
  let bytes = serializedBytes(buildModel(items));
  for (const candidate of candidates) {
    const withVisual = [...items, candidate.full];
    const withVisualBytes = serializedBytes(buildModel(withVisual));
    if (withVisualBytes <= maxBytes) {
      items = withVisual;
      bytes = withVisualBytes;
      continue;
    }
    const compact = [...items, candidate.compact];
    const compactBytes = serializedBytes(buildModel(compact));
    if (compactBytes <= maxBytes) {
      items = compact;
      bytes = compactBytes;
      continue;
    }
    break;
  }
  return { items, bytes };
}
