/* @refresh reload */
import { render } from "solid-js/web";
import Welcome from "./onboarding/Welcome";
import { prepareWindow } from "./windowBootstrap";

void prepareWindow("welcome").then(() => {
  render(
    () => <Welcome />,
    document.getElementById("root") as HTMLElement,
  );
});
