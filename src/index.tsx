/* @refresh reload */
import { render } from "solid-js/web";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyColorMode } from "./theme";
import App from "./App";
import SettingsApp from "./settings/Settings";
import { applySkin } from "./skins/runtime";
import { applyAccent } from "./skins/accent";
import "./skins/index.css";

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

// One first-frame path for both windows: the Rust initialization script has
// already injected the effective settings, so color mode, skin and accent are
// all in place before Solid's first render. Setting color mode first lets the
// skin surface pick the correct resolved light/dark entry.
const cfg = (window as any).__LUME_CONFIG__ as
  | {
      appearance?: {
        skin?: string;
        settings_skin?: string;
        color_mode?: string;
        accent?: string;
      };
    }
  | undefined;
applyColorMode(cfg?.appearance?.color_mode ?? "system");
// Each webview owns one skin. The detached plugin windows are part of the
// launcher shell and therefore follow `skin`, not `settings_skin`.
applySkin(
  isSettings
    ? cfg?.appearance?.settings_skin ?? cfg?.appearance?.skin ?? "chromatic"
    : cfg?.appearance?.skin ?? cfg?.appearance?.settings_skin,
);
applyAccent(cfg?.appearance?.accent);

render(
  () => (isSettings ? <SettingsApp /> : <App />),
  document.getElementById("root") as HTMLElement
);
