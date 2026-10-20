//! 「剪贴板」页 — capture/history limits, merge copies, ignored apps,
//! display & paste behavior, and satellite preview.

import { createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import {
  NumberPreset,
  SegmentedControl,
  SettingGroup,
  SettingRow,
  Toggle,
} from "./controls";
import { ProgramPicker } from "./ProgramPicker";
import plusIcon from "../../res/icons/plus.svg";
import deleteIcon from "../../res/icons/delete.svg";

const CAPS = [100, 200, 500, 1000];

function mergeWindowLabel(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
}

export default function ClipboardPane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["clipboard"]>) => void;
  pluginEnabled?: boolean;
  onOpenPlugins?: () => void;
}) {
  const c = () => props.settings.clipboard;
  const [ignore, setIgnore] = createSignal("");
  const [ignoreError, setIgnoreError] = createSignal<string | null>(null);
  const [ignoreBusy, setIgnoreBusy] = createSignal(false);
  const [picking, setPicking] = createSignal(false);
  let pickTrigger: HTMLButtonElement | undefined;

  async function addIgnoreApp() {
    const raw = ignore().trim();
    if (!raw) {
      setIgnoreError(t("settingsClipIgnoreInvalid"));
      return;
    }
    setIgnoreBusy(true);
    try {
      const name = await invoke<string>("normalize_clipboard_ignore_app", {
        appName: raw,
      });
      const apps = c().ignore_apps ?? [];
      if (apps.some((app) => app.toLowerCase() === name.toLowerCase())) {
        setIgnoreError(t("settingsClipIgnoreDuplicate"));
        return;
      }
      props.onChange({ ignore_apps: [...apps, name] });
      setIgnoreError(null);
      setIgnore("");
    } catch {
      setIgnoreError(t("settingsClipIgnoreInvalid"));
    } finally {
      setIgnoreBusy(false);
    }
  }

  function removeIgnoreApp(app: string) {
    props.onChange({ ignore_apps: (c().ignore_apps ?? []).filter((item) => item !== app) });
  }

  return (
    <>
      <Show when={props.pluginEnabled === false}>
        <div class="settings-info-banner" role="status">
          <span>{t("settingsClipboardPluginHint")}</span>
          <button class="settings-link" type="button" onClick={props.onOpenPlugins}>
            {t("plugins")}
          </button>
        </div>
      </Show>
      <SettingGroup title={t("clipGroupHistory")} number="03.1">
        <SettingRow
          id="clipboard.history_cap"
          label={t("clipHistoryCap")}
          summary={t("settingsHistoryCapHint")}
        >
          <NumberPreset
            value={c().history_cap}
            presets={CAPS.map((value) => ({ label: String(value), value }))}
            onCommit={(value) => props.onChange({ history_cap: value })}
            custom={{ min: 10, max: 5000, step: 10, label: t("clipHistoryCap") }}
          />
        </SettingRow>
        <SettingRow
          id="clipboard.record_images"
          label={t("clipRecordImages")}
          summary={t("settingsRecordImagesHint")}
        >
          <Toggle
            checked={c().record_images}
            label={t("clipRecordImages")}
            onChange={(value) => props.onChange({ record_images: value })}
          />
        </SettingRow>
        <SettingRow
          id="clipboard.record_files"
          label={t("clipRecordFiles")}
          summary={t("settingsRecordFilesHint")}
        >
          <Toggle
            checked={c().record_files}
            label={t("clipRecordFiles")}
            onChange={(value) => props.onChange({ record_files: value })}
          />
        </SettingRow>
        <SettingRow
          id="clipboard.dedup"
          label={t("clipDedup")}
          summary={t("clipDedupHint")}
        >
          <Toggle
            checked={c().dedup}
            label={t("clipDedup")}
            onChange={(value) => props.onChange({ dedup: value })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("clipGroupMerge")} number="03.2">
        <SettingRow
          id="clipboard.merge_copy"
          label={t("clipMergeCopy")}
          summary={t("settingsMergeCopyHint")}
        >
          <Toggle
            checked={c().merge_copy}
            label={t("clipMergeCopy")}
            onChange={(value) => props.onChange({ merge_copy: value })}
          />
        </SettingRow>
        <SettingRow
          id="clipboard.merge_window_ms"
          label={t("clipMergeWindow")}
          summary={t("settingsMergeWindowHint")}
          disabled={!c().merge_copy}
        >
          <div class="settings-slider" classList={{ muted: !c().merge_copy }}>
            <input
              class="settings-slider-input"
              type="range"
              min={500}
              max={5000}
              step={100}
              value={c().merge_window_ms}
              aria-label={t("clipMergeWindow")}
              aria-valuetext={mergeWindowLabel(c().merge_window_ms)}
              disabled={!c().merge_copy}
              style={{
                "--fill": `${((c().merge_window_ms - 500) / (5000 - 500)) * 100}%`,
              }}
              onInput={(event) => {
                const value = event.currentTarget.valueAsNumber;
                if (Number.isFinite(value)) {
                  props.onChange({ merge_window_ms: Math.round(value) });
                }
              }}
            />
            <span class="settings-slider-value">{mergeWindowLabel(c().merge_window_ms)}</span>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("clipGroupIgnore")} number="03.3" class="settings-privacy-group">
        <SettingRow
          id="clipboard.ignore_apps"
          label={t("clipIgnoreApps")}
          summary={t("clipIgnoreHint")}
          details={[t("settingsClipIgnorePickerHint")]}
          class="settings-editor-row"
        >
          <div class="settings-inline-editor">
            <Show
              when={(c().ignore_apps ?? []).length > 0}
              fallback={<span class="settings-empty">{t("clipIgnoreEmpty")}</span>}
            >
              <div class="settings-compact-list">
                <For each={c().ignore_apps ?? []}>
                  {(app) => (
                    <div class="settings-compact-item">
                      <span class="settings-path">{app}</span>
                      <button
                        class="settings-icon-btn"
                        type="button"
                        title={t("delete")}
                        aria-label={`${t("delete")}: ${app}`}
                        onClick={() => removeIgnoreApp(app)}
                      >
                        <img class="settings-icon-btn-icon" src={deleteIcon} alt="" draggable={false} />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="settings-row settings-listadd">
              <input
                class="settings-text-input"
                type="text"
                placeholder={t("clipIgnorePlaceholder")}
                value={ignore()}
                aria-label={t("clipIgnorePlaceholder")}
                onInput={(event) => {
                  setIgnore(event.currentTarget.value);
                  setIgnoreError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addIgnoreApp();
                }}
              />
              <button
                ref={(el) => (pickTrigger = el)}
                class="settings-pick-btn"
                type="button"
                title={t("settingsClipIgnorePicker")}
                onClick={() => setPicking(true)}
              >
                {t("settingsClipIgnorePicker")}
              </button>
              <button
                class="settings-icon-btn"
                type="button"
                title={t("settingsAdd")}
                aria-label={t("settingsAdd")}
                disabled={!ignore().trim() || ignoreBusy()}
                onClick={() => void addIgnoreApp()}
              >
                <img class="settings-icon-btn-icon" src={plusIcon} alt="" draggable={false} />
              </button>
            </div>
            <Show when={ignoreError()}>
              <span class="settings-inline-error" role="alert">{ignoreError()}</span>
            </Show>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupDisplay")} number="03.4">
        <SettingRow id="clipboard.show_source_app" label={t("clipShowSource")}>
          <Toggle
            checked={c().show_source_app}
            label={t("clipShowSource")}
            onChange={(value) => props.onChange({ show_source_app: value })}
          />
        </SettingRow>
        <SettingRow id="clipboard.time_display" label={t("clipTimeDisplay")}>
          <SegmentedControl
            label={t("clipTimeDisplay")}
            value={c().time_display}
            options={[
              { value: "relative", label: t("clipTimeRelative") },
              { value: "absolute", label: t("clipTimeAbsolute") },
            ]}
            onChange={(value) => props.onChange({ time_display: value })}
          />
        </SettingRow>
        <SettingRow
          id="clipboard.hover_select"
          label={t("clipHoverSelect")}
          summary={t("settingsHoverSelectHint")}
        >
          <Toggle
            checked={c().hover_select}
            label={t("clipHoverSelect")}
            onChange={(value) => props.onChange({ hover_select: value })}
          />
        </SettingRow>
        <SettingRow id="clipboard.favorites_top" label={t("clipFavoritesTop")}>
          <Toggle
            checked={c().favorites_top}
            label={t("clipFavoritesTop")}
            onChange={(value) => props.onChange({ favorites_top: value })}
          />
        </SettingRow>
        <SettingRow id="clipboard.paste_close" label={t("clipPasteClose")}>
          <Toggle
            checked={c().paste_close}
            label={t("clipPasteClose")}
            onChange={(value) => props.onChange({ paste_close: value })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupPreview")} number="03.5">
        <SettingRow
          id="clipboard.preview"
          label={t("settingsClipPreview")}
          summary={t("settingsClipPreviewHint")}
        >
          <Toggle
            checked={c().preview}
            label={t("settingsClipPreview")}
            onChange={(value) => props.onChange({ preview: value })}
          />
        </SettingRow>
        <SettingRow id="clipboard.remember_checks" label={t("rememberChecks")}>
          <Toggle
            checked={c().remember_checks}
            label={t("rememberChecks")}
            onChange={(value) => props.onChange({ remember_checks: value })}
          />
        </SettingRow>
      </SettingGroup>

      <Show when={picking()}>
        <ProgramPicker
          onPick={(name) => {
            setIgnore(name);
            setIgnoreError(null);
          }}
          onClose={() => setPicking(false)}
          returnFocus={() => pickTrigger ?? null}
        />
      </Show>
    </>
  );
}
