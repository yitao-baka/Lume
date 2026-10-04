//! Disk mode plugin UI: the plugin's `view` HTML renders inside an iframe
//! (srcdoc, **opaque origin** — the sandbox attribute grants scripts/forms/
//! popups/modals but not same-origin) with an injected bridge client. The
//! page talks to the host through `window.lume` (promise-based RPC) and
//! receives events by assigning `window.lume.on.query / .show / .hide / .key`.
//!
//! Opaque origin means the host can no longer reach into the plugin document
//! (`frame.contentDocument` is off-limits), so the key/focus forwarding that
//! used to be wired from the parent now runs **inside the bridge script** and
//! travels over the same postMessage channel as the RPC traffic.

import { createSignal, onMount, onCleanup, type Component } from "solid-js";
import { currentThemeMode, PANEL_SURFACE_BG } from "../theme";

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
  // The store's bookkeeping fields are not part of a document's body: the
  // host adds them back on every read (uTools-shaped docs, plain JSON rows in
  // SQLite).
  var stripMeta = function (doc) {
    var out = {};
    for (var k in doc) {
      if (k !== "_id" && k !== "_rev" && Object.prototype.hasOwnProperty.call(doc, k)) out[k] = doc[k];
    }
    return out;
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
      dragWindow: function () { return call("app.dragWindow"); },
      notify: function (title, body) { return call("app.notify", { title: title, body: body }); },
      setSubInput: function (opts) { return call("app.setSubInput", { opts: opts }); },
      removeSubInput: function () { return call("app.removeSubInput"); },
      redirect: function (pluginId, opts) {
        return call("app.redirect", {
          pluginId: pluginId,
          code: opts && opts.code,
          payload: opts && opts.payload,
        });
      },
      foreground: function () { return call("app.foreground"); },
    },
    fs: {
      readText: function (p) { return call("fs.readText", { path: p }); },
      bytes: function (p) { return call("fs.bytes", { path: p }); },
      thumb: function (p) { return call("fs.thumb", { path: p }); },
      videoPoster: function (p) { return call("fs.videoPoster", { path: p }); },
      icon: function (paths) { return call("fs.icon", { paths: paths }); },
      writeText: function (name, text) { return call("fs.writeText", { name: name, text: text }); },
      writeBytes: function (name, data) { return call("fs.writeBytes", { name: name, data: data }); },
      readPrivate: function (name) { return call("fs.readPrivate", { name: name }); },
      listPrivate: function () { return call("fs.listPrivate"); },
      privatePath: function (name) { return call("fs.privatePath", { name: name }); },
      removePrivate: function (name) { return call("fs.removePrivate", { name: name }); },
      writeFile: function (p, text) { return call("fs.writeFile", { path: p, text: text }); },
    },
    clipboard: {
      readText: function () { return call("clipboard.readText"); },
      writeText: function (t) { return call("clipboard.writeText", { text: t }); },
      writeImage: function (data) { return call("clipboard.writeImage", { data: data }); },
      writeFiles: function (paths) { return call("clipboard.writeFiles", { paths: paths }); },
      readFiles: function () { return call("clipboard.readFiles"); },
      readImage: function () { return call("clipboard.readImage"); },
      paste: function (payload) {
        return call("clipboard.paste", {
          text: payload && payload.text,
          image: payload && payload.image,
          files: payload && payload.files,
        });
      },
    },
    http: {
      request: function (req) {
        return call("http.request", { req: req }).then(function (res) {
          if (!res) return res;
          // Decode the base64 body here: page code stays free of atob/TextDecoder.
          var dec = function () {
            var bin = atob(res.body || "");
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return new TextDecoder().decode(bytes);
          };
          res.text = dec;
          res.json = function () { return JSON.parse(dec()); };
          return res;
        });
      },
    },
    dialog: {
      open: function (opts) { return call("dialog.open", { opts: opts }); },
      save: function (opts) { return call("dialog.save", { opts: opts }); },
    },
    screen: {
      cursor: function () { return call("screen.cursor"); },
      displays: function () { return call("screen.displays"); },
    },
    storage: {
      get: function (k) { return call("storage.get", { key: k }); },
      set: function (k, v) { return call("storage.set", { key: k, value: v }); },
      remove: function (k) { return call("storage.remove", { key: k }); },
    },
    db: {
      get: function (id) { return call("db.get", { docId: id }); },
      put: function (doc) {
        var d = doc || {};
        return call("db.put", { docId: d._id, rev: d._rev, json: JSON.stringify(stripMeta(d)) });
      },
      remove: function (docOrId, rev) {
        if (docOrId && typeof docOrId === "object") {
          return call("db.remove", { docId: docOrId._id, rev: docOrId._rev });
        }
        return call("db.remove", { docId: docOrId, rev: rev });
      },
      allDocs: function (opts) { return call("db.allDocs", { opts: opts }); },
      bulkDocs: function (docs) {
        var payload = (docs || []).map(function (d) {
          return { docId: d && d._id, rev: d && d._rev, json: JSON.stringify(stripMeta(d || {})) };
        });
        return call("db.bulkDocs", { docs: payload });
      },
    },
    settings: {
      all: function () { return call("settings.all"); },
      get: function (k) { return call("settings.get", { key: k }); },
    },
    search: {
      // opts: legacy number = max, or { offset, max, sort, exts, folder }
      files: function (q, opts) { return call("search.files", { q: q, opts: opts }); },
    },
    on: {}, // the page assigns: lume.on.query / .show / .hide / .key / .enter / .subInput / .settings = function(payload)
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
      // 宿主拼接面：插件页画布默认取主题的实体面板色（--surface），随主题事件
      // 实时跟随。插件自己的 html/body 背景规则文档更靠后，写了自己的底色就
      // 覆盖本默认（契约见 PLUGIN_API.md §6B.2）。
      if (ev.type === "theme") {
        document.documentElement.style.setProperty(
          "--lume-page-bg",
          ev.payload === "light" ? "${PANEL_SURFACE_BG.light}" : "${PANEL_SURFACE_BG.dark}"
        );
      }
      var h = window.lume.on[ev.type];
      if (typeof h === "function") h(ev.payload);
    }
    if (d.__lumeKeyConsumed) {
      // Late consumption: the host router decided this forwarded key belongs
      // to it (Esc / mode switch / grid arrows). preventDefault on the
      // original event — for focus-moving keys the iframe default may already
      // have run (best-effort; documented in PLUGIN_API.md §6C).
      var kb = pendingKeys.get(d.__lumeKeyConsumed);
      pendingKeys.delete(d.__lumeKeyConsumed);
      if (kb && d.__lumeKeyConsumed.consumed) {
        try { kb.preventDefault(); } catch (err) {}
      }
    }
  });
  // ── key forwarding (sandbox-safe) ──
  // The host cannot reach into this document (opaque origin), so forwarding
  // runs from inside: non-editable, not-yet-prevented keydowns bubble here
  // and go to the host, which re-dispatches them through its own router.
  // Page listeners on inner elements run first in the bubble path — a page
  // that preventDefaults a key (its Esc dialogs) keeps it, unchanged from the
  // same-origin days. Every forwarded key gets a receipt so the pending map
  // cannot grow without bound.
  var keySeq = 0;
  var pendingKeys = new Map();
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest("input, textarea, [contenteditable]")) return;
    if (e.defaultPrevented) return;
    var seq = ++keySeq;
    pendingKeys.set(seq, e);
    parent.postMessage({
      __lumeKey: {
        seq: seq,
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      },
    }, "*");
  });
  // Typing hand-off: a click anywhere non-editable in the plugin page parks
  // focus inside the iframe, so host-side typing silently drops. Ask the host
  // to re-focus its search box after the click settles — every plugin
  // benefits, not just the ones that implement the hand-off themselves.
  // Selectable text (user-select: text) is skipped: clicking a preview's path
  // to copy it must not yank focus to the search input.
  document.addEventListener(
    "mousedown",
    function (e) {
      var t = e.target;
      if (t && t.closest && t.closest("input, textarea, [contenteditable]")) return;
      if (t && getComputedStyle(t).userSelect === "text") return;
      parent.postMessage({ __lumeFocusRequest: true }, "*");
    },
    true
  );
  // Announce readiness on the window's load event, NOT immediately: this
  // script sits in <head>, so an immediate post would reach the host before
  // the page's own scripts assigned lume.on.* handlers — the host's state
  // push (query/show/enter) would then be delivered into a page that has no
  // handler yet and silently dropped. After load, classic and module scripts
  // have all run.
  var announced = false;
  function announce() {
    if (announced) return;
    announced = true;
    parent.postMessage({ __lumeReady: { frame: window.name } }, "*");
  }
  if (document.readyState === "complete") announce();
  else window.addEventListener("load", announce);
})();
`;

/** Inject the bridge + a blank-target base + the page-canvas default into a
 * plugin view page.
 *
 * The canvas style is the host's splice surface: a plugin page sits directly
 * under the launcher's search row / the detached window's titlebar, so it must
 * not fall back to the browser's own canvas. A dark `color-scheme` — every
 * mirrored-palette plugin sets one — makes Chromium paint an **opaque #121212**
 * canvas for a transparent root background (#121212-vs-panel is a glaring tone
 * gap at the splice, and host element backgrounds are invisible under such a
 * frame). Giving `html` the theme's solid panel color fixes that — the same
 * `--surface` the launcher panel paints, so the page is literally the panel at
 * the splice; the bridge keeps it in step with `lume.on.theme` (theme flips),
 * and a plugin that paints its own `html`/`body` background still wins (its
 * rule comes later in the document). */
export function injectBridge(html: string): string {
  const injection =
    `<base target="_blank">` +
    `<style>html{background:var(--lume-page-bg,${PANEL_SURFACE_BG[currentThemeMode()]})}</style>` +
    `<script>${BRIDGE_SCRIPT}</script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + injection);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + injection);
  return injection + html;
}

/** The sandbox attribute for plugin view iframes: scripts/forms/popups/modals
 * run, but the page gets an opaque origin — no access to the host document,
 * `parent.__TAURI_INTERNALS__` or launcher DOM, no top-frame navigation. */
export const PLUGIN_FRAME_SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";

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

export function createIframeView(
  onRpc: (method: string, args: Record<string, unknown>) => Promise<unknown>,
  onReady?: () => void,
  opts?: { class?: string; name?: string }
): {
  View: Component & { setHtml(html: string): void };
  post: (type: string, payload?: unknown) => void;
  /** Whether the *current* document's bridge is live (it announced
   * `__lumeReady`). False while a fresh document is still loading — reset on
   * mount, on unmount (a remount is a new document) and when `setHtml` swaps
   * the page. The mode instance exposes it as `ModeInstance.ready` (the
   * shell's loading gate). */
  live: () => boolean;
} {
  let frame: HTMLIFrameElement | undefined;
  const [srcdoc, setSrcdoc] = createSignal("");
  const [live, setLive] = createSignal(false);
  const post = (type: string, payload?: unknown) => {
    frame?.contentWindow?.postMessage({ __lumeEvent: { type, payload } }, "*");
  };
  const View: Component & { setHtml(html: string): void } = () => {
    onMount(() => {
      setLive(false); // a fresh document starts loading
      const grace = window.setTimeout(() => setLive(true), READY_GRACE_MS);
      const handler = (e: MessageEvent) => {
        if (e.source !== frame?.contentWindow) return;
        const d = (e.data || {}) as {
          __lumeRpc?: { id: number; method: string; args: Record<string, unknown> };
          __lumeReady?: unknown;
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
        if (d.__lumeReady) {
          // The page's bridge is live — safe to (re)send state now.
          window.clearTimeout(grace);
          setLive(true);
          try {
            onReady?.();
          } catch (err) {
            console.error("[plugins] onReady failed:", err);
          }
        }
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
        if (d.__lumeKey) {
          // Re-dispatch through the host's window so the existing key router
          // applies unchanged (Esc layering, mode switch, grid arrows; the
          // active mode's onKey delivers lume.on.key from there). Every key
          // gets a receipt — consumed ones preventDefault late in the iframe.
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
          frame?.contentWindow?.postMessage(
            { __lumeKeyConsumed: { seq: k.seq, consumed: syn.defaultPrevented } },
            "*"
          );
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
        window.clearTimeout(grace);
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
        ref={(el) => (frame = el)}
      />
    );
  };
  View.setHtml = (html: string) => {
    setLive(false); // the swapped-in document must announce itself again
    setSrcdoc(html);
  };
  return { View, post, live };
}
