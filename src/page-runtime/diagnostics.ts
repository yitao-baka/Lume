//! Small, secret-free diagnostic rings exposed to CDP probes. Production
//! builds disable the rings; debug builds keep a bounded surface for the UI
//! harness.

type ProbeWindow = Window & {
  __LUME_DEBUG__?: boolean;
  __pageRuntimeVersion?: string;
  __pageModels?: unknown[];
  __pageIntents?: unknown[];
  __presenterStates?: unknown[];
  __pageResources?: unknown[];
};

export function diagnosticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return (window as ProbeWindow).__LUME_DEBUG__ !== false;
}

export function diagnosticBytes(value: unknown): number {
  try {
    // Three bytes per UTF-16 code unit bounds BMP UTF-8 output (surrogate
    // pairs are 2 units / 4 bytes). This avoids allocating a second encoded
    // buffer for every cache and diagnostic-budget check.
    return (JSON.stringify(value) ?? "").length * 3;
  } catch {
    return 0;
  }
}

/** Keep the useful shape of a value without retaining its object graph. */
export function diagnosticSummary(value: unknown, previewChars = 240) {
  let serialized = "";
  try {
    serialized = JSON.stringify(value) ?? String(value ?? "");
  } catch {
    serialized = String(value ?? "");
  }
  const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const fields = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : undefined;
  return {
    type,
    ...(fields != null ? { fields } : {}),
    bytes: diagnosticBytes(value),
    preview: serialized.slice(0, previewChars),
  };
}

/** Append to a debug-only window ring with both entry and byte ceilings. */
export function pushBoundedDiagnostic(
  name: string,
  value: unknown,
  maxEntries = 80,
  maxBytes = 256 * 1024,
): void {
  if (!diagnosticsEnabled()) return;
  const w = window as unknown as Record<string, unknown>;
  const ring = (w[name] ??= []) as unknown[];
  ring.push(value);
  while (ring.length > maxEntries) ring.shift();
  while (ring.length > 1 && diagnosticBytes(ring) > maxBytes) ring.shift();
}

export function exposeDebugProbe(name: string, value: unknown): void {
  if (!diagnosticsEnabled()) return;
  (window as unknown as Record<string, unknown>)[name] = value;
}

export function installPageRuntimeProbes(version = "lume.page/v1"): void {
  if (!diagnosticsEnabled()) return;
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
  pushBoundedDiagnostic(name, value, limit);
}
