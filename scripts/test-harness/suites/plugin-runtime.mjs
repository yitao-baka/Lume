export default {
  id: "plugin-runtime",
  description: "API 2 plugin entry, Presenter readiness and opaque sandbox",
  tags: ["ui", "plugins"],
  fixtures: [
    { source: "examples/plugins/hello-mode", target: "plugins/hello-mode" },
  ],
  async run(t) {
    await t.ensureLauncherVisible();
    const registered = await t.waitFor(
      `window.__pluginRegistryProbe?.plugins().some((plugin) => plugin.id === "hello-mode" && plugin.enabled) === true`,
      12000,
    );
    t.check("hello-mode is registered and enabled", registered);
    await t.setQuery("hello");

    const rowReady = await t.waitFor(
      `[...document.querySelectorAll("[data-target-id]")].some((item) => item.textContent.includes("Hello Mode"))`,
      10000,
    );
    t.check("hello-mode appears as a searchable keyword row", rowReady);
    await t.clickText("[data-target-id]", "Hello Mode");

    const presenterReady = await t.waitFor(
      `window.__presenterStates.some((state) => state.pageId === "hello-mode" && state.status === "ready")`,
      12000,
    );
    t.check("plugin service and Presenter reach ready", presenterReady);

    const frame = await t.evaluate(`(() => {
      const frame = document.querySelector("iframe.presenter-frame");
      return frame ? {
        sandbox: frame.getAttribute("sandbox") || "",
        srcdoc: frame.getAttribute("srcdoc") || "",
      } : null;
    })()`);
    t.check(
      "Presenter srcdoc carries the strict CSP",
      !!frame?.srcdoc.includes("Content-Security-Policy") &&
        frame.srcdoc.includes("connect-src 'none'") &&
        frame.srcdoc.includes("form-action 'none'"),
    );
    t.check(
      "Presenter sandbox is opaque and has no popup/form escape hatch",
      !!frame?.sandbox.includes("allow-scripts") &&
        !frame.sandbox.includes("allow-same-origin") &&
        !frame.sandbox.includes("allow-popups") &&
        !frame.sandbox.includes("allow-forms"),
    );
    t.check(
      "Presenter bridge exposes only the page surface",
      !!frame?.srcdoc.includes("lume.page") && !frame.srcdoc.includes("__TAURI_INTERNALS__"),
    );
    await t.screenshot("hello-mode");
  },
};
