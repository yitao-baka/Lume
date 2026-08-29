//! 「剪贴板」页 — history cap / recording, merge-copy, display, paste and
//! preview groups (docs/SETTINGS.md). Edits drive the working copy via
//! `onChange`, which marks the settings dirty and enables 保存并应用.

import { createSignal, For, Show } from "solid-js";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { Chip, NumberPreset, Row, Toggle } from "./controls";
import folderPlusIcon from "../../res/icons/folder_plus.svg";
import deleteIcon from "../../res/icons/delete.svg";
import damageMapIcon from "../../res/icons/damage-map.svg";

/** History-cap presets (达到上限自动删除最旧的非固定记录). */
const CAPS = [100, 200, 500, 1000];

/** 1500 → "1.5s"、3000 → "3s" — compact seconds label for the merge slider. */
function mergeWindowLabel(ms: number): string {
  const s = ms / 1000;
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
}

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
      <h2 class="settings-grouptitle">{t("clipHistoryCap")}</h2>
      <div class="settings-group">
        <Row label={t("clipHistoryCap")}>
          <NumberPreset
            value={c().history_cap}
            presets={CAPS.map((v) => ({ label: String(v), value: v }))}
            onCommit={(v) => props.onChange({ history_cap: v })}
          />
        </Row>
        <Row label={t("clipRecordImages")}>
          <Toggle
            checked={c().record_images}
            onChange={(v) => props.onChange({ record_images: v })}
          />
        </Row>
        <Row label={t("clipRecordFiles")}>
          <Toggle
            checked={c().record_files}
            onChange={(v) => props.onChange({ record_files: v })}
          />
        </Row>
        <Row label={t("clipMergeCopy")}>
          <Toggle
            checked={c().merge_copy}
            onChange={(v) => props.onChange({ merge_copy: v })}
          />
        </Row>
        <Show when={c().merge_copy}>
          <Row label={t("clipMergeWindow")}>
            <div class="settings-slider">
              <input
                class="settings-slider-input"
                type="range"
                min={500}
                max={5000}
                step={100}
                value={c().merge_window_ms}
                style={{
                  "--fill": `${
                    ((c().merge_window_ms - 500) / (5000 - 500)) * 100
                  }%`,
                }}
                onInput={(e) => {
                  const v = e.currentTarget.valueAsNumber;
                  if (Number.isFinite(v)) {
                    props.onChange({ merge_window_ms: Math.round(v) });
                  }
                }}
              />
              <span class="settings-slider-value">
                {mergeWindowLabel(c().merge_window_ms)}
              </span>
            </div>
          </Row>
        </Show>

        <div class="settings-blocktitle">{t("clipIgnoreApps")}</div>
        <span class="settings-hint">{t("clipIgnoreHint")}</span>
        <Show
          when={(c().ignore_apps ?? []).length > 0}
          fallback={<span class="settings-empty">{t("clipIgnoreEmpty")}</span>}
        >
          <For each={c().ignore_apps ?? []}>
            {(app) => (
              <div class="settings-row-between settings-listrow">
                <img
                  class="settings-icon-btn-icon"
                  src={damageMapIcon}
                  alt=""
                  draggable={false}
                />
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
        </Show>
        <div class="settings-row settings-listadd">
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
            class="settings-icon-btn"
            title={t("settingsAdd")}
            aria-label={t("settingsAdd")}
            disabled={!ignore().trim()}
            onClick={addIgnoreApp}
          >
            <img class="settings-icon-btn-icon" src={folderPlusIcon} alt="" draggable={false} />
          </button>
        </div>

        <Row label={t("clipDedup")}>
          <Toggle
            checked={c().dedup}
            onChange={(v) => props.onChange({ dedup: v })}
          />
        </Row>
        <span class="settings-hint">{t("clipDedupHint")}</span>
      </div>

      <h2 class="settings-grouptitle">{t("groupDisplay")}</h2>
      <div class="settings-group">
        <Row label={t("clipShowSource")}>
          <Toggle
            checked={c().show_source_app}
            onChange={(v) => props.onChange({ show_source_app: v })}
          />
        </Row>
        <Row label={t("clipTimeDisplay")}>
          <div class="settings-row settings-row-chips">
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
        </Row>
        <Row label={t("clipHoverSelect")}>
          <Toggle
            checked={c().hover_select}
            onChange={(v) => props.onChange({ hover_select: v })}
          />
        </Row>
        <Row label={t("clipFavoritesTop")}>
          <Toggle
            checked={c().favorites_top}
            onChange={(v) => props.onChange({ favorites_top: v })}
          />
        </Row>
      </div>

      <h2 class="settings-grouptitle">{t("groupPaste")}</h2>
      <div class="settings-group">
        <Row label={t("clipPasteClose")}>
          <Toggle
            checked={c().paste_close}
            onChange={(v) => props.onChange({ paste_close: v })}
          />
        </Row>
      </div>

      <h2 class="settings-grouptitle">{t("groupPreview")}</h2>
      <div class="settings-group">
        <Row label={t("settingsClipPreview")}>
          <Toggle
            checked={c().preview}
            onChange={(v) => props.onChange({ preview: v })}
          />
        </Row>
        <span class="settings-hint">{t("settingsClipPreviewHint")}</span>
        <Row label={t("rememberChecks")}>
          <Toggle
            checked={c().remember_checks}
            onChange={(v) => props.onChange({ remember_checks: v })}
          />
        </Row>
      </div>
    </>
  );
}
