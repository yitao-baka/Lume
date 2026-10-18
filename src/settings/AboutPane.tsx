//! 「关于」页 — description + version / license / author / homepage rows
//! (docs/SETTINGS.md). The homepage opens through `launch_app`
//! (ShellExecuteW), the same path the clipboard 「打开链接」 uses.

import { invoke } from "@tauri-apps/api/core";
import { createSignal, Show } from "solid-js";
import { t } from "../i18n";
import { APP_VERSION_LABEL } from "../appVersion";
import { Row } from "./controls";
import { settingsError } from "./errors";

const HOMEPAGE = "https://github.com/yitao-baka/Lume";

export default function AboutPane() {
  const [error, setError] = createSignal<string | null>(null);

  async function openHomepage() {
    setError(null);
    try {
      await invoke("launch_app", { path: HOMEPAGE, name: HOMEPAGE, elevated: false });
    } catch (err) {
      setError(settingsError(err, "settingsAboutOpenFailed"));
    }
  }

  return (
    <>
      <h2 class="settings-grouptitle">{t("about")}</h2>
      <div class="settings-group">
        <span class="settings-about-desc">{t("aboutTagline")}</span>
        <Row label={t("aboutVersion")}>
          <span class="settings-about-value">{APP_VERSION_LABEL}</span>
        </Row>
        <Row label={t("aboutLicense")}>
          <span class="settings-about-value">Apache License 2.0</span>
        </Row>
        <Row label={t("aboutAuthor")}>
          <span class="settings-about-value">IndexEeve&amp;yitao-baka</span>
        </Row>
        <Row label={t("aboutHomepage")}>
          <button
            class="settings-link"
            type="button"
            onClick={() => void openHomepage()}
          >
            {HOMEPAGE}
          </button>
        </Row>
        <Show when={error()}>
          <span class="settings-error" role="alert">{error()}</span>
        </Show>
      </div>
    </>
  );
}
