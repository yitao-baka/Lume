// 宿主 HTTP 回归（视图帧路径）：http-probe 夹具在 mode 页沙箱里自检四条路径，
// 宿主侧读回断言。离线可跑（本地 echo 服务），不碰第三方接口。
// ① 正常 JSON status/headers/text()/json() 全可用（回归点：
//                      成功结果带函数，跨 postMessage 不可克隆 → 曾假失败）
//   ② 非 2xx           不抛错，状态码可读
//   ③ 12s 慢响应       比旧看门狗死限（10s）慢但仍成功 → 必须拿到 200 与 JSON
//                      （http.request 的 timeoutMs 是 1–60s，桥不该提前判超时）
//   ④ 真卡死 vs 3000ms 必须 fail loud（报错），且之后桥照常工作
// 说明：夹具 manifest 用 network_allow 白名单放行 127.0.0.1（#32.3）。
// 截图：test/http_probe.png
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, openSync } from "node:fs";
import { createServer } from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
const ID = "http-probe";
mkdirSync("test", { recursive: true });
rmSync(`${BASE}/plugins/${ID}`, { recursive: true, force: true });
cpSync(`scripts/fixtures/${ID}`, `${BASE}/plugins/${ID}`, { recursive: true });

// ── 本地 echo 服务 ──
const slowMs = 12000;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/json") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, path: url.pathname, q: url.searchParams.get("q") }));
    return;
  }
  if (url.pathname === "/err") {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end("boom");
    return;
  }
  if (url.pathname === "/slow") {
    const ms = Number(url.searchParams.get("ms") || 1000);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: true, slept: ms }));
    }, ms);
    return;
  }
  if (url.pathname === "/hang") return; // 不回：看门狗路径
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("nope");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log("echo server on 127.0.0.1:" + port);

const logFd = openSync("test/http_probe_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9229" },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch("http://127.0.0.1:9229/json/list")).json(); } catch { await sleep(500); }
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

const disabled = await invoke("get_settings").then((s) => (s.plugins?.disabled ?? []).includes(ID)).catch(() => false);
if (disabled) { await invoke("set_plugin_enabled", { id: ID, enabled: true }); await sleep(1200); }

// 运行令牌：探针把查询原样回显进结果，脚本只认带本令牌的结果——否则会读到
// 上一轮留在 plugin_store.db 里的旧文档（文档没有删除入口，靠令牌区分新旧）。
const token = "run" + Date.now().toString(36);
await type(`HTTP 探针 ${port} ${token}`);
await sleep(1600);
if (!(await clickKwRow("HTTP 探针"))) {
  console.error("feature row missing — http-probe fixture not installed?");
  process.exit(1);
}
await m.shot("http_probe.png");

// 自检在帧内跑：③ 慢响应 12s + ④ 看门狗 8s，留足等待。
let probe = {};
for (let i = 0; i < 30; i++) {
  await sleep(2000);
  const raw = await invoke("plugin_storage_get", { id: ID, key: "probe" });
  try { probe = JSON.parse(JSON.parse(raw ?? '"{}"')); } catch { probe = {}; }
  if (probe && probe.finished && String(probe.query ?? "").includes(token)) break;
}
console.log("probe:", JSON.stringify(probe));
check("运行令牌：读到的是本次运行的结果", String(probe.query ?? "").includes(token), JSON.stringify(probe.query ?? null));

check("① JSON 200：status", probe.json?.status === 200, JSON.stringify(probe.json));
check("① JSON 200：text()/json() 可用（派生助手随结果回帧）",
  probe.json?.hasText === "function" && probe.json?.hasJson === "function", JSON.stringify(probe.json));
check("① JSON 200：text() 有内容、json() 解析出 ok",
  (probe.json?.textLen ?? -1) > 0 && probe.json?.ok === true, JSON.stringify(probe.json));
check("① JSON 200：响应头 / truncated 字段在位",
  String(probe.json?.contentType ?? "").includes("application/json") && probe.json?.truncated === false,
  JSON.stringify(probe.json));
check("② 500：不抛错且状态码可读", probe.err?.status === 500 && String(probe.err?.body ?? "").includes("boom"), JSON.stringify(probe.err));
check("③ 12s 慢响应：拿到 200 + JSON（桥看门狗不早于 timeoutMs）",
  probe.slow?.status === 200 && probe.slow?.ok === true, JSON.stringify(probe.slow));
check("③ 慢响应确实等满了 12s（没被提前截断）", (probe.slow?.ms ?? 0) >= 11000, String(probe.slow?.ms));
check("④ 卡死目标：fail loud 报错（Rust 超时或桥看门狗，非静默 undefined）",
  /timeout|80072EE2/i.test(String(probe.hang?.error ?? "")) && probe.hang?.resolved === undefined,
  JSON.stringify(probe.hang));
check("④ 在看门狗预算内就报了错（≤10s）", (probe.hang?.ms ?? 1e9) <= 10000, String(probe.hang?.ms));
check("④ 超时之后桥照常工作", probe.afterHangRpc === "ok", String(probe.afterHangRpc));

console.log(`\nHTTP PROBE VERIFY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
server.close();
process.exit(fail === 0 ? 0 : 1);
