//! 「搜索」页 — index directories (system index rows + the key-value user
//! index editor) and the index-cache refresh interval (docs/SETTINGS.md).
//! Keeps the manual 刷新索引 button and the per-entry 「索引文件」 toggle —
//! both absent from the Flutter settings.

import { createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { Row, Toggle } from "./controls";
import folderOpenIcon from "../../res/icons/folder_open.svg";
import folderPlusIcon from "../../res/icons/folder_plus.svg";
import deleteIcon from "../../res/icons/delete.svg";
import refreshIcon from "../../res/icons/refresh.svg";

/** A directory path's last segment (the default user-index name). */
function basename(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

export default function SearchPane(props: {
  settings: SettingsData;
  onChangeIndex: (patch: Partial<SettingsData["index"]>) => void;
}) {
  const idx = () => props.settings.index;
  const [name, setName] = createSignal("");
  const [path, setPath] = createSignal("");
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function addUserIndex() {
    const p = path().trim();
    if (!p) return;
    const n = name().trim() || basename(p);
    const entries = idx().user_index ?? [];
    if (!entries.some((e) => e.path === p)) {
      props.onChangeIndex({ user_index: [...entries, { name: n, path: p, no_files: false }] });
    }
    setName("");
    setPath("");
  }

  function removeUserIndex(entry: { name: string; path: string }) {
    props.onChangeIndex({
      user_index: idx().user_index.filter((e) => e.path !== entry.path),
    });
  }

  // Toggle "index files in this directory": OFF → only .lnk/.exe are indexed.
  function toggleIndexFiles(entry: { path: string; no_files: boolean }) {
    props.onChangeIndex({
      user_index: idx().user_index.map((e) =>
        e.path === entry.path ? { ...e, no_files: !entry.no_files } : e
      ),
    });
  }

  function setSystemDir(dirPath: string, enabled: boolean) {
    props.onChangeIndex({
      system_dirs: idx().system_dirs.map((d) =>
        d.path === dirPath ? { ...d, enabled } : d
      ),
    });
  }

  // Manual index refresh (Desktop + user index + Start Menu).
  function showToast(text: string) {
    setToast(text);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 2000);
  }
  async function refreshIndexNow() {
    try {
      await invoke("refresh_index");
      showToast(t("settingsRefreshed"));
    } catch (err) {
      showToast(String(err));
    }
  }

  return (
    <>
      <div class="settings-title-row">
        <h2 class="settings-grouptitle">{t("settingsIndexDirs")}</h2>
        <button
          class="settings-icon-btn"
          title={t("settingsRefreshIndex")}
          aria-label={t("settingsRefreshIndex")}
          onClick={() => void refreshIndexNow()}
        >
          <img class="settings-icon-btn-icon" src={refreshIcon} alt="" draggable={false} />
        </button>
      </div>
      <div class="settings-group">
        <div class="settings-blocktitle">{t("settingsSystemIndex")}</div>
        <For each={idx().system_dirs}>
          {(d) => (
            <Row
              label={
                d.path === "Desktop"
                  ? t("settingsIndexDesktop")
                  : d.path === "StartMenu"
                    ? t("settingsIndexStartMenu")
                    : d.path
              }
            >
              <Toggle
                checked={d.enabled}
                onChange={(v) => setSystemDir(d.path, v)}
              />
            </Row>
          )}
        </For>

        <div class="settings-blocktitle">{t("settingsUserIndex")}</div>
        <Show
          when={(idx().user_index ?? []).length > 0}
          fallback={<span class="settings-empty">{t("settingsUserIndexEmpty")}</span>}
        >
          <For each={idx().user_index ?? []}>
            {(entry) => (
              <div class="settings-row-between settings-listrow">
                <img
                  class="settings-icon-btn-icon"
                  src={folderOpenIcon}
                  alt=""
                  draggable={false}
                />
                <span class="settings-index-name">{entry.name}</span>
                <span class="settings-index-arrow">→</span>
                <span class="settings-path" title={entry.path}>{entry.path}</span>
                <span title={t("settingsIndexFiles")}>
                  <Toggle
                    checked={!entry.no_files}
                    onChange={() => toggleIndexFiles(entry)}
                  />
                </span>
                <button
                  class="settings-icon-btn"
                  title={t("delete")}
                  aria-label={t("delete")}
                  onClick={() => removeUserIndex(entry)}
                >
                  <img class="settings-icon-btn-icon" src={deleteIcon} alt="" draggable={false} />
                </button>
              </div>
            )}
          </For>
        </Show>
        <div class="settings-row settings-listadd">
          <input
            class="settings-text-input settings-input-name"
            type="text"
            placeholder={t("settingsUserIndexName")}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addUserIndex();
            }}
          />
          <input
            class="settings-text-input"
            type="text"
            placeholder={t("settingsPathPlaceholder")}
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addUserIndex();
            }}
          />
          <button
            class="settings-icon-btn"
            title={t("settingsAdd")}
            aria-label={t("settingsAdd")}
            disabled={!path().trim()}
            onClick={addUserIndex}
          >
            <img class="settings-icon-btn-icon" src={folderPlusIcon} alt="" draggable={false} />
          </button>
        </div>
      </div>

      <h2 class="settings-grouptitle">{t("groupIndexCache")}</h2>
      <div class="settings-group">
        <Row label={t("settingsCacheRefresh")}>
          <div class="settings-slider">
            <input
              class="settings-slider-input"
              type="range"
              min={5}
              max={1440}
              step={5}
              value={idx().cache_refresh_interval_minutes}
              style={{
                "--fill": `${
                  ((idx().cache_refresh_interval_minutes - 5) / (1440 - 5)) * 100
                }%`,
              }}
              onInput={(e) => {
                const v = e.currentTarget.valueAsNumber;
                if (Number.isFinite(v)) {
                  props.onChangeIndex({
                    cache_refresh_interval_minutes: Math.round(v),
                  });
                }
              }}
            />
            <span class="settings-slider-value">
              {idx().cache_refresh_interval_minutes} {t("settingsMinutes")}
            </span>
          </div>
        </Row>
      </div>

      <Show when={toast()}>
        <div class="settings-toast" role="status">{toast()}</div>
      </Show>
    </>
  );
}
