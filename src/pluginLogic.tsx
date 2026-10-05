//! 共享插件逻辑宿主（P6.5 进程隔离）—— 第四个窗口入口（pluginLogic.html）。
//!
//! 一个隐藏窗口承载全部 entry 插件的逻辑：每插件一个 opaque-origin 沙箱
//! iframe（`pluginLogicFrame.html`，站点隔离 → 独立 renderer 进程）。本页是
//! supervisor：按启动器指令建帧/拆帧、发令牌、转发 hook 调用与 ctx RPC，
//! 把 ctx 的启动器侧动作（toast/setQuery/hide/redirect…）经 Rust 令牌中继
//! 回 main。
//!
//! 信任边界（三层）：
//! 1. 插件代码在 opaque-origin iframe 里，够不到 supervisor 的任何状态；
//! 2. 帧→Rust 的每一次调用都带令牌，Rust 按令牌→id 强制归属（冒用无效）；
//! 3. supervisor 本体是第一方代码，持有令牌表与 fetch 代理（文件读取限制
//!    在本插件目录内）。
//!
//! 生命周期：启动器 `plugin_logic_host_ensure` 建窗 → 本页监听器就绪后
//! `plugin_logic_supervisor_ready` → 启动器（重）发各插件 load（覆盖建窗
//! 竞态与崩溃恢复）。崩溃时 Rust `Destroyed` → `plugin-logic-host-closed`。

import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PluginManifest, PluginServices } from "./plugins/types";
import { HOST_PLUGIN_API } from "./plugins/types";
import { setPermissionSource } from "./plugins/permissions";
import { execHostRpc } from "./plugins/rpc";
import { plog } from "./plugins/log";

const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals";

interface FrameCall {
  kind: "load" | "hook";
  resolve?: (v: unknown) => void;
  reject?: (e: unknown) => void;
}

interface LogicEntry {
  token: string;
  dir: string;
  entry: string;
  frame: HTMLIFrameElement | undefined;
  loaded: boolean;
  calls: Map<number, FrameCall>;
  callSeq: number;
}

const entries = new Map<string, LogicEntry>();
// CDP verify tap（同 __pluginStates/__pwClosed 模式）
(window as unknown as { __logicEntries?: Map<string, LogicEntry> }).__logicEntries = entries;

function postTo(entry: LogicEntry, msg: unknown) {
  entry.frame?.contentWindow?.postMessage(msg, "*");
}

/** ctx 的启动器侧动作 —— 全部经令牌中继回 main（Rust 归属强制）。 */
function makeServices(id: string, token: string): PluginServices {
  const action = (action: string, args: Record<string, unknown> = {}) =>
    void invoke("plugin_logic_action", { token, action, args }).catch((err) =>
      plog.error(id, `logic action ${action} failed:`, err)
    );
  return {
    showToast: (text) => action("toast", { text }),
    markEntryOpened: () => action("markEntryOpened"),
    resetAndHide: () => action("hide"),
    persistLastPage: () => {},
    runSearch: async () => {},
    scheduleResize: () => {},
    searchToken: () => 0,
    nextSearchToken: () => 0,
    selectionSource: () => "other",
    markMouse: () => {},
    openMenu: () => {},
    mode: () => id,
    requestMode: () => {},
    setModePlaceholder: () => {},
    setQuery: (q) => action("setQuery", { q }),
    resizeWindow: () => {},
    dragWindow: () => {},
    setSubInput: () => {},
    subInputOwner: () => null,
    enterPlugin: (pluginId, info) => {
      // redirect：载荷交启动器路由（与分离窗口的 redirect 同形）
      action("redirect", { pluginId, code: info.code, payload: info.payload });
      return true;
    },
  };
}

/** supervisor 代理的文件读取：路径必须仍在本插件目录内（防跨插件读码），
 * 经 asset 协议 fetch（supervisor 页面具备 main 的取数能力）。 */
async function readPluginFile(entry: LogicEntry, rawPath: string): Promise<string> {
  const norm = rawPath.replace(/\//g, "\\").toLowerCase();
  const dir = entry.dir.replace(/\//g, "\\").toLowerCase();
  if (!(norm === dir || norm.startsWith(dir + "\\"))) {
    throw new Error("logic frame file read escaped the plugin directory");
  }
  const res = await fetch(convertFileSrc(rawPath));
  if (!res.ok) throw new Error(`plugin file fetch failed: ${res.status}`);
  return res.text();
}

async function loadPlugin(id: string) {
  if (entries.has(id)) return;
  let meta: { dir: string; entry: string; name: string; api: number };
  try {
    meta = await invoke<{ dir: string; entry: string; name: string; api: number }>(
      "plugin_logic_meta",
      { id }
    );
  } catch (err) {
    plog.error(id, "logic host: meta fetch failed:", err);
    return;
  }
  if (!meta.entry) return; // 纯视图模式无逻辑
  // API 版本二次校验（#32.1 防御纵深）：registry 门在前，这里兜底（如
  // 旧 main 窗口残留在发 load）。拒绝建帧，而非加载后行为怪异。
  if (meta.api > HOST_PLUGIN_API) {
    plog.error(
      id,
      `logic host: manifest api=${meta.api} > host ${HOST_PLUGIN_API} — refusing`
    );
    return;
  }
  const token = crypto.randomUUID();
  const entry: LogicEntry = {
    token,
    dir: meta.dir,
    entry: meta.entry,
    frame: undefined,
    loaded: false,
    calls: new Map(),
    callSeq: 0,
  };
  try {
    await invoke("plugin_logic_register_tokens", { entries: [{ id, token }] });
  } catch (err) {
    plog.error(id, "logic host: token register failed:", err);
    return;
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", SANDBOX);
  frame.style.display = "none";
  frame.src = `pluginLogicFrame.html?plugin=${encodeURIComponent(id)}`;
  document.getElementById("root")?.appendChild(frame);
  entry.frame = frame;
  entries.set(id, entry);
  window.addEventListener("message", (e: MessageEvent) => onFrameMessage(id, entry, e));
  plog.info(id, "logic host: iframe created");
}

function onFrameMessage(id: string, entry: LogicEntry, e: MessageEvent) {
  if (e.source !== entry.frame?.contentWindow) return;
  const d = (e.data || {}) as Record<string, any>;
  if (d.__lumeReady) {
    // 就绪 → 发 load（帧内 import entry 并 resolveLogic）
    const callId = ++entry.callSeq;
    entry.calls.set(callId, {
      kind: "load",
      resolve: (result) => {
        entry.loaded = true;
        const hooks = (result as { hooks?: string[] } | null)?.hooks ?? [];
        plog.info(id, `logic host: loaded (${hooks.length} hooks: ${hooks.join("/")})`);
      },
      reject: (err) => plog.error(id, "logic load failed:", err),
    });
    postTo(entry, {
      __lumeCall: { callId, type: "load", payload: { dir: entry.dir, entry: entry.entry } },
    });
    return;
  }
  if (d.__lumeCallResult) {
    const r = d.__lumeCallResult as { callId: number; ok: boolean; result?: unknown; error?: string };
    const call = entry.calls.get(r.callId);
    if (!call) return;
    entry.calls.delete(r.callId);
    if (call.kind === "load") {
      r.ok ? call.resolve?.(r.result) : call.reject?.(new Error(r.error ?? "logic load failed"));
    } else {
      // hook 回执 → 经 Rust 令牌中继回 main（registry 按 callId 收口）
      void invoke("plugin_logic_result", {
        token: entry.token,
        callId: r.callId,
        ok: r.ok,
        result: r.ok ? (r.result ?? null) : null,
        error: r.ok ? null : String(r.error ?? "hook failed"),
      }).catch((err) => plog.error(id, "logic result relay failed:", err));
    }
    return;
  }
  if (d.__lumeRpc) {
    const rpc = d.__lumeRpc as { id: number; method: string; args: Record<string, unknown> };
    const reply = (ok: boolean, result: unknown, error?: string) =>
      postTo(entry, { __lumeRpcResult: { id: rpc.id, ok, result, error } });
    if (rpc.method === "__readPluginFile") {
      readPluginFile(entry, String(rpc.args?.path ?? ""))
        .then((text) => reply(true, text))
        .catch((err) => reply(false, null, String(err)));
      return;
    }
    execHostRpc(id, rpc.method, rpc.args ?? {}, makeServices(id, entry.token), entry.token)
      .then((result) => reply(true, result))
      .catch((err) => reply(false, null, String(err)));
  }
}

function unloadPlugin(id: string) {
  const entry = entries.get(id);
  if (!entry) return;
  entry.frame?.remove();
  entries.delete(id);
  // 令牌表清空该插件（Rust 侧 drop）
  void invoke("plugin_logic_register_tokens", { entries: [{ id, token: null }] }).catch(() => {});
}

function callHook(id: string, payload: { callId: number; name: string; args: unknown[] }) {
  const entry = entries.get(id);
  if (!entry || !entry.loaded || !entry.frame?.contentWindow) {
    // 未就绪：立即回执失败（registry 侧按调用点语义降级，如 search → []）
    if (entry) {
      void invoke("plugin_logic_result", {
        token: entry.token,
        callId: payload.callId,
        ok: false,
        result: null,
        error: `logic not loaded for "${id}"`,
      }).catch(() => {});
    }
    return;
  }
  entry.calls.set(payload.callId, { kind: "hook" });
  postTo(entry, {
    __lumeCall: {
      callId: payload.callId,
      type: "hook",
      payload: { name: payload.name, args: payload.args },
    },
  });
}

async function start() {
  // 权限源的清单来源（与分离窗口同样的接线方式）
  void invoke<PluginManifest[]>("get_plugins")
    .then((list) => setPermissionSource((pid: string) => list.find((x) => x.id === pid)))
    .catch((err) => plog.error(null, "logic host: permission source wire failed:", err));

  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(
    await listen<{ id: string; kind: string; payload: Record<string, unknown> }>(
      "plugin-logic-event",
      (e) => {
        const { id, kind, payload } = e.payload;
        if (kind === "load") {
          void loadPlugin(id);
        } else if (kind === "unload") {
          unloadPlugin(id);
        } else if (kind === "event") {
          const entry = entries.get(id);
          if (entry) postTo(entry, { __lumeEvent: { type: payload.type, payload: payload.payload } });
        } else if (kind === "hook") {
          callHook(id, payload as unknown as { callId: number; name: string; args: unknown[] });
        }
      }
    )
  );
  // 就绪通告 → 启动器（重）发全部 load（覆盖建窗竞态与崩溃恢复）
  await invoke("plugin_logic_supervisor_ready").catch((err) =>
    plog.error(null, "logic host: ready signal failed:", err)
  );
  void unlisteners;
}

void start();
