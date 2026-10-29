import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export default {
  id: "preview",
  description: "Core preview window, permission gate and plugin preview path",
  tags: ["ui", "plugins", "preview"],
  fixtures: [
    { source: "examples/plugins/host-tools", target: "plugins/host-tools" },
  ],
  async prepareRuntime(runtimeDir) {
    const denied = join(runtimeDir, "plugins", "preview-denied");
    mkdirSync(denied, { recursive: true });
    writeFileSync(
      join(denied, "plugin.toml"),
      'id = "preview-denied"\nkind = "service"\napi = 2\nentry = "main.js"\n',
    );
    writeFileSync(join(denied, "main.js"), "export default {};\n");
  },
  async run(t) {
    await t.ensureLauncherVisible();

    const showPreview = async (args) => t.evaluate(`window.__TAURI_INTERNALS__.invoke("hide_launcher")
      .then(() => window.__TAURI_INTERNALS__.invoke("toggle_launcher"))
      .then(() => window.__TAURI_INTERNALS__.invoke("show_preview", ${JSON.stringify(args)}))
      .then(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "preview" }))
      .catch((error) => "ERR:" + String(error))`);

    let coreVisible = await showPreview({ req: { kind: "text", content: "core preview probe" } });
    if (coreVisible !== true) {
      await t.sleep(250);
      coreVisible = await showPreview({ req: { kind: "text", content: "core preview probe" } });
    }
    t.check("core preview command shows the satellite window", coreVisible === true, coreVisible);
    await t.invoke("close_preview");
    t.check(
      "core preview closes cleanly",
      (await t.invoke("plugin:window|is_visible", { label: "preview" })) === false,
    );

    const denied = await t.evaluate(`window.__TAURI_INTERNALS__.invoke("show_preview", {
      pluginId: "preview-denied",
      req: { kind: "text", content: "denied" },
    }).then(() => "").catch((error) => String(error))`);
    t.check(
      "undeclared plugin preview is refused with a permission error",
      denied.includes("permission denied") && denied.includes("preview"),
      denied,
    );

    const pluginVisible = await showPreview({
      pluginId: "host-tools",
      req: { kind: "text", content: "plugin preview probe" },
    });
    t.check("declared plugin reuses the core preview window", pluginVisible === true, pluginVisible);

    const preview = await t.session.preview();
    await t.screenshot("preview-window", preview.connection);
    await t.screenshot("launcher-after-preview");
    await t.invoke("close_preview");
    t.check(
      "plugin preview closes cleanly",
      (await t.invoke("plugin:window|is_visible", { label: "preview" })) === false,
    );
  },
};
