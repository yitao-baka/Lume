//! 「外观」页 — language + color mode (docs/SETTINGS.md). Edits drive the
//! working copy via `onChange`, which marks the settings dirty and enables
//! 保存并应用.

import { t } from "../i18n";
import type { SettingsData } from "./types";
import { Chip, Row } from "./controls";
import langFollowSystemIcon from "../../res/icons/language_follow_system.svg";
import langEnIcon from "../../res/icons/english.svg";
import langZhCNIcon from "../../res/icons/chinese_simplified.svg";
import langZhTWIcon from "../../res/icons/chinese_traditional.svg";

export default function AppearancePane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["appearance"]>) => void;
}) {
  const a = () => props.settings.appearance;
  return (
    <>
      <h2 class="settings-grouptitle">{t("navAppearance")}</h2>
      <div class="settings-group">
        <Row label={t("settingsLanguage")}>
          <div class="settings-row settings-row-chips">
            <Chip
              label={t("settingsLangSystem")}
              icon={langFollowSystemIcon}
              active={a().language === "system"}
              onClick={() => props.onChange({ language: "system" })}
            />
            <Chip
              label={t("settingsLangEn")}
              icon={langEnIcon}
              active={a().language === "en"}
              onClick={() => props.onChange({ language: "en" })}
            />
            <Chip
              label={t("settingsLangZhCN")}
              icon={langZhCNIcon}
              active={a().language === "zh-CN"}
              onClick={() => props.onChange({ language: "zh-CN" })}
            />
            <Chip
              label={t("settingsLangZhTW")}
              icon={langZhTWIcon}
              active={a().language === "zh-TW"}
              onClick={() => props.onChange({ language: "zh-TW" })}
            />
          </div>
        </Row>
        <Row label={t("settingsColorMode")}>
          <div class="settings-row settings-row-chips">
            <Chip
              label={t("settingsColorModeSystem")}
              active={a().color_mode === "system"}
              onClick={() => props.onChange({ color_mode: "system" })}
            />
            <Chip
              label={t("settingsColorModeDark")}
              active={a().color_mode === "dark"}
              onClick={() => props.onChange({ color_mode: "dark" })}
            />
            <Chip
              label={t("settingsColorModeLight")}
              active={a().color_mode === "light"}
              onClick={() => props.onChange({ color_mode: "light" })}
            />
          </div>
        </Row>
      </div>
    </>
  );
}
