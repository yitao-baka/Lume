//! Deterministic fallback tiles for result rows whose real icon is still
//! loading or unavailable. The letter is the first user-perceived grapheme
//! (not the first UTF-16 code unit), and the path/name hash picks one of ten
//! dark-on-light colors so repeated renders never shuffle the palette.

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>;
}

type GraphemeSegmenterCtor = new (
  locales?: string | string[],
  options?: { granularity: "grapheme" }
) => GraphemeSegmenter;

const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterCtor }).Segmenter;
const segmenter = Segmenter
  ? new Segmenter(undefined, { granularity: "grapheme" })
  : null;

const LETTER_TILE_PALETTE = [
  "#f6d1c1",
  "#f2d59b",
  "#d9e8a3",
  "#bfe3c6",
  "#b9e3e2",
  "#c5dcf4",
  "#d3d3f5",
  "#e6d0ef",
  "#f3cfe2",
  "#e4d6c7",
] as const;

/** First grapheme of a user-visible label, with a broad-runtime fallback. */
export function firstGrapheme(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "·";
  if (segmenter) {
    const first = segmenter.segment(trimmed)[Symbol.iterator]().next().value;
    if (first?.segment) return first.segment;
  }
  return Array.from(trimmed)[0] ?? "·";
}

/** Stable color pick keyed by path, then name. */
export function letterTile(name: string, path = ""): { char: string; background: string } {
  const key = (path || name).toLocaleLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return {
    char: firstGrapheme(name),
    background: LETTER_TILE_PALETTE[(hash >>> 0) % LETTER_TILE_PALETTE.length],
  };
}
