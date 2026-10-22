//! Localized display names for the compiled-in plugins.
//!
//! A disk plugin's manifest name is its own (the author picks it), but the two
//! built-ins only carry a fallback name from the Rust registry, so the UI
//! resolves their name by id. The plugin manager and the settings search index
//! both go through here, so a built-in reads the same in every surface and
//! locale.

import { t, type Messages } from "../i18n";

const BUILTIN_NAME: Record<string, keyof Messages> = {
  clipboard: "pluginNameClipboard",
  preview: "pluginNamePreview",
};

/** Display name for a plugin id: the localized built-in name when there is
 *  one, else the manifest name, else the id. */
export function pluginDisplayName(id: string, manifestName?: string | null): string {
  const key = BUILTIN_NAME[id];
  if (key) return t(key);
  return manifestName || id;
}
