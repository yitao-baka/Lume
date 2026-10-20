//! 「外观」页 — language, color mode, settings-window skin and accent. Visual
//! previews are shared DOM nodes; switching skins only changes the root data
//! attribute, so focus and scroll position stay put.

import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { t } from "../i18n";
import { themeMode } from "../theme";
import {
  normalizeSettingsAccent,
  SETTINGS_ACCENT_PRESETS,
} from "./accent";
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
          </button>
        )}
      </For>
    </div>
  );
}

function rgbStringToHex(value: string): string {
  const match = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(value.trim());
  if (!match) return "";
  const channels = match.slice(1, 4).map((part) => Math.min(255, Number(part)));
  return normalizeSettingsAccent(
    `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`,
  );
}

function skinStructureColor(): string {
  const settings = document.querySelector<HTMLElement>(".settings");
  if (!settings) return "#5ac8fa";
  const raw = getComputedStyle(settings).getPropertyValue("--settings-structure").trim();
  const direct = normalizeSettingsAccent(raw);
  if (direct) return direct;
  const probe = document.createElement("span");
  probe.style.color = raw;
  probe.style.display = "none";
  document.body.appendChild(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  return rgbStringToHex(resolved) || "#5ac8fa";
}

function AccentPreview() {
  return (
    <div class="settings-accent-preview" aria-hidden="true">
      <span class="settings-accent-preview-rule" />
      <span class="settings-accent-preview-nav">
        <span class="settings-accent-preview-index">01</span>
        <span class="settings-accent-preview-copy">Lume</span>
      </span>
      <span class="settings-accent-preview-switch"><span /></span>
      <span class="settings-accent-preview-text">{t("settingsAccentPreviewLabel")}</span>
    </div>
  );
}

function AccentPalette(props: {
  value: string;
  onPreview: (value: string) => void;
  onChange: (value: string) => void;
}) {
  let buttons: HTMLButtonElement[] = [];
  const [preview, setPreview] = createSignal("");
  const accent = () => normalizeSettingsAccent(props.value);
  const options = createMemo(() => [
    { value: "", label: t("settingsAccentFollowSkin"), swatch: "" },
    ...SETTINGS_ACCENT_PRESETS.map((preset) => ({
      value: preset.value,
      label: t(preset.labelKey),
      swatch: preset.value,
    })),
  ]);
  const selectedIndex = () => {
    const current = accent();
    if (!current) return 0;
    const found = SETTINGS_ACCENT_PRESETS.findIndex((preset) => preset.value === current);
    return found < 0 ? -1 : found + 1;
  };
  const customActive = () => selectedIndex() < 0;
  // Keep one radio in the tab order even while Custom is active; otherwise
  // keyboard users could not reach the preset group from Tab.
  const rovingIndex = () => (selectedIndex() < 0 ? 0 : selectedIndex());
  const customColor = () => {
    themeMode();
    const current = accent();
    if (current) return current;
    return skinStructureColor();
  };
  const shownCustomColor = () => normalizeSettingsAccent(preview()) || customColor();
  createEffect(() => {
    props.value;
    setPreview("");
  });
  const move = (next: number) => {
    const list = options();
    const index = (next + list.length) % list.length;
    props.onChange(list[index].value);
    requestAnimationFrame(() => buttons[index]?.focus());
  };
  return (
    <div class="settings-accent-control">
      <AccentPreview />
      <div class="settings-accent-options" role="radiogroup" aria-label={t("settingsAccent")}>
        <For each={options()}>
          {(option, index) => (
            <button
              ref={(el) => (buttons[index()] = el)}
              class="settings-accent-option"
              classList={{ active: selectedIndex() === index() }}
              type="button"
              role="radio"
              aria-checked={selectedIndex() === index()}
              data-accent-value={option.value || "follow"}
              tabIndex={rovingIndex() === index() ? 0 : -1}
              onClick={() => {
                props.onChange(option.value);
                requestAnimationFrame(() => {
                  document
                    .querySelector<HTMLElement>(
                      `[data-setting-id="appearance.settings_accent"] [data-accent-value="${option.value || "follow"}"]`,
                    )
                    ?.focus();
                });
              }}
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
                  move(options().length - 1);
                }
              }}
            >
              <span
                class="settings-accent-swatch"
                classList={{ follow: !option.swatch }}
                style={{ "--swatch": option.swatch || undefined }}
                aria-hidden="true"
              >
                <span />
              </span>
              <span>{option.label}</span>
            </button>
          )}
        </For>
      </div>
      <label
        class="settings-accent-custom"
        classList={{ active: customActive() }}
        title={`${t("settingsAccentCustom")}: ${shownCustomColor()}`}
      >
        <input
          class="settings-accent-input"
          type="color"
          value={shownCustomColor()}
          aria-label={t("settingsAccentCustom")}
          onInput={(event) => {
            const value = normalizeSettingsAccent(event.currentTarget.value);
            setPreview(value);
            props.onPreview(value);
          }}
          onChange={(event) => {
            const value = normalizeSettingsAccent(event.currentTarget.value);
            setPreview("");
            if (value) props.onChange(value);
          }}
        />
        <span class="settings-accent-custom-label">{t("settingsAccentCustom")}</span>
        <code>{shownCustomColor()}</code>
      </label>
    </div>
  );
}

export default function AppearancePane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["appearance"]>) => void;
  onAccentPreview: (value: string) => void;
  skinError?: string | null;
  accentError?: string | null;
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

      <SettingGroup title={t("groupAppearanceAccent")} number="01.4">
        <SettingRow
          id="appearance.settings_accent"
          label={t("settingsAccent")}
          summary={t("settingsAccentHint")}
          details={[t("settingsAccentDetail")]}
          class="settings-accent-row"
        >
          <AccentPalette
            value={a().settings_accent}
            onPreview={props.onAccentPreview}
            onChange={(value) => props.onChange({ settings_accent: value })}
          />
          <Show when={props.accentError}>
            <span class="settings-inline-error" role="alert">
              {props.accentError}
            </span>
          </Show>
        </SettingRow>
      </SettingGroup>
      {props.children}
    </>
  );
}
