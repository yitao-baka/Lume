//! 「系统」页 — shortcuts (custom + live validation), index directories,
//! import/export/restore (docs/SETTINGS.md).

import { createEffect, createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t, type Messages } from "../i18n";
import type { SettingsData } from "./types";
import { Chip, Toggle } from "./InterfacePane";
import folderPlusIcon from "../../res/icons/folder_plus.svg";
import deleteIcon from "../../res/icons/delete.svg";
import refreshIcon from "../../res/icons/refresh.svg";

/** Status of the LumeSVC service as reported by the Rust `svc_status` command. */
interface SvcStatus {
  installed: boolean;
  running: boolean;
  bin_path: string | null;
}

/** Keyboard `code` → the shortcut name the Rust parser accepts ("KeyK" → "K"). */
function codeToKey(code: string): string {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

const MODIFIER_CODES = new Set([
  "ControlLeft", "ControlRight", "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight",
]);

/** Build a shortcut string from a keydown event ("Ctrl+Alt+K"). */
function comboFromEvent(e: KeyboardEvent): string | null {
  if (MODIFIER_CODES.has(e.code)) return null; // modifier alone — keep waiting
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Super");
  const key = codeToKey(e.code);
  return key ? [...mods, key].join("+") : null;
}

/** Machine reason codes from the Rust validator → localized message keys. */
const REASON_KEY: Record<string, keyof Messages> = {
  need_modifier: "hotkeyNeedModifier",
  conflict_lume: "hotkeyConflictLume",
  taken: "hotkeyTaken",
  invalid: "hotkeyInvalid",
};

interface HotkeyCheck {
  ok: boolean;
  reason: string | null;
}

/** A hotkey slot: preset chips + a 自定义 recording button with live
 * validation (format + Lume conflict + system occupancy). */
function HotkeyControl(props: {
  presets: string[];
  value: string;
  other: string;
  onCommit: (v: string) => void;
}) {
  const [recording, setRecording] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  function onKeyDown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    const combo = comboFromEvent(e);
    if (!combo) return;
    void (async () => {
      const res = await invoke<HotkeyCheck>("validate_hotkey", {
        combo,
        other: props.other,
      });
      if (res.ok) {
        setError(null);
        setRecording(false);
        props.onCommit(combo);
      } else {
        setError(t(REASON_KEY[res.reason ?? ""] ?? "hotkeyInvalid"));
        // stay recording — the user can retry
      }
    })();
  }

  createEffect(() => {
    if (recording()) {
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }
  });

  const isPreset = () => props.presets.includes(props.value);

  return (
    <div class="settings-sub">
      <div class="settings-row">
        <For each={props.presets}>
          {(p) => (
            <Chip
              label={p}
              active={props.value === p}
              onClick={() => {
                setRecording(false);
                setError(null);
                props.onCommit(p);
              }}
            />
          )}
        </For>
        <Chip
          label={
            recording()
              ? t("hotkeyRecording")
              : isPreset()
                ? t("settingsCustom")
                : props.value
          }
          active={recording() || !isPreset()}
          onClick={() => {
            setRecording((r) => !r);
            setError(null);
          }}
        />
      </div>
      <Show when={error()}>
        <span class="settings-error">{error()}</span>
      </Show>
    </div>
  );
}

/** A button that requires a second click to confirm (restore actions). */
function ConfirmButton(props: {
  label: string;
  confirm?: boolean;
  onAction: () => Promise<void>;
}) {
  const [arming, setArming] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  async function handle() {
    if (props.confirm && !arming()) {
      setArming(true);
      timer = setTimeout(() => setArming(false), 3000);
      return;
    }
    clearTimeout(timer);
    setArming(false);
    await props.onAction();
  }
  return (
    <button class="settings-action" onClick={() => void handle()}>
      {props.confirm && arming() ? t("settingsConfirmAction") : props.label}
    </button>
  );
}

export default function SystemPane(props: {
  settings: SettingsData;
  onChangeHotkeys: (patch: Partial<SettingsData["hotkeys"]>) => void;
  onChangeIndex: (patch: Partial<SettingsData["index"]>) => void;
  onReload: () => void;
}) {
  const [path, setPath] = createSignal("");
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | null>(null);

  // --- LumeSVC service + auto-start (independent of the settings working copy:
  // the registry is the single source of truth, not settings.toml). ---
  const [autostart, setAutostart] = createSignal(false);
  const [svc, setSvc] = createSignal<SvcStatus>({
    installed: false,
    running: false,
    bin_path: null,
  });
  const [svcBusy, setSvcBusy] = createSignal(false);
  const [svcMsg, setSvcMsg] = createSignal<{ ok: boolean; text: string } | null>(null);

  async function refreshService() {
    try {
      setSvc(await invoke<SvcStatus>("svc_status"));
    } catch (err) {
      setSvcMsg({ ok: false, text: String(err) });
    }
  }

  // Manual index refresh (Desktop + user dirs + Start Menu).
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
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
      setSvcMsg({ ok: false, text: String(err) });
    }
  }

  onMount(() => {
    void (async () => {
      try {
        setAutostart(await invoke<boolean>("autostart_get"));
      } catch (err) {
        console.error("autostart_get failed", err);
      }
      await refreshService();
    })();
  });

  async function toggleAutostart(v: boolean) {
    try {
      await invoke("autostart_set", { enabled: v });
      setAutostart(v);
      setSvcMsg({ ok: true, text: t(v ? "settingsAutostartOn" : "settingsAutostartOff") });
    } catch (err) {
      setSvcMsg({ ok: false, text: String(err) });
    }
  }

  async function toggleService() {
    if (svcBusy()) return;
    setSvcBusy(true);
    setSvcMsg(null);
    const installing = !svc().installed;
    let accepted = false;
    try {
      // Blocks through the UAC prompt; returns "canceled" when dismissed.
      await invoke(installing ? "svc_install" : "svc_uninstall");
      accepted = true;
      setSvcMsg({
        ok: true,
        text: t(installing ? "settingsServiceInstalling" : "settingsServiceUninstalling"),
      });
    } catch (err) {
      const msg = String(err);
      setSvcMsg({
        ok: false,
        text: msg.includes("canceled") ? t("settingsServiceUacCanceled") : msg,
      });
    }
    // The elevated lume-svc.exe works after UAC is accepted. Re-query and
    // report a definitive result so the transient "registering/uninstalling"
    // message does not linger on screen.
    setTimeout(() => {
      void (async () => {
        try {
          const s = await invoke<SvcStatus>("svc_status");
          setSvc(s);
          if (accepted) {
            const ok = installing ? s.installed && s.running : !s.installed;
            setSvcMsg({
              ok,
              text: installing
                ? t(ok ? "settingsServiceInstalled" : "settingsServiceInstallFailed")
                : t(ok ? "settingsServiceUninstalled" : "settingsServiceUninstallFailed"),
            });
          }
        } catch (err) {
          setSvcMsg({ ok: false, text: String(err) });
        }
        setSvcBusy(false);
      })();
    }, 2000);
  }

  const svcText = () => {
    const s = svc();
    if (!s.installed) return t("settingsServiceNotInstalled");
    return s.running ? t("settingsServiceRunning") : t("settingsServiceStopped");
  };

  const h = () => props.settings.hotkeys;
  const idx = () => props.settings.index;

  function addUserDir() {
    const p = path().trim();
    if (!p) return;
    props.onChangeIndex({ user_dirs: [...idx().user_dirs, p] });
    setPath("");
  }

  function removeUserDir(dir: string) {
    props.onChangeIndex({ user_dirs: idx().user_dirs.filter((d) => d !== dir) });
  }

  // Toggle "index files in this directory": OFF → add to the no-files list.
  function toggleIndexFiles(dir: string) {
    const noFiles = idx().user_dirs_no_files ?? [];
    const present = noFiles.includes(dir);
    props.onChangeIndex({
      user_dirs_no_files: present ? noFiles.filter((d) => d !== dir) : [...noFiles, dir],
    });
  }

  function setSystemDir(dirPath: string, enabled: boolean) {
    props.onChangeIndex({
      system_dirs: idx().system_dirs.map((d) =>
        d.path === dirPath ? { ...d, enabled } : d
      ),
    });
  }

  async function importSettings() {
    const file = await open({
      multiple: false,
      filters: [{ name: "TOML", extensions: ["toml"] }],
    });
    if (typeof file !== "string") return;
    try {
      await invoke("import_settings", { sourcePath: file });
      setStatus({ ok: true, text: t("settingsImported") });
      props.onReload();
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    }
  }

  async function exportSettings() {
    const file = await save({
      defaultPath: "settings.toml",
      filters: [{ name: "TOML", extensions: ["toml"] }],
    });
    if (typeof file !== "string") return;
    try {
      await invoke("export_settings", { targetPath: file });
      setStatus({ ok: true, text: t("settingsExported") });
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    }
  }

  async function restore(kind: "default" | "backup") {
    try {
      await invoke(kind === "default" ? "restore_default" : "restore_backup");
      setStatus({ ok: true, text: t("settingsRestored") });
      props.onReload();
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    }
  }

  return (
    <>
      <div class="settings-group">
        <h2 class="settings-title">{t("settingsHotkeys")}</h2>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("settingsToggleLauncher")}</span>
          <HotkeyControl
            presets={["Alt+Space", "Ctrl+Space"]}
            value={h().toggle}
            other={h().switch_mode}
            onCommit={(v) => props.onChangeHotkeys({ toggle: v })}
          />
        </div>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("settingsSwitchMode")}</span>
          <HotkeyControl
            presets={["Tab"]}
            value={h().switch_mode}
            other={h().toggle}
            onCommit={(v) => props.onChangeHotkeys({ switch_mode: v })}
          />
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-title-row">
          <h2 class="settings-title">{t("settingsIndexDirs")}</h2>
          <button
            class="settings-icon-btn"
            title={t("settingsRefreshIndex")}
            aria-label={t("settingsRefreshIndex")}
            onClick={() => void refreshIndexNow()}
          >
            <img class="settings-icon-btn-icon" src={refreshIcon} alt="" draggable={false} />
          </button>
        </div>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("settingsSystemIndex")}</span>
          <For each={idx().system_dirs}>
            {(d) => (
              <div class="settings-row settings-row-between">
                <span class="settings-path">
                  {d.path === "Desktop"
                    ? t("settingsIndexDesktop")
                    : d.path === "StartMenu"
                      ? t("settingsIndexStartMenu")
                      : d.path}
                </span>
                <Toggle
                  checked={d.enabled}
                  onChange={(v) => setSystemDir(d.path, v)}
                />
              </div>
            )}
          </For>
        </div>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("settingsUserIndex")}</span>
          <div class="settings-row">
            <input
              class="settings-text-input"
              type="text"
              placeholder={t("settingsPathPlaceholder")}
              value={path()}
              onInput={(e) => setPath(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") addUserDir();
              }}
            />
            <button
              class="settings-icon-btn"
              title={t("settingsAdd")}
              aria-label={t("settingsAdd")}
              disabled={!path().trim()}
              onClick={addUserDir}
            >
              <img class="settings-icon-btn-icon" src={folderPlusIcon} alt="" draggable={false} />
            </button>
          </div>
          <For each={idx().user_dirs}>
            {(dir) => (
              <div class="settings-row settings-row-between">
                <span class="settings-path">{dir}</span>
                <div class="settings-row" style={{ gap: "4px" }}>
                  <span title={t("settingsIndexFiles")}>
                    <Toggle
                      checked={!(idx().user_dirs_no_files ?? []).includes(dir)}
                      onChange={() => toggleIndexFiles(dir)}
                    />
                  </span>
                  <button
                    class="settings-icon-btn"
                    title={t("delete")}
                    aria-label={t("delete")}
                    onClick={() => removeUserDir(dir)}
                  >
                    <img class="settings-icon-btn-icon" src={deleteIcon} alt="" draggable={false} />
                  </button>
                </div>
              </div>
            )}
          </For>
        </div>
        <div class="settings-sub">
          <span class="settings-sub-label">{t("settingsCacheRefresh")}</span>
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
        </div>
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("settingsSystemService")}</h2>
        <div class="settings-sub settings-sub-between">
          <span class="settings-sub-label">{t("settingsAutostart")}</span>
          <Toggle checked={autostart()} onChange={(v) => void toggleAutostart(v)} />
        </div>
        <div class="settings-sub">
          <div class="settings-row settings-row-between">
            <span class="settings-path">{svcText()}</span>
            <button
              class="settings-action"
              disabled={svcBusy()}
              onClick={() => void toggleService()}
            >
              {svc().installed
                ? t("settingsUninstallService")
                : t("settingsRegisterService")}
            </button>
          </div>
          <Show when={svcMsg()}>
            <span
              classList={{ "settings-status": true, error: !svcMsg()!.ok }}
            >
              {svcMsg()!.text}
            </span>
          </Show>
        </div>
      </div>

      <div class="settings-group">
        <h2 class="settings-title">{t("settingsImportExport")}</h2>
        <div class="settings-row">
          <ConfirmButton label={t("settingsImport")} onAction={importSettings} />
          <ConfirmButton label={t("settingsExport")} onAction={exportSettings} />
          <ConfirmButton
            label={t("settingsRestoreDefault")}
            confirm
            onAction={() => restore("default")}
          />
          <ConfirmButton
            label={t("settingsRestoreBackup")}
            confirm
            onAction={() => restore("backup")}
          />
        </div>
        <Show when={status()}>
          <span
            classList={{ "settings-status": true, error: !status()!.ok }}
          >
            {status()!.text}
          </span>
        </Show>
      </div>

      <Show when={toast()}>
        <div class="settings-toast" role="status">{toast()}</div>
      </Show>
    </>
  );
}
