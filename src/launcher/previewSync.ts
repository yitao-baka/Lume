//! Satellite-preview sync — watches the clipboard selection and pushes the
//! debounced show/close requests to the preview window. The launcher's Esc
//! priority reads `currentPreview` synchronously (the actual show/hide lags
//! ~100ms behind the selection).

import { createEffect, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { previewTarget } from "./clipData";
import type { ClipboardItem, PreviewReq } from "./types";

export interface PreviewSyncDeps {
  mode: () => "apps" | "clipboard";
  clipKind: () => unknown;
  clips: () => ClipboardItem[];
  selected: () => number;
  previewEnabled: () => boolean;
  rememberChecks: () => boolean;
}

export function createPreviewSync(deps: PreviewSyncDeps) {
  const [currentPreview, setCurrentPreview] = createSignal<PreviewReq | null>(null);
  let previewTimer: number | undefined;

  // Satellite preview sync (ROADMAP #15): every selection / category / mode
  // change re-evaluates what the preview window should show, but the actual
  // show/hide is debounced (~100ms) so fast keyboard scrolling through rows
  // (esp. "other" binaries between previewable ones) doesn't thrash the window.
  // `currentPreview` tracks the pending request synchronously so Esc knows to
  // close the preview before hiding the launcher.
  createEffect(() => {
    void deps.mode();
    void deps.clipKind();
    void deps.clips();
    void deps.selected();
    void deps.previewEnabled();
    void deps.rememberChecks();
    const item = deps.mode() === "clipboard" ? deps.clips()[deps.selected()] : undefined;
    // 开启预览 off → never open the satellite (close_preview handles teardown).
    const req =
      item && deps.previewEnabled() ? previewTarget(item, deps.rememberChecks()) : null;
    setCurrentPreview(req);
    clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      if (req) void invoke("show_preview", { req });
      else void invoke("close_preview");
    }, 100);
  });
  onCleanup(() => clearTimeout(previewTimer));

  return { currentPreview, setCurrentPreview };
}
