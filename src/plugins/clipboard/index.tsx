//! Clipboard plugin — the first `mode` contribution (ROADMAP #7).
//!
//! Owns a full launcher page: the history store (`store.ts`), the view
//! (`ClipboardView.tsx`), the mode-specific keyboard handling, the
//! 记住上次所在页面 page kind and the settings slice it renders live. The
//! satellite preview is NOT part of this plugin — the mode only *reports*
//! the selected row's preview target; the `preview` service plugin decides
//! what to do with it.

import type { LauncherPlugin, ModeInstance, ModeKeyContext, PluginServices } from "../../plugins/types";
import { previewTarget } from "../../launcher/clipData";
import clipboardIconUrl from "../../../res/icons/clipboard.svg";
import { createClipboardStore } from "./store";
import { ClipboardView } from "./ClipboardView";

export function createClipboardPlugin(services: PluginServices): LauncherPlugin {
  const clip = createClipboardStore(services);

  /** Mode-specific keys (the root handles Esc/mode-switch/shared ↑↓ Enter
   * bookkeeping before calling this). Original clipboard bindings: ←/→
   * switch categories on an empty query; Space toggles multi-select; Del
   * deletes; Enter activates (the root calls `activate` for Enter/↑↓). */
  function onKey(e: KeyboardEvent, ctx: ModeKeyContext): boolean {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      if (clip.clipQuery() === "") {
        e.preventDefault();
        clip.switchCategory(e.key === "ArrowLeft" ? -1 : 1);
        return true;
      }
      return false;
    }
    if (e.key === " ") {
      if (ctx.hasResults) {
        e.preventDefault();
        clip.toggleMulti(clip.selected());
        return true;
      }
      return false;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      void clip.deleteSelected();
      return true;
    }
    return false;
  }

  const instance: ModeInstance = {
    query: clip.clipQuery,
    setQuery: clip.setClipQuery,
    search: clip.search,
    reset: clip.reset,
    selected: clip.selected,
    setSelected: clip.setSelected,
    rows: clip.clips,
    activate: clip.activate,
    onKey,
    onEscape: clip.onEscape,
    previewTarget: () => previewTarget(clip.clips()[clip.selected()], clip.rememberChecks()),
    previewEnabled: clip.previewEnabled,
    measureViewport: clip.measureViewport,
    pageKind: clip.pageKind,
    restorePage: clip.restorePage,
    applySettings: clip.applySettings,
    View: () => <ClipboardView clip={clip} services={services} />,
  };

  /** The shared context menu's clipboard actions (the store satisfies the
   * narrow `ClipMenuActions` interface menu.ts declares). */
  function clipMenuActions() {
    return clip;
  }

  return {
    id: "clipboard",
    modeMeta: {
      labelKey: "clipboard",
      placeholderKey: "placeholderClipboard",
      icon: clipboardIconUrl,
    },
    mode: instance,
    clipMenuActions,
  };
}
