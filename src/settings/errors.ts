//! Localized, consistent settings/action error text. Command errors may carry
//! useful diagnostics, but the settings UI never pastes raw backend text into
//! a localized surface: the detail goes to the log and the user gets a stable
//! message for the operation they attempted.

import { t, type Messages } from "../i18n";

/** Turn an invoke rejection into a localized message for `fallback`. */
export function settingsError(
  err: unknown,
  fallback: keyof Messages = "settingsOperationFailed",
): string {
  console.error("[settings]", err);
  const raw = String(err).toLowerCase();
  if (raw.includes("canceled") || raw.includes("cancelled")) {
    return t("settingsOperationCanceled");
  }
  if (raw.includes("access is denied") || raw.includes("permission denied")) {
    return t("settingsErrorPermission");
  }
  if (raw.includes("not found")) {
    return t("settingsErrorNotFound");
  }
  return t(fallback);
}
