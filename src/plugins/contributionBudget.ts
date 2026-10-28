//! Shared fan-in budgets for plugin contributions. A plugin is untrusted input
//! even after its manifest passes the gate: rows, bars and icon payloads can be
//! arbitrarily large. These limits keep one plugin (or the aggregate host page)
//! from turning the Page Model into a permanent error.

import type { NavBarContribution, PluginIconInput, ProviderResult } from "./types";

export const PROVIDER_ROW_LIMITS = {
  maxRows: 64,
  maxBytes: 192 * 1024,
  maxRowBytes: 16 * 1024,
  maxNameChars: 512,
  maxPathChars: 4096,
  maxDescriptionChars: 2048,
  maxIconChars: 16 * 1024,
} as const;

export const NAV_BAR_LIMITS = {
  maxBarsPerPlugin: 8,
  maxItemsPerBar: 50,
  maxItemsPerPlugin: 120,
  maxTitleChars: 200,
  maxBarIdChars: 200,
  maxNameChars: 512,
  maxPathChars: 4096,
  maxIconChars: 16 * 1024,
  maxBytesPerPlugin: 192 * 1024,
  maxPageBars: 32,
  maxPageItems: 320,
  maxPageBytes: 512 * 1024,
} as const;

export interface ContributionBudgetResult<T> {
  value: T;
  droppedRows: number;
  droppedItems: number;
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** UTF-8 bytes of a JSON-safe value; `Infinity` means it cannot be budgeted. */
export function serializedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function containsNonFiniteNumber(value: unknown, seen = new WeakSet<object>()): boolean {
  if (typeof value === "number") return !Number.isFinite(value);
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsNonFiniteNumber(item, seen));
  return Object.values(value).some((item) => containsNonFiniteNumber(item, seen));
}
function iconWithinBudget(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return value.length <= PROVIDER_ROW_LIMITS.maxIconChars;
  if (!isRecord(value)) return false;
  for (const key of ["light", "dark"] as const) {
    const item = value[key];
    if (item !== undefined && (typeof item !== "string" || item.length > PROVIDER_ROW_LIMITS.maxIconChars)) {
      return false;
    }
  }
  return true;
}

function cleanIcon(value: unknown): string | PluginIconInput | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  const out: PluginIconInput = {};
  if (typeof value.light === "string" && value.light) out.light = value.light;
  if (typeof value.dark === "string" && value.dark) out.dark = value.dark;
  return out.light || out.dark ? out : undefined;
}

/** Validate one provider row and preserve plugin-owned extra fields for
 * `select()` / `onEnter()`. Standard fields are copied and bounded; malformed
 * rows are dropped whole so the plugin gets a predictable failure instead of a
 * half-rendered row. */
export function sanitizeProviderRows(raw: unknown): ContributionBudgetResult<ProviderResult[]> {
  if (!Array.isArray(raw)) {
    return { value: [], droppedRows: 0, droppedItems: 0, truncated: false };
  }

  const rows: ProviderResult[] = [];
  let bytes = 0;
  let droppedRows = 0;
  let truncated = false;

  for (let index = 0; index < raw.length; index++) {
    if (rows.length >= PROVIDER_ROW_LIMITS.maxRows) {
      truncated = true;
      break;
    }
    const source = raw[index];
    if (!isRecord(source)) {
      droppedRows++;
      continue;
    }
    const name = source.name;
    if (typeof name !== "string" || name.trim() === "") {
      droppedRows++;
      continue;
    }
    if (source.enter !== undefined && typeof source.enter !== "boolean") {
      droppedRows++;
      continue;
    }
    if (source.drill !== undefined && typeof source.drill !== "boolean") {
      droppedRows++;
      continue;
    }
    if (source.path !== undefined && typeof source.path !== "string") {
      droppedRows++;
      continue;
    }
    if (source.description !== undefined && typeof source.description !== "string") {
      droppedRows++;
      continue;
    }
    if (!iconWithinBudget(source.icon) || containsNonFiniteNumber(source)) {
      droppedRows++;
      continue;
    }

    const path = typeof source.path === "string" ? source.path : undefined;
    if ((!path || path.length === 0) && source.enter !== true && source.drill !== true) {
      droppedRows++;
      continue;
    }
    if (path && path.length > PROVIDER_ROW_LIMITS.maxPathChars) {
      droppedRows++;
      continue;
    }

    const row: Record<string, unknown> = { ...source };
    row.name = name.length > PROVIDER_ROW_LIMITS.maxNameChars
      ? name.slice(0, PROVIDER_ROW_LIMITS.maxNameChars)
      : name;
    if (row.name !== name) truncated = true;
    if (path === undefined) delete row.path;
    if (typeof source.description === "string") {
      if (source.description.length > PROVIDER_ROW_LIMITS.maxDescriptionChars) {
        row.description = source.description.slice(0, PROVIDER_ROW_LIMITS.maxDescriptionChars);
        truncated = true;
      }
    }
    if (source.icon !== undefined) row.icon = cleanIcon(source.icon);

    const rowBytes = serializedBytes(row);
    if (rowBytes > PROVIDER_ROW_LIMITS.maxRowBytes) {
      droppedRows++;
      continue;
    }
    if (bytes + rowBytes > PROVIDER_ROW_LIMITS.maxBytes) {
      truncated = true;
      break;
    }
    bytes += rowBytes;
    rows.push(row as unknown as ProviderResult);
  }

  return { value: rows, droppedRows, droppedItems: 0, truncated };
}

interface RawNavBar {
  id: string;
  title: string;
  items: { name: string; path: string; icon?: string | PluginIconInput }[];
}

function sanitizeNavItem(
  raw: unknown,
  resolveIcon: (icon: unknown) => string | PluginIconInput | undefined
): { item: RawNavBar["items"][number] | null; truncated: boolean } {
  if (!isRecord(raw)) return { item: null, truncated: false };
  if (typeof raw.name !== "string" || raw.name.trim() === "") return { item: null, truncated: false };
  if (typeof raw.path !== "string" || raw.path.trim() === "") return { item: null, truncated: false };
  if (raw.path.length > NAV_BAR_LIMITS.maxPathChars) return { item: null, truncated: true };
  if (!iconWithinBudget(raw.icon)) return { item: null, truncated: false };

  const name = raw.name.length > NAV_BAR_LIMITS.maxNameChars
    ? raw.name.slice(0, NAV_BAR_LIMITS.maxNameChars)
    : raw.name;
  const icon = resolveIcon(raw.icon);
  return {
    item: {
      name,
      path: raw.path,
      ...(icon ? { icon } : {}),
    },
    truncated: name !== raw.name,
  };
}

/** Validate and budget one plugin's raw `navBars()` return. Bar ids are
 * namespaced here so every consumer sees the same canonical contribution. */
export function sanitizeNavBarContributions(
  pluginId: string,
  raw: unknown,
  resolveIcon: (icon: unknown) => string | PluginIconInput | undefined
): ContributionBudgetResult<RawNavBar[]> {
  if (!Array.isArray(raw)) {
    return { value: [], droppedRows: 0, droppedItems: 0, truncated: false };
  }

  const bars: RawNavBar[] = [];
  const seenBarIds = new Set<string>();
  let totalItems = 0;
  let droppedRows = 0;
  let droppedItems = 0;
  let truncated = false;

  for (const rawBar of raw) {
    if (bars.length >= NAV_BAR_LIMITS.maxBarsPerPlugin) {
      droppedRows++;
      truncated = true;
      break;
    }
    if (!isRecord(rawBar)) {
      droppedRows++;
      continue;
    }
    if (
      typeof rawBar.id !== "string" ||
      rawBar.id === "" ||
      rawBar.id.length > NAV_BAR_LIMITS.maxBarIdChars ||
      typeof rawBar.title !== "string" ||
      !Array.isArray(rawBar.items)
    ) {
      droppedRows++;
      continue;
    }
    if (seenBarIds.has(rawBar.id)) {
      droppedRows++;
      truncated = true;
      continue;
    }
    seenBarIds.add(rawBar.id);

    const title = rawBar.title.length > NAV_BAR_LIMITS.maxTitleChars
      ? rawBar.title.slice(0, NAV_BAR_LIMITS.maxTitleChars)
      : rawBar.title;
    if (title !== rawBar.title) truncated = true;

    const items: RawNavBar["items"] = [];
    for (const rawItem of rawBar.items) {
      if (items.length >= NAV_BAR_LIMITS.maxItemsPerBar || totalItems >= NAV_BAR_LIMITS.maxItemsPerPlugin) {
        droppedItems++;
        truncated = true;
        break;
      }
      const result = sanitizeNavItem(rawItem, resolveIcon);
      if (!result.item) {
        droppedItems++;
        truncated ||= result.truncated;
        continue;
      }
      items.push(result.item);
      totalItems++;
      truncated ||= result.truncated;
    }
    if (items.length === 0) {
      droppedRows++;
      continue;
    }

    const candidate: RawNavBar = {
      id: `${pluginId}:${rawBar.id}`,
      title,
      items,
    };
    while (items.length > 0 && serializedBytes([...bars, candidate]) > NAV_BAR_LIMITS.maxBytesPerPlugin) {
      items.pop();
      totalItems--;
      droppedItems++;
      truncated = true;
    }
    if (items.length > 0) bars.push(candidate);
    else droppedRows++;
  }

  return { value: bars, droppedRows, droppedItems, truncated };
}

/** Enforce the aggregate page budget after all plugin contributions are
 * collected. The registry budget isolates one plugin; this cap protects the
 * combined Navigate model when many plugins are individually valid. */
export function fitNavBarPageBudget(
  bars: NavBarContribution[]
): ContributionBudgetResult<NavBarContribution[]> {
  const out: NavBarContribution[] = [];
  const seenBarIds = new Set<string>();
  let totalItems = 0;
  let droppedRows = 0;
  let droppedItems = 0;
  let truncated = false;

  for (const bar of bars) {
    if (seenBarIds.has(bar.id)) {
      droppedRows++;
      truncated = true;
      continue;
    }
    seenBarIds.add(bar.id);
    if (out.length >= NAV_BAR_LIMITS.maxPageBars) {
      droppedRows++;
      truncated = true;
      break;
    }
    const items = bar.items.slice(0, Math.max(0, NAV_BAR_LIMITS.maxPageItems - totalItems));
    if (items.length < bar.items.length) {
      droppedItems += bar.items.length - items.length;
      truncated = true;
    }
    if (items.length === 0) {
      droppedRows++;
      continue;
    }
    const candidate = { ...bar, items };
    while (items.length > 0 && serializedBytes([...out, candidate]) > NAV_BAR_LIMITS.maxPageBytes) {
      items.pop();
      droppedItems++;
      truncated = true;
    }
    if (items.length === 0) {
      droppedRows++;
      continue;
    }
    totalItems += items.length;
    out.push(candidate);
  }

  return { value: out, droppedRows, droppedItems, truncated };
}
