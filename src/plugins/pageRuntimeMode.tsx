//! Migration-only shell adapter around a remote api 2 Page Service and the
//! restricted Presenter bridge. The service is reached through the shared logic
//! host; the Presenter never receives its token or sensitive capabilities.

import { createSignal, onMount, Show, type Component } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { Dynamic } from "solid-js/web";
import type { PageIntent, PageModel, PageService, PresenterDescriptor } from "../page-runtime/contracts";
import { COLLECTION_SCHEMA, type CollectionModel } from "../page-runtime/schemas";
import { PageSession } from "../page-runtime/session";
import { createPresenterBridge, type PresenterBridge } from "../page-runtime/presenterBridge";
import type { PageLayoutReport } from "../page-runtime/contracts";
import { dropSessionFrames, takeSessionFrames } from "../launcher/session";
import { normalizePluginColorMode } from "../theme";
import { currentSkin, currentSurface, currentSurfaceToneFor } from "../skins/runtime";
import { currentAccent } from "../skins/accent";

import { t } from "../i18n";
import { assertPermission } from "./permissions";
import type {
  ModeInstance,
  ModeKeyContext,
  PluginManifest,
  PluginPresenter,
  PluginServices,
} from "./types";

export interface PageRuntimeModeDeps {
  manifest: PluginManifest;
  services: PluginServices;
  form: "launcher" | "window";
  waitForService(): Promise<void>;
  restartService?(): Promise<void>;
  callService(name: string, ...args: unknown[]): Promise<unknown>;
  fetchPresenter(presenter: PluginPresenter): Promise<string>;
  fetchTitlebar?(presenter: PluginPresenter): Promise<string>;
  applyTheme(mode: ReturnType<typeof normalizePluginColorMode>): Promise<void>;
  initialPresenterId?: string;
  onModel?: (model: PageModel) => void;
  onPresenterState?: (state: ReturnType<PageSession["snapshot"]>["presenter"]) => void;
  onReady?: () => void;
}

export interface PageRuntimeMode {
  instance: ModeInstance;
  publishModel(model: PageModel): void;
  emitEvent(event: unknown): void;
  publishError(error: unknown): void;
  clearError(): void;
  dispatch(intent: PageIntent): Promise<unknown>;
  callRemote(name: string, args: Record<string, unknown>): Promise<unknown>;
  currentModel(): PageModel | undefined;
  currentPresenterId(): string | undefined;
  currentPresenterState(): ReturnType<PageSession["snapshot"]>["presenter"] | undefined;
  currentPresenterSettings(): Record<string, Record<string, unknown>>;
  titlebarView: Component;
  titlebarAvailable: () => boolean;
  snapshotTitlebar(): Promise<unknown | null>;
  titlebarLive: () => boolean;
  postTitlebar(type: string, payload?: unknown): void;
  postEvent(type: string, payload?: unknown): void;
  postTheme(mode: string): void;
  switchPresenter(presenterId: string): Promise<void>;
  applyPresenterSettings(values: Record<string, Record<string, unknown>>): void;
  dispose(): Promise<void>;
}

function presentersOf(m: PluginManifest): PresenterDescriptor[] {
  return m.presenters.map((p) => ({
    id: p.id,
    name: p.name || p.id,
    models: p.models.length ? p.models : [m.model],
    ...(p.titlebar ? { titlebar: p.titlebar } : {}),
  }));
}

function selectedIndex(model: PageModel | undefined): number {
  if (!model?.selection?.primaryId) return 0;
  const data = model.data as Partial<CollectionModel>;
  const items = data.items ?? data.groups?.flatMap((g) => g.items) ?? [];
  const idx = items.findIndex((item) => item.id === model.selection?.primaryId);
  return idx >= 0 ? idx : 0;
}

function selectedId(model: PageModel | undefined, index: number): string | undefined {
  const data = model?.data as Partial<CollectionModel> | undefined;
  const items = data?.items ?? data?.groups?.flatMap((g) => g.items) ?? [];
  return items[index]?.id;
}

export function createPageRuntimeMode(deps: PageRuntimeModeDeps): PageRuntimeMode {
  const m = deps.manifest;
  const [query, setQuery] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [ready, setReady] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  const [mountError, setMountError] = createSignal("");
  const [modal, setModal] = createSignal(false);
  const [bridgeView, setBridgeView] = createSignal<ReturnType<typeof createPresenterBridge>["View"]>();
  const [titlebarView, setTitlebarView] = createSignal<Component>();
  const [layout, setLayout] = createSignal<PageLayoutReport>({ sizing: "fixed" });
  let session: PageSession | undefined;
  let bridge: PresenterBridge | undefined;
  let titlebarBridge: PresenterBridge | undefined;
  let boot: Promise<void> | undefined;
  let startPromise: Promise<void> | undefined;
  let serviceStarted = false;
  let needsServiceRestart = false;
  let lastMountAttempt = 0;
  let pendingQuery: string | null = null;
  let pendingShow: boolean | null = null;
  let pendingSettings: Record<string, unknown> | null = null;
  let pendingFilesDropped: string[] | null = null;
  let pendingEnter: { has: boolean; info?: unknown } = { has: false };
  let pendingPresenterEnter: { has: boolean; info?: unknown } = { has: false };
  let pendingPresenterSettings: Record<string, unknown> | null = null;
  let lifecycleGeneration = 0;
  let presenterSettings: Record<string, Record<string, unknown>> = {};
  const htmlCache = new Map<string, string>();

  const remoteService: PageService = {
    async getModel() {
      const model = (await deps.callService("getModel")) as PageModel;
      if (!model) throw new Error("Page Service getModel returned no model");
      return model;
    },
    async onIntent(intent: PageIntent) {
      const result = await deps.callService("onIntent", intent);
      return (result as never) ?? { status: "accepted" };
    },
    onQuery: async (q) => { await deps.callService("onQuery", q); },
    onSubInput: async (text) => { await deps.callService("onSubInput", text); },
    onShow: async () => { await deps.callService("onShow"); },
    onHide: async () => { await deps.callService("onHide"); },
    onEnter: async (info) => { await deps.callService("onEnter", info); },
    onFilesDropped: async (paths) => { await deps.callService("onFilesDropped", paths); },
    onSettings: async (values) => { await deps.callService("onSettings", values); },
  };

  session = new PageSession({
    pageId: m.id,
    schema: m.model || COLLECTION_SCHEMA,
    presenters: presentersOf(m),
    presenterId: deps.initialPresenterId || m.defaultPresenter || undefined,
    onPresenterState: (state) => {
      deps.onPresenterState?.(state);
      setModal(state.modal);
      const report = state.layout;
      if (report) {
        setLayout({
          sizing: report.sizing,
          ...(report.contentHeight != null ? { contentHeight: report.contentHeight } : {}),
          ...(report.height != null ? { height: report.height } : {}),
          ...(report.expanded != null ? { expanded: report.expanded } : {}),
        });
      } else {
        // Presenter-owned layout is scoped to that Presenter generation. A
        // replacement that has not reported yet must use the page default,
        // never the old Presenter's height.
        setLayout({ sizing: "fixed" });
      }
    },
    onModel: (model) => {
      setSelected(selectedIndex(model));
      deps.onModel?.(model);
      bridge?.postModel(model);
      titlebarBridge?.postModel(model);
    },
  });

  async function presenterHtml(presenter: PresenterDescriptor): Promise<string> {
    const declared = m.presenters.find((p) => p.id === presenter.id) ?? m.presenters[0];
    if (!declared) throw new Error("Presenter declaration missing");
    const cached = htmlCache.get(declared.id);
    if (cached !== undefined) return cached;
    const html = await deps.fetchPresenter(declared);
    htmlCache.set(declared.id, html);
    return html;
  }

  async function waitLive(candidate: PresenterBridge): Promise<void> {
    const startedAt = Date.now();
    while (!candidate.live()) {
      if (Date.now() - startedAt > 5000) throw new Error("Presenter bridge did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  /** Replay service lifecycle events in contract order after a slow first
   * getModel(). Taking the snapshot before awaiting lets new input update the
   * next slot instead of being dropped behind this flush. */
  async function flushPendingLifecycle(): Promise<void> {
    if (!serviceStarted || !session) return;
    const generation = lifecycleGeneration;
    const query = pendingQuery;
    const show = pendingShow;
    const settings = pendingSettings;
    const files = pendingFilesDropped;
    const enter = pendingEnter;
    pendingQuery = null;
    pendingShow = null;
    pendingSettings = null;
    pendingFilesDropped = null;
    pendingEnter = { has: false };

    if (query !== null) await session.setQuery(query);
    if (generation !== lifecycleGeneration) return;
    if (settings !== null) await session.settings(settings);
    if (generation !== lifecycleGeneration) return;
    if (files !== null) await session.filesDropped(files);
    if (generation !== lifecycleGeneration) return;
    if (show === true) await session.show();
    else if (show === false) await session.hide();
    if (generation !== lifecycleGeneration) return;
    if (enter.has) await session.enter(enter.info);
  }

  async function ensureStarted(): Promise<void> {
    if (serviceStarted) return;
    if (startPromise) return startPromise;
    const generation = lifecycleGeneration;
    const attempt = (async () => {
      if (needsServiceRestart && deps.restartService) {
        await deps.restartService();
        needsServiceRestart = false;
      }
      try {
        await deps.waitForService();
      } catch (error) {
        needsServiceRestart = Boolean(deps.restartService);
        throw error;
      }
      await session!.start(remoteService);
      if (generation !== lifecycleGeneration) return;
      serviceStarted = true;
      await flushPendingLifecycle();
    })();
    startPromise = attempt;
    try {
      await attempt;
    } finally {
      if (startPromise === attempt) startPromise = undefined;
    }
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  function markMountFailed(error: unknown): void {
    setReady(false);
    setFailed(true);
    setMountError(errorMessage(error).slice(0, 2000));
  }

  function retryMount(): void {
    void mount(true).catch(() => {});
  }

  /** Retry failed pages on re-activation/search, but never spin on every
   * keystroke. Explicit retry bypasses this backoff. */
  function retryIfDue(): void {
    if (!failed() || boot) return;
    if (Date.now() - lastMountAttempt < 1000) return;
    void mount().catch(() => {});
  }

  function bridgeOptions(
    declared: PluginPresenter,
    descriptor: PresenterDescriptor,
    html: string,
    titlebar = false
  ) {
    return {
      pageId: m.id,
      presenter: descriptor,
      html,
      form: deps.form,
      session: session!,
      titlebar,
      iframeClass: titlebar ? "titlebar-frame" : "plugin-frame presenter-frame",
      showToast: (text: string, opts?: { undo?: () => void; duration?: number }) =>
        deps.services.showToast(text, opts),
      resizeWindow: (width?: number, height?: number) =>
        deps.services.resizeWindow({ width, height }),
      dragWindow: () => deps.services.dragWindow(),
      detach: () => deps.services.detachMode(m.id),
      setQuery: (q: string) => deps.services.setQuery(q),
      readFileText: async (path: string) => {
        assertPermission(m.id, "fs.readText");
        return invoke<string>("get_file_text", { path, pluginId: m.id });
      },
      readFileBytes: async (path: string) => {
        assertPermission(m.id, "fs.bytes");
        return invoke<string>("get_file_bytes", { path, pluginId: m.id });
      },
      preview: {
        show: (request: Parameters<typeof deps.services.preview.show>[0]) =>
          deps.services.preview.show(request, m.id),
        close: () => deps.services.preview.close(m.id),
      },
      themeGet: () => deps.services.pluginColorState(m.id),
      themeSet: async (mode: unknown) => {
        const pref = normalizePluginColorMode(mode);
        if (!pref) throw new Error('theme.set expects "system", "light" or "dark"');
        await deps.applyTheme(pref);
      },
      settings: () => presenterSettings[declared.id] ?? {},
      // The launcher restores a saved frame only after the replacement
      // Presenter is live. Detached windows receive their frames from the
      // authoritative launcher through plugin-state instead.
      ...(deps.form === "launcher" && !titlebar
        ? { takeSnapshot: () => takeSessionFrames(m.id, ["view"])?.view ?? null }
        : {}),
    };
  }

  function factoryFor(presenter: PresenterDescriptor) {
    return async (ctx: { model: PageModel }) => {
      const declared = m.presenters.find((item) => item.id === presenter.id) ?? m.presenters[0];
      if (!declared) throw new Error("Presenter declaration missing");
      const html = await presenterHtml(presenter);
      const next = createPresenterBridge(bridgeOptions(declared, presenter, html));
      bridge = next;
      titlebarBridge = undefined;
      setTitlebarView(undefined);
      setBridgeView(() => next.View);

      if (deps.form === "window" && declared.titlebar && deps.fetchTitlebar) {
        try {
          const titlebarKey = declared.id + ":titlebar";
          let titlebarHtml = htmlCache.get(titlebarKey);
          if (titlebarHtml === undefined) {
            titlebarHtml = await deps.fetchTitlebar(declared);
            htmlCache.set(titlebarKey, titlebarHtml);
          }
          const titlebarDescriptor: PresenterDescriptor = {
            ...presenter,
            id: presenter.id + ":titlebar",
          };
          const titlebar = createPresenterBridge(
            bridgeOptions(declared, titlebarDescriptor, titlebarHtml, true)
          );
          titlebarBridge = titlebar;
          setTitlebarView(() => titlebar.View);
          titlebar.postModel(ctx.model);
        } catch (err) {
          console.error("[page-runtime] titlebar Presenter load failed:", err);
        }
      }

      if (pendingPresenterSettings !== null) {
        next.post("settings", pendingPresenterSettings);
        titlebarBridge?.post("settings", pendingPresenterSettings);
        pendingPresenterSettings = null;
      }
      if (pendingPresenterEnter.has) {
        next.post("enter", pendingPresenterEnter.info);
        titlebarBridge?.post("enter", pendingPresenterEnter.info);
        pendingPresenterEnter = { has: false };
      }
      next.postModel(ctx.model);
      return {
        ready: async () => {
          await waitLive(next);
          if (titlebarBridge) await waitLive(titlebarBridge);
        },
        update: (model: PageModel) => {
          next.postModel(model);
          titlebarBridge?.postModel(model);
        },
        dispose: () => {},
      };
    };
  }

  function mount(force = false): Promise<void> {
    if (ready()) return Promise.resolve();
    if (boot) return boot;
    if (!force && failed() && Date.now() - lastMountAttempt < 1000) return Promise.resolve();
    lastMountAttempt = Date.now();
    setReady(false);
    setFailed(false);
    setMountError("");
    const attempt = (async () => {
      await ensureStarted();
      const state = await session!.mount((presenter) => factoryFor(presenter));
      if (state.status !== "ready") {
        throw new Error(state.error || "Presenter failed to mount");
      }
      setFailed(false);
      setMountError("");
      setReady(true);
      deps.onReady?.();
    })()
      .catch((err) => {
        console.error("[page-runtime] mode mount failed:", err);
        markMountFailed(err);
        throw err;
      })
      .finally(() => {
        if (boot === attempt) boot = undefined;
      });
    boot = attempt;
    return attempt;
  }

  const View = () => {
    onMount(() => { void mount().catch(() => {}); });
    return (
      <Show
        when={!failed()}
        fallback={
          <div class="presenter-error" role="alert">
            <div class="presenter-error-title">{t("pluginViewLoadFailed")}</div>
            <Show when={mountError()}>
              <div class="presenter-error-detail">{mountError()}</div>
            </Show>
            <button class="presenter-error-retry" type="button" onClick={retryMount}>
              {t("settingsRetry")}
            </button>
          </div>
        }
      >
        <Show when={bridgeView()}>
          {(view) => <Dynamic component={view()} />}
        </Show>
      </Show>
    );
  };

  const TitlebarView = () => (
    <Show when={titlebarView()}>
      {(view) => <Dynamic component={view()} />}
    </Show>
  );

  const postBoth = (type: string, payload?: unknown) => {
    bridge?.post(type, payload);
    titlebarBridge?.post(type, payload);
  };

  const instance: ModeInstance = {
    query,
    setQuery: (q) => {
      // Mirror only; the shell's runSearch() invokes search() once after
      // handleQuery interception has had a chance to claim the keystroke.
      setQuery(q);
    },
    search: async (q) => {
      setQuery(q);
      pendingQuery = q;
      if (!ready()) {
        if (failed()) retryIfDue();
        else void mount().catch(() => {});
      }
      if (serviceStarted) {
        pendingQuery = null;
        await session?.setQuery(q);
      }
      postBoth("query", q);
      deps.services.scheduleResize();
    },
    reset: () => {
      // Summon reset is page-state scoped; the session query is preserved
      // unless the shell explicitly calls setQuery("") (idle reset / user input).
      setSelected(0);
    },
    selected,
    setSelected: (index) => {
      setSelected(index);
      const id = selectedId(session?.store.get(), index);
      if (id) void session?.dispatch({ type: "selection.set", payload: { selectedIds: [id] } });
    },
    rows: () => [],
    activate: () => {
      const model = session?.store.get();
      const id = selectedId(model, selected());
      if (id) void session?.dispatch({ type: "item.activate", targetId: id });
    },
    onSubInput: (text) => {
      void session?.subInput(text);
    },
    onKey: (e: KeyboardEvent, _ctx: ModeKeyContext) => {
      // The Presenter already saw the original DOM key (the in-frame bridge
      // waits one task so page bubble handlers can preventDefault first).
      // Once forwarded, the page owns the key: returning true prevents the
      // shell's late arrow/Enter fallback from racing lume.on.key.
      if (!bridge?.live()) return false;
      bridge.post("key", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        metaKey: e.metaKey,
      });
      return true;
    },
    openContextMenu: () => false,
    onEscape: async () => {
      if (!bridge?.live()) return false;
      return bridge.requestKey({
        key: "Escape",
        code: "Escape",
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
      });
    },
    modal,
    measureViewport: () => deps.services.scheduleResize(),
    ready,
    failed,
    heightPolicy: () => layout().sizing,
    anyExpanded: () => layout().expanded ?? false,
    desiredHeight: () => layout().height ?? m.height,
    fitContentHeight: () => layout().contentHeight ?? null,
    pageKind: () => "main",
    restorePage: () => {},
    applySettings: (settings) => {
      const chosen = (settings as { pages?: { presenters?: Record<string, string> } })
        .pages?.presenters?.[m.id];
      if (!chosen || !m.presenters.some((presenter) => presenter.id === chosen)) return;
      const current = session?.snapshot().presenter;
      if (current?.presenterId === chosen) return;
      if (!current || current.status === "idle") {
        session?.setRequestedPresenter(chosen);
      } else {
        void session
          ?.switchPresenter(chosen, (presenter) => factoryFor(presenter))
          .then((state) => {
            if (state.status !== "ready") throw new Error(state.error || "Presenter failed to mount");
            setFailed(false);
            setMountError("");
            setReady(true);
          })
          .catch(markMountFailed);
      }
    },
    onShow: async () => {
      retryIfDue();
      pendingShow = true;
      postBoth("show");
      if (serviceStarted) {
        pendingShow = null;
        await session?.show();
      } else if (startPromise) {
        await startPromise;
      }
    },
    onHide: async () => {
      pendingShow = false;
      postBoth("hide");
      if (serviceStarted) {
        pendingShow = null;
        await session?.hide();
      } else if (startPromise) {
        await startPromise;
      }
    },
    onEnter: (info) => {
      // A new declarative entry is a new page session payload: stale
      // view/titlebar frames from the previous visit must not overwrite it.
      dropSessionFrames(m.id);
      pendingEnter = { has: true, info };
      pendingPresenterEnter = { has: true, info };
      postBoth("enter", info);
      if (bridge || titlebarBridge) pendingPresenterEnter = { has: false };
      if (serviceStarted) {
        pendingEnter = { has: false };
        void session?.enter(info).catch((err) => console.error("[page-runtime] onEnter failed:", err));
      } else {
        void ensureStarted().catch((err) => console.error("[page-runtime] onEnter start failed:", err));
      }
    },
    onSettings: (values) => {
      pendingSettings = values;
      pendingPresenterSettings = values;
      postBoth("settings", values);
      if (bridge || titlebarBridge) pendingPresenterSettings = null;
      if (serviceStarted) {
        pendingSettings = null;
        void session?.settings(values).catch((err) => console.error("[page-runtime] onSettings failed:", err));
      }
    },
    onFilesDropped: (paths) => {
      pendingFilesDropped = paths;
      if (serviceStarted) {
        pendingFilesDropped = null;
        void session?.filesDropped(paths).catch((err) => console.error("[page-runtime] onFilesDropped failed:", err));
      }
    },
    snapshot: () => bridge?.snapshot() ?? Promise.resolve(null),
    View,
  };

  return {
    instance,
    publishModel: (model) => {
      session!.publish(model);
    },
    emitEvent: (event) => { postBoth("event", event); },
    publishError: (error) => {
      const model = session?.store.get();
      if (model) {
        session!.publish({
          ...model,
          revision: model.revision + 1,
          status: "error",
          error: error as PageModel["error"],
        });
      }
    },
    clearError: () => {
      const model = session?.store.get();
      if (model?.error) {
        const next = { ...model };
        delete next.error;
        session!.publish({ ...next, revision: model.revision + 1, status: "ready" });
      }
    },
    dispatch: (intent) => session!.dispatch(intent),
    callRemote: async (name, args) => {
      if (name === "getModel") {
        const current = session?.store.get();
        if (current) return current;
      }
      await ensureStarted();
      switch (name) {
        case "getModel":
          return session!.store.get() ?? null;
        case "onIntent":
          return session!.dispatch(args.intent as PageIntent);
        case "onQuery":
          await session!.setQuery(String(args.query ?? ""));
          return null;
        case "onSubInput":
          await session!.subInput(String(args.text ?? ""));
          return null;
        case "onShow":
          await session!.show();
          return null;
        case "onHide":
          await session!.hide();
          return null;
        case "onEnter":
          dropSessionFrames(m.id);
          await session!.enter(args.info);
          return null;
        case "onSettings":
          await session!.settings((args.values as Record<string, unknown>) ?? {});
          return null;
        case "onFilesDropped":
          await session!.filesDropped((args.paths as string[]) ?? []);
          return null;
        default:
          throw new Error(`unsupported Page Service operation "${name}"`);
      }
    },
    currentModel: () => session?.store.get(),
    currentPresenterId: () => session?.snapshot().presenter.presenterId ?? undefined,
    currentPresenterState: () => session?.snapshot().presenter,
    currentPresenterSettings: () => presenterSettings,
    titlebarView: TitlebarView,
    titlebarAvailable: () => Boolean(titlebarView()),
    snapshotTitlebar: () => titlebarBridge?.snapshot() ?? Promise.resolve(null),
    titlebarLive: () => titlebarBridge?.live() ?? false,
    postTitlebar: (type, payload) => titlebarBridge?.post(type, payload),
    postEvent: (type, payload) => postBoth(type, payload),
    postTheme: (mode) => {
      const resolved = mode === "light" ? "light" : "dark";
      postBoth("theme", currentSurfaceToneFor(resolved));
      const skin = currentSkin();
      const visual = {
        id: skin,
        accent: currentAccent(),
        surface: currentSurface(resolved),
      };
      postBoth("skin", visual);
      const probe = window as unknown as {
        __presenterThemes?: unknown[];
        __presenterSkins?: unknown[];
      };
      (probe.__presenterThemes ??= []).push({ pageId: m.id, mode });
      (probe.__presenterSkins ??= []).push({ pageId: m.id, ...visual });
    },
    switchPresenter: async (presenterId) => {
      if (!m.presenters.some((presenter) => presenter.id === presenterId)) {
        throw new Error(`unknown Presenter "${presenterId}"`);
      }
      if (!serviceStarted) {
        session!.setRequestedPresenter(presenterId);
        return;
      }
      const state = await session!.switchPresenter(presenterId, (presenter) => factoryFor(presenter));
      if (state.status !== "ready") throw new Error(state.error || "Presenter failed to mount");
      setFailed(false);
      setMountError("");
      setReady(true);
    },
    applyPresenterSettings: (values) => {
      presenterSettings = values;
      const presenterId = session?.snapshot().presenter.presenterId;
      const delivered = presenterId ? presenterSettings[presenterId] ?? {} : {};
      if (presenterId) postBoth("settings", delivered);
      const probe = window as unknown as { __presenterSettings?: unknown[] };
      (probe.__presenterSettings ??= []).push({
        pageId: m.id,
        presenterId,
        values: delivered,
        live: bridge?.live() ?? false,
      });
    },
    dispose: async () => {
      lifecycleGeneration++;
      pendingQuery = null;
      pendingShow = null;
      pendingSettings = null;
      pendingFilesDropped = null;
      pendingEnter = { has: false };
      pendingPresenterEnter = { has: false };
      pendingPresenterSettings = null;
      bridge = undefined;
      titlebarBridge = undefined;
      await session?.dispose();
    },
  };
}
