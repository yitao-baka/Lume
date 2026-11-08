//! Detached Page Runtime window — the third window entry (plugin.html), the
//! host page for one api 2 mode's selected Presenter and optional titlebar
//! Presenter.
//!
//! The launcher owns the Page Service and the authoritative Page Session. This
//! window mounts a mirror session whose Presenter bridge only exposes
//! `lume.page`, theme, and shell-safe actions; service calls cross the window
//! boundary through the validated `plugin_page_bridge_call/reply` channel.
//!
//! State flow: the mirror session announces itself with `plugin_window_ready`
//! → the launcher registry pushes the model, Presenter settings and theme as a
//! `plugin-state` event → the mirror session fans each event into the main and
//! titlebar Presenter bridges. A hidden window never reloads on re-show, so
//! re-focus only needs a `plugin-window-shown` → `show` replay.

import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { Dynamic, render } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { applyPluginColorMode, normalizePluginColorMode, onThemeModeChange, resolveColorMode } from "./theme";
import { applySkin, currentSkin } from "./skins/runtime";
import { applyAccent, currentAccent } from "./skins/accent";
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
import { fetchDiskFile, pluginFilePath } from "./plugins/disk";
import { plog } from "./plugins/log";
import { resolveLocale, setLocale, t } from "./i18n";
import { exposeDebugProbe, pushBoundedDiagnostic } from "./page-runtime/diagnostics";
import { toastDurationMs } from "./launcher/toast";
import "./skins/shared.css";
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
  applySkin(cfg?.appearance?.skin ?? cfg?.appearance?.settings_skin);
  applyAccent(cfg?.appearance?.accent);

  // Titlebar label — the manifest name once plugin_window_meta answers.
  const [pluginName, setPluginName] = createSignal(id);
  const [runtimeView, setRuntimeView] = createSignal<Component | null>(null);
  const [runtimeTitlebar, setRuntimeTitlebar] = createSignal<Component | null>(null);
  const [loadError, setLoadError] = createSignal("");
  let pageRuntime: PageRuntimeMode | undefined;

  // Only the final query is needed locally for the close report. All page
  // state belongs to the launcher-owned Page Session; Presenter bridges cache
  // their own pre-handler events.
  let lastQuery: string | null = null;

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const localToast = (text: string, opts?: { undo?: () => void; duration?: number }) => {
    const el = document.getElementById("plugin-window-toast");
    if (!el) return;
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
    }, toastDurationMs(text, { undo: !!opts?.undo, duration: opts?.duration }));
  };

  // Window-local PluginServices (rpc.ts's router needs the full shape).
  // dragWindow's gate: the Presenter bridge's titlebar drag default and a
  // plugin's own §6G.5 handler (titlebar-demo's
  // grip, file-search's body listener) both land here for ONE mousedown —
  // tao posts WM_NCLBUTTONDOWN (HTCAPTION) asynchronously, so a second
  // start_dragging would start a second modal move loop after release and
  // latch the window to the cursor. One real start per gesture window.
  let lastDragAt = 0;
  const services: PluginServices = {
    showToast: (text, opts) => localToast(text, opts),
    markEntryOpened: () => {},
    // `app.hide()` hides THIS window (the plugin decides when it should go
    // away); re-open via the launcher's pill/keyword focuses it again.
    resetAndHide: () => void getCurrentWindow().hide().catch((err) => plog.error(id, "hide failed:", err)),
    detachMode: () => {
      // Already detached here: the caller IS the detached window — raise it.
      void getCurrentWindow().setFocus().catch((err) => plog.error(id, "focus failed:", err));
    },
    preview: {
      show: async (request) => {
        await invoke("show_preview", { req: request, pluginId: id });
      },
      close: async () => {
        await invoke("close_preview", { pluginId: id });
      },
    },
    setPluginColorMode: async (pluginId, mode) => {
      // Same contract as the launcher's services (docs/ROADMAP_HISTORY.md #36), but the
      // reconvergence differs: here the durable write also updates THIS
      // window's chrome, and the launcher learns about it over the Rust
      // `plugin-color-mode` event (its mirror drives the next `theme` push).
      await invoke("set_plugin_color_mode", { id: pluginId, mode });
      setPluginColorPref(pluginId, mode, "window");
      applyWindowTheme();
      pageRuntime?.postTheme(effectiveMode());
    },
    pluginColorState: (pluginId) => ({
      pref: pluginColorPref(pluginId),
      mode: effectiveMode(),
      host: resolveColorMode(hostColorSetting),
      skin: currentSkin(),
      accent: currentAccent(),
    }),
    persistLastPage: () => {},
    runSearch: async () => {
      plog.debug(id, "runSearch ignored in the detached window");
    },
    openSettings: () => {
      void invoke("open_settings").catch((err) => plog.error(id, "open settings failed:", err));
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
      // The launcher owns the Page Service. Forward the intent there, then
      // replay the query to both local Presenter bridges for pages that use
      // the event surface instead of subscribing to the model.
      lastQuery = q;
      void callDetachedService("onQuery", q).catch((err) =>
        plog.error(id, "detached query failed:", err)
      );
      pageRuntime?.postEvent("query", q);
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
      if ((window as unknown as { __LUME_DEBUG__?: boolean }).__LUME_DEBUG__ !== false) {
        w.__dragStarts = (w.__dragStarts ?? 0) + 1;
      }
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
    else if (name === "onSubInput") payload = { text: args[0] };
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
      fetchPresenter: (presenter) => fetchDiskFile(pluginFilePath(meta.dir, presenter.entry)),
      fetchTitlebar: (presenter) =>
        fetchDiskFile(pluginFilePath(meta.dir, presenter.titlebar)),
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
        if (state.presenterId) plog.debug(id, "detached Presenter:", state.presenterId);
      },
    });
    pageRuntime = runtime;
    exposeDebugProbe("__detachedPageRuntime", {
      getModel: () => runtime.currentModel() ?? null,
      getState: () => runtime.currentPresenterState() ?? null,
      getPresenter: () => runtime.currentPresenterId() ?? null,
      titlebarLive: () => runtime.titlebarLive(),
      postTitlebar: (type: string, payload: unknown) => runtime.postTitlebar(type, payload),
      dispatch: (intent: unknown) => runtime.dispatch(intent as never),
      setQuery: (query: string) => runtime.instance.setQuery(query),
    });
    setRuntimeView(() => runtime.instance.View);
    setRuntimeTitlebar(() => runtime.titlebarView);
  }

  // ── 关闭与快照（会话快照 v2，docs/ROADMAP_HISTORY.md #40）──
  // 用户发起的关闭（× / Esc / Rust 的 close-requested 应答）先向每个活帧要
  // 状态快照再上报销毁：启动器侧按帧入库，重新进入本模式时恢复。快照失败/
  // 超时也必须能关掉 —— close_report 失败时兜底走立即关闭。
  const closeWithSnapshot = () => {
    void (async () => {
      const [view, slot] = await Promise.all([
        pageRuntime?.instance.snapshot?.() ?? Promise.resolve(null),
        pageRuntime?.snapshotTitlebar() ?? Promise.resolve(null),
      ]);
      const frames: Record<string, unknown> = {};
      if (view != null) frames.view = view;
      if (slot != null) frames.titlebar = slot;
      const snapshot = { v: 2, frames };
      try {
        await invoke("plugin_window_close_report", {
          id,
          snapshot,
          query: lastQuery,
        });
      } catch (err) {
        plog.error(id, "close report failed — closing without snapshot:", err);
        void invoke("plugin_window_close_report", {
          id,
          snapshot: null,
          query: lastQuery,
        }).catch((fallbackErr) =>
          plog.error(id, "snapshot-free close report failed:", fallbackErr)
        );
      }
    })();
  };
  // The slot element is created exactly once. The Presenter switch replaces
  // only the dynamic component inside it, so the chrome row itself never
  // remounts and the drag region stays stable.
  const slotHost = (
    <div
      class="titlebar-slot-host"
      classList={{ "titlebar-slot-empty": !runtimeTitlebar() }}
    >
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

    // Resolve the Presenter declarations, then mount the mirror session.
    void invoke<{
      dir: string;
      name: string;
      pageRuntime: boolean;
      model: string;
      defaultPresenter: string;
      height: number | null;
      presenters: PluginPresenter[];
      presenterSettings: PluginPresenterSetting[];
    }>("plugin_window_meta", { id })
      .then(async (meta) => {
        document.title = meta.name || id;
        setPluginName(meta.name || id);
        if (!meta.pageRuntime || meta.presenters.length === 0) {
          throw new Error("detached window requires a page_runtime mode with a Presenter");
        }
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
        await wirePerms;
        await setupPageRuntime(meta);
      })
      .catch((err) => {
        plog.error(id, "detached Page Runtime load failed:", err);
        setLoadError(t("pluginViewLoadFailed"));
      });

    void listen<{
      show?: boolean;
      query?: string | null;
      enter?: FeatureEnterInfo | null;
      settings?: Record<string, unknown> | null;
      theme?: string | null;
      themePref?: string | null;
      skin?: string | null;
      accent?: string | null;
      surface?: string | null;
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
      plog.debug(id, "plugin-state:", {
        keys: Object.keys(s),
        presenter: s.presenter,
        presenterStatus: s.presenterStatus,
        hasModel: s.model != null,
        hasSnapshot: s.snapshot != null,
      });
      // Debug tap for the CDP verify scripts (same pattern as __plog): an
      // append-only history, since pushes interleave (shown vs enter).
      pushBoundedDiagnostic("__pluginStates", s, 64, 512 * 1024);
      // Session snapshot frames are still separate from the Page Model: the
      // titlebar frame restores before host-driven events (its input mirrors
      // the query and must not write it back), while the main frame restores
      // after model/state replay.
      const env = s.snapshot as { v?: number; frames?: Record<string, unknown> } | null | undefined;
      const frames = env?.v === 2 ? env.frames : undefined;
      if (frames?.titlebar !== undefined) pageRuntime?.postTitlebar("restore", frames.titlebar);
      // Match the launcher's established replay order: the titlebar's query
      // mirror must be current before the page receives show/enter.
      if (typeof s.query === "string") {
        lastQuery = s.query;
        // A pushed query is an input to the authoritative Page Service, then
        // an event to both local Presenters. This is the detached-window form
        // of the launcher's setQuery round-trip.
        void callDetachedService("onQuery", s.query).catch((err) =>
          plog.error(id, "detached query push failed:", err)
        );
        pageRuntime?.postEvent("query", s.query);
      }
      if (s.show) {
        pageRuntime?.postEvent("show");
      }
      if (s.enter) pageRuntime?.postEvent("enter", s.enter);
      if (s.settings) pageRuntime?.postEvent("settings", s.settings);
      if (s.skin) applySkin(s.skin);
      if (typeof s.accent === "string") applyAccent(s.accent);
      if (s.theme) {
        pageRuntime?.postTheme(s.theme);
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
      if (pageRuntime) {
        if (s.presenterSettings) pageRuntime.applyPresenterSettings(s.presenterSettings);
        if (s.presenter) {
          pageRuntime.instance.applySettings({
            pages: { presenters: { [id]: s.presenter } },
          });
        }
        if (s.model) pageRuntime.publishModel(s.model);
        if (s.pageEvent) pageRuntime.postEvent("event", s.pageEvent);
        if (s.pageError) pageRuntime.publishError(s.pageError);
        if (s.pageClearError) pageRuntime.clearError();
      }
      if (frames?.view !== undefined) pageRuntime?.postEvent("restore", frames.view);
    }, { target: WINDOW_LABEL }).then((u) => (unlisteners.push(u), undefined));

    // Re-focus: replay `show` into the page (the window never unloads, so
    // this is all a re-summon needs).
    void listen<string>("plugin-window-shown", () => {
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

    // A system light/dark flip updates this window's data-theme outside any
    // settings write. Re-push the resolved mode so the sandboxed Presenter and
    // its surface move with the chrome.
    const unlistenMode = onThemeModeChange(() => {
      pageRuntime?.postTheme(effectiveMode());
    });
    unlisteners.push(unlistenMode);

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
          applySkin(s.appearance?.skin);
          applyAccent(s.appearance?.accent);
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
        void (async () => {
          const consumed = await (pageRuntime?.instance.onEscape?.() ?? false);
          if (!consumed) closeWithSnapshot();
        })();
        return;
      }
      pageRuntime?.postEvent("key", {
        key: e.key,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
      });
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
          slot hosts the selected Presenter's optional titlebar page between
          the title and the window controls. */}
      <TitleBar
        title={pluginName()}
        pin
        slot={slotHost}
        onClose={() => closeWithSnapshot()}
      />
      <Show
        when={runtimeView()}
        fallback={
          <Show when={loadError()}>
            <div style={{ color: "#f66", padding: "16px", "font-size": "13px" }}>{loadError()}</div>
          </Show>
        }
      >
        {(view) => <Dynamic component={view()} />}
      </Show>
      <div id="plugin-window-toast" role="status" />
    </div>
  );
}

render(() => <App />, document.getElementById("root") as HTMLElement);
