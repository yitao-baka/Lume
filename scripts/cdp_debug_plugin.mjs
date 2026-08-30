// One-off: capture console while exercising provider search after mode entry.
import { spawn, execSync } from "node:child_process";
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
  const pendingConsole = [];
  let consoleEnabled = false;
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); return; }
    if (consoleEnabled && d.method === "Runtime.consoleAPICalled") {
      const args = (d.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      pendingConsole.push("[page] " + args);
    }
    if (consoleEnabled && d.method === "Runtime.exceptionThrown") {
      pendingConsole.push("[page-exception] " + JSON.stringify(d.params.exceptionDetails?.exception?.description ?? d.params).slice(0, 200));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; p.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
  const drainConsole = () => { while (pendingConsole.length) console.log(pendingConsole.shift()); };
  const enableConsole = async () => { await send("Runtime.enable"); consoleEnabled = true; };
  return { ws, send, evalJs, enableConsole, drainConsole };
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
const m = await connect(mainT.webSocketDebuggerUrl);
await m.enableConsole();
await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`);
await sleep(1500);
await m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = "e"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(2500);
m.drainConsole();
console.log("FIRST search rows:", await m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent).join("|")`));
m.drainConsole();
process.exit(0);
