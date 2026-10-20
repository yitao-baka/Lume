//! 「启动器」页 — window geometry, home bars, session behavior, search
//! placeholders, and entry-box appearance.

import { For } from "solid-js";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { NumberPreset, SettingGroup, SettingRow, Toggle } from "./controls";

const POSITION_GRID = [
  { value: "top-left", label: "settingsPosTopLeft", column: 1, row: 1 },
  { value: "center", label: "settingsPosCenter", column: 2, row: 1 },
  { value: "top-right", label: "settingsPosTopRight", column: 3, row: 1 },
  { value: "bottom-left", label: "settingsPosBottomLeft", column: 1, row: 2 },
  { value: "bottom-right", label: "settingsPosBottomRight", column: 3, row: 2 },
] as const;

function PositionGrid(props: {
  value: string;
  manual: boolean;
  onChange: (patch: { window_position?: string; remember_position?: boolean }) => void;
}) {
  return (
    <div class="settings-position-wrap">
      <div class="settings-position-grid" role="radiogroup" aria-label={t("settingsWindowPosition")}>
        <For each={POSITION_GRID}>
          {(position) => (
            <button
              type="button"
              role="radio"
              aria-checked={!props.manual && props.value === position.value}
              aria-label={t(position.label)}
              title={t(position.label)}
              class="settings-position-cell"
              classList={{ active: !props.manual && props.value === position.value }}
              style={{ "grid-column": String(position.column), "grid-row": String(position.row) }}
              onClick={() =>
                props.onChange({ window_position: position.value, remember_position: false })
              }
            >
              <span aria-hidden="true" />
            </button>
          )}
        </For>
      </div>
      <div class="settings-position-extra">
        <button
          class="settings-position-choice"
          classList={{ active: !props.manual && props.value === "follow-mouse" }}
          type="button"
          aria-pressed={!props.manual && props.value === "follow-mouse"}
          onClick={() => props.onChange({ window_position: "follow-mouse", remember_position: false })}
        >
          {t("settingsPosFollowMouse")}
        </button>
        <button
          class="settings-position-choice"
          classList={{ active: props.manual }}
          type="button"
          aria-pressed={props.manual}
          onClick={() => props.onChange({ remember_position: true })}
        >
          {t("settingsCustom")}
        </button>
      </div>
    </div>
  );
}

function EntrySizeControl(props: {
  value: number;
  onChange: (value: number) => void;
}) {
  const sizes = [70, 110, 150];
  return (
    <div class="settings-entry-size" role="radiogroup" aria-label={t("settingsEntrySize")}>
      <For each={sizes}>
        {(size, index) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.value === size}
            class="settings-entry-option"
            classList={{ active: props.value === size }}
            onClick={() => props.onChange(size)}
          >
            <span class={`settings-entry-sample size-${index()}`} aria-hidden="true" />
            <span>{t(["settingsSizeSmall", "settingsSizeMedium", "settingsSizeLarge"][index()] as any)}</span>
          </button>
        )}
      </For>
    </div>
  );
}

export default function LauncherPane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["appearance"]>) => void;
}) {
  const a = () => props.settings.appearance;
  return (
    <>
      <SettingGroup title={t("groupWindow")} number="02.1">
        <SettingRow
          id="appearance.window_width"
          label={t("settingsWidth")}
          class="settings-window-size-row"
        >
          <NumberPreset
            value={a().window_width}
            presets={[
              { label: t("settingsSizeSmall"), value: 540 },
              { label: t("settingsSizeMedium"), value: 720 },
              { label: t("settingsSizeLarge"), value: 900 },
            ]}
            onCommit={(v) => props.onChange({ window_width: v })}
          />
          <span class="settings-launcher-preview" aria-hidden="true">
            <span class="settings-preview-search" />
            <span class="settings-preview-grid">
              <i /><i /><i /><i />
            </span>
          </span>
        </SettingRow>
        <SettingRow
          id="appearance.window_height"
          label={t("settingsHeight")}
          summary={t("settingsHeightHint")}
        >
          <NumberPreset
            value={a().window_height}
            presets={[
              { label: t("settingsSizeSmall"), value: 420 },
              { label: t("settingsSizeMedium"), value: 520 },
              { label: t("settingsSizeLarge"), value: 620 },
            ]}
            onCommit={(v) => props.onChange({ window_height: v })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.window_position"
          label={t("settingsWindowPosition")}
          summary={t("settingsWindowPositionHint")}
          details={[t("settingsWindowPositionDetail")]}
        >
          <PositionGrid
            value={a().window_position}
            manual={a().remember_position}
            onChange={(patch) => props.onChange(patch)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupNavBar")} number="02.2">
        <SettingRow
          id="appearance.show_recent"
          label={t("showRecent")}
          summary={t("settingsShowRecentHint")}
        >
          <Toggle
            checked={a().show_recent}
            label={t("showRecent")}
            onChange={(v) => props.onChange({ show_recent: v })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.show_explorer_bar"
          label={t("showExplorerBar")}
          summary={t("settingsShowExplorerHint")}
        >
          <Toggle
            checked={a().show_explorer_bar}
            label={t("showExplorerBar")}
            onChange={(v) => props.onChange({ show_explorer_bar: v })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.expand_pinned"
          label={t("expandPinned")}
          summary={t("settingsExpandPinnedHint")}
        >
          <Toggle
            checked={a().expand_pinned}
            label={t("expandPinned")}
            onChange={(v) => props.onChange({ expand_pinned: v })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.mode_switch_icons_only"
          label={t("modeSwitchIconsOnly")}
          summary={t("settingsModeIconsHint")}
        >
          <Toggle
            checked={a().mode_switch_icons_only}
            label={t("modeSwitchIconsOnly")}
            onChange={(v) => props.onChange({ mode_switch_icons_only: v })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.shift_enter_admin"
          label={t("shiftEnterAdmin")}
          summary={t("settingsShiftEnterHint")}
          details={[t("settingsShiftEnterDetail")]}
        >
          <Toggle
            checked={a().shift_enter_admin}
            label={t("shiftEnterAdmin")}
            onChange={(v) => props.onChange({ shift_enter_admin: v })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupSession")} number="02.3">
        <SettingRow
          id="appearance.remember_last_page"
          label={t("rememberLastPage")}
          summary={t("settingsRememberPageHint")}
        >
          <Toggle
            checked={a().remember_last_page}
            label={t("rememberLastPage")}
            onChange={(v) => props.onChange({ remember_last_page: v })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.per_mode_query"
          label={t("perModeQuery")}
          summary={t("settingsPerModeQuerySummary")}
          details={[t("perModeQueryHint")]}
        >
          <Toggle
            checked={a().per_mode_query}
            label={t("perModeQuery")}
            onChange={(v) => props.onChange({ per_mode_query: v })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.idle_reset_enabled"
          label={t("idleReset")}
          summary={t("settingsIdleResetSummary")}
          details={[t("idleResetHint")]}
        >
          <Toggle
            checked={a().idle_reset_enabled}
            label={t("idleReset")}
            onChange={(v) => props.onChange({ idle_reset_enabled: v })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.idle_reset_minutes"
          label={t("idleResetMinutes")}
          summary={t("settingsIdleMinutesHint")}
          disabled={!a().idle_reset_enabled}
        >
          <NumberPreset
            value={a().idle_reset_minutes}
            presets={[
              { label: "5", value: 5 },
              { label: "15", value: 15 },
              { label: "30", value: 30 },
              { label: "60", value: 60 },
              { label: "120", value: 120 },
              { label: "240", value: 240 },
            ]}
            onCommit={(v) => props.onChange({ idle_reset_minutes: v })}
            custom={{ min: 1, max: 10080, step: 1, label: t("idleResetMinutes") }}
            disabled={!a().idle_reset_enabled}
          />
        </SettingRow>
        <SettingRow
          id="appearance.recent_count"
          label={t("recentCount")}
          summary={t("settingsRecentCountHint")}
        >
          <NumberPreset
            value={a().recent_count}
            presets={[
              { label: "10", value: 10 },
              { label: "20", value: 20 },
              { label: "30", value: 30 },
              { label: "50", value: 50 },
            ]}
            onCommit={(v) => props.onChange({ recent_count: v })}
            custom={{ min: 5, max: 200, step: 5, label: t("recentCount") }}
          />
        </SettingRow>
        <SettingRow
          id="appearance.search_placeholder_apps"
          label={t("placeholderApps")}
          summary={t("settingsPlaceholderHint")}
        >
          <input
            class="settings-text-input settings-input-fixed"
            type="text"
            placeholder={t("searchApps")}
            value={a().search_placeholder_apps}
            onInput={(e) => props.onChange({ search_placeholder_apps: e.currentTarget.value })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.search_placeholder_clipboard"
          label={t("placeholderClipboard")}
          summary={t("settingsPlaceholderHint")}
        >
          <input
            class="settings-text-input settings-input-fixed"
            type="text"
            placeholder={t("searchClipboard")}
            value={a().search_placeholder_clipboard}
            onInput={(e) =>
              props.onChange({ search_placeholder_clipboard: e.currentTarget.value })
            }
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupEntryBox")} number="02.4">
        <SettingRow id="appearance.entry_size" label={t("settingsEntrySize")}>
          <EntrySizeControl
            value={a().entry_size}
            onChange={(value) => props.onChange({ entry_size: value })}
          />
        </SettingRow>
        <SettingRow
          id="appearance.round_app_icons"
          label={t("roundAppIcons")}
          summary={t("roundAppIconsHint")}
        >
          <Toggle
            checked={a().round_app_icons}
            label={t("roundAppIcons")}
            onChange={(v) => props.onChange({ round_app_icons: v })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
