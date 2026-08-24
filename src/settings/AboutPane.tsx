//! 「关于」页 — centered app icon + project intro (docs/SETTINGS.md).
//!
//! The icon lives in `res/icons/software.png` (docs/NORMS.md res/ convention)
//! and is bundled here for display.

import { t } from "../i18n";
import { APP_VERSION_LABEL } from "../appVersion";
import iconUrl from "../../res/icons/software.png";

export default function AboutPane() {
  return (
    <div class="about">
      <img class="about-icon" src={iconUrl} alt="Lume" draggable={false} />
      <div class="about-name">Lume</div>
      <div class="about-version">{APP_VERSION_LABEL}</div>
      <p class="about-desc">{t("aboutTagline")}</p>
    </div>
  );
}
