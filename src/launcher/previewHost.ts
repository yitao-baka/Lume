//! Core satellite-preview host state. The window and its renderer belong to
//! the launcher; this module owns the policy above that window: explicit
//! show/close, the short selection debounce used by first-party pages, and the
//! synchronous "something is open" signal that gives Esc priority over hiding
//! the launcher. External plugins reach the same host through `ctx.preview`.

import { createEffect, createSignal, onCleanup } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { PreviewReq } from "./types";

/** Fast keyboard scrolling must not thrash the preview window. */
export const PREVIEW_DEBOUNCE_MS = 100;

export interface PreviewHostDeps {
  /** First-party page selection target (null = hide). */
  target: () => PreviewReq | null;
  /** Setting-driven gate for the first-party follow source. */
  enabled: () => boolean;
}

export interface PreviewHost {
  /** The pending request while the satellite should be considered open. */
  current: () => PreviewReq | null;
  /** Show one request explicitly; resolves once Rust accepted it. */
  show(request: PreviewReq): Promise<void>;
  /** Close immediately; safe to call repeatedly. */
  close(): Promise<void>;
  /** Mirror a preview accepted by Rust (plugin/other window). */
  remember(): void;
  /** Drop Esc-priority state without issuing IPC (Rust teardown event). */
  clear(): void;
}

/** Validate the structural shape before it crosses IPC. The Rust boundary
 * repeats this check because raw invoke is reachable from trusted windows. */
export function validatePreviewRequest(request: unknown): PreviewReq {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("preview.show: request must be an object");
  }
  const value = request as Record<string, unknown>;
  const kinds = ["text", "textfile", "image", "audio", "video", "pdf", "filelist"];
  if (typeof value.kind !== "string" || !kinds.includes(value.kind)) {
    throw new Error("preview.show: unsupported kind");
  }
  if (value.content != null && typeof value.content !== "string") {
    throw new Error("preview.show: content must be a string");
  }
  if (value.path != null && typeof value.path !== "string") {
    throw new Error("preview.show: path must be a string");
  }
  if (value.id != null && (!Number.isInteger(value.id) || Number(value.id) <= 0)) {
    throw new Error("preview.show: id must be a positive integer");
  }
  if (value.paths != null && (!Array.isArray(value.paths) || value.paths.some((p) => typeof p !== "string"))) {
    throw new Error("preview.show: paths must be an array of strings");
  }
  if (
    value.checked != null &&
    (!Array.isArray(value.checked) || value.checked.some((n) => !Number.isInteger(n) || Number(n) < 0))
  ) {
    throw new Error("preview.show: checked must be an array of non-negative integers");
  }
  if (value.remember_checks != null && typeof value.remember_checks !== "boolean") {
    throw new Error("preview.show: remember_checks must be a boolean");
  }
  return {
    kind: value.kind as PreviewReq["kind"],
    ...(value.content !== undefined ? { content: value.content as string | null } : {}),
    ...(value.path !== undefined ? { path: value.path as string | null } : {}),
    ...(value.id !== undefined ? { id: value.id as number | null } : {}),
    ...(value.paths !== undefined ? { paths: value.paths as string[] | null } : {}),
    ...(value.checked !== undefined ? { checked: value.checked as number[] | null } : {}),
    ...(value.remember_checks !== undefined ? { remember_checks: value.remember_checks as boolean } : {}),
  };
}

/** The core host used by the first-party launcher. `show`/`close` are the
 * canonical command surface; the debounced follow effect is only a convenience
 * for pages whose selection drives the preview.
 *
 * External plugin calls enter through the same Rust command, so all callers
 * share one window, placement rule, setting gate and teardown path. */
export function createPreviewHost(deps: PreviewHostDeps): PreviewHost {
  const [current, setCurrent] = createSignal<PreviewReq | null>(null);
  let timer: number | undefined;
  let generation = 0;

  async function show(request: PreviewReq): Promise<void> {
    const req = validatePreviewRequest(request);
    const seq = ++generation;
    setCurrent(req);
    try {
      await invoke("show_preview", { req });
    } catch (error) {
      if (seq === generation) setCurrent(null);
      throw error;
    }
    // A newer request/close won while Rust was opening this one; do not let an
    // old acknowledgement resurrect the Esc-priority flag.
    if (seq !== generation) setCurrent(null);
  }

  async function close(): Promise<void> {
    generation++;
    setCurrent(null);
    await invoke("close_preview");
  }

  createEffect(() => {
    const req = deps.enabled() ? deps.target() : null;
    const seq = ++generation;
    setCurrent(req);
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (seq !== generation) return;
      // The automatic follow source bypasses the plugin service entirely; the
      // Rust setting/visibility gates remain authoritative.
      const command = req ? invoke("show_preview", { req }) : invoke("close_preview");
      void command.catch((err) => {
        if (seq === generation) console.error("[preview] sync failed:", err);
      });
    }, PREVIEW_DEBOUNCE_MS);
  });
  onCleanup(() => {
    generation++;
    clearTimeout(timer);
  });

  return {
    current,
    show,
    close,
    remember: () => {
      generation++;
      // The exact payload lives in the preview renderer. Esc only needs a
      // non-null marker, so avoid duplicating up to 512 KiB through an event.
      setCurrent((previous) => previous ?? { kind: "text", content: "" });
    },
    clear: () => {
      generation++;
      setCurrent(null);
    },
  };
}
