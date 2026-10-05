// 视图帧装载机制验证（P6.7，ROADMAP #33）——两半各一条断言：
//
//   node scripts/cdp_plugin_frame_load_verify.mjs [cycles] [--mode=empty|dropfirst]
//
//   --mode=empty（默认）：**预防**。记录每个 iframe 的 srcdoc 写入；修复后帧在
//     真实 HTML 之前绝不被导航（无空 srcdoc 写入），两个沙箱帧因此各只有一次
//     导航与进程交换。断言：零次空写入 + 视图帧就绪 + 标题栏帧就绪。
//   --mode=dropfirst：**兜底**。吞掉每个 iframe 的第一次大 srcdoc 写入（模拟被
//     丢掉的导航）；宿主侧 boot 看门狗应在 ~700ms 后重新触发导航把页面救回来。
//     断言：视图帧仍然就绪（无看门狗时必为空白）。
//
// 走 Page.reload 路径（同一 bug 在重载后同样可复现，便于注入预文档 shim）。
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, openSync, cpSync, existsSync } from "node:fs";

const CYCLES = Number(process.argv[2]) || 5;
const MODE = (process.argv.find((a) => a.startsWith("--mode=")) ?? "--mode=empty").split("=")[1];
const PLUGIN = "file-search";
const PORT = 9243;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
rmSync("test/frame_load", { recursive: true, force: true });
mkdirSync("test/frame_load", { recursive: true });
if (!existsSync(`src-tauri/target/release/plugins/${PLUGIN}`)) {
  cpSync(`examples/plugins/${PLUGIN}`, `src-tauri/target/release/plugins/${PLUGIN}`, { recursive: true });
}
const fd = openSync("test/frame_load/lume.log", "w");
spawn("src-tauri/target/release/lume.exe", [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", fd, fd],
});

const list = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return null; } };
function client(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const ready = new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params = {}) => new Promise((res) => { const k = ++id; pending.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r?.result?.result?.value;
  };
  return { ws, ready, send, evalJs };
}

// ── 预文档 shim：记录 srcdoc 写入（empty）或吞掉第一次大写入（dropfirst）──
const SHIM = `
(function () {
  var orig = Element.prototype.setAttribute;
  window.__srcdocWrites = [];
  var dropped = new WeakSet();
  Element.prototype.setAttribute = function (name, value) {
    if (name === "srcdoc" && this.tagName === "IFRAME") {
      window.__srcdocWrites.push(typeof value === "string" ? value.length : -1);
      ${MODE === "dropfirst"
        ? `if (typeof value === "string" && value.length > 500000 && !dropped.has(this)) { dropped.add(this); return; }`
        : ``}
    }
    return orig.call(this, name, value);
  };
})();
`;

let mainT = null;
for (let i = 0; i < 60 && !mainT; i++) {
  for (const t of ((await list()) ?? []).filter((x) => x.type === "page" && x.url.includes("tauri.localhost"))) {
    try { const c = client(t.webSocketDebuggerUrl); await c.ready; if (await c.evalJs(`!!document.getElementById("search-input")`)) { mainT = t; c.ws.close(); break; } c.ws.close(); } catch {}
  }
  if (!mainT) await sleep(500);
}
if (!mainT) { console.error("launcher target missing"); process.exit(1); }
const m = client(mainT.webSocketDebuggerUrl);
await m.ready;
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
await invoke("toggle_launcher");
await sleep(1500);
const disabled = await m.evalJs(`window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => (s.plugins?.disabled ?? []).includes(${JSON.stringify(PLUGIN)}))`);
if (disabled) { await invoke("set_plugin_enabled", { id: PLUGIN, enabled: true }); await sleep(800); }

let fail = 0;
for (let i = 1; i <= CYCLES; i++) {
  await invoke("plugin_window_open", { id: PLUGIN });
  let pt = null;
  for (let k = 0; k < 40 && !pt; k++) { await sleep(100); pt = (await list())?.find((t) => t.url.includes("plugin.html?plugin=" + PLUGIN)) ?? null; }
  if (!pt) { console.log(`cycle ${i}: no window`); fail++; continue; }
  const c = client(pt.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Page.addScriptToEvaluateOnNewDocument", { source: SHIM });
  await c.send("Page.reload");
  // dropfirst 要留给看门狗两次机会（首次吞掉 + 700ms 重试）
  await sleep(MODE === "dropfirst" ? 5000 : 3500);
  const writes = await c.evalJs(`window.__srcdocWrites ?? null`);
  const states = await c.evalJs(`((window).__frameStates||[]).filter((s) => s.reason === "ready").map((s) => s.name === "" ? "view" : s.name)`);
  const viewReady = Array.isArray(states) && states.includes("view");
  const emptyWrites = Array.isArray(writes) ? writes.filter((n) => n === 0).length : -1;
  const ok = viewReady && (MODE === "dropfirst" || emptyWrites === 0);
  if (!ok) fail++;
  console.log(`cycle ${i}: ${ok ? "ok" : "*** FAIL ***"} ready=[${states}] srcdocWrites=[${writes}] emptyWrites=${emptyWrites}`);
  c.ws.close();
  await invoke("plugin_window_close", { id: PLUGIN });
  await sleep(900);
}
console.log(`\nFRAME LOAD VERIFY (${MODE}) ${fail === 0 ? "OK" : "FAILED"} — ${CYCLES - fail}/${CYCLES}`);
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
process.exit(fail === 0 ? 0 : 1);
