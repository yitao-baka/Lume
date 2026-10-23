//! Small, secret-free diagnostic rings exposed to CDP probes.

type ProbeWindow = Window & {
  __pageRuntimeVersion?: string;
  __pageModels?: unknown[];
  __pageIntents?: unknown[];
  __presenterStates?: unknown[];
  __pageResources?: unknown[];
};

export function installPageRuntimeProbes(version = "lume.page/v1"): void {
  if (typeof window === "undefined") return;
  const w = window as ProbeWindow;
  w.__pageRuntimeVersion = version;
  w.__pageModels ??= [];
  w.__pageIntents ??= [];
  w.__presenterStates ??= [];
  w.__pageResources ??= [];
}

export function pushDiagnostic(
  name: "__pageModels" | "__pageIntents" | "__presenterStates" | "__pageResources",
  value: unknown,
  limit = 80
): void {
  if (typeof window === "undefined") return;
  const w = window as ProbeWindow;
  const ring = (w[name] ??= []);
  ring.push(value);
  if (ring.length > limit) ring.splice(0, ring.length - limit);
}
