export default {
  id: "plugin-runtime",
  description: "API 2 plugin entry, Presenter readiness and opaque sandbox",
  tags: ["ui", "plugins"],
  env: {
    LUME_HOST_RECLAIM_SECS: "1",
    LUME_ACTIVE_HOST_RECLAIM_SECS: "2",
    LUME_LOGIC_IDLE_UNLOAD_SECS: "1",
    LUME_LOGIC_IDLE_SWEEP_SECS: "1",
  },
  fixtures: [
    { source: "examples/plugins/hello-mode", target: "plugins/hello-mode" },
    { source: "examples/plugins/web-search", target: "plugins/web-search" },
  ],
  async run(t) {
    await t.ensureLauncherVisible();
    const registered = await t.waitFor(
      `window.__pluginRegistryProbe?.plugins().some((plugin) => plugin.id === "hello-mode" && plugin.enabled) === true`,
      12000,
    );
    t.check("hello-mode is registered and enabled", registered);
    const coldLogic = await t.evaluate('window.__pluginRegistryProbe?.logic().loaded ?? []');
    t.check(
      "entry logic stays cold until the plugin is first used",
      !coldLogic.includes("hello-mode"),
      coldLogic,
    );
    await t.setQuery("hello");

    const rowReady = await t.waitFor(
      `[...document.querySelectorAll("[data-target-id]")].some((item) => item.textContent.includes("Hello Mode"))`,
      10000,
    );
    t.check("hello-mode appears as a searchable keyword row", rowReady);
    const providerWarm = await t.waitFor(
      'window.__pluginRegistryProbe?.logic().loaded.includes("web-search") === true',
      12000,
    );
    t.check("provider first search lazily warms its own logic frame", providerWarm);
    await t.clickText("[data-target-id]", "Hello Mode");

    const presenterReady = await t.waitFor(
      `window.__presenterStates.some((state) => state.pageId === "hello-mode" && state.status === "ready")`,
      12000,
    );
    t.check("plugin service and Presenter reach ready", presenterReady);
    const warmLogic = await t.evaluate('window.__pluginRegistryProbe?.logic().loaded ?? []');
    t.check("first page mount warms the plugin logic iframe", warmLogic.includes("hello-mode"), warmLogic);

    await t.invoke("hide_launcher");
    const logicUnloaded = await t.waitFor(
      'window.__pluginRegistryProbe?.logic().loaded.length === 0',
      12000,
    );
    t.check("hidden idle pages unload their logic iframes", logicUnloaded);
    await t.sleep(2500);
    const activeHostUnmounted = await t.waitFor(
      '!document.querySelector(\'.mode-host[data-mode="hello-mode"]\')',
      8000,
    );
    t.check("deep-idle active host is cold-reclaimed", activeHostUnmounted);
    await t.ensureLauncherVisible();
    const activeHostRestored = await t.waitFor(
      '!!document.querySelector(\'.mode-host[data-mode="hello-mode"]\')',
      12000,
    );
    t.check("summon restores the active page host from its session frame", activeHostRestored);
    const logicReloaded = await t.waitFor(
      'window.__pluginRegistryProbe?.logic().loaded.includes("hello-mode") === true',
      12000,
    );
    t.check("summon lazily reloads the active page logic iframe", logicReloaded);

    const beforeRestartIntent = await t.evaluate(
      'window.__pageRuntimeLatestModel("hello-mode")'
    );
    const expectedCount = Number(beforeRestartIntent?.data?.count || 0) + 1;
    const firstIntent = await t.evaluate(
      'window.__pageRuntimeDispatch("hello-mode", { type: "item.action", actionId: "count" })'
    );
    const firstPublish = await t.waitFor(
      `window.__pageRuntimeLatestModel("hello-mode")?.data?.count === ${expectedCount} &&
       window.__pageRuntimeLatestModel("hello-mode")?.revision > ${beforeRestartIntent?.revision ?? 0}`,
      8000
    );
    t.check(
      "first intent after logic restart publishes a newer Page Model",
      firstIntent?.status === "completed" && firstPublish,
      {
        firstIntent,
        before: beforeRestartIntent && {
          revision: beforeRestartIntent.revision,
          count: beforeRestartIntent.data?.count,
        },
        after: await t.evaluate('window.__pageRuntimeLatestModel("hello-mode")'),
      }
    );

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
        frame.srcdoc.includes("form-action 'none'") &&
        frame.srcdoc.includes("worker-src blob:"),
    );
    t.check(
      "Presenter sandbox is opaque and has no popup/form escape hatch",
      !!frame?.sandbox.includes("allow-scripts") &&
        !frame.sandbox.includes("allow-same-origin") &&
        !frame.sandbox.includes("allow-popups") &&
        !frame.sandbox.includes("allow-forms"),
    );
    t.check(
      "Presenter bridge exposes the page surface plus fs.read-gated bytes only",
      !!frame?.srcdoc.includes("lume.page") &&
        frame.srcdoc.includes("fs.bytes") &&
        frame.srcdoc.includes("fs.readText") &&
        !frame.srcdoc.includes("__TAURI_INTERNALS__"),
    );
    await t.screenshot("hello-mode");
  },
};
