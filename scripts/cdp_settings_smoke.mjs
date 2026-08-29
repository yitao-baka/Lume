// Dev helper: settings re-layout smoke test (2026-08-30 grouped-card layout).
//  1. 7 nav sections render in the Flutter-aligned order
//  2. footer has 恢复默认设置 + 保存并应用 (disabled until dirty)
//  3. 恢复默认设置 is two-step: click → save button enables (nothing written)
//  4. search box filters nav + stacks matching sections
//  5. user index empty state + refresh-index button present
// Screenshots: test/settings_*.png
// Usage: node scripts/cdp_settings_smoke.mjs
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

const targets = await getTargets();
for (const t of targets) console.log("[target]", t.type, JSON.stringify(t.title), t.url);

// Identify the settings window by its body class (index.tsx adds
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

// 1. Nav sections
const nav = await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).map((b) => b.textContent.trim())`);
check("7 nav sections in order", JSON.stringify(nav) === JSON.stringify(["外观", "导航页", "剪贴板", "快捷键", "搜索", "系统", "关于"]), JSON.stringify(nav));

// 2. Footer buttons
const footer = await s.evalJs(`Array.from(document.querySelectorAll('.settings-footer .settings-action')).map((b) => ({ text: b.textContent.trim(), disabled: b.disabled }))`);
check("footer = 恢复默认设置 + 保存并应用(disabled)", footer.length === 2 && footer[0].text.includes("恢复默认") && footer[1].text.includes("保存并应用") && footer[1].disabled === true, JSON.stringify(footer));

// 3. Two-step restore default
await s.evalJs(`Array.from(document.querySelectorAll('.settings-footer .settings-action'))[0].click(); "ok"`);
await sleep(200);
const footer2 = await s.evalJs(`Array.from(document.querySelectorAll('.settings-footer .settings-action')).map((b) => b.disabled)`);
check("restore-default enables save (two-step)", footer2[1] === false, JSON.stringify(footer2));

// Grouped cards render in the appearance section
const cards = await s.evalJs(`document.querySelectorAll('.settings-group').length`);
const titles = await s.evalJs(`Array.from(document.querySelectorAll('.settings-grouptitle')).map((h) => h.textContent.trim())`);
check("appearance section renders cards + group titles", cards >= 1 && titles.length >= 1, JSON.stringify({ cards, titles }));

// 4. Search filter: 许可证 only matches 关于
await s.evalJs(`(() => { const inp = document.querySelector('.settings-search-input'); inp.value = "许可证"; inp.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(300);
const navFiltered = await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).map((b) => b.textContent.trim())`);
const sectionsStacked = await s.evalJs(`Array.from(document.querySelectorAll('.settings-section')).map((d) => d.dataset.section)`);
check("search 许可证 → only 关于 in nav", JSON.stringify(navFiltered) === JSON.stringify(["关于"]), JSON.stringify(navFiltered));
check("search stacks matching section", JSON.stringify(sectionsStacked) === JSON.stringify(["about"]), JSON.stringify(sectionsStacked));
await s.evalJs(`(() => { const inp = document.querySelector('.settings-search-input'); inp.value = ""; inp.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(200);

// Screenshot: appearance
let shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/settings_appearance.png", Buffer.from(shot.result.data, "base64"));

// 5. Switch to 搜索 section (user index + refresh)
await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).find((b) => b.textContent.includes("搜索"))?.click(); "ok"`);
await sleep(300);
const hasRefresh = await s.evalJs(`!!document.querySelector('.settings-title-row .settings-icon-btn')`);
const emptyState = await s.evalJs(`document.querySelector('.settings-empty')?.textContent ?? ""`);
check("搜索 section: refresh button + user-index empty state", hasRefresh === true && emptyState.includes("索引"), JSON.stringify({ hasRefresh, emptyState }));
shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/settings_search.png", Buffer.from(shot.result.data, "base64"));

// 6. 剪贴板 section (merge slider gated off, ignore editor, remember checks)
await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).find((b) => b.textContent.includes("剪贴板"))?.click(); "ok"`);
await sleep(300);
const clip = await s.evalJs(`({
  toggles: Array.from(document.querySelectorAll('.settings-toggle')).length,
  blocktitle: Array.from(document.querySelectorAll('.settings-blocktitle')).map((h) => h.textContent.trim()),
  rememberChecks: Array.from(document.querySelectorAll('.settings-sub-label')).some((l) => l.textContent === "记住勾选"),
  mergeSlider: !!document.querySelector('.settings-slider-input'),
})`);
check("剪贴板 section: blocktitles + remember-checks + no slider while merge off",
  clip.blocktitle.includes("忽略应用") && clip.rememberChecks === true && clip.mergeSlider === false, JSON.stringify(clip));
shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/settings_clipboard.png", Buffer.from(shot.result.data, "base64"));

// 7. 快捷键 + 系统 + 关于 screenshots via nav
for (const name of ["快捷键", "系统", "关于"]) {
  await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).find((b) => b.textContent.includes("${name}"))?.click(); "ok"`);
  await sleep(300);
  shot = await s.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`test/settings_${name}.png`, Buffer.from(shot.result.data, "base64"));
}
const hotkey = await s.evalJs(`({
  chips: Array.from(document.querySelectorAll('.settings-chip')).map((c) => c.textContent.trim()),
  rec: document.querySelector('.settings-hotkey-btn')?.textContent.trim(),
})`).catch(() => null);

console.log("[hotkey chips]", JSON.stringify(hotkey));
console.log(failures === 0 ? "[smoke] ALL PASS" : `[smoke] ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
