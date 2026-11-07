/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { prepareWindow } from "./windowBootstrap";

void prepareWindow("launcher").then(() => {
  render(
    () => <App />,
    document.getElementById("root") as HTMLElement
  );
});
