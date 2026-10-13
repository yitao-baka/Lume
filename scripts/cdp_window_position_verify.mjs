// 主窗口位置记忆验证（ROADMAP #41）：
//   ① 窗口被拖走后：
//      a) apply_position（前端内容高度变化后调用的钩子）不再拉回预设锚点；
//      b) hide → show 继承上次关闭位置（核心回归：不再重置到预设）；
//      c) 保存「无关设置」（位置配置未变）也不重置。
//   ② 显式改「窗口位置」预设：立即生效（即时反馈），之后的呼出沿用新位置。
//   ③ 跟随鼠标：每次呼出都按光标重新定位（唯一例外）。
// 说明：窗口位置读取/移动走 scripts/ps_lume_main_rect.ps1 —— 真 HWND
// （CDP Browser.setWindowBounds 在 WebView2 上只改“虚拟窗口”，实测真实窗口
// 纹丝不动，弃用）。外部 MoveWindow = 用户拖拽的判定路径（位置偏离程序化
// 锚点 → user_placed）。光标用 SetPhysicalCursorPos 落到目标点；DPI 虚拟化
// 的 PowerShell 里光标输入空间与窗口矩形同空间（150% 实测二者 1:1），
// 所以目标点直接按 PS 空间给，不做换算。
// Usage: node scripts/cdp_window_position_verify.mjs
//        （先 pnpm run tauri build --debug --no-bundle 重建内嵌前端）

import { spawn, execFileSync, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";

const CDP_PORT = 9238;
const APP = process.env.LUME_APP ?? "src-tauri/target/debug/lume.exe"; // LUME_APP=.../release/lume.exe 可验证发行包
const PS_HELPER = "scripts/ps_lume_main_rect.ps1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
mkdirSync("test", { recursive: true });
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

let mainT = null;
for (let i = 0; i < 40 && !mainT; i++) { await sleep(500); mainT = await findMain(); }
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
);

// ── Real window rect / move (see scripts/ps_lume_main_rect.ps1) ──
const psRect = (move) => {
  const env = { ...process.env };
  if (move) env.LUME_MOVE = `${Math.round(move.left)},${Math.round(move.top)}`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_HELPER], {
    encoding: "utf8", windowsHide: true, env,
  }).trim();
  if (!/^-?\d+,-?\d+,-?\d+,-?\d+$/.test(out)) return null;
  const [left, top, right, bottom] = out.split(",").map(Number);
  return { left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
};
const eqPt = (a, p, tol = 2) => !!a && Math.abs(a.left - p.left) <= tol && Math.abs(a.top - p.top) <= tol;
const sameRect = (a, b, tol = 2) => eqPt(a, b, tol) && !!a && Math.abs(a.right - b.right) <= tol + 2 && Math.abs(a.bottom - b.bottom) <= tol + 2;

// Guaranteed fresh show: hide (idempotent) → toggle (hidden → shown).
const summon = async () => {
  await invoke("hide_launcher");
  await sleep(250);
  await invoke("toggle_launcher");
  await sleep(900);
};
const setCursor = (x, y) => {
  const code = [
    'Add-Type @"',
    "using System;",
    'using System.Runtime.InteropServices;',
    'public class LumeCursor { [DllImport("user32.dll")] public static extern bool SetPhysicalCursorPos(int x, int y); }',
    '"@',
    `[void][LumeCursor]::SetPhysicalCursorPos(${Math.round(x)}, ${Math.round(y)})`,
  ].join("\n");
  execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", code], { stdio: "ignore", windowsHide: true });
};

// ── 0. Deterministic start: 窗口位置 = center, 自定义关 ──
const s0 = await invoke("get_settings");
const orig = {
  window_position: s0.appearance.window_position,
  remember_position: s0.appearance.remember_position,
};
s0.appearance.window_position = "center";
s0.appearance.remember_position = false;
await invoke("save_settings", { new: s0 });
await sleep(300);
const s0b = await invoke("get_settings");
check("起始预设 = center + remember_position=false",
  s0b.appearance.window_position === "center" && s0b.appearance.remember_position === false,
  JSON.stringify({ pos: s0b.appearance.window_position, remember: s0b.appearance.remember_position }));

// 首次出现（run 内第一次 show）。
await summon();
const r1 = psRect();
check("主窗口句柄定位 + 首次呼出", !!r1, JSON.stringify(r1));

// ── 1. 模拟用户拖走窗口（真 HWND MoveWindow） ──
const target = { left: r1.left + 140, top: r1.top + 100 };
const r2 = psRect(target);
check("模拟拖动生效（真实窗口移动）", eqPt(r2, target, 3), JSON.stringify({ r1, target, r2 }));

// 1a. apply_position（内容高度变化钩子）不得拉回预设锚点。
await invoke("apply_position");
await sleep(400);
const r3 = psRect();
check("拖走后 apply_position 不拉回预设", sameRect(r3, r2), JSON.stringify({ r2, r3 }));

// ── 1b. hide → show：继承上次关闭位置（核心回归） ──
await summon();
const r4 = psRect();
check("隐藏再呼出：继承关窗位置（不重置）", sameRect(r4, r2), JSON.stringify({ r2, r4 }));

// ── 1c. 无关设置保存不得重置（位置配置未变） ──
const s1 = await invoke("get_settings");
await invoke("save_settings", { new: s1 });
await sleep(450);
const r5 = psRect();
check("保存无关设置不重置位置", sameRect(r5, r2), JSON.stringify({ r2, r5 }));

// ── 2. 显式改「窗口位置」预设：立即生效，之后呼出沿用 ──
const sw = Math.round(await m.evalJs(`screen.width`));
const sh = Math.round(await m.evalJs(`screen.height`));
const s2 = await invoke("get_settings");
s2.appearance.window_position = "bottom-right";
s2.appearance.remember_position = false;
await invoke("save_settings", { new: s2 });
await sleep(700);
const r6 = psRect();
check("显式改预设立即生效（位置改变）", !!r6 && !eqPt(r6, r2, 8), JSON.stringify({ r2, r6 }));
check("bottom-right 预设贴到屏幕右下角", !!r6 && r6.right >= sw - 20 && r6.bottom >= sh - 20,
  JSON.stringify({ screen: `${sw}x${sh}`, r6 }));
await summon();
const r7 = psRect();
check("改预设后呼出沿用新位置", sameRect(r7, r6), JSON.stringify({ r6, r7 }));

// ── 3. 跟随鼠标（例外：每次呼出都按光标定位） ──
const s3 = await invoke("get_settings");
s3.appearance.window_position = "follow-mouse";
s3.appearance.remember_position = false;
await invoke("save_settings", { new: s3 });
await sleep(500);
// 目标点取屏幕中心附近（离边缘足够远，居中后不触发 clamp）。
const p1 = { x: Math.round(sw / 2) - 200, y: Math.round(sh / 2) + 80 };
setCursor(p1.x, p1.y);
await sleep(250);
await summon();
const r8 = psRect();
check("跟随鼠标：呼出时窗口居中到光标",
  !!r8 && Math.abs(r8.cx - p1.x) <= 8 && Math.abs(r8.cy - p1.y) <= 8,
  JSON.stringify({ p1, center: r8 && { x: r8.cx, y: r8.cy } }));

const p2 = { x: p1.x + 110, y: p1.y - 70 };
setCursor(p2.x, p2.y);
await sleep(250);
await summon();
const r9 = psRect();
check("跟随鼠标：再次呼出重新跟随新光标（非首次出现也生效）",
  !!r9 && Math.abs(r9.cx - p2.x) <= 8 && Math.abs(r9.cy - p2.y) <= 8 &&
  Math.abs((r9.cx - r8.cx) - (p2.x - p1.x)) <= 6 &&
  Math.abs((r9.cy - r8.cy) - (p2.y - p1.y)) <= 6,
  JSON.stringify({ p2, center: r9 && { x: r9.cx, y: r9.cy } }));

const shot = await m.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/window_position_verify.png", Buffer.from(shot.result.data, "base64"));

// ── 4. 还原原设置 ──
const s4 = await invoke("get_settings");
s4.appearance.window_position = orig.window_position;
s4.appearance.remember_position = orig.remember_position;
await invoke("save_settings", { new: s4 });
await sleep(300);
const s5 = await invoke("get_settings");
check("还原原窗口位置设置",
  s5.appearance.window_position === orig.window_position &&
  s5.appearance.remember_position === orig.remember_position,
  JSON.stringify({ restored: orig }));

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
