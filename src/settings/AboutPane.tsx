//! 「关于」页 — description + version / license / author / homepage rows
//! (docs/SETTINGS.md). The homepage opens through `launch_app`
//! (ShellExecuteW), the same path the clipboard 「打开链接」 uses.

import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import { APP_VERSION_LABEL } from "../appVersion";
import { Row } from "./controls";

const HOMEPAGE = "https://github.com/yitao-baka/Lume";

export default function AboutPane() {
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
            onClick={() =>
              void invoke("launch_app", { path: HOMEPAGE, name: HOMEPAGE, elevated: false })
            }
          >
            {HOMEPAGE}
          </button>
        </Row>
      </div>
    </>
  );
}
