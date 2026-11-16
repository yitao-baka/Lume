export type OnboardingStatus = "in_progress" | "completed" | "skipped";

export interface OnboardingSnapshot {
  status: OnboardingStatus;
  step: number;
  replay: boolean;
}

export interface InjectedOnboarding extends OnboardingSnapshot {}

export const COMPLETED_ONBOARDING: OnboardingSnapshot = {
  status: "completed",
  step: 4,
  replay: false,
};

export function activeOnboardingStep(snapshot: OnboardingSnapshot): number {
  return snapshot.status === "in_progress" ? snapshot.step : 0;
}
