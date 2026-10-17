//! Shared keyboard predicates for the launcher and its pages.
//!
//! IME composition and native text editing are not launcher shortcuts: they
//! must pass through untouched even while the window-level router is active.

/** True while an IME candidate window owns the key (including the legacy
 * `keyCode === 229` signal WebView2 uses for some Chinese input methods). */
export function isImeComposing(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

const NON_TEXT_INPUTS = new Set([
  "button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit",
]);

/** True when the event target is a text-editing control. Checkboxes and
 * buttons are deliberately excluded: their native Space/Enter semantics
 * belong to the control, not to text editing. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  return (
    (target instanceof HTMLInputElement && !NON_TEXT_INPUTS.has(target.type)) ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
