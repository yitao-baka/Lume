// 闲置重置（ROADMAP #46）端到端验证。
//
// 夹具：examples/plugins/state-probe（清单 keep_session = true，豁免默认）
//       examples/plugins/hello-mode（未声明，默认不豁免）
//
// 覆盖：
//   A 阈值内不重置：hide → 模拟 +10min → show，页面/查询/iframe 身份不变
//   B 超阈值完整重置（默认 30min）：回导航页、query 清空、非豁免页宿主卸载
//     （冷启动）、豁免页宿主与状态原样保留、豁免页 query 保留
//   C 重置后重进：非豁免页 query 为空 + iframe 新建；豁免页 query 回放、
//     iframe 身份不变
//   D 用户级覆盖（false）：清单声明豁免的 state-probe 被强制重置
//   E 用户级覆盖（true）：未声明的 hello-mode 被保留
//   F 总开关关闭：超阈值也不重置
//   G 恢复默认后：清单 keep_session 重新生效（state-probe 保留）
//
// 时间通过 page 上下文覆写 Date.now 加偏移模拟（锚点比较用的是挂钟）；
// 每次进入可见期都先把偏移归零，避免影响窗口内其它时间逻辑。
// #48 起：豁免页「查询保留」断言以「各模式独立搜索词」为前提——脚本先开启
// 该设置（结束恢复原值）；默认共享语义（含闲置重置清空共享值）由
// scripts/cdp_mode_query_verify.mjs 覆盖。
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
const PORT = 9241;
mkdirSync("test", { recursive: true });
for (const id of ["state-probe", "hello-mode"]) {
  rmSync(`${BASE}/plugins/${id}`, { recursive: true, force: true });
  cpSync(`examples/plugins/${id}`, `${BASE}/plugins/${id}`, { recursive: true });
}
const logFd = openSync("test/idle_reset_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP unavailable");
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && p.has(msg.id)) { p.get(msg.id)(msg); p.delete(msg.id); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; p.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description ?? "eval failed"));
    return r?.result?.result?.value;
  };
  return { ws, evalJs };
}
async function findWindow(match, probe) {
  for (let i = 0; i < 40; i++) {
    const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes(match));
    for (const t of pages) {
      try {
        const c = await connect(t.webSocketDebuggerUrl);
        const ok = probe ? await probe(c) : true;
        if (ok) return { target: t, conn: c };
        c.ws.close();
      } catch {}
    }
    await sleep(400);
  }
  return null;
}
const findMain = () => findWindow("tauri.localhost", async (c) => {
  const ok = await c.evalJs(`!!document.getElementById("search-input")`);
  c.ws.close();
  return ok;
});

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : (extra ? " — " + extra : "")));
  ok ? pass++ : fail++;
};

let m = null, invoke = null;
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const escMain = () => m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"`);
const activePill = () => m.evalJs(`document.querySelector(".mode-switch-item.active")?.textContent?.trim() ?? ""`);
const searchVal = () => m.evalJs(`document.getElementById("search-input").value`);
const hostPresent = (mode) => m.evalJs(`!!document.querySelector('.mode-host[data-mode=${JSON.stringify(mode)}]')`);
const iframeProbe = (mode) => m.evalJs(`document.querySelector('.mode-host[data-mode=${JSON.stringify(mode)}] iframe')?.__keepProbe ?? null`);
const markIframe = (mode, v) => m.evalJs(`(() => { const f = document.querySelector('.mode-host[data-mode=${JSON.stringify(mode)}] iframe'); if (!f) return false; f.__keepProbe = ${v}; return true; })()`);
const setOffset = (ms) => m.evalJs(`window.__idleNowOff = ${ms}; "ok"`);
const clickPillAny = async (labels, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    const hit = await m.evalJs(`(() => {
      const want = ${JSON.stringify(labels)};
      const el = [...document.querySelectorAll(".mode-switch-item")].find((b) => want.some((w) => b.textContent.includes(w)));
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (hit) return true;
    await sleep(400);
  }
  return false;
};
const showLauncher = async () => {
  await invoke("toggle_launcher");
  await sleep(1500);
};
const lastTap = () => m.evalJs(`JSON.stringify((window.__idleReset ?? []).slice(-1)[0] ?? null)`);
const hideLauncher = async () => {
  await escMain();
  await sleep(1000);
};

// ── boot ──
const mainT = await findMain();
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
m = await connect(mainT.target.webSocketDebuggerUrl);
invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
for (const id of ["state-probe", "hello-mode"]) await invoke("set_plugin_enabled", { id, enabled: true });
await sleep(1200);
await showLauncher();

// Keep the dev settings file clean: snapshot the original values and restore.
const original = await invoke("get_settings");
let restoreNeeded = true;
async function restoreSettings() {
  if (!restoreNeeded) return;
  restoreNeeded = false;
  try {
    const s = await invoke("get_settings");
    s.appearance.idle_reset_enabled = original.appearance.idle_reset_enabled;
    s.appearance.idle_reset_minutes = original.appearance.idle_reset_minutes;
    s.plugins.keep_session_overrides = original.plugins.keep_session_overrides ?? {};
    await invoke("save_settings", { new: s });
  } catch (err) { console.log("restore settings failed:", String(err)); }
}
/** #48: put the user's per-mode-query choice back — the run needs it pinned
 * true until the very end (G re-enters an exempt page's query). */
async function restorePerModeQuery() {
  try {
    const s = await invoke("get_settings");
    s.appearance.per_mode_query = original.appearance.per_mode_query;
    await invoke("save_settings", { new: s });
  } catch (err) { console.log("restore per_mode_query failed:", String(err)); }
}

// #48: this script's contract is #46 under independent per-mode queries —
// pin it on for the run (restored above at the end).
{
  const s = await invoke("get_settings");
  s.appearance.per_mode_query = true;
  await invoke("save_settings", { new: s });
  await sleep(800);
}

// Install the simulated clock once (module scope resolves Date.now at call time).
await m.evalJs(`(() => {
  if (!window.__idleNowInstalled) {
    window.__idleNowOrig = Date.now.bind(Date);
    window.__idleNowOff = 0;
    Date.now = () => window.__idleNowOrig() + window.__idleNowOff;
    window.__idleNowInstalled = true;
  }
  return true;
})()`);

// Baseline: enter both modes, set queries + iframe identity probes.
check("baseline: enter State Probe via pill", await clickPillAny(["State Probe"]));
await sleep(2200);
check("baseline: State Probe host mounted", await hostPresent("state-probe"));
check("baseline: mark State Probe iframe", await markIframe("state-probe", 4242));
await type("idle-state");
await sleep(500);
check("baseline: State Probe query set", (await searchVal()) === "idle-state");

check("baseline: enter Hello Mode via pill", await clickPillAny(["Hello Mode"]));
await sleep(1500);
check("baseline: Hello Mode host mounted", await hostPresent("hello-mode"));
check("baseline: mark Hello Mode iframe", await markIframe("hello-mode", 5151));
await type("idle-hello");
await sleep(500);
check("baseline: Hello Mode query set", (await searchVal()) === "idle-hello");

// ═══ A. 阈值内不重置（10 分钟 < 30）═══
await setOffset(0);
await hideLauncher();
await setOffset(10 * 60_000);
await showLauncher();
check("A: still on Hello Mode", (await activePill()).includes("Hello Mode"));
check("A: query kept", (await searchVal()) === "idle-hello");
check("A: Hello Mode iframe not remounted", (await iframeProbe("hello-mode")) === 5151);

// ═══ B. 超阈值完整重置（31 分钟 > 30）═══
await setOffset(0);
await hideLauncher();
await setOffset(31 * 60_000);
await showLauncher();
const pillB = await activePill();
check("B: back on the home page", pillB.includes("导航") || pillB.includes("Navigate"), pillB);
check("B: home query cleared", (await searchVal()) === "");
check("B: non-exempt host unmounted", !(await hostPresent("hello-mode")));
check("B: exempt host kept mounted", await hostPresent("state-probe"));
check("B: exempt iframe not remounted", (await iframeProbe("state-probe")) === 4242);

// ═══ C. 重置后的重进语义 ═══
check("C: re-enter Hello Mode", await clickPillAny(["Hello Mode"]));
await sleep(1500);
check("C: non-exempt query stays empty", (await searchVal()) === "");
check("C: non-exempt iframe is fresh", (await iframeProbe("hello-mode")) === null);
check("C: mark fresh Hello Mode iframe", await markIframe("hello-mode", 5152));
check("C: switch to State Probe", await clickPillAny(["State Probe"]));
await sleep(1200);
check("C: exempt query restored", (await searchVal()) === "idle-state");
check("C: exempt iframe kept its identity", (await iframeProbe("state-probe")) === 4242);

// ═══ D. 用户覆盖 false：清单豁免被强制重置 ═══
await invoke("set_plugin_keep_session", { id: "state-probe", keep: false });
await sleep(500);
await type("override-off");
await sleep(400);
await setOffset(0);
await hideLauncher();
await setOffset(31 * 60_000);
await showLauncher();
check("D: back on the home page", (await activePill()).includes("导航") || (await activePill()).includes("Navigate"));
check("D: overridden host unmounted", !(await hostPresent("state-probe")));
check("D: re-enter State Probe", await clickPillAny(["State Probe"]));
await sleep(2200);
check("D: overridden query stays empty", (await searchVal()) === "");
check("D: overridden iframe is fresh", (await iframeProbe("state-probe")) === null);
check("D: mark fresh State Probe iframe", await markIframe("state-probe", 4243));

// ═══ E. 用户覆盖 true：未声明插件被保留 ═══
await invoke("set_plugin_keep_session", { id: "hello-mode", keep: true });
await sleep(500);
check("E: switch to Hello Mode", await clickPillAny(["Hello Mode"]));
await sleep(1400);
check("E: switch landed", (await activePill()).includes("Hello Mode"), await activePill());
await type("keep-hello");
await sleep(400);
check("E: mark Hello Mode iframe", await markIframe("hello-mode", 5153));
await setOffset(0);
await hideLauncher();
await setOffset(31 * 60_000);
await showLauncher();
const tapE = await lastTap();
check("E: reset kept hello-mode state", tapE.includes('"kept":["hello-mode"]'), tapE);
const pillE = await activePill();
check("E: reset still lands on the home page", pillE.includes("导航") || pillE.includes("Navigate"), pillE);
check("E: exempt host stays mounted", await hostPresent("hello-mode"));
const probeE = await iframeProbe("hello-mode");
check("E: exempt iframe kept its identity", probeE === 5153, String(probeE));
check("E: re-enter Hello Mode", await clickPillAny(["Hello Mode"]));
await sleep(1400);
const valE = await searchVal();
check("E: exempt query restored", valE === "keep-hello", valE);

// ═══ F. 总开关关闭：超阈值也不重置 ═══
{
  const s = await invoke("get_settings");
  s.appearance.idle_reset_enabled = false;
  await invoke("save_settings", { new: s });
  await sleep(600);
}
check("F: switch to State Probe", await clickPillAny(["State Probe"]));
await sleep(1200);
await type("disabled-hello");
await sleep(400);
await setOffset(0);
await hideLauncher();
await setOffset(31 * 60_000);
await showLauncher();
check("F: still on State Probe", (await activePill()).includes("State Probe"));
check("F: query kept while disabled", (await searchVal()) === "disabled-hello");

// ═══ G. 恢复默认设置：清单 keep_session 重新生效 ═══
await restoreSettings();
await sleep(600);
check("G: mark State Probe iframe", await markIframe("state-probe", 4244));
await setOffset(0);
await hideLauncher();
await setOffset(31 * 60_000);
await showLauncher();
const tapG = await lastTap();
check("G: manifest exemption kept state-probe", tapG.includes('"kept":["state-probe"]'), tapG);
const pillG = await activePill();
check("G: reset lands on the home page", pillG.includes("导航") || pillG.includes("Navigate"), pillG);
check("G: exempt host stays mounted", await hostPresent("state-probe"));
const probeG = await iframeProbe("state-probe");
check("G: exempt iframe kept its identity", probeG === 4244, String(probeG));
check("G: re-enter State Probe", await clickPillAny(["State Probe"]));
await sleep(1400);
const valG = await searchVal();
check("G: exempt query restored", valG === "disabled-hello", valG);

await restoreSettings();
await restorePerModeQuery();
console.log(`\nIDLE-RESET-VERIFY ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);