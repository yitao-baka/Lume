import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const JPEG_PROBE = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAQABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDEooor7s+PP//Z",
  "base64",
);
const PDF_PROBE = Buffer.from(
  "JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCAzMDAgMjAwXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA1IDAgUiA+PiA+PiAvQ29udGVudHMgNCAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA1MyA+PgpzdHJlYW0KQlQgL0YxIDEyIFRmIDIwIDEwMCBUZCAoTHVtZSBQREYgcHJldmlldyBwcm9iZSkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8IC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYSA+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDE1IDAwMDAwIG4gCjAwMDAwMDAwNjQgMDAwMDAgbiAKMDAwMDAwMDEyMSAwMDAwMCBuIAowMDAwMDAwMjQ3IDAwMDAwIG4gCjAwMDAwMDAzNTAgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MjAKJSVFT0YK",
  "base64",
);
let externalPreviewPath = "";
let externalPdfPath = "";

export default {
  id: "preview",
  description: "Blank startup, core PDF/preview lifecycle and plugin permission gate",
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
    externalPdfPath = join(runtimeDir, "..", "asset-preview-probe.pdf");
    writeFileSync(externalPdfPath, PDF_PROBE);
  },
  async run(t) {
    const startupPages = await t.session.targets();
    t.check(
      "preview renderer starts on the zero-script blank page without loading preview.html",
      startupPages.some(
        (target) => target.type === "page" && target.url.includes("/blank.html"),
      ) &&
        !startupPages.some(
          (target) => target.type === "page" && target.url.includes("/preview.html"),
        ),
      startupPages.map((target) => ({ type: target.type, url: target.url })),
    );
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

    const bytesDenied = await t.evaluate(`window.__TAURI_INTERNALS__.invoke("get_file_bytes", {
      pluginId: "preview-denied",
      path: ${JSON.stringify(externalPreviewPath)},
    }).then(() => "").catch((error) => String(error))`);
    t.check(
      "Presenter file bytes require the declared fs.read capability",
      bytesDenied.includes("permission denied") && bytesDenied.includes("fs.read"),
      bytesDenied,
    );
    const bytesAllowed = await t.evaluate(`window.__TAURI_INTERNALS__.invoke("get_file_bytes", {
      pluginId: "asset-probe",
      path: ${JSON.stringify(externalPreviewPath)},
    }).then((value) => ({ ok: typeof value === "string" && value.length > 0, length: String(value).length }))
      .catch((error) => ({ ok: false, error: String(error) }))`);
    t.check("declared fs.read returns raw file bytes", bytesAllowed.ok === true, bytesAllowed);

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

    const pdfVisible = await showPreview({
      pluginId: "host-tools",
      req: { kind: "pdf", path: externalPdfPath },
    });
    t.check("core PDF preview accepts a granted external file", pdfVisible === true, pdfVisible);
    const pdfPreview = await t.session.preview();
    let pdfCanvas;
    try {
      pdfCanvas = await pdfPreview.connection.waitFor(
        `(() => { const c = document.querySelector(".preview-pdf-canvas"); return c && c.width > 0 && c.height > 0 ? { width: c.width, height: c.height } : null; })()`,
        12000,
      );
    } catch (error) {
      const diagnostic = await pdfPreview.connection.evaluate(`(() => ({
        url: location.href,
        visibility: document.visibilityState,
        canvas: (() => { const c = document.querySelector(".preview-pdf-canvas"); return c ? { width: c.width, height: c.height } : null; })(),
        error: document.querySelector(".preview-error")?.textContent ?? "",
        lastError: window.__pdfLastError ?? "",
        placeholder: document.querySelector(".preview-placeholder")?.textContent ?? "",
        text: document.body.innerText.slice(0, 500),
      }))()`);
      t.log("PDF diagnostic", JSON.stringify(diagnostic));
      throw error;
    }
    t.check("core PDF preview renders the first page", pdfCanvas.width > 0 && pdfCanvas.height > 0, pdfCanvas);
    await t.screenshot("preview-pdf", pdfPreview.connection);
    await t.invoke("close_preview");

    let previewCyclesOk = true;
    for (let cycle = 0; cycle < 10; cycle++) {
      await t.invoke("show_preview", {
        req: { kind: "text", content: `preview cycle ${cycle}` },
      });
      const shown = await t.waitFor(
        'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "preview" })',
        5000,
      );
      await t.invoke("close_preview");
      const hidden = await t.waitFor(
        'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "preview" }).then((value) => !value)',
        5000,
      );
      if (!shown || !hidden) {
        previewCyclesOk = false;
        break;
      }
    }
    t.check("10 preview open/close cycles preserve native visibility", previewCyclesOk);
  },
};
