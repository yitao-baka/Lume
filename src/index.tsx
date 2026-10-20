/* @refresh reload */
import { render } from "solid-js/web";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyColorMode } from "./theme";
import App from "./App";
import SettingsApp from "./settings/Settings";
import { applySettingsSkin } from "./settings/skin";

// One build serves both windows: the launcher (`main`) and the settings
// window (`settings`). Branch on the window label.
let isSettings = false;
try {
  isSettings = getCurrentWindow().label === "settings";
} catch {
  // Outside Tauri (plain browser) — render the launcher.
}
if (isSettings) {
  document.body.classList.add("settings-window");
  // First-frame skin/theme: the Rust initialization script has already put
  // the effective settings on the window, so no async IPC/flash is involved.
  const cfg = (window as any).__LUME_CONFIG__ as
    | { appearance?: { settings_skin?: string; color_mode?: string } }
    | undefined;
  applySettingsSkin(cfg?.appearance?.settings_skin);
  applyColorMode(cfg?.appearance?.color_mode ?? "system");
} else {
  // Launcher: apply the OS-preferred theme before first paint (the stored
  // color_mode is applied right after get_settings resolves).
  applyColorMode("system");
}

render(
  () => (isSettings ? <SettingsApp /> : <App />),
  document.getElementById("root") as HTMLElement
);
