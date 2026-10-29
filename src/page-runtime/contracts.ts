//! Framework-neutral contracts for the Page Model / Presenter runtime.
//!
//! Everything crossing the Service → Host → Presenter boundary is plain JSON.
//! Presenters receive read-only snapshots and return semantic intents; they
//! never receive function values, DOM nodes, Solid signals or Tauri commands.

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

/** The runtime protocol version carried by every page snapshot. */
export const PAGE_RUNTIME = "lume.page/v1" as const;
export type PageRuntime = typeof PAGE_RUNTIME;

export type PageStatus = "loading" | "ready" | "empty" | "error";

export interface PageAction {
  id: string;
  label: string;
  kind?: "default" | "primary" | "danger";
  shortcut?: string;
  enabled?: boolean;
}

export interface ResourceRef {
  kind: "url" | "asset" | "file-icon" | "thumbnail";
  src: string;
  light?: string;
  dark?: string;
  width?: number;
  height?: number;
  alt?: string;
}

/** The preview payload accepted by the core host. Content-only by design:
 * the renderer never injects HTML. */
export interface PagePreviewRequest {
  kind: "text" | "textfile" | "image" | "audio" | "video" | "pdf" | "filelist";
  content?: string | null;
  path?: string | null;
  id?: number | null;
  paths?: string[] | null;
  checked?: number[] | null;
  remember_checks?: boolean;
}

export interface PagePreview {
  kind: "text" | "textfile" | "image" | "file" | "filelist" | "audio" | "video" | "pdf";
  targetId: string;
  payload: JsonValue;
}

export interface PageSelection {
  primaryId?: string;
  selectedIds?: string[];
}

export interface PageError {
  code: string;
  message: string;
  retryable?: boolean;
}

export interface PageModel<Data extends JsonValue = JsonValue> {
  runtime: PageRuntime;
  schema: string;
  revision: number;
  status: PageStatus;
  data: Data;
  selection?: PageSelection;
  actions?: PageAction[];
  preview?: PagePreview | null;
  error?: PageError;
}

export interface PageIntent {
  requestId?: string;
  type: string;
  targetId?: string;
  actionId?: string;
  payload?: JsonValue;
}

export interface IntentResult {
  requestId?: string;
  status: "accepted" | "completed" | "failed";
  code?: string;
  message?: string;
  value?: JsonValue;
}

export interface PageEvent {
  type: string;
  requestId?: string;
  payload?: JsonValue;
}

export interface PageLayoutReport {
  sizing: "fit" | "fixed";
  contentHeight?: number;
  height?: number;
  expanded?: boolean;
}

export interface PresenterDescriptor {
  id: string;
  name: string;
  models: string[];
  titlebar?: string;
  builtin?: boolean;
}

/** Presenter-safe surface. Network, storage, DB, filesystem, clipboard,
 * dialogs, search and secrets are deliberately absent. */
export interface PresenterHostApi {
  ready(): Promise<void>;
  getModel(): Promise<PageModel>;
  subscribe(handler: (model: PageModel) => void): () => void;
  dispatch(intent: PageIntent): Promise<IntentResult>;
  reportLayout(report: PageLayoutReport): Promise<void>;
  setModal(open: boolean): Promise<void>;
  requestSearchFocus(): Promise<void>;
  /** Show the core preview host / dismiss it. Presenters cannot reach the
   * raw Tauri command surface. */
  preview(request: PagePreviewRequest): Promise<void>;
  closePreview(): Promise<void>;
}

/** The Page Service receives the service-only capabilities. The concrete
 * capability groups are supplied by the plugin host; this interface names the
 * page-specific coordinates without coupling the runtime to Tauri. */
export interface PageServiceContext<Capabilities = unknown> {
  page: {
    publish(model: PageModel): void;
    patch(update: Partial<PageModel>): void;
    emit(event: PageEvent): void;
    setError(error: PageError): void;
    clearError(): void;
  };
  capabilities: Capabilities;
}

export interface PageService {
  getModel(): PageModel | Promise<PageModel>;
  onIntent?(intent: PageIntent): IntentResult | Promise<IntentResult>;
  onQuery?(query: string): void | Promise<void>;
  onSubInput?(text: string): void | Promise<void>;
  onShow?(): void | Promise<void>;
  onHide?(): void | Promise<void>;
  onEnter?(info: unknown): void | Promise<void>;
  onFilesDropped?(paths: string[]): void | Promise<void>;
  onSettings?(values: Record<string, unknown>): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

export type PageServiceFactory = (
  context: PageServiceContext
) => PageService | Promise<PageService>;

/** Intents every Presenter may emit. Domain verbs belong in `item.action`
 * with an `actionId` declared by the current Page Model. */
export const STANDARD_INTENTS = [
  "selection.set",
  "selection.move",
  "selection.clear",
  "item.activate",
  "item.action",
  "query.submit",
  "page.refresh",
  "page.cancel",
  "page.escape",
  "page.retry",
  "viewport.request",
] as const;

export type StandardIntent = (typeof STANDARD_INTENTS)[number];

export function isStandardIntent(type: string): type is StandardIntent {
  return (STANDARD_INTENTS as readonly string[]).includes(type);
}
