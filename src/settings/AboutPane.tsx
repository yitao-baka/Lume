//! 「关于」页 — brand block and a compact metadata table.

import { invoke } from "@tauri-apps/api/core";
import { createSignal, Show } from "solid-js";
import { t } from "../i18n";
import { APP_VERSION_LABEL } from "../appVersion";
import { settingsError } from "./errors";

const HOMEPAGE = "https://github.com/yitao-baka/Lume";

export default function AboutPane() {
  const [error, setError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);

  async function openHomepage() {
    setError(null);
    try {
      await invoke("launch_app", { path: HOMEPAGE, name: HOMEPAGE, elevated: false });
    } catch (err) {
      setError(settingsError(err, "settingsAboutOpenFailed"));
    }
  }

  async function copyVersion() {
    try {
      await navigator.clipboard.writeText(APP_VERSION_LABEL);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t("settingsOperationFailed"));
    }
  }

  return (
    <section class="settings-about">
      <div class="settings-about-brand">
        <span class="settings-about-monogram" aria-hidden="true">LU</span>
        <div>
          <h2>LUME</h2>
          <p>{t("aboutTagline")}</p>
        </div>
      </div>
      <div class="settings-about-table" role="table">
        <div class="settings-about-row" role="row" id="about.version" data-setting-id="about.version" tabIndex={-1}>
          <span role="rowheader">{t("aboutVersion")}</span>
          <span role="cell">
            <button class="settings-about-value" type="button" onClick={() => void copyVersion()}>
              {APP_VERSION_LABEL}
              <small>{copied() ? t("copied") : ""}</small>
            </button>
          </span>
        </div>
        <div class="settings-about-row" role="row" id="about.license" data-setting-id="about.license" tabIndex={-1}>
          <span role="rowheader">{t("aboutLicense")}</span>
          <span role="cell">Apache License 2.0</span>
        </div>
        <div class="settings-about-row" role="row">
          <span role="rowheader">{t("aboutAuthor")}</span>
          <span role="cell">IndexEeve &amp; yitao-baka</span>
        </div>
        <div class="settings-about-row" role="row" id="about.homepage" data-setting-id="about.homepage" tabIndex={-1}>
          <span role="rowheader">{t("aboutHomepage")}</span>
          <span role="cell">
            <button class="settings-action settings-action-primary" type="button" onClick={() => void openHomepage()}>
              {HOMEPAGE} ↗
            </button>
          </span>
        </div>
      </div>
      <Show when={error()}>
        <span class="settings-inline-error" role="alert">{error()}</span>
      </Show>
    </section>
  );
}
