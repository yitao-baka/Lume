// 独立窗口空白页回归验证（P6.7，ROADMAP #33）：新建/销毁 `plugin-<id>` 窗口 N
// 次，逐次断言**视图帧的桥接真的起来了**（`__frameStates` 里 name="" 的 ready
// 上报 + 心跳）。
//
//   node scripts/cdp_plugin_blank_verify.mjs [cycles] [--plugin=id] [--keep]
//
// 回归背景：`srcdoc=""` 的初始导航 + 紧随其后的真实导航 = 同一页面里两个沙箱帧
// 的进程交换挤在一起，WebView2 会丢掉后一个导航，帧永久停在空文档上（窗口只剩
// 宿主 chrome，看起来整页空白）。修复前 file-search **10/12 空白**，修复后
// **0/34**。截图存 test/blank_repro/。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, openSync, cpSync, existsSync } from "node:fs";

const CYCLES = Number(process.argv[2]) || 20;
const KEEP = process.argv.includes("--keep");
const PLUGIN = (process.argv.find((a) => a.startsWith("--plugin=")) ?? "--plugin=file-search").split("=")[1];
const PORT = 9233;
const APP = "src-tauri/target/release/lume.exe";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
mkdirSync("test/blank_repro", { recursive: true });
rmSync("test/blank_repro", { recursive: true, force: true });
mkdirSync("test/blank_repro", { recursive: true });
// Fixture: prefer the installed copy (the file-search fixture ships here with
// titlebar + detachable); fall back to the example.
if (!existsSync(`src-tauri/target/release/plugins/${PLUGIN}`)) {
  cpSync(`examples/plugins/${PLUGIN}`, `src-tauri/target/release/plugins/${PLUGIN}`, { recursive: true });
}

const logFd = openSync("test/blank_repro/lume.log", "w");
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
});

async function listTargets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return null; }
}
async function findTarget(match) {
  const pages = ((await listTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes(match));
  return pages[0] ?? null;
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  const consoleLines = [];
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.id && p.has(d.id)) { p.get(d.id)(d); p.delete(d.id); return; }
    if (d.method === "Runtime.consoleAPICalled") {
      const args = (d.params.args || []).map((a) => a.value ?? a.description ?? "").join(" ");
      consoleLines.push(`[console.${d.params.type}] ${args}`.slice(0, 300));
    }
    if (d.method === "Runtime.exceptionThrown") {
      consoleLines.push(`[exception] ${d.params.exceptionDetails?.exception?.description ?? JSON.stringify(d.params).slice(0, 300)}`.slice(0, 400));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; p.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails).slice(0, 500));
    if (r?.error) throw new Error("cdp error: " + JSON.stringify(r.error).slice(0, 300));
    return r?.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    if (r?.result?.data) writeFileSync("test/blank_repro/" + name, Buffer.from(r.result.data, "base64"));
  };
  return { ws, send, evalJs, shot, consoleLines };
}

// Wait for the launcher target.
let mainT = null;
for (let i = 0; i < 60 && !mainT; i++) {
  const pages = ((await listTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      if (await c.evalJs(`!!document.getElementById("search-input")`)) { mainT = t; c.ws.close(); break; }
      c.ws.close();
    } catch {}
  }
  if (!mainT) await sleep(500);
}
if (!mainT) { console.error("launcher target missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
// The launcher is visible when a user clicks 分离 (detach) — keep it shown for
// the whole run so window focus/visibility matches the real flow.
await invoke("toggle_launcher");
await sleep(1500);
// Ensure the fixture plugin is enabled (leftover state from other verifies).
const disabled = await m.evalJs(`window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => (s.plugins?.disabled ?? []).includes(${JSON.stringify(PLUGIN)}))`);
if (disabled) {
  await invoke("set_plugin_enabled", { id: PLUGIN, enabled: true });
  await sleep(800);
}

const PROBE = `(() => {
  const root = document.getElementById("root");
  const states = (window).__frameStates || [];
  const res = (performance.getEntriesByType("resource") || []).map((r) => r.name.split("/").pop() + ":" + Math.round(r.duration)).join(",");
  return {
    rootChildren: root ? root.childElementCount : -1,
    hasRoot: !!document.querySelector(".plugin-window-root"),
    titlebarReady: states.some((s) => s.name === "titlebar" && s.reason === "ready"),
    viewReady: states.some((s) => s.name === "" && s.reason === "ready"),
    viewTicks: states.filter((s) => s.name === "" && s.reason === "tick").length,
    pluginStates: ((window).__pluginStates || []).length,
    resources: res,
  };
})()`;

let blanks = 0;
let errors = 0;
for (let i = 1; i <= CYCLES; i++) {
  const r = await invoke("plugin_window_open", { id: PLUGIN });
  // Wait for the target to appear.
  let pt = null;
  for (let k = 0; k < 40 && !pt; k++) { await sleep(100); pt = await findTarget("plugin.html?plugin=" + PLUGIN); }
  if (!pt) {
    console.log(`cycle ${i}: ${r} — target NEVER appeared`);
    blanks++; errors++;
    continue;
  }
  await sleep(3000); // let the (large) view + titlebar pages load and settle
  let info = null; let err = null; let consoleDump = [];
  try {
    const c = await connect(pt.webSocketDebuggerUrl);
    await c.send("Runtime.enable");
    await sleep(300);
    info = await c.evalJs(PROBE);
    await c.shot(`cycle_${String(i).padStart(2, "0")}.png`);
    consoleDump = c.consoleLines.slice(0, 12);
    c.ws.close();
  } catch (e) { err = String(e); }
  // The real failure: the view iframe's bridge never comes up (its document
  // is the empty srcdoc one) — the window shows only the host chrome.
  const blank = !info || info.viewReady !== true;
  if (blank) blanks++;
  console.log(`cycle ${i}: ${r} ${blank ? "*** BLANK ***" : "ok"} ${info ? JSON.stringify(info) : err}`);
  if (blank && consoleDump.length) console.log("   console: " + consoleDump.join(" | "));
  await invoke("plugin_window_close", { id: PLUGIN });
  await sleep(900);
  for (let k = 0; k < 30; k++) { if (!(await findTarget("plugin.html?plugin=" + PLUGIN))) break; await sleep(100); }
}

console.log(`\nBLANK ${blanks}/${CYCLES}`);
if (!KEEP) { try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {} }
process.exit(blanks > 0 ? 1 : 0);
