// P1 验证（ROADMAP #24）：宿主能力面。
//   ① HTTP：webview 直连被 CORS 挡住，宿主 http.request 同一 URL 成功；
//   ② 通知：plugin_notify 注册隐藏图标 + 弹气泡（截屏核对）；
//   ③ 剪贴板：图片写入 → PowerShell 读回；文件列表写→读往返；
//   ④ 对话框：原生选择框 ESC 取消 → 解析为 []（非错误）；
//   ⑤ 屏幕：光标位置在主屏范围内、显示器数量正确；
//   ⑥ 粘贴：写入并 Ctrl+V 到前台窗口后启动器隐藏。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 18771;

// ── ① 本地测试服务器：故意不发 CORS 头 ──
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.stringify({ path: req.url, method: req.method, body, host: req.headers.host });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(payload);
  });
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
console.log(`test server on http://127.0.0.1:${PORT}`);

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
// stderr → test/p1_lume.log so the Rust-side [plugins]/[clipboard] diagnostics
// are inspectable after a run (the paste fallback branch logs there).
const logFd = openSync("test/p1_lume.log", "w");
spawn("src-tauri/target/debug/lume.exe", [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223" },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch("http://127.0.0.1:9223/json/list")).json(); } catch { await sleep(500); }
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
    if (r?.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails));
    return r?.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("test/" + name, Buffer.from(r.result.data, "base64"));
  };
  return { ws, evalJs, shot };
}
const ps = (cmd) => execSync(`powershell -NoProfile -STA -Command "${cmd.replace(/"/g, '\\"')}"`, { encoding: "utf8" }).trim();

mkdirSync("test", { recursive: true });
let mainT = null;
for (let i = 0; i < 40 && !mainT; i++) {
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      if (await c.evalJs(`!!document.getElementById("search-input")`)) { mainT = t; c.ws.close(); break; }
      c.ws.close();
    } catch {}
  }
  if (!mainT) await sleep(500);
}
if (!mainT) { console.error("main missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const clickRow = (name) => m.evalJs(`(() => { const b = Array.from(document.querySelectorAll(".result-box")).find((x) => x.querySelector(".result-box-name")?.textContent === ${JSON.stringify(name)}); if (!b) return "missing"; b.click(); return "clicked"; })()`);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS" : "FAIL") + " " + name + (extra ? " — " + extra : "")); ok ? pass++ : fail++; };

await invoke("toggle_launcher");
await sleep(1500);

// ── ① CORS 对比：页面直连失败，宿主成功 ──
const direct = await m.evalJs(`fetch("http://127.0.0.1:${PORT}/echo").then((r) => "ok " + r.status).catch((e) => "blocked: " + e.message)`);
check("webview direct fetch is CORS-blocked (no ACAO header)", String(direct).startsWith("blocked"), String(direct));
const viaHost = await invoke("plugin_http_fetch", { req: { url: `http://127.0.0.1:${PORT}/echo?q=1`, timeout_ms: 8000 } });
const hostBody = viaHost?.body ? Buffer.from(viaHost.body, "base64").toString("utf8") : "";
check("host http.request succeeds on the same URL", viaHost?.status === 200 && hostBody.includes('"path":"/echo?q=1"'), `status=${viaHost?.status} body=${hostBody}`);
check("host http.request returns response headers", (viaHost?.headers?.["content-type"] ?? "").includes("application/json"), JSON.stringify(viaHost?.headers));

// provider 面板：h: 前缀列出动作行
await type("h:");
await sleep(1800);
let names = await m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
check("h: lists the host-tool actions", names.filter((n) => n.startsWith("h: ")).length >= 6, JSON.stringify(names));

// ── ② 通知（先弹气泡，立刻截屏右下角对比） ──
// The shell accepting the call is the assertion; whether a balloon actually
// renders depends on the machine's notification settings, so the visual part
// is reported, not asserted (this dev box suppresses ALL notification
// balloons — even a PowerShell NotifyIcon control experiment shows nothing).
const corner = (name) => ps(`Add-Type -AssemblyName System.Drawing,System.Windows.Forms; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $w=560;$h=400;$img=New-Object System.Drawing.Bitmap($w,$h); $g=[System.Drawing.Graphics]::FromImage($img); $g.CopyFromScreen($b.Width-$w,$b.Height-$h,0,0,(New-Object System.Drawing.Size($w,$h))); $img.Save('test/${name}'); 'ok'`);
const before = corner("p1_notify_before.png");
const notified = await invoke("plugin_notify", { title: "Lume P1 验证", body: "宿主通知：气泡应出现在右下角", pluginId: "host-tools" });
await sleep(600);
corner("p1_notify_after.png");
const sameBytes = readFileSync("test/p1_notify_before.png").equals(readFileSync("test/p1_notify_after.png"));
check("plugin_notify accepted by the shell", notified === null, String(notified));
console.log(
  sameBytes
    ? "NOTE 没有捕捉到气泡像素变化 —— 本机可能关闭了通知/处于专注助手状态（对照实验：PowerShell NotifyIcon 同样不显示）。注册与投递已被 shell 接受，视觉确认需在开启通知的环境复验。"
    : "NOTE 检测到右下角像素变化 → 气泡已显示（截图 test/p1_notify_after.png）。"
);

// ── ③ 剪贴板：图片写入读回 ──
const pngB64 = await m.evalJs(`(() => { const c = document.createElement("canvas"); c.width = 40; c.height = 24; const g = c.getContext("2d"); g.fillStyle = "#4aa3ff"; g.fillRect(0,0,40,24); return c.toDataURL("image/png").split(",")[1]; })()`);
await invoke("plugin_clipboard_write_image", { data: pngB64 });
await sleep(400);
const imgInfo = ps(`Add-Type -AssemblyName System.Windows.Forms; $i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){"$($i.Width)x$($i.Height)"}else{"none"}`);
check("clipboard holds the written image (read back via shell)", imgInfo === "40x24", imgInfo);

// 文件列表写→读往返
const filesIn = ["C:\\Windows\\win.ini", "C:\\Windows\\system.ini"];
await invoke("plugin_clipboard_write_files", { paths: filesIn });
await sleep(300);
const filesBack = await invoke("plugin_clipboard_read_files");
check("clipboard file list round-trips", JSON.stringify(filesBack) === JSON.stringify(filesIn), JSON.stringify(filesBack));

// ── ④ 对话框：打开后 ESC 取消（异步命令不被阻塞，取消解析为 []） ──
const dlgPromise = m.evalJs(`window.__TAURI_INTERNALS__.invoke("plugin_dialog_open", { params: { title: "P1 smoke" } })`);
await sleep(2200); // the native picker is up now
try { ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ESC}')`); } catch (err) { console.log("sendkeys failed:", String(err).slice(0, 100)); }
await sleep(1500);
const dlgResult = await dlgPromise;
check("dialog.open resolves to [] when cancelled", Array.isArray(dlgResult) && dlgResult.length === 0, JSON.stringify(dlgResult));

// ── ⑤ 屏幕信息 ──
const pos = await invoke("plugin_cursor_pos");
const displays = await invoke("plugin_displays");
const inside = (displays ?? []).some((d) => pos.x >= d.x && pos.x < d.x + d.width && pos.y >= d.y && pos.y < d.y + d.height);
check("cursor is inside a reported display", inside, JSON.stringify(pos) + " in " + (displays ?? []).length + " display(s)");
check("exactly one primary display reported", (displays ?? []).filter((d) => d.primary).length === 1);

// ── ⑥ 粘贴：写入文本并 Ctrl+V（走完整 auto-paste 路径 → 隐藏启动器） ──
// NOTE: document.visibilityState stays "visible" when a WebView2 window is
// hidden (verified), so the window state is probed from the OS side instead
// (scripts/ps_lume_windows.ps1 — Tao's internal event-target window is always
// visible and is excluded there).
// The dialog test above blurred the launcher (auto-hide on focus loss), so
// re-summon it first — same order a real paste has: summon → paste.
await invoke("toggle_launcher");
await sleep(1200);
const winState = () => ps(`E:\\SoftwareDevelopment\\Projects\\LumeLauncher\\scripts\\ps_lume_windows.ps1`);
check("launcher visible before the paste", /visible=1/.test(winState()), winState());
await invoke("plugin_clipboard_paste", { text: "P1 paste check" });
await sleep(1200);
check("clipboard.paste hid the launcher (auto-paste flow ran)", /visible=0/.test(winState()), winState());
const pasteLog = readFileSync("test/p1_lume.log", "utf8");
check("paste used the real paste path (no plain-copy fallback)", pasteLog.includes("[plugins] clipboard.paste: text") && !pasteLog.includes("copied without pasting"));
const clipText = ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()`);
check("pasted text stayed on the clipboard", clipText === "P1 paste check", clipText);

await m.shot("p1_panel.png");
console.log(`\n${pass} passed, ${fail} failed`);
server.close();
process.exit(fail ? 1 : 0);
