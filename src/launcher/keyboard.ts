//! Keyboard routing — the window-level keydown handler (Esc layering, mode
//! switch, shared ↑/↓/Enter fallback) and the WebView2 built-in accelerator
//! blocker. Installed once per launcher window. Per-page keys (grid arrows,
//! bar navigation, category switching, …) are delegated to the active page's
//! `onKey`; this router only owns the global layers.

import { invoke } from "@tauri-apps/api/core";
import { APP_KEYS, EDIT_KEYS, type MenuState, type Mode, type PreviewReq } from "./types";
import type { ModeId, ModeInstance, ModeKeyContext, PageRow } from "../plugins/types";
import { isImeComposing, isTextEditingTarget } from "./keyInput";

export interface KeyDeps {
  mode: () => Mode;
  /** Key that switches modes (settings → 快捷键). */
  switchKey: () => string;
  /** Visible mode ids in cycle order (home page first, then plugin modes) —
   * modes declared `hidden` are excluded. */
  modeIds: () => ModeId[];
  shiftEnterAdmin: () => boolean;
  menu: () => MenuState;
  currentResults: () => PageRow[];
  currentPreview: () => PreviewReq | null;
  setCurrentPreview: (v: PreviewReq | null) => void;
  markKeyboard: () => void;
  /** Context-menu keys. The menu owns the keyboard while open; this callback
   * implements arrow/Home/End/Enter navigation and may close the menu. */
  handleMenuKey: (e: KeyboardEvent) => void;
  /** The active page — page-specific keys are delegated to it. */
  activeMode: () => ModeInstance | undefined;
  gridCols: () => number;
  moveSelection: (delta: number) => void;
  activate: (opts?: { elevated?: boolean }) => void;
  switchMode: (m: Mode) => void;
  resetAndHide: () => void;
  closeMenu: () => void;
  openSettings: () => void;
  /** F6 / Shift+F6: search box → mode bar → page → settings → search. */
  cycleFocus: (backwards: boolean) => void;
}

/** True when `e` matches a mode-switch shortcut (a single key like "Tab" or
 * a modifier combo like "Ctrl+Q"). */
export function matchesSwitchKey(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (
    e.ctrlKey !== mods.includes("Ctrl") ||
    e.altKey !== mods.includes("Alt") ||
    e.shiftKey !== mods.includes("Shift") ||
    e.metaKey !== mods.includes("Super")
  ) {
    return false;
  }
  if (mods.length === 0) return e.key.toLowerCase() === combo.toLowerCase();
  if (e.ctrlKey !== mods.includes("Ctrl")) return false;
  if (e.altKey !== mods.includes("Alt")) return false;
  if (e.shiftKey !== mods.includes("Shift")) return false;
  if (e.metaKey !== mods.includes("Super")) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

/** A combo that includes a modifier never needs the "only while typing"
 * exemption a bare key (Tab) needs. */
function comboHasModifier(combo: string): boolean {
  const parts = combo.split("+");
  return parts.length > 1 && parts.slice(0, -1).some(Boolean);
}

export function createKeyRouter(deps: KeyDeps) {
  function onKeyDown(e: KeyboardEvent) {
    // An IME candidate list owns Enter/Space/arrows until the composition is
    // committed. Never preventDefault here, or CJK input methods break.
    if (isImeComposing(e)) return;
    const hasResults = deps.currentResults().length > 0;

    // A context menu is a keyboard scope of its own. Escape closes it; every
    // other key goes to the menu handler and is never routed to the page
    // behind the overlay.
    if (deps.menu()) {
      if (e.key === "Escape") {
        e.preventDefault();
        deps.closeMenu();
      } else {
        deps.handleMenuKey(e);
      }
      return;
    }

    if (e.key === "Escape") {
      e.preventDefault();
      if (deps.activeMode()?.onEscape()) {
        // The active page consumed Esc (a drill level popped, multi-select
        // left) — stay open.
      } else if (deps.currentPreview()) {
        // Close the satellite preview without hiding the launcher. The preview
        // window is WS_EX_NOACTIVATE and can never receive the key itself, so
        // Esc is routed here in the main window.
        deps.setCurrentPreview(null);
        void invoke("close_preview");
      } else {
        deps.resetAndHide();
      }
      return;
    }

    const inst = deps.activeMode();
    const ctx: ModeKeyContext = {
      hasResults,
      moveSelection: deps.moveSelection,
      gridCols: deps.gridCols,
      markKeyboard: deps.markKeyboard,
      editing: isTextEditingTarget(e.target),
    };

    // Modal page scopes must run before the mode-switch shortcut and the
    // shared Enter/arrow fallback. The page handles Escape through onEscape.
    if (inst?.modal?.()) {
      inst.onKey(e, ctx);
      return;
    }

    // F6 cycles focus between the search box, the mode bar, the active page
    // and the settings gear. This gives keyboard users a way out of the
    // search input without consuming Tab (see the plain-Tab gate below).
    if (e.key === "F6") {
      e.preventDefault();
      deps.cycleFocus(e.shiftKey);
      return;
    }

    // Standard settings shortcut. Kept independent of the configurable mode
    // switch key so a custom combo can never make Settings unreachable.
    if (e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === ",") {
      e.preventDefault();
      deps.openSettings();
      return;
    }

    // Right-click menu without a mouse: Shift+F10 / the Menu key acts on the
    // current bar tile or result row.
    if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
      if (inst?.openContextMenu?.()) {
        e.preventDefault();
        return;
      }
    }

    // A bare Tab is the historical mode-switch key, but it must not swallow
    // focus traversal everywhere. Keep it while the search box is focused
    // (the launcher's primary workflow) and accept Ctrl+Tab globally. With
    // any other focus, Tab / Shift+Tab move focus natively.
    const switchCombo = deps.switchKey();
    const plainTab = switchCombo.trim().toLowerCase() === "tab";
    const ctrlTabAlias =
      plainTab &&
      e.key === "Tab" &&
      e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.metaKey;
    const searchFocused =
      isTextEditingTarget(e.target) ||
      document.activeElement?.id === "search-input";
    const switchMatched =
      matchesSwitchKey(e, switchCombo) || ctrlTabAlias;
    if (switchMatched && (comboHasModifier(switchCombo) || ctrlTabAlias || searchFocused)) {
      e.preventDefault();
      // Cycle through every visible page (home first, then plugin modes).
      // Hidden modes (manifest `hidden`) are not in this list; when one is
      // active the cycle restarts from the first page (the home page).
      const modes = deps.modeIds();
      if (modes.length === 0) return;
      const idx = modes.indexOf(deps.mode());
      void deps.switchMode(idx < 0 ? modes[0] : modes[(idx + 1) % modes.length]);
    } else {
      // Page-owned keys first (grid arrows + bar navigation, category
      // switching, multi-select, delete), then the shared bindings (↑/↓ move,
      // Enter activates).
      if (inst?.onKey(e, ctx)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (hasResults) {
          e.preventDefault();
          deps.moveSelection(e.key === "ArrowDown" ? 1 : -1);
        }
      } else if (
        e.key === "Enter" &&
        !(e.target instanceof Element && e.target.closest("button"))
      ) {
        e.preventDefault();
        deps.activate({ elevated: e.shiftKey && deps.shiftEnterAdmin() });
      }
    }
  }

  /** Block every WebView2/Chromium built-in accelerator (Find, Print, Reload,
   * DevTools, history navigation, …) except the keys Lume handles and text
   * editing inside the search input. */
  function blockBrowserKeys(e: KeyboardEvent) {
    if (isImeComposing(e)) return;
    if (APP_KEYS.has(e.key)) return; // launcher's own keys
    const editing = isTextEditingTarget(e.target);
    // Allow the full native Windows edit set (Ctrl+Backspace, Ctrl+Home/End,
    // word navigation, …), not only clipboard/history commands.
    if (editing && EDIT_KEYS.has(e.key.toLowerCase())) return;
    if (e.ctrlKey || e.altKey || e.metaKey || /^F\d{1,2}$/.test(e.key)) {
      e.preventDefault();
    }
  }

  /** Add both window listeners; returns their removal (for onCleanup). */
  function install(): () => void {
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keydown", blockBrowserKeys);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keydown", blockBrowserKeys);
    };
  }

  return { onKeyDown, install };
}
