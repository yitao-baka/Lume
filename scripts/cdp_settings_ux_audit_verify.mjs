// The original settings UX audit targeted the pre-redesign grouped-card DOM.
// The redesign keeps its accessibility regressions (tab/tabpanel semantics,
// radio/switch state, focus preservation, 560×420 reflow, command search) in
// cdp_settings_skin_verify.mjs, so this filename now forwards there.
import { spawnSync } from "node:child_process";

console.log("[settings-ux-audit] forwarding to cdp_settings_skin_verify.mjs");
const result = spawnSync(process.execPath, ["scripts/cdp_settings_skin_verify.mjs"], {
  stdio: "inherit",
  cwd: process.cwd(),
});
process.exit(result.status ?? 1);