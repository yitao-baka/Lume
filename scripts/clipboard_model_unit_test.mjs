// Clipboard Page Model budget regression. Runs through Vite SSR so the same
// TypeScript implementation used by the app is exercised without a browser.
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  appType: "custom",
  clearScreen: false,
  server: { middlewareMode: true },
  logLevel: "error",
  optimizeDeps: { noDiscovery: true, include: [] },
});

const checks = [];
const check = (name, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  checks.push(ok);
};

try {
  const budget = await server.ssrLoadModule("/src/page-services/clipboard/modelBudget.ts");
  const runtime = await server.ssrLoadModule("/src/page-runtime/modelStore.ts");
  const scroll = await server.ssrLoadModule("/src/presenters/clipboard-scroll.ts");
  const makeModel = (rows, revision = 1) => ({
    runtime: "lume.page/v1",
    schema: "lume.clipboard/v1",
    revision,
    status: "ready",
    data: {
      query: "",
      categories: [{ id: "all", label: "All", count: 10 }],
      activeCategory: "all",
      items: rows,
      total: 10,
      window: { offset: 0, limit: rows.length },
      selectedIndex: 0,
      selectedIds: rows[0] ? [rows[0].id] : [],
      paused: false,
      status: { total: 10, selected: 0, text: "10 items" },
      showSourceApp: true,
      timeDisplay: "relative",
      hoverSelect: false,
      previewEnabled: true,
    },
  });
  const thumb = "data:image/png;base64," + "A".repeat(213_000);
  const rows = Array.from({ length: 10 }, (_, i) => ({
    full: {
      id: `clip:${i + 1}`,
      numericId: i + 1,
      kind: "image",
      title: "Image",
      content: "Image",
      createdAt: i,
      thumb: { kind: "thumbnail", src: thumb },
      pinned: false,
      hasHtml: false,
      mergedCount: 1,
      valid: true,
      actions: ["copy", "paste", "preview"],
    },
    compact: {
      id: `clip:${i + 1}`,
      numericId: i + 1,
      kind: "image",
      title: "Image",
      content: "Image",
      createdAt: i,
      pinned: false,
      hasHtml: false,
      mergedCount: 1,
      valid: true,
      actions: ["copy", "paste", "preview"],
    },
  }));
  const rawBytes = new TextEncoder().encode(JSON.stringify(makeModel(rows.map((r) => r.full)))).byteLength;
  check("ten image thumbs exceed the 1 MiB model limit", rawBytes > runtime.DEFAULT_MODEL_MAX_BYTES, String(rawBytes));
  const fitted = budget.fitClipboardModelWindow(rows, (items) => makeModel(items));
  const fittedModel = makeModel(fitted.items);
  const fittedBytes = runtime.validatePageModel(fittedModel);
  const thumbCount = fitted.items.filter((row) => row.thumb).length;
  check("budget keeps a non-empty contiguous window", fitted.items.length > 0, String(fitted.items.length));
  check("budget drops oversized visual resources before dropping rows", thumbCount > 0 && thumbCount < rows.length, `${thumbCount}/${rows.length}`);
  check("budgeted model validates below the hard cap", fittedBytes <= runtime.DEFAULT_MODEL_MAX_BYTES, String(fittedBytes));

  const giant = "x".repeat(2 * 1024 * 1024);
  const preview = budget.clipContentPreview(giant);
  check("large text is reduced to the display preview cap", preview.length === budget.CLIPBOARD_CONTENT_PREVIEW_CHARS, String(preview.length));
  const oneRow = [{
    full: { id: "clip:1", numericId: 1, kind: "text", title: "x", content: preview, pinned: false, hasHtml: false, mergedCount: 1, valid: true, actions: ["copy"] },
    compact: { id: "clip:1", numericId: 1, kind: "text", title: "x", content: preview, pinned: false, hasHtml: false, mergedCount: 1, valid: true, actions: ["copy"] },
  }];
  const one = budget.fitClipboardModelWindow(oneRow, (items) => makeModel(items));
  runtime.validatePageModel(makeModel(one.items));
  check("a single multi-megabyte text row still leaves a usable model", one.items.length === 1, String(one.items.length));

  const filePreview = budget.fitClipboardFileListPreview(
    Array.from({ length: 12 }, () => "C:\\" + "x".repeat(500)),
    [0, 1, 7],
    8,
    1024,
  );
  const filePreviewBytes = new TextEncoder().encode(JSON.stringify(filePreview)).byteLength;
  check(
    "multi-file preview is capped by entries and serialized bytes",
    filePreview.paths.length > 0 && filePreview.paths.length <= 8 && filePreviewBytes <= 1024 &&
      (filePreview.checked ?? []).every((index) => index < filePreview.paths.length),
    JSON.stringify({ paths: filePreview.paths.length, bytes: filePreviewBytes, checked: filePreview.checked }),
  );

  const atTop = scroll.clipboardScrollFades(0, 200, 2000);
  const onePixel = scroll.clipboardScrollFades(1, 200, 2000);
  const nearBottom = scroll.clipboardScrollFades(1799, 200, 2000);
  const atBottom = scroll.clipboardScrollFades(1800, 200, 2000);
  const fractionalBottom = scroll.clipboardScrollFades(1799.2, 200, 2000);
  check("top fade appears on the first real scrolled pixel", !atTop.top && onePixel.top, JSON.stringify({ atTop, onePixel }));
  check("bottom fade remains at one pixel above the end", nearBottom.bottom && !atBottom.bottom, JSON.stringify({ nearBottom, atBottom }));
  check("fractional scroll clamp at the true end hides the bottom fade", !fractionalBottom.bottom, JSON.stringify({ fractionalBottom }));
} finally {
  await server.close();
}

const passed = checks.filter(Boolean).length;
console.log(`CLIPBOARD MODEL UNIT ${passed}/${checks.length}`);
process.exit(passed === checks.length ? 0 : 1);
