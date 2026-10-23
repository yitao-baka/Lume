//! Custom schema shipped by examples/plugins/translation-demo. The guard is
//! intentionally minimal: it checks the fields the two Presenters consume.

import type { JsonValue } from "./contracts";

export const TRANSLATION_SCHEMA = "translator.translation/v1" as const;

export interface TranslationEngine {
  id: string;
  label: string;
}

export interface TranslationLanguage {
  id: string;
  label: string;
}

export interface TranslationData {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  engine: string;
  engines: TranslationEngine[];
  languages: TranslationLanguage[];
  phase: "idle" | "loading" | "ready" | "error" | "canceled";
  requestId: number;
  cacheHit: boolean;
  hasApiKey: boolean;
  notice: string;
  timeoutMs: number;
  actionTarget: { id: string; actions: string[] };
}

export function isTranslationData(value: JsonValue | unknown): value is TranslationData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const data = value as Record<string, unknown>;
  return (
    typeof data.sourceText === "string" &&
    typeof data.translatedText === "string" &&
    typeof data.sourceLang === "string" &&
    typeof data.targetLang === "string" &&
    typeof data.engine === "string" &&
    Array.isArray(data.engines) &&
    Array.isArray(data.languages) &&
    ["idle", "loading", "ready", "error", "canceled"].includes(String(data.phase)) &&
    typeof data.requestId === "number" &&
    typeof data.cacheHit === "boolean" &&
    typeof data.hasApiKey === "boolean" &&
    typeof data.notice === "string" &&
    typeof data.timeoutMs === "number" &&
    !!data.actionTarget &&
    typeof data.actionTarget === "object" &&
    Array.isArray((data.actionTarget as Record<string, unknown>).actions)
  );
}
