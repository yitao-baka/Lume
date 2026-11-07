//! Session state (docs/ROADMAP_HISTORY.md #40) — the cross-surface page state that must
//! survive hide/show, mode switches, keep-alive eviction and the detached
//! window hand-off.
//!
//! Two pieces live here:
//! - **Session frames** — per-mode page snapshots (`view` / `titlebar`) that
//!   travel between the launcher and a detached window. Entries are
//!   memory-only, size-capped (`capSnapshot`) and consumed frame-by-frame:
//!   the launcher takes `view`, a detached window takes both; whatever the
//!   consumer cannot use stays stored for the next boundary.
//! - **Host stack** — the keep-alive list of mounted mode pages. Pages are
//!   mounted once (lazy) and hidden instead of unmounted, so page DOM/JS
//!   state survives mode switches and window hides without any snapshot.
//!   Over the cap the least-recently-used evictable page is snapshotted and
//!   unmounted; remounting restores from that snapshot (consume-once, wired
//!   in the registry's ready handshake).

import { createSignal, type Accessor } from "solid-js";
import type { ModeId, ModeInstance, SessionFrames } from "../plugins/types";
import { capSnapshot } from "../plugins/iframeBridge";
import {
  diagnosticBytes,
  exposeDebugProbe,
  pushBoundedDiagnostic,
} from "../page-runtime/diagnostics";

export type SessionFrameName = "view" | "titlebar";

/** Diagnostic tap (CDP probes): every frame store/take/evict lands here. */
function tap(entry: unknown) {
  pushBoundedDiagnostic("__sessionFrames", entry, 80, 64 * 1024);
}

// ── Session frames ──────────────────────────────────────────────────────────

const SESSION_FRAME_TOTAL_BYTES = 4 * 1024 * 1024;
const SESSION_FRAME_TTL_MS = 10 * 60_000;

interface StoredFrame {
  value: unknown;
  bytes: number;
  touchedAt: number;
}

type StoredFrames = Partial<Record<SessionFrameName, StoredFrame>>;

const frames = new Map<string, StoredFrames>();
let frameExpiryTimer: number | undefined;

function totalFrameBytes(): number {
  let total = 0;
  for (const entry of frames.values()) {
    for (const frame of Object.values(entry)) total += frame?.bytes ?? 0;
  }
  return total;
}

function pruneExpiredFrames(now = Date.now()): boolean {
  let changed = false;
  for (const [id, entry] of frames) {
    for (const name of ["view", "titlebar"] as const) {
      const frame = entry[name];
      if (!frame || now - frame.touchedAt < SESSION_FRAME_TTL_MS) continue;
      delete entry[name];
      changed = true;
      tap({ op: "expire", id, frame: name });
    }
    if (Object.keys(entry).length === 0) frames.delete(id);
  }
  if (changed) scheduleFrameExpiry();
  return changed;
}

function scheduleFrameExpiry(): void {
  if (frameExpiryTimer !== undefined) window.clearTimeout(frameExpiryTimer);
  frameExpiryTimer = undefined;
  let earliest = Number.POSITIVE_INFINITY;
  for (const entry of frames.values()) {
    for (const frame of Object.values(entry)) {
      if (frame) earliest = Math.min(earliest, frame.touchedAt + SESSION_FRAME_TTL_MS);
    }
  }
  if (!Number.isFinite(earliest)) return;
  frameExpiryTimer = window.setTimeout(() => {
    frameExpiryTimer = undefined;
    pruneExpiredFrames();
    scheduleFrameExpiry();
  }, Math.max(0, earliest - Date.now()));
}

function evictFramesToBudget(): void {
  while (totalFrameBytes() > SESSION_FRAME_TOTAL_BYTES) {
    let oldestId: string | undefined;
    let oldestName: SessionFrameName | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [id, entry] of frames) {
      for (const name of ["view", "titlebar"] as const) {
        const frame = entry[name];
        if (frame && frame.touchedAt < oldestAt) {
          oldestAt = frame.touchedAt;
          oldestId = id;
          oldestName = name;
        }
      }
    }
    if (!oldestId || !oldestName) break;
    const entry = frames.get(oldestId);
    if (!entry) break;
    delete entry[oldestName];
    if (Object.keys(entry).length === 0) frames.delete(oldestId);
    tap({ op: "budget-evict", id: oldestId, frame: oldestName });
  }
}

exposeDebugProbe("__sessionFrameStats", () => ({
  entries: [...frames.values()].reduce((sum, entry) => sum + Object.keys(entry).length, 0),
  ids: [...frames.keys()],
  bytes: totalFrameBytes(),
  budget: SESSION_FRAME_TOTAL_BYTES,
  ttlMs: SESSION_FRAME_TTL_MS,
}));

/** Store one frame's snapshot (capped; null/oversized values are dropped).
 * Returns whether a frame was actually stored. */
export function putSessionFrame(id: string, frame: SessionFrameName, snap: unknown): boolean {
  pruneExpiredFrames();
  const capped = capSnapshot(snap, id);
  tap({ op: "put", id, frame, ok: capped != null });
  // CDP tap (test/_snapshot_probe.mjs + scripts/cdp_plugin_state_verify.mjs):
  // the stored digest — which fields went in (k:v pairs, first 12).
  const auto = (capped as { auto?: { fields?: Array<{ k?: string; v?: string; c?: boolean }> } } | null)?.auto;
  const digest = (auto?.fields ?? [])
    .slice(0, 12)
    .map((f) => `${f.k ?? "?"}=${f.c != null ? (f.c ? "[x]" : "[ ]") : f.v ?? ""}`);
  pushBoundedDiagnostic(
    "__snapPending",
    { id, frame, stored: capped != null, fields: digest },
    80,
    64 * 1024,
  );
  if (capped == null) return false;
  const cur = frames.get(id) ?? {};
  cur[frame] = { value: capped, bytes: diagnosticBytes(capped), touchedAt: Date.now() };
  frames.set(id, cur);
  evictFramesToBudget();
  scheduleFrameExpiry();
  return true;
}

/** Drop one stored frame (e.g. a detach that failed to open its window). */
export function dropSessionFrame(id: string, frame: SessionFrameName): void {
  pruneExpiredFrames();
  const cur = frames.get(id);
  if (!cur) return;
  delete cur[frame];
  if (Object.keys(cur).length === 0) frames.delete(id);
  else frames.set(id, cur);
  tap({ op: "drop", id, frame });
}

/** Drop every stored frame of one mode (disable / reload / code replaced). */
export function dropSessionFrames(id: string): void {
  pruneExpiredFrames();
  if (frames.delete(id)) tap({ op: "drop-all", id });
}

/** Consume-once: take the requested frames, leave the rest stored. */
export function takeSessionFrames(id: string, which: SessionFrameName[]): SessionFrames | null {
  pruneExpiredFrames();
  const cur = frames.get(id);
  if (!cur) return null;
  const out: SessionFrames = {};
  for (const f of which) {
    if (cur[f] !== undefined) {
      out[f] = cur[f]?.value;
      delete cur[f];
    }
  }
  if (Object.keys(cur).length === 0) frames.delete(id);
  else frames.set(id, cur);
  const taken = Object.keys(out).length > 0;
  tap({ op: "take", id, frames: Object.keys(out) });
  // Legacy CDP tap (test/_snapshot_probe.mjs): consumed view frames.
  pushBoundedDiagnostic("__snapConsume", { id, hadView: out.view !== undefined }, 80, 64 * 1024);
  scheduleFrameExpiry();
  return taken ? out : null;
}

// ── Keep-alive host stack ───────────────────────────────────────────────────

interface HostEntry {
  id: ModeId;
  inst: ModeInstance;
  lastUsed: number;
  evicting?: boolean;
  evictToken?: number;
}

export interface HostStack {
  /** Reactive list for the shell's <For> — stable entry objects, append/remove only. */
  hosts: Accessor<HostEntry[]>;
  /** Mount (or refresh) the page for one mode; runs the LRU pass. */
  ensure(id: ModeId): void;
  /** Unmount without a snapshot (detach hand-off, disable, reload). */
  retire(id: ModeId): void;
  /** Unmount after capturing a `view` snapshot (LRU eviction). */
  evict(id: ModeId, opts?: { allowActive?: boolean }): Promise<void>;
  /** Cancel an in-flight snapshot/unmount when the page is about to be shown. */
  cancelEviction(id: ModeId): void;
  /** Retire entries whose instance is gone or replaced (plugin reload). */
  prune(alive: (id: ModeId, inst: ModeInstance) => boolean): void;
  /** Live ids (oldest first) — diagnostics. */
  ids(): ModeId[];
}

export function createHostStack(deps: {
  mode: Accessor<ModeId>;
  instance: (id: ModeId) => ModeInstance | undefined;
  /** Pages that may be evicted (typically: everything but the home page). */
  evictable?: (id: ModeId) => boolean;
  maxLive?: number;
}): HostStack {
  const maxLive = deps.maxLive ?? 4;
  const entries = new Map<ModeId, HostEntry>();
  const [hosts, setHosts] = createSignal<HostEntry[]>([], { equals: false });

  function retireEntry(e: HostEntry) {
    if (!entries.has(e.id)) return;
    entries.delete(e.id);
    setHosts((prev) => prev.filter((h) => h !== e));
  }

  function retire(id: ModeId) {
    const e = entries.get(id);
    if (e) retireEntry(e);
  }

  async function evict(id: ModeId, opts?: { allowActive?: boolean }) {
    const e = entries.get(id);
    if (!e || e.evicting) return;
    const token = (e.evictToken ?? 0) + 1;
    e.evictToken = token;
    e.evicting = true;
    let snap: unknown = null;
    try {
      snap = (await e.inst.snapshot?.()) ?? null;
    } catch {
      // A dead page yields null — unmounting still frees the DOM.
    }
    if (e.evictToken !== token) return;
    e.evicting = false;
    if (!entries.has(id)) return;
    // Became (or stayed) the active page while the snapshot was in flight.
    if (deps.mode() === id && !opts?.allowActive) {
      // The abort spent its slot without freeing anything — pass the budget
      // to the next LRU victim so the cap still converges.
      if (entries.size > maxLive) runEvictionPass();
      return;
    }
    if (snap != null) putSessionFrame(id, "view", snap);
    retireEntry(e);
    tap({ op: "evict", id });
    // An ensure() during the snapshot round-trip can add fresh overflow;
    // top up so the cap always converges to <= maxLive.
    if (entries.size > maxLive) runEvictionPass();
  }

  /** `protect`: the page `ensure()` is about to activate — never a victim. */
  function runEvictionPass(protect?: ModeId) {
    if (entries.size <= maxLive) return;
    const candidates = [...entries.values()]
      .filter(
        (e) =>
          e.id !== deps.mode() &&
          e.id !== protect &&
          (deps.evictable?.(e.id) ?? true)
      )
      .sort((a, b) => a.lastUsed - b.lastUsed);
    // `evict` retires the entry only after its async snapshot round-trip, so
    // entries.size does NOT drop while this synchronous pass runs. Counting
    // the evictions already in flight keeps ONE overflow down to one victim;
    // the old `entries.size <= maxLive` break started an eviction for every
    // candidate — the first overflow nuked the whole stack minus the active
    // page (docs/ROADMAP_HISTORY.md #42).
    let toStart =
      entries.size - maxLive - candidates.filter((e) => e.evicting).length;
    for (const e of candidates) {
      if (toStart <= 0) break;
      if (e.evicting) continue;
      toStart--;
      void evict(e.id);
    }
  }

  function ensure(id: ModeId) {
    const inst = deps.instance(id);
    if (!inst) return;
    const cur = entries.get(id);
    if (cur && cur.inst === inst) {
      cur.lastUsed = Date.now();
      return;
    }
    if (cur) retireEntry(cur); // replaced instance (reload) — mount the new one
    const e: HostEntry = { id, inst, lastUsed: Date.now(), evictToken: 0 };
    entries.set(id, e);
    setHosts((prev) => [...prev, e]);
    runEvictionPass(id);
  }

  function prune(alive: (id: ModeId, inst: ModeInstance) => boolean) {
    for (const e of [...entries.values()]) {
      if (!alive(e.id, e.inst)) retireEntry(e);
    }
  }

  function cancelEviction(id: ModeId) {
    const entry = entries.get(id);
    if (!entry?.evicting) return;
    entry.evictToken = (entry.evictToken ?? 0) + 1;
    entry.evicting = false;
  }

  return {
    hosts,
    ensure,
    retire,
    evict,
    cancelEviction,
    prune,
    ids: () => [...entries.values()].sort((a, b) => a.lastUsed - b.lastUsed).map((e) => e.id),
  };
}
