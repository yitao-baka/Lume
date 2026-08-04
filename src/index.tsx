/* @refresh reload */
import { render } from "solid-js/web";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyColorMode } from "./theme";
import App from "./App";
import SettingsApp from "./settings/Settings";

// Apply the OS-preferred theme before first paint (the stored color_mode is
// applied right after get_settings resolves).
applyColorMode("system");

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
}

render(
  () => (isSettings ? <SettingsApp /> : <App />),
  document.getElementById("root") as HTMLElement
);
