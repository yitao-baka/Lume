//! Navigate's launch-command adapter. UI harnesses can observe the exact
//! request in debug builds without opening a real UAC prompt; release builds
//! always call the Tauri command.

import { invoke } from "@tauri-apps/api/core";
import { diagnosticsEnabled } from "../../page-runtime/diagnostics";

export interface LaunchAppRequest {
  path: string;
  name: string;
  elevated: boolean;
}

export interface LaunchAppOutcome {
  outcome: string;
}

type LaunchAppTestHook = (request: LaunchAppRequest) => Promise<LaunchAppOutcome>;

type ProbeWindow = Window & {
  __LUME_TEST_LAUNCH_APP__?: LaunchAppTestHook;
};

/** Launch through the recent-open chokepoint. `elevated` must be forwarded
 * unchanged: Rust maps it to the `runas` shell verb. */
export function invokeLaunchApp(
  path: string,
  name: string,
  elevated: boolean,
): Promise<LaunchAppOutcome> {
  const request: LaunchAppRequest = { path, name, elevated };
  if (diagnosticsEnabled()) {
    const probe = (window as ProbeWindow).__LUME_TEST_LAUNCH_APP__;
    if (typeof probe === "function") return probe(request);
  }
  return invoke<LaunchAppOutcome>("launch_app", { path, name, elevated });
}
