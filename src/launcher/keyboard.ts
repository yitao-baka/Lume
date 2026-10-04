//! Keyboard routing — the window-level keydown handler (Esc layering, mode
//! switch, shared ↑/↓/Enter fallback) and the WebView2 built-in accelerator
//! blocker. Installed once per launcher window. Per-page keys (grid arrows,
//! bar navigation, category switching, …) are delegated to the active page's
//! `onKey`; this router only owns the global layers.

import { invoke } from "@tauri-apps/api/core";
import { APP_KEYS, EDIT_KEYS, type MenuState, type Mode, type PreviewReq } from "./types";
import type { ModeId, ModeInstance, ModeKeyContext, PageRow } from "../plugins/types";

export interface KeyDeps {
  mode: () => Mode;
  /** Key that switches modes (settings → 快捷键). */
  switchKey: () => string;
  /** All enabled mode ids in cycle order (home page first, then plugin modes). */
  modeIds: () => ModeId[];
  shiftEnterAdmin: () => boolean;
  menu: () => MenuState;
  currentResults: () => PageRow[];
  currentPreview: () => PreviewReq | null;
  setCurrentPreview: (v: PreviewReq | null) => void;
  markKeyboard: () => void;
  /** The active page — page-specific keys are delegated to it. */
  activeMode: () => ModeInstance | undefined;
  gridCols: () => number;
  moveSelection: (delta: number) => void;
  activate: (opts?: { elevated?: boolean }) => void;
  switchMode: (m: Mode) => void;
  resetAndHide: () => void;
  closeMenu: () => void;
}

/** True when `e` matches a mode-switch shortcut (a single key like "Tab" or
 * a modifier combo like "Ctrl+Q"). */
export function matchesSwitchKey(e: KeyboardEvent, combo: string): boolean {
  if (!combo) return false;
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.length === 0) return e.key === combo;
  if (e.ctrlKey !== mods.includes("Ctrl")) return false;
  if (e.altKey !== mods.includes("Alt")) return false;
  if (e.shiftKey !== mods.includes("Shift")) return false;
  if (e.metaKey !== mods.includes("Super")) return false;
  return e.key.toLowerCase() === key.toLowerCase();
}

export function createKeyRouter(deps: KeyDeps) {
  function onKeyDown(e: KeyboardEvent) {
    const hasResults = deps.currentResults().length > 0;
    if (e.key === "Escape") {
      e.preventDefault();
      if (deps.menu()) {
        deps.closeMenu();
      } else if (deps.activeMode()?.onEscape()) {
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
    } else if (matchesSwitchKey(e, deps.switchKey())) {
      e.preventDefault();
      // Cycle through every enabled page (home first, then plugin modes).
      const modes = deps.modeIds();
      const idx = modes.indexOf(deps.mode());
      void deps.switchMode(modes[(Math.max(idx, 0) + 1) % modes.length]);
    } else {
      // Page-owned keys first (grid arrows + bar navigation, category
      // switching, multi-select, delete), then the shared bindings (↑/↓ move,
      // Enter activates).
      const inst = deps.activeMode();
      const ctx: ModeKeyContext = {
        hasResults,
        moveSelection: deps.moveSelection,
        gridCols: deps.gridCols,
        markKeyboard: deps.markKeyboard,
      };
      if (inst?.onKey(e, ctx)) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (hasResults) {
          e.preventDefault();
          deps.moveSelection(e.key === "ArrowDown" ? 1 : -1);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        deps.activate({ elevated: e.shiftKey && deps.shiftEnterAdmin() });
      }
    }
  }

  /** Block every WebView2/Chromium built-in accelerator (Find, Print, Reload,
   * DevTools, history navigation, …) except the keys Lume handles and text
   * editing inside the search input. */
  function blockBrowserKeys(e: KeyboardEvent) {
    if (APP_KEYS.has(e.key)) return; // launcher's own keys
    const input = document.getElementById("search-input");
    const editing = e.ctrlKey && input === document.activeElement;
    if (editing && EDIT_KEYS.has(e.key.toLowerCase())) return; // Ctrl+C/V/… in the input
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
