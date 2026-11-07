//! i18n — UI strings for Lume, kept in `languages/*.json` and loaded via
//! i18next (docs/ARCHITECTURE.md).
//!
//! Languages: English, Simplified Chinese, Traditional Chinese. The active
//! locale is detected from the system language at startup; `setLocale`
//! (used by the settings page) switches it at runtime.
//!
//! English is compiled into the entry bundle as the fallback. The active
//! Chinese bundle is loaded on demand before the first render, so a window
//! never carries all three locale tables at once. Any `languages/*.json` found
//! next to the exe is merged in as a runtime override, so a portable install
//! can tweak strings without a rebuild.

import { createSignal } from "solid-js";
import i18n from "i18next";
import { invoke } from "@tauri-apps/api/core";

import en from "../languages/en.json";

export type Locale = "en" | "zh-CN" | "zh-TW";

/** The set of UI string keys, derived from the English bundle. */
export type Messages = typeof en;

/** Resolve the user's locale from the browser/system language. */
export function detectLocale(): Locale {
  const lang = (navigator.language || "en").toLowerCase();
  if (lang.startsWith("zh")) {
    // zh-TW / zh-HK / zh-Hant → traditional; otherwise simplified.
    return lang.includes("tw") || lang.includes("hk") || lang.includes("hant") ? "zh-TW" : "zh-CN";
  }
  return "en";
}

const i18nReady = i18n.init({
  resources: {
    en: { translation: en },
  },
  lng: detectLocale(),
  fallbackLng: "en",
  supportedLngs: ["en", "zh-CN", "zh-TW"],
  load: "currentOnly",
  interpolation: {
    // Match the existing "{placeholder}" format in the JSON bundles.
    prefix: "{",
    suffix: "}",
    escapeValue: false,
  },
});

const localeLoaders: Record<Exclude<Locale, "en">, () => Promise<{ default: object }>> = {
  "zh-CN": () => import("../languages/zh-CN.json"),
  "zh-TW": () => import("../languages/zh-TW.json"),
};
const localeLoads = new Map<Locale, Promise<void>>();

/** Load one non-English bundle once and add it to i18next. */
export function ensureLocale(locale: Locale): Promise<void> {
  if (locale === "en") return Promise.resolve();
  const loaded = localeLoads.get(locale);
  if (loaded) return loaded;
  const pending = localeLoaders[locale]()
    .then((module) => {
      i18n.addResourceBundle(locale, "translation", module.default, true, true);
    })
    .catch(() => {
      // A missing optional bundle keeps the English fallback usable.
      localeLoads.delete(locale);
    });
  localeLoads.set(locale, pending);
  return pending;
}

/** Load and activate a locale before the first render. */
export async function prepareLocale(locale: Locale): Promise<void> {
  await i18nReady;
  await ensureLocale(locale);
  await i18n.changeLanguage(locale);
}

function syncDocumentLanguage(locale: string) {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
}

// Bump a Solid signal on every language change so reactive `t()` callers
// (JSX, effects) re-evaluate when the locale switches.
const [localeTick, bumpLocale] = createSignal(0);
i18n.on("languageChanged", (locale) => {
  syncDocumentLanguage(locale);
  bumpLocale((n) => n + 1);
});

// `init()` resolves synchronously for the bundled resources in practice, but
// syncing here also covers a deferred initialization without blocking render.
syncDocumentLanguage(i18n.language || detectLocale());

/** Current active locale. */
export function getLocale(): Locale {
  return i18n.language as Locale;
}

/** Override the active locale (used by the settings page). */
export function setLocale(locale: Locale) {
  syncDocumentLanguage(locale);
  void i18nReady.then(() => ensureLocale(locale)).then(() => i18n.changeLanguage(locale));
}

/** Resolve a stored language value (`"system"` or a locale) to an active one. */
export function resolveLocale(raw: string): Locale {
  if (raw === "en" || raw === "zh-CN" || raw === "zh-TW") return raw;
  return detectLocale();
}

/** Look up a message, substituting `{placeholder}` values if given.
 *
 * A numeric `count` also selects the `_one` / `_other` variant, which is how
 * English pluralises "{count} items" strings (docs/ARCHITECTURE.md); locales
 * without plural forms carry the same text in both slots. */
export function t(key: keyof Messages, params?: Record<string, string | number>): string {
  void localeTick(); // subscribe this caller to language changes
  return i18n.t(key, params);
}

/** A language file read from `<exe_dir>/languages/*.json`. */
interface LanguageFile {
  lang: string;
  json: string;
}

/** Merge language files found next to the exe as runtime overrides. */
export async function loadExternalLanguages() {
  try {
    await i18nReady;
    const files = await invoke<LanguageFile[]>("load_language_files");
    for (const f of files) {
      try {
        i18n.addResourceBundle(f.lang, "translation", JSON.parse(f.json), true, true);
      } catch {
        // Skip a malformed file rather than failing startup.
      }
    }
    // The merge happens asynchronously, after the app has already rendered —
    // bump the tick so reactive t() callers re-evaluate with the overrides.
    bumpLocale((n) => n + 1);
  } catch {
    // Command missing or no files present — the compiled bundles stay
    // authoritative.
  }
}

// Kick off the override load; it is async and failure-proof, so startup is
// never blocked on it.
void loadExternalLanguages();
