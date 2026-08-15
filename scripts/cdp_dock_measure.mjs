// Dev diagnostic: measure the client-area gap between the launcher and the
// satellite preview on BOTH docks (left when the launcher is pinned top-right,
// right when pinned top-left). Reports CSS px (≈4 expected with the 4-logical-px
// PREVIEW_GAP). Restores the launcher's window_position afterward.
// Usage: node scripts/cdp_dock_measure.mjs
import { spawn, execSync } from "node:child_process";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";
const TEST = "E:\\SoftwareDevelopment\\Projects\\LumeLauncher\\test";
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
  return { evalJs };
}

let main = null, preview = null;
for (let attempt = 0; attempt < 10 && !main; attempt++) {
  const targets = await getTargets();
  for (const t of targets.filter((x) => x.type === "page")) {
    const h = await connect(t.webSocketDebuggerUrl);
    const cls = await h.evalJs(`document.body.className`).catch(() => "");
    const hasSearch = await h.evalJs(`!!document.querySelector(".search")`).catch(() => false);
    if (hasSearch) main = { ...h };
    else if (!cls.includes("settings-window")) preview = { ...h };
  }
  if (!main) await sleep(800);
}
if (!main || !preview) throw new Error("windows not found");
const inv = `window.__TAURI_INTERNALS__.invoke`;

const setPos = async (pos) => {
  const s = await main.evalJs(`${inv}("get_settings")`);
  s.appearance.window_position = pos;
  await main.evalJs(`${inv}("save_settings", { new: ${JSON.stringify(s)} })`);
};
const showClipboard = async () => {
  await main.evalJs(`${inv}("hide_launcher"); "h"`);
  await sleep(300);
  await main.evalJs(`${inv}("toggle_launcher"); "s"`);
  await sleep(900);
  await main.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); "tab"`);
  await sleep(1200);
  for (let i = 0; i < 20; i++) {
    const w = await preview.evalJs(`document.querySelector(".preview-pdf-canvas")?.width ?? 0`).catch(() => 0);
    if (w > 0) break;
    await sleep(300);
  }
};
const geom = async (h) => await h.evalJs(`({ sx: window.screenX, sw: window.outerWidth, iw: window.innerWidth })`);

// Seed a PDF row so the satellite has something to show.
execSync(`powershell -NoProfile -Command "Set-Clipboard -Path '${TEST}\\sample.pdf'"`);
await sleep(1000);

// LEFT dock (launcher pinned top-right → preview flips left).
await setPos("top-right");
await showClipboard();
let m = await geom(main), p = await geom(preview);
let mcl = m.sx + (m.sw - m.iw) / 2, pcr = p.sx + (p.sw - p.iw) / 2 + p.iw;
console.log("LEFT dock gap (preview client right → main client left), CSS px:", (mcl - pcr).toFixed(1));

// RIGHT dock (launcher pinned top-left → preview docks right).
await setPos("top-left");
await showClipboard();
m = await geom(main); p = await geom(preview);
const mcr = m.sx + (m.sw - m.iw) / 2 + m.iw, pcl = p.sx + (p.sw - p.iw) / 2;
console.log("RIGHT dock gap (preview client left → main client right), CSS px:", (pcl - mcr).toFixed(1));

// Restore the user's window_position + hide.
await setPos("center");
await main.evalJs(`${inv}("hide_launcher"); "done"`);
process.exit(0);
