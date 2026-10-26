//! Sandboxed iframe host shared by page-runtime Presenters. The Presenter
//! bridge injects its own restricted `window.lume`; this module owns the
//! opaque-origin frame, document swapping, readiness, diagnostics and
//! host-to-frame event transport.

import { createSignal, onMount, onCleanup, type Component } from "solid-js";
import { plog } from "./log";

/** The sandbox attribute for plugin view iframes: scripts/forms/popups/modals
 * run, but the page gets an opaque origin — no access to the host document,
 * `parent.__TAURI_INTERNALS__` or launcher DOM, no top-frame navigation. */
export const PLUGIN_FRAME_SANDBOX = "allow-scripts allow-modals";

/** Build the mode View for a disk mode plugin: renders the prepared HTML in
 * an iframe and answers the bridge RPCs. Events (query/show/hide/enter) flow
 * out through the returned `post` handle.
 *
 * `onReady` fires when the plugin page's bridge script announces itself
 * (`__lumeReady`). The host must (re)deliver the current page state there:
 * `post` before that point reaches a document that has no listener yet, so
 * anything sent while the iframe was still loading would be lost.
 *
 * The same View builder serves both hosts of a plugin page — the launcher
 * window (mode page inside the results area) and a detached plugin window
 * (the page hosted on its own). Host-specific behaviour is limited to the
 * key/focus messages: the launcher re-dispatches keys into its router and
 * re-focuses the search box; a detached host ignores the focus request and
 * delivers keys itself.
 *
 * Multiple viewers can coexist in one host page (the detached window mounts
 * a second one for the plugin's titlebar page): every instance filters
 * messages by `e.source === frame.contentWindow`, so sibling iframes never
 * see each other's traffic. `opts` renames the iframe class and sets the
 * frame's `window.name` (arrives in `__lumeReady.frame`) so the host can
 * tell the ready announcements apart. */
/** How long a plugin page may stay "loading" before it is shown anyway. The
 * bridge announces ready on the document's `load`, so a stalled subresource
 * (broken page, unreachable remote asset) must not hide the launcher behind a
 * spinner forever — past this grace period the page is shown as-is. */
const READY_GRACE_MS = 3000;

/** Boot watchdog delays ( blank-window fix). A fresh frame is expected to
 * report `__lumeFrameBoot` a few ms after its navigation commits; a frame that
 * stays silent this long never got a document and is re-navigated (see
 * `createIframeView`). Runs only while the current document is unbooted, so a
 * healthy frame clears the timers on its first message. */
const BOOT_RETRY_DELAYS_MS = [700, 1500, 2800];
/** After the last re-navigation: how long to wait before reporting the frame
 * as dead (loudly — the window is blank and the user deserves a console
 * record of why). */
const BOOT_FINAL_CHECK_MS = 1600;

/** Snapshot size cap : the snapshot travels as JSON through Tauri
 * events and lives in session memory only — past this cap drop the plugin's
 * custom layer first, then give up entirely. */
const SNAPSHOT_MAX_CHARS = 1_000_000;

/** Clamp every snapshot layer before it can cross the host boundary. The
 * in-frame bridge applies the same limits first; this guard covers older or
 * hostile pages and older frame snapshots. */
const SNAPSHOT_MAX_FIELDS = 200;
const SNAPSHOT_MAX_FIELD_CHARS = 64 * 1024;
const SNAPSHOT_MAX_CUSTOM_CHARS = 512_000;

function snapshotJsonLength(value: unknown): number {
  return JSON.stringify(value).length;
}

export function capSnapshot(snap: unknown, owner?: string): unknown {
  const warn = (msg: string) => plog.warn(owner ?? null, msg);
  try {
    if (snap == null) return null;
    if (typeof snap !== "object" || Array.isArray(snap)) return null;

    const source = snap as { auto?: { fields?: unknown }; custom?: unknown };
    if (!source.auto || !("custom" in source)) {
      return snapshotJsonLength(snap) <= SNAPSHOT_MAX_CHARS ? snap : null;
    }
    const rawFields = Array.isArray(source.auto?.fields) ? source.auto.fields : [];
    const fields = rawFields.slice(0, SNAPSHOT_MAX_FIELDS).flatMap((raw) => {
      if (!raw || typeof raw !== "object") return [];
      const field = raw as { key?: unknown; value?: unknown; checked?: unknown; secret?: unknown };
      if (typeof field.key !== "string" || field.key.length > 512) return [];
      let value: string | string[];
      if (field.secret === true) {
        value = "";
      } else if (Array.isArray(field.value)) {
        let chars = 0;
        value = field.value
          .slice(0, 64)
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => entry.slice(0, SNAPSHOT_MAX_FIELD_CHARS))
          .filter((entry) => {
            chars += entry.length;
            return chars <= SNAPSHOT_MAX_FIELD_CHARS;
          });
      } else {
        value = String(field.value ?? "").slice(0, SNAPSHOT_MAX_FIELD_CHARS);
      }
      return [{ key: field.key, value, checked: Boolean(field.checked) }];
    });

    let custom = source.custom ?? null;
    if (custom != null && snapshotJsonLength(custom) > SNAPSHOT_MAX_CUSTOM_CHARS) {
      warn("snapshot custom layer exceeded 512KB — dropped");
      custom = null;
    }
    const result = { v: 2, auto: { fields }, custom };
    while (fields.length > 0 && snapshotJsonLength(result) > SNAPSHOT_MAX_CHARS) {
      fields.pop();
    }
    if (snapshotJsonLength(result) > SNAPSHOT_MAX_CHARS) {
      warn("snapshot exceeded 1MB after field/custom caps — dropped entirely");
      return null;
    }
    return result;
  } catch (err) {
    warn(`snapshot serialization failed: ${err}`);
    return null;
  }
}

export function createIframeView(
  onRpc: (method: string, args: Record<string, unknown>) => Promise<unknown>,
  onReady?: () => void,
  opts?: { class?: string; name?: string; id?: string }
): {
  View: Component & { setHtml(html: string): void };
  post: (type: string, payload?: unknown) => void;
  /** Ask the page for its state snapshot (frame snapshot v2 since
   * docs/ROADMAP_HISTORY.md #40). Resolves null when the page isn't live, doesn't answer
   * within `timeoutMs`, or errors — a dead or hostile page must never block
   * a detach/close. */
  snapshot: (timeoutMs?: number) => Promise<unknown | null>;
  /** Host-to-page call with an optional payload. Used by the Presenter bridge
   * for waitable key decisions; resolves null on timeout/error. */
  call: (type: string, payload?: unknown, timeoutMs?: number) => Promise<unknown | null>;
  /** Whether the *current* document's bridge is live (it announced
   * `__lumeReady`). False while a fresh document is still loading — reset on
   * mount, on unmount (a remount is a new document) and when `setHtml` swaps
   * the page. The mode instance exposes it as `ModeInstance.ready` (the
   * shell's loading gate). */
  live: () => boolean;
} {
  let frame: HTMLIFrameElement | undefined;
  /** The page HTML; `undefined` until `setHtml`. The frame must NOT be
   * navigated before real HTML exists: writing an EMPTY srcdoc (the old
   * `srcdoc=""` initial value) sends the frame through a navigation +
   * renderer-process swap of its own, and the real navigation that follows a
   * few ms later can be dropped outright — the frame then sits on the empty
   * document forever (the "completely blank detached plugin window", seen
   * with 2 sandboxed frames per window; the logic host's frames, which set
   * `src` before insertion — one navigation — never hit it). Binding `null`
   * to the attribute removes it instead of writing, so a frame with no HTML
   * yet simply stays on about:blank. */
  const [srcdoc, setSrcdoc] = createSignal<string | undefined>(undefined);
  const [live, setLive] = createSignal(false);
  // ── load/bookkeeping state for the current document ──
  /** Last HTML handed to `setHtml` (the re-navigation payload). */
  let currentHtml: string | undefined;
  /** The document reported `__lumeFrameBoot` — its bridge is executing. */
  let booted = false;
  let bootTimers: ReturnType<typeof setTimeout>[] = [];
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  const frameLabel = opts?.name ? `frame "${opts.name}"` : "frame";
  const clearBootTimers = () => {
    for (const t of bootTimers) window.clearTimeout(t);
    bootTimers = [];
  };
  /** Re-trigger the current document's navigation. remove-then-set, not a
   * plain value write: the attribute has to be seen as *changed* for the
   * frame to process it again (verified recovery for a dropped navigation). */
  const reNavigate = (attempt: number) => {
    if (!frame || !currentHtml) return;
    plog.warn(
      opts?.id ?? null,
      `${frameLabel} never booted — re-navigating (attempt ${attempt}/${BOOT_RETRY_DELAYS_MS.length})`
    );
    frame.removeAttribute("srcdoc");
    frame.setAttribute("srcdoc", currentHtml);
    armGrace(); // a fresh load restarts the ready grace
  };
  /** Start (or restart) the boot watchdog for the current document. Only
   * bridge-instrumented pages are watched — a host-authored error page (a
   * failed view fetch renders a bare notice) has no bridge and would just be
   * reloaded in a loop. A frame that is not mounted yet has nothing to retry
   * either: the launcher fetches a mode page's HTML while the mode may not be
   * on screen, and the mount-time `ref` re-arms the watchdog for it. */
  const armBootWatchdog = () => {
    clearBootTimers();
    booted = false;
    if (!currentHtml?.includes("__lumeFrameBoot")) return;
    const liveFrame = () => !!frame && frame.isConnected;
    BOOT_RETRY_DELAYS_MS.forEach((delay, i) => {
      bootTimers.push(
        window.setTimeout(() => {
          if (!booted && liveFrame()) reNavigate(i + 1);
        }, delay)
      );
    });
    bootTimers.push(
      window.setTimeout(() => {
        if (!booted && liveFrame()) {
          plog.error(
            opts?.id ?? null,
            `${frameLabel} still blank after ${BOOT_RETRY_DELAYS_MS.length} re-navigations — giving up`
          );
        }
      }, BOOT_RETRY_DELAYS_MS[BOOT_RETRY_DELAYS_MS.length - 1] + BOOT_FINAL_CHECK_MS)
    );
  };
  const armGrace = () => {
    window.clearTimeout(graceTimer);
    graceTimer = window.setTimeout(() => setLive(true), READY_GRACE_MS);
  };
  const post = (type: string, payload?: unknown) => {
    frame?.contentWindow?.postMessage({ __lumeEvent: { type, payload } }, "*");
  };
  /** JSON round-trip: drop values that cannot be structured-cloned (the
   * `text()`/`json()` helpers on an `http.request` reply). The data survives;
   * the page's bridge re-attaches the helpers on its side (§6D.1). Mirrors
   * `jsonSafe` in src/pluginLogic.tsx — the view bridge lacked this step, so a
   * **successful** http.request was downgraded to a DataCloneError failure. */
  const jsonSafe = (v: unknown): unknown => {
    try {
      return JSON.parse(JSON.stringify(v ?? null));
    } catch {
      return null;
    }
  };
  /** Answer a page RPC, staying structured-cloneable: post directly (the
   * common case) and, if the clone is refused, strip the non-clonable parts
   * and re-send — never turn a usable result into a fake failure. */
  const replyRpc = (id: number, ok: boolean, result: unknown, error?: string) => {
    const msg = { __lumeRpcResult: { id, ok, result: ok ? result : null, error } };
    try {
      frame?.contentWindow?.postMessage(msg, "*");
      return;
    } catch {
      // DataCloneError (or a dead frame window) — retry with the stripped result.
    }
    msg.__lumeRpcResult.result = jsonSafe(result);
    try {
      frame?.contentWindow?.postMessage(msg, "*");
    } catch (err2) {
      plog.error(opts?.id ?? null, `${frameLabel} rpc reply not cloneable: ${err2}`);
      frame?.contentWindow?.postMessage(
        { __lumeRpcResult: { id, ok: false, result: null, error: String(err2) } },
        "*"
      );
    }
  };
  // Host→page calls (`__lumeCall`) awaiting their `__lumeCallResult` receipt.
  const pendingCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let callSeq = 0;
  const call = (type: string, payload?: unknown, timeoutMs = 1500): Promise<unknown | null> => {
    if (!live() || !frame?.contentWindow) return Promise.resolve(null);
    const callId = ++callSeq;
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        pendingCalls.delete(callId);
        resolve(null);
      }, timeoutMs);
      pendingCalls.set(callId, {
        resolve: (v) => {
          window.clearTimeout(timer);
          resolve(capSnapshot(v, opts?.id));
        },
        reject: () => {
          window.clearTimeout(timer);
          resolve(null);
        },
      });
      frame?.contentWindow?.postMessage({ __lumeCall: { callId, type, payload } }, "*");
    });
  };
  const snapshot = (timeoutMs = 1500): Promise<unknown | null> =>
    call("snapshot", undefined, timeoutMs).then((value) => capSnapshot(value, opts?.id));
  const View: Component & { setHtml(html: string): void } = () => {
    onMount(() => {
      setLive(false); // a fresh document starts loading
      armGrace();
      const handler = (e: MessageEvent) => {
        if (e.source !== frame?.contentWindow) return;
        const d = (e.data || {}) as {
          __lumeRpc?: { id: number; method: string; args: Record<string, unknown> };
          __lumeReady?: unknown;
          __lumeFrameBoot?: { frame?: string };
          __lumeCallResult?: { callId: number; ok: boolean; result?: unknown; error?: string };
          __lumeFrameState?: unknown;
          __lumeKey?: {
            seq: number;
            key: string;
            code: string;
            ctrlKey: boolean;
            shiftKey: boolean;
            altKey: boolean;
            metaKey: boolean;
          };
          __lumeFocusRequest?: unknown;
        };
        if (d.__lumeFrameBoot) {
          // The document committed and its bridge script is running: the
          // navigation was not dropped, so the load watchdog stands down
          // (the page itself may take a while longer — that is fine).
          booted = true;
          clearBootTimers();
        }
        if (d.__lumeReady) {
          // The page's bridge is live — safe to (re)send state now.
          window.clearTimeout(graceTimer);
          setLive(true);
          try {
            onReady?.();
          } catch (err) {
            console.error("[plugins] onReady failed:", err);
          }
        }
        if (d.__lumeCallResult) {
          const c = pendingCalls.get(d.__lumeCallResult.callId);
          if (c) {
            pendingCalls.delete(d.__lumeCallResult.callId);
            d.__lumeCallResult.ok
              ? c.resolve(d.__lumeCallResult.result ?? null)
              : c.resolve(null);
          }
        }
        if (d.__lumeFrameState) {
          // 帧内状态上报（桥的 reportState）：收口到本窗口的 __frameStates
          // 环形缓冲。srcdoc 帧的 CDP context 在新 WebView2 里对宿主 target 不
          // 可见，外部工具（probe）改从这读取；生产路径无人消费，成本 ~KB/s。
          const states = ((window as unknown as { __frameStates?: unknown[] }).__frameStates ??= []);
          states.push(d.__lumeFrameState);
          if (states.length > 40) states.shift();
        }
        if (d.__lumeRpc) {
          const { id, method, args } = d.__lumeRpc;
          onRpc(method, args)
            .then((result) => replyRpc(id, true, result))
            .catch((err) => replyRpc(id, false, null, String(err)));
        }
        if (d.__lumeKey) {
          // Re-dispatch through the host's window so the existing key router
          // applies unchanged (Esc layering, mode switch, grid arrows; the
          // active mode's onKey delivers lume.on.key from there). Esc uses a
          // separate waitable page call; ordinary consumed keys simply stop at
          // the host router.
          const k = d.__lumeKey;
          const syn = new KeyboardEvent("keydown", {
            key: k.key,
            code: k.code,
            ctrlKey: k.ctrlKey,
            shiftKey: k.shiftKey,
            altKey: k.altKey,
            metaKey: k.metaKey,
            bubbles: true,
          });
          window.dispatchEvent(syn);
        }
        if (d.__lumeFocusRequest) {
          // Typing hand-off (launcher only — a detached window has no search
          // input and this resolves to nothing).
          document.getElementById("search-input")?.focus();
        }
      };
      window.addEventListener("message", handler);
      onCleanup(() => {
        window.removeEventListener("message", handler);
        window.clearTimeout(graceTimer);
        clearBootTimers();
        setLive(false); // unmount = the document is gone
      });
    });
    return (
      <iframe
        class={opts?.class ?? "plugin-frame"}
        name={opts?.name}
        srcdoc={srcdoc()}
        title="plugin"
        sandbox={PLUGIN_FRAME_SANDBOX}
        ref={(el) => {
          frame = el;
          // The launcher's mode page can mount *after* setHtml was called
          // (the page HTML is fetched while the mode is not on screen): the
          // frame's first navigation starts here, so the watchdog for the
          // pending HTML starts here too.
          if (el && currentHtml) armBootWatchdog();
        }}
      />
    );
  };
  View.setHtml = (html: string) => {
    // Same HTML into a live document: the old code's signal write was a no-op
    // (equal value), and re-navigating here would needlessly reload the page.
    if (html === currentHtml && booted) return;
    setLive(false); // the swapped-in document must announce itself again
    currentHtml = html;
    armBootWatchdog();
    setSrcdoc(html);
  };
  return { View, post, snapshot, call, live };
}
