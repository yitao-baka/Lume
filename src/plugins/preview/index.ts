//! Preview plugin — the `service` contribution owning the satellite preview
//! window routing (ROADMAP #7).
//!
//! The Rust side owns the window itself (created at startup, WS_EX_NOACTIVATE,
//! docked to the launcher's right edge — window lifecycle is core
//! infrastructure, like the settings window). This plugin owns everything
//! above it: which request the satellite should show, the ~100ms selection
//! debounce (fast keyboard scrolling through non-previewable rows must not
//! thrash the window), the show/close IPC and the synchronous
//! `currentPreview` state that gives Esc priority over the hide.

import { createEffect, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { PreviewReq } from "../../launcher/types";
import type { LauncherPlugin } from "../types";

export interface PreviewPluginDeps {
  /** The active mode's preview target for its selected row (null = hide). */
  previewTarget: () => PreviewReq | null;
  /** 设置/剪贴板 → 开启预览 — off = the satellite never pops. */
  enabled: () => boolean;
}

export function createPreviewPlugin(deps: PreviewPluginDeps): LauncherPlugin {
  const [currentPreview, setCurrentPreview] = createSignal<PreviewReq | null>(null);
  let previewTimer: number | undefined;

  // Satellite preview sync (ROADMAP #15): every selection / category / mode
  // change re-evaluates what the preview window should show, but the actual
  // show/hide is debounced (~100ms) so fast keyboard scrolling through rows
  // (esp. "other" binaries between previewable ones) doesn't thrash the window.
  // `currentPreview` tracks the pending request synchronously so Esc knows to
  // close the preview before hiding the launcher.
  createEffect(() => {
    const req = deps.enabled() ? deps.previewTarget() : null;
    setCurrentPreview(req);
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      if (req) void invoke("show_preview", { req });
      else void invoke("close_preview");
    }, 100);
  });
  onCleanup(() => clearTimeout(previewTimer));

  return {
    id: "preview",
    preview: {
      currentPreview,
      clear: () => setCurrentPreview(null),
    },
  };
}
