//! 「关于」页 — centered app icon + project intro (docs/SETTINGS.md).
//!
//! The icon lives in `res/icons/software.png` (docs/NORMS.md res/ convention)
//! and is bundled here for display.

import { createSignal, onMount, Show } from "solid-js";
import { getVersion } from "@tauri-apps/api/app";
import { t } from "../i18n";
import iconUrl from "../../res/icons/software.png";

export default function AboutPane() {
  const [version, setVersion] = createSignal("");
  onMount(() => {
    void getVersion().then(setVersion).catch(() => {});
  });
  return (
    <div class="about">
      <img class="about-icon" src={iconUrl} alt="Lume" draggable={false} />
      <div class="about-name">Lume</div>
      <Show when={version()}>
        <div class="about-version">v{version()}</div>
      </Show>
      <p class="about-desc">{t("aboutTagline")}</p>
    </div>
  );
}
