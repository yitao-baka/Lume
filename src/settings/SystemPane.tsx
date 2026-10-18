//! 「系统」页 — auto-start, the LumeSVC service and import/export (with the
//! backup restore that the Flutter settings dropped). 恢复应用默认值 lives in
//! the footer now (two-step: reset working copy → 保存并应用).

import { createSignal, Show, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { ImmediateBadge, Row, Toggle } from "./controls";
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
  onAction: () => Promise<void>;
  disabled?: boolean;
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
    <button
      class="settings-action"
      type="button"
      disabled={props.disabled}
      onClick={() => void handle()}
    >
      {props.confirm && arming() ? t("settingsConfirmAction") : props.label}
    </button>
  );
}

export default function SystemPane(props: {
  settings: SettingsData;
  onReload: () => void;
  /** False = the user kept their unsaved draft; skip the instant change. */
  confirmDiscard: () => Promise<boolean>;
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

  async function toggleAgent() {
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

  async function importSettings() {
    const file = await open({
      multiple: false,
      filters: [{ name: "TOML", extensions: ["toml"] }],
    });
    if (typeof file !== "string") return;
    if (!(await props.confirmDiscard())) return;
    try {
      await invoke("import_settings", { sourcePath: file });
      setStatus({ ok: true, text: t("settingsImported") });
      props.onReload();
    } catch (err) {
      setStatus({ ok: false, text: settingsError(err, "settingsImportFailed") });
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
      setStatus({ ok: false, text: settingsError(err, "settingsExportFailed") });
    }
  }

  async function restoreBackup() {
    if (!(await props.confirmDiscard())) return;
    try {
      await invoke("restore_backup");
      setStatus({ ok: true, text: t("settingsRestored") });
      props.onReload();
    } catch (err) {
      setStatus({ ok: false, text: settingsError(err, "settingsRestoreFailed") });
    }
  }

  return (
    <>
      <div class="settings-title-row">
        <h2 class="settings-grouptitle">{t("settingsAutostart")}</h2>
        <ImmediateBadge />
      </div>
      <div class="settings-group">
        <Row label={t("settingsAutostart")}>
          <Toggle
            checked={autostart()}
            label={t("settingsAutostart")}
            onChange={(v) => void toggleAutostart(v)}
          />
        </Row>
        <Show when={autostartMsg()}>
          <span
            classList={{ "settings-status": true, error: !autostartMsg()!.ok }}
            role={autostartMsg()!.ok ? "status" : "alert"}
          >
            {autostartMsg()!.text}
          </span>
        </Show>
      </div>

      <div class="settings-title-row">
        <h2 class="settings-grouptitle">{t("settingsSystemService")}</h2>
        <ImmediateBadge />
      </div>
      <div class="settings-group">
        <div class="settings-row-between">
          <span class="settings-path" role="status" aria-live="polite">{svcText()}</span>
          <div class="settings-row settings-service-actions">
            <Show
              when={svc().installed}
              fallback={
                <button
                  class="settings-action"
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
                disabled={svcBusy()}
                onAction={() => runServiceAction("uninstall")}
              />
            </Show>
          </div>
        </div>
        <Show when={svcMsg()}>
          <span
            classList={{ "settings-status": true, error: !svcMsg()!.ok }}
            role={svcMsg()!.ok ? "status" : "alert"}
          >
            {svcMsg()!.text}
          </span>
        </Show>
      </div>

      <div class="settings-title-row">
        <h2 class="settings-grouptitle">{t("settingsAgentGroup")}</h2>
        <ImmediateBadge />
      </div>
      <div class="settings-group">
        <div class="settings-row-between">
          <span class="settings-path" role="status" aria-live="polite">{agentText()}</span>
          <button
            class="settings-action"
            type="button"
            disabled={agentBusy()}
            onClick={() => void toggleAgent()}
          >
            {agent().installed
              ? t("settingsAgentUninstall")
              : t("settingsAgentInstall")}
          </button>
        </div>
        <p class="settings-hint">{t("settingsAgentHint")}</p>
        <Show when={agentMsg()}>
          <span
            classList={{ "settings-status": true, error: !agentMsg()!.ok }}
            role={agentMsg()!.ok ? "status" : "alert"}
          >
            {agentMsg()!.text}
          </span>
        </Show>
      </div>

      <div class="settings-title-row">
        <h2 class="settings-grouptitle">{t("settingsImportExport")}</h2>
        <ImmediateBadge />
      </div>
      <div class="settings-group">
        <div class="settings-row">
          <ConfirmButton label={t("settingsExport")} onAction={exportSettings} />
          <ConfirmButton label={t("settingsImport")} onAction={importSettings} />
          <ConfirmButton label={t("settingsRestoreBackup")} confirm onAction={restoreBackup} />
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
    </>
  );
}
