//! Migration-only shell adapter around a remote api 2 Page Service and the
//! restricted Presenter bridge. The service is reached through the shared logic
//! host; the Presenter never receives its token or sensitive capabilities.

import { createSignal, onMount, Show } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { PageIntent, PageModel, PageService, PresenterDescriptor } from "../page-runtime/contracts";
import { COLLECTION_SCHEMA, type CollectionModel } from "../page-runtime/schemas";
import { PageSession } from "../page-runtime/session";
import { createPresenterBridge, type PresenterBridge } from "../page-runtime/presenterBridge";
import { normalizePluginColorMode } from "../theme";
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
  callService(name: string, ...args: unknown[]): Promise<unknown>;
  fetchPresenter(presenter: PluginPresenter): Promise<string>;
  applyTheme(mode: ReturnType<typeof normalizePluginColorMode>): Promise<void>;
}

export interface PageRuntimeMode {
  instance: ModeInstance;
  publishModel(model: PageModel): void;
  emitEvent(event: unknown): void;
  publishError(error: unknown): void;
  clearError(): void;
  dispatch(intent: PageIntent): Promise<unknown>;
  switchPresenter(presenterId: string): Promise<void>;
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
  const [modal, setModal] = createSignal(false);
  const [bridgeView, setBridgeView] = createSignal<ReturnType<typeof createPresenterBridge>["View"]>();
  const [layout, setLayout] = createSignal<{ sizing: "fit" | "fixed"; height?: number; expanded?: boolean }>({
    sizing: "fixed",
  });
  let session: PageSession | undefined;
  let bridge: PresenterBridge | undefined;
  let boot: Promise<void> | undefined;
  let started = false;
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
    presenterId: m.defaultPresenter || undefined,
    onPresenterState: (state) => {
      setModal(state.modal);
      const report = state.layout;
      if (report) {
        setLayout({
          sizing: report.sizing,
          ...(report.height != null ? { height: report.height } : {}),
          ...(report.expanded != null ? { expanded: report.expanded } : {}),
        });
      }
    },
    onModel: (model) => {
      setSelected(selectedIndex(model));
      bridge?.postModel(model);
      if (model.status !== "loading") setReady(true);
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

  async function ensureStarted(): Promise<void> {
    if (started) return;
    started = true;
    await deps.waitForService();
    await session!.start(remoteService);
  }

  function factoryFor(presenter: PresenterDescriptor) {
    return async (ctx: { model: PageModel }) => {
      const html = await presenterHtml(presenter);
      const next = createPresenterBridge({
        pageId: m.id,
        presenter,
        html,
        form: deps.form,
        session: session!,
        showToast: (text, opts) => deps.services.showToast(text, opts),
        resizeWindow: (width, height) => deps.services.resizeWindow({ width, height }),
        dragWindow: () => deps.services.dragWindow(),
        detach: () => deps.services.detachMode(m.id),
        setQuery: (q) => deps.services.setQuery(q),
        themeGet: () => deps.services.pluginColorState(m.id),
        themeSet: async (mode) => {
          const pref = normalizePluginColorMode(mode);
          if (!pref) throw new Error('theme.set expects "system", "light" or "dark"');
          await deps.applyTheme(pref);
        },
      });
      bridge = next;
      setBridgeView(() => next.View);
      next.postModel(ctx.model);
      return {
        ready: () => waitLive(next),
        update: (model: PageModel) => next.postModel(model),
        dispose: () => {},
      };
    };
  }

  async function mount(): Promise<void> {
    if (boot) return boot;
    boot = (async () => {
      await ensureStarted();
      await session!.mount((presenter) => factoryFor(presenter));
      setReady(true);
    })().catch((err) => {
      boot = undefined;
      console.error("[page-runtime] mode mount failed:", err);
      setReady(false);
      throw err;
    });
    return boot;
  }

  const View = () => {
    onMount(() => { void mount(); });
    return (
      <Show when={bridgeView()}>
        {(view) => <Dynamic component={view()} />}
      </Show>
    );
  };

  const instance: ModeInstance = {
    query,
    setQuery: (q) => {
      setQuery(q);
      void session?.setQuery(q);
    },
    search: async (q) => {
      setQuery(q);
      await session?.setQuery(q);
      deps.services.scheduleResize();
    },
    reset: () => {
      setQuery("");
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
    onKey: (_e: KeyboardEvent, _ctx: ModeKeyContext) => {
      // The Presenter receives in-page DOM keys directly. Forwarded keys are
      // replayed through lume.on.key for pages that use the semantic surface.
      return false;
    },
    openContextMenu: () => false,
    onEscape: () => false,
    modal,
    previewTarget: () => null,
    previewEnabled: () => false,
    measureViewport: () => deps.services.scheduleResize(),
    ready,
    heightPolicy: () => layout().sizing,
    anyExpanded: () => layout().expanded ?? false,
    desiredHeight: () => layout().height ?? m.height,
    pageKind: () => "main",
    restorePage: () => {},
    applySettings: () => {},
    onShow: async () => { await session?.show(); },
    onHide: async () => { await session?.hide(); },
    onEnter: (info) => { void session?.enter(info); bridge?.post("enter", info); },
    onSettings: (values) => { void session?.settings(values); bridge?.post("settings", values); },
    onFilesDropped: (paths) => { void session?.filesDropped(paths); },
    snapshot: () => bridge?.snapshot() ?? Promise.resolve(null),
    View,
  };

  return {
    instance,
    publishModel: (model) => {
      session!.publish(model);
    },
    emitEvent: (event) => { bridge?.post("event", event); },
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
    switchPresenter: async (presenterId) => {
      await ensureStarted();
      await session!.switchPresenter(presenterId, (presenter) => factoryFor(presenter));
      setReady(true);
    },
    dispose: async () => {
      await session?.dispose();
    },
  };
}
