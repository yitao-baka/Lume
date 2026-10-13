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
  // Boot signal — the very FIRST statement, before anything can stall: the
  // document committed and its bridge is executing. The host's load watchdog
  // keys on this (not on the later __lumeReady, which waits for the page's own
  // load event) to tell "the frame is alive and merely slow" apart from "the
  // navigation was dropped", so it only ever re-navigates the latter.
  try { parent.postMessage({ __lumeFrameBoot: { frame: window.name } }, "*"); } catch (err) {}
  var pending = new Map();
  var rpcId = 0;
  // Host form (§6C, ROADMAP #42): the host pins every frame to "launcher"
  // (inside the launcher window) or "window" (a detached plugin window) before
  // any page script runs. This is the ONLY reliable way to tell the two apart —
  // do NOT count parent-document iframes: keep-alive (#40) keeps several mode
  // pages mounted at once, so the old "frame count" heuristic misfires.
  var hostForm = window.__LUME_HOST_FORM__ === "window" ? "window" : "launcher";
  // Watchdog only — a net for a host that never answers, so it must not fire
  // before the call's own deadline. \`http.request\` carries its own timeoutMs
  // (the host clamps it to 1–60s, docs/PLUGIN_API.md §6D.1); the old flat 10s
  // cut every slower reply, and the answer arriving after it landed with no
  // pending entry left to resolve (silent drop). Everything else keeps 10s.
  function watchdogMs(method, args) {
    if (method === "http.request" && args && args.req && typeof args.req.timeoutMs === "number") {
      var t = args.req.timeoutMs;
      if (!(t > 0)) t = 10000;
      return Math.min(t, 60000) + 5000;
    }
    return 10000;
  }
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
      }, watchdogMs(method, args));
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
    // 宿主形态常量（§6C/Roadmap #42）："launcher" = 启动器主窗口内嵌页面，
    // "window" = 插件独立窗口内的 view/titlebar 帧。同步可读——页面脚本和
    // 模块初始化时即可分支（例如隐藏自绘的「分离窗口」按钮）。逻辑帧恒为
    // "launcher"（逻辑宿主属于启动器侧）。
    env: { form: hostForm },
    theme: {
      // 本插件自己的颜色模式（§6C，2026-10-12 起）：system = 跟随启动器，
      // light/dark = 固定本插件的明暗。只作用于本插件（页面画布
      // --lume-page-bg + 独立窗口 chrome + 本页 on.theme 载荷），启动器
      // 自身的主题不受影响；值随宿主落盘，重启/独立窗口首帧均生效。
      set: function (mode) { return call("theme.set", { mode: mode }); },
      get: function () { return call("theme.get"); },
    },
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
      detach: function () { return call("app.detach"); },
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
    // the page assigns: lume.on.query / .show / .hide / .key / .enter / .subInput
    // / .settings / .theme = function(payload) —— .theme 收到的是本插件**生效**
    // 的明暗（受 lume.theme.set 影响）。
    on: {},
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
      // 恢复窗口期内的宿主事件 = 页面正在被驱动：放弃「最终校正」
      // （否则会把 enter/query 等正常状态再拉回旧快照）。
      if (restoreState && ev.type !== "restore") restoreState.interrupted = true;
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
  // ── 状态快照（P6.5 / 会话快照 v2，ROADMAP #40）──
  // detach / 关闭独立窗口前，宿主通过 __lumeCall{type:"snapshot"} 向页面要
  // 一份状态（帧域快照 v2）。auto 层由桥自动捕获/回放：输入控件按**稳定键**
  // （id → name → nth-of-type 路径，含 open shadow root）寻址，另有
  // contenteditable、document/滚动容器位置与焦点——不再依赖 DOM 顺序。
  // 页面可用 lume.on.snapshot 提供 custom 层（任意可 JSON 化对象），恢复时
  // 交给 lume.on.restore。恢复带重试：load 之后才异步建 DOM 的页面也能接住
  // 快照；用户先动过的字段不覆盖。快照仅内存流转，不落盘。
  var RESTORE_MS = 4000;
  var SNAP_FIELD_MAX = 200;
  var SNAP_SCROLL_MAX = 40;
  var SNAP_VALUE_MAX = 65536;
  var applying = false;
  // 标题栏槽位帧的恢复是「静默」的：输入值是宿主 query 的视图，派发
  // input/change 会被页面当成新输入（app.setQuery 回路）把当前 query 冲掉。
  // 标题栏仍可自定义 lume.on.restore 处理自身状态。
  var silentRestore = window.name === "titlebar";

  function clipValue(v) {
    v = v == null ? "" : String(v);
    return v.length > SNAP_VALUE_MAX ? v.slice(0, SNAP_VALUE_MAX) : v;
  }
  /** Stable element key — identical on capture and restore of one document. */
  function nodeKey(el) {
    try {
      if (el.id) return "#" + el.id;
      var tag = el.tagName ? el.tagName.toLowerCase() : "";
      if (el.name && (tag === "input" || tag === "textarea" || tag === "select")) {
        var ty = (el.type || "").toLowerCase();
        if (ty === "radio" || ty === "checkbox") {
          return "@" + tag + ":" + el.name + ":" + clipValue(el.value);
        }
        return "@" + tag + ":" + el.name;
      }
      var parts = [];
      var n = el;
      for (var d = 0; n && n.nodeType === 1 && d < 40; d++) {
        var t = n.tagName.toLowerCase();
        var idx = 1;
        var sib = n;
        while ((sib = sib.previousElementSibling)) {
          if (sib.tagName === n.tagName) idx++;
        }
        parts.unshift(t + ":" + idx);
        var root = n.getRootNode ? n.getRootNode() : null;
        if (root && root !== document && root.host) {
          n = root.host;
          parts.unshift(">>");
        } else {
          n = n.parentElement;
        }
      }
      return parts.join("/");
    } catch (err) {
      return "";
    }
  }
  /** State-bearing nodes (inputs + contenteditable), open shadow roots included. */
  function collectNodes(root, out) {
    try {
      var list = root.querySelectorAll("input, textarea, select, [contenteditable]");
      for (var i = 0; i < list.length && out.length < 600; i++) out.push(list[i]);
      var all = root.querySelectorAll("*");
      for (var j = 0; j < all.length && out.length < 600; j++) {
        var sr = all[j].shadowRoot;
        if (sr) collectNodes(sr, out);
      }
    } catch (err) {}
  }
  function keyMap(nodes) {
    var m = {};
    for (var i = 0; i < nodes.length; i++) {
      var k = nodeKey(nodes[i]);
      if (k && !(k in m)) m[k] = nodes[i];
    }
    return m;
  }
  function captureSnapshot() {
    var nodes = [];
    collectNodes(document, nodes);
    var fields = [];
    var editables = [];
    for (var i = 0; i < nodes.length && fields.length < SNAP_FIELD_MAX; i++) {
      var el = nodes[i];
      try {
        var tag = el.tagName ? el.tagName.toLowerCase() : "";
        if (tag === "input") {
          var ty = (el.type || "text").toLowerCase();
          if (ty === "file") continue; // FileList 不可序列化
          if (ty === "checkbox" || ty === "radio") {
            fields.push({ k: nodeKey(el), t: ty, c: !!el.checked });
          } else {
            fields.push({ k: nodeKey(el), t: "input", v: clipValue(el.value) });
          }
        } else if (tag === "textarea") {
          fields.push({ k: nodeKey(el), t: "textarea", v: clipValue(el.value) });
        } else if (tag === "select") {
          if (el.multiple) {
            var vals = [];
            for (var oi = 0; oi < el.options.length; oi++) {
              if (el.options[oi].selected) vals.push(String(el.options[oi].value));
            }
            fields.push({ k: nodeKey(el), t: "multi", vals: vals });
          } else {
            fields.push({ k: nodeKey(el), t: "select", v: clipValue(el.value) });
          }
        } else if (el.isContentEditable) {
          editables.push({ k: nodeKey(el), text: clipValue(el.innerText) });
        }
      } catch (err) {}
    }
    var scroll = [];
    try {
      var se = document.scrollingElement || document.documentElement;
      scroll.push({ k: "", x: se.scrollLeft || 0, y: se.scrollTop || 0 });
    } catch (err) {}
    for (var si = 0; si < nodes.length && scroll.length < SNAP_SCROLL_MAX; si++) {
      var sn = nodes[si];
      try {
        if (sn.scrollHeight > sn.clientHeight + 4 || sn.scrollWidth > sn.clientWidth + 4) {
          scroll.push({ k: nodeKey(sn), x: sn.scrollLeft || 0, y: sn.scrollTop || 0 });
        }
      } catch (err) {}
    }
    var focus = null;
    try {
      var ae = document.activeElement;
      if (ae && ae.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName)) {
        focus = { k: nodeKey(ae) };
        if (typeof ae.selectionStart === "number") {
          focus.start = ae.selectionStart;
          focus.end = ae.selectionEnd;
        }
      }
    } catch (err) {}
    var snap = { v: 2, auto: { fields: fields, scroll: scroll } };
    if (editables.length) snap.auto.editables = editables;
    if (focus) snap.auto.focus = focus;
    var h = window.lume.on.snapshot;
    if (typeof h !== "function") return snap;
    return Promise.resolve()
      .then(h)
      .then(function (custom) {
        if (custom !== undefined && custom !== null) snap.custom = custom;
        return snap;
      })
      .catch(function () {
        return snap; // custom 层异常不拖垮 auto 层
      });
  }
  // 恢复：立即 + 观察 DOM + 250ms 轮询，持续 RESTORE_MS；按稳定键应用，
  // 用户先动过的字段/滚动不再覆盖。v1（P6.5 按 DOM 顺序的 fields 数组）兼容。
  var restoreState = null;
  function stopRestore() {
    var st = restoreState;
    if (!st) return;
    restoreState = null;
    try { window.clearInterval(st.interval); } catch (err) {}
    try { if (st.moTimer) window.clearTimeout(st.moTimer); } catch (err) {}
    try { if (st.observer) st.observer.disconnect(); } catch (err) {}
    try {
      document.removeEventListener("input", st.onUser, true);
      document.removeEventListener("change", st.onUser, true);
      document.removeEventListener("keydown", st.onInteract, true);
      document.removeEventListener("mousedown", st.onInteract, true);
      document.removeEventListener("scroll", st.onScroll, true);
    } catch (err) {}
  }
  function normalizeFrame(snap) {
    if (!snap || typeof snap !== "object") return null;
    if (snap.v === 2 && snap.auto) return snap;
    if (snap.auto && Object.prototype.toString.call(snap.auto.fields) === "[object Array]") {
      var fields = [];
      for (var i = 0; i < snap.auto.fields.length; i++) {
        var f = snap.auto.fields[i] || {};
        fields.push({ k: ":legacy:" + i, t: "legacy", v: f.v, c: f.c });
      }
      var scroll = [];
      if (snap.auto.scroll) {
        scroll.push({ k: "", x: snap.auto.scroll.x || 0, y: snap.auto.scroll.y || 0 });
      }
      return { v: 2, auto: { fields: fields, scroll: scroll, legacy: true }, custom: snap.custom };
    }
    return null;
  }
  function findLegacyNode(nodes, idx) {
    var seen = -1;
    for (var i = 0; i < nodes.length; i++) {
      var tag = nodes[i].tagName ? nodes[i].tagName.toLowerCase() : "";
      if (tag !== "input" && tag !== "textarea" && tag !== "select") continue;
      if (nodes[i].type === "file") continue;
      seen++;
      if (seen === idx) return nodes[i];
    }
    return null;
  }
  function setFieldValue(el, f) {
    applying = true;
    try {
      if (f.t === "checkbox" || f.t === "radio") {
        el.checked = !!f.c;
        if (!silentRestore) el.dispatchEvent(new Event("change", { bubbles: true }));
      } else if (f.t === "multi") {
        var want = f.vals || [];
        for (var i = 0; i < el.options.length; i++) {
          el.options[i].selected = want.indexOf(String(el.options[i].value)) !== -1;
        }
        if (!silentRestore) el.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        el.value = f.v == null ? "" : String(f.v);
        if (!silentRestore) el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (err) {} finally {
      applying = false;
    }
  }
  function setEditableValue(el, text) {
    applying = true;
    try {
      el.innerText = text == null ? "" : String(text);
      if (!silentRestore) el.dispatchEvent(new Event("input", { bubbles: true }));
    } catch (err) {} finally {
      applying = false;
    }
  }
  function tryRestore() {
    var st = restoreState;
    if (!st) return;
    // 最终校正（deadline 的那次 pass）：页面若没有后续宿主事件、用户也没动过，
    // 把异步初始化覆盖掉的字段再拉回一次（每个字段一生最多两次写入）。
    var finalPass = Date.now() >= st.deadline && !st.interrupted;
    var frame = st.frame;
    var auto = frame.auto || {};
    var fields = auto.fields || [];
    var editables = auto.editables || [];
    var scroll = auto.scroll || [];
    var nodes = null;
    var map = null;
    if (fields.length || editables.length || scroll.length || auto.focus) {
      nodes = [];
      collectNodes(document, nodes);
      map = keyMap(nodes);
    }
    // 应用语义（#40 修正）：每个字段**只应用一次**；只有「还没找到」（迟到
    // DOM）或「应用过的节点被替换」（isConnected=false）时才重试。这样恢复
    // 窗口期内页面自己的状态变化（宿主 enter/query 驱动的写入、异步初始化
    // 之后的重渲染）不会被恢复循环反复回滚——异步初始化覆盖表单值这类页面
    // 应由 lume.on.snapshot/restore 自定义层负责（契约见 PLUGIN_API §6C）。
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      if (!f || !f.k || st.touched[f.k]) continue;
      if (st.applied[f.k]) {
        var prev = st.appliedEl[f.k];
        if (!prev || prev.isConnected) {
          if (!finalPass) continue; // 已应用过：非最终校正不再写
        }
        delete st.applied[f.k]; // 节点被替换 / 最终校正：允许再写一次
      }
      var el = f.el && f.el.isConnected ? f.el : (auto.legacy ? findLegacyNode(nodes, i) : map[f.k]);
      if (!el) continue;
      f.el = el;
      if (f.t === "multi") {
        var haveMul = [];
        if (el.selectedOptions) {
          for (var so = 0; so < el.selectedOptions.length; so++) {
            haveMul.push(String(el.selectedOptions[so].value));
          }
        }
        var wantMul = f.vals || [];
        var a = haveMul.slice().sort().join("\\n");
        var b = wantMul.slice().sort().join("\\n");
        if (a !== b) setFieldValue(el, f);
      } else {
        var want = f.t === "checkbox" || f.t === "radio" ? !!f.c : (f.v == null ? "" : String(f.v));
        var have = f.t === "checkbox" || f.t === "radio" ? !!el.checked : (el.value == null ? "" : String(el.value));
        if (have !== want) setFieldValue(el, f);
      }
      st.applied[f.k] = 1;
      st.appliedEl[f.k] = el;
    }
    for (var e2 = 0; e2 < editables.length; e2++) {
      var ed = editables[e2];
      if (!ed || !ed.k || st.touched[ed.k]) continue;
      if (st.applied[ed.k]) {
        var prevEd = st.appliedEl[ed.k];
        if (!prevEd || prevEd.isConnected) {
          if (!finalPass) continue;
        }
        delete st.applied[ed.k];
      }
      var ee = ed.el && ed.el.isConnected ? ed.el : map[ed.k];
      if (!ee) continue;
      ed.el = ee;
      if ((ee.innerText == null ? "" : String(ee.innerText)) !== (ed.text || "")) {
        setEditableValue(ee, ed.text || "");
      }
      st.applied[ed.k] = 1;
      st.appliedEl[ed.k] = ee;
    }
    for (var s2 = 0; s2 < scroll.length; s2++) {
      var sc = scroll[s2];
      if (!sc || sc.k == null || st.scrollDone[sc.k] || st.touched[sc.k]) continue;
      var se = sc.k === "" ? (document.scrollingElement || document.documentElement) : map[sc.k];
      if (!se) continue;
      applying = true;
      try {
        if (typeof se.scrollTo === "function") se.scrollTo(sc.x || 0, sc.y || 0);
        else { se.scrollLeft = sc.x || 0; se.scrollTop = sc.y || 0; }
      } catch (err) {
        try { se.scrollLeft = sc.x || 0; se.scrollTop = sc.y || 0; } catch (e3) {}
      } finally {
        applying = false;
      }
      st.scrollDone[sc.k] = 1;
    }
    // custom 层只投一次；页面若异步初始化需自行缓存（契约见 PLUGIN_API §6C）。
    if (!st.customDone) {
      st.customDone = true;
      if (frame.custom !== undefined && typeof window.lume.on.restore === "function") {
        try { window.lume.on.restore(frame.custom); } catch (err) {}
      }
    }
    // focus：用户没动过才还焦点与选区（首个能命中元素的 pass 生效）。
    var fo = auto.focus;
    if (fo && !st.focusDone && !st.interacted) {
      var fe = fo.el && fo.el.isConnected ? fo.el : map ? map[fo.k] : null;
      if (fe) {
        fo.el = fe;
        st.focusDone = true;
        applying = true;
        try {
          fe.focus({ preventScroll: true });
          if (typeof fo.start === "number" && fe.setSelectionRange) {
            fe.setSelectionRange(fo.start, fo.end == null ? fo.start : fo.end);
          }
        } catch (err) {} finally {
          applying = false;
        }
      }
    }
    if (Date.now() >= st.deadline) stopRestore();
  }
  function applySnapshot(snap) {
    var frame = normalizeFrame(snap);
    if (!frame) return;
    stopRestore();
    var st = {
      frame: frame,
      deadline: Date.now() + RESTORE_MS,
      touched: {},
      applied: {},
      interrupted: false,
      appliedEl: {},
      scrollDone: {},
      customDone: false,
      focusDone: false,
      interacted: false,
      observer: null,
      moTimer: 0,
      interval: 0,
    };
    st.onUser = function (e) {
      if (applying) return;
      var t = e.target;
      if (!t || !t.tagName) return;
      var k = nodeKey(t);
      if (k) st.touched[k] = 1;
    };
    st.onInteract = function () { st.interacted = true; };
    st.onScroll = function (e) {
      if (applying) return;
      var t = e.target;
      var k = t === document ? "" : (t && t.nodeName ? nodeKey(t) : "");
      st.scrollDone[k] = 1;
    };
    document.addEventListener("input", st.onUser, true);
    document.addEventListener("change", st.onUser, true);
    document.addEventListener("keydown", st.onInteract, true);
    document.addEventListener("mousedown", st.onInteract, true);
    document.addEventListener("scroll", st.onScroll, true);
    try {
      st.observer = new MutationObserver(function () {
        if (st.moTimer) return;
        st.moTimer = window.setTimeout(function () { st.moTimer = 0; tryRestore(); }, 80);
      });
      st.observer.observe(document.documentElement || document, { childList: true, subtree: true });
    } catch (err) {}
    restoreState = st;
    tryRestore();
    st.interval = window.setInterval(tryRestore, 250);
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
      var nodes = document.querySelectorAll("input, textarea, select, [contenteditable]");
      for (var i = 0; i < nodes.length && values.length < 24; i++) {
        var el = nodes[i];
        if (el.type === "file") continue;
        var v;
        if (el.isContentEditable) v = el.innerText;
        else if (el.tagName === "SELECT" && el.multiple) {
          var sel = [];
          for (var o = 0; o < el.selectedOptions.length; o++) sel.push(el.selectedOptions[o].value);
          v = sel.join(",");
        } else v = el.value;
        values.push({
          id: el.id || "",
          name: el.name || "",
          value: v == null ? "" : String(v),
          checked: !!el.checked,
        });
      }
      parent.postMessage(
        {
          __lumeFrameState: {
            name: window.name || "",
            form: hostForm,
            reason: reason,
            ready: document.readyState,
            // 诊断（probes）：恢复是否仍在「迟到 DOM」重试窗口内。
            restoring: !!restoreState,
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

/** Host default for titlebar slot pages: blank areas drag the detached
 * window. Events inside the slot iframe never reach the host chrome row
 * (opaque origin, PLUGIN_API.md §6G.5), and a page that ships the slot only
 * as decoration — no drag handling of its own, e.g. a blank discriminator
 * page — would otherwise leave the middle of the title bar dead (only the
 * host-rendered title stayed draggable). Interactive elements keep their
 * clicks; selectable text keeps text selection; a page opts out wholesale
 * with `data-lume-drag="off"` on itself or any ancestor (or per-element with
 * `data-lume-no-drag`). Double clicks do nothing here (no maximize RPC —
 * and dragging on detail===2 would jiggle the window). Runs in CAPTURE phase
 * before page handlers; a plugin's own `app.dragWindow()` on the same gesture
 * is deduped by the host (pluginWindow's services.dragWindow time-gate), so
 * pages that implement the §6G.5 convention themselves keep working. */
export const TITLEBAR_DRAG_SCRIPT = `
/* lume-titlebar-drag-default */
(function () {
  var INTERACTIVE = "a,button,input,select,textarea,label,summary," +
    "[contenteditable],[tabindex],[role],[data-lume-no-drag]";
  function wantsDrag(e) {
    if (e.button !== 0 || e.detail !== 1) return false;
    var t = e.target;
    if (!t || !t.closest) return false;
    if (t.closest(INTERACTIVE)) return false;
    if (t.closest('[data-lume-drag="off"]')) return false;
    try { if (getComputedStyle(t).userSelect === "text") return false; } catch (err) {}
    return true;
  }
  document.addEventListener("mousedown", function (e) {
    if (wantsDrag(e) && window.lume && window.lume.app) window.lume.app.dragWindow();
  }, true);
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
export function injectBridge(html: string, form: "launcher" | "window"): string {
  return injectAtHead(html, "", form);
}

/** Titlebar slot pages (detached window chrome row, manifest `titlebar`):
 * the bridge plus the host's default window-drag for blank areas
 * (TITLEBAR_DRAG_SCRIPT). */
export function injectTitlebarBridge(html: string, form: "launcher" | "window"): string {
  return injectAtHead(html, `<script>${TITLEBAR_DRAG_SCRIPT}</script>`, form);
}

function injectAtHead(html: string, tail: string, form: "launcher" | "window"): string {
  const injection =
    `<base target="_blank">` +
    `<style>html{background:var(--lume-page-bg,${PANEL_SURFACE_BG[currentThemeMode()]})}</style>` +
    // `lume.env.form` (ROADMAP #42): the hosting surface this frame lives in.
    // Injected BEFORE the bridge so `window.lume` exists synchronously with
    // the right value, and the page cannot corrupt it by running first.
    `<script>window.__LUME_HOST_FORM__=${JSON.stringify(form)};</script>` +
    `<script>${BRIDGE_SCRIPT}</script>` +
    tail;
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

/** Boot watchdog delays (P6.6 blank-window fix). A fresh frame is expected to
 * report `__lumeFrameBoot` a few ms after its navigation commits; a frame that
 * stays silent this long never got a document and is re-navigated (see
 * `createIframeView`). Runs only while the current document is unbooted, so a
 * healthy frame clears the timers on its first message. */
const BOOT_RETRY_DELAYS_MS = [700, 1500, 2800];
/** After the last re-navigation: how long to wait before reporting the frame
 * as dead (loudly — the window is blank and the user deserves a console
 * record of why). */
const BOOT_FINAL_CHECK_MS = 1600;

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
  opts?: { class?: string; name?: string; id?: string }
): {
  View: Component & { setHtml(html: string): void };
  post: (type: string, payload?: unknown) => void;
  /** Ask the page for its state snapshot (P6.5; frame snapshot v2 since
   * ROADMAP #40). Resolves null when the page isn't live, doesn't answer
   * within `timeoutMs`, or errors — a dead or hostile page must never block
   * a detach/close. */
  snapshot: (timeoutMs?: number) => Promise<unknown | null>;
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
  return { View, post, snapshot, live };
}
