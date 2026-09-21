//! Disk mode plugin UI: the plugin's `view` HTML renders inside an iframe
//! (srcdoc, same-origin — the trust model is "explicit placement = trusted")
//! with an injected bridge client. The page talks to the host through
//! `window.lume` (promise-based RPC) and receives events by assigning
//! `window.lume.on.query / .show / .hide / .key`.

import { createSignal, onCleanup, onMount, type Component } from "solid-js";

/** The bridge client injected into every plugin view page. Kept as a string
 * so it can be textually injected — it runs inside the plugin iframe. */
export const BRIDGE_SCRIPT = `
(function () {
  var pending = new Map();
  var rpcId = 0;
  function rpc(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++rpcId;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __lumeRpc: { id: id, method: method, args: args } }, "*");
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("lume bridge timeout: " + method));
        }
      }, 10000);
    });
  }
  var call = function (method, args) {
    return rpc(method, args).catch(function (err) {
      console.error("[lume bridge]", method, err);
    });
  };
  window.lume = {
    app: {
      hide: function () { return call("app.hide"); },
      toast: function (text, opts) { return call("app.toast", { text: text, opts: opts }); },
      setQuery: function (q) { return call("app.setQuery", { q: q }); },
      setPlaceholder: function (t) { return call("app.setPlaceholder", { text: t }); },
      openPath: function (p) { return call("app.openPath", { path: p }); },
      revealPath: function (p) { return call("app.revealPath", { path: p }); },
      trash: function (paths) { return call("app.trash", { paths: paths }); },
      resize: function (size) {
        return call("app.resize", { width: size && size.width, height: size && size.height });
      },
    },
    fs: {
      readText: function (p) { return call("fs.readText", { path: p }); },
      thumb: function (p) { return call("fs.thumb", { path: p }); },
      videoPoster: function (p) { return call("fs.videoPoster", { path: p }); },
      icon: function (paths) { return call("fs.icon", { paths: paths }); },
    },
    clipboard: {
      readText: function () { return call("clipboard.readText"); },
      writeText: function (t) { return call("clipboard.writeText", { text: t }); },
    },
    storage: {
      get: function (k) { return call("storage.get", { key: k }); },
      set: function (k, v) { return call("storage.set", { key: k, value: v }); },
      remove: function (k) { return call("storage.remove", { key: k }); },
    },
    search: {
      // opts: legacy number = max, or { offset, max, sort }
      files: function (q, opts) { return call("search.files", { q: q, opts: opts }); },
    },
    on: {}, // the page assigns: lume.on.query / .show / .hide / .key = function(payload)
  };
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.__lumeRpcResult) {
      var r = d.__lumeRpcResult;
      var pend = pending.get(r.id);
      if (pend) {
        pending.delete(r.id);
        r.ok ? pend.resolve(r.result) : pend.reject(new Error(r.error));
      }
    }
    if (d.__lumeEvent) {
      var ev = d.__lumeEvent;
      var h = window.lume.on[ev.type];
      if (typeof h === "function") h(ev.payload);
    }
  });
  parent.postMessage({ __lumeReady: { frame: window.name } }, "*");
})();
`;

/** Inject the bridge + a blank-target base into a plugin view page. */
export function injectBridge(html: string): string {
  const injection = `<base target="_blank"><script>${BRIDGE_SCRIPT}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + injection);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + injection);
  return injection + html;
}

/** Forward keydowns from the plugin iframe to the host window router.
 *
 * Focus entering the iframe (any click on the plugin page) makes keydown fire
 * in the iframe's document only — the host window listener never sees it. This
 * re-dispatches the event on the host window so the existing key routing
 * (`keyboard.ts` `onKeyDown` / `blockBrowserKeys`) applies unchanged:
 *
 * - Bubble phase, not capture: the plugin page's own document listeners
 *   register earlier and run first, so a plugin can consume keys (Esc in
 *   file-search's filter dialog) via `preventDefault` — consumed events are
 *   not forwarded.
 * - Editable targets (input/textarea/contenteditable) are skipped: the
 *   plugin's dialogs own their typing (Ctrl+A/C/V, arrows, Enter).
 * - When the host router consumes the re-dispatch (Esc / mode-switch /
 *   arrows), `preventDefault` is re-applied on the original event so iframe
 *   defaults (Tab focus roaming, …) stay blocked too.
 */
function attachKeyForwarding(frame: HTMLIFrameElement) {
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const editable = t?.closest?.("input, textarea, [contenteditable]");
    if (e.defaultPrevented || editable) return;
    const syn = new KeyboardEvent("keydown", {
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
      bubbles: true,
    });
    window.dispatchEvent(syn);
    if (syn.defaultPrevented) e.preventDefault();
  });
  // Typing hand-off: a click anywhere non-editable in the plugin page parks
  // focus inside the iframe, so host-side typing silently drops. Bounce focus
  // back to the search box after the click settles — every plugin benefits,
  // not just the ones that implement the hand-off themselves.
  doc.addEventListener(
    "mousedown",
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable]")) return;
      setTimeout(() => document.getElementById("search-input")?.focus(), 0);
    },
    true
  );
}

/** Build the mode View for a disk mode plugin: renders the prepared HTML in
 * an iframe and answers the bridge RPCs. Events (query/show/hide) flow out
 * through the returned `post` handle. */
export function createIframeView(
  onRpc: (method: string, args: Record<string, unknown>) => Promise<unknown>,
): { View: Component & { setHtml(html: string): void }; post: (type: string, payload?: unknown) => void } {
  let frame: HTMLIFrameElement | undefined;
  const [srcdoc, setSrcdoc] = createSignal("");
  const post = (type: string, payload?: unknown) => {
    frame?.contentWindow?.postMessage({ __lumeEvent: { type, payload } }, "*");
  };
  const View: Component & { setHtml(html: string): void } = () => {
    onMount(() => {
      const handler = (e: MessageEvent) => {
        if (e.source !== frame?.contentWindow) return;
        const d = (e.data || {}) as {
          __lumeRpc?: { id: number; method: string; args: Record<string, unknown> };
        };
        if (d.__lumeRpc) {
          const { id, method, args } = d.__lumeRpc;
          onRpc(method, args)
            .then((result) =>
              frame?.contentWindow?.postMessage(
                { __lumeRpcResult: { id, ok: true, result } },
                "*"
              )
            )
            .catch((err) =>
              frame?.contentWindow?.postMessage(
                { __lumeRpcResult: { id, ok: false, error: String(err) } },
                "*"
              )
            );
        }
        // __lumeReady needs no reply — the loader already fired onShow.
      };
      window.addEventListener("message", handler);
      onCleanup(() => window.removeEventListener("message", handler));
    });
    return (
      <iframe
        class="plugin-frame"
        srcdoc={srcdoc()}
        title="plugin"
        ref={(el) => (frame = el)}
        // srcdoc is set asynchronously — the document swaps between
        // about:blank and the injected page, so key forwarding can only be
        // attached after the load event lands on the final document.
        onLoad={() => attachKeyForwarding(frame!)}
      />
    );
  };
  View.setHtml = (html: string) => setSrcdoc(html);
  return { View, post };
}
