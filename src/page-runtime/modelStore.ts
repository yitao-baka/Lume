//! Page Model store: revision ownership, JSON validation, size limits and
//! animation-frame coalescing. Presenter mounts subscribe to this store; a
//! slow or crashed Presenter never owns the authoritative snapshot.

import {
  PAGE_RUNTIME,
  type PageModel,
  type PageStatus,
  type ResourceRef,
} from "./contracts";
import { validateResourceRef } from "./resources";

export const DEFAULT_MODEL_MAX_BYTES = 1024 * 1024;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_DEPTH = 64;

export interface ModelStoreOptions {
  maxBytes?: number;
  /** Test seam; production defaults to rAF plus a timeout fallback. */
  schedule?: (flush: () => void) => number;
  cancel?: (handle: number) => void;
}

export interface PageModelMeta {
  pageId: string;
  schema: string;
  revision: number;
  bytes: number;
  status: PageStatus;
}

function fail(message: string): never {
  throw new Error(`invalid page model: ${message}`);
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function assertJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
  nodes: { count: number },
  depth: number
): asserts value is import("./contracts").JsonValue {
  if (depth > MAX_JSON_DEPTH) fail(`JSON nesting exceeds ${MAX_JSON_DEPTH} at ${path}`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`non-finite number at ${path}`);
    return;
  }
  if (typeof value !== "object") {
    fail(`unsupported ${typeof value} at ${path}`);
  }
  if (seen.has(value)) fail(`cyclic value at ${path}`);
  seen.add(value);
  if (++nodes.count > MAX_JSON_NODES) fail(`JSON exceeds ${MAX_JSON_NODES} nodes`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertJsonValue(value[i], `${path}[${i}]`, seen, nodes, depth + 1);
    }
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) fail(`class instance or exotic object at ${path}`);
  for (const [key, child] of Object.entries(value)) {
    assertJsonValue(child, `${path}.${key}`, seen, nodes, depth + 1);
  }
  seen.delete(value);
}

function scanResources(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((child, i) => scanResources(child, `${path}[${i}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.kind === "string" &&
    ["url", "asset", "file-icon", "thumbnail"].includes(obj.kind) &&
    typeof obj.src === "string"
  ) {
    validateResourceRef(obj as unknown as ResourceRef, path);
  }
  for (const [key, child] of Object.entries(obj)) scanResources(child, `${path}.${key}`);
}

/** Validate a complete snapshot before it crosses the host boundary. */
export function validateJsonValue(value: unknown): void {
  assertJsonValue(value, "$", new WeakSet(), { count: 0 }, 0);
}

export function validatePageModel(model: PageModel, maxBytes = DEFAULT_MODEL_MAX_BYTES): number {
  if (model?.runtime !== PAGE_RUNTIME) fail(`runtime must be "${PAGE_RUNTIME}"`);
  if (typeof model.schema !== "string" || !model.schema.trim()) fail("schema is required");
  if (!Number.isSafeInteger(model.revision) || model.revision <= 0) {
    fail("revision must be a positive safe integer");
  }
  if (!["loading", "ready", "empty", "error"].includes(model.status)) {
    fail(`unknown status "${String(model.status)}"`);
  }
  validateJsonValue(model);
  scanResources(model.data, "$.data");
  scanResources(model.actions, "$.actions");
  scanResources(model.preview, "$.preview");
  const bytes = new TextEncoder().encode(JSON.stringify(model)).byteLength;
  if (bytes > maxBytes) fail(`serialized size ${bytes} exceeds ${maxBytes} bytes`);
  return bytes;
}

export class PageModelStore {
  private current: PageModel | undefined;
  private bytes = 0;
  private readonly listeners = new Set<(model: PageModel) => void>();
  private readonly maxBytes: number;
  private readonly schedule: (flush: () => void) => number;
  private readonly cancel: (handle: number) => void;
  private pending = 0;

  constructor(
    private readonly pageId: string,
    options: ModelStoreOptions = {}
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MODEL_MAX_BYTES;
    this.schedule =
      options.schedule ??
      ((flush) => {
        if (typeof requestAnimationFrame === "function") return requestAnimationFrame(flush);
        return setTimeout(flush, 16) as unknown as number;
      });
    this.cancel =
      options.cancel ??
      ((handle) => {
        if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(handle);
        else clearTimeout(handle);
      });
  }

  get(): PageModel | undefined {
    return this.current;
  }

  meta(): PageModelMeta | null {
    if (!this.current) return null;
    return {
      pageId: this.pageId,
      schema: this.current.schema,
      revision: this.current.revision,
      bytes: this.bytes,
      status: this.current.status,
    };
  }

  /** Full-snapshot publish. Stale revisions are ignored, never overwritten. */
  publish(model: PageModel): PageModel {
    const bytes = validatePageModel(model, this.maxBytes);
    if (this.current && model.revision <= this.current.revision) {
      return this.current;
    }
    this.current = structuredClone(model);
    this.bytes = bytes;
    this.queueNotify();
    return this.current;
  }

  subscribe(listener: (model: PageModel) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private queueNotify(): void {
    if (this.pending) return;
    this.pending = this.schedule(() => {
      this.pending = 0;
      const model = this.current;
      if (!model) return;
      for (const listener of [...this.listeners]) {
        try {
          listener(structuredClone(model));
        } catch (err) {
          console.error("[page-runtime] model subscriber failed:", err);
        }
      }
    });
  }

  dispose(): void {
    if (this.pending) this.cancel(this.pending);
    this.pending = 0;
    this.listeners.clear();
  }
}
