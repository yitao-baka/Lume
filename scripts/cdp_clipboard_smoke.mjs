// Dev helper: end-to-end smoke test for the clipboard-mode redesign
// (ROADMAP #13, phase 1). Launches the release exe with CDP, seeds the
// clipboard through the app's own listener, switches to Clipboard mode, and
// inspects the DOM: category tabs, rows, status bar, filtering, virtual list.
// Usage: node scripts/cdp_clipboard_smoke.mjs
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Clean slate: stop any prior instance so the single-instance mutex is free.
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const app = spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function getWsUrl() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(500);
  }
  throw new Error("CDP not available on :" + CDP_PORT);
}

let targets = [];
for (let i = 0; i < 10 && targets.length === 0; i++) {
  try { targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(400); }
}
for (const t of targets) console.log("[target]", t.type, JSON.stringify(t.title), t.url);

/** Connect and return true when the page hosts the launcher (.search exists). */
async function probeLauncher(url) {
  const w = new WebSocket(url);
  let i = 0; const pend = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const snd = (method, params) => new Promise((res) => { const k = ++i; pend.set(k, res); w.send(JSON.stringify({ id: k, method, params })); });
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  const r = await snd("Runtime.evaluate", { expression: "!!document.querySelector('.search')", returnByValue: true });
  w.close();
  return r.result?.result?.value === true;
}

let wsUrl = null;
for (const t of targets.filter((x) => x.type === "page")) {
  if (await probeLauncher(t.webSocketDebuggerUrl)) { wsUrl = t.webSocketDebuggerUrl; break; }
}
if (!wsUrl) throw new Error("launcher page not found");
console.log("[smoke] using launcher ws:", wsUrl);

// Seed history through the app's own listener (each Set-Clipboard bumps the
// sequence number → the recorder stores a row with a source app).
const seeds = [
  "https://example.com/some/long/path",
  "#ff8800",
  "hello lume clipboard text",
  "rgb(96, 165, 250)",
];
for (const val of seeds) {
  execSync(`powershell -NoProfile -Command "Set-Clipboard -Value '${val}'"`);
  await sleep(700);
}

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params) =>
  new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

// Diagnostic: what is on screen before we switch?
console.log("[dbg] search:", await evalJs(`!!document.querySelector(".search")`));
console.log("[dbg] pills:", await evalJs(`[...document.querySelectorAll(".mode-switch-item")].map((p) => p.textContent.trim() + ":" + (p.classList.contains("active") ? "ACTIVE" : "idle"))`));
console.log("[dbg] bar-list:", await evalJs(`!!document.querySelector(".bar-list")`));
console.log("[dbg] clip-page:", await evalJs(`!!document.querySelector(".clip-page")`));

// Tab switches to Clipboard mode.
await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); "tab"`);
await sleep(900);
console.log("[dbg] after Tab clip-page:", await evalJs(`!!document.querySelector(".clip-page")`));
console.log("[dbg] after Tab pills:", await evalJs(`[...document.querySelectorAll(".mode-switch-item")].map((p) => p.textContent.trim() + ":" + (p.classList.contains("active") ? "ACTIVE" : "idle"))`));

const cats = await evalJs(`[...document.querySelectorAll(".clip-cat")].map((c) => c.textContent.trim())`);
const status = await evalJs(`document.querySelector(".clip-status-count")?.textContent ?? null`);
const rowCount = await evalJs(`document.querySelectorAll(".clip-row").length`);
const rowMeta = await evalJs(`[...document.querySelectorAll(".clip-row-meta")].map((m) => m.textContent.trim()).slice(0, 4)`);
const titles = await evalJs(`[...document.querySelectorAll(".clip-row-title")].map((t) => t.textContent.trim()).slice(0, 4)`);
const emptyVisible = await evalJs(`!!document.querySelector(".clip-empty")`);
const spacerH = await evalJs(`document.querySelector(".clip-spacer")?.style.height ?? null`);
console.log("[smoke] cats =", JSON.stringify(cats));
console.log("[smoke] status =", JSON.stringify(status));
console.log("[smoke] rendered rows =", rowCount);
console.log("[smoke] titles =", JSON.stringify(titles));
console.log("[smoke] metas =", JSON.stringify(rowMeta));
console.log("[smoke] emptyVisible =", emptyVisible, "spacerH =", spacerH);

// Category filter: click 收藏 (favorites, index 4) → empty (nothing pinned).
await evalJs(`document.querySelectorAll(".clip-cat")[4]?.click(); "click"`);
await sleep(500);
const favEmpty = await evalJs(`document.querySelectorAll(".clip-row").length`);
const favEmptyVisible = await evalJs(`!!document.querySelector(".clip-empty")`);
console.log("[smoke] favorites rows =", favEmpty, "empty =", favEmptyVisible);

// Back to 全部, click the 文本 filter → only text rows.
await evalJs(`document.querySelectorAll(".clip-cat")[0]?.click(); "all"`);
await sleep(400);
await evalJs(`document.querySelectorAll(".clip-cat")[1]?.click(); "text"`);
await sleep(400);
const textRows = await evalJs(`document.querySelectorAll(".clip-row").length`);
console.log("[smoke] text-category rows =", textRows);

// Multi-select: Space on the first row, check the badge + status text.
await evalJs(`document.querySelectorAll(".clip-row")[0]?.dispatchEvent(new MouseEvent("mousemove")); window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); "space"`);
await sleep(300);
const multiStatus = await evalJs(`document.querySelector(".clip-status-count")?.textContent ?? null`);
const multiBadges = await evalJs(`document.querySelectorAll(".clip-row-check").length`);
console.log("[smoke] after Space: status =", JSON.stringify(multiStatus), "badges =", multiBadges);

writeFileSync("smoke-clipboard.png", Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result?.data ?? "", "base64"));
console.log("[smoke] screenshot saved: smoke-clipboard.png");

// Leave the app running for further inspection.
console.log("[smoke] leaving app running");
process.exit(0);
