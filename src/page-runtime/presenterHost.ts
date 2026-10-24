//! Presenter lifecycle: compatible selection, ready handshake, retry and
//! fallback. The Page Service and PageModelStore outlive every Presenter mount.

import type {
  IntentResult,
  PageIntent,
  PageLayoutReport,
  PageModel,
  PresenterDescriptor,
} from "./contracts";
import { pushDiagnostic } from "./diagnostics";
import type { PageModelStore } from "./modelStore";

export interface PresenterMountContext {
  readonly model: PageModel;
  readonly presenter: PresenterDescriptor;
  getModel(): PageModel;
  subscribe(listener: (model: PageModel) => void): () => void;
  dispatch(intent: PageIntent): Promise<IntentResult>;
  reportLayout(report: PageLayoutReport): void;
  setModal(open: boolean): void;
  requestSearchFocus(): void;
}

export interface PresenterHandle {
  ready?: Promise<void> | (() => Promise<void> | void);
  update?(model: PageModel): void;
  dispose(): void;
}

export type PresenterFactory = (
  context: PresenterMountContext
) => PresenterHandle | Promise<PresenterHandle>;

export interface PresenterHostState {
  pageId: string;
  presenterId: string | null;
  status: "idle" | "mounting" | "ready" | "error";
  attempts: number;
  error?: string;
  modal: boolean;
  layout: PageLayoutReport | null;
}

export interface MountPresenterRequest {
  pageId: string;
  presenters: PresenterDescriptor[];
  requestedId?: string;
  schema: string;
  store: PageModelStore;
  dispatch(intent: PageIntent): Promise<IntentResult>;
  factory: (presenter: PresenterDescriptor) => PresenterFactory;
  onSearchFocus?: () => void;
}

/** Pick the requested Presenter when compatible, otherwise the first
 * compatible declaration. No declaration means no mount. */
export function selectCompatiblePresenter(
  presenters: PresenterDescriptor[],
  schema: string,
  requestedId?: string
): PresenterDescriptor | null {
  const compatible = presenters.filter(
    (p) => p.models.length === 0 || p.models.includes(schema)
  );
  if (requestedId) {
    const requested = compatible.find((p) => p.id === requestedId);
    if (requested) return requested;
  }
  return compatible[0] ?? null;
}

export interface PresenterHostOptions {
  onState?: (state: PresenterHostState) => void;
  /** Tests inject known failures; production keeps diagnostics in the log. */
  logErrors?: boolean;
}

export class PresenterHost {
  private state: PresenterHostState;
  private current: PresenterHandle | null = null;
  private currentPresenter: PresenterDescriptor | null = null;
  private disposed = false;

  private readonly onStates?: (state: PresenterHostState) => void;
  private readonly logErrors: boolean;

  constructor(pageId: string, options: PresenterHostOptions = {}) {
    this.onStates = options.onState;
    this.logErrors = options.logErrors ?? true;
    this.state = {
      pageId,
      presenterId: null,
      status: "idle",
      attempts: 0,
      modal: false,
      layout: null,
    };
  }

  getState(): PresenterHostState {
    return { ...this.state, layout: this.state.layout ? { ...this.state.layout } : null };
  }

  getPresenter(): PresenterDescriptor | null {
    return this.currentPresenter;
  }

  async mount(request: MountPresenterRequest): Promise<PresenterHostState> {
    this.disposed = false;
    this.unmount();
    const compatible = request.presenters.filter(
      (p) => p.models.length === 0 || p.models.includes(request.schema)
    );
    const first = selectCompatiblePresenter(
      request.presenters,
      request.schema,
      request.requestedId
    );
    if (!first) {
      this.setState({
        status: "error",
        error: `no Presenter supports schema "${request.schema}"`,
        presenterId: null,
        attempts: 0,
      });
      return this.getState();
    }
    const ordered = [first, ...compatible.filter((p) => p.id !== first.id)];
    let attempts = 0;
    for (const presenter of ordered) {
      for (let attempt = 0; attempt < 2; attempt++) {
        attempts++;
        let handle: PresenterHandle | undefined;
        this.setState({
          presenterId: presenter.id,
          status: "mounting",
          attempts,
          error: undefined,
        });
        try {
          const model = request.store.get();
          if (!model) throw new Error("Presenter mount requires a current Page Model");
          const context: PresenterMountContext = {
            model,
            presenter,
            getModel: () => {
              const next = request.store.get();
              if (!next) throw new Error("Page Model is no longer available");
              return next;
            },
            subscribe: (listener) => request.store.subscribe(listener),
            dispatch: (intent) => request.dispatch(intent),
            reportLayout: (report) => this.reportLayout(report),
            setModal: (open) => this.setModal(open),
            requestSearchFocus: () => request.onSearchFocus?.(),
          };
          handle = await request.factory(presenter)(context);
          await (typeof handle.ready === "function" ? handle.ready() : handle.ready);
          if (this.disposed) {
            handle.dispose();
            return this.getState();
          }
          this.current = handle;
          this.currentPresenter = presenter;
          this.setState({ status: "ready", error: undefined });
          return this.getState();
        } catch (err) {
          try {
            handle?.dispose();
          } catch (disposeErr) {
            if (this.logErrors) {
              console.error(`[page-runtime] Presenter ${presenter.id} cleanup failed:`, disposeErr);
            }
          }
          const message = String(err);
          if (this.logErrors) console.error(`[page-runtime] Presenter ${presenter.id} failed:`, err);
          this.setState({ status: "error", error: message });
          await Promise.resolve();
        }
      }
    }
    this.setState({
      status: "error",
      presenterId: null,
      error: `all Presenters failed after ${attempts} attempts`,
    });
    return this.getState();
  }

  updateModel(model: PageModel): void {
    if (this.state.status !== "ready") return;
    try {
      this.current?.update?.(model);
    } catch (err) {
      if (this.logErrors) console.error("[page-runtime] Presenter update failed:", err);
      this.setState({ status: "error", error: String(err) });
    }
  }

  reportLayout(report: PageLayoutReport): void {
    this.setState({ layout: { ...report } });
  }

  setModal(open: boolean): void {
    this.setState({ modal: open });
  }

  unmount(): void {
    try {
      this.current?.dispose();
    } catch (err) {
      if (this.logErrors) console.error("[page-runtime] Presenter dispose failed:", err);
    }
    this.current = null;
    this.currentPresenter = null;
  }

  dispose(): void {
    this.disposed = true;
    this.unmount();
  }

  private setState(patch: Partial<PresenterHostState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    pushDiagnostic("__presenterStates", snapshot);
    this.onStates?.(snapshot);
  }
}

