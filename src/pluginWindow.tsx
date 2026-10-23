//! Detached plugin window — the third window entry (plugin.html), the
//! host page for one mode plugin's page living in its own window.
//!
//! Mirrors the in-launcher disk mode exactly where it can: the same
//! `createIframeView` renders the plugin's `view` HTML in a sandboxed bridge
//! iframe, the same `execHostRpc` answers `window.lume` traffic, and the
//! same permission layers (frontend ledger + Rust whitelist) apply. What
//! differs is the `PluginServices` — this window answers window-locally
//! (toast / hide / resize / drag) and forwards launcher-bound actions
//! (placeholder / sub-input are meaningless here; redirect goes back through
//! the launcher over a Rust event). `setQuery` is real here: the query lives
//! in this window's iframes (the titlebar page drives the view through it).
//!
//! Titlebar slot (optional manifest `titlebar` field): a SECOND bridge
//! iframe rendered inside the chrome row (src/components/TitleBar.tsx),
//! same sandbox, same RPC router. State pushes fan out to both iframes;
//! keys forwarded out of the slot still reach the view via `lume.on.key`.
//!
//! State flow: the page announces itself with `plugin_window_ready` → the
//! launcher's registry pushes `{show, query, enter, settings}` as the
//! `plugin-state` event → this page posts each piece into the iframes. A
//! hidden window never re-loads on re-show, so re-focus only needs a
//! `plugin-window-shown` → `show` replay.

import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { Dynamic, render } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { applyPluginColorMode, normalizePluginColorMode, resolveColorMode } from "./theme";
import { pluginColorMode, pluginColorPref, seedPluginColorPrefs, setPluginColorPref } from "./plugins/themePrefs";
import { TitleBar } from "./components/TitleBar";
import type {
  FeatureEnterInfo,
  PluginManifest,
  PluginPresenter,
  PluginPresenterSetting,
  PluginServices,
} from "./plugins/types";
import { createPageRuntimeMode, type PageRuntimeMode } from "./plugins/pageRuntimeMode";
import type { PageModel } from "./page-runtime/contracts";
import type { SettingsData } from "./settings/types";
import { setPermissionSource } from "./plugins/permissions";
import { createIframeView, escapeHtml, injectBridge, injectTitlebarBridge } from "./plugins/iframeBridge";
import { execHostRpc } from "./plugins/rpc";
import { fetchDiskFile } from "./plugins/disk";
import { plog } from "./plugins/log";
import { resolveLocale, setLocale, t } from "./i18n";
import "./pluginWindow.css";

const id = new URLSearchParams(location.search).get("plugin") ?? "";
/** This window's own label (`plugin-<id>`) — the target every plugin-scoped
 * event listener must be registered with. **Tauri's JS `listen()` defaults to
 * `EventTarget::Any`, and `emit_to`'s filter only ever consults the *listener*
 * target** (every webview is visited): an unscoped listener therefore receives
 * every other plugin's `emit_to` traffic too. That was invisible while all
 * payloads were identical — with per-plugin color modes (docs/ROADMAP_HISTORY.md #36) the
 * hello-mode window was applying file-search's `themePref` and repainting
 * itself. Scope every plugin-scoped event; leave app-wide ones
 * (`settings-applied`) unscoped. */
const WINDOW_LABEL = getCurrentWindow().label;

/** The launcher's `appearance.color_mode` — the fallback this window's theme
 * follows when the plugin never pinned one. Mutable: `settings-applied`
 * refreshes it while the window is open. */
let hostColorSetting = "system";

/** Paint this window in the PLUGIN's effective color mode (docs/ROADMAP_HISTORY.md #36): the
 * window's document IS the plugin's surface, so its chrome (`TitleBar`, the
 * theme tokens) must not disagree with the page inside it — a dark-pinned
 * plugin on a light launcher would otherwise show a light strip above a dark
 * page. `applyPluginColorMode` keeps the launcher's own resolution (and its
 * live OS following) for a `"system"` preference. */
function applyWindowTheme(): void {
  applyPluginColorMode(hostColorSetting, pluginColorPref(id));
}

/** The mode the plugin's page is told to render in (what `theme` events and
 * `theme.get` report). */
function effectiveMode(): "light" | "dark" {
  return pluginColorMode(id, resolveColorMode(hostColorSetting));
}

function App() {
  // Theme before first paint (the Rust init script injected __LUME_CONFIG__,
  // same as the main/settings windows) — including the plugin's own override,
  // which the launcher persisted, so the window never opens in the launcher's
  // mode and flips a frame later.
  const cfg = (window as unknown as { __LUME_CONFIG__?: SettingsData }).__LUME_CONFIG__;
  hostColorSetting = cfg?.appearance?.color_mode ?? "system";
  seedPluginColorPrefs(cfg?.plugins?.color_modes);
  // The chrome and the load-failure page render host text, so follow the
  // configured language (the injected config already carries it).
  setLocale(resolveLocale(cfg?.appearance?.language ?? "system"));
  applyWindowTheme();

  // Titlebar label — the manifest name once plugin_window_meta answers.
  const [pluginName, setPluginName] = createSignal(id);
  /** The titlebar page's HTML — set only when the manifest declares a
      `titlebar` file and it loaded (drives the slot in the chrome row). */
  const [titlebarHtml, setTitlebarHtml] = createSignal("");
  const [runtimeView, setRuntimeView] = createSignal<Component | null>(null);
  const [runtimeTitlebar, setRuntimeTitlebar] = createSignal<Component | null>(null);
  let pageRuntime: PageRuntimeMode | undefined;

  // Last state pushed from the launcher, cached: the titlebar page's ready
  // handshake replays it locally (the registry answers only the view's).
  const lastState: {
    show?: boolean;
    query?: string | null;
    enter?: FeatureEnterInfo | null;
    settings?: Record<string, unknown> | null;
    theme?: string | null;
    presenter?: string;
    /** Titlebar frame of the last v2 snapshot push — replayed when the
     * slot mounts after the push (it loads asynchronously). */
    snapshotTitlebar?: unknown;
  } = {};

  let slotPost: ((type: string, payload?: unknown) => void) | undefined;
  let slotSnapshot: ((timeoutMs?: number) => Promise<unknown | null>) | undefined;
  /** Fan an event out to every mounted iframe (view + titlebar slot). */
  const fan = (type: string, payload?: unknown) => {
    post(type, payload);
    slotPost?.(type, payload);
  };
  /** Frame-scoped restore routing (#40): a v2 envelope carries {view,
   * titlebar}. `early` delivers the titlebar frame (silent restore, before
   * the standard replay); `late` delivers the view frame (after it).
   * Anything else is a legacy flat snapshot of the view page. */
  const routeSnapshot = (snap: unknown, phase: "early" | "late") => {
    const env = snap as { v?: number; frames?: Record<string, unknown> } | null;
    if (env && typeof env === "object" && env.v === 2 && env.frames) {
      if (phase === "early" && env.frames.titlebar !== undefined) {
        lastState.snapshotTitlebar = env.frames.titlebar;
        slotPost?.("restore", env.frames.titlebar);
      }
      if (phase === "late" && env.frames.view !== undefined) {
        post("restore", env.frames.view);
      }
      return;
    }
    if (phase === "late" && snap) post("restore", snap);
  };

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const localToast = (text: string) => {
    const el = document.getElementById("plugin-window-toast");
    if (!el) return;
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
    }, 1800);
  };

  // Window-local PluginServices (rpc.ts's router needs the full shape).
  // dragWindow's gate: the host-injected slot drag default (iframeBridge's
  // TITLEBAR_DRAG_SCRIPT) and a plugin's own §6G.5 handler (titlebar-demo's
  // grip, file-search's body listener) both land here for ONE mousedown —
  // tao posts WM_NCLBUTTONDOWN (HTCAPTION) asynchronously, so a second
  // start_dragging would start a second modal move loop after release and
  // latch the window to the cursor. One real start per gesture window.
  let lastDragAt = 0;
  const services: PluginServices = {
    showToast: (text) => localToast(text),
    markEntryOpened: () => {},
    // `app.hide()` hides THIS window (the plugin decides when it should go
    // away); re-open via the launcher's pill/keyword focuses it again.
    resetAndHide: () => void getCurrentWindow().hide().catch((err) => plog.error(id, "hide failed:", err)),
    detachMode: () => {
      // Already detached here: the caller IS the detached window — raise it.
      void getCurrentWindow().setFocus().catch((err) => plog.error(id, "focus failed:", err));
    },
    setPluginColorMode: async (pluginId, mode) => {
      // Same contract as the launcher's services (docs/ROADMAP_HISTORY.md #36), but the
      // reconvergence differs: here the durable write also updates THIS
      // window's chrome, and the launcher learns about it over the Rust
      // `plugin-color-mode` event (its mirror drives the next `theme` push).
      await invoke("set_plugin_color_mode", { id: pluginId, mode });
      setPluginColorPref(pluginId, mode, "window");
      applyWindowTheme();
      fan("theme", effectiveMode());
    },
    pluginColorState: (pluginId) => ({
      pref: pluginColorPref(pluginId),
      mode: effectiveMode(),
      host: resolveColorMode(hostColorSetting),
    }),
    persistLastPage: () => {},
    runSearch: async () => {
      plog.debug(id, "runSearch ignored in the detached window");
    },
    scheduleResize: () => {},
    searchToken: () => 0,
    nextSearchToken: () => 0,
    selectionSource: () => "other",
    markMouse: () => {},
    openMenu: () => {},
    mode: () => id,
    requestMode: () => {
      plog.debug(id, "requestMode ignored in the detached window");
    },
    setModePlaceholder: () => {
      plog.debug(id, "setPlaceholder ignored in the detached window (no search box here)");
    },
    setQuery: (q) => {
      // Page Runtime windows still route the query to the launcher-owned Page
      // Service; legacy views keep their historical local fan-out. The echo to
      // both local frames matches the launcher's setQuery → on.query round-trip.
      lastState.query = q;
      if (pageRuntime) {
        void callDetachedService("onQuery", q).catch((err) =>
          plog.error(id, "detached query failed:", err)
        );
        pageRuntime.postEvent("query", q);
        return;
      }
      fan("query", q);
    },
    resizeWindow: (size) => {
      void (async () => {
        const win = getCurrentWindow();
        const cur = (await win.innerSize()).toLogical(await win.scaleFactor());
        const width = Math.max(360, Math.round(size?.width ?? cur.width));
        const height = Math.max(240, Math.round(size?.height ?? cur.height));
        await win.setSize(new LogicalSize(width, height));
      })().catch((err) => plog.error(id, "resize failed:", err));
    },
    dragWindow: () => {
      const now = Date.now();
      if (now - lastDragAt < 300) return;
      lastDragAt = now;
      // Debug tap for the CDP verify scripts (same pattern as __pluginStates).
      const w = window as unknown as { __dragStarts?: number };
      w.__dragStarts = (w.__dragStarts ?? 0) + 1;
      void getCurrentWindow().startDragging().catch((err) =>
        plog.error(id, "drag failed:", err)
      );
    },
    setSubInput: () => {
      plog.debug(id, "setSubInput ignored in the detached window");
    },
    subInputOwner: () => null,
    enterPlugin: (pluginId, info: FeatureEnterInfo) => {
      // Redirect out of a detached window: hand the payload to the launcher
      // (which routes it like any feature activation) and close/raise there.
      void invoke("plugin_window_redirect", { from: id, pluginId, info }).catch((err) =>
        plog.error(id, "redirect failed:", err)
      );
      return true;
    },
  };

  // Page Runtime calls are mirror requests: the launcher's Page Session owns
  // the service and answers each request by id. Nothing in this window reaches
  // native capabilities directly.
  const pageCalls = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  const callPageService = (name: string, args: Record<string, unknown> = {}) =>
    new Promise<unknown>((resolve, reject) => {
      const requestId =
        typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        pageCalls.delete(requestId);
        reject(new Error("detached Page Service call timed out: " + name));
      }, 10_000);
      pageCalls.set(requestId, { resolve, reject, timer });
      void invoke("plugin_page_bridge_call", {
        id,
        requestId,
        name,
        args,
      }).catch((error) => {
        clearTimeout(timer);
        pageCalls.delete(requestId);
        reject(new Error(String(error)));
      });
    });

  const callDetachedService = (name: string, ...args: unknown[]) => {
    let payload: Record<string, unknown> = {};
    if (name === "onIntent") payload = { intent: args[0] };
    else if (name === "onQuery") payload = { query: args[0] };
    else if (name === "onEnter") payload = { info: args[0] };
    else if (name === "onSettings") payload = { values: args[0] };
    else if (name === "onFilesDropped") payload = { paths: args[0] };
    return callPageService(name, payload);
  };

  async function setupPageRuntime(meta: {
    dir: string;
    name: string;
    model: string;
    defaultPresenter: string;
    height: number | null;
    presenters: PluginPresenter[];
    presenterSettings: PluginPresenterSetting[];
  }): Promise<void> {
    const manifest = {
      id,
      name: meta.name || id,
      model: meta.model,
      defaultPresenter: meta.defaultPresenter,
      height: meta.height,
      presenters: meta.presenters,
      presenterSettings: meta.presenterSettings,
    } as PluginManifest;
    const initialPresenterId = (
      (window as unknown as { __LUME_CONFIG__?: { pages?: { presenters?: Record<string, string> } } })
        .__LUME_CONFIG__?.pages?.presenters ?? {}
    )[id];
    const runtime = createPageRuntimeMode({
      manifest,
      services,
      form: "window",
      waitForService: async () => {},
      callService: callDetachedService,
      fetchPresenter: (presenter) => fetchDiskFile(meta.dir + "\\" + presenter.entry),
      fetchTitlebar: (presenter) =>
        fetchDiskFile(meta.dir + "\\" + presenter.titlebar),
      applyTheme: async (mode) => {
        if (!mode) throw new Error("Page Runtime theme mode is required");
        await invoke("set_plugin_color_mode", { id, mode });
        setPluginColorPref(id, mode, "window");
        applyWindowTheme();
        runtime.postTheme(effectiveMode());
      },
      initialPresenterId,
      onReady: () => {
        void invoke("plugin_window_ready", { id }).catch((err) =>
          plog.error(id, "Page Runtime ready failed:", err)
        );
      },
      onPresenterState: (state) => {
        if (state.presenterId) {
          lastState.presenter = state.presenterId;
        }
      },
    });
    pageRuntime = runtime;
    (window as unknown as { __detachedPageRuntime?: unknown }).__detachedPageRuntime = {
      getModel: () => runtime.currentModel() ?? null,
      getState: () => runtime.currentPresenterState() ?? null,
      getPresenter: () => runtime.currentPresenterId() ?? null,
      titlebarLive: () => runtime.titlebarLive(),
      postTitlebar: (type: string, payload: unknown) => runtime.postTitlebar(type, payload),
      dispatch: (intent: unknown) => runtime.dispatch(intent as never),
      setQuery: (query: string) => runtime.instance.setQuery(query),
    };
    setRuntimeView(() => runtime.instance.View);
    setRuntimeTitlebar(() => runtime.titlebarView);
  }

  const { View, post, snapshot: viewSnapshot } = createIframeView(
    (method, args) => execHostRpc(id, method, args, services),
    () => {
      // The bridge is live — ask the launcher to push the current state
      // (query / enter / settings / show). This is the cross-window version
      // of the in-launcher ready handshake.
      void invoke("plugin_window_ready", { id }).catch((err) => plog.error(id, "ready failed:", err));
    },
    { id }
  );

  // Titlebar slot viewer (optional manifest `titlebar`): the same bridge and
  // RPC router, one row up. Its ready handshake replays the cached state
  // locally — plugin_window_ready is NOT re-invoked, so the launcher's
  // registry never double-pushes.
  const slotView = createIframeView(
    (method, args) => execHostRpc(id, method, args, services),
    () => {
      if (lastState.show) slotPost?.("show");
      if (typeof lastState.query === "string") slotPost?.("query", lastState.query);
      if (lastState.enter) slotPost?.("enter", lastState.enter);
      if (lastState.settings) slotPost?.("settings", lastState.settings);
      if (lastState.theme) slotPost?.("theme", lastState.theme);
      // 会话快照（#40）：标题栏帧随插件状态推送一起到达；槽位晚挂载时在
      // 这里补投（view 帧由 registry 的就绪握手消费，不重放）。
      if (lastState.snapshotTitlebar !== undefined) slotPost?.("restore", lastState.snapshotTitlebar);
    },
    { class: "titlebar-frame", name: "titlebar", id }
  );
  slotPost = slotView.post;
  slotSnapshot = slotView.snapshot;

  // ── 关闭与快照（会话快照 v2，docs/ROADMAP_HISTORY.md #40）──
  // 用户发起的关闭（× / Esc / Rust 的 close-requested 应答）先向每个活帧要
  // 状态快照再上报销毁：启动器侧按帧入库，重新进入本模式时恢复。快照失败/
  // 超时也必须能关掉 —— close_report 失败时兜底走立即关闭。
  const closeWithSnapshot = () => {
    void (async () => {
      const [view, slot] = await Promise.all([
        pageRuntime ? pageRuntime.instance.snapshot?.() ?? Promise.resolve(null) : viewSnapshot(),
        slotSnapshot ? slotSnapshot() : Promise.resolve(null),
      ]);
      const frames: Record<string, unknown> = {};
      if (view != null) frames.view = view;
      if (slot != null) frames.titlebar = slot;
      const snapshot = { v: 2, frames };
      try {
        await invoke("plugin_window_close_report", {
          id,
          snapshot,
          query: typeof lastState.query === "string" ? lastState.query : null,
        });
      } catch (err) {
        plog.error(id, "close report failed — closing without snapshot:", err);
        void invoke("plugin_window_close", { id }).catch(() => {});
      }
    })();
  };
  // The slot element is created EXACTLY ONCE, outside any reactive
  // expression: a `<slotView.View />` written inline in the `slot={…}` prop
  // getter is re-invoked whenever its dependencies change (titlebarHtml,
  // pluginName), which strands the wired instance — the mounted iframe ends
  // up with no message listener and the whole slot channel dies. One static
  // element + a reactive classList (visibility only) keeps one component
  // instance, one listener, one live iframe; plugins without a titlebar page
  // just keep it empty and non-interactive (the drag region shows through).
  const slotHost = (
    <div
      class="titlebar-slot-host"
      classList={{
        "titlebar-slot-empty":
          titlebarHtml() === "" && !(runtimeTitlebar() && pageRuntime?.titlebarAvailable()),
      }}
    >
      <Show when={!runtimeTitlebar()}>
        <slotView.View />
      </Show>
      <Show when={runtimeTitlebar()}>{(view) => <Dynamic component={view()} />}</Show>
    </div>
  );

  onMount(() => {
    let unlisteners: (UnlistenFn | undefined)[] = [];
    void listen<{
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }>("plugin-page-bridge-reply", (event) => {
      const reply = event.payload;
      const pending = pageCalls.get(reply.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      pageCalls.delete(reply.requestId);
      if (reply.ok) pending.resolve(reply.result);
      else pending.reject(new Error(reply.error || "Page Service call failed"));
    }, { target: WINDOW_LABEL }).then((unlisten) => unlisteners.push(unlisten));

    // Fetch + bridge the view page (same as createDiskModeInstance).
    let dir = "";
    let view = "";
    void invoke<{
      dir: string;
      view: string;
      titlebar: string;
      name: string;
      pageRuntime: boolean;
      model: string;
      defaultPresenter: string;
      height: number | null;
      presenters: PluginPresenter[];
      presenterSettings: PluginPresenterSetting[];
    }>("plugin_window_meta", { id })
      .then(async (meta) => {
        dir = meta.dir;
        view = meta.view;
        document.title = meta.name || id;
        setPluginName(meta.name || id);
        // The permission ledger's manifest source lives in the registry, which
        // only runs in the launcher window — wire it here from the same
        // command the settings pane uses, BEFORE the view HTML lands (the
        // page's first guarded RPC would otherwise be refused with
        // "unknown plugin": this window has no registry to look manifests up).
        const wirePerms = invoke<PluginManifest[]>("get_plugins")
          .then((list) => {
            setPermissionSource((pid) => list.find((x) => x.id === pid));
          })
          .catch((err) => plog.error(id, "permission source wire failed:", err));
        if (meta.pageRuntime) {
          await wirePerms;
          await setupPageRuntime(meta);
          return;
        }
        // Titlebar page (optional manifest `titlebar`): same permission-wire
        // order as the view; a failure just leaves the slot empty (the
        // chrome row stays title + controls). setHtml runs BEFORE the signal
        // mounts the iframe so it renders with its document in place.
        if (meta.titlebar) {
          void wirePerms
            .then(() => fetchDiskFile(dir + "\\" + meta.titlebar))
            .then((html) => {
              // Titlebar pages get the bridge PLUS the host's default
              // blank-area window drag (the slot iframe swallows pointer
              // events; a page without drag handling of its own would leave
              // the middle of the chrome row dead).
              slotView.View.setHtml(injectTitlebarBridge(html, "window"));
              setTitlebarHtml(html);
            })
            .catch((err) => plog.error(id, "titlebar load failed:", err));
        }
        await wirePerms;
        return fetchDiskFile(dir + "\\" + view);
      })
      .then((html) => {
        if (html) View.setHtml(injectBridge(html, "window"));
      })
      .catch((err) => {
        // Raw error to the log; the page shows the localized fallback.
        plog.error(id, "detached view load failed:", err);
        View.setHtml(
          `<body style="font:13px sans-serif;color:#f66;padding:16px">${escapeHtml(
            t("pluginViewLoadFailed")
          )}</body>`
        );
      });

    void listen<{
      show?: boolean;
      query?: string | null;
      enter?: FeatureEnterInfo | null;
      settings?: Record<string, unknown> | null;
      theme?: string | null;
      themePref?: string | null;
      snapshot?: unknown;
      pageRuntime?: boolean;
      model?: PageModel;
      presenter?: string;
      presenterStatus?: string;
      presenterSettings?: Record<string, Record<string, unknown>>;
      pageEvent?: unknown;
      pageError?: unknown;
      pageClearError?: boolean;
    }>("plugin-state", (e) => {
      const s = e.payload;
      plog.debug(id, "plugin-state:", JSON.stringify(s).slice(0, 200));
      // Debug tap for the CDP verify scripts (same pattern as __plog): an
      // append-only history, since pushes interleave (shown vs enter).
      const w = window as unknown as { __pluginStates?: unknown[] };
      (w.__pluginStates ??= []).push(s);
      // 会话快照（docs/ROADMAP_HISTORY.md #40）：titlebar 帧在标准回放**之前**静默恢复
      // （它的输入通常是宿主 query 的视图，恢复值若派发 input 会被页面
      // 当成新输入经 app.setQuery 回灌、把当前 query 冲掉——实测坑）；
      // 标准重放随后把宿主驱动值写回。view 帧在标准回放**之后**投递。
      if (s.snapshot) routeSnapshot(s.snapshot, "early");
      // Fan out to every mounted iframe (view + titlebar slot) and cache for
      // the slot's ready replay.
      if (s.show) {
        lastState.show = true;
        fan("show");
      }
      if (typeof s.query === "string") {
        lastState.query = s.query;
        fan("query", s.query);
      }
      if (s.enter) {
        lastState.enter = s.enter;
        fan("enter", s.enter);
      }
      if (s.settings) {
        lastState.settings = s.settings;
        fan("settings", s.settings);
      }
      if (s.theme) {
        lastState.theme = s.theme;
        fan("theme", s.theme);
      }
      // The plugin's own preference rides every theme push (docs/ROADMAP_HISTORY.md #36): a
      // `theme.set` from the launcher's side (the plugin's logic iframe, or a
      // hand-edited settings.toml) must repaint THIS window's chrome too —
      // and the prefs file may have moved under us.
      const pref = normalizePluginColorMode(s.themePref);
      if (pref && pref !== pluginColorPref(id)) {
        setPluginColorPref(id, pref, "launcher");
        applyWindowTheme();
      }
      // 会话快照（docs/ROADMAP_HISTORY.md #40）：view 帧在标准回放**之后**投递 —— 页面自身
      // 状态最后落地，覆盖与宿主回放重叠的部分（titlebar 帧见上方 early）。
      if (s.snapshot) routeSnapshot(s.snapshot, "late");

      if (s.pageRuntime && pageRuntime) {
        if (s.presenterSettings) pageRuntime.applyPresenterSettings(s.presenterSettings);
        if (s.presenter) {
          lastState.presenter = s.presenter;
          pageRuntime.instance.applySettings({
            pages: { presenters: { [id]: s.presenter } },
          });
        }
        if (s.model) pageRuntime.publishModel(s.model);
        if (s.pageEvent) pageRuntime.postEvent("event", s.pageEvent);
        if (s.pageError) pageRuntime.publishError(s.pageError);
        if (s.pageClearError) pageRuntime.clearError();
        if (s.theme) pageRuntime.postTheme(s.theme);
        if (s.show) pageRuntime.postEvent("show");
        if (typeof s.query === "string") pageRuntime.postEvent("query", s.query);
        if (s.enter) pageRuntime.postEvent("enter", s.enter);
        if (s.settings) pageRuntime.postEvent("settings", s.settings);
      }
    }, { target: WINDOW_LABEL }).then((u) => (unlisteners.push(u), undefined));

    // Re-focus: replay `show` into the page (the window never unloads, so
    // this is all a re-summon needs).
    void listen<string>("plugin-window-shown", () => {
      lastState.show = true;
      fan("show");
      pageRuntime?.postEvent("show");
    }, { target: WINDOW_LABEL }).then(
      (u) => (unlisteners.push(u), undefined)
    );

    // Rust 拦截的用户发起关闭（× / Esc / Alt+F4）：先快照再上报销毁。
    // 必须带 target：不带的话别的插件窗口的关闭请求也会打进本窗口，
    // 两个独立窗口并存时关一个会连带关掉另一个。
    void listen("plugin-window-close-requested", () => {
      closeWithSnapshot();
    }, { target: WINDOW_LABEL }).then((u) => (unlisteners.push(u), undefined));

    // Theme follows the launcher's settings while the window is open — but
    // only through the plugin's own preference, so a pinned plugin keeps its
    // mode when the launcher's changes; the permission source rides along
    // (启用/权限清单可能在窗口存续期间变化).
    void listen("settings-applied", () => {
      void invoke<SettingsData>("get_settings")
        .then((s) => {
          hostColorSetting = s.appearance?.color_mode ?? "system";
          // Re-seed: our own `theme.set` writes land in the same snapshot, so
          // this window and the launcher cannot drift apart.
          seedPluginColorPrefs(s.plugins?.color_modes);
          applyWindowTheme();
          fan("theme", effectiveMode());
          pageRuntime?.postTheme(effectiveMode());
          pageRuntime?.instance.applySettings(s);
        })
        .catch(() => {});
      void invoke<PluginManifest[]>("get_plugins")
        .then((list) => setPermissionSource((pid) => list.find((x) => x.id === pid)))
        .catch(() => {});
    }).then((u) => (unlisteners.push(u), undefined));

    // Keys: the bridge forwards non-editable keydowns here (synthetic
    // re-dispatch on this window). There is no host router in this window —
    // every forwarded key is delivered to the page as `lume.on.key`, and an
    // UNCONSUMED Esc closes the window (a page that wants Esc keeps it by
    // preventDefault-ing, the same contract as the launcher).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeWithSnapshot();
        return;
      }
      post("key", { key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });
    };
    window.addEventListener("keydown", onKey);

    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      for (const u of unlisteners) u?.();
      for (const pending of pageCalls.values()) clearTimeout(pending.timer);
      pageCalls.clear();
      clearTimeout(toastTimer);
    });
  });

  return (
    <div class="plugin-window-root">
      {/* Frameless chrome row — the pin toggle makes sense only here (a
          detached window a user keeps on top while working elsewhere). The
          slot hosts the plugin's titlebar page (optional manifest
          `titlebar` field) between the title and the window controls. */}
      <TitleBar
        title={pluginName()}
        pin
        slot={slotHost}
        onClose={() => closeWithSnapshot()}
      />
      <Dynamic component={runtimeView() ?? View} />
      <div id="plugin-window-toast" role="status" />
    </div>
  );
}

render(() => <App />, document.getElementById("root") as HTMLElement);
