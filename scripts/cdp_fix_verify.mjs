// One-off: verify the three fixes (hotkey button text / Tab cycling to plugin
// mode / About contributors).
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
spawn("src-tauri/target/release/lume.exe", [], {
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
// settings checks (hotkey text + about contributors)
let settingsT = null;
for (let i = 0; i < 40 && !settingsT; i++) {
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
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
await s.evalJs(`[...document.querySelectorAll(".settings-nav")].find((b) => /快捷键|Hotkeys|快捷鍵/.test(b.textContent))?.click(); "ok"`);
await sleep(500);
console.log("hotkey buttons:", await s.evalJs(`Array.from(document.querySelectorAll(".settings-hotkey-btn")).map((b) => b.textContent.trim()).join("|")`));
await s.evalJs(`[...document.querySelectorAll(".settings-nav")].find((b) => /关于|About|關於/.test(b.textContent))?.click(); "ok"`);
await sleep(500);
console.log("about rows:", await s.evalJs(`Array.from(document.querySelectorAll(".settings-sub-label")).map((l) => l.textContent + "=" + (l.parentElement.querySelector(".settings-about-value, .settings-link")?.textContent ?? "?")).join(" | ")`));
await s.shot("fix_about.png");

// main-window check: Tab cycles into the plugin mode
let mainT = null;
const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
for (const t of pages) {
  if (t === settingsT) continue;
  try {
    const c = await connect(t.webSocketDebuggerUrl);
    if (await c.evalJs(`!!document.getElementById("search-input")`)) { mainT = t; c.ws.close(); break; }
    c.ws.close();
  } catch {}
}
if (!mainT) { console.error("main missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`);
await sleep(1500);
await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" })); "ok"`);
await sleep(800);
console.log("after Tab #1 active pill:", await m.evalJs(`document.querySelector(".mode-switch-item.active")?.textContent.trim()`));
await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab" })); "ok"`);
await sleep(800);
console.log("after Tab #2 active pill:", await m.evalJs(`document.querySelector(".mode-switch-item.active")?.textContent.trim()`));
console.log("plugin frame visible:", await m.evalJs(`!!document.querySelector(".plugin-frame")`));
await m.shot("fix_tab_cycle.png");
process.exit(0);
