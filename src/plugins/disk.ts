//! Disk plugin file access (asset protocol) — shared by the registry's
//! module loader and the detached plugin window's view loader.

import { convertFileSrc } from "@tauri-apps/api/core";

/** Resolve a manifest-relative path under its plugin directory. This mirrors
 * the Rust manifest gate as defense in depth: absolute/UNC/drive paths,
 * parent traversal, alternate data streams and URL-like values are refused. */
export function pluginFilePath(dir: string, relative: string): string {
  if (
    !relative ||
    relative.length > 1024 ||
    relative.includes("\0") ||
    relative.includes(":") ||
    /^[\\/]/.test(relative) ||
    relative.replace(/\\/g, "/").split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("plugin path must stay inside the plugin directory");
  }
  return dir.replace(/[\\/]+$/, "") + "\\" + relative.replace(/\//g, "\\");
}

/** Fetch a file from a plugin directory (absolute path) via the asset
 * protocol. Throws with the HTTP status when the read fails. */
export async function fetchDiskFile(path: string): Promise<string> {
  const res = await fetch(convertFileSrc(path));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
