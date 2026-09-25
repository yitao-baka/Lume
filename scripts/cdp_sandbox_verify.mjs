// 沙箱验证（P5）：mode 页 iframe 变 opaque origin + Rust 命令侧权限白名单。
//   ① sandbox  iframe 带 sandbox 属性（allow-scripts，无 allow-same-origin）
//   ② 隔离    宿主读不到 iframe 内部（contentDocument=null / lume 不可达）
//   ③ 桥内自检  sandbox-probe 插件页在 opaque origin 里自检并把结果写进
//            自己的 storage（origin=null、localStorage 抛错、parent 文档与
//            __TAURI_INTERNALS__ 不可达、window.lume 可用、keydown 转发 →
//            lume.on.key、mousedown → 焦点回搜索框），脚本从宿主侧读回；
//            最后自派 Tab → 宿主路由切回导航页（iframe 卸载）
//   ④ Rust 门控  主窗口直连 invoke：未声明 notify 的插件被 Rust 拒绝；
//            已声明的放行；file_search 无 pluginId（原生路径）放行、带未授权
//            pluginId 被拒
// 说明：WebView2 的 CDP 不把沙箱 iframe 的执行上下文暴露给 getFrameTree，
// 桥内断言由探针插件自检（scripts/fixtures/sandbox-probe/）——这是自动化
// 进入沙箱页的通道，也让「桥接在沙箱内照常工作」成为被测事实。
// 截图：test/sandbox_frame.png
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
mkdirSync("test", { recursive: true });
for (const id of ["hello-mode", "host-tools"]) {
  rmSync(`${BASE}/plugins/${id}`, { recursive: true, force: true });
  cpSync(`examples/plugins/${id}`, `${BASE}/plugins/${id}`, { recursive: true });
}
rmSync(`${BASE}/plugins/sandbox-probe`, { recursive: true, force: true });
cpSync(`scripts/fixtures/sandbox-probe`, `${BASE}/plugins/sandbox-probe`, { recursive: true });
const logFd = openSync("test/sandbox_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9227" },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch("http://127.0.0.1:9227/json/list")).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP unavailable");
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; p.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description ?? "eval failed"));
    return r?.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("test/" + name, Buffer.from(r.result.data, "base64"));
  };
  return { ws, evalJs, shot };
}

async function findMain() {
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      const ok = await c.evalJs(`!!document.getElementById("search-input")`);
      c.ws.close();
      if (ok) return t;
    } catch {}
  }
  return null;
}
let mainT = await findMain();
for (let i = 0; i < 40 && !mainT; i++) { await sleep(500); mainT = await findMain(); }
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const clickKwRow = async (label) => {
  const idx = await m.evalJs(`[...document.querySelectorAll(".result-box")].findIndex((el) => el.textContent.includes(${JSON.stringify(label)}))`);
  if (idx < 0) return false;
  await m.evalJs(`[...document.querySelectorAll(".result-box")][${idx}].dispatchEvent(new MouseEvent("click", { bubbles: true })); "ok"`);
  await sleep(250);
  await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))`);
  return true;
};

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : " — " + extra)); ok ? pass++ : fail++; };

await invoke("toggle_launcher");
await sleep(1800);

// ── 进 sandbox-probe（关键字 sbprobe）──
await type("sbprobe");
await sleep(1500);
if (!(await clickKwRow("进入 Sandbox Probe"))) { console.error("keyword row missing — sandbox-probe not installed?"); process.exit(1); }
await sleep(2500);
await m.shot("sandbox_frame.png");

// ① sandbox 属性
const sandboxAttr = await m.evalJs(`document.querySelector(".plugin-frame")?.getAttribute("sandbox") ?? ""`);
check("① sandbox attr present, no allow-same-origin",
  sandboxAttr.includes("allow-scripts") && !sandboxAttr.includes("allow-same-origin"), sandboxAttr);

// ② 宿主读不到 iframe 内部（同源特权消失）
const reach = await m.evalJs(`(() => {
  const f = document.querySelector(".plugin-frame");
  const doc = f.contentDocument;                       // cross-origin → null
  let lume = "unreadable";
  try { lume = typeof f.contentWindow.lume; } catch (e) { lume = "threw"; }
  return { doc: doc === null ? "null" : "REACHABLE", lume };
})()`);
check("② host cannot reach into the iframe", reach.doc === "null" && reach.lume !== "object", JSON.stringify(reach));

// ③ 探针自检结果（opaque origin + 受限 + 桥接/按键/焦点照常）
// storage 值是双重 JSON（桥接层 stringify 一次、探针 stringify 一次）。
let probeRaw = null;
for (let i = 0; i < 10 && !probeRaw; i++) {
  await sleep(400);
  probeRaw = await invoke("plugin_storage_get", { id: "sandbox-probe", key: "probe" });
}
let probe = {};
try { probe = JSON.parse(JSON.parse(probeRaw ?? '"{}"')); } catch (e) { probe = { parseError: String(probeRaw) }; }
check("③a iframe is opaque origin (null)", probe.origin === "null" && probe.srcdoc === true, JSON.stringify(probe));
check("③b localStorage blocked in the sandbox", probe.localStorage === "blocked", String(probe.localStorage));
check("③c parent document unreachable", probe.parentDoc === "blocked", String(probe.parentDoc));
check("③d parent __TAURI_INTERNALS__ unreachable",
  probe.parentInternals === "undefined" || probe.parentInternals === "threw", String(probe.parentInternals));
check("③e bridge alive: window.lume is an object", probe.hasLume === "object" && probe.ownDoc === "object", JSON.stringify({ hasLume: probe.hasLume, ownDoc: probe.ownDoc }));
check("③f keydown forwarded → lume.on.key", Array.isArray(probe.keysAfterA) && probe.keysAfterA.includes("a"), JSON.stringify(probe.keysAfterA));
const focusBack = await m.evalJs(`document.activeElement === document.getElementById("search-input")`);
check("③g focus hand-off after iframe mousedown", focusBack === true);
// Tab 由脚本经 query 事件遥控探针派发（iframe 不可从宿主触达）。
await type("tab");
await sleep(1000);
const tabSwitched = await m.evalJs(`!document.querySelector(".plugin-frame")`);
check("③h Tab in iframe switches back to Navigate", tabSwitched === true);

// ④ Rust 命令侧白名单（主窗口直连 invoke，绕过前端守卫；拒绝以
// promise rejection 出现，evalJs 里要先接住）
const tryInvoke = (cmd, args) => m.evalJs(
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})` +
  `.then(() => "resolved", (e) => String(e))`
);
const denied = await tryInvoke("plugin_notify", { title: "x", body: "y", pluginId: "hello-mode" });
check("④a Rust gate rejects undeclared capability", /permission denied|notify/.test(denied), denied);
const allowed = await tryInvoke("plugin_notify", { title: "Lume 沙箱验证", body: "host-tools 已声明 notify", pluginId: "host-tools" });
check("④b declared capability passes the Rust gate", allowed === "resolved", allowed);
const nativeSearch = await tryInvoke("file_search", { query: "readme" });
check("④c native file_search (no id, main window) still works", nativeSearch === "resolved", nativeSearch);
const gatedSearch = await tryInvoke("file_search", { query: "readme", pluginId: "hello-mode" });
check("④d file_search with unauthorized pluginId is denied",
  /permission denied|search\.files/.test(gatedSearch), gatedSearch);

console.log(`\nSANDBOX VERIFY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
