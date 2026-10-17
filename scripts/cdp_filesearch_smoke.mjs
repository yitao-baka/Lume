// One-off verification for the unified file-search facade: direct
// `file_search` invoke (backend selection) + the merged grid while typing.
// Run against the built debug exe (`frontendDist` is embedded); no vite server
// is required. The backend is whatever this machine provides — Everything or
// the LumeSVC USN index — and a machine with neither skips instead of failing.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
spawn("src-tauri/target/debug/lume.exe", [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  stdio: "ignore",
});
async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch("http://127.0.0.1:9222/json/list")).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP unavailable");
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; p.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("test/" + name, Buffer.from(r.result.data, "base64"));
    console.log("saved", name);
  };
  return { ws, evalJs, shot };
}
mkdirSync("test", { recursive: true });
let mainT = null;
for (let i = 0; i < 40 && !mainT; i++) {
  const pages = ((await getTargets()) ?? []).filter(
    (t) => t.type === "page" && (t.url.includes("tauri.localhost") || t.url.includes("localhost:1420")),
  );
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      if (await c.evalJs(`!!document.getElementById("search-input")`)) { mainT = t; c.ws.close(); break; }
      c.ws.close();
    } catch {}
  }
  if (!mainT) await sleep(500);
}
if (!mainT) { console.error("main missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
const consoleLines = [];
await m.evalJs(`(window.__captured = []); (function(){ const orig = console.error; console.error = (...a) => { window.__captured.push(a.join(" ")); orig(...a); }; })()`);
await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`);
await sleep(1200);

// 1) Direct facade invoke — either real backend is valid. Wait briefly for a
//    building service; an unavailable backend is an environment skip.
let direct = null;
for (let i = 0; i < 10; i++) {
  direct = await m.evalJs(
    `window.__TAURI_INTERNALS__.invoke("file_search", { query: "readme" })`,
  );
  console.log(`direct #${i}:`, direct.backend, direct.status, direct.entries.length, "entries");
  if (direct.status === "ready" || direct.backend === "none") break;
  await sleep(1000);
}
console.log("sample:", direct.entries.slice(0, 3).map((e) => e.path));
const usableBackend = direct.backend === "everything" || direct.backend === "svc";
if (!usableBackend) {
  console.log(`SKIP: no ready file-search backend (backend=${direct.backend}, status=${direct.status})`);
  process.exit(0);
}

// 2) Type the query and confirm the grid renders the merged rows.
await m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = "readme"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(2500);
const names = await m.evalJs(
  `[...document.querySelectorAll(".result-box-name")].map((n) => n.textContent)`,
);
console.log("grid rows:", names.length, JSON.stringify(names));
const errs = await m.evalJs(`window.__captured`);
console.log("console errors:", JSON.stringify(errs));
await m.shot("filesearch_grid.png");

// Older builds could log the expected "settings arrived before logic" miss
// once at startup. The pending-settings path re-delivers it; keep the smoke
// strict about every other console error.
const unexpectedErrors = errs.filter(
  (line) => !line.includes('provider onSettings failed: Error: logic not loaded'),
);
const ok = direct.entries.length > 0 && names.length > 0 && unexpectedErrors.length === 0;
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
