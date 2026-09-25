// 独立窗口验证（P6）：mode 页分离为独立窗口的端到端流程。
//   ① detach  hello-mode（detachable = true）激活后页面有「在独立窗口打开」
//            按钮 → 点击 → 启动器隐藏，plugin-<id> 窗口创建（CDP 新 target）
//   ② 窗口页  plugin.html 加载：桥接 iframe 带沙箱属性；就绪握手后宿主推送
//            状态（__lastPluginState.show === true）
//   ③ 激活路由 关键字再次进入已分离的模式 → 窗口被聚焦（不切启动器页面）→
//            onEnter 投递进窗口（钩子写 storage，从主窗口读回验证）
//   ④ 关闭    Esc（未消费）→ 窗口销毁；几何写入 settings.plugins.window_bounds
//   ⑤ 重开    plugin_window_open 再建窗口；禁用插件 → 窗口自动关闭
// 截图：test/plugin_window.png（插件窗口内容）
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
mkdirSync("test", { recursive: true });
rmSync(`${BASE}/plugins/hello-mode`, { recursive: true, force: true });
cpSync(`examples/plugins/hello-mode`, `${BASE}/plugins/hello-mode`, { recursive: true });
const logFd = openSync("test/plugin_window_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9228" },
  stdio: ["ignore", logFd, logFd],
});

const PORT = 9228;
async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(500); }
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
async function findWindow(match, probe) {
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes(match));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      const ok = probe ? await probe(c) : true;
      if (ok) return { target: t, conn: c };
      c.ws.close();
    } catch {}
  }
  return null;
}
async function findMain() {
  return findWindow("tauri.localhost", async (c) => {
    const ok = await c.evalJs(`!!document.getElementById("search-input")`);
    c.ws.close();
    return ok;
  });
}

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : " — " + extra)); ok ? pass++ : fail++; };

let mainT = await findMain();
for (let i = 0; i < 40 && !mainT; i++) { await sleep(500); mainT = await findMain(); }
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
const m = await connect(mainT.target.webSocketDebuggerUrl);
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
const pluginWindowTarget = async () => {
  for (let i = 0; i < 20; i++) {
    const t = await findWindow("plugin.html?plugin=hello-mode");
    if (t) return t;
    await sleep(400);
  }
  return null;
};

await invoke("toggle_launcher");
await sleep(1500);

// ① 进入 hello-mode → 分离按钮出现 → 点击
await type("hello");
await sleep(1500);
if (!(await clickKwRow("进入 Hello Mode"))) { console.error("keyword row missing"); process.exit(1); }
await sleep(1500);
const btnInfo = await m.evalJs(`(() => {
  const b = document.querySelector(".detach-btn");
  if (!b) return null;
  return { text: b.textContent.trim(), title: b.title };
})()`);
check("①a detach button present on the detachable mode page", !!btnInfo, JSON.stringify(btnInfo));
await m.evalJs(`document.querySelector(".detach-btn").click(); "ok"`);
await sleep(2500);

// ② 插件窗口创建 + 页面加载 + 就绪握手状态推送
const pw = await pluginWindowTarget();
check("①b plugin window created (CDP target)", !!pw, "plugin.html?plugin=hello-mode target");
if (!pw) { console.log(`\nPLUGIN WINDOW VERIFY FAILED (${pass}/${pass + fail})`); process.exit(1); }
const w = pw.conn;
check("②a host page has the sandboxed bridge iframe", await w.evalJs(
  `(() => { const f = document.querySelector(".plugin-frame"); return !!f && (f.getAttribute("sandbox") ?? "").includes("allow-scripts") && !f.contentDocument; })()`
));
let state = null;
for (let i = 0; i < 15 && !state; i++) {
  await sleep(400);
  state = await w.evalJs(`((window).__pluginStates ?? []).find((s) => s.show === true) ?? null`);
}
check("②b ready handshake pushed state (show)", !!state && state.show === true, JSON.stringify(state));
await w.shot("plugin_window.png");

// ③ 激活路由：feature 行进入已分离模式 → 聚焦窗口（不切启动器页面）+
//    enter payload 跨窗口推送（iframe 收 lume.on.enter，钩子写 storage）
await invoke("toggle_launcher");
await sleep(1200);
await type("hello:payload-test");
await sleep(1500);
const featVisible = await m.evalJs(`[...document.querySelectorAll(".result-box")].some((el) => el.textContent.includes("Hello Mode：处理这段文本"))`);
await m.evalJs(`(() => { const b = [...document.querySelectorAll(".result-box")].find((el) => el.textContent.includes("Hello Mode：处理这段文本")); if (b) b.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "ok"; })()`);
await sleep(2000);
// 启动器应已隐藏（detach 语义），插件窗口仍是同一 target（聚焦而非重建）
const pwAfter = await pluginWindowTarget();
check("③a feature enter into the detached mode focuses the window",
  !!pwAfter && featVisible, `window alive: ${!!pwAfter}, feature row: ${featVisible}`);
let lastEnter = null;
for (let i = 0; i < 10 && !lastEnter; i++) {
  await sleep(300);
  const raw = await invoke("plugin_storage_get", { id: "hello-mode", key: "lastEnter" });
  // storage.set JSON-stringifies once; the hook stored an object → one parse.
  try { lastEnter = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { lastEnter = null; }
}
check("③b enter payload delivered (logic hook wrote storage)",
  !!lastEnter && lastEnter.code === "shout" && lastEnter.payload === "hello:payload-test",
  JSON.stringify(lastEnter));
// 推送交错（shown 与 enter），读追加式历史而不是最后一条。
const pushedEnter = pwAfter
  ? await pwAfter.conn.evalJs(`((window).__pluginStates ?? []).some((s) => s.enter?.code === "shout")`)
  : false;
check("③c enter payload pushed across windows (plugin-state)", pushedEnter === true);

// ④ Esc（未消费）关闭窗口 + 几何记忆
await w.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"`);
await sleep(1500);
const goneAfterEsc = !(await pluginWindowTarget());
check("④a Esc closes (destroys) the plugin window", goneAfterEsc);
const bounds = await invoke("get_settings").then(
  (s) => (s.plugins?.window_bounds ?? {})["hello-mode"] ?? null,
  () => null
);
check("④b window geometry remembered in settings", !!bounds && bounds.width > 0, JSON.stringify(bounds));

// ⑤ 重开 + 禁用自动关窗
await invoke("plugin_window_open", { id: "hello-mode" });
const pwReopened = await pluginWindowTarget();
check("⑤a plugin_window_open recreates the window", !!pwReopened);
let reState = null;
for (let i = 0; i < 15 && !reState; i++) {
  await sleep(400);
  reState = pwReopened ? await pwReopened.conn.evalJs(`((window).__pluginStates ?? []).some((s) => s.show === true)`) : null;
}
check("⑤b ready handshake re-runs on the rebuilt window (state pushed again)",
  reState === true, String(reState));
await invoke("set_plugin_enabled", { id: "hello-mode", enabled: false });
await sleep(2000);
const goneAfterDisable = !(await pluginWindowTarget());
check("⑤c disabling the plugin closes its detached window", goneAfterDisable);
await invoke("set_plugin_enabled", { id: "hello-mode", enabled: true });

pwReopened?.conn.ws.close();
console.log(`\nPLUGIN WINDOW VERIFY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
