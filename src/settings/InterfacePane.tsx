//! 「界面」页 — language, entry box size, window size (width + initial height),
//! window position (docs/SETTINGS.md). Edits drive the working copy via
//! `onChange`, which marks the settings dirty and enables 保存 / 应用.

import { For, Show } from "solid-js";
import { t, type Messages } from "../i18n";
import type { SettingsData } from "./types";
import langFollowSystemIcon from "../../res/icons/language_follow_system.svg";
import langEnIcon from "../../res/icons/english.svg";
import langZhCNIcon from "../../res/icons/chinese_simplified.svg";
import langZhTWIcon from "../../res/icons/chinese_traditional.svg";

/** A small selectable chip used across the settings panes. */
export function Chip(props: {
  label: string;
  active: boolean;
  icon?: string;
  onClick: () => void;
}) {
  return (
    <button
      class="settings-chip"
      classList={{ active: props.active }}
      onClick={props.onClick}
    >
      <Show when={props.icon}>
        <img class="settings-chip-icon" src={props.icon} alt="" draggable={false} />
      </Show>
      {props.label}
    </button>
  );
}

/** A preset-button group for a numeric value (entry box / window size). */
function NumberPreset(props: {
  value: number;
  presets: { label: string; value: number }[];
  onCommit: (v: number) => void;
}) {
  return (
    <div class="settings-row">
      <For each={props.presets}>
        {(p) => (
          <Chip
            label={p.label}
            active={props.value === p.value}
            onClick={() => props.onCommit(p.value)}
          />
        )}
      </For>
    </div>
  );
}

/** An on/off switch. */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      class="settings-toggle"
      classList={{ on: props.checked }}
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="settings-toggle-knob" />
    </button>
  );
}

const POSITIONS: { value: string; label: keyof Messages }[] = [
  { value: "center", label: "settingsPosCenter" },
  { value: "follow-mouse", label: "settingsPosFollowMouse" },
  { value: "top-left", label: "settingsPosTopLeft" },
  { value: "top-right", label: "settingsPosTopRight" },
  { value: "bottom-left", label: "settingsPosBottomLeft" },
  { value: "bottom-right", label: "settingsPosBottomRight" },
];

export default function InterfacePane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["appearance"]>) => void;
}) {
  const a = () => props.settings.appearance;
  return (
    <>
      {/* 颜色模式置顶 — live previews via the Settings window's createEffect. */}
      <div class="settings-group">
        <h2 class="settings-title">{t("settingsColorMode")}</h2>
        <div class="settings-row">
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
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("settingsLanguage")}</h2>
        <div class="settings-row">
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
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("settingsEntrySize")}</h2>
        <NumberPreset
          value={a().entry_size}
          presets={[
            { label: t("settingsSizeSmall"), value: 80 },
            { label: t("settingsSizeMedium"), value: 110 },
            { label: t("settingsSizeLarge"), value: 140 },
          ]}
          onCommit={(v) => props.onChange({ entry_size: v })}
        />
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("settingsWindowSize")}</h2>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("settingsWidth")}</span>
          <NumberPreset
            value={a().window_width}
            presets={[
              { label: t("settingsSizeSmall"), value: 600 },
              { label: t("settingsSizeMedium"), value: 720 },
              { label: t("settingsSizeLarge"), value: 840 },
            ]}
            onCommit={(v) => props.onChange({ window_width: v })}
          />
        </div>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("settingsHeight")}</span>
          <NumberPreset
            value={a().window_height}
            presets={[
              { label: t("settingsSizeSmall"), value: 360 },
              { label: t("settingsSizeMedium"), value: 520 },
              { label: t("settingsSizeLarge"), value: 720 },
            ]}
            onCommit={(v) => props.onChange({ window_height: v })}
          />
        </div>
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("settingsWindowPosition")}</h2>
        <div class="settings-row">
          <For each={POSITIONS}>
            {(p) => (
              <Chip
                label={t(p.label)}
                active={!a().remember_position && a().window_position === p.value}
                onClick={() =>
                  props.onChange({ window_position: p.value, remember_position: false })
                }
              />
            )}
          </For>
          {/* 自定义 = 记住位置开：窗口停在用户手动拖到的位置。 */}
          <Chip
            label={t("settingsCustom")}
            active={a().remember_position}
            onClick={() => props.onChange({ remember_position: true })}
          />
        </div>
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("recentCount")}</h2>
        <NumberPreset
          value={a().recent_count}
          presets={[
            { label: "10", value: 10 },
            { label: "20", value: 20 },
            { label: "30", value: 30 },
          ]}
          onCommit={(v) => props.onChange({ recent_count: v })}
        />
      </div>

      <div class="settings-group">
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("showRecent")}</span>
          <Toggle
            checked={a().show_recent}
            onChange={(v) => props.onChange({ show_recent: v })}
          />
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("expandPinned")}</span>
          <Toggle
            checked={a().expand_pinned}
            onChange={(v) => props.onChange({ expand_pinned: v })}
          />
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("shiftEnterAdmin")}</span>
          <Toggle
            checked={a().shift_enter_admin}
            onChange={(v) => props.onChange({ shift_enter_admin: v })}
          />
        </div>
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("searchPlaceholder")}</h2>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("placeholderApps")}</span>
          <input
            class="settings-text-input"
            type="text"
            placeholder={t("searchApps")}
            value={a().search_placeholder_apps}
            onInput={(e) =>
              props.onChange({ search_placeholder_apps: e.currentTarget.value })
            }
          />
        </div>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("placeholderClipboard")}</span>
          <input
            class="settings-text-input"
            type="text"
            placeholder={t("searchClipboard")}
            value={a().search_placeholder_clipboard}
            onInput={(e) =>
              props.onChange({ search_placeholder_clipboard: e.currentTarget.value })
            }
          />
        </div>
        <span class="settings-hint">{t("placeholderHint")}</span>
      </div>
    </>
  );
}
