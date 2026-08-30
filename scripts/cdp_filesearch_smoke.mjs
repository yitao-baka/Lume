// One-off verification for the unified file-search facade: direct
// `file_search` invoke (backend selection) + the merged grid while typing.
// Run with the debug exe + vite dev server: `npm run dev` first.
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

// 1) Direct facade invoke — backend must be "everything" on this machine
//    (Everything is running) and hits must be real paths.
for (let i = 0; i < 3; i++) {
  const direct = await m.evalJs(
    `window.__TAURI_INTERNALS__.invoke("file_search", { query: "readme" })`,
  );
  console.log(`direct #${i}:`, direct.backend, direct.status, direct.entries.length, "entries");
}
const direct = await m.evalJs(
  `window.__TAURI_INTERNALS__.invoke("file_search", { query: "readme" })`,
);
console.log("sample:", direct.entries.slice(0, 3).map((e) => e.path));

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

const ok = direct.backend === "everything" && direct.entries.length > 0 && names.length > 0;
console.log(ok ? "SMOKE OK" : "SMOKE FAILED");
process.exit(ok ? 0 : 1);
