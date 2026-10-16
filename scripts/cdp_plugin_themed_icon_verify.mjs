// 插件图标深浅两套（docs/ROADMAP_HISTORY.md #44）回归：
//
//   ① 启动器浅色：关键字行 / 模式 pill / 列表模板行（显式对与清单缺省）都取
//      light 变体；显式变体带 .icon-explicit（不受 --icon-filter 反相）。
//   ② 切深色（save_settings 真实路径）：同一批图标即时换成 dark 变体。
//   ③ 旧版单图（字符串 icon）行为不变：深色下 .plugin-list-icon 仍 invert(1)。
//   ④ 导航 feature 行（[[features]] 自带两套图）随主题换套。
//   ⑤ 独立窗任务栏图标（脚本自建 themed-window 夹具，detachable + 两套图）：
//      detach 后 ICON_BIG 是上传的 light 变体原样像素；窗口内 lume.theme.set
//      钉成 dark 后重取 HICON = dark 变体原样像素（显式变体不做反相 ——
//      反相值与本断言颜色相距超容差）。
//
//   前置：pnpm run tauri build --debug --no-bundle；node scripts/cdp_plugin_themed_icon_verify.mjs
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, openSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const PORT = 9237;
const BASE = "src-tauri/target/debug";
const OUT = "test/plugin_themed_icon_check";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** `--legacy`: run only the legacy single-icon taskbar branch (⑤). */
const LEGACY = process.argv.includes("--legacy");
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ── 夹具 1：仓库示例 themed-icons（pill/行/feature 两套图） ──
rmSync(`${BASE}/plugins/themed-icons`, { recursive: true, force: true });
cpSync("examples/plugins/themed-icons", `${BASE}/plugins/themed-icons`, { recursive: true });

// ── 夹具 2：脚本自建的可分离 mode（任务栏图标端到端） ──
const FIX = `${OUT}/fixture/themed-window`;
mkdirSync(FIX, { recursive: true });
writeFileSync(`${FIX}/plugin.toml`, `# 任务栏图标 #44 回归夹具（脚本自建，仅测试用）。
id = "themed-window"
name = "Themed Window"
kind = "mode"
view = "view.html"
detachable = true
keywords = ["themedwin"]
icon_light = "light.svg"
icon_dark = "dark.svg"
`);
writeFileSync(`${FIX}/view.html`, `<!doctype html><html><body style="margin:0;font:13px sans-serif;background:inherit"></body></html>`);
writeFileSync(`${FIX}/light.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" fill="#2e8b57"/></svg>`);
writeFileSync(`${FIX}/dark.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" fill="#ffd166"/></svg>`);
rmSync(`${BASE}/plugins/themed-window`, { recursive: true, force: true });
cpSync(FIX, `${BASE}/plugins/themed-window`, { recursive: true });

// 兼容路径夹具：只有旧的单图 `icon`（深色下应继续被反相）。
const FIX_LEGACY = `${OUT}/fixture/themed-window-legacy`;
mkdirSync(FIX_LEGACY, { recursive: true });
writeFileSync(`${FIX_LEGACY}/plugin.toml`, `id = "themed-window-legacy"
name = "Themed Window Legacy"
kind = "mode"
view = "view.html"
detachable = true
keywords = ["themedlegacy"]
icon = "light.svg"
`);
writeFileSync(`${FIX_LEGACY}/view.html`, `<!doctype html><html><body style="margin:0;font:13px sans-serif;background:inherit"></body></html>`);
writeFileSync(`${FIX_LEGACY}/light.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48"><rect width="48" height="48" fill="#2e8b57"/></svg>`);
rmSync(`${BASE}/plugins/themed-window-legacy`, { recursive: true, force: true });
cpSync(FIX_LEGACY, `${BASE}/plugins/themed-window-legacy`, { recursive: true });

// ── 每窗口 ICON_BIG 落盘（含 PNG 文件名，便于按行取样） ──
const DUMP_PS = String.raw`
param([string]$Out = "dump.json", [string]$PngDir = ".")
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr wp, IntPtr lp);

  public static List<IntPtr> ProcWindows(int pid) {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      uint p; GetWindowThreadProcessId(h, out p);
      if ((int)p == pid) { list.Add(h); }
      return true;
    }, IntPtr.Zero);
    return list;
  }
  public static string TitleOf(IntPtr h) {
    StringBuilder sb = new StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }
}
'@
[W]::SetProcessDPIAware() | Out-Null
$procs = @(Get-Process lume -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { "no lume process"; exit 1 }
$rows = @()
$i = 0
foreach ($pr in $procs) {
  foreach ($h in [W]::ProcWindows([int]$pr.Id)) {
    $i++
    $png = $null
    $big = [W]::SendMessage($h, 0x7F, [IntPtr]1, [IntPtr]::Zero)
    if ($big -ne [IntPtr]::Zero) {
      try {
        $ico = [System.Drawing.Icon]::FromHandle($big)
        $bmp = $ico.ToBitmap()
        $png = 'win' + $i + '_big.png'
        $bmp.Save(($PngDir + '/' + $png), [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
      } catch { $png = $null }
    }
    $rows += [pscustomobject]@{ hwnd = [int64]$h; pid = $pr.Id; title = [W]::TitleOf($h); visible = [W]::IsWindowVisible($h); png = $png }
  }
}
$json = $rows | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
"saved " + $rows.Count + " window records"
`;
writeFileSync(`${OUT}/dump.ps1`, DUMP_PS);
function dump() {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File ${OUT}/dump.ps1 -Out ${OUT}/dump.json -PngDir ${OUT}`, { stdio: "ignore" });
  return JSON.parse(readFileSync(`${OUT}/dump.json`, "utf8"));
}

// ── 极简 8-bit PNG 解码（取 (x,y) 像素） ──
function pngPixelAt(buf, x, y) {
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 0 ? 1 : 0;
  if (!ch || depth !== 8) throw new Error(`unsupported png (ctype ${ctype}, depth ${depth})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let row = 0; row < h; row++) {
    const filter = raw[row * (stride + 1)];
    const line = raw.subarray(row * (stride + 1) + 1, row * (stride + 1) + 1 + stride);
    const cur = out.subarray(row * stride, (row + 1) * stride);
    const prev = row > 0 ? out.subarray((row - 1) * stride, row * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0, v = line[i];
      cur[i] = (filter === 0 ? v
        : filter === 1 ? v + a
        : filter === 2 ? v + b
        : filter === 3 ? v + ((a + b) >> 1)
        : v + paeth(a, b, c)) & 255;
    }
  }
  const px = Math.min(Math.max(x, 0), w - 1), py = Math.min(Math.max(y, 0), h - 1);
  const off = py * stride + px * ch;
  return [out[off], out[off + 1], out[off + 2], ch === 4 ? out[off + 3] : 255];
}
const near = (px, ref, tol = 30) => px.slice(0, 3).every((v, i) => Math.abs(v - ref[i]) <= tol);
const hex = (px) => "#" + px.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");
const GREEN = [46, 139, 87], AMBER = [255, 209, 102];

// ── 启动 + CDP ──
const logFd = openSync(`${OUT}/lume.log`, "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
});
async function listTargets() {
  try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return null; }
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
  return { ws, send, evalJs };
}
async function findMain() {
  const pages = ((await listTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      if (await c.evalJs(`!!document.getElementById("search-input")`)) return { target: t, conn: c };
      c.ws.close();
    } catch {}
  }
  return null;
}

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : " — " + extra));
  ok ? pass++ : fail++;
};

let mainT = null;
for (let i = 0; i < 60 && !mainT; i++) { await sleep(500); mainT = await findMain(); }
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
const m = mainT.conn;
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const PILL = (label) => m.evalJs(`(() => {
  const b = [...document.querySelectorAll(".mode-switch-item")].find((x) => x.textContent.includes(${JSON.stringify(label)}));
  const img = b?.querySelector(".mode-switch-icon");
  return img ? { src: img.src, cls: img.className, filter: getComputedStyle(img).filter } : null;
})()`);
const LIST_ROWS = () => m.evalJs(`[...document.querySelectorAll(".plugin-list-row")].map((r) => {
  const img = r.querySelector(".plugin-list-icon");
  return { text: r.textContent, src: img?.src ?? null, cls: img?.className ?? null, filter: img ? getComputedStyle(img).filter : null };
})`);
const GRID_ROW = (text) => m.evalJs(`(() => {
  const r = [...document.querySelectorAll(".result-box")].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  const img = r?.querySelector(".result-box-img");
  return r ? { text: r.textContent, src: img?.src ?? null, filter: img ? getComputedStyle(img).filter : "none" } : null;
})()`);
const setTheme = async (mode) => {
  const s = await invoke("get_settings");
  s.appearance.color_mode = mode;
  await invoke("save_settings", { new: s });
  await sleep(1500);
};
const clickRow = (text) => m.evalJs(`(() => {
  const r = [...document.querySelectorAll(".result-box")].find((x) => x.textContent.includes(${JSON.stringify(text)}));
  if (!r) return false;
  r.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return true;
})()`);
async function waitFor(expr, tries = 30) {
  for (let i = 0; i < tries; i++) { if (await m.evalJs(expr)) return true; await sleep(300); }
  return false;
}

// 自愈：本插件启停 / 颜色偏好可能被上一轮改过。
await invoke("toggle_launcher");
await sleep(1200);
for (const id of ["themed-icons", "themed-window", "themed-window-legacy"]) {
  const off = await m.evalJs(`window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => (s.plugins?.disabled ?? []).includes(${JSON.stringify(id)}))`);
  if (off) { await invoke("set_plugin_enabled", { id, enabled: true }); await sleep(900); }
}
{
  const s = await invoke("get_settings");
  delete s.plugins.color_modes["themed-icons"];
  delete s.plugins.color_modes["themed-window"];
  delete s.plugins.color_modes["themed-window-legacy"];
  s.appearance.color_mode = "light";
  await invoke("save_settings", { new: s });
  await sleep(1500);
}
check("①a launcher theme = light (baseline)", (await m.evalJs("document.documentElement.dataset.theme")) === "light");

// ── ⑤ 兼容路径（--legacy）：旧单图 icon 的任务栏图标深色下仍反相 ──
if (LEGACY) {
  const INV_GREEN = [209, 116, 168]; // invert_rgb(#2e8b57)
  await type("themedlegacy");
  await sleep(1500);
  check("⑤a entered legacy window mode", await clickRow("进入 Themed Window Legacy"));
  check("⑤b detach button present", await waitFor(`!!document.querySelector(".detach-btn")`));
  await m.evalJs(`document.querySelector(".detach-btn")?.click(); "ok"`);
  await sleep(2500);
  let legacyWin = null;
  for (let i = 0; i < 30 && !legacyWin; i++) {
    const pages = ((await listTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("plugin.html") && t.url.includes("themed-window-legacy"));
    if (pages[0]) { try { legacyWin = await connect(pages[0].webSocketDebuggerUrl); } catch {} }
    if (!legacyWin) await sleep(500);
  }
  check("⑤c legacy window target present", !!legacyWin);
  if (legacyWin) {
    const rec = () => {
      const rows = dump();
      const arr = Array.isArray(rows) ? rows : [rows];
      return arr.find((r) => r.title === "Themed Window Legacy" && r.png) ?? null;
    };
    const iconPixel = (row) => pngPixelAt(readFileSync(`${OUT}/${row.png}`), 128, 128);
    const lightRow = rec();
    check("⑤d legacy light window shows the raw icon", !!lightRow && near(iconPixel(lightRow), GREEN), lightRow ? hex(iconPixel(lightRow)) : "no record");
    await legacyWin.evalJs(`window.__TAURI_INTERNALS__.invoke("set_plugin_color_mode", { id: "themed-window-legacy", mode: "dark" })`);
    await sleep(1500);
    const darkRow = rec();
    check("⑤e legacy dark window still inverts the icon", !!darkRow && near(iconPixel(darkRow), INV_GREEN), darkRow ? hex(iconPixel(darkRow)) : "no record");
    legacyWin.ws.close();
  }
  console.log(`\nPLUGIN THEMED ICON VERIFY (legacy) ${pass}/${pass + fail}${fail ? " — FAIL" : " — PASS"}`);
  process.exit(fail ? 1 : 0);
}

// ── ① 浅色：关键字行 + pill + 列表三行 ──
await type("themed");
await sleep(1500);
const kw = await GRID_ROW("进入 Themed Icons");
check("①b keyword row uses the light variant", !!kw?.src?.includes("pill-light"), JSON.stringify(kw));
check("①c keyword row entered", await clickRow("进入 Themed Icons"));
check("①d list template mounted", await waitFor(`document.querySelectorAll(".plugin-list-row").length >= 3`));
const pLight = await PILL("Themed Icons");
check("①e pill uses the light variant, explicit (no invert)",
  !!pLight?.src?.includes("pill-light") && pLight.cls.includes("icon-explicit") && pLight.filter === "none",
  JSON.stringify(pLight));
const rLight = await LIST_ROWS();
check("①f explicit row icon = light variant, no invert",
  !!rLight[0]?.src?.includes("row-light") && rLight[0].cls.includes("icon-explicit") && rLight[0].filter === "none",
  JSON.stringify(rLight[0]));
check("①g default row falls back to the manifest light variant",
  !!rLight[1]?.src?.includes("pill-light") && rLight[1].filter === "none",
  JSON.stringify(rLight[1]));
check("①h legacy string row stays on the legacy path (no explicit marker)",
  !!rLight[2]?.src?.includes("pill-light") && !rLight[2].cls.includes("icon-explicit"),
  JSON.stringify(rLight[2]));

// ── ② 深色：同一批图标即时换套；legacy 行仍反相 ──
await setTheme("dark");
const pDark = await PILL("Themed Icons");
check("②a pill swapped to the dark variant",
  !!pDark?.src?.includes("pill-dark") && pDark.filter === "none",
  JSON.stringify(pDark));
const rDark = await LIST_ROWS();
check("②b explicit row icon swapped to the dark variant",
  !!rDark[0]?.src?.includes("row-dark") && rDark[0].filter === "none",
  JSON.stringify(rDark[0]));
check("②c default row swapped to the manifest dark variant",
  !!rDark[1]?.src?.includes("pill-dark") && rDark[1].filter === "none",
  JSON.stringify(rDark[1]));
check("②d legacy row keeps the historical invert(1)",
  !!rDark[2]?.src?.includes("pill-light") && rDark[2].filter === "invert(1)",
  JSON.stringify(rDark[2]));

// ── ③ 导航 feature 行（规则自带两套图）随主题换套 ──
await m.evalJs(`document.querySelectorAll(".mode-switch-item")[0]?.click(); "ok"`);
await sleep(1200);
await type("themed:abc");
await sleep(1500);
const featDark = await GRID_ROW("处理这段文字");
check("③a feature row uses its own dark variant", !!featDark?.src?.includes("row-dark"), JSON.stringify(featDark));
await setTheme("light");
const featLight = await GRID_ROW("处理这段文字");
check("③b feature row follows the flip back to light", !!featLight?.src?.includes("row-light"), JSON.stringify(featLight));

// ── ④ 独立窗任务栏图标：显式变体原样取用、随插件生效主题重取 ──
await type("");
await sleep(500);
check("④a entered themed-window via keyword", await (async () => {
  await type("themedwin");
  await sleep(1500);
  const ok = await clickRow("进入 Themed Window");
  await sleep(1800);
  return ok;
})());
check("④b detach button present", await waitFor(`!!document.querySelector(".detach-btn")`));
await m.evalJs(`document.querySelector(".detach-btn")?.click(); "ok"`);
await sleep(2500);

// Plugin window target (CDP) — the launcher hides on detach; drive the window.
let winT = null;
for (let i = 0; i < 30 && !winT; i++) {
  const pages = ((await listTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("plugin.html") && t.url.includes("themed-window"));
  if (pages[0]) {
    try { winT = { target: pages[0], conn: await connect(pages[0].webSocketDebuggerUrl) }; } catch {}
  }
  if (!winT) await sleep(500);
}
check("④c detached window target present", !!winT);
if (winT) {
  const winInvoke = (cmd, args = {}) => winT.conn.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
  const rec = () => {
    const rows = dump();
    const arr = Array.isArray(rows) ? rows : [rows];
    return arr.find((r) => r.title === "Themed Window" && r.png) ?? null;
  };
  const iconPixel = (row) => {
    const buf = readFileSync(`${OUT}/${row.png}`);
    return pngPixelAt(buf, 128, 128);
  };
  const lightRow = rec();
  check("④d light window ICON_BIG is the raw light variant", !!lightRow && near(iconPixel(lightRow), GREEN), lightRow ? hex(iconPixel(lightRow)) : "no window record");
  await winInvoke("set_plugin_color_mode", { id: "themed-window", mode: "dark" });
  await sleep(1500);
  check("④e plugin window theme pinned dark", (await winT.conn.evalJs("document.documentElement.dataset.theme")) === "dark");
  const darkRow = rec();
  check("④f dark window ICON_BIG is the raw dark variant (no inversion)",
    !!darkRow && near(iconPixel(darkRow), AMBER), darkRow ? hex(iconPixel(darkRow)) : "no window record");
  await winInvoke("set_plugin_color_mode", { id: "themed-window", mode: "light" });
  await sleep(1500);
  const backRow = rec();
  check("④g flip back re-picks the light variant",
    !!backRow && near(iconPixel(backRow), GREEN), backRow ? hex(iconPixel(backRow)) : "no window record");
  winT.conn.ws.close();
}

console.log(`\nPLUGIN THEMED ICON VERIFY ${pass}/${pass + fail}${fail ? " — FAIL" : " — PASS"}`);
process.exit(fail ? 1 : 0);
