//! Capability permissions (P3.2) — the ledger and the choke point.
//!
//! A disk plugin declares what it needs in `plugin.toml`
//! (`permissions = ["network", ...]`); a capability it did **not** declare is
//! refused with the missing word named. The table below is the single source
//! of truth (`docs/PLUGIN_API.md` §6D.6): one row per host capability that
//! reaches outside the launcher's own UI. 设置 → 插件 shows each plugin's
//! declared words and offers 「全部授权」 (`settings.plugins.trusted`).
//!
//! *Where* the check runs matters. A disk plugin reaches the host twice — its
//! **logic** (`search`/`onEnter`/…) runs in the launcher window holding the
//! host API directly, and its **page** (a mode iframe) reaches the same
//! surface over the postMessage bridge. Both get their API from
//! `createHostApi`, so the guard is applied there (`guardHostApi`) and neither
//! path can slip past by calling the API directly instead of over the bridge.
//!
//! Scope, stated honestly: this is a **frontend** choke point. The mode iframe
//! is same-origin, so a deliberately hostile page could still reach Tauri IPC
//! directly; real isolation needs the sandbox planned with the ecosystem
//! phase. What the ledger buys today is informed consent — the capabilities a
//! plugin uses are written in its manifest and visible in the settings pane,
//! and a plugin that forgot to declare one fails loudly instead of silently
//! working.

import { t } from "../i18n";
import { plog } from "./log";
import type { PluginHostApi, PluginManifest } from "./types";

/** Method ("group.name") → the permission word the manifest must declare.
 * Methods absent here are free: launcher-UI actions (`app.*`), the plugin's
 * own data (`storage.*`, `db.*`, `settings.*`) and its own private directory
 * (`fs.writeText` / `readPrivate` / `listPrivate` / `privatePath` /
 * `removePrivate`). */
export const RPC_PERMISSION: Record<string, string> = {
  "app.notify": "notify",
  "app.trash": "trash",
  "clipboard.readText": "clipboard",
  "clipboard.writeText": "clipboard",
  "clipboard.writeImage": "clipboard",
  "clipboard.writeFiles": "clipboard",
  "clipboard.readFiles": "clipboard",
  "clipboard.paste": "clipboard",
  "http.request": "network",
  "dialog.open": "dialog",
  "dialog.save": "dialog",
  "screen.cursor": "screen",
  "screen.displays": "screen",
  "search.files": "search.files",
  "fs.readText": "fs.read",
  "fs.thumb": "fs.read",
  "fs.videoPoster": "fs.read",
  "fs.icon": "fs.read",
  "fs.writeFile": "fs.write",
};

/** How the ledger finds a plugin's manifest — wired by the registry (it owns
 * the manifest list). Unwired means every id looks undeclared, which is the
 * right default for a permission layer (fail-closed). */
let lookupManifest: (id: string) => PluginManifest | undefined = () => undefined;

/** Wire the manifest lookup (the registry calls this once at module init). */
export function setPermissionSource(fn: (id: string) => PluginManifest | undefined) {
  lookupManifest = fn;
}

/** Fail-closed capability check: throws when a disk plugin hasn't declared
 * what the method needs. Built-ins are compiled into lume.exe and exempt;
 * `trusted` (「全部授权」) passes everything. */
export function assertPermission(id: string, method: string): void {
  const need = RPC_PERMISSION[method];
  if (!need) return;
  const m = lookupManifest(id);
  if (m && (m.builtin || m.trusted)) return;
  if (m && (m.permissions ?? []).includes(need)) return;
  plog.error(
    id,
    `permission denied: ${method} needs "${need}"` +
      (m ? ` — declared: [${(m.permissions ?? []).join(", ")}]` : " — unknown plugin")
  );
  throw new Error(t("pluginPermissionDenied", { id, perm: need }));
}

/** Wrap the ledger-listed methods of a host API so the check holds however
 * the API was reached. Only guarded methods are touched (the free ones keep
 * their exact behaviour, including their synchronous returns), and a refusal
 * travels as a rejected promise — every guarded method is async, and a
 * rejection is what a caller's `catch`/bridge reply path expects. */
export function guardHostApi(id: string, api: PluginHostApi): PluginHostApi {
  for (const [group, methods] of Object.entries(api as unknown as Record<string, unknown>)) {
    if (!methods || typeof methods !== "object") continue;
    const bag = methods as Record<string, unknown>;
    for (const [name, fn] of Object.entries(bag)) {
      const key = `${group}.${name}`;
      if (!RPC_PERMISSION[key] || typeof fn !== "function") continue;
      const call = fn as (...a: unknown[]) => unknown;
      bag[name] = (...args: unknown[]) => {
        try {
          assertPermission(id, key);
        } catch (err) {
          return Promise.reject(err);
        }
        return call(...args);
      };
    }
  }
  return api;
}
