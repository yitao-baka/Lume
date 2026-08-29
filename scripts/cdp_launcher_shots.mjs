// Dev helper: capture a fixed set of launcher screenshots for before/after
// refactor comparison. Usage: node scripts/cdp_launcher_shots.mjs <outDir>
// Captures: menu (empty-query bars), search (query "e"), clip-all / clip-selected
// (satellite preview) / clip-menu (context menu). menu+search are byte-stable
// across runs on the same machine (no timestamps); the clip ones carry relative
// times and are for visual review only.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";
const OUT = process.argv[2] ?? "test/shots";
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
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(OUT, name), Buffer.from(r.result.data, "base64"));
    console.log("saved", name);
  };
  return { ws, send, evalJs, shot };
}

mkdirSync(OUT, { recursive: true });
const targets = await getTargets();
const pages = targets.filter((t) => t.type === "page" && t.url.includes("tauri.localhost") && !t.url.includes("preview"));
let mainT = null;
for (const t of pages) {
  const c = await connect(t.webSocketDebuggerUrl);
  const isSettings = await c.evalJs(`document.body.classList.contains("settings-window")`);
  if (!isSettings) { mainT = t; await c.ws.close(); break; }
  await c.ws.close();
}
if (!mainT) { console.error("main target missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);

// Show the hidden launcher (tray/hotkey equivalent) and let icons settle.
await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher"); "shown"`);
await sleep(2500);
await m.shot("menu.png");

// Search results grid (fixed query — deterministic index on this machine).
await m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = "e"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(2000);
await m.shot("search.png");

// Clipboard mode via the mode pill (same as a real click).
await m.evalJs(`document.querySelectorAll(".mode-switch-item")[1].click(); "ok"`);
await sleep(2000);
await m.shot("clip-all.png");

// Select the first row (ArrowDown) — satellite preview pops after its debounce.
await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); "ok"`);
await sleep(1200);
await m.shot("clip-selected.png");

// Right-click the selected row → custom context menu.
await m.evalJs(`(() => { const row = document.querySelector(".clip-row.result-selected") ?? document.querySelector(".clip-row"); const r = row.getBoundingClientRect(); row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 10 })); return "ok"; })()`);
await sleep(500);
await m.shot("clip-menu.png");

await m.ws.close();
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
console.log("done:", OUT);
process.exit(0);
