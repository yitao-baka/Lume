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
    bottom: scrollTop + clientHeight < scrollHeight,
  };
}
