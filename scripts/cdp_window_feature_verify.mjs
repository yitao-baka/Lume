// 活动窗口匹配验证（docs/ROADMAP_HISTORY.md #29 / [[features]] type="window"）：
//   ① 匹配      真实前台窗口（PowerShell WinForms 夹具 + PID 前台激活 → toggle_launcher
//               呼出时 Rust 侧捕获 FocusState）→ 空查询主菜单出现「窗口工具」行
//               （#43 起落在「推荐使用」栏，最近使用/已固定栏保持渲染，不再以
//               网格替代栏目条）；process 维度（exe 名/stem OR）与
//               process+title AND 维度
//   ② 负例      标题不含 `LUME_WINDOW_B` 的夹具 → AND 规则不出行
//   ③ 激活      点行 → onFeature 收到 info.window（process/className/title）
//   ④ 一次性    前台换成非编辑器后行消失（summon-scoped）
//   ⑤ app.foreground(ctx 层)  权限拒绝/放行 + 快照形状 + 未知插件 fail-closed
// 边界：Explorer 的 class 维度（CabinetWClass）与 path 解析依赖真实 Explorer
// 窗口激活，自动化不稳定 —— 由 window-demo 的手工步骤覆盖（docs/TESTING.md）。
// 说明：编辑器依赖本机 notepad/Notepad3 的替换关系与中文标题编码，自动化
// 改为启动两个 ASCII 标题的 PowerShell WinForms 窗口，按 PID 激活并验证
// 前台归属；测试 plugin 的 process 规则匹配 powershell/pwsh。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
function cleanupFixtures() {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'LUME_WINDOW_*' } | Stop-Process -Force"`,
      { stdio: "ignore" }
    );
  } catch {}
}
cleanupFixtures();

const BASE = "src-tauri/target/debug";
const CDP_PORT = 9237;
mkdirSync("test", { recursive: true });
rmSync(`${BASE}/plugins/window-demo`, { recursive: true, force: true });
cpSync(`examples/plugins/window-demo`, `${BASE}/plugins/window-demo`, { recursive: true });

// 自动化断言用脚本生成的测试插件；process 匹配 PowerShell 宿主进程。
const TEST_PLUGIN = `${BASE}/plugins/window-test`;
rmSync(TEST_PLUGIN, { recursive: true, force: true });
mkdirSync(TEST_PLUGIN, { recursive: true });
writeFileSync(
  `${TEST_PLUGIN}/plugin.toml`,
  'id = "window-test"\nname = "Window Test"\nkind = "provider"\nentry = "main.js"\npermissions = ["window"]\n\n' +
    '[[features]]\ncode = "editor"\nlabel = "窗口工具：编辑器（process）"\ntype = "window"\nprocess = ["powershell", "pwsh"]\n\n' +
    '[[features]]\ncode = "editor-verified"\nlabel = "窗口工具：编辑器（验证用）"\ntype = "window"\nprocess = ["powershell", "pwsh"]\ntitle = ["LUME_WINDOW_B"]\n'
);
writeFileSync(
  `${TEST_PLUGIN}/main.js`,
  'export default function create(ctx) { return { async search(q) { return []; }, onFeature(info) { const w = info.window ?? {}; ctx.app.toast("命中窗口规则「" + info.code + "」：进程 " + w.process + "｜类名 " + w.className + "｜标题「" + w.title + "」"); } }; }\n'
);

// Fixture windows: A has no marker (AND-rule negative), B carries the ASCII
// title marker (positive). Activation is PID-based and verifies that Windows
// really handed the foreground to that process before Lume samples it.
const FIXTURE_PS1 = process.cwd().replaceAll("/", "\\") + "\\test\\window_fixture.ps1";
const ACTIVATE_PS1 = process.cwd().replaceAll("/", "\\") + "\\test\\window_activate.ps1";
writeFileSync(
  FIXTURE_PS1,
  `param([string]$Title)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 460
$form.Height = 180
$form.StartPosition = 'CenterScreen'
$label = New-Object System.Windows.Forms.Label
$label.Text = "Lume window fixture: $Title"
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(20, 20)
$form.Controls.Add($label)
[System.Windows.Forms.Application]::Run($form)
`
);
writeFileSync(
  ACTIVATE_PS1,
  `param([int]$TargetPid)
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Foreground {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool on);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
for ($i = 0; $i -lt 20; $i++) {
  $p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250; continue }
  $hwnd = $p.MainWindowHandle
  $fg = [Win32Foreground]::GetForegroundWindow()
  [uint32]$fgPid = 0
  $fgThread = [Win32Foreground]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  $curThread = [Win32Foreground]::GetCurrentThreadId()
  [Win32Foreground]::AttachThreadInput($fgThread, $curThread, $true) | Out-Null
  [Win32Foreground]::ShowWindow($hwnd, 9) | Out-Null
  [Win32Foreground]::SetForegroundWindow($hwnd) | Out-Null
  [Win32Foreground]::AttachThreadInput($fgThread, $curThread, $false) | Out-Null
  Start-Sleep -Milliseconds 200
  $now = [Win32Foreground]::GetForegroundWindow()
  [uint32]$nowPid = 0
  [Win32Foreground]::GetWindowThreadProcessId($now, [ref]$nowPid) | Out-Null
  if ($nowPid -eq $TargetPid) { Write-Output "True"; exit 0 }
  Start-Sleep -Milliseconds 250
}
Write-Output "False"
exit 1
`
);
function startFixture(title) {
  return spawn(
    "powershell.exe",
    ["-NoProfile", "-STA", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", FIXTURE_PS1, title],
    { stdio: "ignore" }
  );
}
function activate(pid) {
  try {
    return execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${ACTIVATE_PS1}" ${pid}`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim() === "True";
  } catch {
    return false;
  }
}

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const logFd = openSync("test/window_feature_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(500); }
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
    if (r?.result?.exceptionDetails) {
      const ex = r.result.exceptionDetails.exception;
      throw new Error(String(ex?.description ?? ex?.value ?? "eval failed"));
    }
    return r?.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("test/" + name, Buffer.from(r.result.data, "base64"));
  };
  return { ws, evalJs, shot };
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
const invoke = async (cmd, args = {}) => await m.evalJs(
  `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
);
const tryInvoke = async (cmd, args = {}) => {
  try { return { ok: await invoke(cmd, args) }; }
  catch (e) { return { err: String(e) }; }
};
async function invokeRetry(cmd, args = {}, tries = 20) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await invoke(cmd, args); }
    catch (e) {
      last = e;
      if (!String(e).includes("state not managed")) throw e;
      await sleep(250);
    }
  }
  throw last;
}
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const rowNames = () => m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
const clickRow = (name) => m.evalJs(`(() => { const b = Array.from(document.querySelectorAll(".result-box")).find((x) => x.querySelector(".result-box-name")?.textContent === ${JSON.stringify(name)}); if (!b) return "missing"; b.click(); return "clicked"; })()`);
const toastText = () => m.evalJs(`document.querySelector(".toast-text")?.textContent ?? ""`);
async function clickAndToast(name, timeoutMs = 5000) {
  const clicked = await clickRow(name);
  let text = "";
  for (let waited = 0; waited < timeoutMs && !text; waited += 150) {
    await sleep(150);
    text = await toastText();
  }
  return { clicked, text };
}
async function summon() {
  // 呼出（hide → show）：show 分支捕获当前前台窗口到 FocusState，前端在
  // launcher-shown 流程里拉取上下文并渲染 window 行。「记住上次所在页面」
  // 可能把模式留在插件页 —— window 行是导航页空查询主菜单的东西，先回导航。
  await invoke("toggle_launcher");
  await sleep(600);
  await invoke("toggle_launcher");
  await sleep(2200);
  await m.evalJs(`document.querySelector(".mode-switch-item")?.click()`);
  await sleep(600);
  await type("");
  await sleep(900);
}

// plog tap（DevTools console → __plog）
await m.evalJs(`(() => {
  if (window.__plog) return "already";
  window.__plog = [];
  for (const level of ["debug", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { window.__plog.push(level + ": " + a.map(String).join(" ")); orig(...a); };
  }
  return "hooked";
})()`);

// #43：先固定一个应用，让「已固定栏与推荐使用栏并存」的断言真实成立
// （cmd.exe 不启动，只写 pins；文末撤销）。
const CMD_EXE = "C:\\Windows\\System32\\cmd.exe";
let pinned = false;
try {
  await invokeRetry("pin_app", { path: CMD_EXE, name: "cmd" });
  pinned = true;
} catch (e) {
  console.error("pin_app setup failed:", e);
}
check("pin_app setup completed", pinned);

// ── 预热：启动编辑器 A，首次呼出让清单/插件/前台管线就绪 ──
const fixtureA = startFixture("LUME_WINDOW_A");
await sleep(1500);
check("fixture A got the foreground", activate(fixtureA.pid));
await invoke("toggle_launcher");
await sleep(2200);
await invoke("toggle_launcher");
await sleep(800);

// ── ① + ② 编辑器 A（标题无「验证用」）：process 规则命中、AND 规则不命中 ──
check("fixture A re-activated for summon", activate(fixtureA.pid));
await summon();
// 诊断：summon 时宿主抓到的前台快照（window-test 有 window 权限）。
const snapDiag = await tryInvoke("plugin_foreground_context", { pluginId: "window-test" });
console.log("  [diag] summon-time snapshot:", JSON.stringify(snapDiag.ok ?? snapDiag.err));
const plogLines = await m.evalJs(`window.__plog.filter((l) => l.includes("foreground") || l.includes("window-test") || l.includes("loaded"))`);
console.log("  [diag] plog foreground lines:", JSON.stringify(plogLines));
const raceDiag = await m.evalJs(`Promise.race([
  window.__TAURI_INTERNALS__.invoke("get_foreground_context"),
  new Promise((r) => setTimeout(() => r("TIMEOUT"), 5000)),
])`);
console.log("  [diag] get_foreground_context race:", JSON.stringify(raceDiag));
const manifestDiag = await tryInvoke("get_plugins");
const wt = (manifestDiag.ok ?? []).find((p) => p.id === "window-test");
console.log("  [diag] window-test manifest:", JSON.stringify(wt ? { enabled: wt.enabled, features: wt.features } : null));
let names = await rowNames();
console.log("  [diag] all rows:", JSON.stringify(names));
check("editor foreground: process 规则出行",
  names.some((n) => n.includes("窗口工具：编辑器（process）")), JSON.stringify(names.filter((n) => n.includes("窗口"))));
check("AND 规则负例：标题无「验证用」不出行",
  !names.some((n) => n.includes("窗口工具：编辑器（验证用）")), JSON.stringify(names.filter((n) => n.includes("窗口"))));

// #43：window 行落在「推荐使用」栏，不再以网格顶掉最近的栏目条。
const barIds = await m.evalJs(`Array.from(document.querySelectorAll(".bar-grid")).map((g) => g.dataset.barId)`);
check("window row lands in the 推荐使用 section", barIds.includes("recommended"), JSON.stringify(barIds));
check("bars stay visible (no forced grid) beside 推荐使用",
  !(await m.evalJs(`!!document.querySelector(".result-grid")`)), JSON.stringify(barIds));
if (((await invoke("get_recent_apps")) ?? []).length > 0) {
  check("最近使用 bar still rendered", barIds.includes("recent"), JSON.stringify(barIds));
}
if (((await invoke("get_pinned_apps")) ?? []).length > 0) {
  check("已固定 bar still rendered", barIds.includes("pinned"), JSON.stringify(barIds));
}

// ── ③ 激活：onFeature 收到窗口信息 ──
const editorRow = names.find((n) => n.includes("窗口工具：编辑器（process）"));
if (editorRow) {
  const { clicked, text } = await clickAndToast(editorRow);
  check("window row clicked", clicked === "clicked", text);
  check("onFeature got the window payload (code + fields)",
    text.includes("命中窗口规则「editor」") && text.includes("进程") && text.includes("标题")
    && !text.includes("undefined"), text);
} else {
  check("window row clickable", false, "row missing");
}

// ── ① 编辑器 B（标题含 LUME_WINDOW_B）：两条规则都出行 ──
fixtureA.kill();
await sleep(600);
const fixtureB = startFixture("LUME_WINDOW_B");
await sleep(1500);
check("fixture B got the foreground", activate(fixtureB.pid));
await summon();
names = await rowNames();
check("AND 规则正例：标题含「验证用」出行",
  names.some((n) => n.includes("窗口工具：编辑器（验证用）")), JSON.stringify(names.filter((n) => n.includes("窗口"))));
check("两条规则同时出行（不同 code 的行并存）",
  names.filter((n) => n.includes("窗口工具")).length === 2, JSON.stringify(names.filter((n) => n.includes("窗口"))));

// ── ④ 前台不再是编辑器：process 规则消失 ──
fixtureB.kill();
await sleep(800);
await summon();
names = await rowNames();
check("前台不再是编辑器：process 规则消失",
  !names.some((n) => n.includes("窗口工具：编辑器（process）")), JSON.stringify(names.filter((n) => n.includes("窗口"))));

// ── ⑤ app.foreground：权限拒绝 + 放行形状 ──
const denied = await tryInvoke("plugin_foreground_context", { pluginId: "web-search" });
check("未声明 window 权限 → 明确拒绝",
  denied.err && denied.err.includes("window"), denied.err);
const granted = await tryInvoke("plugin_foreground_context", { pluginId: "window-test" });
check("声明 window 权限 → 返回快照（可为 null）",
  !granted.err && (granted.ok === null || typeof granted.ok === "object"),
  JSON.stringify(granted.ok ?? granted.err));
if (granted.ok) {
  check("快照字段齐全", typeof granted.ok.process === "string"
    && typeof granted.ok.className === "string" && typeof granted.ok.title === "string",
    JSON.stringify(granted.ok));
}
const ghost = await tryInvoke("plugin_foreground_context", { pluginId: "ghost-id" });
check("未知插件 fail-closed", ghost.err && ghost.err.includes("permission denied"), ghost.err);

await m.shot("window_feature_rows.png");

// 清场
await invoke("unpin_app", { path: CMD_EXE }).catch(() => {});
cleanupFixtures();
rmSync(TEST_PLUGIN, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
