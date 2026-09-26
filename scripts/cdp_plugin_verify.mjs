// One-off verification for the plugin system round: provider row in search +
// the settings 插件 pane.
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
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
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
await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`);
await sleep(2000);
// Type a rare query — the disk provider should append 搜索 "<q>" after the
// (few) native/file hits. A common letter would fill the 20-row grid cap and
// squeeze the provider row out.
await m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = "zzqx"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(2500);
const names = await m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
console.log("results:", JSON.stringify(names));
console.log("provider loaded:", await m.evalJs(`!!Array.from(document.querySelectorAll(".result-box-name")).find((n) => n.textContent.includes("zzqx"))`));
await m.shot("plugin_provider_search.png");

// ── mode page iframe under the sandbox (P5) ──
// Enter the file-search mode; the page renders and the iframe is an
// opaque-origin sandbox now: the host cannot reach into it (no
// contentDocument / lume readback). The in-iframe behaviours — keydown
// forwarding → lume.on.key, mousedown focus hand-off, Tab switching back —
// are exercised from INSIDE the sandbox by scripts/cdp_sandbox_verify.mjs
// (probe plugin); this script only checks the host-side contract.
const typeQ = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await typeQ("秒搜");
await sleep(1500);
const kwIdx = await m.evalJs(
  `[...document.querySelectorAll(".result-box")].findIndex((el) => el.textContent.includes("进入 文件秒搜"))`,
);
if (kwIdx < 0) { console.error("keyword row missing — file-search mode plugin not installed?"); process.exit(1); }
await m.evalJs(`[...document.querySelectorAll(".result-box")][${kwIdx}].dispatchEvent(new MouseEvent("click", { bubbles: true })); "ok"`);
await sleep(200);
await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))`);
await sleep(1200);
const frameUp = await m.evalJs(`(() => {
  const f = document.querySelector(".plugin-frame");
  if (!f) return false;
  const doc = f.contentDocument; // cross-origin → null
  return (f.getAttribute("sandbox") ?? "").includes("allow-scripts") && doc === null;
})()`);
console.log("file-search mode entered, iframe sandboxed (opaque):", frameUp);

// Typing in the host box while the mode is up must not break the pipeline
// (the page receives lume.on.query inside the sandbox — see the sandbox
// verify script for the in-iframe assertions).
await typeQ("lume");
await sleep(1500);
const stillUp = await m.evalJs(`!!document.querySelector(".plugin-frame")`);
console.log("mode page survives host typing:", stillUp);
await m.shot("plugin_iframe_keys.png");

// ── Settings → 插件 pane (the window is created at startup; open via gear). ──
await m.evalJs(`document.querySelector(".icon-btn")?.click(); "ok"`);
await sleep(1500);
let settingsT = null;
for (let i = 0; i < 20 && !settingsT; i++) {
  const pages = (await getTargets()).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    if (t === mainT) continue;
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      if (await c.evalJs(`document.body.classList.contains("settings-window")`)) { settingsT = t; c.ws.close(); break; }
      c.ws.close();
    } catch {}
  }
  if (!settingsT) await sleep(500);
}
if (!settingsT) { console.error("settings missing"); process.exit(1); }
const s = await connect(settingsT.webSocketDebuggerUrl);
await s.evalJs(`[...document.querySelectorAll(".settings-nav")].find((b) => /插件|Plugins|外掛/.test(b.textContent))?.click(); "ok"`);
await sleep(800);
const rows = await s.evalJs(`Array.from(document.querySelectorAll(".plg-name")).map((l) => l.textContent.trim().slice(0, 30))`);
console.log("plugin rows:", JSON.stringify(rows));
await s.shot("plugin_settings_pane.png");

const ok = frameUp && stillUp && rows.length > 0;
console.log(ok ? "PLUGIN VERIFY OK" : "PLUGIN VERIFY FAILED");
process.exit(ok ? 0 : 1);
