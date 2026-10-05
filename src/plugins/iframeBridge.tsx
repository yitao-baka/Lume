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
import { plog } from "./log";

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
  // 透明传递：**不吞错**（与逻辑帧 pluginLogicFrame.js 的 call 一致）。曾经
  // catch 后无 return 把失败静默成 undefined —— 权限拒绝/超时等错误不可感知，
  // 与 P3.2「fail loud」相悖。
  var call = function (method, args) {
    return rpc(method, args).catch(function (err) {
      console.error("[lume bridge]", method, err);
      throw err;
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
    on: {}, // the page assigns: lume.on.query / .show / .hide / .key / .enter / .subInput / .settings / .theme = function(payload)
    // 状态快照（P6.5，可选实现）：lume.on.snapshot = () => state — 宿主在
    // detach/关闭前向页面要一份状态（与桥自动捕获的表单/滚动合并后跨窗口
    // 传递）；lume.on.restore = (state) => {} — 宿主把快照的 custom 层交给
    // 页面（auto 层由桥自动回放）。快照仅内存流转，不落盘。
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
    if (d.__lumeCall) {
      // 宿主 → 页面的带响应调用（P6.5）：今天只有 "snapshot"（状态快照）。
      // 结果必须回执，宿主侧有超时兜底，但回执让它能提前收口。
      var c = d.__lumeCall;
      Promise.resolve()
        .then(function () {
          if (c.type === "snapshot") return captureSnapshot();
          return undefined;
        })
        .then(function (result) {
          parent.postMessage({ __lumeCallResult: { callId: c.callId, ok: true, result: result } }, "*");
        })
        .catch(function (err) {
          parent.postMessage({ __lumeCallResult: { callId: c.callId, ok: false, error: String(err) } }, "*");
        });
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
      if (ev.type === "restore") {
        applySnapshot(ev.payload);
        return;
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
  // ── 状态快照（P6.5）──
  // detach / 关闭独立窗口前，宿主通过 __lumeCall{type:"snapshot"} 向页面要
  // 一份状态。桥自动捕获两层：表单控件值（input/textarea/select，按 DOM 顺序
  // 成组，恢复时按同一顺序回放）与 document 滚动位置。页面可选实现
  // lume.on.snapshot 提供 custom 层（任意可 JSON 化对象）；恢复时 auto 层由
  // 桥自动回放，custom 层交给 lume.on.restore。快照仅内存流转，不落盘。
  function captureSnapshot() {
    var nodes = document.querySelectorAll("input, textarea, select");
    var fields = [];
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.type === "file") continue; // FileList 不可序列化
      fields.push({ v: el.value == null ? "" : String(el.value), c: !!el.checked });
    }
    var snap = {
      auto: {
        fields: fields,
        scroll: { x: window.scrollX || 0, y: window.scrollY || 0 },
      },
    };
    var h = window.lume.on.snapshot;
    if (typeof h !== "function") return snap;
    return Promise.resolve()
      .then(h)
      .then(function (custom) {
        if (custom !== undefined && custom !== null) snap.custom = custom;
        return snap;
      });
  }
  function applySnapshot(snap) {
    if (!snap || typeof snap !== "object") return;
    var auto = snap.auto || {};
    try {
      var nodes = document.querySelectorAll("input, textarea, select");
      var fields = auto.fields || [];
      for (var i = 0, j = 0; i < nodes.length && j < fields.length; i++) {
        var el = nodes[i];
        if (el.type === "file") continue;
        var f = fields[j++];
        if (f && f.v != null) {
          el.value = f.v;
          try { el.dispatchEvent(new Event("input", { bubbles: true })); } catch (err) {}
        }
        if (f && "c" in f) el.checked = !!f.c;
      }
    } catch (err) {}
    try {
      window.scrollTo((auto.scroll && auto.scroll.x) || 0, (auto.scroll && auto.scroll.y) || 0);
    } catch (err) {}
    if (snap.custom !== undefined && typeof window.lume.on.restore === "function") {
      try { window.lume.on.restore(snap.custom); } catch (err) {}
    }
    reportState("restored");
  }
  // ── 状态上报（诊断用）──
  // srcdoc 帧的 CDP execution context 在较新的 WebView2 里不再暴露给宿主
  // target，外部工具（CDP probe）无法直接读帧内 DOM。桥把关键控件值随
  // postMessage 报给宿主，宿主收口到 window.__frameStates（有上限、仅内存）——
  // 大步骤（就绪/恢复）即时报，另有 1s 心跳供工具轮询。
  function reportState(reason) {
    try {
      var values = [];
      var nodes = document.querySelectorAll("input, textarea, select");
      for (var i = 0; i < nodes.length && values.length < 24; i++) {
        var el = nodes[i];
        if (el.type === "file") continue;
        values.push({
          id: el.id || "",
          name: el.name || "",
          value: el.value == null ? "" : String(el.value),
        });
      }
      parent.postMessage(
        {
          __lumeFrameState: {
            name: window.name || "",
            reason: reason,
            ready: document.readyState,
            values: values,
          },
        },
        "*"
      );
    } catch (err) {}
  }
  window.setInterval(function () { reportState("tick"); }, 1000);
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
    reportState("ready");
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

/** Snapshot size cap (P6.5): the snapshot travels as JSON through Tauri
 * events and lives in session memory only — past this cap drop the plugin's
 * custom layer first, then give up entirely. */
const SNAPSHOT_MAX_CHARS = 1_000_000;

export function capSnapshot(snap: unknown, owner?: string): unknown {
  // 降级必须可感知（否则表现为"状态继承时灵时不灵"）——devtools 里能查到原因。
  const warn = (msg: string) => plog.warn(owner ?? null, msg);
  try {
    if (snap == null) return null;
    if (JSON.stringify(snap).length <= SNAPSHOT_MAX_CHARS) return snap;
    if (typeof snap !== "object") {
      warn("snapshot >1MB — dropped entirely");
      return null;
    }
    const { custom: _drop, ...rest } = snap as { custom?: unknown };
    if (JSON.stringify(rest).length <= SNAPSHOT_MAX_CHARS) {
      warn("snapshot >1MB — custom layer dropped, auto fields kept");
      return rest;
    }
    warn("snapshot >1MB — dropped entirely");
    return null;
  } catch (err) {
    warn(`snapshot serialization failed: ${err}`);
    return null;
  }
}

export function createIframeView(
  onRpc: (method: string, args: Record<string, unknown>) => Promise<unknown>,
  onReady?: () => void,
  opts?: { class?: string; name?: string }
): {
  View: Component & { setHtml(html: string): void };
  post: (type: string, payload?: unknown) => void;
  /** Ask the page for its state snapshot (P6.5). Resolves null when the page
   * isn't live, doesn't answer within `timeoutMs`, or errors — a dead or
   * hostile page must never block a detach/close. */
  snapshot: (timeoutMs?: number) => Promise<unknown | null>;
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
  // Host→page calls (`__lumeCall`) awaiting their `__lumeCallResult` receipt.
  const pendingCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let callSeq = 0;
  const snapshot = (timeoutMs = 1500): Promise<unknown | null> => {
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
          resolve(v);
        },
        reject: () => {
          window.clearTimeout(timer);
          resolve(null);
        },
      });
      frame?.contentWindow?.postMessage({ __lumeCall: { callId, type: "snapshot" } }, "*");
    });
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
  return { View, post, snapshot, live };
}
