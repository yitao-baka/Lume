/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { prepareWindow } from "./windowBootstrap";
import "./skins/launcher.css";

void prepareWindow("launcher").then(() => {
  render(
    () => <App />,
    document.getElementById("root") as HTMLElement
  );
});
