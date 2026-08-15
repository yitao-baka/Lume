// Dev helper: ROADMAP #15 memory reclaim test.
// Launches the release exe with CDP, seeds an image clipboard row, opens the
// satellite preview, and snapshots memory via measure-webview-mem.ps1 at:
//   baseline        — preview at about:blank (expect renderer ×3)
//   preview-open    — image decoded in the preview renderer (spike)
//   preview-closed  — Esc → about:blank, preview renderer back to baseline
// Usage: node scripts/cdp_preview_memtest.mjs
import { spawn, execSync } from "node:child_process";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";
const IMG = "E:\\SoftwareDevelopment\\Projects\\LumeLauncher\\test\\PixPin_2026-08-06_22-03-20.png";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const snap = (label) => {
  const out = execSync(
    `powershell -ExecutionPolicy Bypass -File scripts/measure-webview-mem.ps1 -Label ${label}`,
    { encoding: "utf8" }
  );
  console.log(out.split("\n").filter((l) => /快照|priv-WS|TOTAL|renderer/.test(l)).join("\n"));
};

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
const app = spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP not available");
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
let main = null, settings = null, preview = null;
for (const t of targets.filter((x) => x.type === "page")) {
  const h = await connect(t.webSocketDebuggerUrl);
  if (await h.evalJs(`!!document.querySelector(".search")`)) main = { ...h };
  else if (await h.evalJs(`document.body.classList.contains("settings-window")`)) settings = { ...h };
  else preview = { ...h }; // the preview window (starts at about:blank)
}
if (!main) throw new Error("main not found");
if (!preview) throw new Error("preview target not found");
console.log("windows: main", main ? "ok" : "?", "settings", settings ? "ok" : "?", "preview", preview ? "ok" : "?");
await sleep(1500);

console.log("=== BASELINE (preview about:blank) ===");
snap("baseline");

// Seed an image row, switch to Clipboard, open the image preview.
execSync(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; [System.Windows.Forms.Clipboard]::SetImage([System.Drawing.Image]::FromFile('${IMG}'))"`);
await sleep(900);
await main.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); "tab"`);
await sleep(900);
await main.evalJs(`document.querySelectorAll(".clip-cat")[3]?.click(); "image-cat"`);
await sleep(1500);
const rendered = await preview.evalJs(`!!document.querySelector(".preview-img")`);
console.log("=== PREVIEW OPEN (image decoded) — preview-img rendered:", rendered, "===");
snap("preview-open");

// Esc → about:blank, wait for teardown + GC-ish settle.
await main.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); "esc"`);
await sleep(4000);
console.log("=== PREVIEW CLOSED (about:blank) ===");
snap("preview-closed");

app.kill();
process.exit(0);
