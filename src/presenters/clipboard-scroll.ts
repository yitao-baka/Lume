// Shared real-scroll fade test for the clipboard Presenters. Overscan decides
// which rows are materialized; it must never decide whether content exists
// above/below the viewport.
export interface ClipboardScrollFades {
  top: boolean;
  bottom: boolean;
}

export function clipboardScrollFades(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): ClipboardScrollFades {
  return {
    top: scrollTop > 0,
    // Browser scrollTop can clamp to a fractional value a fraction below the
    // mathematical maximum at non-integer DPI. Compare the visible bottom edge
    // after pixel rounding so a true end does not keep a phantom fade.
    bottom: Math.ceil(scrollTop + clientHeight) < Math.ceil(scrollHeight),
  };
}
