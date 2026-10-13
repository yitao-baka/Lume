// 模式切换栏隐藏 + 导航结果行图标默认（ROADMAP #37）。
//
//   ① manifest `hidden = true` 的 mode（examples/plugins/hidden-mode，纯 view）：
//      get_plugins 上报 hidden、切换栏没有它的 pill；
//   ② 入口 = 导航页搜索结果：关键字「进入 Hidden Mode」行 / feature 行都在，
//      行图标默认取插件自己的 icon（不是未知图标）；
//   ③ 点结果行进入该模式（无 pill 高亮），再按切换键 Tab：
//      hidden 模式不在循环里 → 回到导航页；
//   ④ provider 结果行图标（scratch fixture icon-demo）：
//      显式 icon 写相对插件目录的路径 → 解析为 asset URL；
//      没有 icon 的行 → 默认用插件清单 icon（custom.svg）。
//
//   node scripts/cdp_plugin_mode_bar_verify.mjs（先 pnpm run tauri build --debug --no-bundle）
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, openSync } from "node:fs";

const PORT = 9237;
const BASE = "src-tauri/target/debug";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}

// ── fixtures ──────────────────────────────────────────────────────────────
// ① hidden-mode 用仓库示例（纯 view + keywords + [[features]] + icon.svg）。
mkdirSync(`${BASE}/plugins`, { recursive: true });
rmSync(`${BASE}/plugins/hidden-mode`, { recursive: true, force: true });
cpSync("examples/plugins/hidden-mode", `${BASE}/plugins/hidden-mode`, { recursive: true });
// ② icon-demo 是脚本内的 scratch provider：一行带相对路径显式 icon，一行没有。
const FIX = "test/plugin_mode_bar_fixture/icon-demo";
rmSync("test/plugin_mode_bar_fixture", { recursive: true, force: true });
mkdirSync(`${FIX}`, { recursive: true });
writeFileSync(`${FIX}/plugin.toml`, `id = "icon-demo"
name = "Icon Demo"
version = "1.0.0"
kind = "provider"
description = "CDP fixture: 结果行图标（显式相对路径 / 清单 icon 缺省）"
icon = "custom.svg"
entry = "main.js"
`);
writeFileSync(`${FIX}/main.js`, `export default {
  async search(q) {
    if (q.trim().toLowerCase() !== "iconprobe") return [];
    return [
      { name: "自定义图标行", icon: "row.svg" },
      { name: "默认图标行" },
    ];
  },
};
`);
const svg = (color) => `<?xml version="1.0" encoding="UTF-8"?><svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="18" height="18" rx="4" fill="${color}"/></svg>`;
writeFileSync(`${FIX}/custom.svg`, svg("#2ecc71"));
writeFileSync(`${FIX}/row.svg`, svg("#e67e22"));
rmSync(`${BASE}/plugins/icon-demo`, { recursive: true, force: true });
cpSync(FIX, `${BASE}/plugins/icon-demo`, { recursive: true });

const logFd = openSync("test/plugin_mode_bar_lume.log", "w");
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
  let id = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; p.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description ?? "eval failed"));
    return r?.result?.result?.value;
  };
  return { ws, evalJs, send };
}
async function findMain() {
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      if (await c.evalJs(`!!document.getElementById("search-input")`)) return c;
      c.ws.close();
    } catch {}
  }
  return null;
}

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : " \u2014 " + extra));
  ok ? pass++ : fail++;
};

let m = null;
for (let i = 0; i < 40 && !m; i++) { await sleep(500); m = await findMain(); }
if (!m) { console.error("launcher window missing"); process.exit(1); }
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

await invoke("toggle_launcher");
await sleep(1500);

// Make sure both fixtures are enabled (previous runs / other probes may have
// left them disabled) and wait for the registry refresh to pick them up.
const settings = await invoke("get_settings");
const disabled = settings?.plugins?.disabled ?? [];
for (const id of ["hidden-mode", "icon-demo"]) {
  if (disabled.includes(id)) { await invoke("set_plugin_enabled", { id, enabled: true }); await sleep(900); }
}

const typeQuery = async (q) => {
  await m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  await sleep(700);
};
const pillTexts = () => m.evalJs(`[...document.querySelectorAll(".mode-switch-item")].map((el) => el.textContent.trim())`);
const rowInfo = (needle) => m.evalJs(`(() => {
  const box = [...document.querySelectorAll(".result-box")].find((el) => el.textContent.includes(${JSON.stringify(needle)}));
  if (!box) return null;
  const img = box.querySelector("img.result-box-img");
  return { text: box.textContent.trim(), src: img ? img.getAttribute("src") : null, unknown: img ? img.classList.contains("icon-unknown") : null };
})()`);
const waitRow = async (needle, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    const r = await rowInfo(needle);
    if (r) return r;
    await sleep(200);
  }
  return null;
};
const iconMatches = (src, file) => !!src && src.includes(file) && (src.includes("hidden-mode") || src.includes("icon-demo"));

// ── ① manifest flag + pill absence ───────────────────────────────────────
const manifests = await invoke("get_plugins");
const hm = (manifests ?? []).find((p) => p.id === "hidden-mode");
check("①a get_plugins reports hidden-mode hidden=true (enabled)", !!hm && hm.hidden === true && hm.enabled === true, JSON.stringify(hm));
await typeQuery("hush");
let pills = await pillTexts();
check("①b switch bar has no Hidden Mode pill", !pills.some((t2) => t2.includes("Hidden Mode")), JSON.stringify(pills));
check("①c switch bar still has the Navigate pill", pills.some((t2) => t2.includes("\u5bfc\u822a") || t2.toLowerCase().includes("navigate")), JSON.stringify(pills));

// ── ② keyword / feature rows carry the plugin icon ───────────────────────
const kw = await waitRow("\u8fdb\u5165 Hidden Mode");
check("②a keyword row present", !!kw, JSON.stringify(kw));
check("②b keyword row icon = plugin icon (hidden-mode/icon.svg)", iconMatches(kw?.src, "icon.svg") && kw?.unknown === false, JSON.stringify(kw));
await typeQuery("hush:abc");
const feat = await waitRow("Hidden Mode\uff1a\u8fdb\u5165\u5e76\u5e26\u8fd9\u6bb5\u6587\u5b57" /* label */);
check("②c feature row present", !!feat, JSON.stringify(feat));
check("②d feature row icon = plugin icon", iconMatches(feat?.src, "icon.svg") && feat?.unknown === false, JSON.stringify(feat));

// ── ③ enter via the row; no pill highlight; switch key skips it ──────────
await typeQuery("hush");
const kw2 = await waitRow("\u8fdb\u5165 Hidden Mode");
check("③a keyword row present for the click", !!kw2, JSON.stringify(kw2));
if (kw2) {
  await m.evalJs(`(() => { const box = [...document.querySelectorAll(".result-box")].find((el) => el.textContent.includes(${JSON.stringify("\u8fdb\u5165 Hidden Mode")})); box.dispatchEvent(new MouseEvent("click", { bubbles: true })); return "ok"; })()`);
}
let mounted = false;
for (let i = 0; i < 30 && !mounted; i++) {
  await sleep(200);
  mounted = await m.evalJs(`!!document.querySelector('iframe[srcdoc*="hidden-mode-view"]')`);
}
check("③b activating the row mounts the hidden mode page", mounted === true);
const activeCount = await m.evalJs(`document.querySelectorAll(".mode-switch-item.active").length`);
check("③c hidden mode active without a highlighted pill", activeCount === 0, `active=${activeCount}`);

const combo = settings?.hotkeys?.switch_mode || "Tab";
const parts = combo.split("+");
const key = parts[parts.length - 1];
const mods = parts.slice(0, -1).map((x) => x.toLowerCase());
await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, ctrlKey: ${mods.includes("ctrl")}, altKey: ${mods.includes("alt")}, shiftKey: ${mods.includes("shift")}, metaKey: ${mods.includes("super")}, bubbles: true })); "ok"`);
await sleep(600);
// #40 起页面保活：离开断言用「hidden-mode 宿主不再是 active」而不是 iframe
// 被卸载（iframe 会以隐藏状态保留，这正是会话续存的目标）。
const backHome = await m.evalJs(`(() => ({
  hostActive: !!document.querySelector('.mode-host[data-mode="hidden-mode"].active'),
  active: [...document.querySelectorAll(".mode-switch-item.active")].map((el) => el.textContent.trim()),
}))()`);
check("③d switch key leaves the hidden mode (cycle restarts at home)", backHome.hostActive === false && backHome.active.length === 1, JSON.stringify(backHome));

// ── ④ provider result icons ──────────────────────────────────────────────
await typeQuery("iconprobe");
const customRow = await waitRow("\u81ea\u5b9a\u4e49\u56fe\u6807\u884c");
const defaultRow = await waitRow("\u9ed8\u8ba4\u56fe\u6807\u884c");
check("④a provider row present (explicit icon)", !!customRow, JSON.stringify(customRow));
check("④b explicit icon (relative path) resolves to the fixture asset", !!customRow && customRow.src?.includes("row.svg") && customRow.unknown === false, JSON.stringify(customRow));
check("④c provider row without icon present", !!defaultRow, JSON.stringify(defaultRow));
check("④d default row icon = plugin manifest icon (custom.svg)", !!defaultRow && defaultRow.src?.includes("custom.svg") && defaultRow.unknown === false, JSON.stringify(defaultRow));

console.log(`\nPLUGIN MODE BAR VERIFY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
