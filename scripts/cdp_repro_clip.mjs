// Does the paste (Enter) flow RESTORE the clipboard afterward? And does the
// COPY button leave the old row's files on the clipboard? Isolated copy.
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CDP_PORT = 9224;
const RELEASE = "src-tauri/target/release";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const iso = mkdtempSync(join(tmpdir(), "lume-repro-"));
for (const entry of ["lume.exe", "lume-svc.exe", "data", "settings", "languages", "res"]) {
  try { cpSync(join(RELEASE, entry), join(iso, entry), { recursive: true }); } catch {}
}
console.log("[repro] isolated:", iso);
spawn(join(iso, "lume.exe"), [], {
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
  return { ws, send, evalJs };
}

const clipText = () => {
  try { return execSync(`powershell -NoProfile -Command "Get-Clipboard -Raw"`, { encoding: "utf8", timeout: 15000 }).trim().slice(0, 40); }
  catch { return "(no text on clipboard)"; }
};
const clipFiles = () => {
  try {
    const out = execSync(`powershell -NoProfile -Command "(Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }) -join ' | '"`, { encoding: "utf8", timeout: 15000 }).trim();
    return out || "(empty)";
  } catch { return "(no file drop)"; }
};
const setText = (s) => execSync(`powershell -NoProfile -Command "Set-Clipboard -Value '${s}'"`);

const targets = await getTargets();
let main = null;
for (const t of targets.filter((x) => x.type === "page")) {
  const h = await connect(t.webSocketDebuggerUrl);
  if (await h.evalJs(`!!document.querySelector(".search")`)) main = { ...h, url: t.url };
}
if (!main) throw new Error("launcher not found");

const items = await main.evalJs(`window.__TAURI_INTERNALS__.invoke("search_clipboard", { query: "", kind: "all" })`);
const old = items[items.length - 1];
console.log("[repro] oldest row id=", old.id, "kind=", old.kind);

// ── TEST 1: COPY BUTTON on the oldest FILE row → clipboard should KEEP old files ──
setText("X"); await sleep(200);
await main.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher"); "shown"`);
await sleep(600);
await main.evalJs(`document.querySelectorAll(".mode-switch-item")[1].click(); "clip"`);
// Wait until the clipboard list has rendered as many rows as the search returned.
for (let i = 0; i < 20; i++) {
  const n = await main.evalJs(`document.querySelectorAll(".clip-row").length`);
  if (n >= items.length) break;
  await sleep(300);
}
await main.evalJs(`document.querySelectorAll(".clip-row")[${items.length - 1}].querySelectorAll(".clip-act")[0].click(); "clicked"`);
await sleep(500);
console.log("[repro] after COPY button on oldest row — clipboard text:", clipText(), "| files:", clipFiles());

// ── TEST 2: ENTER on the oldest row (paste) → clipboard should be RESTORED ──
await main.evalJs(`document.querySelectorAll(".clip-row")[${items.length - 1}].click(); "selected"`);
await sleep(200);
await main.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await main.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(700);
console.log("[repro] after ENTER on oldest row — clipboard text:", clipText(), "| files:", clipFiles());

process.exit(0);
