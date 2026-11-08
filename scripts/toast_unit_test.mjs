// Toast readability contract: adaptive dwell-time math and the wrapping bounds
// shared by the launcher, settings and detached-plugin surfaces.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "vite";
import { ROOT } from "./test-harness/cdp.mjs";

const checks = [];
const check = (name, ok, extra = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};

function ruleBlock(css, selector) {
  const start = css.indexOf(`${selector} {`);
  if (start < 0) return "";
  const end = css.indexOf("}", start);
  return end < 0 ? "" : css.slice(start, end + 1);
}

const server = await createServer({
  configFile: false,
  appType: "custom",
  clearScreen: false,
  logLevel: "error",
  server: { middlewareMode: true },
  optimizeDeps: { noDiscovery: true, include: [] },
});

try {
  const {
    TOAST_MAX_AUTO_MS,
    TOAST_MIN_MS,
    TOAST_UNDO_MIN_MS,
    toastDurationMs,
  } = await server.ssrLoadModule("/src/launcher/toast.ts");

  check("short toast keeps the readable 4s floor", toastDurationMs("Copied") === TOAST_MIN_MS);
  check(
    "CJK text extends dwell by reading weight",
    toastDurationMs("「示例插件」连续调用失败，已暂停；其他插件不受影响，重载后重试") >
      toastDurationMs("已复制"),
  );
  check(
    "long English text extends dwell by reading weight",
    toastDurationMs("Plugin paused after repeated failures; other plugins are unaffected — reload to retry") >
      toastDurationMs("Copied"),
  );
  check(
    "undo toast gets a 6s minimum action window",
    toastDurationMs("Deleted 1 item", { undo: true }) === TOAST_UNDO_MIN_MS,
  );
  check(
    "short plugin override cannot undercut the readable floor",
    toastDurationMs("Copied", { duration: 1 }) === TOAST_MIN_MS,
  );
  check(
    "longer explicit duration remains available",
    toastDurationMs("Copied", { duration: 15_000 }) === 15_000,
  );
  check(
    "automatic duration is capped for pathological plugin text",
    toastDurationMs("x".repeat(10_000)) === TOAST_MAX_AUTO_MS,
  );
  check(
    "layout whitespace does not consume reading time",
    toastDurationMs("Copied") === toastDurationMs("  Copied\n\t"),
  );

  const appCss = readFileSync(join(ROOT, "src", "App.css"), "utf8");
  const launcherToast = ruleBlock(appCss, ".toast");
  const launcherToastText = ruleBlock(appCss, ".toast-text");
  check(
    "launcher toast is viewport-bounded and scrollable",
    launcherToast.includes("width: max-content") &&
      launcherToast.includes("max-width: min(640px, calc(100vw - 48px))") &&
      launcherToast.includes("max-height: calc(100vh - 80px)") &&
      launcherToast.includes("overflow-y: auto") &&
      launcherToast.includes("scrollbar-width: none"),
  );
  check(
    "launcher toast wraps long words and preserves explicit line breaks",
    launcherToastText.includes("overflow-wrap: anywhere") &&
      launcherToastText.includes("white-space: pre-wrap"),
  );

  const pluginCss = readFileSync(join(ROOT, "src", "pluginWindow.css"), "utf8");
  const pluginToast = ruleBlock(pluginCss, "#plugin-window-toast");
  check(
    "detached-plugin toast is viewport-bounded and wraps long words",
    pluginToast.includes("box-sizing: border-box") &&
      pluginToast.includes("width: max-content") &&
      pluginToast.includes("max-width: min(640px, calc(100vw - 36px))") &&
      pluginToast.includes("max-height: calc(100vh - 54px)") &&
      pluginToast.includes("scrollbar-width: none") &&
      pluginToast.includes("overflow-wrap: anywhere") &&
      pluginToast.includes("white-space: pre-wrap"),
  );

  const settingsCss = readFileSync(join(ROOT, "src", "settings", "skins", "base.css"), "utf8");
  const settingsToast = ruleBlock(settingsCss, ".settings-toast");
  check(
    "settings toast is viewport-bounded and wraps long words",
    settingsToast.includes("width: max-content") &&
      settingsToast.includes("max-width: min(640px, calc(100vw - 48px))") &&
      settingsToast.includes("max-height: calc(100vh - 96px)") &&
      settingsToast.includes("scrollbar-width: none") &&
      settingsToast.includes("overflow-wrap: anywhere") &&
      settingsToast.includes("white-space: pre-wrap"),
  );

  const successful = checks.filter((item) => item.ok).length;
  console.log(`\nTOAST UNIT ${successful === checks.length ? "PASS" : "FAIL"} (${successful}/${checks.length})`);
  if (successful !== checks.length) process.exitCode = 1;
} finally {
  await server.close();
}
