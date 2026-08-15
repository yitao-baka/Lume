// Dev helper: ROADMAP #15 smoke test for the satellite preview window.
// Launches the release exe with CDP, seeds text + image clipboard rows,
// switches to Clipboard mode, and verifies:
//   1. three page targets exist (main / settings / preview)
//   2. selecting a previewable row opens the satellite with content
//   3. the satellite is docked flush to the main window's right edge
//   4. the main window does NOT widen for previews anymore
//   5. Esc in the main window tears the satellite down to about:blank
// Leaves the app running for the memory measurement (measure-webview-mem.ps1).
// Usage: node scripts/cdp_preview_smoke.mjs
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";
const IMG = "E:\\SoftwareDevelopment\\Projects\\LumeLauncher\\test\\PixPin_2026-08-06_22-03-20.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP not available on :" + CDP_PORT);
}

async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; pending.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { ws, evalJs };
}

const targets = await getTargets();
for (const t of targets) console.log("[target]", t.type, JSON.stringify(t.title), t.url);

// Identify main / settings / preview by DOM probe. The preview window starts at
// about:blank (WebView2 won't run its initial preview.html load while hidden +
// WS_EX_NOACTIVATE) — identify it as the remaining page target.
let main = null, settings = null, preview = null;
for (const t of targets.filter((x) => x.type === "page")) {
  const h = await connect(t.webSocketDebuggerUrl);
  if (await h.evalJs(`!!document.querySelector(".search")`)) main = { ...h, url: t.url };
  else if (await h.evalJs(`document.body.classList.contains("settings-window")`)) settings = { ...h, url: t.url };
  else preview = { ...h, url: t.url };
}
if (!main) throw new Error("launcher (main) page not found");
if (!preview) throw new Error("preview window target not found");
console.log("[smoke] windows found — main:", main.url, "| settings:", settings?.url ?? "?", "| preview:", preview.url);

// Seed clipboard: image row first, then a text row (text ends up newest/top).
execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${IMG}'))"`);
await sleep(800);
execSync(`powershell -NoProfile -Command "Set-Clipboard -Value 'hello preview smoke 42'"`);
await sleep(800);

// Switch to Clipboard mode (Tab) — the top row is the text row.
await main.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); "tab"`);
await sleep(900);
const clipPage = await main.evalJs(`!!document.querySelector(".clip-page")`);
const title0 = await main.evalJs(`document.querySelector(".clip-row-title")?.textContent?.trim() ?? null`);
console.log("[smoke] clipboard page:", clipPage, "| top row title:", JSON.stringify(title0));

// Issue 4 rule: a plain TEXT row (kind text) must NOT open the satellite.
const mainWBefore = await main.evalJs(`window.outerWidth`);
await sleep(1200);
const previewBodyForText = await preview.evalJs(`!!document.querySelector(".preview-body, .preview-img, .preview-text")`);
console.log("[smoke] text row → preview has content (expect false):", previewBodyForText, "| top row:", JSON.stringify(title0));
const mainGeom = await main.evalJs(`({ x: window.screenX, iw: window.innerWidth, ih: window.innerHeight, w: window.outerWidth })`);
console.log("[smoke] main width before→after (expect ~720, not widened):", mainWBefore, "→", mainGeom.w);

// Image preview: click the 图片 category (index 3) → image rows → preview-img renders + docks.
await main.evalJs(`document.querySelectorAll(".clip-cat")[3]?.click(); "image-cat"`);
await sleep(1000);
const previewImg = await preview.evalJs(`!!document.querySelector(".preview-img")`);
const imgSrcHead = await preview.evalJs(`document.querySelector(".preview-img")?.src?.slice(0, 60) ?? null`);
const previewErr = await preview.evalJs(`document.querySelector(".preview-error")?.textContent ?? null`);
const imgTitle = await main.evalJs(`document.querySelector(".clip-row-title")?.textContent?.trim() ?? null`);
console.log("[smoke] image category — preview-img:", previewImg, "| src head:", imgSrcHead, "| error:", JSON.stringify(previewErr), "| top row:", JSON.stringify(imgTitle));
const geom = await preview.evalJs(`({ x: window.screenX, w: window.outerWidth, h: window.outerHeight })`);
console.log("[smoke] dock gap-vs-outer (expect ≤10; true client-edge gap ~1):", Math.abs(geom.x - (mainGeom.x + mainGeom.iw)), "| preview width (expect 320±1):", geom.w, "| preview h≈main.innerH:", Math.abs(geom.h - mainGeom.ih) <= 2);

// Screenshot the preview while it is open (before Esc tears it down).
try {
  const mainShot = await main.ws.send("Page.captureScreenshot", { format: "png" });
  const prevShot = await preview.ws.send("Page.captureScreenshot", { format: "png" });
  writeFileSync("smoke-preview-main.png", Buffer.from(mainShot.result?.data ?? "", "base64"));
  writeFileSync("smoke-preview-sat.png", Buffer.from(prevShot.result?.data ?? "", "base64"));
  console.log("[smoke] screenshots: smoke-preview-main.png / smoke-preview-sat.png");
} catch (e) { console.log("[smoke] screenshot failed:", e.message); }

// Esc in main closes the preview → about:blank.
await main.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
await sleep(600);
const previewGone = await preview.evalJs(`!document.querySelector(".preview-close")`);
const previewUrl = await preview.evalJs(`location.href`);
const mainStillUp = await main.evalJs(`!!document.querySelector(".search")`);
const mainWAfter = await main.evalJs(`window.outerWidth`);
console.log("[smoke] after Esc — preview torn down:", previewGone, "| url:", previewUrl, "| main still up:", mainStillUp, "| main width:", mainWAfter);

console.log("[smoke] leaving app running for memory measurement");
process.exit(0);
