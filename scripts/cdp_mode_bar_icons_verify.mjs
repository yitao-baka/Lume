// 模式切换栏仅图标（docs/ROADMAP_HISTORY.md #47）端到端验证。
//
// 夹具：scratch mode 插件 noicon-mode（plugin.toml 不声明 icon）——
//   断言无图标回退 unknow_universal.svg；内置导航/剪贴板胶囊用于宽度对比。
//
// 覆盖：
//   A 默认关：胶囊显示「图标 + 名称」，每颗胶囊 title/aria-label 齐备
//   B 无图标模式：胶囊图标回退 unknow_universal.svg（两种呈现下都在）
//   C 开启（save_settings → settings-applied 实时生效）：
//     名称隐藏、栏与胶囊变窄、高度不变、title/aria-label 保留
//   D 开启后交互不变：点击胶囊切页、切换键循环仍工作
//   E 关回：名称恢复
//   F 真实设置面板路径：导航页开关 → 保存并应用 → 启动器实时生效 + 持久化
//   G 重启首帧：设置已落盘为开 → 重启后直出仅图标（__LUME_CONFIG__ 注入路径）
//
// 结束前恢复原设置并移除夹具（不污染其它脚本的基线）。
// 运行：node scripts/cdp_mode_bar_icons_verify.mjs
//       （先 pnpm run tauri build --debug --no-bundle，脚本自己拉起已构建 exe）
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, openSync, writeFileSync, readFileSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
const PORT = 9245;

// 小 SVG 会被 Vite 内联成 data: URL —— 按源文件第一条 path 的特征串判定
// 「unknow_universal」（未内联时退回文件名）。
const unknownMarker = (() => {
  try {
    const svg = readFileSync("res/icons/unknow_universal.svg", "utf-8");
    const mm = /d="(M[^"]{20,})"/.exec(svg);
    return mm ? mm[1].slice(0, 24) : null;
  } catch { return null; }
})();
const isUnknownIcon = (src) => {
  if (!src) return false;
  if (src.includes("unknow_universal")) return true;
  if (!src.startsWith("data:")) return false;
  let decoded = src;
  try { decoded = decodeURIComponent(src); } catch {}
  return !!unknownMarker && decoded.includes(unknownMarker);
};

// ── fixture：无图标 mode（纯 view，清单不声明 icon） ─────────────────────
const FIX = "test/mode_bar_icons_fixture/noicon-mode";
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
writeFileSync(`${FIX}/plugin.toml`, `id = "noicon-mode"
name = "No Icon Mode"
version = "1.0.0"
kind = "mode"
description = "CDP fixture: mode without an icon - pill falls back to unknow_universal.svg"
view = "view.html"
height = 360
`);
writeFileSync(
  `${FIX}/view.html`,
  `<!doctype html><html><body><div id="noicon-view" style="font:14px sans-serif;color:#888">No Icon Mode</div></body></html>`
);
mkdirSync(`${BASE}/plugins`, { recursive: true });
rmSync(`${BASE}/plugins/noicon-mode`, { recursive: true, force: true });
cpSync(FIX, `${BASE}/plugins/noicon-mode`, { recursive: true });

function startApp(logName) {
  const logFd = openSync(logName, "w");
  spawn(`${BASE}/lume.exe`, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: ["ignore", logFd, logFd],
  });
}
startApp("test/mode_bar_icons_lume.log");

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
  return { ws, evalJs, send };
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
const shot = async (file) => {
  const r = await m.send("Page.captureScreenshot", { format: "png" });
  if (r?.result?.data) writeFileSync(file, Buffer.from(r.result.data, "base64"));
};
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

// Snapshot the original switch; force the deterministic baseline (off).
const originalFlag = !!(await invoke("get_settings")).appearance.mode_switch_icons_only;
const setFlag = async (v) => {
  const s = await invoke("get_settings");
  s.appearance.mode_switch_icons_only = v;
  await invoke("save_settings", { new: s });
  await sleep(700);
};
let restoreNeeded = true;
async function restore() {
  if (!restoreNeeded) return;
  restoreNeeded = false;
  try { await setFlag(originalFlag); } catch (e) { console.log("restore settings failed:", String(e)); }
  try { rmSync(`${BASE}/plugins/noicon-mode`, { recursive: true, force: true }); } catch {}
}

const pillInfo = () => m.evalJs(`(() => {
  const bar = document.querySelector(".mode-switch");
  if (!bar) return null;
  const items = [...document.querySelectorAll(".mode-switch-item")];
  return {
    iconsOnly: bar.classList.contains("icons-only"),
    barW: Math.round(bar.getBoundingClientRect().width),
    items: items.map((b) => {
      const label = b.querySelector(".mode-switch-label");
      const img = b.querySelector(".mode-switch-icon");
      return {
        title: b.getAttribute("title"),
        aria: b.getAttribute("aria-label"),
        active: b.classList.contains("active"),
        labelShown: !!label && getComputedStyle(label).display !== "none",
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
        src: img ? img.getAttribute("src") : null,
      };
    }),
  };
})()`);
const waitPill = async (title, tries = 30) => {
  for (let i = 0; i < tries; i++) {
    const info = await pillInfo();
    if (info && info.items.some((it) => it.title === title)) return info;
    await sleep(400);
  }
  return await pillInfo();
};
const waitIconsOnly = async (want, tries = 25) => {
  for (let i = 0; i < tries; i++) {
    const info = await pillInfo();
    if (info && info.iconsOnly === want) return info;
    await sleep(200);
  }
  return await pillInfo();
};
const clickPill = (title) => m.evalJs(`(() => {
  const b = [...document.querySelectorAll(".mode-switch-item")].find((x) => x.getAttribute("title") === ${JSON.stringify(title)});
  if (!b) return false;
  b.click();
  return true;
})()`);
const activeTitle = async () => (await pillInfo())?.items.find((i) => i.active)?.title ?? "";

try {
  await invoke("set_plugin_enabled", { id: "noicon-mode", enabled: true });
  await setFlag(false);
  await invoke("toggle_launcher");
  await sleep(1500);

  // ── A. 默认关：图标 + 名称 ────────────────────────────────────────────
  const a = await waitPill("No Icon Mode");
  check("A1 默认关：栏存在且 3 颗胶囊在位", !!a && !a.iconsOnly && a.items.length >= 3, JSON.stringify(a?.items?.map((i) => i.title)));
  check("A2 默认呈现图标 + 名称", !!a && a.items.every((i) => i.labelShown), JSON.stringify(a?.items?.filter((i) => !i.labelShown).map((i) => i.title)));
  check("A3 每颗胶囊都有 title + aria-label", !!a && a.items.every((i) => i.title && i.aria && i.title === i.aria));
  await shot("test/mode_bar_icons_labels.png");

  // ── B. 无图标回退 unknow_universal.svg ───────────────────────────────
  const noiconA = a?.items.find((i) => i.title === "No Icon Mode");
  check("B1 无图标模式胶囊存在", !!noiconA);
  check("B2 无图标回退 unknow_universal.svg", isUnknownIcon(noiconA?.src), String(noiconA?.src).slice(0, 80));

  // ── C. 开启仅图标（实时生效） ────────────────────────────────────────
  await setFlag(true);
  const c = await waitIconsOnly(true);
  check("C1 icons-only 类实时生效", !!c && c.iconsOnly);
  check("C2 名称全部隐藏", !!c && c.items.every((i) => !i.labelShown));
  check("C3 title + aria-label 保留", !!c && c.items.every((i) => i.title && i.aria && i.title === i.aria));
  const wBefore = new Map((a?.items ?? []).map((i) => [i.title, i.w]));
  check("C4 栏与每颗胶囊都变窄", !!c && c.barW < (a?.barW ?? 0) && c.items.every((i) => i.w < (wBefore.get(i.title) ?? 1e9)),
    (a?.barW ?? "-") + " -> " + (c?.barW ?? "-") + " " + JSON.stringify(c?.items?.map((i) => i.w)));
  const hBefore = new Map((a?.items ?? []).map((i) => [i.title, i.h]));
  check("C5 胶囊高度不变（切换不跳行）", !!c && c.items.every((i) => Math.abs(i.h - (hBefore.get(i.title) ?? -99)) <= 1),
    JSON.stringify(c?.items?.map((i) => i.h)) + " vs " + JSON.stringify(a?.items?.map((i) => i.h)));
  const noiconC = c?.items.find((i) => i.title === "No Icon Mode");
  check("C6 仅图标下仍回退 unknow_universal.svg", isUnknownIcon(noiconC?.src), String(noiconC?.src).slice(0, 80));
  await shot("test/mode_bar_icons_only.png");

  // ── D. 交互不变：点击切页 + 切换键循环 ───────────────────────────────
  check("D1 点击无图标胶囊可切页", await clickPill("No Icon Mode"));
  await sleep(1800);
  check("D2 激活态落在该模式", (await activeTitle()) === "No Icon Mode", await activeTitle());
  const combo = (await invoke("get_settings")).hotkeys.switch_mode || "Tab";
  const parts = combo.split("+");
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1).map((x) => x.toLowerCase());
  const before = await activeTitle();
  await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, ctrlKey: ${mods.includes("ctrl")}, altKey: ${mods.includes("alt")}, shiftKey: ${mods.includes("shift")}, metaKey: ${mods.includes("super")}, bubbles: true })); "ok"`);
  await sleep(800);
  const after = await activeTitle();
  check("D3 切换键循环在仅图标下仍工作", !!after && after !== before && after !== "No Icon Mode", before + " -> " + after);

  // ── E. 关回：名称恢复 ────────────────────────────────────────────────
  await setFlag(false);
  const e = await waitIconsOnly(false);
  check("E1 关回后名称恢复", !!e && !e.iconsOnly && e.items.every((i) => i.labelShown));

  // ── F. 真实设置面板：导航页开关 → 保存并应用 → 实时生效 ─────────────
  await m.evalJs(`document.querySelector(".icon-btn[aria-label]")?.click(); "clicked"`);
  const s = await findSettings();
  check("F1 设置窗口打开", !!s);
  if (s) {
    // 设置窗默认落在别的面板 —— 先切到「导航页」（三语名）。
    await s.evalJs(`(() => {
      const names = ["导航页", "導航頁", "Navigation"];
      const b = [...document.querySelectorAll(".settings-nav")].find((x) => names.some((n) => x.textContent.includes(n)));
      b?.click();
      return !!b;
    })()`);
    await sleep(500);
  }
  const rowLabels = ["模式切换栏仅显示图标", "模式切換欄僅顯示圖示", "Mode bar shows icons only"];
  const rowSel = `(() => {
    const labels = ${JSON.stringify(rowLabels)};
    return [...document.querySelectorAll(".settings-row-between")].find((r) => labels.some((l) => r.textContent.includes(l))) ?? null;
  })()`;
  const rowBefore = s ? await s.evalJs(`(() => { const r = ${rowSel}; return r ? { label: r.textContent.trim(), checked: r.querySelector(".settings-toggle")?.getAttribute("aria-checked") } : null; })()`) : null;
  check("F2 导航页有该开关且当前为关", !!rowBefore && rowBefore.checked === "false", JSON.stringify(rowBefore));
  if (s && rowBefore) {
    await s.evalJs(`(() => { const r = ${rowSel}; r?.querySelector(".settings-toggle")?.click(); return "ok"; })()`);
    await sleep(300);
    const saveDisabled = await s.evalJs(`Array.from(document.querySelectorAll(".settings-footer .settings-action"))[1]?.disabled`);
    check("F3 改动后保存按钮可用", saveDisabled === false);
    await s.evalJs(`Array.from(document.querySelectorAll(".settings-footer .settings-action"))[1]?.click(); "ok"`);
    await sleep(1200);
  }
  const f = await waitIconsOnly(true, 30);
  check("F4 保存并应用后启动器实时切成仅图标", !!f && f.iconsOnly);
  const persisted = !!(await invoke("get_settings")).appearance.mode_switch_icons_only;
  check("F5 开关已落盘", persisted === true);

  // ── G. 重启首帧：__LUME_CONFIG__ 注入（重启后不做任何设置变更） ──────
  await setFlag(true); // 保证重启时开关已落盘为开（与 F 的成败解耦）
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
  await sleep(1200);
  startApp("test/mode_bar_icons_lume_restart.log");
  m = await findMain();
  check("G0 重启后主窗口回来了", !!m);
  if (m) {
    await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`);
    await sleep(1500);
    const g = await waitIconsOnly(true, 20);
    check("G1 首帧即仅图标（注入路径）", !!g && g.iconsOnly && g.items.every((i) => !i.labelShown), JSON.stringify({ iconsOnly: g?.iconsOnly, labels: g?.items?.map((i) => i.labelShown) }));
  }
} catch (err) {
  console.error("unhandled:", err);
  fail++;
}

await restore();
console.log(`\nMODE-BAR-ICONS-VERIFY ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
process.exit(fail === 0 ? 0 : 1);
