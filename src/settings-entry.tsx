/* @refresh reload */
import { render } from "solid-js/web";
import SettingsApp from "./settings/Settings";
import { prepareWindow } from "./windowBootstrap";
import "./skins/settings.css";

void prepareWindow("settings").then(() => {
  render(
    () => <SettingsApp />,
    document.getElementById("root") as HTMLElement,
  );
});
