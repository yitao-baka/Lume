//! 「外观」页 — language, color mode, and the settings-window skin. Visual
//! previews are shared DOM nodes; switching skins only changes the root data
//! attribute, so focus and scroll position stay put.

import { For, Show, type JSX } from "solid-js";
import { t } from "../i18n";
import type { SettingsData, SettingsSkin } from "./types";
import { SegmentedControl, SettingGroup, SettingRow } from "./controls";

const LANGUAGES = [
  { value: "system", label: "settingsLangSystem" },
  { value: "en", label: "settingsLangEn" },
  { value: "zh-CN", label: "settingsLangZhCN" },
  { value: "zh-TW", label: "settingsLangZhTW" },
] as const;

const THEMES = [
  { value: "system", label: "settingsColorModeSystem" },
  { value: "dark", label: "settingsColorModeDark" },
  { value: "light", label: "settingsColorModeLight" },
] as const;

function RadioCards(props: {
  label: string;
  value: string;
  options: { value: string; label: string; description?: string }[];
  className: string;
  onChange: (value: string) => void;
}) {
  let buttons: HTMLButtonElement[] = [];
  const at = () => {
    const found = props.options.findIndex((option) => option.value === props.value);
    return found < 0 ? 0 : found;
  };
  const move = (next: number) => {
    const index = (next + props.options.length) % props.options.length;
    props.onChange(props.options[index].value);
    requestAnimationFrame(() => buttons[index]?.focus());
  };
  return (
    <div class={props.className} role="radiogroup" aria-label={props.label}>
      <For each={props.options}>
        {(option, index) => (
          <button
            ref={(el) => (buttons[index()] = el)}
            class="settings-preview-option"
            classList={{ active: props.value === option.value }}
            type="button"
            role="radio"
            aria-checked={props.value === option.value}
            tabIndex={at() === index() ? 0 : -1}
            onClick={() => props.onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index() + 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index() - 1);
              } else if (event.key === "Home") {
                event.preventDefault();
                move(0);
              } else if (event.key === "End") {
                event.preventDefault();
                move(props.options.length - 1);
              }
            }}
          >
            <Show when={props.className === "settings-theme-grid"}>
              <span class={`settings-theme-sample ${option.value}`} aria-hidden="true">
                <span class="settings-theme-sample-title">Lume</span>
              </span>
            </Show>
            <span class="settings-preview-label">{option.label}</span>
            <Show when={option.description}>
              <span class="settings-preview-description">{option.description}</span>
            </Show>
            <span class="settings-preview-check" aria-hidden="true">✓</span>
          </button>
        )}
      </For>
    </div>
  );
}

export default function AppearancePane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["appearance"]>) => void;
  skinError?: string | null;
  children?: JSX.Element;
}) {
  const a = () => props.settings.appearance;
  return (
    <>
      <SettingGroup title={t("groupAppearanceTheme")} number="01.1">
        <SettingRow
          id="appearance.color_mode"
          label={t("settingsColorMode")}
          summary={t("settingsColorModeHint")}
          details={[t("settingsColorModeDetail")]}
        >
          <RadioCards
            label={t("settingsColorMode")}
            value={a().color_mode}
            className="settings-theme-grid"
            options={THEMES.map((theme) => ({
              value: theme.value,
              label: t(theme.label),
            }))}
            onChange={(value) => props.onChange({ color_mode: value })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupAppearanceLanguage")} number="01.2">
        <SettingRow
          id="appearance.language"
          label={t("settingsLanguage")}
          summary={t("settingsLanguageHint")}
        >
          <SegmentedControl
            label={t("settingsLanguage")}
            value={a().language}
            options={LANGUAGES.map((language) => ({
              value: language.value,
              label: t(language.label),
            }))}
            onChange={(value) => props.onChange({ language: value })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupAppearanceSkin")} number="01.3">
        <SettingRow
          id="appearance.settings_skin"
          label={t("settingsSkin")}
          summary={t("settingsSkinHint")}
          details={[t("settingsSkinDetail")]}
          class="settings-skin-row"
        >
          <RadioCards
            label={t("settingsSkin")}
            value={a().settings_skin}
            className="settings-skin-options"
            options={[
              {
                value: "quiet",
                label: t("settingsSkinQuiet"),
                description: t("settingsSkinQuietHint"),
              },
              {
                value: "chromatic",
                label: t("settingsSkinChromatic"),
                description: t("settingsSkinChromaticHint"),
              },
            ]}
            onChange={(value) => props.onChange({ settings_skin: value as SettingsSkin })}
          />
          <Show when={props.skinError}>
            <span class="settings-inline-error" role="alert">
              {props.skinError}
            </span>
          </Show>
        </SettingRow>
      </SettingGroup>
      {props.children}
    </>
  );
}
