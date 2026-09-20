//! 「系统」页 — auto-start, the LumeSVC service and import/export (with the
//! backup restore that the Flutter settings dropped). 恢复默认设置 lives in
//! the footer now (two-step: reset working copy → 保存并应用).

import { createSignal, Show, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { Row, Toggle } from "./controls";

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
  onReload: () => void;
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
        console.error("autostart_get failed", err);
      }
      try {
        setSvc(await invoke<SvcStatus>("svc_status"));
      } catch (err) {
        setSvcMsg({ ok: false, text: String(err) });
      }
      try {
        setAgent(await invoke<AgentStatus>("agent_status"));
      } catch (err) {
        setAgentMsg({ ok: false, text: String(err) });
      }
    })();
  });

  async function toggleAutostart(v: boolean) {
    try {
      await invoke("autostart_set", { enabled: v });
      setAutostart(v);
      setAutostartMsg({ ok: true, text: t(v ? "settingsAutostartOn" : "settingsAutostartOff") });
    } catch (err) {
      setAutostartMsg({ ok: false, text: String(err) });
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
    let accepted = false;
    try {
      // Blocks through the UAC prompt; returns "canceled" when dismissed.
      await invoke(installing ? "agent_install" : "agent_uninstall");
      accepted = true;
      setAgentMsg({
        ok: true,
        text: t(installing ? "settingsAgentInstalling" : "settingsAgentUninstalling"),
      });
    } catch (err) {
      const msg = String(err);
      setAgentMsg({
        ok: false,
        text: msg.includes("canceled") ? t("settingsAgentUacCanceled") : msg,
      });
    }
    // The elevated lume-agent.exe works after UAC is accepted. Re-query and
    // report a definitive result so the transient message does not linger.
    setTimeout(() => {
      void (async () => {
        try {
          const a = await invoke<AgentStatus>("agent_status");
          setAgent(a);
          if (accepted) {
            const ok = installing ? a.installed : !a.installed;
            setAgentMsg({
              ok,
              text: installing
                ? t(ok ? "settingsAgentInstalled" : "settingsAgentInstallFailed")
                : t(ok ? "settingsAgentUninstalled" : "settingsAgentUninstallFailed"),
            });
          }
        } catch (err) {
          setAgentMsg({ ok: false, text: String(err) });
        }
        setAgentBusy(false);
      })();
    }, 2000);
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

  async function restoreBackup() {
    try {
      await invoke("restore_backup");
      setStatus({ ok: true, text: t("settingsRestored") });
      props.onReload();
    } catch (err) {
      setStatus({ ok: false, text: String(err) });
    }
  }

  return (
    <>
      <h2 class="settings-grouptitle">{t("settingsAutostart")}</h2>
      <div class="settings-group">
        <Row label={t("settingsAutostart")}>
          <Toggle checked={autostart()} onChange={(v) => void toggleAutostart(v)} />
        </Row>
        <Show when={autostartMsg()}>
          <span
            classList={{ "settings-status": true, error: !autostartMsg()!.ok }}
          >
            {autostartMsg()!.text}
          </span>
        </Show>
      </div>

      <h2 class="settings-grouptitle">{t("settingsSystemService")}</h2>
      <div class="settings-group">
        <div class="settings-row-between">
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

      <h2 class="settings-grouptitle">{t("settingsAgentGroup")}</h2>
      <div class="settings-group">
        <div class="settings-row-between">
          <span class="settings-path">{agentText()}</span>
          <button
            class="settings-action"
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
          >
            {agentMsg()!.text}
          </span>
        </Show>
      </div>

      <h2 class="settings-grouptitle">{t("settingsImportExport")}</h2>
      <div class="settings-group">
        <div class="settings-row">
          <ConfirmButton label={t("settingsExport")} onAction={exportSettings} />
          <ConfirmButton label={t("settingsImport")} onAction={importSettings} />
          <ConfirmButton label={t("settingsRestoreBackup")} confirm onAction={restoreBackup} />
        </div>
        <Show when={status()}>
          <span
            classList={{ "settings-status": true, error: !status()!.ok }}
          >
            {status()!.text}
          </span>
        </Show>
      </div>
    </>
  );
}
