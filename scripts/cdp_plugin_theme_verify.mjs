// 插件自身颜色模式验证（docs/ROADMAP_HISTORY.md #36）：插件用 `lume.theme.set` 改自己的明暗，
// 启动器不受影响；launcher 内嵌页与独立窗口两条路径都在覆盖内。
//   ① 基线    启动器浅色、hello-mode 无偏好 → 页面画布 = 面板色（浅）
//   ② 驱动    搜索框输入 theme:dark（示例页 on.query 里调 lume.theme.set，
//            与它那颗按钮同一段代码、同一条桥接 RPC）→ 画布转深、启动器仍浅、
//            settings.plugins.color_modes 落盘、__pluginThemes/__themeLog 有记录
//   ③ 反向    启动器切深色 + 插件 pin "light" → 画布浅、启动器面板深
//            （"只作用于插件本身"的核心断言）
//   ④ 独立窗口 分离 → 窗口 chrome（data-theme）与窗口内画布都是插件色，
//            而启动器仍是自己的色
//   ⑤ 回传    独立窗口内改偏好 → Rust 事件回传启动器镜像（source="window"）；
//            关窗回启动器再进 → 画布仍是插件 pin 的值
// 采样：CDP 1×1 clip 截图 + zlib 解 PNG —— 页面画布颜色是推送值的直接可见
// 结果（桥接把 mode 写进 --lume-page-bg），比读沙箱内 DOM 可靠（沙箱帧的
// CDP DOM/execution context 对宿主 target 不可见，DOM.getDocument pierce
// 也查不到 —— 实测）。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, openSync } from "node:fs";
import { inflateSync } from "node:zlib";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
mkdirSync("test", { recursive: true });
rmSync(`${BASE}/plugins/hello-mode`, { recursive: true, force: true });
cpSync(`examples/plugins/hello-mode`, `${BASE}/plugins/hello-mode`, { recursive: true });
const logFd = openSync("test/plugin_theme_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9231" },
  stdio: ["ignore", logFd, logFd],
});

const PORT = 9231;
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
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("test/" + name, Buffer.from(r.result.data, "base64"));
  };
  /** One CSS pixel of the rendered page (CDP clip, scale 1) → [r,g,b,a]. */
  const pixel = async (x, y) => {
    const r = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1, scale: 1 },
    });
    return pngPixel(Buffer.from(r.result.data, "base64"));
  };
  return { ws, evalJs, shot, pixel, send };
}

/** Minimal 8-bit PNG decode (node has zlib; no image dependency). */
function pngPixel(buf) {
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
  const ch = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : ctype === 0 ? 1 : 0;
  if (!ch || depth !== 8) throw new Error(`unsupported png (ctype ${ctype}, depth ${depth})`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0, x = line[i];
      cur[i] = (filter === 0 ? x
        : filter === 1 ? x + a
        : filter === 2 ? x + b
        : filter === 3 ? x + ((a + b) >> 1)
        : x + paeth(a, b, c)) & 255;
    }
  }
  const off = (h - 1) * stride; // 1×1 in practice; sample the last row if bigger
  return [out[off], out[off + 1], out[off + 2], ch === 4 ? out[off + 3] : 255];
}

const SURFACE = { dark: [30, 30, 32], light: [251, 251, 253] };
const near = (px, ref, tol = 6) => px.slice(0, 3).every((v, i) => Math.abs(v - ref[i]) <= tol);
const hex = (px) => "#" + px.slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("");

async function findWindow(match, probe) {
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes(match));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      const ok = probe ? await probe(c) : true;
      if (ok) return { target: t, conn: c };
      c.ws.close();
    } catch {}
  }
  return null;
}
async function findMain() {
  return findWindow("tauri.localhost", async (c) => {
    const ok = await c.evalJs(`!!document.getElementById("search-input")`);
    c.ws.close();
    return ok;
  });
}

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : " — " + extra));
  ok ? pass++ : fail++;
};

let mainT = await findMain();
for (let i = 0; i < 40 && !mainT; i++) { await sleep(500); mainT = await findMain(); }
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
const m = await connect(mainT.target.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
/** Type into the launcher's search box (the host's own input path). */
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const launcherTheme = () => m.evalJs(`document.documentElement.dataset.theme`);
/** The launcher's OWN panel color — read at the search row, which no plugin
 * page ever covers. */
const panelPoint = () => m.evalJs(`(() => { const r = document.querySelector(".search-row, .launcher").getBoundingClientRect(); return { x: r.left + 12, y: r.top + 4 }; })()`);
/** The plugin page's canvas: inside the frame's padding (hello-mode: 18px top,
 * 22px left), so the sample never lands on text or a button border. */
const pagePoint = (c) => c.evalJs(`(() => { const f = document.querySelector(".plugin-frame"); if (!f) return null;
  const r = f.getBoundingClientRect(); return { x: r.left + 8, y: r.top + 8, w: Math.round(r.width), h: Math.round(r.height) }; })()`);
const setSettings = async (patch) => {
  const s = await invoke("get_settings");
  Object.assign(s.appearance, patch.appearance ?? {});
  if (patch.colorModes !== undefined) s.plugins.color_modes = patch.colorModes;
  await invoke("save_settings", { new: s });
  await sleep(1200);
};
const themeTap = () => m.evalJs(`((window).__pluginThemes ?? []).filter((e) => e.id === "hello-mode")`);
const themeLog = () => m.evalJs(`((window).__themeLog ?? []).filter((e) => e.id === "hello-mode" && e.mode === "dark")`);
const colorModes = async () => (await invoke("get_settings")).plugins?.color_modes ?? {};
/** Enter hello-mode from the launcher: keyword row + Enter. */
async function enterHelloMode() {
  await type("hello");
  await sleep(1500);
  const idx = await m.evalJs(`[...document.querySelectorAll(".result-box")].findIndex((el) => el.textContent.includes("进入 Hello Mode"))`);
  if (idx < 0) return false;
  await m.evalJs(`[...document.querySelectorAll(".result-box")][${idx}].dispatchEvent(new MouseEvent("click", { bubbles: true })); "ok"`);
  await sleep(250);
  await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))`);
  await sleep(2500);
  return true;
}
/** Drive the plugin page's own color-mode call through the search box (the
 * example's on.query hook → the same `lume.theme.set` its button uses). */
async function driveTheme(mode) {
  await type("theme:" + mode);
  await sleep(1400);
}
/** Same, in the detached window: there is no search box there, so the query
 * arrives over the launcher's own `plugin_window_push_state` channel (the same
 * push a real query takes) and the page's handler does the rest. */
async function driveThemeInWindow(mode) {
  await invoke("plugin_window_push_state", {
    id: "hello-mode",
    state: { query: "theme:" + mode },
  });
  await sleep(1400);
}

// 自愈：脚本自身改过设置，中途被杀会留下禁用态 / 残留偏好。
await invoke("set_plugin_enabled", { id: "hello-mode", enabled: true });
await sleep(800);
// ① 基线：启动器浅色 + 清空本插件偏好
await setSettings({ appearance: { color_mode: "light" }, colorModes: {} });
await invoke("toggle_launcher");
await sleep(1500);
check("①a launcher color mode is light (baseline)", (await launcherTheme()) === "light", await launcherTheme());

// ② 进入 hello-mode
check("②a entered hello-mode via the keyword row", await enterHelloMode());
const area0 = await pagePoint(m);
check("②b mode page mounted (sandboxed iframe)", !!area0, JSON.stringify(area0));
if (!area0) { console.log(`\nPLUGIN THEME VERIFY FAILED (${pass}/${pass + fail})`); process.exit(1); }
const pp = await panelPoint();
const panel0 = await m.pixel(pp.x, pp.y);
const page0 = await m.pixel(area0.x, area0.y);
check("②c page canvas follows the launcher (light surface)",
  near(page0, SURFACE.light) && near(panel0, SURFACE.light),
  `panel ${hex(panel0)} / page ${hex(page0)}`);
// 只看插件自己 pin 的记录：上一轮的设置残留会在启动时种进镜像（source
// "settings"），那是持久化生效的证据，不是本轮插件行为。
check("②d plugin has not pinned anything yet",
  !(await themeTap()).some((e) => e.source === "main" || e.source === "window"), JSON.stringify(await themeTap()));

// ③ theme.set("dark") —— 页面画布转深，启动器不动
await driveTheme("dark");
const page1 = await m.pixel(area0.x, area0.y);
const panel1 = await m.pixel(pp.x, pp.y);
check("③a page canvas turned dark (theme push honoured)", near(page1, SURFACE.dark), hex(page1));
check("③b launcher panel STAYED light (override is plugin-scoped)", near(panel1, SURFACE.light), hex(panel1));
check("③c launcher data-theme untouched", (await launcherTheme()) === "light", await launcherTheme());
check("③d preference persisted to settings", (await colorModes())["hello-mode"] === "dark", JSON.stringify(await colorModes()));
check("③e mirror recorded the pin (source main)", (await themeTap()).some((e) => e.pref === "dark" && e.source === "main"), JSON.stringify(await themeTap()));
check("③f page was told theme=dark (event tap)", (await themeLog()).length > 0, JSON.stringify(await themeLog()));

// ④ 反向：启动器切深色 + 插件 pin "light" → 画布浅、面板深
await setSettings({ appearance: { color_mode: "dark" } });
await invoke("toggle_launcher");
await sleep(1500);
const pagePinDark = await m.pixel(area0.x, area0.y);
check("④a pinned dark survives the launcher's flip", near(pagePinDark, SURFACE.dark), hex(pagePinDark));
check("④b launcher panel is now dark", near(await m.pixel(pp.x, pp.y), SURFACE.dark), hex(await m.pixel(pp.x, pp.y)));
await driveTheme("light");
const page2 = await m.pixel(area0.x, area0.y);
const panel2 = await m.pixel(pp.x, pp.y);
check("④c page canvas turned light while the launcher is dark",
  near(page2, SURFACE.light) && near(panel2, SURFACE.dark), `panel ${hex(panel2)} / page ${hex(page2)}`);
await m.shot("plugin_theme_launcher.png");
const launcherBeforeDetach = await launcherTheme();

// ⑤ 独立窗口：chrome 与画布都跟插件走
await m.evalJs(`document.querySelector(".detach-btn").click(); "ok"`);
await sleep(2500);
let pw = null;
for (let i = 0; i < 20 && !pw; i++) { pw = await findWindow("plugin.html?plugin=hello-mode"); if (!pw) await sleep(400); }
check("⑤a detached window created", !!pw);
if (!pw) { console.log(`\nPLUGIN THEME VERIFY FAILED (${pass}/${pass + fail})`); process.exit(1); }
const w = pw.conn;
const winTheme = () => w.evalJs(`document.documentElement.dataset.theme`);
check("⑤b window chrome follows the PLUGIN (light) not the launcher (dark)",
  (await winTheme()) === "light" && launcherBeforeDetach === "dark",
  `window ${await winTheme()} / launcher ${launcherBeforeDetach}`);
let wArea = null;
for (let i = 0; i < 20 && !wArea; i++) { wArea = await pagePoint(w); if (!wArea) await sleep(400); }
check("⑤c detached page mounted", !!wArea, JSON.stringify(wArea));
const wPage = wArea ? await w.pixel(wArea.x, wArea.y) : null;
check("⑤d detached page canvas is the plugin mode (light)", !!wPage && near(wPage, SURFACE.light), wPage ? hex(wPage) : "no page");
const pushed = await w.evalJs(`((window).__pluginStates ?? []).filter((s) => s.theme).map((s) => s.theme)`);
check("⑤e launcher pushed the plugin's effective mode across windows",
  pushed.includes("light") && !pushed.includes("dark"), JSON.stringify(pushed));
await w.shot("plugin_theme_window.png");

// ⑥ 独立窗口内改偏好 → 回传启动器镜像
await driveThemeInWindow("dark");
await sleep(800);
check("⑥a window chrome flipped to dark (set from the detached window)", (await winTheme()) === "dark", await winTheme());
check("⑥b detached page canvas flipped too", wArea && near(await w.pixel(wArea.x, wArea.y), SURFACE.dark), wArea ? hex(await w.pixel(wArea.x, wArea.y)) : "no page");
check("⑥c preference persisted from the window", (await colorModes())["hello-mode"] === "dark", JSON.stringify(await colorModes()));
const tap6 = await themeTap();
check("⑥d launcher mirror updated by the cross-window event (source window)",
  tap6.some((e) => e.pref === "dark" && e.source === "window"), JSON.stringify(tap6));

// ⑦ 独立窗口不接受启动器的翻转：启动器转浅色，窗口仍是插件 pin 的深色
await setSettings({ appearance: { color_mode: "light" } });
await sleep(800);
check("⑦a pinned window ignores the launcher's flip (chrome stays dark)", (await winTheme()) === "dark", await winTheme());
check("⑦b pinned window's page still dark", wArea && near(await w.pixel(wArea.x, wArea.y), SURFACE.dark), wArea ? hex(await w.pixel(wArea.x, wArea.y)) : "no page");
await w.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); "ok"`);
await sleep(2000);
check("⑦c Esc closed the detached window", !(await findWindow("plugin.html?plugin=hello-mode")));

// ⑧ 回到启动器：启动器浅色、插件仍 pin 深色 → 页面画布必须是深色
await invoke("toggle_launcher");
await sleep(1800);
check("⑧a re-entered hello-mode in the launcher", await enterHelloMode());
const area8 = await pagePoint(m);
const page8 = area8 ? await m.pixel(area8.x, area8.y) : null;
const panel8 = await m.pixel(pp.x, pp.y);
check("⑧b pinned dark honoured after returning, launcher stays light",
  !!page8 && near(page8, SURFACE.dark) && near(panel8, SURFACE.light),
  `panel ${hex(panel8)} / page ${page8 ? hex(page8) : "no page"}`);

// 收尾：清掉本插件偏好，别把测试状态留给下一次运行
await setSettings({ colorModes: {} });
m.ws.close();
console.log(`\nPLUGIN THEME VERIFY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
