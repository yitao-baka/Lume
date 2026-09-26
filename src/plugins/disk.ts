//! Disk plugin file access (asset protocol) — shared by the registry's
//! module loader and the detached plugin window's view loader.

import { convertFileSrc } from "@tauri-apps/api/core";

/** Fetch a file from a plugin directory (absolute path) via the asset
 * protocol. Throws with the HTTP status when the read fails. */
export async function fetchDiskFile(path: string): Promise<string> {
  const res = await fetch(convertFileSrc(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
