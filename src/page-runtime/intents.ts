//! Page Intent validation and routing. A Presenter names semantic operations,
//! never host commands; the Host Runtime rejects unknown targets/actions
//! before the Page Service sees the intent.

import type { IntentResult, PageIntent, PageModel } from "./contracts";
import { isStandardIntent } from "./contracts";
import { pushDiagnostic } from "./diagnostics";
import { validateJsonValue } from "./modelStore";

export interface ModelTarget {
  id: string;
  actions: Set<string>;
}

export interface ModelActionSet {
  targets: Map<string, ModelTarget>;
  globalActions: Set<string>;
}

export type IntentHandler = (intent: PageIntent) => IntentResult | Promise<IntentResult>;

function stableId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
}

export function collectModelActions(model: PageModel): ModelActionSet {
  const targets = new Map<string, ModelTarget>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if (typeof obj.id === "string" && stableId(obj.id)) {
      const actions = new Set(
        Array.isArray(obj.actions)
          ? obj.actions.filter((a): a is string => typeof a === "string" && stableId(a))
          : []
      );
      targets.set(obj.id, { id: obj.id, actions });
    }
    for (const child of Object.values(obj)) walk(child);
  };
  walk(model.data);
  const globalActions = new Set(
    (model.actions ?? [])
      .map((a) => a.id)
      .filter((id) => typeof id === "string" && stableId(id))
  );
  return { targets, globalActions };
}

function failed(code: string, message: string): IntentResult {
  return { status: "failed", code, message };
}

/** Validate one intent against the current snapshot. Returns a failure result
 * when it must not reach the Page Service. */
export function validateIntent(intent: PageIntent, model: PageModel): IntentResult | null {
  if (!intent || typeof intent !== "object") return failed("intent.invalid", "intent must be an object");
  if (typeof intent.type !== "string" || !intent.type.trim()) {
    return failed("intent.type", "intent.type is required");
  }
  if (!isStandardIntent(intent.type) && !/^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]*$/.test(intent.type)) {
    return failed("intent.type", `unknown intent type "${intent.type}"`);
  }
  if (intent.requestId !== undefined) {
    if (typeof intent.requestId !== "string" || intent.requestId.length > 128) {
      return failed("intent.requestId", "requestId must be <= 128 chars");
    }
  }
  try {
    validateJsonValue(intent.payload ?? null);
  } catch (err) {
    return failed("intent.payload", String(err));
  }
  const ledger = collectModelActions(model);
  const targetId = intent.targetId;
  if (targetId !== undefined) {
    if (typeof targetId !== "string" || !stableId(targetId)) {
      return failed("intent.target", "targetId is invalid");
    }
    if (!ledger.targets.has(targetId)) {
      return failed("intent.target", `target "${targetId}" is not in the current model`);
    }
  }

  switch (intent.type) {
    case "selection.set": {
      const payload = intent.payload as { selectedIds?: unknown } | undefined;
      const ids = Array.isArray(payload?.selectedIds) ? payload.selectedIds : [];
      for (const id of ids) {
        if (typeof id !== "string" || !ledger.targets.has(id)) {
          return failed("intent.selection", `selected id "${String(id)}" is not in the current model`);
        }
      }
      return null;
    }
    case "selection.move": {
      const delta = (intent.payload as { delta?: unknown } | undefined)?.delta;
      if (delta !== undefined && (typeof delta !== "number" || !Number.isFinite(delta) || Math.abs(delta) > 1000)) {
        return failed("intent.selection", "selection.move delta must be a finite number");
      }
      return null;
    }
    case "item.activate":
    case "item.action":
      if (!targetId) return failed("intent.target", `${intent.type} requires targetId`);
      if (intent.type === "item.action") {
        if (typeof intent.actionId !== "string" || !stableId(intent.actionId)) {
          return failed("intent.action", "item.action requires actionId");
        }
        const target = ledger.targets.get(targetId);
        if (!ledger.globalActions.has(intent.actionId) && !target?.actions.has(intent.actionId)) {
          return failed("intent.action", `action "${intent.actionId}" is not declared for "${targetId}"`);
        }
      }
      return null;
    case "viewport.request": {
      const payload = intent.payload as { offset?: unknown; limit?: unknown } | undefined;
      const offset = payload?.offset;
      const limit = payload?.limit;
      if (offset !== undefined && (!Number.isSafeInteger(offset) || (offset as number) < 0)) {
        return failed("intent.viewport", "viewport offset must be a non-negative integer");
      }
      if (limit !== undefined && (!Number.isSafeInteger(limit) || (limit as number) <= 0 || (limit as number) > 5000)) {
        return failed("intent.viewport", "viewport limit must be between 1 and 5000");
      }
      return null;
    }
    default:
      return null;
  }
}

export class IntentRouter {
  constructor(
    private readonly pageId: string,
    private readonly handler: IntentHandler
  ) {}

  async dispatch(intent: PageIntent, model: PageModel): Promise<IntentResult> {
    const started = performance.now();
    const invalid = validateIntent(intent, model);
    if (invalid) {
      pushDiagnostic("__pageIntents", {
        pageId: this.pageId,
        requestId: intent?.requestId,
        type: intent?.type,
        status: "failed",
        code: invalid.code,
        durationMs: 0,
      });
      return { ...invalid, requestId: intent?.requestId };
    }
    try {
      const raw = await this.handler(intent);
      const result: IntentResult = {
        requestId: raw.requestId ?? intent.requestId,
        status: raw.status,
        ...(raw.code ? { code: raw.code } : {}),
        ...(raw.message ? { message: raw.message } : {}),
        ...(raw.value !== undefined ? { value: raw.value } : {}),
      };
      pushDiagnostic("__pageIntents", {
        pageId: this.pageId,
        requestId: intent.requestId,
        type: intent.type,
        targetId: intent.targetId,
        actionId: intent.actionId,
        status: result.status,
        code: result.code,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      });
      return result;
    } catch (err) {
      const result = {
        requestId: intent.requestId,
        status: "failed" as const,
        code: "intent.handler",
        message: String(err),
      };
      pushDiagnostic("__pageIntents", {
        pageId: this.pageId,
        requestId: intent.requestId,
        type: intent.type,
        targetId: intent.targetId,
        actionId: intent.actionId,
        status: "failed",
        code: result.code,
        durationMs: Math.round((performance.now() - started) * 10) / 10,
      });
      return result;
    }
  }
}
