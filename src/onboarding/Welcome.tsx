import { createSignal, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import lumeAppIcon from "../../src-tauri/icons/icon-transparent.png";
import { HotkeyKeys } from "./keys";
import type { InjectedOnboarding } from "./types";
import type { SettingsData } from "../settings/types";
import "./welcome.css";

export default function Welcome() {
  const cfg = (window as { __LUME_CONFIG__?: SettingsData }).__LUME_CONFIG__;
  const injected = (window as { __LUME_ONBOARDING__?: InjectedOnboarding }).__LUME_ONBOARDING__;
  const configured = cfg?.hotkeys?.toggle || "Alt+Space";
  const [hotkey, setHotkey] = createSignal(configured);
  const [conflict, setConflict] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    void invoke<string>("get_hotkey")
      .then((active) => {
        setConflict(!active);
        if (active) setHotkey(active);
      })
      .catch((err) => {
        console.error("[onboarding] hotkey state", err);
        setConflict(true);
      });
  });

  async function continueWithoutHotkey() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("onboarding_continue_from_welcome");
    } catch (err) {
      console.error("[onboarding] welcome continue", err);
      setError(t("onboardingOperationFailed"));
      setBusy(false);
    }
  }

  async function skip() {
    if (busy()) return;
    setBusy(true);
    setError(null);
    try {
      await invoke("onboarding_skip");
    } catch (err) {
      console.error("[onboarding] welcome skip", err);
      setError(t("onboardingOperationFailed"));
      setBusy(false);
    }
  }

  return (
    <div class="welcome-window" data-replay={injected?.replay ? "true" : undefined}>
      <header class="welcome-topbar" data-tauri-drag-region>
        <span class="welcome-brand" data-tauri-drag-region>
          <img src={lumeAppIcon} alt="" draggable={false} />
          <span>LUME</span>
        </span>
        <span class="welcome-progress-copy">{t("onboardingStepCounter", { step: 1 })}</span>
      </header>

      <main class="welcome-main" aria-labelledby="welcome-title">
        <div class="onboarding-progress" aria-hidden="true">
          <span class="active" />
          <span />
          <span />
          <span />
        </div>
        <p class="welcome-eyebrow">{t("onboardingWelcomeEyebrow")}</p>
        <h1 id="welcome-title">{t("onboardingWelcomeTitle")}</h1>
        <p class="welcome-body">{t("onboardingWelcomeBody")}</p>
        <div class="welcome-shortcut">
          <HotkeyKeys combo={hotkey()} />
        </div>

        <Show when={conflict()}>
          <p class="welcome-warning" role="alert">{t("onboardingWelcomeConflict")}</p>
        </Show>
        <Show when={!conflict()}>
          <p class="welcome-hint" role="status">{t("onboardingWelcomeHint", { hotkey: hotkey() })}</p>
        </Show>
        <Show when={error()}>
          <p class="welcome-error" role="alert">{error()}</p>
        </Show>
      </main>

      <footer class="welcome-actions">
        <button
          id="welcome-skip"
          class="welcome-skip"
          type="button"
          disabled={busy()}
          onClick={() => void skip()}
        >
          {t("onboardingSkip")}
        </button>
        <button
          id="welcome-continue"
          class="welcome-continue"
          classList={{ prominent: conflict() }}
          type="button"
          disabled={busy()}
          onClick={() => void continueWithoutHotkey()}
        >
          {conflict() ? t("onboardingContinueToLauncher") : t("onboardingContinueWithoutHotkey")}
        </button>
      </footer>
    </div>
  );
}
