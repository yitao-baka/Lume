//! Launcher app-icon store — the frontend mirror of the backend `IconCache`.
//! One factory per launcher window; the cache lives for the window's lifetime
//! so re-viewing a result set never re-extracts or re-fetches icons.

import { createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import type { AppEntry } from "./types";

/** Icons are requested in batches to avoid one huge blocking IPC. */
const ICON_BATCH = 20;

export function createIconStore() {
  const cache = new Map<string, string>();
  /** Bumped whenever a batch lands — renders reading `iconFor` re-run. */
  const [tick, setTick] = createSignal(0);

  /** Cached icon for an app path; reactive via `tick`. */
  function iconFor(path: string): string | undefined {
    tick(); // subscribe the render to icon loading
    return cache.get(path);
  }

  /** Fetch icons for the given apps in batches, swapping letter tiles as they arrive. */
  async function loadIcons(apps: AppEntry[]) {
    const missing = apps.map((a) => a.path).filter((p) => !cache.has(p));
    for (let i = 0; i < missing.length; i += ICON_BATCH) {
      const batch = missing.slice(i, i + ICON_BATCH);
      try {
        const icons = (await invoke("get_app_icons", { paths: batch })) as {
          path: string;
          icon: string | null;
        }[];
        for (const { path, icon } of icons) {
          if (icon) cache.set(path, icon);
        }
        setTick((t) => t + 1);
      } catch (err) {
        console.error("loadIcons failed", err);
      }
    }
  }

  return { iconFor, loadIcons };
}
