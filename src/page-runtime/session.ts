//! Page Session: one page id owns a Page Service, authoritative model,
//! intent router and replaceable Presenter. Switching Presenters never
//! recreates the service or store.

import type {
  IntentResult,
  PageEvent,
  PageIntent,
  PageLayoutReport,
  PageModel,
  PageService,
  PresenterDescriptor,
} from "./contracts";
import { pushDiagnostic } from "./diagnostics";
import { IntentRouter } from "./intents";
import { PageModelStore, type ModelStoreOptions } from "./modelStore";
import { PresenterHost, type PresenterFactory, type PresenterHostState } from "./presenterHost";

export interface PageSessionOptions {
  pageId: string;
  schema: string;
  presenters: PresenterDescriptor[];
  presenterId?: string;
  modelStore?: ModelStoreOptions;
  onPresenterState?: (state: PresenterHostState) => void;
  onModel?: (model: PageModel) => void;
}

export interface PageSessionSnapshot {
  pageId: string;
  schema: string;
  presenter: PresenterHostState;
  model: ReturnType<PageModelStore["meta"]>;
  query: string;
}

export class PageSession {
  readonly pageId: string;
  readonly schema: string;
  readonly presenters: PresenterDescriptor[];
  readonly store: PageModelStore;
  readonly presenterHost: PresenterHost;
  private service: PageService | null = null;
  private presenterId: string | undefined;
  private readonly router: IntentRouter;
  private query = "";
  private destroyed = false;
  private readonly unsubscribeModel: () => void;

  constructor(options: PageSessionOptions) {
    this.pageId = options.pageId;
    this.schema = options.schema;
    this.presenters = [...options.presenters];
    this.presenterId = options.presenterId;
    this.store = new PageModelStore(options.pageId, options.modelStore);
    this.presenterHost = new PresenterHost(options.pageId, { onState: options.onPresenterState });
    this.unsubscribeModel = this.store.subscribe((model) => options.onModel?.(model));
    this.router = new IntentRouter(options.pageId, async (intent) => {
      if (!this.service) {
        return { status: "failed", code: "service.missing", message: "Page Service is not ready" };
      }
      if (!this.service.onIntent) return { status: "accepted" };
      return this.service.onIntent(intent);
    });
  }

  async start(service: PageService): Promise<PageModel> {
    if (this.destroyed) throw new Error("Page Session was destroyed");
    this.service = service;
    const model = await service.getModel();
    const published = this.store.publish(model);
    this.traceModel(published);
    return published;
  }

  async mount(
    factory: (presenter: PresenterDescriptor) => PresenterFactory
  ): Promise<PresenterHostState> {
    return this.presenterHost.mount({
      pageId: this.pageId,
      presenters: this.presenters,
      requestedId: this.presenterId,
      schema: this.schema,
      store: this.store,
      dispatch: (intent) => this.dispatch(intent),
      factory,
      onSearchFocus: () => document.getElementById("search-input")?.focus(),
    });
  }

  /** Choose the Presenter for the next mount without mounting it yet. */
  setRequestedPresenter(presenterId: string): void {
    if (!this.presenters.some((p) => p.id === presenterId)) {
      throw new Error(`unknown Presenter "${presenterId}"`);
    }
    this.presenterId = presenterId;
  }

  async switchPresenter(
    presenterId: string,
    factory: (presenter: PresenterDescriptor) => PresenterFactory
  ): Promise<PresenterHostState> {
    this.setRequestedPresenter(presenterId);
    return this.mount(factory);
  }

  async dispatch(intent: PageIntent): Promise<IntentResult> {
    const model = this.store.get();
    if (!model) {
      return {
        requestId: intent.requestId,
        status: "failed",
        code: "model.missing",
        message: "Page Model is not ready",
      };
    }
    return this.router.dispatch(intent, model);
  }

  publish(model: PageModel): PageModel {
    const published = this.store.publish(model);
    this.traceModel(published);
    this.presenterHost.updateModel(published);
    return published;
  }

  emit(event: PageEvent): void {
    pushDiagnostic("__pageIntents", {
      pageId: this.pageId,
      event: event.type,
      requestId: event.requestId,
    });
  }

  async setQuery(query: string): Promise<void> {
    this.query = query;
    await this.service?.onQuery?.(query);
  }

  async show(): Promise<void> { await this.service?.onShow?.(); }
  async hide(): Promise<void> { await this.service?.onHide?.(); }
  async enter(info: unknown): Promise<void> { await this.service?.onEnter?.(info); }
  async filesDropped(paths: string[]): Promise<void> { await this.service?.onFilesDropped?.(paths); }
  async settings(values: Record<string, unknown>): Promise<void> { await this.service?.onSettings?.(values); }
  layout(report: PageLayoutReport): void { this.presenterHost.reportLayout(report); }
  setModal(open: boolean): void { this.presenterHost.setModal(open); }

  snapshot(): PageSessionSnapshot {
    return {
      pageId: this.pageId,
      schema: this.schema,
      presenter: this.presenterHost.getState(),
      model: this.store.meta(),
      query: this.query,
    };
  }

  async dispose(): Promise<void> {
    this.destroyed = true;
    this.presenterHost.dispose();
    await this.service?.dispose?.();
    this.service = null;
    this.unsubscribeModel();
    this.store.dispose();
  }

  private traceModel(model: PageModel): void {
    pushDiagnostic("__pageModels", {
      pageId: this.pageId,
      schema: model.schema,
      revision: model.revision,
      status: model.status,
      bytes: this.store.meta()?.bytes,
    });
  }
}
