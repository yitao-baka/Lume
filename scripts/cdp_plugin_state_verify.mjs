// 会话续存 + 分离窗口状态 端到端验证（ROADMAP #40）。
//
// 夹具 examples/plugins/state-probe（可分离 + titlebar）：
//   视图帧：input#src / checkbox#flag / select[multiple]#multi /
//           contenteditable#note / readonly#jsn（custom 快照）/ readonly
//           #scrollmirror（滚动可见化）/ 事件探针 #evt / load 后 600ms 才插入
//           的 input#late（验证恢复只对「迟到 DOM」重试，不回滚既有状态）
//   标题栏帧：#tb（enter → payload + "-TB"，用于区分两帧状态）
//
// 覆盖：
//   A 会话续存  hide→呼出 页面/查询/页面状态不变；模式切走再回来 iframe 不重建
//   B detach    view 帧快照（键控 auto + custom + 迟到 DOM 重试）进入窗口
//   C 分离中 enter  payload 扇出到窗口的 view + titlebar 两帧
//   D 关闭回流  user close → 启动器回到该页并恢复状态；query 写回
//   E 再分离    titlebar 帧（上次关闭时存的）进入新窗口
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
const PORT = 9233;
mkdirSync("test", { recursive: true });
rmSync(`${BASE}/plugins/state-probe`, { recursive: true, force: true });
cpSync(`examples/plugins/state-probe`, `${BASE}/plugins/state-probe`, { recursive: true });
const logFd = openSync("test/plugin_state_lume.log", "w");
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
const pluginGone = async () => {
  for (let i = 0; i < 20; i++) {
    const gone = ((await getTargets()) ?? []).every((t) => !(t.type === "page" && t.url.includes("plugin.html?plugin=state-probe")));
    if (gone) return true;
    await sleep(400);
  }
  return false;
};

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : (extra ? " — " + extra : "")));
  ok ? pass++ : fail++;
};

// ── helpers against the launcher ──
let m = null;
let invoke = null;
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const clickPillAny = async (labels) => {
  for (let i = 0; i < 20; i++) {
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
const clickRow = async (label) => {
  for (let i = 0; i < 15; i++) {
    const hit = await m.evalJs(`(() => {
      const el = [...document.querySelectorAll(".result-box")].find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!el) return false;
      el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      return true;
    })()`);
    if (hit) { await sleep(150); await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))`); return true; }
    await sleep(400);
  }
  return false;
};
const escMain = () => m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"`);

// Latest reported value of a field inside a frame (name "" = view frames).
const readField = (conn, frame, id) => conn.evalJs(`(() => {
  const st = (window.__frameStates || []).filter((s) => s.name === ${JSON.stringify(frame)});
  for (let i = st.length - 1; i >= 0; i--) {
    const v = (st[i].values || []).find((x) => x.id === ${JSON.stringify(id)});
    if (v) return { value: v.value, checked: v.checked, reason: st[i].reason };
  }
  return null;
})()`);
// The bridge's diagnostic frame state (`__frameStates`) also carries the
// hosting form — `lume.env.form`, ROADMAP #42. Read it off the latest state
// that reported a known field id (identifies the frame without CDP).
const readFrameForm = (conn, id) => conn.evalJs(`(() => {
  const st = (window.__frameStates || []).filter((s) => (s.values || []).some((x) => x.id === ${JSON.stringify(id)}));
  return st.length ? (st[st.length - 1].form ?? null) : null;
})()`);
const expectField = async (conn, frame, id, want, tries = 24) => {
  for (let i = 0; i < tries; i++) {
    const v = await readField(conn, frame, id);
    if (v && String(v.value) === String(want)) return v;
    await sleep(350);
  }
  return null;
};
const fieldEquals = async (conn, frame, id, want, tries = 6) => {
  const v = await expectField(conn, frame, id, want, tries);
  return { ok: !!v, got: v ? v.value : null };
};

// ── boot ──
const mainT = await findMain();
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
// findMain's probe closes its socket — reconnect for real use (pattern from
// the other CDP scripts; using the probe connection would hang every eval).
m = await connect(mainT.target.webSocketDebuggerUrl);
invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
await invoke("set_plugin_enabled", { id: "state-probe", enabled: true });
await sleep(1500);
await invoke("toggle_launcher");
await sleep(1500);

// ═══ A. 会话续存 ═══
check("A: enter state-probe via pill", await clickPillAny(["State Probe"]));
await sleep(2500);
check("A: view frame is live", !!(await readField(m, "", "src")), "no #src report yet");
const formA = await readFrameForm(m, "src");
check("A: view frame reports lume.env.form = launcher", formA === "launcher", String(formA));

await type("src:hello-A"); await sleep(400);
await type("js:7"); await sleep(400);
await type("flag:on"); await sleep(400);
await type("multi:a,c"); await sleep(400);
await type("note:NOTE-A"); await sleep(400);
await type("scroll:200"); await sleep(400);
await type("late:late-A"); await sleep(600);
for (const [id, want] of [["src", "hello-A"], ["jsn", "7"], ["multi", "a,c"], ["note", "NOTE-A"], ["scrollmirror", "200"], ["late", "late-A"]]) {
  const r = await fieldEquals(m, "", id, want, 8);
  check(`A: drove #${id} = ${want}`, r.ok, String(r.got));
}
const flagState = await readField(m, "", "flag");
check("A: drove #flag checked", !!flagState && flagState.checked === true, JSON.stringify(flagState));

// keep-alive identity probe: a JS property on the iframe element must survive
// hide/show and a mode-switch roundtrip (a remount would recreate the element).
check("A: mark view iframe element", await m.evalJs(`(() => {
  const f = document.querySelector('.mode-host[data-mode="state-probe"] iframe');
  if (!f) return false;
  f.__keepProbe = 777;
  return true;
})()`));

// hide → summon: everything must survive
await escMain();
await sleep(900);
await invoke("toggle_launcher");
await sleep(1300);
check("A: re-summon focused the launcher", await m.evalJs(`document.hasFocus() === true`));
const activePill = await m.evalJs(`document.querySelector(".mode-switch-item.active")?.textContent?.trim() ?? ""`);
check("A: still on State Probe after re-summon", activePill.includes("State Probe"), activePill);
const boxVal = await m.evalJs(`document.getElementById("search-input").value`);
check("A: search box kept the query", boxVal === "late:late-A", boxVal);
check("A: view iframe was NOT remounted", (await m.evalJs(`document.querySelector('.mode-host[data-mode="state-probe"] iframe')?.__keepProbe`)) === 777);
for (const [id, want] of [["src", "hello-A"], ["jsn", "7"], ["late", "late-A"], ["note", "NOTE-A"], ["scrollmirror", "200"]]) {
  const r = await fieldEquals(m, "", id, want, 6);
  check(`A: #${id} survived hide/show`, r.ok, String(r.got));
}

// switch away (clipboard) and back — the kept-alive page must not reload
check("A: switch to clipboard", await clickPillAny(["剪贴板", "Clipboard"]));
await sleep(900);
check("A: switch back to State Probe", await clickPillAny(["State Probe"]));
await sleep(900);
check("A: view iframe survived a mode switch", (await m.evalJs(`document.querySelector('.mode-host[data-mode="state-probe"] iframe')?.__keepProbe`)) === 777);
const backSrc = await fieldEquals(m, "", "src", "hello-A", 6);
check("A: #src survived a mode switch", backSrc.ok, String(backSrc.got));

// ═══ B. detach：view 帧快照进入窗口（auto 键控 + custom + 迟到 DOM 重试）═══
await m.evalJs(`document.querySelector(".detach-btn")?.click()`);
const pwB = await findWindow("plugin.html?plugin=state-probe");
check("B: detached window opened", !!pwB);
if (!pwB) { console.log(`\nSTATE-VERIFY FAILED (${pass}/${pass + fail})`); process.exit(1); }
const wB = pwB.conn;
const envB = await wB.evalJs(`(() => {
  const st = (window.__pluginStates ?? []).filter((s) => s.snapshot && s.snapshot.v === 2 && s.snapshot.frames);
  const last = st[st.length - 1];
  return last ? Object.keys(last.snapshot.frames) : null;
})()`);
check("B: ready push carried a v2 snapshot (view frame)", Array.isArray(envB) && envB.includes("view"), JSON.stringify(envB));
for (const [id, want] of [["src", "hello-A"], ["jsn", "7"], ["multi", "a,c"], ["note", "NOTE-A"], ["scrollmirror", "200"], ["late", "late-A"]]) {
  const r = await fieldEquals(wB, "", id, want, 20);
  check(`B: window inherited #${id}`, r.ok, String(r.got));
}
const flagB = await expectField(wB, "", "flag", "on", 8);
check("B: window inherited #flag checked", !!flagB && flagB.checked === true, JSON.stringify(flagB));
const formBView = await readFrameForm(wB, "src");
check("B: window view frame reports form = window", formBView === "window", String(formBView));
const formBTb = await readFrameForm(wB, "tb");
check("B: window titlebar frame reports form = window", formBTb === "window", String(formBTb));

// ═══ C. 分离中 enter：payload 进窗口的 view + titlebar 两帧 ═══
await invoke("toggle_launcher");
await sleep(900);
await type("sp:window-B");
await sleep(900);
check("C: feature row visible", await clickRow("State Probe：注入"));
await sleep(1500);
const srcC = await fieldEquals(wB, "", "src", "sp:window-B", 10);
check("C: enter payload reached the window view", srcC.ok, String(srcC.got));
const tbC = await fieldEquals(wB, "titlebar", "tb", "sp:window-B-TB", 10);
check("C: enter payload reached the window titlebar", tbC.ok, String(tbC.got));

// ═══ D. 关闭回流：启动器回到该页并恢复状态 ═══
await wB.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"`);
check("D: detached window destroyed", await pluginGone());
await sleep(1500);
const closedD = await m.evalJs(`JSON.stringify((window.__pwClosed ?? []).slice(-1)[0] ?? null)`);
check("D: close report marked user + snapshot", closedD.includes('"user":true') && closedD.includes('"hasSnapshot":true'), closedD);
const activePillD = await m.evalJs(`document.querySelector(".mode-switch-item.active")?.textContent?.trim() ?? ""`);
check("D: launcher re-docked to State Probe", activePillD.includes("State Probe"), activePillD);
const boxD = await m.evalJs(`document.getElementById("search-input").value`);
check("D: query came back to the launcher", boxD === "late:late-A", boxD);
for (const [id, want] of [["src", "sp:window-B"], ["jsn", "7"], ["late", "late-A"], ["note", "NOTE-A"], ["multi", "a,c"], ["scrollmirror", "200"]]) {
  const r = await fieldEquals(m, "", id, want, 20);
  check(`D: launcher restored #${id}`, r.ok, String(r.got));
}
const flagD = await expectField(m, "", "flag", "on", 8);
check("D: launcher restored #flag checked", !!flagD && flagD.checked === true, JSON.stringify(flagD));
const formD = await readFrameForm(m, "src");
check("D: re-docked frame reports form = launcher", formD === "launcher", String(formD));

// ═══ E. 再分离：titlebar 帧（关闭时存的）进入新窗口 ═══
await m.evalJs(`document.querySelector(".detach-btn")?.click()`);
const pwE = await findWindow("plugin.html?plugin=state-probe");
check("E: detached window re-opened", !!pwE);
if (pwE) {
  const wE = pwE.conn;
  const envE = await wE.evalJs(`(() => {
    const st = (window.__pluginStates ?? []).filter((s) => s.snapshot && s.snapshot.v === 2 && s.snapshot.frames);
    const last = st[st.length - 1];
    return last ? Object.keys(last.snapshot.frames) : null;
  })()`);
  check("E: re-detach push carried view + titlebar frames", Array.isArray(envE) && envE.includes("view") && envE.includes("titlebar"), JSON.stringify(envE));
  const tbE = await fieldEquals(wE, "titlebar", "tb", "sp:window-B-TB", 16);
  check("E: titlebar frame restored in the new window", tbE.ok, String(tbE.got));
  const srcE = await fieldEquals(wE, "", "src", "sp:window-B", 16);
  check("E: view frame restored in the new window", srcE.ok, String(srcE.got));
  await wE.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"`);
}

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
console.log(`\nSTATE-VERIFY ${pass}/${pass + fail}`);
console.log(fail === 0 ? "STATE-VERIFY-ALL-PASS" : `STATE-VERIFY-FAILURES=${fail}`);
process.exit(fail === 0 ? 0 : 1);