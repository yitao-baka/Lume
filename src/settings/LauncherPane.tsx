//! 「导航页」页 — window size/position, the nav-bar behavior toggles and the
//! entry-box size (docs/SETTINGS.md). Edits drive the working copy via
//! `onChange`, which marks the settings dirty and enables 保存并应用.

import { For } from "solid-js";
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
            {/* 自定义 = 记住位置开：窗口停在用户手动拖到的位置。 */}
            <Chip
              label={t("settingsCustom")}
              active={a().remember_position}
              onClick={() => props.onChange({ remember_position: true })}
            />
          </div>
        </Row>
      </div>

      <h2 class="settings-grouptitle">{t("groupNavBar")}</h2>
      <div class="settings-group">
        <Row label={t("showRecent")}>
          <Toggle
            checked={a().show_recent}
            onChange={(v) => props.onChange({ show_recent: v })}
          />
        </Row>
        <Row label={t("showExplorerBar")}>
          <Toggle
            checked={a().show_explorer_bar}
            onChange={(v) => props.onChange({ show_explorer_bar: v })}
          />
        </Row>
        <Row label={t("expandPinned")}>
          <Toggle
            checked={a().expand_pinned}
            onChange={(v) => props.onChange({ expand_pinned: v })}
          />
        </Row>
        <Row label={t("shiftEnterAdmin")}>
          <Toggle
            checked={a().shift_enter_admin}
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
            onChange={(v) => props.onChange({ remember_last_page: v })}
          />
        </Row>
        <span class="settings-hint">{t("rememberLastPageHint")}</span>
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
      </div>
    </>
  );
}
