//! The plugin registry — where launcher capabilities plug in.
//!
//! The composition root creates the shared `PluginServices`, then each
//! first-party module registers itself: `definePlugin(clipboardPlugin)`,
//! `definePlugin(previewPlugin)`. Modes are created eagerly (their signals
//! must exist inside the component's reactive owner); the enabled set comes
//! from the Rust `get_plugins` command (`settings.plugins.disabled`) and is
//! refreshed on `settings-applied`. Disabled mode plugins vanish from the
//! mode pills and Tab cycling; a disabled preview plugin never opens the
//! satellite.

import { createSignal } from "solid-js";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FeatureEnterInfo, ForegroundInfo, LauncherPlugin, ModeId, ModeInstance, NavBarContribution, PluginFeature, PluginManifest, PluginServices, ProviderInstance, ProviderResult } from "./types";
import { HOST_PLUGIN_API } from "./types";
import { capSnapshot, createIframeView, injectBridge } from "./iframeBridge";
import { createListTemplateMode } from "./listTemplate";
import { fetchDiskFile } from "./disk";
import { execHostRpc as execHostRpcShared } from "./rpc";
import { plog } from "./log";
import { setPermissionSource } from "./permissions";
import { currentThemeMode } from "../theme";
import { t } from "../i18n";
export {
  APPS_MODE,
  type LauncherPlugin,
  type ModeId,
  type ModeInstance,
  type PluginManifest,
  type PluginServices,
} from "./types";

const plugins: LauncherPlugin[] = [];
const [manifests, setManifests] = createSignal<PluginManifest[]>([]);

/** Register a plugin. Call once per plugin at composition time. */
export function definePlugin(plugin: LauncherPlugin) {
  plog.debug(plugin.id, "register:", [
    plugin.mode && "mode",
    plugin.provider && "provider",
    plugin.preview && "preview",
    plugin.lifecycle && "lifecycle",
    plugin.navBars && "navBars",
  ]
    .filter(Boolean)
    .join("/"));
  plugins.push(plugin);
}

/** Refresh manifests (builtin + disk) + enabled state from the backend, then
 * load any newly discovered disk plugins. */
export async function refreshPlugins() {
  try {
    // 保存设置 = 用户出手干预：熔断状态整体复位（#32.4；用户可能刚改过
    // 出问题插件的配置或做了重载）。
    logicFailCounts.clear();
    logicOffline.clear();
    const list = await invoke<PluginManifest[]>("get_plugins");
    plog.info(
      null,
      `manifests refreshed: ${list.length} (builtin ${list.filter((m) => m.builtin).length}, ` +
        `disk ${list.filter((m) => !m.builtin).length})`
    );
    for (const m of list) {
      plog.debug(
        m.id,
        `manifest: kind=${m.kind} enabled=${m.enabled} builtin=${m.builtin}` +
          (m.entry ? ` entry=${m.entry}` : "") +
          (m.view ? ` view=${m.view}` : "") +
          (m.keywords.length ? ` keywords=[${m.keywords.join(",")}]` : "")
      );
    }
    setManifests(list);
    await loadDiskPlugins();
  } catch (err) {
    plog.error(null, "get_plugins failed — keeping previous state:", err);
  }
}

function isEnabled(id: string): boolean {
  const m = manifests().find((x) => x.id === id);
  return m ? m.enabled : true; // unknown → enabled (fail-open, like built-ins pre-list)
}

/** All registered plugins (enabled or not). */
export function allPlugins(): LauncherPlugin[] {
  return plugins;
}

/** Enabled provider instances (contributed by registered and disk plugins). */
export function providerPlugins(): { id: string; instance: ProviderInstance }[] {
  return plugins
    .filter((p) => p.provider && isEnabled(p.id))
    .map((p) => ({ id: p.id, instance: p.provider! }));
}

// ── Third-party JS plugin loading (v2: provider / mode / service) ──
//
// A disk plugin's entry is a standard ES Module. Its default export is either
// a plain object (legacy provider form: `{ search }`) or a **factory**
// `create(ctx)` receiving the host capability API (`PluginHostApi`) and
// returning the logic object. `kind` picks the contribution:
// - provider: `{ search(query) → [{name, path}] }` — appended to Navigate results
// - mode:     optional hooks + a `view` HTML page rendered in a bridged iframe
// - service:  headless lifecycle hooks `{ onShow, onHide, onQuery }`
//
// Executing third-party JS is arbitrary code in this webview: the user opts
// in by placing the plugin in plugins/ (the `permissions` manifest field is
// reserved for a future enforcement layer). The mode view iframe is
// same-origin (srcdoc) — no sandbox beyond that trust decision.
const loadedDiskIds = new Set<string>();
/** Ids that this module actually registered into `plugins` (disk loads only)
 * — unload removes exactly these, never a built-in that happens to share an
 * id with a disk manifest. */
const registeredDiskIds = new Set<string>();
let pluginServices: PluginServices | null = null;

/** Wire the composition-root services (the host API needs them). Call once
 * before the first refreshPlugins(). */
export function setPluginServices(services: PluginServices) {
  pluginServices = services;
}

// ── 逻辑宿主中继（P6.5 进程隔离）──
//
// entry 插件的逻辑不再 import() 进本窗口：registry 只注册**代理贡献**，hook
// 调用经 `plugin_logic_push`（Rust emit 到共享逻辑宿主窗口）→ supervisor →
// 沙箱 iframe 内的真实模块；回执经 `plugin-logic-result` 事件按 callId 收口。
// ctx 的启动器侧动作（toast/setQuery/hide/redirect…）经
// `plugin-logic-action` 事件回来（Rust 已按令牌强制归属 plugin id）。
// 宿主窗口就绪/崩溃通告驱动 load 的（重）发——覆盖建窗竞态与崩溃恢复。

const logicPending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
let logicCallSeq = 0;
/** 已向宿主发过 load 的插件（宿主 ready 时重发；unload 时移除）。 */
const logicLoadedIds = new Set<string>();

// ── 插件熔断（#32.4）──
//
// 共享逻辑宿主 = 共享故障域：一个插件死循环/连续超时会把同窗所有插件的
// 调用拖慢。连续 3 次失败（超时 / push 失败 / ok:false 回执）→ 标记离线：
// 后续调用立即快速失败（调用点既有 catch 路径天然降级为空结果），load 不再
// 重发。恢复：重载插件 / 保存设置（refreshPlugins）清标记。其余插件不受影响。

const CIRCUIT_THRESHOLD = 3;
const logicFailCounts = new Map<string, number>();
const logicOffline = new Set<string>();
/** 24 条失败原因环形缓冲（CDP 诊断；`__logicCircuit.log`）。 */
const circuitLog: { id: string; why: string; at: number }[] = [];

// 已注册但逻辑帧未就绪的插件（首载 + 重载窗口）。此时宿主侧 entry 可能
// 尚不存在（hook 被静默丢弃 → 8s 超时），或被 post 给正在销毁的旧帧——
// 两条路都会把正常注册流程误判成插件故障。逻辑就绪信号（supervisor 的
// logic-loaded action）到达前，hook 一律快速失败（"logic not loaded" 前缀，
// 不计熔断）。
const logicPendingReady = new Set<string>();

function noteLogicFailure(id: string, why: string): void {
  if (logicOffline.has(id)) return;
  circuitLog.push({ id, why, at: Date.now() });
  if (circuitLog.length > 24) circuitLog.shift();
  const n = (logicFailCounts.get(id) ?? 0) + 1;
  logicFailCounts.set(id, n);
  if (n < CIRCUIT_THRESHOLD) return;
  logicOffline.add(id);
  plog.error(id, `circuit open after ${n} consecutive failures (${why}) — plugin paused`);
  const m = manifests().find((x) => x.id === id);
  pluginServices?.showToast(t("pluginCircuitOpen", { name: m?.name || id }));
}

function noteLogicSuccess(id: string): void {
  logicFailCounts.delete(id);
}

/** 清一个插件的熔断状态（重载/重启加载时调用）。 */
function resetCircuit(id: string): void {
  logicFailCounts.delete(id);
  logicOffline.delete(id);
}

// CDP verify tap（同 __logicEntries/__pluginStates 模式）
(window as unknown as { __logicCircuit?: unknown }).__logicCircuit = {
  failCounts: logicFailCounts,
  offline: logicOffline,
  log: circuitLog,
};

/** 一次 hook 调用：跨窗口 RPC，8s 超时（与桥接 10s 语义对齐、略短）。 */
function logicCall(id: string, name: string, args: unknown[], timeoutMs = 8000): Promise<unknown> {
  // 熔断打开：快速失败（不是静默——调用点会打日志/降级空结果）。
  if (logicOffline.has(id)) {
    plog.debug(id, `call skipped (circuit open): ${name}`);
    return Promise.reject(new Error(`plugin "${id}" is offline (circuit open — reload it to retry)`));
  }
  // 逻辑帧未就绪（首载/重载窗口）：同样快速失败，但用 "logic not loaded"
  // 前缀——不是插件故障，不计熔断（宿主 side 的丢包是注册时序，不是它的错）。
  if (logicPendingReady.has(id)) {
    return Promise.reject(new Error(`logic not loaded for "${id}"`));
  }
  const callId = ++logicCallSeq;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      logicPending.delete(callId);
      noteLogicFailure(id, `timeout: ${name}`);
      reject(new Error(`logic call timeout: ${id}.${name}`));
    }, timeoutMs);
    logicPending.set(callId, {
      resolve: (v) => {
        window.clearTimeout(timer);
        noteLogicSuccess(id);
        resolve(v);
      },
      reject: (e) => {
        window.clearTimeout(timer);
        reject(e);
      },
    });
    void invoke("plugin_logic_push", { id, kind: "hook", payload: { callId, name, args } }).catch(
      (err) => {
        window.clearTimeout(timer);
        logicPending.delete(callId);
        noteLogicFailure(id, `push failed: ${name}`);
        reject(err);
      }
    );
  });
}

/** 建窗（幂等）+ 发一次 load 指令。supervisor 未就绪时 load 会丢失——由
 * `plugin-logic-host-ready` 通告驱动重发兜底。熔断打开的插件不再重发
 * （#32.4：保持暂停直到重载/保存设置）。 */
function pushLogicLoad(id: string): void {
  if (logicOffline.has(id)) return;
  logicPendingReady.add(id); // 帧就绪信号（logic-loaded）到达前 hook 快速失败
  logicLoadedIds.add(id);
  void invoke("plugin_logic_host_ensure")
    .then(() => invoke("plugin_logic_push", { id, kind: "load", payload: {} }))
    .catch((err) => plog.error(id, "logic load push failed:", err));
}

// ── 高频 hook 的跨进程节流（#32.5）──
//
// onQuery / onSubInput 随每次键击跨 3 个进程（主窗 → Rust 中继 → 逻辑宿主
// iframe，3-10ms/次），打字快时是事件风暴。trailing 合并：窗口内后到的值
// 覆盖先到的，一个窗口只发一次——插件收到的仍是"最新输入"，API 语义不变。

const THROTTLE_MS = 120;
const throttledCalls = new Map<string, { timer: number; args: unknown[] }>();

/** fire-and-forget 的节流版 logicCall：仅用于高频、无返回值消费的 hook。 */
export function throttledLogicCall(
  id: string,
  name: string,
  args: unknown[],
  ms = THROTTLE_MS
): void {
  const key = `${id}\u0000${name}`;
  const existing = throttledCalls.get(key);
  if (existing) {
    existing.args = args; // 窗口内只留最新值，到点发一次
    return;
  }
  const slot: { timer: number; args: unknown[] } = { timer: 0, args };
  throttledCalls.set(key, slot);
  slot.timer = window.setTimeout(() => {
    throttledCalls.delete(key);
    void logicCall(id, name, slot.args).catch(() => {});
  }, ms);
}

/** 卸载/重载时丢弃未发送的高频 hook——插件已不在，迟到调用只会白报错误。 */
function clearThrottledCalls(id: string): void {
  for (const [key, slot] of throttledCalls) {
    if (key.startsWith(id + "\u0000")) {
      window.clearTimeout(slot.timer);
      throttledCalls.delete(key);
    }
  }
}

/** ctx 动作分发（Rust 中继已按令牌归属 id）。 */
function handleLogicAction(id: string, action: string, args: Record<string, unknown>): void {
  const services = pluginServices;
  if (!services) return;
  switch (action) {
    case "toast":
      services.showToast(String(args.text ?? ""));
      break;
    case "setQuery":
      services.setQuery(String(args.q ?? ""));
      break;
    case "hide":
      services.resetAndHide();
      break;
    case "markEntryOpened":
      services.markEntryOpened();
      break;
    case "redirect":
      services.enterPlugin(String(args.pluginId ?? ""), {
        code: String(args.code ?? ""),
        type: "redirect",
        payload: String(args.payload ?? ""),
      });
      break;
    case "logic-loaded":
      // 逻辑帧就绪：解除"未就绪"快速失败 + 补投 load 前积压的声明式设置
      // （applyPluginSettings 的首投可能早于逻辑就绪而落空）。
      {
        logicPendingReady.delete(id);
        const values = pendingLogicSettings.get(id);
        if (values) {
          pendingLogicSettings.delete(id);
          const p = plugins.find((x) => x.id === id);
          try {
            p?.mode?.onSettings?.(values);
            p?.provider?.onSettings?.(values);
            p?.lifecycle?.onSettings?.(values);
          } catch (err) {
            plog.error(id, "deferred onSettings failed:", err);
          }
        }
      }
      break;
    default:
      plog.debug(id, "logic action ignored:", action);
  }
}

/** load 前积压的声明式设置（applyPluginSettings 首投落空时暂存）。 */
const pendingLogicSettings = new Map<string, Record<string, unknown>>();

/** 宿主窗口崩溃恢复：整窗重建后重发全部 load；10s 内二次崩溃 → 停止。 */
let logicHostCrashAt = 0;
function onLogicHostCrashed(): void {
  const now = Date.now();
  plog.error(null, "logic host window destroyed — rebuilding");
  if (now - logicHostCrashAt < 10000) {
    for (const id of logicLoadedIds) plog.error(id, "logic host keeps crashing — giving up this round");
    return;
  }
  logicHostCrashAt = now;
  for (const id of logicLoadedIds) pushLogicLoad(id);
}

let logicRelayWired = false;
/** 事件接线（main 窗口单例；模块导入即生效，双注册有旗标防呆）。 */
function initLogicRelay(): void {
  if (logicRelayWired) return;
  logicRelayWired = true;
  void listen<{ id: string; callId: number; ok: boolean; result?: unknown; error?: string }>(
    "plugin-logic-result",
    (e) => {
      const { id, callId, ok, result, error } = e.payload;
      const p = logicPending.get(callId);
      if (p) {
        logicPending.delete(callId);
        if (ok) {
          noteLogicSuccess(id);
          p.resolve(result);
        } else {
          // "未就绪"不是插件故障（load 在途时的高频 hook 会短暂命中）——
          // 不计入熔断，否则启动瞬间就会误打开断路器。
          const notReady = typeof error === "string" && error.startsWith("logic not loaded");
          if (!notReady) noteLogicFailure(id, error ?? "hook failed");
          p.reject(new Error(error ?? "logic call failed"));
        }
      }
    }
  );
  void listen<{ id: string; action: string; args: Record<string, unknown> }>(
    "plugin-logic-action",
    (e) => handleLogicAction(e.payload.id, e.payload.action, e.payload.args)
  );
  void listen("plugin-logic-host-ready", () => {
    // supervisor 就绪（建窗竞态 / 崩溃恢复）→ 重发全部 load
    for (const id of logicLoadedIds) pushLogicLoad(id);
  });
  void listen("plugin-logic-host-closed", () => onLogicHostCrashed());
}
initLogicRelay();

/** 代理逻辑对象：任意 hook 名都是跨窗口调用（帧内缺名时安全返回
 * undefined，调用点按可选项语义处理）。 */
function logicProxy(id: string): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get: (_t, prop) => {
      if (typeof prop !== "string") return undefined;
      return (...args: unknown[]) => logicCall(id, prop, args);
    },
  });
}


export function callHook(id: string, logic: Record<string, unknown>, name: string, ...args: unknown[]) {
  const fn = logic[name];
  if (typeof fn === "function") {
    try {
      return (fn as (...a: unknown[]) => unknown)(...args);
    } catch (err) {
      plog.error(id, `hook ${name} failed:`, err);
    }
  }
  return undefined;
}

/** data:/http(s):/asset:/blob: URIs pass through untouched; anything else in
 * an item's `icon` is a file path (absolute, or relative to `base` — a
 * manifest icon is relative to the plugin dir) → asset URL. */
function resolvePluginIcon(icon: unknown, base?: string): string | undefined {
  if (typeof icon !== "string" || icon === "") return undefined;
  if (/^(data:|https?:|asset:|blob:)/i.test(icon)) return icon;
  if (base && !/^(?:[A-Za-z]:[\\/]|\\\\)/.test(icon)) {
    return convertFileSrc(base + "\\" + icon);
  }
  return convertFileSrc(icon);
}

/** Validate + normalize a plugin's `navBars()` return: prefix bar ids with
 * the plugin id (the zone-key namespace), resolve icons, cap items per bar.
 * Malformed bars/entries are dropped with a console error. */
function normalizeNavBarContributions(pluginId: string, raw: unknown): NavBarContribution[] {
  if (!Array.isArray(raw)) return [];
  const out: NavBarContribution[] = [];
  for (const bar of raw) {
    const b = bar as { id?: unknown; title?: unknown; items?: unknown } | null;
    if (
      !b ||
      typeof b.id !== "string" ||
      b.id === "" ||
      typeof b.title !== "string" ||
      !Array.isArray(b.items)
    ) {
      plog.error(pluginId, "bad navBars entry (dropped):", b);
      continue;
    }
    const items = b.items
      .slice(0, 50) // keep the bar grid sane, like the provider result cap
      .filter((it): it is { name: string; path: string; icon?: string } => {
        const x = it as { name?: unknown; path?: unknown; icon?: unknown } | null;
        return (
          !!x &&
          typeof x.name === "string" &&
          typeof x.path === "string" &&
          (x.icon === undefined || typeof x.icon === "string")
        );
      })
      .map((it) => ({ name: it.name, path: it.path, icon: resolvePluginIcon(it.icon) }));
    out.push({ id: `${pluginId}:${b.id}`, title: b.title, items });
  }
  return out;
}

/** The plugin's optional `navBars` hook as a LauncherPlugin contribution —
 * undefined when the logic object doesn't provide one. */
function navBarsContribution(
  pluginId: string,
  logic: Record<string, unknown>
): (() => Promise<NavBarContribution[]> | NavBarContribution[]) | undefined {
  if (typeof logic.navBars !== "function") return undefined;
  return () => {
    try {
      return Promise.resolve(
        normalizeNavBarContributions(
          pluginId,
          (logic.navBars as () => unknown)()
        )
      );
    } catch (err) {
      console.error("[plugins] navBars failed:", pluginId, err);
      return Promise.resolve([]);
    }
  };
}

// ── Capability permissions (P3.2) ──
//
// The ledger, the fail-closed check and the guard that applies it to every
// host API live in `permissions.ts`; this module only wires the manifest
// lookup the check consults (the manifests signal is owned here). The guard
// runs inside `createHostApi`, so both paths a disk plugin has — its logic in
// this window and its mode page over the bridge — are covered.
setPermissionSource((id) => manifests().find((x) => x.id === id));

/** Route a bridge RPC ("app.hide" / "storage.get" / …) to the host API.
 * The router lives in `rpc.ts` so a detached plugin window can answer the
 * same bridge traffic for its own page. */
async function execHostRpc(
  id: string,
  method: string,
  args: Record<string, unknown>
): Promise<unknown> {
  return execHostRpcShared(id, method, args, pluginServices!);
}

/** Build the ModeInstance for a disk mode plugin (bridged iframe UI). */
function createDiskModeInstance(
  m: PluginManifest,
  logic: Record<string, unknown>,
  services: PluginServices
): ModeInstance {
  const [query, setQuerySig] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const hook = (name: string, ...args: unknown[]) => callHook(m.id, logic, name, ...args);
  // How this page was entered (`[[features]]` payload / redirect). Kept until
  // the mode resets and REPLAYED on every ready handshake: the View mounts
  // (and the srcdoc document loads) only when the mode becomes active, so an
  // enter delivered while the document is still loading would be lost — and
  // a fresh document needs the payload again the way it needs query/show.
  let enterPayload: FeatureEnterInfo | null = null;
  // Declarative settings (P3.4) delivered to this page. Kept so the ready
  // handshake can replay them: the pane may change a value while the mode is
  // not active (the srcdoc document doesn't exist yet), and a fresh document
  // needs the current values again.
  let settingsValues: Record<string, unknown> | null = null;
  // Detached-window state pusher (P6): while the page lives in its own
  // window, this window's iframe is unmounted — page state travels over the
  // Rust `plugin-window` event channel instead of postMessage.
  detachedSuppliers.set(m.id, {
    push: (show, includeSnapshot = false) => {
      // Detach 快照（P6.5）：detachMode 在开窗前从本页取走的状态，只在
      // ready 握手的那次推送里带过去（取出即删）。shown 事件的推送发生在
      // 建窗瞬间（页面尚未加载），绝不能消费快照 —— 否则独立窗口永远收
      // 不到它。
      let pending: { view?: unknown } | undefined;
      if (includeSnapshot) {
        pending = pendingSnapshots.get(m.id);
        pendingSnapshots.delete(m.id);
      }
      void invoke("plugin_window_push_state", {
        id: m.id,
        state: {
          show,
          query: query(),
          enter: enterPayload,
          settings: settingsValues,
          theme: currentThemeMode(),
          ...(pending?.view ? { snapshot: pending.view } : {}),
        },
      }).catch((err) => plog.error(m.id, "detached state push failed:", err));
    },
    pushTheme: (t) => {
      void invoke("plugin_window_push_state", { id: m.id, state: { theme: t } }).catch((err) =>
        plog.error(m.id, "detached theme push failed:", err)
      );
    },
    onShow: () => hook("onShow"),
  });
  // Theme replays (P5 sandbox follow-up): the opaque iframe cannot read the
  // launcher document, so the host pushes the color mode — on the ready
  // handshake below and on every `data-theme` flip (see the observer at the
  // bottom of this module).
  themePosters.set(m.id, (t) => {
    if (viewReady) postEv("theme", t);
  });
  // 状态快照（P6.5）：独立窗口关闭时页面可能仍挂载（搜索记忆保留住了 mode），
  // 此时 restore 直接投进活 iframe；否则存入 attachSnapshots，由下一次 ready
  // 握手消费。判定用 live()（当前文档的桥是否活着）而不是 viewReady（那只
  // 表示 view HTML 已取回、一次性为 true）——页面未挂载时 poster 返回 false，
  // 调用方据此落到 ready 握手路径。
  directPosters.set(m.id, (type, payload) => {
    if (!viewLive()) return false;
    postEv(type, payload);
    return true;
  });
  const { View, post, snapshot: viewSnapshot, live: viewLive } = createIframeView(
    (method, args) => execHostRpc(m.id, method, args),
    () => {
      // The page's bridge is live and its handlers are assigned: push the
      // current state (this also covers the initial load, where the loader
      // raced the srcdoc document).
      postEv("query", query());
      postEv("show");
      postEv("theme", currentThemeMode());
      if (enterPayload) postEv("enter", enterPayload);
      if (settingsValues) postEv("settings", settingsValues);
      // Attach-back restore (P6.5): the detached window's final page state,
      // consumed once on the first ready after its close.
      const att = attachSnapshots.get(m.id);
      if (att) {
        attachSnapshots.delete(m.id);
        // CDP verify tap
        ((window as unknown as { __snapConsume?: unknown[] }).__snapConsume ??= []).push({
          id: m.id,
          hadView: !!att.view,
        });
        if (att.view) postEv("restore", att.view);
      }
    },
    { id: m.id }
  );
  // Events (query/show/hide) mirror into the plugin log so a silent page is
  // distinguishable from one that never received anything.
  const postEv = (type: string, payload?: unknown) => {
    plog.debug(m.id, `event → ${type}`, payload ?? "");
    post(type, payload);
  };
  let viewReady = false;

  // Fetch + bridge the view page, then mark ready and deliver the current
  // query (the page may already have assigned lume.on.query).
  plog.info(m.id, "mode view fetching:", m.view);
  void fetchDiskFile(m.dir + "\\" + m.view)
    .then((html) => {
      plog.info(m.id, "mode view ready (html", html.length, "bytes)");
      viewReady = true;
      View.setHtml(injectBridge(html));
      // query/show are NOT posted here: setting the srcdoc only starts the
      // document load, so the bridge has no listener yet. The ready handshake
      // (see the onReady callback above) delivers the page state once live.
    })
    .catch((err) => {
      plog.error(m.id, "view load failed:", err);
      View.setHtml(
        `<body style="font:13px sans-serif;color:#f66;padding:16px">plugin view load failed: ${String(
          err
        )}</body>`
      );
    });

  return {
    query,
    setQuery: (q) => {
      setQuerySig(q);
      if (viewReady) postEv("query", q);
      throttledLogicCall(m.id, "onQuery", [q]);
    },
    search: async (q) => {
      if (viewReady) postEv("query", q);
      throttledLogicCall(m.id, "onQuery", [q]);
      // ModeInstance contract: every search ends with a resize request —
      // without it the window keeps the previous page's size after a mode
      // switch (the fixed-height model differs per mode).
      services.scheduleResize();
    },
    reset: () => {
      setSelected(0);
      // A fresh summon starts a new page state — the previous entry payload
      // no longer describes how this round began.
      enterPayload = null;
      if (viewReady) postEv("show");
      hook("onShow");
      services.scheduleResize();
    },
    selected,
    setSelected,
    rows: () => [],
    activate: () => {},
    onKey: (e) => {
      // Forward every key to the iframe (`lume.on.key`) — plugin pages
      // implement their own arrow/Enter handling. Never consumed: rows() is
      // empty, so the root's own grid bindings are no-ops anyway.
      if (viewReady) {
        post("key", {
          key: e.key,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
        });
      }
      return false;
    },
    onEscape: () => false,
    previewTarget: () => null,
    previewEnabled: () => false,
    measureViewport: () => {},
    // Loading gate: the page area stays hidden (window collapsed to the search
    // row, pill spinner) until THIS document's bridge is live — a remount
    // reloads the srcdoc and flips it back to false.
    ready: viewLive,
    // Manifest `height` — the mode's preferred fixed window height.
    desiredHeight: () => (m.height != null && m.height > 0 ? m.height : null),
    pageKind: () => "main",
    restorePage: () => {},
    applySettings: () => {},
    // Detach/attach hand-off (P6.5): ask the page for its state snapshot.
    snapshot: () => viewSnapshot(),
    onHide: () => {
      if (viewReady) postEv("hide");
      hook("onHide");
    },
    onEnter: (info) => {
      enterPayload = info;
      if (detachedIds.has(m.id)) {
        // The page lives in its own window — the payload travels over the
        // event channel (the in-launcher iframe is not mounted).
        detachedSuppliers.get(m.id)?.push(false);
      }
      if (viewReady) postEv("enter", info);
      hook("onEnter", info);
    },
    onSubInput: (text) => {
      if (viewReady) postEv("subInput", text);
      throttledLogicCall(m.id, "onSubInput", [text]);
    },
    onSettings: (values) => {
      settingsValues = values;
      if (detachedIds.has(m.id)) detachedSuppliers.get(m.id)?.push(false);
      if (viewReady) postEv("settings", values);
      hook("onSettings", values);
    },
    View,
  };
}

/** Unload one disk plugin's contributions (hot reload, P0.3): drop its
 * registrations, forget its load attempt and clear the module cache so a
 * re-import re-reads the code from disk. (The cache is global — already-
 * imported modules of other plugins stay alive; only future loads recompile.)
 * Returns false when the id was never loaded from disk. */
export async function unloadDiskPlugin(id: string): Promise<boolean> {
  if (!registeredDiskIds.has(id)) return false;
  registeredDiskIds.delete(id);
  loadedDiskIds.delete(id);
  for (let i = plugins.length - 1; i >= 0; i--) {
    if (plugins[i].id === id) plugins.splice(i, 1);
  }
  logicLoadedIds.delete(id);
  clearThrottledCalls(id);
  resetCircuit(id); // 重载 = 重新开始：熔断状态不跨代（#32.4）
  // 重载窗口 = 未就绪：帧已拆、新帧未起，期间的 hook 快速失败（不计熔断）。
  logicPendingReady.add(id);
  // await 而非 fire-and-forget：宿主必须先把帧拆掉再放行后续注册流程——
  // 否则紧随其后的 navBars/onSettings 拉取可能被 post 到正在销毁的旧帧
  // （无回执 → 8s 超时 → 重载把插件误判进熔断）。
  await invoke("plugin_logic_push", { id, kind: "unload", payload: {} }).catch(() => {});
  pendingLogicSettings.delete(id);
  detachedSuppliers.delete(id);
  themePosters.delete(id);
  pendingSnapshots.delete(id);
  attachSnapshots.delete(id);
  directPosters.delete(id);
  return true;
}

/** Hot-reload one disk plugin (settings-pane 重载 button → `plugin-reload`
 * event). Re-reads manifests so manifest edits apply too; unknown ids are
 * reported back as false. */
export async function reloadDiskPlugin(id: string): Promise<boolean> {
  const had = await unloadDiskPlugin(id);
  // Re-read manifests first: a renamed/removed plugin must not be resurrected
  // from a stale manifest list, and new keywords/features need a fresh read.
  try {
    setManifests(await invoke<PluginManifest[]>("get_plugins"));
  } catch (err) {
    plog.error(null, "reload: get_plugins failed:", err);
  }
  await loadDiskPlugins();
  return had;
}

/** Load every not-yet-loaded, enabled disk plugin from the manifests.
 * Manifests flagged `development` are unloaded first, so editing their code
 * takes effect on the next refresh (settings-applied) without a restart. */
export async function loadDiskPlugins() {
  const services = pluginServices;
  let loadedAny = false;
  for (const m of manifests()) {
    if (m.builtin || !m.enabled || !m.dir) {
      plog.debug(
        m.id,
        "skip load:",
        m.builtin ? "builtin" : !m.enabled ? "disabled in settings" : "no dir"
      );
      continue;
    }
    // API 版本门（#32.1）：清单声明的版本超过宿主支持 → 明确停用 + 提示，
    // 而不是加载后行为怪异（§11 兼容性：低版本/缺省照常加载）。
    if (m.api > HOST_PLUGIN_API) {
      plog.error(m.id, `manifest api=${m.api} > host ${HOST_PLUGIN_API} — refusing to load`);
      services?.showToast(
        t("pluginApiMismatch", {
          name: m.name || m.id,
          api: String(m.api),
          host: String(HOST_PLUGIN_API),
        })
      );
      continue;
    }
    if (m.development) await unloadDiskPlugin(m.id);
    if (loadedDiskIds.has(m.id)) {
      plog.debug(m.id, "skip load: already loaded this session");
      continue;
    }
    loadedDiskIds.add(m.id); // mark regardless of outcome — never retry-spam
    try {
      if (m.kind === "provider" && m.entry) {
        // P6.5：逻辑在共享宿主窗口的沙箱 iframe 里 —— 这里只注册代理贡献。
        // 帧内未实现/未就绪的 hook 安全返回 undefined（search → 空结果）。
        // pushLogicLoad 先于任何 hook 拉取（navBarsContribution）：未就绪窗口
        // 内的调用走 registry 的快速失败，而不是被宿主静默丢弃后拖满 8s。
        pushLogicLoad(m.id);
        const proxy = logicProxy(m.id);
        const navBars = navBarsContribution(m.id, proxy);
        definePlugin({
          id: m.id,
          features: m.features ?? [],
          dir: m.dir,
          provider: {
            search: async (q) => {
              const rows = await logicCall(m.id, "search", [q]).catch((err) => {
                plog.error(m.id, "provider search failed:", err);
                return undefined;
              });
              return Array.isArray(rows) ? rows : [];
            },
            onEnter: (item: ProviderResult) =>
              void logicCall(m.id, "onEnter", [item]).catch((err) =>
                plog.error(m.id, "provider onEnter failed:", err)
              ),
            onFeature: (info: FeatureEnterInfo) =>
              void logicCall(m.id, "onFeature", [info]).catch((err) =>
                plog.error(m.id, "provider onFeature failed:", err)
              ),
            select: async (item: ProviderResult) => {
              const rows = await logicCall(m.id, "select", [item]).catch(() => undefined);
              return Array.isArray(rows) ? rows : [];
            },
            filter: async (item: ProviderResult, q: string) => {
              const rows = await logicCall(m.id, "filter", [item, q]).catch(() => undefined);
              return Array.isArray(rows) ? rows : [];
            },
            onSettings: (values: Record<string, unknown>) =>
              void logicCall(m.id, "onSettings", [values]).catch((err) =>
                plog.error(m.id, "provider onSettings failed:", err)
              ),
          },
          ...(navBars ? { navBars } : {}),
        });
        registeredDiskIds.add(m.id);
        void applyPluginSettings(m.id);
        loadedAny = true;
        plog.info(m.id, `registered provider proxy (entry=${m.entry})`);
      } else if (m.kind === "mode" && m.template === "list" && m.entry) {
        // Built-in list template (P2.5b): no view HTML — the entry logic runs
        // host-side (provider trust model) and the built-in list component
        // renders its rows.
        // P6.5：逻辑在共享宿主的沙箱 iframe（list 模板消费的是代理 hook）。
        pushLogicLoad(m.id); // 先于 hook 拉取（同 provider 分支注释）
        const logic = logicProxy(m.id);
        const instance = createListTemplateMode(m, logic, services!);
        definePlugin({
          id: m.id,
          modeMeta: {
            labelKey: "",
            placeholderKey: "",
            icon: resolvePluginIcon(m.icon, m.dir) ?? "",
            label: m.name || m.id,
          },
          keywords: m.keywords,
          keywordsPinyin: m.keywordsPinyin ?? [],
          features: m.features ?? [],
          dir: m.dir,
          pluginName: m.name || m.id,
          mode: instance,
        });
        registeredDiskIds.add(m.id);
        void applyPluginSettings(m.id);
        loadedAny = true;
        plog.info(
          m.id,
          `registered mode proxy (template=list, entry=${m.entry}` +
            `${m.height != null ? `, height=${m.height}` : ""}${m.features?.length ? `, ${m.features.length} feature(s)` : ""})`
        );
      } else if (m.kind === "mode" && m.view) {
        if (m.entry) pushLogicLoad(m.id); // 先于 hook 拉取（同 provider 分支注释）
        const logic = m.entry ? logicProxy(m.id) : {};
        const instance = createDiskModeInstance(m, logic, services!);
        const navBars = navBarsContribution(m.id, logic);
        definePlugin({
          id: m.id,
          modeMeta: {
            labelKey: "",
            placeholderKey: "",
            icon: resolvePluginIcon(m.icon, m.dir) ?? "",
            label: m.name || m.id,
          },
          keywords: m.keywords,
          keywordsPinyin: m.keywordsPinyin ?? [],
          features: m.features ?? [],
          dir: m.dir,
          pluginName: m.name || m.id,
          mode: instance,
          ...(navBars ? { navBars } : {}),
        });
        registeredDiskIds.add(m.id);
        void applyPluginSettings(m.id);
        loadedAny = true;
        plog.info(
          m.id,
          `registered mode (view=${m.view}${m.entry ? `, entry=${m.entry}` : ""}` +
            `${m.height != null ? `, height=${m.height}` : ""}${navBars ? ", navBars" : ""})`
        );
      } else if (m.kind === "service" && m.entry) {
        pushLogicLoad(m.id); // 先于 hook 拉取（同 provider 分支注释）
        const navBars = navBarsContribution(m.id, logicProxy(m.id));
        definePlugin({
          id: m.id,
          lifecycle: {
            onShow: () => void logicCall(m.id, "onShow", []).catch(() => {}),
            onHide: () => void logicCall(m.id, "onHide", []).catch(() => {}),
            onQuery: (q) => throttledLogicCall(m.id, "onQuery", [q]),
            onFeature: (info) => void logicCall(m.id, "onFeature", [info]).catch(() => {}),
            onSubInput: (text) => throttledLogicCall(m.id, "onSubInput", [text]),
            onSettings: (values) => void logicCall(m.id, "onSettings", [values]).catch(() => {}),
          },
          features: m.features ?? [],
          dir: m.dir,
          ...(navBars ? { navBars } : {}),
        });
        registeredDiskIds.add(m.id);
        void applyPluginSettings(m.id);
        loadedAny = true;
        plog.info(m.id, `registered service proxy (entry=${m.entry})`);
      } else {
        plog.error(
          m.id,
          `unusable manifest: kind=${m.kind}` +
            (m.kind === "provider" && !m.entry ? " — provider requires `entry`" : "") +
            (m.kind === "mode" && m.template !== "list" && !m.view ? " — mode requires `view`" : "") +
            (m.kind === "mode" && m.template === "list" && !m.entry ? " — template=list requires `entry`" : "") +
            (m.kind === "service" && !m.entry ? " — service requires `entry`" : "")
        );
      }
    } catch (err) {
      plog.error(m.id, "load failed:", err);
    }
  }
  if (loadedAny) plog.info(null, "disk plugins loaded; manifests signal refreshed");
  // The `plugins` array is plain — clone the manifests signal so reactive
  // consumers (mode pills, provider merge) re-run after disk loads.
  if (loadedAny) setManifests((prev) => [...prev]);
}

/** Load a plugin's effective settings (P3.4) and hand them to its
 * contribution hooks. Called when a disk plugin is loaded and whenever the
 * settings window changes a value (the Rust `plugin-settings` event) — the
 * plugin instance lives in this window, the pane lives in the settings one, so
 * the values have to be pushed across. */
export async function applyPluginSettings(id: string): Promise<void> {
  const p = plugins.find((x) => x.id === id);
  if (!p) return;
  let values: Record<string, unknown>;
  try {
    values = (await invoke<Record<string, unknown>>("plugin_settings_get", { id })) ?? {};
  } catch (err) {
    plog.error(id, "settings load failed:", err);
    return;
  }
  plog.debug(id, "settings →", values);
  pendingLogicSettings.set(id, values); // logic-loaded 时补投（首投可能早于逻辑就绪）
  try {
    p.mode?.onSettings?.(values);
    p.provider?.onSettings?.(values);
    p.lifecycle?.onSettings?.(values);
  } catch (err) {
    plog.error(id, "onSettings failed:", err);
  }
}

/** Global keywords (uTools-style) of enabled mode plugins → Navigate offers
 * an 「进入 <name>」 row when the query matches one. Matching tiers, best
 * first: exact (case-insensitive) → prefix → pinyin initials prefix → full
 * pinyin prefix. Pinyin comes precomputed from the backend (`keywordsPinyin`)
 * — the frontend has no pinyin table of its own. */
export function modeKeywordMatches(q: string): { id: ModeId; name: string }[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  const hits: { id: ModeId; name: string; tier: number }[] = [];
  for (const p of plugins) {
    if (!p.mode || !isEnabled(p.id)) continue;
    const kws = (p as { keywords?: string[] }).keywords ?? [];
    const pys = (p as { keywordsPinyin?: { full: string; initials: string }[] })
      .keywordsPinyin ?? [];
    let best = Infinity;
    kws.forEach((k, i) => {
      const kl = k.trim().toLowerCase();
      let tier = Infinity;
      if (kl === needle) tier = 0;
      else if (kl.startsWith(needle)) tier = 1;
      else {
        const py = pys[i];
        if (py) {
          if (py.initials.startsWith(needle)) tier = 2;
          else if (py.full.startsWith(needle)) tier = 3;
        }
      }
      if (tier < best) best = tier;
    });
    if (best < Infinity) {
      hits.push({
        id: p.id,
        name: (p as { pluginName?: string }).pluginName ?? p.id,
        tier: best,
      });
    }
  }
  hits.sort((a, b) => a.tier - b.tier);
  return hits.map(({ id, name }) => ({ id, name }));
}

/** Enabled plugins contributing Navigate bars (栏目), in registration
 * order. The composition root calls each `navBars()` on show/refresh and
 * feeds the results into the navigate store's section registry. */
export function navBarPlugins(): {
  id: string;
  navBars: () => Promise<NavBarContribution[]> | NavBarContribution[];
}[] {
  return plugins
    .filter((p) => p.navBars && isEnabled(p.id))
    .map((p) => ({ id: p.id, navBars: p.navBars! }));
}

/** Enabled mode plugins, in registration order (id + instance + pill meta). */
export function modePlugins(): {
  id: ModeId;
  instance: ModeInstance;
  modeMeta?: { labelKey: string; placeholderKey: string; icon: string; label?: string };
}[] {
  return plugins
    .filter((p) => p.mode && isEnabled(p.id))
    .map((p) => ({ id: p.id, instance: p.mode!, modeMeta: p.modeMeta }));
}

// ── Detached plugin windows (P6) ──
//
// A disk mode plugin declaring `detachable` can move its page into its own
// window (label `plugin-<id>`, page plugin.html). The plugin's **logic** (the
// entry hooks) stays here in the launcher window — the detached window is
// only the view. While a plugin is detached:
// - its postMessage bridge cannot reach this window's iframe (not mounted),
//   so page state is pushed over Rust events (`plugin_window_push_state`);
// - `onEnter` / `onSettings` payloads travel the same way;
// - activating the mode (pill / Tab / keyword / redirect) raises the window
//   instead of switching pages here.
const detachedIds = new Set<string>();
/** Per detached disk mode: a state pusher + the logic-side onShow hook.
 * `includeSnapshot` (P6.5) only on the ready handshake — the shown-event
 * push fires at window creation, before the page's iframes exist. */
const detachedSuppliers = new Map<
  string,
  { push: (show: boolean, includeSnapshot?: boolean) => void; pushTheme: (t: string) => void; onShow: () => void }
>();

// ── 状态快照（P6.5）──
//
// detach 方向：detachMode 在 `plugin_window_open` 之前从启动器内的活 iframe
// 取快照（此刻页面必然挂载），暂存在这里，随独立窗口 ready 后的那次
// push_state 一次性带过去（取出即删）。
const pendingSnapshots = new Map<string, { view?: unknown }>();
/** App.tsx 的 detachMode 在开窗前调用：页面无响应/未就绪传 null，不暂存。 */
export function storePendingSnapshot(id: string, snapshot: unknown | null): void {
  const capped = capSnapshot(snapshot, id);
  // CDP verify tap（同 pluginWindow 的 __pluginStates 模式）；fields 是快照
  // 内容摘录，供 probe 不依赖帧内 DOM 也能校验捕获到的值。
  const auto = (capped as { auto?: { fields?: unknown[] } } | null)?.auto;
  ((window as unknown as { __snapPending?: unknown[] }).__snapPending ??= []).push({
    id,
    stored: capped != null,
    fields: auto?.fields ?? null,
  });
  if (capped) pendingSnapshots.set(id, { view: capped });
}
// attach 方向：独立窗口关闭时上报的最终状态。启动器内的 iframe 若还活着
// （搜索记忆留住了 mode）则直接投递；否则等下一次 ready 握手消费。
const attachSnapshots = new Map<string, { view?: unknown }>();
/** Per disk mode: a post-into-the-live-iframe guard — returns whether the
 * event actually went into a mounted page (the closed-window restore uses
 * it to decide between direct delivery and the ready-handshake path). */
const directPosters = new Map<string, (type: string, payload?: unknown) => boolean>();

// ── Theme push (P5 sandbox follow-up) ──
//
// The sandboxed mode iframe cannot read the launcher document (opaque
// origin), so the read-the-host-palette trick plugins used pre-P5 is dead.
// The host owns the color mode, so it pushes it: `lume.on.theme = (mode) => …`
// receives `"light" | "dark"` on the ready handshake and whenever the
// launcher's `data-theme` flips (颜色模式 setting, or the OS in system mode).
/** Per disk mode page: the closure that posts a theme value into its iframe
 * (no-op until the page's view is ready). */
const themePosters = new Map<string, (t: string) => void>();

function postThemeEverywhere() {
  const t = currentThemeMode();
  for (const post of themePosters.values()) post(t);
  for (const s of detachedSuppliers.values()) s.pushTheme(t);
}

// applyColorMode writes `data-theme` (and system mode rewrites it on OS
// flips) — one observer covers every path.
new MutationObserver(postThemeEverywhere).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme"],
});

/** True when the mode page currently lives in its own window. */
export function isPluginDetached(id: string): boolean {
  return detachedIds.has(id);
}

/** Track detach state (set after a successful `plugin_window_open`, cleared
 * by the `plugin-window-closed` event). */
export function setPluginDetached(id: string, detached: boolean): void {
  if (detached) detachedIds.add(id);
  else detachedIds.delete(id);
}

/** Currently detached ids (consistency cleanup after settings changes). */
export function detachedPluginIds(): string[] {
  return [...detachedIds];
}

/** The manifest declares the mode detachable (settings-pane chip + the
 * detach button read this). */
export function isPluginDetachable(id: string): boolean {
  return manifests().find((x) => x.id === id)?.detachable ?? false;
}

/** `plugin-window-ready` — the detached page's bridge is live; push the
 * current state (the cross-window ready handshake) and fire onShow. Also
 * (re)marks the plugin detached: the window's existence is the ground truth
 * (the launcher may have missed its own detach bookkeeping — e.g. after a
 * reload — and the events arrive before any close). */
export function onPluginWindowReady(id: string): void {
  const s = detachedSuppliers.get(id);
  if (!s) return;
  detachedIds.add(id);
  s.push(true, true);
  s.onShow();
}

/** `plugin-window-shown` — a detached window was opened/focused again:
 * replay `show` into the page and fire the logic hook. Same self-healing
 * tracking as ready. */
export function onPluginWindowShown(id: string): void {
  const s = detachedSuppliers.get(id);
  if (!s) return;
  detachedIds.add(id);
  s.push(true);
  s.onShow();
}

/** `plugin-window-closed` — the window is gone; the mode returns to the
 * normal in-launcher behaviour. The payload (P6.5) carries the detached
 * page's final snapshot + query so the state can travel back into the
 * launcher: the query lands in the mode's signal immediately (the next
 * summon's replay carries it), the snapshot either posts straight into a
 * still-mounted iframe or waits for the next ready handshake. */
export function onPluginWindowClosed(
  payload: string | { id: string; snapshot?: unknown; query?: string | null }
): void {
  const id = typeof payload === "string" ? payload : payload.id;
  detachedIds.delete(id);
  if (typeof payload === "string") return; // pre-P6.5 emitter (no snapshot)
  const view = capSnapshot(payload.snapshot, id);
  // The final query becomes the mode's query: the in-launcher replay (and
  // the search box) pick it up on the next activation. **"" is a real
  // value** — the user may have cleared the text inside the detached window;
  // only null/undefined means "no query info" (keep the current signal).
  // Skipping "" here would resurrect pre-detach text into the search box.
  if (typeof payload.query === "string") {
    plugins.find((x) => x.id === id)?.mode?.setQuery(payload.query);
  }
  const delivered = view == null ? false : directPosters.get(id)?.("restore", view) ?? false;
  // CDP verify tap（无快照的关闭也记录——query 清空语义同样需要可观测）
  ((window as unknown as { __pwClosed?: unknown[] }).__pwClosed ??= []).push({
    id,
    hasSnapshot: view != null,
    query: payload.query ?? null,
    delivered,
  });
  if (view != null && !delivered) attachSnapshots.set(id, { view });
}

// ── Declarative entry rules (P2.1: `[[features]]` in the manifest) ──
//
// A feature matches the query text and offers an 「<label>」 row whose
// activation enters the plugin with the text as payload. Matching happens
// here (JS RegExp); the manifest only carries the pattern. Compiled patterns
// are cached per plugin+index; a pattern matching the empty string is
// dropped (it would fire on every keystroke — the same rule uTools applies).

const featureRegexCache = new Map<string, RegExp | null>();

function compileFeatureRegex(pluginId: string, idx: number, pattern: string): RegExp | null {
  const key = `${pluginId}#${idx}`;
  const hit = featureRegexCache.get(key);
  if (hit !== undefined) return hit;
  let out: RegExp | null = null;
  try {
    const re = new RegExp(pattern, "i");
    if (re.test("")) {
      plog.warn(pluginId, `feature[${idx}] regex matches the empty string — ignored`);
    } else {
      out = re;
    }
  } catch (err) {
    plog.error(pluginId, `feature[${idx}] bad regex "${pattern}":`, err);
  }
  featureRegexCache.set(key, out);
  return out;
}

/** A fired entry rule: the row data + what the plugin receives on enter. */
export interface FeatureMatch extends FeatureEnterInfo {
  pluginId: string;
  label: string;
  icon?: string;
}

/** Entry rules of enabled plugins matching a query (empty query → none). */
export function featureMatches(q: string): FeatureMatch[] {
  const query = q.trim();
  if (!query) return [];
  const out: FeatureMatch[] = [];
  for (const p of plugins) {
    if (!isEnabled(p.id)) continue;
    const feats = (p as { features?: PluginFeature[] }).features ?? [];
    feats.forEach((f, i) => {
      if (!f?.code) return;
      // files/img rules never match query text — fileFeatureMatches /
      // imgFeatureMatches own them.
      if (f.type && f.type !== "text") return;
      const len = query.length;
      if (f.minLength != null && len < f.minLength) return;
      if (f.maxLength != null && len > f.maxLength) return;
      let type: FeatureEnterInfo["type"] = "over";
      if (f.regex) {
        const re = compileFeatureRegex(p.id, i, f.regex);
        if (!re || !re.test(query)) return;
        type = "regex";
      } else if (!f.over) {
        return; // a rule with neither regex nor over never matches
      }
      out.push({
        pluginId: p.id,
        code: f.code,
        type,
        payload: query,
        label: f.label || (p as { pluginName?: string }).pluginName || p.id,
        ...(f.icon ? { icon: resolvePluginIcon(f.icon, (p as { dir?: string }).dir) } : {}),
      });
    });
  }
  return out;
}

/** Extension → `fileType` category table (P4, ROADMAP #28). Curated, not
 * exhaustive — anything unmapped is `others`. A plugin that needs precision
 * declares `extensions` instead. */
const FILE_TYPE_EXTS: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "tif", "tiff", "svg", "heic", "avif"],
  video: ["mp4", "mkv", "avi", "mov", "wmv", "flv", "webm", "m4v", "mpg", "mpeg", "ts"],
  audio: ["mp3", "wav", "flac", "ogg", "m4a", "aac", "wma", "opus", "mid"],
  document: ["doc", "docx", "dot", "dotx", "xls", "xlsx", "xlsm", "ppt", "pptx", "potx",
    "pdf", "odt", "ods", "odp", "rtf", "pages", "numbers", "key", "epub"],
  text: ["txt", "md", "markdown", "log", "csv", "tsv", "json", "xml", "yaml", "yml", "ini",
    "toml", "html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "py", "rs", "go", "sh",
    "bat", "ps1", "sql", "gitignore"],
};

const extOf = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  // No dot / dotfile: no usable extension.
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

/** `type = "files"` rules (P2.2) matching a dropped file list, with P4
 * `fileType` categories and folder matching. Matching semantics per rule:
 * - `extensions` non-empty → files whose extension is listed (folders never
 *   match — a directory named `x.md` is not a markdown file);
 * - else `fileType` declared → `folder` matches directories, `others`
 *   matches files outside every table, anything else is a table lookup;
 * - neither → any **file** (a folder needs `fileType = "folder"`).
 * `minLength`/`maxLength` bound the matched-subset count; the payload
 * carries only the matching subset. `kinds` runs parallel to `paths`
 * ("file" | "folder" | "missing", from the `file_kinds` command). */
export function fileFeatureMatches(paths: string[], kinds: string[]): FeatureMatch[] {
  if (paths.length === 0) return [];
  const out: FeatureMatch[] = [];
  for (const p of plugins) {
    if (!isEnabled(p.id)) continue;
    const feats = (p as { features?: PluginFeature[] }).features ?? [];
    feats.forEach((f) => {
      if (!f?.code || f.type !== "files") return;
      const exts = (f.extensions ?? []).map((e) => e.toLowerCase().replace(/^\./, ""));
      const kindOf = (i: number) => kinds[i] ?? "file";
      const matched = paths.filter((path, i) => {
        if (exts.length > 0) {
          return kindOf(i) === "file" && exts.includes(extOf(path));
        }
        const fileType = f.fileType;
        if (!fileType) return kindOf(i) === "file"; // no filter = any file, not folders
        if (fileType === "folder") return kindOf(i) === "folder";
        if (kindOf(i) !== "file") return false;
        if (fileType === "others") return !Object.values(FILE_TYPE_EXTS).some((t) => t.includes(extOf(path)));
        return (FILE_TYPE_EXTS[fileType] ?? []).includes(extOf(path));
      });
      if (matched.length === 0) return;
      if (f.minLength != null && matched.length < f.minLength) return;
      if (f.maxLength != null && matched.length > f.maxLength) return;
      out.push({
        pluginId: p.id,
        code: f.code,
        type: "files",
        payload: "",
        paths: matched,
        label: f.label || (p as { pluginName?: string }).pluginName || p.id,
        ...(f.icon ? { icon: resolvePluginIcon(f.icon, (p as { dir?: string }).dir) } : {}),
      });
    });
  }
  return out;
}

/** `type = "img"` rules (P2.2) — offered on the empty-query main menu while
 * the clipboard holds an image (the caller probes `plugin_clipboard_has_image`
 * once per summon, never per keystroke). The plugin reads the pixels itself
 * via `clipboard.readImage()`. */
export function imgFeatureMatches(): FeatureMatch[] {
  const out: FeatureMatch[] = [];
  for (const p of plugins) {
    if (!isEnabled(p.id)) continue;
    const feats = (p as { features?: PluginFeature[] }).features ?? [];
    feats.forEach((f) => {
      if (!f?.code || f.type !== "img") return;
      out.push({
        pluginId: p.id,
        code: f.code,
        type: "img",
        payload: "",
        label: f.label || (p as { pluginName?: string }).pluginName || p.id,
        ...(f.icon ? { icon: resolvePluginIcon(f.icon, (p as { dir?: string }).dir) } : {}),
      });
    });
  }
  return out;
}

/** `type = "window"` rules (P4, ROADMAP #29) — offered on the empty-query
 * main menu when the window that had focus before the launcher appeared
 * matches the rule's declared dimensions. Matching: within one field the
 * values OR, across fields they AND; a rule with no field at all never
 * matches (symmetric with a text rule that has neither regex nor over).
 * The payload carries the matched window info so a plugin can adapt (e.g.
 * offer actions for the file the user is looking at). */
export function windowFeatureMatches(fg: ForegroundInfo | null): FeatureMatch[] {
  if (!fg) return [];
  const process = fg.process.toLowerCase();
  const processStem = process.replace(/\.exe$/, "");
  const className = fg.className.toLowerCase();
  const out: FeatureMatch[] = [];
  for (const p of plugins) {
    if (!isEnabled(p.id)) continue;
    const feats = (p as { features?: PluginFeature[] }).features ?? [];
    feats.forEach((f, idx) => {
      if (!f?.code || f.type !== "window") return;
      const procs = (f.process ?? []).map((v) => v.toLowerCase());
      const classes = (f.class ?? []).map((v) => v.toLowerCase());
      const titles = f.title ?? [];
      if (procs.length === 0 && classes.length === 0 && titles.length === 0) return;
      if (procs.length > 0 && !procs.some((v) => v === process || v === processStem)) return;
      if (classes.length > 0 && !classes.includes(className)) return;
      if (titles.length > 0 && !titles.some((v) => titleValueMatches(p.id, idx, v, fg.title))) return;
      out.push({
        pluginId: p.id,
        code: f.code,
        type: "window",
        payload: "",
        window: fg,
        label: f.label || (p as { pluginName?: string }).pluginName || p.id,
        ...(f.icon ? { icon: resolvePluginIcon(f.icon, (p as { dir?: string }).dir) } : {}),
      });
    });
  }
  return out;
}

/** One `title` matcher value: a case-insensitive substring, or a regex when
 * wrapped in `/…/` (compiled through the same cache/guards as the text-rule
 * patterns — same plugin+rule key space, invalid and empty-matching patterns
 * are dropped). */
function titleValueMatches(pluginId: string, ruleIdx: number, value: string, title: string): boolean {
  const wrapped = /^\/(.*)\/$/.exec(value.trim());
  if (!wrapped) return title.toLowerCase().includes(value.toLowerCase());
  const re = compileFeatureRegex(pluginId, ruleIdx, wrapped[1]);
  return re ? re.test(title) : false;
}

/** Whether any enabled plugin declares a `type = "window"` rule — gates the
 * per-summon foreground-context fetch (zero IPC when unused). */
export function hasWindowFeatures(): boolean {
  return plugins.some(
    (p) =>
      isEnabled(p.id) &&
      ((p as { features?: PluginFeature[] }).features ?? []).some((f) => f?.type === "window")
  );
}

/** Route a declarative entry payload to its plugin: a mode receives
 * `onEnter` (the root switches to it first), a provider/service its
 * `onFeature`. Returns false when nothing consumed it (unknown id or no
 * handler) so the caller can tell the user. */
export function deliverFeature(pluginId: string, info: FeatureEnterInfo): boolean {
  const p = plugins.find((x) => x.id === pluginId);
  if (!p || !isEnabled(pluginId)) return false;
  const label = (p as { pluginName?: string }).pluginName ?? pluginId;
  try {
    if (p.mode?.onEnter) {
      p.mode.onEnter(info);
      return true;
    }
    if (p.provider?.onFeature) {
      p.provider.onFeature(info);
      return true;
    }
    if (p.lifecycle?.onFeature) {
      p.lifecycle.onFeature(info);
      return true;
    }
  } catch (err) {
    plog.error(pluginId, "feature enter failed:", err);
    return true; // the handler ran (and threw) — not an "unhandled" case
  }
  plog.warn(pluginId, `no feature handler for code="${info.code}" (${label})`);
  return false;
}

/** Deliver one keystroke to the plugin owning the search box (P2.3). */
export function deliverSubInput(pluginId: string, text: string): boolean {
  const p = plugins.find((x) => x.id === pluginId);
  if (!p || !isEnabled(pluginId)) return false;
  try {
    if (p.mode?.onSubInput) {
      p.mode.onSubInput(text);
      return true;
    }
    if (p.lifecycle?.onSubInput) {
      p.lifecycle.onSubInput(text);
      return true;
    }
  } catch (err) {
    plog.error(pluginId, "onSubInput failed:", err);
    return true;
  }
  plog.warn(pluginId, "sub-input text dropped: no onSubInput handler");
  return false;
}

/** The contribution kind a plugin registered (for feature/redirect targets). */
export function pluginKind(id: string): "mode" | "provider" | "service" | null {
  const p = plugins.find((x) => x.id === id);
  if (!p || !isEnabled(id)) return null;
  if (p.mode) return "mode";
  if (p.provider) return "provider";
  if (p.lifecycle) return "service";
  return null;
}

/** Find a plugin's mode instance by id (undefined when disabled/absent). */
export function modeById(id: ModeId): ModeInstance | undefined {
  const p = plugins.find((x) => x.id === id);
  return p && p.mode && isEnabled(p.id) ? p.mode : undefined;
}

export function previewPlugins(): LauncherPlugin[] {
  return plugins.filter((p) => p.preview && isEnabled(p.id));
}

export { isEnabled as pluginEnabled };
