// Dev helper: 插件页重设计验收 — cards, toolbar, detail panel, filters.
// Usage: node scripts/cdp_plugins_pane_verify.mjs
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CDP_PORT = 9222;
const APP = "src-tauri/target/debug/lume.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(500);
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
  const shot = async (file) => {
    const s = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(file, Buffer.from(s.result.data, "base64"));
  };
  return { ws, send, evalJs, shot };
}

const targets = await getTargets();
async function findTargets() {
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
  ({ settingsT, mainT } = await findTargets());
  if (!settingsT) await sleep(500);
}
if (!settingsT || !mainT) { console.error("targets missing"); process.exit(1); }

const m = await connect(mainT.webSocketDebuggerUrl);
await m.evalJs(`document.querySelector('.icon-btn[aria-label]')?.click(); "clicked"`);
await sleep(1200);
const s = await connect(settingsT.webSocketDebuggerUrl);
await sleep(600);

// Switch to the 插件 section
await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).find((b) => b.textContent.includes("插件"))?.click(); "ok"`);
await sleep(600);

const toolbar = await s.evalJs(`({
  summary: document.querySelector('.plg-summary')?.textContent ?? "",
  chips: Array.from(document.querySelectorAll('.plg-filter-chip')).map((b) => b.textContent.trim()),
  filterInput: !!document.querySelector('.plg-filter-input'),
})`);
check("toolbar: summary + 4 filter chips + filter input",
  toolbar.summary.includes("插件") && toolbar.chips.length === 4 && toolbar.filterInput, JSON.stringify(toolbar));

const cards = await s.evalJs(`Array.from(document.querySelectorAll('.plg-card')).map((c) => ({
  name: c.querySelector('.plg-name')?.textContent,
  desc: !!c.querySelector('.plg-desc'),
  sub: c.querySelector('.plg-sub')?.textContent,
  toggle: !!c.querySelector('.settings-toggle'),
  off: c.classList.contains('off'),
}))`);
check("cards render with name + sub line", cards.length >= 5 && cards.every((c) => c.name && c.sub), JSON.stringify(cards.length) + " cards");

// Expand the first disk plugin card → detail panel
await s.evalJs(`(() => {
  const card = Array.from(document.querySelectorAll('.plg-card')).find((c) => c.querySelector('.plg-badge')?.textContent === "磁盘");
  card?.querySelector('.plg-head')?.click();
  return card?.querySelector('.plg-name')?.textContent ?? "";
})()`);
await sleep(800);
const detail = await s.evalJs(`({
  open: !!document.querySelector('.plg-card.open .plg-detail'),
  name: document.querySelector('.plg-card.open .plg-name')?.textContent ?? "",
  sections: Array.from(document.querySelectorAll('.plg-card.open .plg-dsec .plg-dlabel, .plg-card.open .plg-dsec .plg-dsec')).map((n) => n.textContent?.trim()).filter(Boolean),
  permChips: Array.from(document.querySelectorAll('.plg-card.open .plg-perm-chip')).map((c) => c.textContent.trim()),
  trust: !!document.querySelector('.plg-card.open .plg-trust'),
  meta: Array.from(document.querySelectorAll('.plg-card.open .plg-kv')).map((n) => n.textContent.trim()),
})`);
check("detail panel opens with permissions + trust + meta",
  detail.open && detail.permChips.length > 0 && detail.trust && detail.meta.length >= 1, JSON.stringify(detail));
await s.shot("test/plg_dark_list.png");

// Keyword filter narrows the list
await s.evalJs(`(() => { const i = document.querySelector('.plg-filter-input'); i.value = "hello"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(300);
const filtered = await s.evalJs(`Array.from(document.querySelectorAll('.plg-card .plg-name')).map((n) => n.textContent)`);
check("filter input narrows to hello-mode", JSON.stringify(filtered) === JSON.stringify(["Hello Mode"]), JSON.stringify(filtered));
await s.evalJs(`(() => { const i = document.querySelector('.plg-filter-input'); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(300);

// Filter chip: 已停用
await s.evalJs(`Array.from(document.querySelectorAll('.plg-filter-chip')).find((b) => b.textContent === "已停用")?.click(); "ok"`);
await sleep(300);
const disabledCards = await s.evalJs(`({
  cards: Array.from(document.querySelectorAll('.plg-card')).map((c) => ({ name: c.querySelector('.plg-name')?.textContent, off: c.classList.contains('off') })),
  empty: document.querySelector('.plg-empty')?.textContent ?? "",
})`);
check("已停用 filter: only disabled cards, or the empty state", disabledCards.cards.every((c) => c.off) && (disabledCards.cards.length >= 1 || disabledCards.empty.includes("没有匹配")), JSON.stringify(disabledCards));
await s.evalJs(`Array.from(document.querySelectorAll('.plg-filter-chip')).find((b) => b.textContent === "全部")?.click(); "ok"`);
await sleep(300);

// Expand a plugin with declared settings (notes) → setting rows + default hint
await s.evalJs(`(() => {
  const cards = Array.from(document.querySelectorAll('.plg-card'));
  // open the notes plugin card by name
  const target = cards.find((c) => (c.querySelector('.plg-name')?.textContent ?? "").toLowerCase().includes("notes"));
  (target ?? cards[1])?.querySelector('.plg-head')?.click();
  return "ok";
})()`);
await sleep(900);
const settingsRows = await s.evalJs(`Array.from(document.querySelectorAll('.plg-card.open .plg-setting .settings-sub-label')).map((n) => n.textContent)`);
check("declared settings render", settingsRows.length > 0, JSON.stringify(settingsRows));

// Light theme screenshot (live preview only — never saved)
await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).find((b) => b.textContent.includes("外观"))?.click(); "ok"`);
await sleep(300);
await s.evalJs(`(() => {
  const chips = Array.from(document.querySelectorAll('.settings-chip'));
  chips.find((c) => c.textContent.trim() === "浅色")?.click();
  return "ok";
})()`);
await sleep(400);
await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).find((b) => b.textContent.includes("插件"))?.click(); "ok"`);
await sleep(500);
await s.evalJs(`(() => {
  const card = Array.from(document.querySelectorAll('.plg-card')).find((c) => c.querySelector('.plg-badge')?.textContent === "磁盘");
  card?.querySelector('.plg-head')?.click();
  return "ok";
})()`);
await sleep(700);
await s.shot("test/plg_light_detail.png");

console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
