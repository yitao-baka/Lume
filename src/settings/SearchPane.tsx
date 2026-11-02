//! 「搜索」页 — index directories (system index rows + the key-value user
//! index editor) and the index-cache refresh interval (docs/SETTINGS.md).

import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { t, type Messages } from "../i18n";
import type { ConfirmState, SettingsData } from "./types";
import { SettingGroup, SettingRow, Toggle } from "./controls";
import { settingsError } from "./errors";
import folderOpenIcon from "../../res/icons/folder_open.svg";
import folderPlusIcon from "../../res/icons/folder_plus.svg";
import deleteIcon from "../../res/icons/delete.svg";

interface IndexDirValidation {
  ok: boolean;
  path: string;
  reason: "missing" | "not_dir" | "inaccessible" | "invalid" | null;
}

interface SvcStatus {
  installed: boolean;
  running: boolean;
}

const PATH_REASON_KEY: Record<string, keyof Messages> = {
  missing: "settingsPathMissing",
  not_dir: "settingsPathNotDir",
  inaccessible: "settingsPathInaccessible",
  invalid: "settingsPathInvalid",
};

const SYSTEM_DIR_HINT: Record<string, keyof Messages> = {
  Desktop: "settingsIndexDesktopHint",
  System32: "settingsIndexSystem32Hint",
  StartMenu: "settingsIndexStartMenuHint",
};

/** A directory path's last segment (the default user-index name). */
function basename(path: string): string {
  const norm = path.replace(/[\\/]+$/, "");
  const i = Math.max(norm.lastIndexOf("\\"), norm.lastIndexOf("/"));
  return i >= 0 ? norm.slice(i + 1) : norm;
}

/** Windows case-insensitive comparison key with duplicate separators and a
 * trailing separator removed. */
function pathKey(path: string): string {
  const normalized = path.trim().replace(/\//g, "\\").replace(/\\+$/, "");
  return normalized.toLowerCase();
}

function reasonText(reason: string | null): string {
  return t(PATH_REASON_KEY[reason ?? ""] ?? "settingsPathInvalid");
}

export default function SearchPane(props: {
  settings: SettingsData;
  onChangeIndex: (patch: Partial<SettingsData["index"]>) => void;
  requestConfirm: (state: ConfirmState) => void;
  onOpenSystem: () => void;
}) {
  const idx = () => props.settings.index;
  const [name, setName] = createSignal("");
  const [path, setPath] = createSignal("");
  const [pathError, setPathError] = createSignal<string | null>(null);
  const [entryErrors, setEntryErrors] = createSignal<Record<string, string>>({});
  const [validating, setValidating] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [rebuilding, setRebuilding] = createSignal(false);
  const [fullDriveBusy, setFullDriveBusy] = createSignal(false);
  const [svcInstalled, setSvcInstalled] = createSignal<boolean | null>(null);
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | null>(null);
  let validationSeq = 0;

  const fullDriveEnabled = () =>
    svcInstalled() === true && (idx().full_drive_search ?? false);

  /** The service is the source of truth, matching the agent switch: unknown or
   * unregistered states keep the option fail-closed. */
  async function refreshServiceInstalled(): Promise<boolean | null> {
    try {
      const next = await invoke<SvcStatus>("svc_status");
      setSvcInstalled(next.installed);
      if (!next.installed && (idx().full_drive_search ?? false)) {
        props.onChangeIndex({ full_drive_search: false });
      }
      return next.installed;
    } catch (err) {
      setSvcInstalled(null);
      setStatus({ ok: false, text: settingsError(err, "settingsFullDriveCheckFailed") });
      return null;
    }
  }

  onMount(() => {
    void refreshServiceInstalled();
  });

  async function toggleFullDrive(value: boolean) {
    if (!value) {
      props.onChangeIndex({ full_drive_search: false });
      return;
    }
    if (fullDriveBusy()) return;
    setFullDriveBusy(true);
    try {
      const installed = await refreshServiceInstalled();
      if (installed !== true) {
        if (installed === false) {
          props.requestConfirm({
            title: t("settingsFullDriveServiceRequiredTitle"),
            hint: t("settingsFullDriveServiceRequiredHint"),
            confirmLabel: t("settingsFullDriveOpenSystem"),
            action: async () => {
              props.onOpenSystem();
            },
          });
        }
        return;
      }
      props.onChangeIndex({ full_drive_search: true });
    } finally {
      setFullDriveBusy(false);
    }
  }

  async function validate(raw: string): Promise<IndexDirValidation> {
    return invoke<IndexDirValidation>("validate_index_dir", { path: raw });
  }

  // Existing entries can predate validation or disappear after being saved.
  // Recheck them as a group and expose missing/inaccessible/duplicate rows
  // inline instead of silently running an empty scan.
  createEffect(() => {
    const entries = idx().user_index ?? [];
    const seq = ++validationSeq;
    if (entries.length === 0) {
      setEntryErrors({});
      return;
    }
    void (async () => {
      const errors: Record<string, string> = {};
      const seen = new Map<string, string>();
      for (const entry of entries) {
        const check = await validate(entry.path);
        if (seq !== validationSeq) return;
        if (!check.ok) {
          errors[entry.path] = reasonText(check.reason);
          continue;
        }
        const key = pathKey(check.path);
        if (seen.has(key)) {
          errors[entry.path] = t("settingsPathDuplicate");
        } else {
          seen.set(key, entry.path);
        }
      }
      if (seq === validationSeq) setEntryErrors(errors);
    })();
  });

  async function addUserIndex() {
    const raw = path().trim();
    if (!raw) {
      setPathError(t("settingsPathInvalid"));
      return;
    }
    setValidating(true);
    setPathError(null);
    try {
      const check = await validate(raw);
      if (!check.ok) {
        setPathError(reasonText(check.reason));
        return;
      }
      const entries = idx().user_index ?? [];
      if (entries.some((e) => pathKey(e.path) === pathKey(check.path))) {
        setPathError(t("settingsPathDuplicate"));
        return;
      }
      const n = name().trim() || basename(check.path);
      props.onChangeIndex({
        user_index: [...entries, { name: n, path: check.path, no_files: false }],
      });
      setName("");
      setPath("");
    } catch (err) {
      setPathError(settingsError(err));
    } finally {
      setValidating(false);
    }
  }

  async function pickFolder(title: string): Promise<string | null> {
    try {
      const picked = await openDialog({ directory: true, multiple: false, title });
      return typeof picked === "string" ? picked : null;
    } catch (err) {
      setPathError(settingsError(err));
      return null;
    }
  }

  async function chooseNewFolder() {
    const picked = await pickFolder(t("settingsChooseFolder"));
    if (!picked) return;
    setPath(picked);
    setPathError(null);
    if (!name().trim()) setName(basename(picked));
  }

  async function repairEntry(entry: { name: string; path: string; no_files: boolean }) {
    const picked = await pickFolder(t("settingsChooseFolder"));
    if (!picked) return;
    try {
      const check = await validate(picked);
      if (!check.ok) {
        setEntryErrors((all) => ({ ...all, [entry.path]: reasonText(check.reason) }));
        return;
      }
      const entries = idx().user_index ?? [];
      if (
        entries.some(
          (e) => e.path !== entry.path && pathKey(e.path) === pathKey(check.path),
        )
      ) {
        setEntryErrors((all) => ({ ...all, [entry.path]: t("settingsPathDuplicate") }));
        return;
      }
      props.onChangeIndex({
        user_index: entries.map((e) =>
          e.path === entry.path
            ? { ...e, path: check.path, name: e.name.trim() || basename(check.path) }
            : e,
        ),
      });
      setEntryErrors((all) => {
        const next = { ...all };
        delete next[entry.path];
        return next;
      });
    } catch (err) {
      setEntryErrors((all) => ({ ...all, [entry.path]: settingsError(err) }));
    }
  }

  function removeUserIndex(entry: { path: string }) {
    props.onChangeIndex({
      user_index: (idx().user_index ?? []).filter((e) => e.path !== entry.path),
    });
  }

  // OFF → only .lnk/.exe are indexed.
  function toggleIndexFiles(entry: { path: string; no_files: boolean }) {
    props.onChangeIndex({
      user_index: (idx().user_index ?? []).map((e) =>
        e.path === entry.path ? { ...e, no_files: !entry.no_files } : e,
      ),
    });
  }

  function setSystemDir(dirPath: string, enabled: boolean) {
    props.onChangeIndex({
      system_dirs: idx().system_dirs.map((d) =>
        d.path === dirPath ? { ...d, enabled } : d,
      ),
    });
  }

  async function refreshIndexNow() {
    if (refreshing() || rebuilding()) return;
    setRefreshing(true);
    setStatus({ ok: true, text: t("settingsRefreshRunning") });
    try {
      await invoke("refresh_index");
      setStatus({ ok: true, text: t("settingsRefreshed") });
    } catch (err) {
      setStatus({ ok: false, text: settingsError(err, "settingsRefreshFailed") });
    } finally {
      setRefreshing(false);
    }
  }

  function rebuildIndexNow() {
    if (refreshing() || rebuilding()) return;
    props.requestConfirm({
      title: t("settingsRebuildIndexConfirmTitle"),
      hint: t("settingsRebuildIndexConfirmHint"),
      confirmLabel: t("settingsRebuildIndex"),
      action: async () => {
        setRebuilding(true);
        setStatus({ ok: true, text: t("settingsRebuildRunning") });
        try {
          await invoke("rebuild_index");
          setStatus({ ok: true, text: t("settingsRebuilt") });
        } catch (err) {
          setStatus({ ok: false, text: settingsError(err, "settingsRebuildFailed") });
          throw err;
        } finally {
          setRebuilding(false);
        }
      },
    });
  }

  return (
    <>
      <div class="settings-page-inline-action settings-index-maintenance">
        <button
          class="settings-action"
          data-setting-id="action.refresh_index"
          aria-busy={refreshing()}
          disabled={refreshing() || rebuilding()}
          onClick={() => void refreshIndexNow()}
        >
          {t(refreshing() ? "settingsRefreshRunning" : "settingsRefreshIndex")}
        </button>
        <button
          class="settings-action"
          data-setting-id="action.rebuild_index"
          aria-busy={rebuilding()}
          disabled={refreshing() || rebuilding()}
          onClick={rebuildIndexNow}
        >
          {t(rebuilding() ? "settingsRebuildRunning" : "settingsRebuildIndex")}
        </button>
      </div>
      <SettingGroup id="index.system_dirs" title={t("settingsSystemIndex")} number="04.1">
        <For each={idx().system_dirs}>
          {(d) => {
            const label =
              d.path === "Desktop"
                ? t("settingsIndexDesktop")
                : d.path === "StartMenu"
                  ? t("settingsIndexStartMenu")
                  : d.path;
            return (
              <SettingRow
                id={`index.system_dirs.${d.path}`}
                label={label}
                summary={t(SYSTEM_DIR_HINT[d.path] ?? "settingsSystemIndexHint")}
              >
                <Toggle
                  checked={d.enabled}
                  label={label}
                  onChange={(v) => setSystemDir(d.path, v)}
                />
              </SettingRow>
            );
          }}
        </For>
      </SettingGroup>

      <SettingGroup id="index.user_index_group" title={t("settingsUserIndex")} number="04.2">
        <SettingRow
          id="index.user_index"
          label={t("settingsIndexDirs")}
          summary={t("settingsIndexFilesHint")}
          class="settings-editor-row"
        >
          <div class="settings-inline-editor">
        <Show
          when={(idx().user_index ?? []).length > 0}
          fallback={<span class="settings-empty">{t("settingsUserIndexEmpty")}</span>}
        >
          <For each={idx().user_index ?? []}>
            {(entry) => (
              <div class="settings-listitem">
                <div class="settings-index-row">
                  <button
                    class="settings-icon-btn settings-index-repair"
                    type="button"
                    title={t("settingsChooseFolder")}
                    aria-label={`${t("settingsChooseFolder")}: ${entry.name}`}
                    onClick={() => void repairEntry(entry)}
                  >
                    <img class="settings-icon-btn-icon" src={folderOpenIcon} alt="" draggable={false} />
                  </button>
                  <div class="settings-index-copy">
                    <span class="settings-index-name" title={entry.name}>{entry.name}</span>
                    <span class="settings-path" title={entry.path}>{entry.path}</span>
                  </div>
                  <div class="settings-index-actions">
                    <span class="settings-index-files-label">{t("settingsIndexFilesShort")}</span>
                    <Toggle
                      checked={!entry.no_files}
                      label={`${t("settingsIndexFiles")}: ${entry.name}`}
                      onChange={() => toggleIndexFiles(entry)}
                    />
                    <button
                      class="settings-icon-btn"
                      type="button"
                      title={t("delete")}
                      aria-label={`${t("delete")}: ${entry.name}`}
                      onClick={() => removeUserIndex(entry)}
                    >
                      <img class="settings-icon-btn-icon" src={deleteIcon} alt="" draggable={false} />
                    </button>
                  </div>
                </div>
                <Show when={entryErrors()[entry.path]}>
                  <span class="settings-error" role="alert">{entryErrors()[entry.path]}</span>
                </Show>
              </div>
            )}
          </For>
        </Show>
        <div class="settings-row settings-listadd">
          <input
            class="settings-text-input settings-input-name"
            type="text"
            placeholder={t("settingsUserIndexName")}
            aria-label={t("settingsUserIndexName")}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addUserIndex();
            }}
          />
          <input
            class="settings-text-input"
            type="text"
            placeholder={t("settingsPathPlaceholder")}
            aria-label={t("settingsPathPlaceholder")}
            value={path()}
            onInput={(e) => {
              setPath(e.currentTarget.value);
              setPathError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void addUserIndex();
            }}
          />
          <button
            class="settings-icon-btn"
            type="button"
            title={t("settingsChooseFolder")}
            aria-label={t("settingsChooseFolder")}
            onClick={() => void chooseNewFolder()}
          >
            <img class="settings-icon-btn-icon" src={folderOpenIcon} alt="" draggable={false} />
          </button>
          <button
            class="settings-icon-btn"
            type="button"
            title={t("settingsAdd")}
            aria-label={t("settingsAdd")}
            disabled={!path().trim() || validating()}
            onClick={() => void addUserIndex()}
          >
            <img class="settings-icon-btn-icon" src={folderPlusIcon} alt="" draggable={false} />
          </button>
        </div>
        <Show when={pathError()}>
          <span class="settings-inline-error" role="alert">{pathError()}</span>
        </Show>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup
        id="index.full_drive_group"
        title={t("settingsFullDriveIndex")}
        number="04.3"
      >
        <SettingRow
          id="index.full_drive_search"
          label={t("settingsFullDriveIndexToggle")}
          summary={
            svcInstalled() === false
              ? t("settingsFullDriveServiceRequiredSummary")
              : t("settingsFullDriveIndexHint")
          }
          class="settings-single-line-summary"
        >
          <Toggle
            checked={fullDriveEnabled()}
            label={t("settingsFullDriveIndex")}
            disabled={fullDriveBusy()}
            onChange={(v) => void toggleFullDrive(v)}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("groupIndexCache")} number="04.4">
        <SettingRow
          id="index.cache_refresh_interval_minutes"
          label={t("settingsCacheRefresh")}
          summary={t("settingsCacheHint")}
        >
          <div class="settings-slider">
            <input
              class="settings-slider-input"
              type="range"
              min={5}
              max={1440}
              step={5}
              value={idx().cache_refresh_interval_minutes}
              aria-label={t("settingsCacheRefresh")}
              style={{
                "--fill": `${
                  ((idx().cache_refresh_interval_minutes - 5) / (1440 - 5)) * 100
                }%`,
              }}
              onInput={(e) => {
                const v = e.currentTarget.valueAsNumber;
                if (Number.isFinite(v)) {
                  props.onChangeIndex({ cache_refresh_interval_minutes: Math.round(v) });
                }
              }}
            />
            <span class="settings-slider-value">
              {idx().cache_refresh_interval_minutes} {t("settingsMinutes")}
            </span>
          </div>
        </SettingRow>
      </SettingGroup>
      <Show when={status()}>
        <span
          class="settings-status"
          classList={{ error: !status()!.ok }}
          role={status()!.ok ? "status" : "alert"}
        >
          {status()!.text}
        </span>
      </Show>
    </>
  );
}
