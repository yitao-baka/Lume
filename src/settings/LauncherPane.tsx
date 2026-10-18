//! 「导航页」页 — window size/position, the nav-bar behavior toggles and the
//! entry-box size (docs/SETTINGS.md). Edits drive the working copy via
//! `onChange`, which marks the settings dirty and enables 保存并应用.

import { For, Show } from "solid-js";
import { t, type Messages } from "../i18n";
import type { SettingsData } from "./types";
import { Chip, NumberPreset, Row, Toggle } from "./controls";

const POSITIONS: { value: string; label: keyof Messages }[] = [
  { value: "center", label: "settingsPosCenter" },
  { value: "follow-mouse", label: "settingsPosFollowMouse" },
  { value: "top-left", label: "settingsPosTopLeft" },
  { value: "top-right", label: "settingsPosTopRight" },
  { value: "bottom-left", label: "settingsPosBottomLeft" },
  { value: "bottom-right", label: "settingsPosBottomRight" },
];

export default function LauncherPane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["appearance"]>) => void;
}) {
  const a = () => props.settings.appearance;
  return (
    <>
      <h2 class="settings-grouptitle">{t("groupWindow")}</h2>
      <div class="settings-group">
        <Row label={t("settingsWidth")}>
          <NumberPreset
            value={a().window_width}
            presets={[
              { label: t("settingsSizeSmall"), value: 540 },
              { label: t("settingsSizeMedium"), value: 720 },
              { label: t("settingsSizeLarge"), value: 900 },
            ]}
            onCommit={(v) => props.onChange({ window_width: v })}
          />
        </Row>
        <Row label={t("settingsHeight")}>
          <NumberPreset
            value={a().window_height}
            presets={[
              { label: t("settingsSizeSmall"), value: 420 },
              { label: t("settingsSizeMedium"), value: 520 },
              { label: t("settingsSizeLarge"), value: 620 },
            ]}
            onCommit={(v) => props.onChange({ window_height: v })}
          />
        </Row>
        <span class="settings-hint">{t("settingsHeightHint")}</span>
        <Row label={t("settingsWindowPosition")}>
          <div class="settings-row settings-row-chips">
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
            {/* 自定义 = 首次出现也不套用预设：窗口停在当前/上次的位置。 */}
            <Chip
              label={t("settingsCustom")}
              active={a().remember_position}
              onClick={() => props.onChange({ remember_position: true })}
            />
          </div>
        </Row>
        <span class="settings-hint">{t("settingsCustomHint")}</span>
      </div>

      <h2 class="settings-grouptitle">{t("groupNavBar")}</h2>
      <div class="settings-group">
        <Row label={t("showRecent")}>
          <Toggle
            checked={a().show_recent}
            label={t("showRecent")}
            onChange={(v) => props.onChange({ show_recent: v })}
          />
        </Row>
        <span class="settings-hint">{t("settingsShowRecentHint")}</span>
        <Row label={t("showExplorerBar")}>
          <Toggle
            checked={a().show_explorer_bar}
            label={t("showExplorerBar")}
            onChange={(v) => props.onChange({ show_explorer_bar: v })}
          />
        </Row>
        <Row label={t("expandPinned")}>
          <Toggle
            checked={a().expand_pinned}
            label={t("expandPinned")}
            onChange={(v) => props.onChange({ expand_pinned: v })}
          />
        </Row>
        <Row label={t("modeSwitchIconsOnly")}>
          <Toggle
            checked={a().mode_switch_icons_only}
            label={t("modeSwitchIconsOnly")}
            onChange={(v) => props.onChange({ mode_switch_icons_only: v })}
          />
        </Row>
        <Row label={t("shiftEnterAdmin")}>
          <Toggle
            checked={a().shift_enter_admin}
            label={t("shiftEnterAdmin")}
            onChange={(v) => props.onChange({ shift_enter_admin: v })}
          />
        </Row>
        <Row label={t("recentCount")}>
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
        </Row>
        <Row label={t("placeholderApps")}>
          <input
            class="settings-text-input settings-input-fixed"
            type="text"
            placeholder={t("searchApps")}
            value={a().search_placeholder_apps}
            onInput={(e) =>
              props.onChange({ search_placeholder_apps: e.currentTarget.value })
            }
          />
        </Row>
        <Row label={t("placeholderClipboard")}>
          <input
            class="settings-text-input settings-input-fixed"
            type="text"
            placeholder={t("searchClipboard")}
            value={a().search_placeholder_clipboard}
            onInput={(e) =>
              props.onChange({ search_placeholder_clipboard: e.currentTarget.value })
            }
          />
        </Row>
        <Row label={t("rememberLastPage")}>
          <Toggle
            checked={a().remember_last_page}
            label={t("rememberLastPage")}
            onChange={(v) => props.onChange({ remember_last_page: v })}
          />
        </Row>
        <span class="settings-hint">{t("rememberLastPageHint")}</span>
        <Row label={t("perModeQuery")}>
          <Toggle
            checked={a().per_mode_query}
            label={t("perModeQuery")}
            onChange={(v) => props.onChange({ per_mode_query: v })}
          />
        </Row>
        <span class="settings-hint">{t("perModeQueryHint")}</span>
        <Row label={t("idleReset")}>
          <Toggle
            checked={a().idle_reset_enabled}
            label={t("idleReset")}
            onChange={(v) => props.onChange({ idle_reset_enabled: v })}
          />
        </Row>
        <Show when={a().idle_reset_enabled}>
          <Row label={t("idleResetMinutes")}>
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
            />
          </Row>
        </Show>
        <span class="settings-hint">{t("idleResetHint")}</span>
      </div>

      <h2 class="settings-grouptitle">{t("groupEntryBox")}</h2>
      <div class="settings-group">
        <Row label={t("settingsEntrySize")}>
          <NumberPreset
            value={a().entry_size}
            presets={[
              { label: t("settingsSizeSmall"), value: 70 },
              { label: t("settingsSizeMedium"), value: 110 },
              { label: t("settingsSizeLarge"), value: 150 },
            ]}
            onCommit={(v) => props.onChange({ entry_size: v })}
          />
        </Row>
        <Row label={t("roundAppIcons")}>
          <Toggle
            checked={a().round_app_icons}
            label={t("roundAppIcons")}
            onChange={(v) => props.onChange({ round_app_icons: v })}
          />
        </Row>
        <span class="settings-hint">{t("roundAppIconsHint")}</span>
      </div>
    </>
  );
}
