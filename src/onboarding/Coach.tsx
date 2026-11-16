import { Show } from "solid-js";
import { t } from "../i18n";
import { HotkeyKeys } from "./keys";
import "./coach.css";

export default function Coach(props: {
  step: number;
  switchKey: string;
  busy: boolean;
  error: string | null;
  onAdvance: () => void;
  onOpenSettings: () => void;
  onDecline: () => void;
  onSkip: () => void;
}) {
  const title = () => {
    if (props.step === 2) return t("onboardingStepModeTitle");
    if (props.step === 3) return t("onboardingStepSettingsTitle");
    return t("onboardingStepAutostartTitle");
  };
  const body = () => {
    if (props.step === 2) return t("onboardingStepModeBody", { key: props.switchKey });
    if (props.step === 3) return t("onboardingStepSettingsBody");
    return t("onboardingStepAutostartBody");
  };

  return (
    <section
      id="onboarding-coach"
      class="onboarding-coach"
      data-step={props.step}
      role="region"
      aria-labelledby="onboarding-coach-title"
      aria-live="polite"
    >
      <div class="onboarding-coach-panel">
        <div class="onboarding-coach-head">
          <span class="onboarding-coach-counter">
            {t("onboardingStepCounter", { step: props.step })}
          </span>
          <div class="onboarding-progress" aria-hidden="true">
            <span classList={{ active: props.step >= 1 }} />
            <span classList={{ active: props.step >= 2 }} />
            <span classList={{ active: props.step >= 3 }} />
            <span classList={{ active: props.step >= 4 }} />
          </div>
        </div>

        <h2 id="onboarding-coach-title">{title()}</h2>
        <p class="onboarding-coach-body">{body()}</p>

        <Show when={props.step === 2}>
          <div class="onboarding-coach-key">
            <HotkeyKeys combo={props.switchKey} />
          </div>
          <p class="onboarding-coach-hint">{t("onboardingModeHint")}</p>
        </Show>

        <Show when={props.step === 3 || props.step === 4}>
          <p class="onboarding-coach-hint">
            {props.step === 3
              ? t("onboardingSettingsHint")
              : t("onboardingAutostartHint")}
          </p>
        </Show>

        <Show when={props.error}>
          <p class="onboarding-coach-error" role="alert">{props.error}</p>
        </Show>

        <div class="onboarding-coach-actions">
          <button
            class="onboarding-skip"
            type="button"
            disabled={props.busy}
            onClick={() => (props.step === 2 ? props.onAdvance() : props.onSkip())}
          >
            {props.step === 2 ? t("onboardingSkipThisStep") : t("onboardingSkip")}
          </button>

          <div class="onboarding-primary-actions">
            <Show when={props.step === 2}>
              <button
                id="onboarding-mouse-continue"
                class="onboarding-secondary"
                type="button"
                disabled={props.busy}
                onClick={() => props.onAdvance()}
              >
                {t("onboardingContinueWithMouse")}
              </button>
            </Show>
            <Show when={props.step === 3 || props.step === 4}>
              <button
                id="onboarding-open-settings"
                class="onboarding-primary"
                type="button"
                disabled={props.busy}
                onClick={() => props.onOpenSettings()}
              >
                {props.step === 3 ? t("onboardingOpenSettings") : t("onboardingContinueAutostart")}
              </button>
            </Show>
            <Show when={props.step === 4}>
              <button
                id="onboarding-autostart-decline"
                class="onboarding-secondary"
                type="button"
                disabled={props.busy}
                onClick={() => props.onDecline()}
              >
                {t("onboardingNotNow")}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </section>
  );
}
