//! Shared keyboard-capture helpers for the shortcut recorders (快捷键 page and
//! the 自动化 page). Turns a `keydown` into the combo string the Rust parser
//! accepts ("Ctrl+Alt+K").

/** Keyboard `code` → the shortcut name the Rust parser accepts ("KeyK" → "K"). */
export function codeToKey(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

/** Build a shortcut string from a keydown event ("Ctrl+Alt+K"). Returns null
 * while only modifiers are held (keep waiting for the main key). */
export function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const key = codeToKey(e.code);
  return key ? [...mods, key].join("+") : null;
}