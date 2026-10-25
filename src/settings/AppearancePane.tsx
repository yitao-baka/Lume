//! 「外观」页 — language, color mode, application skin and accent. Visual
//! previews are shared DOM nodes; switching skins only changes the root data
//! attribute, so focus and scroll position stay put.

import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { t } from "../i18n";
import { themeMode } from "../theme";
import {
  accentPresets,
  ACCENT_CUSTOM_FALLBACK,
  nativeAccent,
  normalizeAccent,
} from "../skins/accent";
import type { SkinId } from "../skins/registry";
import type { SettingsData } from "./types";
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

function AccentPreview() {
  return (
    <div class="settings-accent-preview" aria-hidden="true">
      <span class="settings-accent-preview-rule" />
      <span class="settings-accent-preview-nav">
        <span class="settings-accent-preview-index">01</span>
        <span class="settings-accent-preview-copy">Lume</span>
      </span>
      <span class="settings-accent-preview-switch"><span /></span>
      <span class="settings-accent-preview-text">{t("appearanceAccentPreviewLabel")}</span>
    </div>
  );
}

function AccentPalette(props: {
  value: string;
  /** The color the custom picker stored ("" = never picked one). */
  custom: string;
  skin: SkinId;
  onPreview: (value: string) => void;
  onChange: (value: string) => void;
  onCustomChange: (value: string) => void;
}) {
  let buttons: HTMLButtonElement[] = [];
  const [preview, setPreview] = createSignal("");
  const accent = () => normalizeAccent(props.value);
  const presets = () => accentPresets(props.skin);
  const options = createMemo(() => {
    // The 默认 swatch shows the skin's own accent, which is mode-specific:
    // reading themeMode() here keeps it in step with a light/dark flip.
    themeMode();
    return [
      { value: "", label: t("appearanceAccentDefault"), swatch: nativeAccent(props.skin) },
      ...presets().map((preset) => ({
        value: preset.value,
        label: t(preset.labelKey),
        swatch: preset.value,
      })),
    ];
  });
  const selectedIndex = () => {
    const current = accent();
    if (!current) return 0;
    const found = presets().findIndex((preset) => preset.value === current);
    return found < 0 ? -1 : found + 1;
  };
  const customActive = () => selectedIndex() < 0;
  // Keep one radio in the tab order even while Custom is active; otherwise
  // keyboard users could not reach the preset group from Tab.
  const rovingIndex = () => (selectedIndex() < 0 ? 0 : selectedIndex());
  // The picker owns its own value: the remembered custom color, or — until
  // the user picks one — pure white. It never mirrors the preset in use.
  const customColor = () =>
    normalizeAccent(props.custom) || ACCENT_CUSTOM_FALLBACK;
  const shownCustomColor = () => normalizeAccent(preview()) || customColor();
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
      <div class="settings-accent-options" role="radiogroup" aria-label={t("appearanceAccent")}>
        <For each={options()}>
          {(option, index) => (
            <button
              ref={(el) => (buttons[index()] = el)}
              class="settings-accent-option"
              classList={{ active: selectedIndex() === index() }}
              type="button"
              role="radio"
              aria-checked={selectedIndex() === index()}
              data-accent-value={option.value || "default"}
              tabIndex={rovingIndex() === index() ? 0 : -1}
              onClick={() => {
                props.onChange(option.value);
                requestAnimationFrame(() => {
                  document
                    .querySelector<HTMLElement>(
                      `[data-setting-id="appearance.accent"] [data-accent-value="${option.value || "default"}"]`,
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
                style={{ "--swatch": option.swatch }}
                aria-hidden="true"
              >
                <span />
              </span>
              <span>{option.label}</span>
            </button>
          )}
        </For>
      </div>
      <div
        class="settings-accent-custom"
        classList={{ active: customActive() }}
        title={`${t("appearanceAccentCustom")}: ${shownCustomColor()}`}
      >
        <input
          class="settings-accent-input"
          type="color"
          value={shownCustomColor()}
          aria-label={t("appearanceAccentCustom")}
          onInput={(event) => {
            const value = normalizeAccent(event.currentTarget.value);
            setPreview(value);
            props.onPreview(value);
          }}
          onChange={(event) => {
            const value = normalizeAccent(event.currentTarget.value);
            setPreview("");
            if (value) props.onCustomChange(value);
          }}
        />
        {/* The swatch above opens the native picker; this label applies the
            stored color straight away, so the entry behaves like a preset. */}
        <button
          class="settings-accent-custom-apply"
          type="button"
          aria-pressed={customActive()}
          onClick={() => props.onCustomChange(customColor())}
        >
          <span class="settings-accent-custom-label">{t("appearanceAccentCustom")}</span>
          <code>{shownCustomColor()}</code>
        </button>
      </div>
    </div>
  );
}

export default function AppearancePane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["appearance"]>) => void;
  onAccentPreview: (value: string) => void;
  launcherSkinError?: string | null;
  settingsSkinError?: string | null;
  accentError?: string | null;
  children?: JSX.Element;
}) {
  const a = () => props.settings.appearance;
  const skinOptions = () => [
    {
      value: "quiet",
      label: t("appearanceSkinQuiet"),
      description: t("appearanceSkinQuietHint"),
    },
    {
      value: "chromatic",
      label: t("appearanceSkinChromatic"),
      description: t("appearanceSkinChromaticHint"),
    },
  ];
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
          id="appearance.skin"
          label={t("appearanceSkin")}
          summary={t("appearanceSkinHint")}
          details={[t("appearanceSkinDetail")]}
          class="settings-skin-row"
        >
          <RadioCards
            label={t("appearanceSkin")}
            value={a().skin}
            className="settings-skin-options"
            options={skinOptions()}
            onChange={(value) => props.onChange({ skin: value as SkinId })}
          />
          <Show when={props.launcherSkinError}>
            <span class="settings-inline-error" role="alert">
              {props.launcherSkinError}
            </span>
          </Show>
        </SettingRow>
        <SettingRow
          id="appearance.settings_skin"
          label={t("appearanceSettingsSkin")}
          summary={t("appearanceSettingsSkinHint")}
          details={[t("appearanceSettingsSkinDetail")]}
          class="settings-skin-row"
        >
          <RadioCards
            label={t("appearanceSettingsSkin")}
            value={a().settings_skin}
            className="settings-skin-options"
            options={skinOptions()}
            onChange={(value) =>
              props.onChange({ settings_skin: value as SkinId })
            }
          />
          <Show when={props.settingsSkinError}>
            <span class="settings-inline-error" role="alert">
              {props.settingsSkinError}
            </span>
          </Show>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupAppearanceAccent")} number="01.4">
        <SettingRow
          id="appearance.accent"
          label={t("appearanceAccent")}
          summary={t("appearanceAccentHint")}
          details={[t("appearanceAccentDetail")]}
          class="settings-accent-row"
        >
          <AccentPalette
            value={a().accent}
            custom={a().accent_custom}
            skin={a().settings_skin ?? a().skin}
            onPreview={props.onAccentPreview}
            onChange={(value) => props.onChange({ accent: value })}
            onCustomChange={(value) =>
              props.onChange({ accent: value, accent_custom: value })
            }
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
