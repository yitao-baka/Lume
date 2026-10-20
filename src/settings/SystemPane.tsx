//! 「系统」页 — auto-start, the LumeSVC service, elevation agent, and explicit
//! import/export/restore operations. Reversible settings autosave; this page
//! uses status tickets and confirmation dialogs instead.

import { createSignal, Show, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { SettingGroup, SettingRow, StatusTicket, Toggle } from "./controls";
import { settingsError } from "./errors";

/** Status of the LumeSVC service as reported by the Rust `svc_status` command. */
interface SvcStatus {
  installed: boolean;
  running: boolean;
  bin_path: string | null;
}

/** Status of the elevated injection helper (`agent_status`). `installed` means
 * the scheduled task is registered; `running` means it answers on its pipe. */
interface AgentStatus {
  installed: boolean;
  running: boolean;
  elevated: boolean;
  session: number | null;
  sent_total: number;
  bin_path: string | null;
  task_name: string;
  idle_exit_secs: number;
}

/** A button that requires a second click to confirm (restore backup). */
function ConfirmButton(props: {
  label: string;
  confirm?: boolean;
  settingId?: string;
  confirmTitle?: string;
  confirmHint?: string;
  requestConfirm?: (state: {
    title: string;
    hint: string;
    confirmLabel: string;
    action: () => Promise<void>;
  }) => void;
  onAction: () => Promise<void>;
  disabled?: boolean;
}) {
  async function handle() {
    if (props.confirm && props.requestConfirm) {
      props.requestConfirm({
        title: props.confirmTitle ?? props.label,
        hint: props.confirmHint ?? "",
        confirmLabel: props.label,
        action: props.onAction,
      });
      return;
    }
    await props.onAction();
  }
  return (
    <button
      class="settings-action"
      type="button"
      data-setting-id={props.settingId}
      disabled={props.disabled}
      onClick={() => void handle()}
    >
      {props.label}
    </button>
  );
}

export default function SystemPane(props: {
  settings: SettingsData;
  onReload: () => void;
  /** False = pending autosave failed; do not replace the live file. */
  confirmDiscard: () => Promise<boolean>;
  requestConfirm: (state: {
    title: string;
    hint: string;
    confirmLabel: string;
    action: () => Promise<void>;
  }) => void;
}) {
  const [status, setStatus] = createSignal<{ ok: boolean; text: string } | null>(null);

  // --- LumeSVC service + auto-start (independent of the settings working copy:
  // the registry is the single source of truth, not settings.toml). ---
  const [autostart, setAutostart] = createSignal(false);
  const [autostartMsg, setAutostartMsg] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [svc, setSvc] = createSignal<SvcStatus>({
    installed: false,
    running: false,
    bin_path: null,
  });
  const [svcBusy, setSvcBusy] = createSignal(false);
  const [svcMsg, setSvcMsg] = createSignal<{ ok: boolean; text: string } | null>(null);

  // 提权代理 — same "the OS is the source of truth" model as the service.
  const [agent, setAgent] = createSignal<AgentStatus>({
    installed: false,
    running: false,
    elevated: false,
    session: null,
    sent_total: 0,
    bin_path: null,
    task_name: "",
    idle_exit_secs: 0,
  });
  const [agentBusy, setAgentBusy] = createSignal(false);
  const [agentMsg, setAgentMsg] = createSignal<{ ok: boolean; text: string } | null>(null);

  onMount(() => {
    void (async () => {
      try {
        setAutostart(await invoke<boolean>("autostart_get"));
      } catch (err) {
        setAutostartMsg({ ok: false, text: settingsError(err) });
      }
      try {
        setSvc(await invoke<SvcStatus>("svc_status"));
      } catch (err) {
        setSvcMsg({ ok: false, text: settingsError(err) });
      }
      try {
        setAgent(await invoke<AgentStatus>("agent_status"));
      } catch (err) {
        setAgentMsg({ ok: false, text: settingsError(err) });
      }
    })();
  });

  async function toggleAutostart(v: boolean) {
    try {
      await invoke("autostart_set", { enabled: v });
      setAutostart(v);
      setAutostartMsg({ ok: true, text: t(v ? "settingsAutostartOn" : "settingsAutostartOff") });
    } catch (err) {
      setAutostartMsg({ ok: false, text: settingsError(err) });
    }
  }

  type ServiceAction = "install" | "uninstall" | "start" | "restart";

  async function waitForService(
    expected: (status: SvcStatus) => boolean,
  ): Promise<SvcStatus> {
    for (let i = 0; i < 160; i++) {
      try {
        const next = await invoke<SvcStatus>("svc_status");
        setSvc(next);
        if (expected(next)) return next;
      } catch {
        // SCM can briefly reject queries while the service entry is changing;
        // keep polling until the stable state or timeout.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("service state did not settle");
  }

  async function runServiceAction(action: ServiceAction) {
    if (svcBusy()) return;
    setSvcBusy(true);
    setSvcMsg({
      ok: true,
      text: t(
        action === "install"
          ? "settingsServiceInstalling"
          : action === "uninstall"
            ? "settingsServiceUninstalling"
            : action === "start"
              ? "settingsServiceStarting"
              : "settingsServiceRestarting",
      ),
    });
    try {
      await invoke(`svc_${action}`);
      const expected =
        action === "uninstall"
          ? (s: SvcStatus) => !s.installed
          : action === "install"
            ? (s: SvcStatus) => s.installed && s.running
            : (s: SvcStatus) => s.installed && s.running;
      await waitForService(expected);
      setSvcMsg({
        ok: true,
        text: t(
          action === "install"
            ? "settingsServiceInstalled"
            : action === "uninstall"
              ? "settingsServiceUninstalled"
              : action === "start"
                ? "settingsServiceStarted"
                : "settingsServiceRestarted",
        ),
      });
    } catch (err) {
      setSvcMsg({
        ok: false,
        text: settingsError(
          err,
          action === "install"
            ? "settingsServiceInstallFailed"
            : action === "uninstall"
              ? "settingsServiceUninstallFailed"
              : "settingsServiceActionFailed",
        ),
      });
    } finally {
      setSvcBusy(false);
    }
  }

  const svcText = () => {
    const s = svc();
    if (!s.installed) return t("settingsServiceNotInstalled");
    return s.running ? t("settingsServiceRunning") : t("settingsServiceStopped");
  };

  /** 提权代理: installed = the scheduled task exists, running = it answers. */
  const agentText = () => {
    const a = agent();
    if (!a.installed) return t("settingsAgentNotInstalled");
    if (!a.running) return t("settingsAgentRegistered");
    return a.elevated ? t("settingsAgentRunning") : t("settingsAgentNotElevated");
  };

  async function performAgentToggle() {
    if (agentBusy()) return;
    setAgentBusy(true);
    setAgentMsg(null);
    const installing = !agent().installed;
    try {
      // Blocks through the UAC prompt; returns "canceled" when dismissed.
      await invoke(installing ? "agent_install" : "agent_uninstall");
      setAgentMsg({
        ok: true,
        text: t(installing ? "settingsAgentInstalling" : "settingsAgentUninstalling"),
      });
    } catch (err) {
      setAgentMsg({
        ok: false,
        text: settingsError(
          err,
          installing ? "settingsAgentInstallFailed" : "settingsAgentUninstallFailed",
        ),
      });
      setAgentBusy(false);
      return;
    }
    // agent_install/agent_uninstall already wait for the elevated worker's
    // real result, so a single status read is the stable value here.
    try {
      const a = await invoke<AgentStatus>("agent_status");
      setAgent(a);
      const ok = installing ? a.installed : !a.installed;
      setAgentMsg({
        ok,
        text: t(
          installing
            ? ok
              ? "settingsAgentInstalled"
              : "settingsAgentInstallFailed"
            : ok
              ? "settingsAgentUninstalled"
              : "settingsAgentUninstallFailed",
        ),
      });
    } catch (err) {
      setAgentMsg({ ok: false, text: settingsError(err) });
    } finally {
      setAgentBusy(false);
    }
  }

  function toggleAgent() {
    if (!agent().installed) {
      void performAgentToggle();
      return;
    }
    props.requestConfirm({
      title: t("settingsConfirmUninstallAgentTitle"),
      hint: t("settingsConfirmUninstallAgentHint"),
      confirmLabel: t("settingsAgentUninstall"),
      action: performAgentToggle,
    });
  }

  async function importSettings() {
    const file = await open({
      multiple: false,
      filters: [{ name: "TOML", extensions: ["toml"] }],
    });
    if (typeof file !== "string") return;
    props.requestConfirm({
      title: t("settingsConfirmImportTitle"),
      hint: t("settingsConfirmImportHint"),
      confirmLabel: t("settingsImport"),
      action: async () => {
        if (!(await props.confirmDiscard())) return;
        try {
          await invoke("import_settings", { sourcePath: file });
          setStatus({ ok: true, text: t("settingsImported") });
          props.onReload();
        } catch (err) {
          setStatus({ ok: false, text: settingsError(err, "settingsImportFailed") });
        }
      },
    });
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
      setStatus({ ok: false, text: settingsError(err, "settingsExportFailed") });
    }
  }

  async function restoreBackup() {
    props.requestConfirm({
      title: t("settingsConfirmRestoreBackupTitle"),
      hint: t("settingsConfirmRestoreBackupHint"),
      confirmLabel: t("settingsRestoreBackup"),
      action: async () => {
        if (!(await props.confirmDiscard())) return;
        try {
          await invoke("restore_backup");
          setStatus({ ok: true, text: t("settingsRestored") });
          props.onReload();
        } catch (err) {
          setStatus({ ok: false, text: settingsError(err, "settingsRestoreFailed") });
        }
      },
    });
  }

  return (
    <>
      <SettingGroup title={t("settingsAutostart")} number="08.1">
        <SettingRow
          id="system.autostart"
          label={t("settingsAutostart")}
          summary={t("settingsAutostartHint")}
        >
          <Toggle
            checked={autostart()}
            label={t("settingsAutostart")}
            onChange={(value) => void toggleAutostart(value)}
          />
        </SettingRow>
        <Show when={autostartMsg()}>
          <div class="settings-group-status">
            <span
              classList={{ "settings-status": true, error: !autostartMsg()!.ok }}
              role={autostartMsg()!.ok ? "status" : "alert"}
            >
              {autostartMsg()!.text}
            </span>
          </div>
        </Show>
      </SettingGroup>

      <SettingGroup title={t("settingsSystemService")} number="08.2">
        <div class="settings-ticket-wrap">
          <StatusTicket
            id="system.service"
            title={t("settingsSystemService")}
            status={svcText()}
            tone={svc().running ? "ok" : svc().installed ? "warn" : "neutral"}
          >
            <p class="settings-row-summary">{t("settingsServiceHint")}</p>
            <div class="settings-ticket-actions">
              <Show
                when={svc().installed}
                fallback={
                  <button
                    class="settings-action settings-action-primary"
                    type="button"
                    disabled={svcBusy()}
                    onClick={() => void runServiceAction("install")}
                  >
                    {t("settingsRegisterService")}
                  </button>
                }
              >
                <Show when={!svc().running}>
                  <button
                    class="settings-action"
                    type="button"
                    disabled={svcBusy()}
                    onClick={() => void runServiceAction("start")}
                  >
                    {t("settingsStartService")}
                  </button>
                </Show>
                <button
                  class="settings-action"
                  type="button"
                  disabled={svcBusy()}
                  onClick={() => void runServiceAction("restart")}
                >
                  {t("settingsRestartService")}
                </button>
                <ConfirmButton
                  label={t("settingsUninstallService")}
                  confirm
                  confirmTitle={t("settingsConfirmUninstallServiceTitle")}
                  confirmHint={t("settingsConfirmUninstallServiceHint")}
                  requestConfirm={props.requestConfirm}
                  disabled={svcBusy()}
                  onAction={() => runServiceAction("uninstall")}
                />
              </Show>
            </div>
            <Show when={svcMsg()}>
              <span
                classList={{ "settings-status": true, error: !svcMsg()!.ok }}
                role={svcMsg()!.ok ? "status" : "alert"}
              >
                {svcMsg()!.text}
              </span>
            </Show>
          </StatusTicket>

          <StatusTicket
            id="system.agent"
            title={t("settingsAgentGroup")}
            status={agentText()}
            tone={agent().elevated ? "ok" : agent().installed ? "warn" : "neutral"}
          >
            <p class="settings-row-summary">{t("settingsAgentHint")}</p>
            <div class="settings-ticket-actions">
              <button
                class="settings-action"
                type="button"
                disabled={agentBusy()}
                onClick={() => void toggleAgent()}
              >
                {agent().installed ? t("settingsAgentUninstall") : t("settingsAgentInstall")}
              </button>
            </div>
            <Show when={agentMsg()}>
              <span
                classList={{ "settings-status": true, error: !agentMsg()!.ok }}
                role={agentMsg()!.ok ? "status" : "alert"}
              >
                {agentMsg()!.text}
              </span>
            </Show>
          </StatusTicket>
        </div>
      </SettingGroup>

      <SettingGroup title={t("settingsImportExport")} number="08.3">
        <div class="settings-data-actions">
          <p class="settings-row-summary">{t("settingsImportExportHint")}</p>
          <div class="settings-data-action-row">
            <ConfirmButton settingId="system.export_settings" label={t("settingsExport")} onAction={exportSettings} />
            <ConfirmButton settingId="system.import_settings" label={t("settingsImport")} onAction={importSettings} />
            <ConfirmButton
              settingId="system.restore_backup"
              label={t("settingsRestoreBackup")}
              onAction={restoreBackup}
            />
          </div>
          <Show when={status()}>
            <span
              classList={{ "settings-status": true, error: !status()!.ok }}
              role={status()!.ok ? "status" : "alert"}
            >
              {status()!.text}
            </span>
          </Show>
        </div>
      </SettingGroup>
    </>
  );
}
