// 搜索框跨模式共享（docs/ROADMAP_HISTORY.md #48）端到端验证。
//
// 覆盖：
//   A 默认（per_mode_query=false）：导航页输入后切剪贴板仍显示同一内容，
//     目标页 mirror/搜索都以该共享值为准（__queryRoute tap + DOM）
//   B 真实设置面板开启「各模式使用独立搜索词」→ 保存并应用（落盘 + 实时）；
//     开启瞬间把当前共享文字播种给各页面，之后各模式各自记忆
//   C 运行中关回共享：以当前活动页文字为共享值，并传播到其它模式；
//     再开启时再次播种
//   D 闲置重置清空共享值（Date.now 偏移模拟 hide → +31min → show）
//   E 重启：per_mode_query 经 __LUME_CONFIG__ 注入首帧；搜索词不落盘（重启为空）
//
// 运行：node scripts/cdp_mode_query_verify.mjs
//       （先 pnpm run tauri build --debug --no-bundle，脚本自己拉起已构建 exe）
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, openSync, writeFileSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
const PORT = 9246;
mkdirSync("test", { recursive: true });

// ── fixture：带 keyword 的纯 view mode —— 验证「行进入消耗共享词」 ──
const FIX = "test/mode_query_fixture/q48-mode";
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
writeFileSync(`${FIX}/plugin.toml`, `id = "q48-mode"
name = "Q48 Mode"
version = "1.0.0"
kind = "mode"
description = "CDP fixture: keyword row entry consumes the shared query"
view = "view.html"
height = 360
keywords = ["q48kw"]
`);
writeFileSync(
  `${FIX}/view.html`,
  `<!doctype html><html><body><div id="q48-view" style="font:14px sans-serif;color:#888">Q48 Mode</div></body></html>`
);
mkdirSync(`${BASE}/plugins`, { recursive: true });
rmSync(`${BASE}/plugins/q48-mode`, { recursive: true, force: true });
cpSync(FIX, `${BASE}/plugins/q48-mode`, { recursive: true });

function startApp(logName) {
  const logFd = openSync(logName, "w");
  spawn(`${BASE}/lume.exe`, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: ["ignore", logFd, logFd],
  });
}
startApp("test/mode_query_lume.log");

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
async function findMain() {
  for (let i = 0; i < 40; i++) {
    const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    for (const t of pages) {
      try {
        const c = await connect(t.webSocketDebuggerUrl);
        const ok = await c.evalJs(`!!document.getElementById("search-input")`);
        if (ok) return c;
        c.ws.close();
      } catch {}
    }
    await sleep(400);
  }
  return null;
}
async function findSettings() {
  for (let i = 0; i < 30; i++) {
    const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
    for (const t of pages) {
      try {
        const c = await connect(t.webSocketDebuggerUrl);
        const ok = await c.evalJs(`document.body.classList.contains("settings-window")`);
        if (ok) return c;
        c.ws.close();
      } catch {}
    }
    await sleep(400);
  }
  return null;
}

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : (extra ? " - " + extra : "")));
  ok ? pass++ : fail++;
};

let m = await findMain();
if (!m) { console.error("launcher window missing"); process.exit(1); }
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const searchVal = () => m.evalJs(`document.getElementById("search-input").value`);
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const escMain = () => m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"`);
const activePill = () => m.evalJs(`document.querySelector(".mode-switch-item.active")?.textContent?.trim() ?? ""`);
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
const tapLen = () => m.evalJs(`(window.__queryRoute ?? []).length`);
const routesSince = async (n) => JSON.parse(await m.evalJs(`JSON.stringify((window.__queryRoute ?? []).slice(${n}))`));
const clipState = () => m.evalJs(`(() => {
  const host = document.querySelector('.mode-host[data-mode="clipboard"]');
  if (!host || !host.classList.contains("active")) return null;
  const empty = document.querySelector(".clip-empty");
  const hint = document.querySelector(".clip-empty-hint");
  const title = document.querySelector(".clip-empty-title");
  return {
    empty: !!empty,
    hint: !!hint,
    title: title ? title.textContent.trim() : null,
    rows: document.querySelectorAll(".clip-row").length,
  };
})()`);
const setFlag = async (v) => {
  const s = await invoke("get_settings");
  s.appearance.per_mode_query = v;
  await invoke("save_settings", { new: s });
  await sleep(900);
};
const setOffset = (ms) => m.evalJs(`window.__q48NowOff = ${ms}; "ok"`);
const installClock = () => m.evalJs(`(() => {
  if (!window.__q48NowInstalled) {
    window.__q48NowOrig = Date.now.bind(Date);
    window.__q48NowOff = 0;
    Date.now = () => window.__q48NowOrig() + window.__q48NowOff;
    window.__q48NowInstalled = true;
  }
  return true;
})()`);

const NAV = ["导航", "導航", "Navigate"];
const CLIP = ["剪贴板", "剪貼簿", "Clipboard"];
const NO_RESULTS = ["No results", "无结果", "無結果"];

// Snapshot the settings we touch; restore at the end.
const original = await invoke("get_settings");
const originalFlag = !!original.appearance.per_mode_query;
const originalIdleEnabled = original.appearance.idle_reset_enabled;
const originalIdleMinutes = original.appearance.idle_reset_minutes;
let restoreNeeded = true;
async function restore() {
  if (!restoreNeeded) return;
  restoreNeeded = false;
  try {
    const s = await invoke("get_settings");
    s.appearance.per_mode_query = originalFlag;
    s.appearance.idle_reset_enabled = originalIdleEnabled;
    s.appearance.idle_reset_minutes = originalIdleMinutes;
    await invoke("save_settings", { new: s });
  } catch (e) { console.log("restore settings failed:", String(e)); }
  try { await invoke("set_plugin_enabled", { id: "q48-mode", enabled: false }); } catch {}
  try { rmSync(`${BASE}/plugins/q48-mode`, { recursive: true, force: true }); } catch {}
  try { rmSync(FIX, { recursive: true, force: true }); } catch {}
}

try {
  // Deterministic baseline: sharing on (default), idle reset on + 30min.
  const base = await invoke("get_settings");
  base.appearance.per_mode_query = false;
  base.appearance.idle_reset_enabled = true;
  base.appearance.idle_reset_minutes = 30;
  await invoke("save_settings", { new: base });
  await sleep(900);
  await invoke("set_plugin_enabled", { id: "q48-mode", enabled: true });
  await sleep(1300);
  await invoke("toggle_launcher");
  await sleep(1500);

  // ═══ A. 默认共享 ═══
  check("A0 进入导航页", await clickPillAny(NAV));
  await sleep(900);
  await type("q48share");
  await sleep(700);
  check("A1 导航页输入后输入框为 q48share", (await searchVal()) === "q48share");
  {
    const t = await routesSince(0);
    const set = [...t].reverse().find((r) => r.ev === "set" && r.q === "q48share");
    check("A2 路由 tap 记录 set（perMode=false）", !!set && set.perMode === false, JSON.stringify(set));
  }

  const aSwitchAt = await tapLen();
  check("A3 切到剪贴板", await clickPillAny(CLIP));
  await sleep(1400);
  check("A4 剪贴板输入框仍为 q48share", (await searchVal()) === "q48share", await searchVal());
  {
    const t = await routesSince(aSwitchAt);
    const sw = t.find((r) => r.ev === "switch" && r.to === "clipboard" && r.q === "q48share");
    check("A5 switch tap：共享值交给剪贴板且 mirror 已写入", !!sw && sw.mirror === "q48share", JSON.stringify(sw));
    const se = t.find((r) => r.ev === "search" && r.mode === "clipboard" && r.q === "q48share");
    check("A6 剪贴板按共享值执行搜索", !!se, JSON.stringify(t.filter((r) => r.ev === "search")));
  }
  {
    const cs = await clipState();
    const filtered = !!cs && cs.rows === 0 && (!cs.empty || NO_RESULTS.some((x) => (cs.title ?? "").includes(x)));
    check("A7 剪贴板页按共享词过滤（无匹配=0 行 / 无结果态）", filtered, JSON.stringify(cs));
  }

  const aBackAt = await tapLen();
  check("A8 切回导航页", await clickPillAny(NAV));
  await sleep(1200);
  check("A9 导航页输入框仍为 q48share", (await searchVal()) === "q48share", await searchVal());
  {
    const t = await routesSince(aBackAt);
    check("A10 切回时按共享值重新搜索导航页", t.some((r) => r.ev === "switch" && r.to === "apps" && r.q === "q48share") && t.some((r) => r.ev === "search" && r.mode === "apps" && r.q === "q48share"));
  }

  // ═══ B. 真实设置面板开启独立模式 ═══
  await m.evalJs(`document.querySelector(".icon-btn[aria-label]")?.click(); "clicked"`);
  const s = await findSettings();
  check("B1 设置窗口打开", !!s);
  if (s) {
    await s.evalJs(`(() => {
      const names = ["导航页", "導航頁", "Navigation"];
      const b = [...document.querySelectorAll(".settings-nav")].find((x) => names.some((n) => x.textContent.includes(n)));
      b?.click();
      return !!b;
    })()`);
    await sleep(500);
  }
  const rowLabels = ["各模式使用独立搜索词", "各模式使用獨立搜尋詞", "Independent search text per mode"];
  const rowSel = `(() => {
    const labels = ${JSON.stringify(rowLabels)};
    return [...document.querySelectorAll(".settings-row-between")].find((r) => labels.some((l) => r.textContent.includes(l))) ?? null;
  })()`;
  const rowBefore = s ? await s.evalJs(`(() => { const r = ${rowSel}; return r ? { label: r.textContent.trim(), checked: r.querySelector(".settings-toggle")?.getAttribute("aria-checked") } : null; })()`) : null;
  check("B2 导航页有此开关且当前为关（默认共享）", !!rowBefore && rowBefore.checked === "false", JSON.stringify(rowBefore));
  if (s && rowBefore) {
    await s.evalJs(`(() => { const r = ${rowSel}; r?.querySelector(".settings-toggle")?.click(); return "ok"; })()`);
    await sleep(300);
    await s.evalJs(`Array.from(document.querySelectorAll(".settings-footer .settings-action"))[1]?.click(); "ok"`);
    await sleep(1300);
  }
  check("B3 开关已落盘为开", (await invoke("get_settings")).appearance.per_mode_query === true);
  check("B4 开启后当前输入框文字不变（off→on 保持画面稳定）", (await searchVal()) === "q48share", await searchVal());

  check("B5 切到剪贴板（播种起点 = 共享文字）", await clickPillAny(CLIP));
  await sleep(1300);
  check("B6 剪贴板播种后为 q48share", (await searchVal()) === "q48share", await searchVal());
  await type("q48clip");
  await sleep(600);
  check("B7 剪贴板输入 q48clip", (await searchVal()) === "q48clip");
  check("B8 切回导航页（独立记忆：仍是 q48share）", await clickPillAny(NAV));
  await sleep(1200);
  check("B9 导航页 q48share 未被剪贴板覆盖", (await searchVal()) === "q48share", await searchVal());
  check("B10 切回剪贴板（独立记忆：q48clip）", await clickPillAny(CLIP));
  await sleep(1200);
  check("B11 剪贴板 q48clip 未被覆盖", (await searchVal()) === "q48clip", await searchVal());
  {
    const t = await routesSince(0);
    const indep = [...t].reverse().find((r) => r.ev === "set" && r.q === "q48clip");
    check("B12 独立模式下 set tap 记录 perMode=true", !!indep && indep.perMode === true, JSON.stringify(indep));
  }

  // ═══ C. 运行中关回共享（以当前活动页为准）→ 再开启（播种） ═══
  await setFlag(false);
  check("C1 关回共享：当前活动页文字不变（q48clip）", (await searchVal()) === "q48clip", await searchVal());
  check("C2 切到导航页（共享已传播：q48clip）", await clickPillAny(NAV));
  await sleep(1200);
  check("C3 导航页显示共享值 q48clip", (await searchVal()) === "q48clip", await searchVal());
  await setFlag(true);
  await type("q48nav2");
  await sleep(600);
  check("C4 再开启独立后导航页可输入 q48nav2", (await searchVal()) === "q48nav2");
  check("C5 切回剪贴板（各自独立：仍是 q48clip）", await clickPillAny(CLIP));
  await sleep(1200);
  check("C6 剪贴板保留 q48clip", (await searchVal()) === "q48clip", await searchVal());

  // ═══ D. 闲置重置清空共享值 ═══
  await setFlag(false);
  check("D0 回到共享模式并切到导航页", await clickPillAny(NAV));
  await sleep(1000);
  await installClock();
  await type("q48idle");
  await sleep(500);
  check("D1 共享值设为 q48idle", (await searchVal()) === "q48idle");
  await setOffset(0);
  await escMain();
  await sleep(1200);
  await setOffset(31 * 60_000);
  await invoke("toggle_launcher");
  await sleep(2000);
  await setOffset(0);
  check("D2 闲置重置后输入框清空", (await searchVal()) === "", await searchVal());
  check("D3 切到剪贴板仍为空（共享值被重置）", await clickPillAny(CLIP));
  await sleep(1200);
  check("D4 剪贴板输入框为空", (await searchVal()) === "", await searchVal());

  // ═══ F. 行进入（keyword 行）消耗共享词 ═══
  check("F0 回到导航页", await clickPillAny(NAV));
  await sleep(1000);
  await type("q48kw");
  await sleep(900);
  check("F1 keyword 行出现（进入 Q48 Mode）",
    await m.evalJs(`[...document.querySelectorAll(".result-box-name")].some((n) => n.textContent.includes("Q48 Mode"))`));
  check("F2 点击前行仍是共享词 q48kw", (await searchVal()) === "q48kw", await searchVal());
  const consumeAt = await tapLen();
  check("F3 点击 keyword 行", await m.evalJs(`(() => {
    const b = [...document.querySelectorAll(".result-box")].find((x) => (x.querySelector(".result-box-name")?.textContent ?? "").includes("Q48 Mode"));
    if (!b) return false;
    b.click();
    return true;
  })()`));
  await sleep(1800);
  check("F4 目标模式已激活", (await activePill()).includes("Q48 Mode"), await activePill());
  check("F5 输入框清空（行进入消耗共享值）", (await searchVal()) === "", await searchVal());
  {
    const t = await routesSince(consumeAt);
    check("F6 tap 记录 consume", t.some((r) => r.ev === "consume"), JSON.stringify(t.map((r) => r.ev)));
  }
  check("F7 切回导航页", await clickPillAny(NAV));
  await sleep(1000);
  check("F8 导航页输入框仍为空（值已被消耗）", (await searchVal()) === "", await searchVal());

  // ═══ E. 重启：注入 + 搜索词不落盘 ═══
  await setFlag(true);
  await type("q48boot");
  await sleep(500);
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
  await sleep(1200);
  startApp("test/mode_query_lume_restart.log");
  m = await findMain();
  check("E0 重启后主窗口回来了", !!m);
  if (m) {
    await invoke("toggle_launcher");
    await sleep(1600);
    check("E1 重启后搜索词不落盘（输入框为空）", (await searchVal()) === "", await searchVal());
    const injected = await m.evalJs(`window.__LUME_CONFIG__?.appearance?.per_mode_query`);
    check("E2 重启首帧注入 per_mode_query=true", injected === true, String(injected));
    check("E3 重启后 get_settings 仍为 true", (await invoke("get_settings")).appearance.per_mode_query === true);
  }
} catch (err) {
  console.error("unhandled:", err);
  fail++;
}

await restore();
console.log(`\nMODE-QUERY-VERIFY ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);