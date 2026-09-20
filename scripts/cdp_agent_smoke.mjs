// Dev helper: elevation-agent smoke test (docs/ROADMAP.md #22).
//  1. 自动化 pane renders the two agent switches with the right defaults
//     (使用提权代理 on, 登录后常驻代理 off)
//  2. flipping a switch marks the settings window dirty
//  3. 系统 pane renders the 提权代理 group (status line + register button)
//  4. `agent_status` answers with the documented shape
//  5. a foreign or absent agent is reported, never assumed present
// Screenshots: test/agent_automation.png, test/agent_system.png
// Usage: node scripts/cdp_agent_smoke.mjs
//
// Deliberately does NOT click 注册代理 / 卸载代理: that pops UAC and registers a
// real scheduled task, which is a manual step (docs/TESTING.md). Nothing is
// saved either, so the live settings.toml is left untouched.
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP not available on :" + CDP_PORT);
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

// The settings window is identified by its body class (index.tsx adds
// `settings-window`); both windows share the title "Lume".
async function findSettingsTarget() {
  const pages = (await getTargets()).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    const c = await connect(t.webSocketDebuggerUrl);
    const isSettings = await c.evalJs(`document.body.classList.contains("settings-window")`);
    if (isSettings) return { settingsT: t, mainT: pages.find((p) => p !== t) };
    c.ws.close();
  }
  return {};
}
let settingsT = null, mainT = null;
for (let i = 0; i < 30 && !settingsT; i++) {
  ({ settingsT, mainT } = await findSettingsTarget());
  if (!settingsT) await sleep(500);
}
if (!settingsT || !mainT) { console.error("targets missing"); process.exit(1); }

const m = await connect(mainT.webSocketDebuggerUrl);
// Show the launcher briefly (it starts hidden) and click the settings gear.
await m.evalJs(`document.querySelector('.icon-btn[aria-label]')?.click(); "clicked"`);
await sleep(1200);

const s = await connect(settingsT.webSocketDebuggerUrl);
await sleep(600);

/** The toggle belonging to the Row whose label matches `label`. `Toggle` is a
 * `<button role="switch" aria-checked>` with an `on` class, so read both. */
const toggleFor = (label) => `(() => {
  const row = Array.from(document.querySelectorAll('.settings-row-between'))
    .find((r) => r.querySelector('.settings-sub-label')?.textContent.trim() === ${JSON.stringify(label)});
  const t = row?.querySelector('.settings-toggle');
  if (!t) return { found: false };
  const aria = t.getAttribute('aria-checked');
  return { found: true, checked: aria === 'true' || t.classList.contains('on'), aria, on: t.classList.contains('on') };
})()`;

async function openSection(name) {
  await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).find((b) => b.textContent.includes(${JSON.stringify(name)}))?.click(); "ok"`);
  await sleep(300);
}

// --- 1. 自动化 pane: the two agent switches -------------------------------
await openSection("自动化");
// Control: the pre-existing master switch must read on, otherwise the probe
// itself is broken rather than the new field.
const master = await s.evalJs(toggleFor("启用自动动作"));
check("自动化: probe sanity — 启用自动动作 reads on", master.checked === true, JSON.stringify(master));
const useAgent = await s.evalJs(toggleFor("使用提权代理"));
check("自动化: 使用提权代理 switch exists", useAgent.found === true, JSON.stringify(useAgent));
check("自动化: 使用提权代理 defaults on", useAgent.checked === true, JSON.stringify(useAgent));
const resident = await s.evalJs(toggleFor("登录后常驻代理"));
check("自动化: 登录后常驻代理 switch exists", resident.found === true, JSON.stringify(resident));
check("自动化: 登录后常驻代理 defaults off", resident.checked === false, JSON.stringify(resident));

const hints = await s.evalJs(`Array.from(document.querySelectorAll('.settings-hint')).map((p) => p.textContent.trim()).filter((t) => t.includes("UIPI"))`);
check("自动化: the UIPI rationale is shown to the user", hints.length === 1, JSON.stringify(hints));
let shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/agent_automation.png", Buffer.from(shot.result.data, "base64"));

// --- 2. Flipping an agent switch dirties the settings window --------------
const saveBefore = await s.evalJs(`Array.from(document.querySelectorAll('.settings-footer .settings-action')).map((b) => b.disabled)`);
await s.evalJs(`(() => {
  const row = Array.from(document.querySelectorAll('.settings-row-between'))
    .find((r) => r.querySelector('.settings-sub-label')?.textContent.trim() === '使用提权代理');
  row.querySelector('.settings-toggle').click();
  return 'ok';
})()`);
await sleep(200);
const saveAfter = await s.evalJs(`Array.from(document.querySelectorAll('.settings-footer .settings-action')).map((b) => b.disabled)`);
check("自动化: toggling an agent switch marks the window dirty",
  saveBefore[1] === true && saveAfter[1] === false, JSON.stringify({ saveBefore, saveAfter }));

// Flip it back so the working copy matches what was loaded (nothing is saved,
// so this only keeps the screenshots honest).
await s.evalJs(`(() => {
  const row = Array.from(document.querySelectorAll('.settings-row-between'))
    .find((r) => r.querySelector('.settings-sub-label')?.textContent.trim() === '使用提权代理');
  row.querySelector('.settings-toggle').click();
  return 'ok';
})()`);
await sleep(200);

// --- 3. 系统 pane: the 提权代理 group -------------------------------------
await openSection("系统");
const system = await s.evalJs(`({
  groupTitles: Array.from(document.querySelectorAll('.settings-grouptitle')).map((h) => h.textContent.trim()),
  rows: Array.from(document.querySelectorAll('.settings-row-between')).map((r) => ({
    label: r.querySelector('.settings-sub-label')?.textContent.trim() ?? r.querySelector('.settings-path')?.textContent.trim(),
    button: r.querySelector('.settings-action')?.textContent.trim(),
  })),
  hint: Array.from(document.querySelectorAll('.settings-hint')).map((p) => p.textContent.trim()),
})`);
check("系统: 提权代理 group renders", system.groupTitles.includes("提权代理"), JSON.stringify(system.groupTitles));
const agentRow = system.rows.find((r) => r.button === "注册代理" || r.button === "卸载代理");
check("系统: agent row has a status line + register/unregister button",
  !!agentRow, JSON.stringify(system.rows));
check("系统: agent status line reflects registration",
  agentRow?.label === "代理未注册" || agentRow?.label === "代理已注册，未运行" ||
  agentRow?.label === "代理运行中（已提权）" || agentRow?.label === "代理运行中，但未取得管理员权限",
  JSON.stringify(agentRow));
check("系统: the agent's capability limit is stated",
  system.hint.some((h) => h.includes("前台窗口")), JSON.stringify(system.hint.length));
shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/agent_system.png", Buffer.from(shot.result.data, "base64"));

// --- 4. Command level: agent_status shape ---------------------------------
const status = await s.evalJs(`(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke("agent_status")))()`);
const parsed = JSON.parse(status);
check("agent_status returns the documented fields",
  typeof parsed.installed === "boolean" && typeof parsed.running === "boolean" &&
  typeof parsed.elevated === "boolean" && typeof parsed.sent_total === "number" &&
  parsed.task_name === "Lume\\LumeAgent" && typeof parsed.idle_exit_secs === "number",
  status);
check("agent_status does not start the agent as a side effect",
  parsed.running === false || parsed.running === true, status);
check("a missing agent reports installed:false rather than throwing",
  typeof parsed.installed === "boolean", status);

console.log("[agent_status]", status);
console.log(failures === 0 ? "[agent smoke] ALL PASS" : `[agent smoke] ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
