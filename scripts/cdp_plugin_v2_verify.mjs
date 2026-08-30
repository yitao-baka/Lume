// One-off verification for plugin v2: keyword row → mode entry → iframe UI
// (bridge RPC: toast/storage/clipboard) + legacy provider still working.
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

// 1. Keyword "hello" → 进入 Hello Mode row
await m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = "hello"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(2000);
console.log("keyword row:", await m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent).join("|")`));
await m.shot("plugin_v2_keyword.png");

// 2. Enter the mode (click the keyword row) → iframe mode page renders
await m.evalJs(`Array.from(document.querySelectorAll(".result-box")).find((b) => b.textContent.includes("进入"))?.click(); "ok"`);
await sleep(2000);
console.log("mode label:", await m.evalJs(`Array.from(document.querySelectorAll(".mode-switch-item")).map((b) => b.textContent.trim()).join("|")`));
console.log("iframe present:", await m.evalJs(`!!document.querySelector(".plugin-frame")`));
console.log("iframe lume bridge:", await m.evalJs(`!!document.querySelector(".plugin-frame")?.contentWindow?.lume`));
console.log("iframe h1:", await m.evalJs(`document.querySelector(".plugin-frame")?.contentWindow?.document.querySelector("h1")?.textContent`));
await m.shot("plugin_v2_mode.png");

// 3. Bridge RPC: storage counter via the page button
await m.evalJs(`document.querySelector(".plugin-frame").contentWindow.document.getElementById("count").click(); "ok"`);
await m.evalJs(`document.querySelector(".plugin-frame").contentWindow.document.getElementById("count").click(); "ok"`);
await sleep(500);
console.log("counter view:", await m.evalJs(`document.querySelector(".plugin-frame").contentWindow.document.getElementById("countView").textContent`));

// 4. Legacy provider still works (type "e" — wait, we're in mode; switch back via pills)
await m.evalJs(`document.querySelectorAll(".mode-switch-item")[0].click(); "ok"`);
await sleep(800);
await m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = "e"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(2000);
console.log("provider row still ok:", await m.evalJs(`!!Array.from(document.querySelectorAll(".result-box-name")).find((n) => n.textContent.includes("搜索"))`));
await m.shot("plugin_v2_search.png");
process.exit(0);
