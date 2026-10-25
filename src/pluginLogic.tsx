//! 共享插件逻辑宿主（进程隔离）—— 第四个窗口入口（pluginLogic.html）。
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

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { PluginManifest, PluginServices } from "./plugins/types";
import { HOST_PLUGIN_API } from "./plugins/types";
import { setPermissionSource } from "./plugins/permissions";
import { execHostRpc } from "./plugins/rpc";
import { plog } from "./plugins/log";
import { resolveColorMode } from "./theme";
import { normalizeSkin } from "./skins/registry";
import { normalizeAccent } from "./skins/accent";
import { pluginColorMode, pluginColorPref, seedPluginColorPrefs, setPluginColorPref } from "./plugins/themePrefs";
import type { SettingsData } from "./settings/types";

/** This hidden window's copy of the launcher's color-mode setting + the
 * per-plugin preference mirror (same `__LUME_CONFIG__` snapshot every window
 * gets) — `ctx.theme.get` answers from it and `ctx.theme.set` keeps it fresh
 * (docs/ROADMAP_HISTORY.md #36). This window draws nothing of its own, so the values only ever
 * travel into the plugin frames' host-API answers; a preference changed
 * elsewhere *after* this window was created is therefore up to one window
 * lifetime stale here (the launcher's own mirror, not this one, drives every
 * `theme` push). */
const cfgAppearance = (window as unknown as { __LUME_CONFIG__?: SettingsData }).__LUME_CONFIG__?.appearance;
let hostColorSetting = cfgAppearance?.color_mode ?? "system";
let hostSkin = normalizeSkin(cfgAppearance?.skin);
let hostAccent = normalizeAccent(cfgAppearance?.accent);
seedPluginColorPrefs(
  (window as unknown as { __LUME_CONFIG__?: SettingsData }).__LUME_CONFIG__?.plugins?.color_modes
);

const SANDBOX = "allow-scripts allow-modals";
const permissionManifests = new Map<string, PluginManifest>();
setPermissionSource((id) => permissionManifests.get(id));

interface FrameCall {
  kind: "load" | "hook";
  name?: string;
  resolve?: (v: unknown) => void;
  reject?: (e: unknown) => void;
  /** hook 回执兜底（#32.4）：帧卡死/不回执时主动回执失败并清槽，
   * 否则 `entry.calls` 的条目永久滞留（泄漏）且 registry 侧只能等 8s。 */
  timer?: number;
}

interface LogicEntry {
  token: string;
  role: "service" | "logic";
  dir: string;
  entry: string;
  frame: HTMLIFrameElement | undefined;
  messageHandler: ((event: MessageEvent) => void) | undefined;
  loaded: boolean;
  calls: Map<number, FrameCall>;
  callSeq: number;
}

const entries = new Map<string, LogicEntry>();
let messageListenerCount = 0;
// CDP verify tap（同 __pluginStates/__pwClosed 模式）
(window as unknown as { __logicEntries?: Map<string, LogicEntry> }).__logicEntries = entries;
(window as unknown as { __logicListenerProbe?: unknown }).__logicListenerProbe = {
  listenerCount: () => messageListenerCount,
  pendingCalls: () => [...entries.values()].reduce((sum, entry) => sum + entry.calls.size, 0),
};
/** 最近 80 条帧 rpc 的结局摘要（#32 加固核验用；CDP 直读）。 */
const rpcLog: {
  id: string;
  method: string;
  ok: boolean;
  error?: string;
  resultType: string;
}[] = [];
(window as unknown as { __rpcLog?: unknown }).__rpcLog = rpcLog;
const hookLog: { id: string; name?: string; callId: number; ok: boolean; result?: unknown; error?: string }[] = [];
(window as unknown as { __logicHookLog?: unknown }).__logicHookLog = hookLog;

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
    setSubInput: (pluginId, opts) => action("setSubInput", { pluginId, opts }),
    subInputOwner: () => null,
    enterPlugin: (pluginId, info) => {
      // redirect：载荷交启动器路由（与分离窗口的 redirect 同形）
      action("redirect", { pluginId, code: info.code, payload: info.payload });
      return true;
    },
    detachMode: () => action("detach"),
    // `theme.set` / `theme.get` from the plugin's LOGIC (docs/ROADMAP_HISTORY.md #36). The
    // write goes to Rust like any other host call: this window's label
    // (`plugin-logic-host`) is not `main`, so the command also emits
    // `plugin-color-mode` and the launcher's mirror follows; the token keeps
    // the id attribution honest. `get` answers from this window's copy of the
    // same settings snapshot.
    setPluginColorMode: async (pluginId, mode) => {
      await invoke("set_plugin_color_mode", { id: pluginId, mode, hostToken: token });
      setPluginColorPref(pluginId, mode, "window");
    },
    pluginColorState: (pluginId) => {
      const host = resolveColorMode(hostColorSetting);
      return {
        pref: pluginColorPref(pluginId),
        mode: pluginColorMode(pluginId, host),
        host,
        skin: hostSkin,
        accent: hostAccent,
      };
    },
  };
}

/** supervisor 代理的文件读取：路径必须仍在本插件目录内（防跨插件读码），
 * 经 asset 协议 fetch（supervisor 页面具备 main 的取数能力）。 */
async function readPluginFile(id: string, entry: LogicEntry, rawPath: string): Promise<string> {
  const norm = rawPath.replace(/\//g, "\\").toLowerCase();
  const dir = entry.dir.replace(/\//g, "\\").toLowerCase();
  if (!(norm === dir || norm.startsWith(dir + "\\"))) {
    throw new Error("logic frame file read escaped the plugin directory");
  }
  return invoke<string>("plugin_logic_read_file", {
    id,
    token: entry.token,
    path: rawPath,
  });
}

async function loadPlugin(id: string, suppliedManifest?: PluginManifest) {
  if (entries.has(id)) return;
  let meta: { dir: string; entry: string; name: string; api: number; role: "service" | "logic" };
  try {
    if (suppliedManifest) {
      permissionManifests.set(id, suppliedManifest);
      meta = {
        dir: suppliedManifest.dir,
        entry: suppliedManifest.entry,
        name: suppliedManifest.name,
        api: suppliedManifest.api,
        role: suppliedManifest.kind === "mode" && suppliedManifest.pageRuntime &&
          suppliedManifest.presenters.length > 0 ? "service" : "logic",
      };
    } else {
      meta = await invoke<{ dir: string; entry: string; name: string; api: number; role: "service" | "logic" }>(
        "plugin_logic_meta",
        { id }
      );
    }
  } catch (err) {
    plog.error(id, "logic host: meta fetch failed:", err);
    return;
  }
  if (!meta.entry) return; // 纯视图模式无逻辑
  // API 版本二次校验（#32.1 防御纵深）：registry 门在前，这里兜底（如
  // 旧 main 窗口残留在发 load）。拒绝建帧，而非加载后行为怪异。
  if (meta.api !== HOST_PLUGIN_API) {
    plog.error(
      id,
      `logic host: manifest api=${meta.api} != host ${HOST_PLUGIN_API} — refusing`
    );
    return;
  }
  const token = crypto.randomUUID();
  const entry: LogicEntry = {
    token,
    role: meta.role,
    dir: meta.dir,
    entry: meta.entry,
    frame: undefined,
    messageHandler: undefined,
    loaded: false,
    calls: new Map(),
    callSeq: 0,
  };
  try {
    await invoke("plugin_logic_register_tokens", { entries: [{ id, token, role: meta.role }] });
  } catch (err) {
    plog.error(id, "logic host: token register failed:", err);
    return;
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", SANDBOX);
  frame.style.display = "none";
  frame.src = `pluginLogicFrame.html?plugin=${encodeURIComponent(id)}&role=${meta.role}`;
  document.getElementById("root")?.appendChild(frame);
  entry.frame = frame;
  entries.set(id, entry);
  const messageHandler = (e: MessageEvent) => onFrameMessage(id, entry, e);
  entry.messageHandler = messageHandler;
  window.addEventListener("message", messageHandler);
  messageListenerCount++;
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
        // 通知启动器：逻辑就绪（registry 解除"未就绪"快速失败并补投积压设置）。
        void invoke("plugin_logic_action", { token: entry.token, action: "logic-loaded", args: { hooks } }).catch(
          (err) => plog.error(id, "logic-loaded relay failed:", err)
        );
      },
      reject: (err) => plog.error(id, "logic load failed:", err),
      // 首次 load 要取多个模块文本再编译，比 hook 宽松；卡死同样清槽
      // （否则 entry.calls 泄漏且插件永远半死）。
      timer: window.setTimeout(() => {
        if (entry.calls.delete(callId)) {
          plog.error(id, "logic load timed out — frame stuck during module load");
        }
      }, 15_000),
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
    if (call.timer) window.clearTimeout(call.timer);
    if (call.kind === "load") {
      r.ok ? call.resolve?.(r.result) : call.reject?.(new Error(r.error ?? "logic load failed"));
    } else {
      hookLog.push({ id, name: call.name, callId: r.callId, ok: r.ok, result: r.result, error: r.error });
      if (hookLog.length > 80) hookLog.shift();
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
    rpcLog.push({ id, method: rpc.method, ok: true, resultType: "(recv)" });
    if (rpcLog.length > 80) rpcLog.shift();
    // CDP verify tap（同 __logicEntries 模式）：最近 80 条 rpc 的结果摘要。
    const rec = (ok: boolean, error?: string, result?: unknown) => {
      rpcLog.push({
        id,
        method: rpc.method,
        ok,
        error: error ? String(error).slice(0, 200) : undefined,
        resultType: result === undefined ? "undefined" : typeof result,
      });
      if (rpcLog.length > 80) rpcLog.shift();
    };
    /** JSON 往返：剥掉函数等不可结构化克隆值（http 响应的 text()/json()）——
     * 数据保留，函数由帧侧 wrapper 按需重建（pluginLogicFrame 就是这么设计的）。 */
    const jsonSafe = (v: unknown): unknown => {
      try {
        return JSON.parse(JSON.stringify(v ?? null));
      } catch {
        return null;
      }
    };
    const reply = (ok: boolean, result: unknown, error?: string) => {
      const msg = { __lumeRpcResult: { id: rpc.id, ok, result, error } };
      try {
        postTo(entry, msg);
        rec(ok, error, result);
        return;
      } catch {
        // 不可克隆（回归：http.request 成功也带函数）→ 剥离后重发，
        // 绝不当成失败——那会把可用的结果变成假错误。
      }
      msg.__lumeRpcResult.result = jsonSafe(result);
      try {
        postTo(entry, msg);
        rec(ok, error, msg.__lumeRpcResult.result);
      } catch (err2) {
        rec(false, `clone failed: ${err2}`);
        postTo(entry, { __lumeRpcResult: { id: rpc.id, ok: false, result: null, error: String(err2) } });
      }
    };
    if (rpc.method.startsWith("page.") || rpc.method.startsWith("secrets.")) {
      const serviceCall = async (): Promise<unknown> => {
        switch (rpc.method) {
          case "page.publish":
            return invoke("plugin_page_publish", { token: entry.token, model: rpc.args?.model });
          case "page.patch":
            throw new Error("page.patch is reserved; publish a full snapshot");
          case "page.emit":
            return invoke("plugin_page_emit", { token: entry.token, event: rpc.args?.event });
          case "page.error":
            return invoke("plugin_page_error", { token: entry.token, error: rpc.args?.error });
          case "page.clearError":
            return invoke("plugin_page_clear_error", { token: entry.token });
          case "secrets.has":
            return invoke("plugin_secret_service_has", { token: entry.token, key: String(rpc.args?.key ?? "") });
          case "secrets.get":
            return invoke("plugin_secret_service_get", { token: entry.token, key: String(rpc.args?.key ?? "") });
          default:
            throw new Error("unknown Page Service rpc: " + rpc.method);
        }
      };
      serviceCall().then((result) => reply(true, result)).catch((err) => reply(false, null, String(err)));
      return;
    }
    if (rpc.method === "__readPluginFile") {
      readPluginFile(id, entry, String(rpc.args?.path ?? ""))
        .then((text) => reply(true, text))
        .catch((err) => reply(false, null, String(err)));
      return;
    }
    // execHostRpc 也会同步抛（未知方法名以外的意外）——记录并回执，
    // 否则帧侧挂到 30s 超时、诊断时看不见任何痕迹。
    try {
      execHostRpc(id, rpc.method, rpc.args ?? {}, makeServices(id, entry.token), entry.token)
        .then((result) => reply(true, result))
        .catch((err) => reply(false, null, String(err)));
    } catch (err) {
      reply(false, null, `sync throw: ${String(err)}`);
    }
  }
}

async function unloadPlugin(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry) return;
  if (entry.messageHandler) {
    window.removeEventListener("message", entry.messageHandler);
    messageListenerCount = Math.max(0, messageListenerCount - 1);
  }
  const cancellations: Promise<unknown>[] = [];
  for (const [callId, call] of entry.calls) {
    if (call.timer) window.clearTimeout(call.timer);
    if (call.kind === "load") {
      call.reject?.(new Error(`logic unloaded during load: ${id}`));
    } else {
      cancellations.push(
        invoke("plugin_logic_result", {
          token: entry.token,
          callId,
          ok: false,
          result: null,
          error: `logic unloaded: ${id}`,
        }).catch(() => undefined)
      );
    }
  }
  entry.calls.clear();
  entry.frame?.remove();
  entries.delete(id);
  await Promise.allSettled(cancellations);
  // 令牌表清空该插件（Rust 侧 drop）
  await invoke("plugin_logic_register_tokens", { entries: [{ id, token: null, role: "logic" }] }).catch(() => {});
}

/** Serialize per-plugin lifecycle work. Rust relays `unload` and `load` as
 * separate events; without this queue the new token could be registered
 * before the old unload's token-drop landed, which would immediately revoke
 * the fresh iframe. */
const lifecycleQueues = new Map<string, Promise<void>>();
function queueLifecycle(id: string, task: () => Promise<void>): void {
  const previous = lifecycleQueues.get(id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .catch((err) => plog.error(id, "logic lifecycle failed:", err));
  lifecycleQueues.set(id, next);
  void next.finally(() => {
    if (lifecycleQueues.get(id) === next) lifecycleQueues.delete(id);
  });
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
  // 帧内卡死（死循环/未捕获异常）→ 主动回执失败。6s 先于 registry 的 8s
  // 超时到达：调用方拿到的是明确的 "logic hook timeout"（计入熔断）而不是
  // 泛化的 logic call timeout——帧真死了就该熔断，重载竞态由 unload await 消除。
  const HOOK_TIMEOUT_MS = 6_000;
  const timer = window.setTimeout(() => {
    entry.calls.delete(payload.callId);
    // 帧内卡死（死循环/未捕获异常）→ 主动回执失败，registry 侧按普通
    // 失败处理（计入熔断），无需等它自己的 8s 超时。
    void invoke("plugin_logic_result", {
      token: entry.token,
      callId: payload.callId,
      ok: false,
      result: null,
      error: `logic hook timeout after ${HOOK_TIMEOUT_MS}ms: ${payload.name}`,
    }).catch(() => {});
  }, HOOK_TIMEOUT_MS);
  entry.calls.set(payload.callId, { kind: "hook", name: payload.name, timer });
  postTo(entry, {
    __lumeCall: {
      callId: payload.callId,
      type: "hook",
      payload: { name: payload.name, args: payload.args },
    },
  });
}

async function refreshPermissionSource(): Promise<void> {
  const list = await invoke<PluginManifest[]>("get_plugins");
  permissionManifests.clear();
  for (const manifest of list) permissionManifests.set(manifest.id, manifest);
  setPermissionSource((pid: string) => list.find((x) => x.id === pid));
}

async function refreshHostSettings(): Promise<void> {
  try {
    const settings = await invoke<SettingsData>("get_settings");
    hostColorSetting = settings.appearance?.color_mode ?? "system";
    hostSkin = normalizeSkin(settings.appearance?.skin);
    hostAccent = normalizeAccent(settings.appearance?.accent);
    seedPluginColorPrefs(settings.plugins?.color_modes);
  } catch (err) {
    plog.error(null, "logic host: settings refresh failed:", err);
  }
}

async function start() {
  // 权限源必须在任何 iframe 执行前就绪；settings-applied / plugin-reload /
  // 每次 load 都会重新读取磁盘清单，避免安装或编辑权限后必须重启进程。
  try {
    await refreshPermissionSource();
  } catch (err) {
    plog.error(null, "logic host: permission source wire failed:", err);
  }

  const unlisteners: UnlistenFn[] = [];
  unlisteners.push(
    await listen("settings-applied", () => {
      void Promise.allSettled([refreshHostSettings(), refreshPermissionSource()]);
    })
  );
  unlisteners.push(
    await listen<string>("plugin-reload", () => {
      void refreshPermissionSource().catch((err) =>
        plog.error(null, "logic host: reload permission refresh failed:", err)
      );
    })
  );
  unlisteners.push(
    await listen<{ id: string; kind: string; payload: Record<string, unknown> }>(
      "plugin-logic-event",
      (e) => {
        const { id, kind, payload } = e.payload;
        if (kind === "load") {
          const manifest = (payload as { manifest?: PluginManifest }).manifest;
          queueLifecycle(id, () => loadPlugin(id, manifest));
        } else if (kind === "unload") {
          queueLifecycle(id, () => unloadPlugin(id));
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
