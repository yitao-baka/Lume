// 逻辑帧（P6.5）—— 一个插件逻辑的沙箱运行环境（classic script）。
//
// 必须是 **classic script**（不能 type=module）：沙箱 iframe 是 opaque
// origin，module 脚本按 CORS 模式取数，Tauri 自定义协议对 Origin: null 不
// 回 ACAO —— fetch 全被拒（实测 "Failed to fetch"），模块永远不执行。
// classic 脚本走 no-cors 模式，同一 URL 正常加载。
//
// 本文件是自包含的：window.lume（与视图桥同面的 ctx）+ 协议处理 +
// ESM 加载器（文件文本经 supervisor 代理，相对导入改写为帧内 blob URL）。
// 源头的 TypeScript 版设计说明见 docs/PLUGIN_API.md「逻辑运行时」。
(function () {
  "use strict";
  var params = new URLSearchParams(location.search);
  var pluginId = params.get("plugin") || "";
  var __dbg = (window.__frameDebug = window.__frameDebug || []);

  function post(msg) {
    parent.postMessage(msg, "*");
  }

  // ── 帧 → 宿主 RPC（ctx 调用 + 文件读取；模块链可能很长，超时 30s）──
  var pending = new Map();
  var rpcSeq = 0;
  function rpc(method, args) {
    return new Promise(function (resolve, reject) {
      var id = ++rpcSeq;
      var timer = setTimeout(function () {
        pending.delete(id);
        reject(new Error("logic frame rpc timeout: " + method));
      }, 30000);
      pending.set(id, {
        resolve: function (v) {
          clearTimeout(timer);
          resolve(v);
        },
        reject: function (e) {
          clearTimeout(timer);
          reject(e);
        },
      });
      post({ __lumeRpc: { id: id, method: method, args: args } });
    });
  }
  // 透明传递：**不吞错**。曾经这里 catch 后 return undefined，把超时/权限
  // 拒绝/内网拒绝等失败静默伪装成「返回 undefined」——插件无法区分失败与空值
  // （http.request 失败后访问 res.status 抛 TypeError），安全错误也不可感知。
  // 视图桥（iframeBridge 的 rpc）一直是 reject 语义——两个宿主保持一致。
  function call(method, args) {
    return rpc(method, args).catch(function (err) {
      console.error("[lume logic]", method, err);
      throw err;
    });
  }
  function stripMeta(doc) {
    var out = {};
    for (var k in doc) {
      if (k !== "_id" && k !== "_rev" && Object.prototype.hasOwnProperty.call(doc, k)) out[k] = doc[k];
    }
    return out;
  }

  // ── ctx：与视图桥 window.lume 同面（工厂 create(ctx) 收到的就是它）──
  window.lume = {
    app: {
      hide: function () { return call("app.hide"); },
      toast: function (text, opts) { return call("app.toast", { text: text, opts: opts }); },
      setQuery: function (q) { return call("app.setQuery", { q: q }); },
      setPlaceholder: function (text) { return call("app.setPlaceholder", { text: text }); },
      openPath: function (p) { return call("app.openPath", { path: p }); },
      revealPath: function (p) { return call("app.revealPath", { path: p }); },
      trash: function (paths) { return call("app.trash", { paths: paths }); },
      resize: function (size) { return call("app.resize", { width: size && size.width, height: size && size.height }); },
      dragWindow: function () { return call("app.dragWindow"); },
      notify: function (title, body) { return call("app.notify", { title: title, body: body }); },
      setSubInput: function (opts) { return call("app.setSubInput", { opts: opts }); },
      removeSubInput: function () { return call("app.removeSubInput"); },
      redirect: function (targetId, opts) {
        return call("app.redirect", { pluginId: targetId, code: opts && opts.code, payload: opts && opts.payload });
      },
      foreground: function () { return call("app.foreground"); },
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
      files: function (q, opts) { return call("search.files", { q: q, opts: opts }); },
    },
    on: {},
  };

  // ── ESM 加载器：取文本（supervisor 代理）→ 相对导入改写为帧内 blob URL
  //    → import()。opaque origin 里帧自建的 blob 自洽可导。 ──
  var RELATIVE_IMPORT_RE = /(from\s*|import\s*\(\s*|import\s*)(["'])(\.{1,2}\/[^"']+)\2/g;
  var moduleCache = new Map();

  function moduleKey(p) {
    return p.replace(/\//g, "\\").toLowerCase();
  }
  function parentDir(p) {
    var norm = p.replace(/\//g, "\\");
    var i = norm.lastIndexOf("\\");
    return i > 0 ? norm.slice(0, i) : norm;
  }
  function resolveRelative(dir, spec) {
    var parts = (dir + "\\" + spec.replace(/\//g, "\\")).split("\\");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("\\");
  }
  function fetchModuleText(path) {
    var candidates = /\.[a-zA-Z0-9]+$/.test(path) ? [path] : [path + ".js", path + "\\index.js"];
    var seq = candidates.reduce(function (pr, c) {
      return pr.catch(function () { return rpc("__readPluginFile", { path: c }); });
    }, Promise.reject());
    return seq.catch(function () {
      throw new Error("module not found: " + path);
    });
  }
  function compileDiskModule(absPath, rootDir) {
    var key = moduleKey(absPath);
    var cached = moduleCache.get(key);
    if (cached) return cached;
    var compiled = (function () {
      var promise = fetchModuleText(absPath)
        .then(function (text) {
          var dir = parentDir(absPath);
          var deps = new Map();
          var matches = text.matchAll(RELATIVE_IMPORT_RE);
          for (var m of matches) {
            var spec = m[3];
            if (!deps.has(spec)) {
              deps.set(spec, compileDiskModule(resolveRelative(dir, spec), rootDir).then(function (c) { return c.url; }));
            }
          }
          return Promise.all(
            Array.from(deps.entries()).map(function (e) {
              return e[1].then(function (url) { return [e[0], url]; });
            })
          ).then(function (pairs) {
            var urls = new Map(pairs);
            var rewritten = text.replace(RELATIVE_IMPORT_RE, function (mm, pre, q, spec) {
              var url = urls.get(spec);
              return url ? pre + q + url + q : mm;
            });
            // DevTools 里按真实文件名显示（否则是匿名 blob hash）。
            var rel = rootDir && absPath.toLowerCase().startsWith(rootDir.toLowerCase())
              ? absPath.slice(rootDir.length + 1)
              : absPath;
            rewritten += "\n//# sourceURL=lume-plugin/" + pluginId + "/" + rel.replace(/\\/g, "/") + "\n";
            var url = URL.createObjectURL(new Blob([rewritten], { type: "text/javascript" }));
            return import(url);
          });
        });
      moduleCache.set(key, promise);
      return promise;
    })();
    return compiled;
  }
  function resolveLogic(def, api) {
    var ns = def;
    if (ns && typeof ns === "object" && "default" in ns && !("search" in ns)) {
      def = ns.default;
    }
    if (typeof def === "function") {
      var produced = def(api);
      return produced && typeof produced === "object" ? produced : {};
    }
    return def && typeof def === "object" ? def : {};
  }

  var logic = {};

  function handleLoad(payload) {
    var dir = String((payload && payload.dir) || "");
    var entry = String((payload && payload.entry) || "");
    if (!dir || !entry) return Promise.reject(new Error("logic load: missing dir/entry"));
    return compileDiskModule(dir + "\\" + entry.replace(/\//g, "\\"), dir).then(function (mod) {
      logic = resolveLogic(mod, window.lume);
      return { hooks: Object.keys(logic).filter(function (k) { return typeof logic[k] === "function"; }) };
    });
  }
  function handleHook(payload) {
    var name = String((payload && payload.name) || "");
    var fn = logic[name];
    if (typeof fn !== "function") return Promise.resolve(undefined);
    return Promise.resolve(fn.apply(null, (payload && payload.args) || []));
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var d = e.data || {};
    if (d.__lumeRpcResult) {
      var r = d.__lumeRpcResult;
      var p = pending.get(r.id);
      if (p) {
        pending.delete(r.id);
        r.ok ? p.resolve(r.result) : p.reject(new Error(r.error || "logic host rpc failed"));
      }
      return;
    }
    if (d.__lumeEvent) {
      var ev = d.__lumeEvent;
      var h = window.lume.on[ev.type];
      if (typeof h === "function") h(ev.payload);
      return;
    }
    if (d.__lumeCall) {
      __dbg.push("call:" + d.__lumeCall.type);
      var c = d.__lumeCall;
      Promise.resolve()
        .then(function () {
          if (c.type === "load") return handleLoad(c.payload || {});
          if (c.type === "hook") return handleHook(c.payload || {});
          return undefined;
        })
        .then(function (result) {
          post({ __lumeCallResult: { callId: c.callId, ok: true, result: result } });
        })
        .catch(function (err) {
          post({ __lumeCallResult: { callId: c.callId, ok: false, error: String(err) } });
        });
    }
  });

  // 就绪握手（frame 名 = plugin id，supervisor 据此认领）
  function announce() {
    __dbg.push("announced:" + pluginId);
    post({ __lumeReady: { frame: pluginId } });
  }
  if (document.readyState === "complete") announce();
  else window.addEventListener("load", announce);
})();
