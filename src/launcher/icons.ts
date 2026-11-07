//! Launcher app-icon store — the frontend mirror of the backend `IconCache`.
//! One factory per launcher window; the cache lives for the window's lifetime
//! so re-viewing a result set never re-extracts or re-fetches icons.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppEntry } from "./types";

/** Icons are requested in batches to avoid one huge blocking IPC. */
const ICON_BATCH = 20;
/** Both ceilings apply independently: count bounds tiny icons, bytes bounds a
 * long tail of large PNG data URIs. */
const ICON_CACHE_MAX_ENTRIES = 512;
const ICON_CACHE_MAX_BYTES = 12 * 1024 * 1024;

interface StoredIcon {
  value: string;
  bytes: number;
  lastUsed: number;
}

export function createIconStore() {
  const cache = new Map<string, StoredIcon>();
  let bytes = 0;
  let accessSeq = 0;
  /** Bumped whenever a batch lands — renders reading `iconFor` re-run. */
  const [tick, setTick] = createSignal(0);

  function evictToBudget() {
    while (cache.size > ICON_CACHE_MAX_ENTRIES || bytes > ICON_CACHE_MAX_BYTES) {
      let oldestPath: string | undefined;
      let oldest = Number.POSITIVE_INFINITY;
      for (const [path, entry] of cache) {
        if (entry.lastUsed < oldest) {
          oldest = entry.lastUsed;
          oldestPath = path;
        }
      }
      if (!oldestPath) break;
      bytes -= cache.get(oldestPath)?.bytes ?? 0;
      cache.delete(oldestPath);
    }
  }

  function remember(path: string, icon: string) {
    const previous = cache.get(path);
    if (previous) bytes -= previous.bytes;
    // base64/ASCII data URI: one JS code unit is one byte on the wire.
    const entry = { value: icon, bytes: icon.length, lastUsed: ++accessSeq };
    cache.set(path, entry);
    bytes += entry.bytes;
    evictToBudget();
  }

  /** Cached icon for an app path; reactive via `tick`. */
  function iconFor(path: string): string | undefined {
    tick(); // subscribe the render to icon loading
    const entry = cache.get(path);
    if (!entry) return undefined;
    entry.lastUsed = ++accessSeq;
    return entry.value;
  }

  /** Fetch icons for the given apps in batches, swapping them in as they arrive. */
  async function loadIcons(apps: AppEntry[]) {
    const missing = [...new Set(apps.map((a) => a.path).filter((p) => !cache.has(p)))];
    for (let i = 0; i < missing.length; i += ICON_BATCH) {
      const batch = missing.slice(i, i + ICON_BATCH);
      try {
        const icons = (await invoke("get_app_icons", { paths: batch })) as {
          path: string;
          icon: string | null;
        }[];
        for (const { path, icon } of icons) {
          if (icon) remember(path, icon);
        }
        setTick((t) => t + 1);
      } catch (err) {
        console.error("loadIcons failed", err);
      }
    }
  }

  /** Long-hidden launcher: drop every icon not needed by a visible window.
   * The next show re-fetches only the rows it actually renders. */
  function trim(): void {
    if (cache.size === 0) return;
    cache.clear();
    bytes = 0;
    setTick((t) => t + 1);
  }

  return { iconFor, loadIcons, trim };
}
