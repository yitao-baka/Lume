//! Restricted Presenter bridge. Model reads/intents and shell-safe actions are
//! the only RPCs this iframe can reach; there is no http/storage/db/fs/
//! clipboard/dialog/screen/search/secrets or arbitrary Tauri command surface.

import { currentThemeMode } from "../theme";
import { currentSkin } from "../skins/runtime";
import { currentAccent, normalizeAccent } from "../skins/accent";
import { normalizeSkin, skinSurface } from "../skins/registry";
import { createIframeView } from "../plugins/iframeBridge";
import type { PageModel, PresenterDescriptor } from "./contracts";
import { normalizeLayoutReport, normalizeResizeRequest } from "./layout";
import type { PageSession } from "./session";

const PRESENTER_BRIDGE_SCRIPT = `(function () {
  try { parent.postMessage({ __lumeFrameBoot: { frame: window.name } }, "*"); } catch (err) {}
  var pending = new Map();
  var seq = 0;
  function rpc(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      parent.postMessage({ __lumeRpc: { id: id, method: method, args: args } }, "*");
      setTimeout(function () {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error("lume presenter bridge timeout: " + method));
        }
      }, 10000);
    });
  }
  var handlers = {};
  var pendingEvents = {};
  var on = new Proxy(handlers, {
    set: function (target, key, value) {
      target[key] = value;
      var queued = pendingEvents[key];
      if (typeof value === "function" && queued) {
        delete pendingEvents[key];
        for (var i = 0; i < queued.length; i++) value(queued[i]);
      }
      return true;
    }
  });
  var HOST_FORM = window.__LUME_HOST_FORM__ === "window" ? "window" : "launcher";
  var reportTimer = 0;
  var SNAPSHOT_MAX_CHARS = 1000000;
  var SNAPSHOT_MAX_FIELDS = 200;
  var SNAPSHOT_MAX_FIELD_CHARS = 65536;
  var SNAPSHOT_MAX_CUSTOM_CHARS = 512000;
  function domPath(el) {
    var parts = [];
    var node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var parent = node.parentElement;
      if (!parent) break;
      var tag = node.tagName.toLowerCase();
      var index = 1;
      for (var sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (sibling.tagName === node.tagName) index++;
      }
      parts.unshift(tag + ":nth-of-type(" + index + ")");
      node = parent;
    }
    return parts.join(">");
  }
  function fieldKey(el) {
    if (el.id) return "id:" + el.id;
    if (el.name) {
      var named = Array.from(document.querySelectorAll("[name]")).filter(function (node) {
        return node.getAttribute("name") === el.name;
      });
      return "name:" + el.name + "\\u001f" + named.indexOf(el);
    }
    return "path:" + domPath(el);
  }
  function fieldValue(el) {
    if (el.multiple) return Array.from(el.options).filter(function (o) { return o.selected; }).map(function (o) { return o.value; });
    if (el.type === "checkbox" || el.type === "radio") return el.checked ? "on" : "";
    if (el.isContentEditable) return el.innerText || "";
    return el.value == null ? "" : String(el.value);
  }
  function captureState(reason) {
    var values = Array.from(document.querySelectorAll("input,textarea,select,[contenteditable]")).slice(0, 200).map(function (el) {
      return { id: fieldKey(el), value: String(fieldValue(el)).slice(0, 65536), checked: !!el.checked };
    });
    return { name: window.__LUME_TITLEBAR__ ? "titlebar" : "", form: HOST_FORM, reason: reason || "update", values: values };
  }
  function reportState(reason) {
    try { parent.postMessage({ __lumeFrameState: captureState(reason) }, "*"); } catch (err) {}
  }
  function scheduleReport(reason) {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(function () { reportState(reason); }, 40);
  }
  function captureSnapshot() {
    var values = Array.from(document.querySelectorAll("input,textarea,select,[contenteditable]")).slice(0, 200).map(function (el) {
      var value = fieldValue(el);
      if (Array.isArray(value)) {
        value = value.slice(0, 64).map(function (entry) { return String(entry).slice(0, SNAPSHOT_MAX_FIELD_CHARS); });
      } else {
        value = String(value == null ? "" : value).slice(0, SNAPSHOT_MAX_FIELD_CHARS);
      }
      return { key: fieldKey(el), value: value, checked: !!el.checked };
    });
    var custom = typeof handlers.snapshot === "function" ? handlers.snapshot() : null;
    if (custom != null) {
      try {
        if (JSON.stringify(custom).length > SNAPSHOT_MAX_CUSTOM_CHARS) custom = null;
      } catch (err) {
        custom = null;
      }
    }
    var snap = { v: 2, auto: { fields: values }, custom: custom == null ? null : custom };
    while (values.length > 0 && JSON.stringify(snap).length > SNAPSHOT_MAX_CHARS) values.pop();
    if (JSON.stringify(snap).length > SNAPSHOT_MAX_CHARS) return null;
    return snap;
  }
  function resolveSnapshotField(key) {
    var raw = String(key == null ? "" : key);
    if (raw.indexOf("id:") === 0) return document.getElementById(raw.slice(3));
    if (raw.indexOf("name:") === 0) {
      var nameKey = raw.slice(5);
      var split = nameKey.lastIndexOf("\\u001f");
      var name = split >= 0 ? nameKey.slice(0, split) : nameKey;
      var wanted = split >= 0 ? Number(nameKey.slice(split + 1)) : 0;
      var named = Array.from(document.querySelectorAll("[name]")).filter(function (node) {
        return node.getAttribute("name") === name;
      });
      return named[Number.isFinite(wanted) ? wanted : 0] || null;
    }
    if (raw.indexOf("path:") === 0) return document.querySelector(raw.slice(5));
    // Backward compatibility with v2 snapshots written before key prefixes.
    var legacyId = document.getElementById(raw);
    if (legacyId) return legacyId;
    if (/^[0-9]+$/.test(raw)) {
      return Array.from(document.querySelectorAll("input,textarea,select,[contenteditable]"))[Number(raw)] || null;
    }
    return null;
  }
  function restoreSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return;
    var fields = snapshot.auto && Array.isArray(snapshot.auto.fields) ? snapshot.auto.fields : [];
    var changed = [];
    for (var i = 0; i < fields.length; i++) {
      var saved = fields[i];
      var el = resolveSnapshotField(saved.key);
      if (!el) continue;
      if (el.multiple) {
        var selected = Array.isArray(saved.value) ? saved.value : String(saved.value == null ? "" : saved.value).split(",");
        for (var j = 0; j < el.options.length; j++) el.options[j].selected = selected.indexOf(el.options[j].value) >= 0;
      } else if (el.type === "checkbox" || el.type === "radio") {
        el.checked = !!saved.checked;
      } else if (el.isContentEditable) {
        el.innerText = String(saved.value == null ? "" : saved.value);
      } else {
        el.value = saved.value == null ? "" : String(saved.value);
      }
      changed.push(el);
    }
    if (typeof handlers.restore === "function") handlers.restore(snapshot.custom);
    // Titlebar frames mirror the query; replaying input there would write the
    // old query back into the authoritative Page Service. Main view frames
    // need the events so framework-controlled inputs and validation update.
    if (!window.__LUME_TITLEBAR__) {
      for (var k = 0; k < changed.length; k++) {
        changed[k].dispatchEvent(new Event("input", { bubbles: true }));
        changed[k].dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
    scheduleReport("restore");
  }

  window.lume = {
    env: { form: HOST_FORM },
    page: {
      ready: function () { return rpc("page.ready"); },
      getModel: function () { return rpc("page.getModel"); },
      subscribe: function (fn) { handlers.model = fn; return function () { if (handlers.model === fn) handlers.model = null; }; },
      dispatch: function (intent) { return rpc("page.dispatch", { intent: intent }); },
      reportLayout: function (report) { return rpc("page.reportLayout", { report: report }); },
      setModal: function (open) { return rpc("page.setModal", { open: !!open }); },
      requestSearchFocus: function () { return rpc("page.requestSearchFocus"); }
    },
    theme: {
      get: function () { return rpc("theme.get"); },
      set: function (mode) { return rpc("theme.set", { mode: mode }); }
    },
    app: {
      toast: function (text, opts) { return rpc("app.toast", { text: text, opts: opts }); },
      resize: function (size) { return rpc("app.resize", { width: size && size.width, height: size && size.height }); },
      dragWindow: function () { return rpc("app.dragWindow"); },
      detach: function () { return rpc("app.detach"); },
      setQuery: function (q) { return rpc("app.setQuery", { q: q }); }
    },
    on: on
  };
  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data || {};
    if (d.__lumeRpcResult) {
      var r = d.__lumeRpcResult;
      var p = pending.get(r.id);
      if (p) {
        pending.delete(r.id);
        r.ok ? p.resolve(r.result) : p.reject(new Error(r.error || "presenter rpc failed"));
      }
      return;
    }
    if (d.__lumeCall) {
      var call = d.__lumeCall;
      Promise.resolve()
        .then(function () {
          if (call.type === "snapshot") return captureSnapshot();
          if (call.type === "key") return typeof handlers.key === "function" ? handlers.key(call.payload) : false;
          return undefined;
        })
        .then(function (result) {
          parent.postMessage({ __lumeCallResult: { callId: call.callId, ok: true, result: result } }, "*");
        })
        .catch(function (err) {
          parent.postMessage({ __lumeCallResult: { callId: call.callId, ok: false, error: String(err) } }, "*");
        });
    }
    if (d.__lumeEvent) {
      var ev = d.__lumeEvent;
      if (ev.type === "restore") restoreSnapshot(ev.payload);
      if (ev.type === "skin" && ev.payload) {
        if (ev.payload.surface) document.documentElement.style.setProperty("--lume-page-bg", ev.payload.surface);
        document.documentElement.style.setProperty("--lume-page-accent", ev.payload.accent || "");
        if (ev.payload.id) document.documentElement.dataset.lumeSkin = ev.payload.id;
      }
      var h = handlers[ev.type];
      if (typeof h === "function") h(ev.payload);
      else (pendingEvents[ev.type] || (pendingEvents[ev.type] = [])).push(ev.payload);
      if (ev.type === "model" || ev.type === "settings" || ev.type === "enter" || ev.type === "show" || ev.type === "query") {
        scheduleReport(ev.type);
      }
    }
  });
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
    if (e.defaultPrevented) return;
    setTimeout(function () {
      // Bubble listeners (including handlers installed after this bridge) have
      // completed by now, so preventDefault reliably suppresses forwarding.
      if (e.defaultPrevented) return;
      parent.postMessage({ __lumeKey: { seq: ++seq, key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey } }, "*");
    }, 0);
  });
  if (window.__LUME_TITLEBAR__) {
    document.addEventListener("mousedown", function (e) {
      if (e.button !== 0) return;
      var t = e.target;
      if (t && t.closest && t.closest("button, input, textarea, select, a, [contenteditable]")) return;
      rpc("app.dragWindow").catch(function () {});
    });
  }
  document.addEventListener("input", function () { scheduleReport("input"); }, true);
  document.addEventListener("change", function () { scheduleReport("change"); }, true);
  document.addEventListener("scroll", function () { scheduleReport("scroll"); }, true);
  function announce() {
    parent.postMessage({ __lumeReady: { frame: window.name } }, "*");
    scheduleReport("ready");
  }
  if (document.readyState === "complete") announce(); else window.addEventListener("load", announce);
})();`;

/** Presenter documents are opaque-origin sandboxes. CSP closes the browser's
 * native network paths (fetch/XHR/WebSocket/EventSource/forms/subresources)
 * so a page cannot bypass the host's permission-checked HTTP proxy. Asset
 * URLs remain available only for host-resolved icons and media. */
const PRESENTER_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob: asset: lume-resource: http://asset.localhost https://asset.localhost",
  "media-src data: blob: asset: lume-resource: http://asset.localhost https://asset.localhost",
  "font-src data:",
  "worker-src 'none'",
  "manifest-src 'none'",
].join("; ");

export function injectPresenterBridge(
  html: string,
  form: "launcher" | "window",
  titlebar = false,
  skin = currentSkin(),
  surface = skinSurface(skin, currentThemeMode()),
  accent = currentAccent()
): string {
  const injection =
    '<meta http-equiv="Content-Security-Policy" content="' + PRESENTER_CSP + '">' +
    '<base target="_blank">' +
    '<style>html{--lume-page-bg:' + surface + ';--lume-page-accent:' + accent + ';background:var(--lume-page-bg)}</style>' +
    '<script>document.documentElement.dataset.lumeSkin=' + JSON.stringify(normalizeSkin(skin)) + ';window.__LUME_HOST_FORM__=' + JSON.stringify(form) + ';</script>' +
    (titlebar ? '<script>window.__LUME_TITLEBAR__=true;/* lume-titlebar-drag-default */</script>' : '') +
    '<script>' + PRESENTER_BRIDGE_SCRIPT + '</script>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + injection);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + injection);
  return injection + html;
}

export interface PresenterBridgeOptions {
  pageId: string;
  presenter: PresenterDescriptor;
  html: string;
  form: "launcher" | "window";
  session: PageSession;
  showToast(text: string, opts?: { undo?: () => void; duration?: number }): void;
  resizeWindow(width?: number, height?: number): void;
  dragWindow?(): void;
  detach?(): void;
  setQuery?(query: string): void;
  themeGet(): unknown;
  themeSet(mode: unknown): Promise<void>;
  settings?(): Record<string, unknown>;
  /** Consume a frame-specific session snapshot when the bridge becomes live.
   * The callback is lazy so a mount that never reaches ready cannot consume
   * state needed by the retry/fallback Presenter. */
  takeSnapshot?(): unknown | null;
  titlebar?: boolean;
  iframeClass?: string;
}

export interface PresenterBridge {
  View: ReturnType<typeof createIframeView>["View"];
  post(type: string, payload?: unknown): void;
  postModel(model: PageModel): void;
  live: () => boolean;
  snapshot: () => Promise<unknown | null>;
  requestKey(key: Record<string, unknown>): Promise<boolean>;
}

export function createPresenterBridge(opts: PresenterBridgeOptions): PresenterBridge {
  const { View, post, live, snapshot, call } = createIframeView(
    async (method, args) => {
      switch (method) {
        case "page.ready":
        case "page.getModel": {
          const model = opts.session.store.get();
          if (!model) throw new Error("Page Model is not ready");
          return model;
        }
        case "page.dispatch":
          return opts.session.dispatch(args.intent as never);
        case "page.reportLayout":
          opts.session.layout(normalizeLayoutReport(args.report));
          return null;
        case "page.setModal":
          opts.session.setModal(Boolean(args.open));
          return null;
        case "page.requestSearchFocus":
          document.getElementById("search-input")?.focus();
          return null;
        case "theme.get":
          return opts.themeGet();
        case "theme.set":
          await opts.themeSet(args.mode);
          return null;
        case "app.toast":
          opts.showToast(String(args.text ?? ""), args.opts as never);
          return null;
        case "app.resize":
          {
            const size = normalizeResizeRequest(args.width, args.height);
            opts.resizeWindow(size.width, size.height);
          }
          return null;
        case "app.dragWindow":
          if (!opts.dragWindow) throw new Error("app.dragWindow is unavailable in this host");
          opts.dragWindow();
          return null;
        case "app.detach":
          if (!opts.detach) throw new Error("app.detach is unavailable in this host");
          opts.detach();
          return null;
        case "app.setQuery":
          if (!opts.setQuery) throw new Error("app.setQuery is unavailable in this host");
          opts.setQuery(String(args.q ?? ""));
          return null;
        default:
          throw new Error("permission denied: Presenter capability not available: " + method);
      }
    },
    () => {
      post("model", opts.session.store.get());
      post("settings", opts.settings?.() ?? {});
      const state = opts.themeGet() as
        | { mode?: unknown; skin?: unknown; accent?: unknown }
        | null
        | undefined;
      const mode = state?.mode === "light" || state?.mode === "dark"
        ? state.mode
        : currentThemeMode();
      const skin = normalizeSkin(state?.skin ?? currentSkin());
      const accent = normalizeAccent(state?.accent ?? currentAccent());
      post("theme", mode);
      post("skin", { id: skin, accent, surface: skinSurface(skin, mode) });
      const snapshot = opts.takeSnapshot?.();
      if (snapshot != null) post("restore", snapshot);
    },
    {
      class: opts.iframeClass ?? "plugin-frame presenter-frame",
      name: "presenter:" + opts.pageId + ":" + opts.presenter.id,
      id: opts.pageId,
    }
  );
  const state = opts.themeGet() as { mode?: unknown; skin?: unknown; accent?: unknown } | null | undefined;
  const mode = state?.mode === "light" || state?.mode === "dark" ? state.mode : currentThemeMode();
  const skin = normalizeSkin(state?.skin ?? currentSkin());
  const accent = normalizeAccent(state?.accent ?? currentAccent());
  View.setHtml(
    injectPresenterBridge(
      opts.html,
      opts.form,
      opts.titlebar === true,
      skin,
      skinSurface(skin, mode),
      accent,
    ),
  );
  return {
    View,
    post,
    postModel: (model) => post("model", model),
    live,
    snapshot,
    requestKey: async (key) => (await call("key", key, 1500)) === true,
  };
}
