export type TranslationPhase = "idle" | "loading" | "ready" | "error" | "canceled";

export interface TranslationEngine { id: string; label: string; }
export interface TranslationLanguage { id: string; label: string; }
export interface TranslationData {
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  engine: string;
  engines: TranslationEngine[];
  languages: TranslationLanguage[];
  phase: TranslationPhase;
  requestId: number;
  cacheHit: boolean;
  hasApiKey: boolean;
  notice: string;
  timeoutMs: number;
  actionTarget: { id: string; actions: string[] };
}
