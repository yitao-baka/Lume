import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const JPEG_PROBE = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEooor7s+PP//Z",
  "base64",
);
let externalPreviewPath = "";

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

    const allowed = join(runtimeDir, "plugins", "asset-probe");
    mkdirSync(allowed, { recursive: true });
    writeFileSync(
      join(allowed, "plugin.toml"),
      'id = "asset-probe"\nkind = "service"\napi = 2\nentry = "main.js"\npermissions = ["fs.read"]\n',
    );
    writeFileSync(join(allowed, "main.js"), "export default {};\n");

    // Keep the probe outside the runtime tree: $EXE/** is already in the
    // static asset scope, so only a per-file grant can make this image load.
    externalPreviewPath = join(runtimeDir, "..", "asset-preview-probe.jpg");
    writeFileSync(externalPreviewPath, JPEG_PROBE);
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

    const probeUrl = await t.evaluate(
      `window.__TAURI_INTERNALS__.convertFileSrc(${JSON.stringify(externalPreviewPath)})`,
    );
    const imageStatus = (url) => t.evaluate(`new Promise((resolve) => {
      const image = new Image();
      const finish = (ok) => {
        clearTimeout(timer);
        resolve({ ok, width: image.naturalWidth });
      };
      const timer = setTimeout(() => finish(false), 3000);
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = ${JSON.stringify(url)};
    })`);
    const beforeGrant = await imageStatus(probeUrl);
    t.check("asset scope refuses files outside Lume's own trees", beforeGrant.ok === false, beforeGrant);

    const assetDenied = await t.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin_allow_asset_path", {
      pluginId: "preview-denied",
      path: ${JSON.stringify(externalPreviewPath)},
    }).then(() => "").catch((error) => String(error))`);
    t.check(
      "plugin asset grant requires the declared fs.read capability",
      assetDenied.includes("permission denied") && assetDenied.includes("fs.read"),
      assetDenied,
    );

    const assetGranted = await t.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin_allow_asset_path", {
      pluginId: "asset-probe",
      path: ${JSON.stringify(externalPreviewPath)},
    }).then(() => true).catch((error) => String(error))`);
    t.check("declared plugin grants one exact external file", assetGranted === true, assetGranted);
    const afterGrant = await imageStatus(probeUrl);
    t.check(
      "granted file loads through the asset protocol",
      afterGrant.ok === true && afterGrant.width > 0,
      afterGrant,
    );

    const thumb = await t.evaluate(`window.__TAURI_INTERNALS__.invoke("get_file_thumb", {
      pluginId: "asset-probe",
      path: ${JSON.stringify(externalPreviewPath)},
    }).then((value) => ({ ok: String(value).startsWith("data:image/png;base64,"), length: String(value).length }))
      .catch((error) => ({ ok: false, error: String(error) }))`);
    t.check("fs.thumb returns a Shell thumbnail for JPEG input", thumb.ok === true, thumb);

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
