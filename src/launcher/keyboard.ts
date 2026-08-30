//! Keyboard routing — the window-level keydown handler (Esc layering, mode
//! switch, per-mode arrow/Enter/Delete handling) and the WebView2 built-in
//! accelerator blocker. Installed once per launcher window.

import { invoke } from "@tauri-apps/api/core";
import { APP_KEYS, EDIT_KEYS, type AppEntry, type ClipboardItem, type MenuState, type Mode, type PreviewReq } from "./types";
import type { ModeId } from "../plugins/types";
import type { NavigateStore } from "./navigate";
import type { ModeInstance } from "../plugins/types";

export interface KeyDeps {
  mode: () => Mode;
  appsQuery: () => string;
  /** Key that switches modes (settings → 快捷键). */
  switchKey: () => string;
  /** All enabled mode ids in cycle order (apps first, then plugin modes). */
  modeIds: () => ModeId[];
  shiftEnterAdmin: () => boolean;
  /** Settings: show the 「最近使用」 bar (gates bar navigation). */
  showRecent: () => boolean;
  selected: () => number;
  menu: () => MenuState;
  currentResults: () => (AppEntry | ClipboardItem)[];
  currentPreview: () => PreviewReq | null;
  setCurrentPreview: (v: PreviewReq | null) => void;
  markKeyboard: () => void;
  nav: NavigateStore;
  /** The active plugin mode — plugin-specific keys are delegated to it. */
  activeMode: () => ModeInstance | undefined;
  /** Let the active mode consume Esc (multi-select) before hiding. */
  onModeEscape: () => boolean;
  gridCols: () => number;
  moveSelection: (delta: number) => void;
  activate: () => void;
  activateAdmin: () => void;
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
    const { nav } = deps;
    const hasResults = deps.currentResults().length > 0;
    if (e.key === "Escape") {
      e.preventDefault();
      if (deps.menu()) {
        deps.closeMenu();
      } else if (deps.onModeEscape()) {
        // The active mode consumed Esc (e.g. leave multi-select) — stay open.
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
      // Cycle through every enabled mode (apps first, then plugin modes).
      const modes = deps.modeIds();
      const idx = modes.indexOf(deps.mode());
      void deps.switchMode(modes[(Math.max(idx, 0) + 1) % modes.length]);
    } else if (deps.mode() === "apps") {
      const empty = deps.appsQuery() === "";
      // ── search results grid (non-empty query) ──
      // Grid navigation always wins when there is a query, regardless of
      // `zone` — the zone signal belongs to the bar view and may carry a
      // stale value from a prior empty-query interaction.
      if (!empty) {
        if (!hasResults) return;
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          deps.markKeyboard();
          deps.moveSelection(-1);
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          deps.markKeyboard();
          deps.moveSelection(1);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          deps.markKeyboard();
          deps.moveSelection(deps.gridCols());
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          deps.markKeyboard();
          deps.moveSelection(-deps.gridCols());
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (e.shiftKey && deps.shiftEnterAdmin()) deps.activateAdmin();
          else deps.activate();
        }
        return;
      }
      // ── empty-query bar navigation (最近使用 / 已固定, one continuous grid) ──
      const hasBars =
        (deps.showRecent() && nav.recentApps().length > 0) ||
        nav.pinnedApps().length > 0 ||
        !!nav.folderCtx();
      if (!hasBars) return;
      if (e.key === "ArrowLeft") {
        deps.markKeyboard();
        e.preventDefault();
        nav.moveBarSelection(-1, 0);
      } else if (e.key === "ArrowRight") {
        deps.markKeyboard();
        e.preventDefault();
        nav.moveBarSelection(1, 0);
      } else if (e.key === "ArrowDown") {
        deps.markKeyboard();
        e.preventDefault();
        nav.moveBarSelection(0, 1);
      } else if (e.key === "ArrowUp") {
        deps.markKeyboard();
        e.preventDefault();
        nav.moveBarSelection(0, -1);
      } else if (e.key === "Delete") {
        // Remove the selected recent entry (soft delete). In the grid zone
        // (typing) Delete falls through to text editing in the search input.
        if (nav.zone() === "recent") {
          e.preventDefault();
          const item = nav.recentApps()[nav.recentSelected()];
          if (item) void nav.deleteRecent(item);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (e.shiftKey && deps.shiftEnterAdmin()) deps.activateAdmin();
        else deps.activate();
      }
    } else {
      // Plugin mode: mode-specific keys first (category switching,
      // multi-select, delete), then the shared grid bindings (↑/↓ move,
      // Enter activates).
      const inst = deps.activeMode();
      const handled = inst?.onKey(e, { hasResults, moveSelection: deps.moveSelection }) ?? false;
      if (handled) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (hasResults) {
          e.preventDefault();
          deps.moveSelection(e.key === "ArrowDown" ? 1 : -1);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        deps.activate();
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
