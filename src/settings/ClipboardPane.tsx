//! 「剪贴板」页 — history cap, what gets recorded, paste behavior and time
//! display (docs/SETTINGS.md). Edits drive the working copy via `onChange`,
//! which marks the settings dirty and enables 保存 / 应用.

import { createSignal, For } from "solid-js";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { Chip, Toggle } from "./InterfacePane";
import deleteIcon from "../../res/icons/delete.svg";

/** History-cap presets (达到上限自动删除最旧的非固定记录). */
const CAPS = [100, 200, 500, 1000];
/** Auto-merge window presets in milliseconds. */
const MERGE_WINDOWS = [500, 1000, 1500, 2000, 3000];

export default function ClipboardPane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["clipboard"]>) => void;
}) {
  const c = () => props.settings.clipboard;
  const [ignore, setIgnore] = createSignal("");

  function addIgnoreApp() {
    const name = ignore().trim();
    if (!name) return;
    const apps = c().ignore_apps ?? [];
    if (!apps.some((a) => a.toLowerCase() === name.toLowerCase())) {
      props.onChange({ ignore_apps: [...apps, name] });
    }
    setIgnore("");
  }

  function removeIgnoreApp(app: string) {
    props.onChange({ ignore_apps: (c().ignore_apps ?? []).filter((a) => a !== app) });
  }
  return (
    <>
      <div class="settings-group">
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("settingsClipPreview")}</span>
          <Toggle
            checked={c().preview}
            onChange={(v) => props.onChange({ preview: v })}
          />
        </div>
        <span class="settings-hint">{t("settingsClipPreviewHint")}</span>
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("clipHistoryCap")}</h2>
        <div class="settings-row">
          <For each={CAPS}>
            {(v) => (
              <Chip
                label={String(v)}
                active={c().history_cap === v}
                onClick={() => props.onChange({ history_cap: v })}
              />
            )}
          </For>
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("clipRecordImages")}</span>
          <Toggle
            checked={c().record_images}
            onChange={(v) => props.onChange({ record_images: v })}
          />
        </div>
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("clipRecordFiles")}</span>
          <Toggle
            checked={c().record_files}
            onChange={(v) => props.onChange({ record_files: v })}
          />
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("clipPasteClose")}</span>
          <Toggle
            checked={c().paste_close}
            onChange={(v) => props.onChange({ paste_close: v })}
          />
        </div>
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("clipShowSource")}</span>
          <Toggle
            checked={c().show_source_app}
            onChange={(v) => props.onChange({ show_source_app: v })}
          />
        </div>
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("clipHoverSelect")}</span>
          <Toggle
            checked={c().hover_select}
            onChange={(v) => props.onChange({ hover_select: v })}
          />
        </div>
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("clipFavoritesTop")}</span>
          <Toggle
            checked={c().favorites_top}
            onChange={(v) => props.onChange({ favorites_top: v })}
          />
        </div>
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("clipTimeDisplay")}</h2>
        <div class="settings-row">
          <Chip
            label={t("clipTimeRelative")}
            active={c().time_display === "relative"}
            onClick={() => props.onChange({ time_display: "relative" })}
          />
          <Chip
            label={t("clipTimeAbsolute")}
            active={c().time_display === "absolute"}
            onClick={() => props.onChange({ time_display: "absolute" })}
          />
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("clipMergeCopy")}</span>
          <Toggle
            checked={c().merge_copy}
            onChange={(v) => props.onChange({ merge_copy: v })}
          />
        </div>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("clipMergeWindow")}</span>
          <div class="settings-row">
            <For each={MERGE_WINDOWS}>
              {(ms) => (
                <Chip
                  label={`${ms / 1000}s`}
                  active={c().merge_window_ms === ms}
                  onClick={() => props.onChange({ merge_window_ms: ms })}
                />
              )}
            </For>
          </div>
        </div>
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("clipIgnoreApps")}</h2>
        <div class="settings-sub">
          <div class="settings-row">
            <input
              class="settings-text-input"
              type="text"
              placeholder={t("clipIgnorePlaceholder")}
              value={ignore()}
              onInput={(e) => setIgnore(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addIgnoreApp();
              }}
            />
            <button
              class="settings-action"
              disabled={!ignore().trim()}
              onClick={addIgnoreApp}
            >
              {t("settingsAdd")}
            </button>
          </div>
          <For each={c().ignore_apps ?? []}>
            {(app) => (
              <div class="settings-row settings-row-between">
                <span class="settings-path">{app}</span>
                <button
                  class="settings-icon-btn"
                  title={t("delete")}
                  aria-label={t("delete")}
                  onClick={() => removeIgnoreApp(app)}
                >
                  <img class="settings-icon-btn-icon" src={deleteIcon} alt="" draggable={false} />
                </button>
              </div>
            )}
          </For>
          <span class="settings-hint">{t("clipIgnoreHint")}</span>
        </div>
      </div>
    </>
  );
}
