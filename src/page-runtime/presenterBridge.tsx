//! Restricted Presenter bridge. Model reads/intents and shell-safe actions are
//! the only RPCs this iframe can reach; there is no http/storage/db/fs/
//! clipboard/dialog/screen/search/secrets or arbitrary Tauri command surface.

import { currentThemeMode, PANEL_SURFACE_BG } from "../theme";
import { createIframeView } from "../plugins/iframeBridge";
import type { PageLayoutReport, PageModel, PresenterDescriptor } from "./contracts";
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
  window.lume = {
    env: { form: window.__LUME_HOST_FORM__ === "window" ? "window" : "launcher" },
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
    if (d.__lumeEvent) {
      var ev = d.__lumeEvent;
      if (ev.type === "theme") {
        document.documentElement.style.setProperty("--lume-page-bg", ev.payload === "light" ? "${PANEL_SURFACE_BG.light}" : "${PANEL_SURFACE_BG.dark}");
      }
      var h = handlers[ev.type];
      if (typeof h === "function") h(ev.payload);
      else (pendingEvents[ev.type] || (pendingEvents[ev.type] = [])).push(ev.payload);
    }
  });
  document.addEventListener("keydown", function (e) {
    var t = e.target;
    if (t && t.closest && t.closest("input, textarea, select, [contenteditable]")) return;
    if (e.defaultPrevented) return;
    parent.postMessage({ __lumeKey: { seq: ++seq, key: e.key, code: e.code, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey } }, "*");
  });
  function announce() { parent.postMessage({ __lumeReady: { frame: window.name } }, "*"); }
  if (document.readyState === "complete") announce(); else window.addEventListener("load", announce);
})();`;

export function injectPresenterBridge(html: string, form: "launcher" | "window"): string {
  const injection =
    '<base target="_blank">' +
    '<style>html{background:var(--lume-page-bg,' + PANEL_SURFACE_BG[currentThemeMode()] + ')}</style>' +
    '<script>window.__LUME_HOST_FORM__=' + JSON.stringify(form) + ';</script>' +
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
}

export interface PresenterBridge {
  View: ReturnType<typeof createIframeView>["View"];
  post(type: string, payload?: unknown): void;
  postModel(model: PageModel): void;
  live: () => boolean;
  snapshot: () => Promise<unknown | null>;
}

export function createPresenterBridge(opts: PresenterBridgeOptions): PresenterBridge {
  const { View, post, live, snapshot } = createIframeView(
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
          opts.session.layout(args.report as PageLayoutReport);
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
          opts.resizeWindow(args.width as number | undefined, args.height as number | undefined);
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
      post("theme", currentThemeMode());
    },
    { class: "plugin-frame presenter-frame", name: "presenter:" + opts.pageId + ":" + opts.presenter.id, id: opts.pageId }
  );
  View.setHtml(injectPresenterBridge(opts.html, opts.form));
  return {
    View,
    post,
    postModel: (model) => post("model", model),
    live,
    snapshot,
  };
}
