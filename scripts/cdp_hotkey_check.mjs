// One-off: screenshot the 快捷键 settings pane + dump the recorder button text.
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
await sleep(600);
console.log("hotkey buttons:", await s.evalJs(`Array.from(document.querySelectorAll(".settings-hotkey-btn")).map((b) => ({ text: b.textContent.trim(), active: b.classList.contains("active") }))`));
console.log("chips:", await s.evalJs(`Array.from(document.querySelectorAll(".settings-chip")).map((c) => c.textContent.trim() + (c.classList.contains("active") ? "*" : "")).join("|")`));
await s.shot("hotkey_pane.png");
process.exit(0);
