// 独立窗任务栏图标 / 身份回归（P6.8，ROADMAP #34）。
//
//   ① 真实 detach file-search（关键字行进模式页 → 点「在独立窗口打开」）——
//      前端把 manifest `icon`（SVG）光栅化后随 plugin_window_open 上传，
//      Rust 转成 HICON 设到窗口上。断言：插件窗的 ICON_BIG 与启动器**不同**
//      （且非空）→ 任务栏/Alt+Tab 用插件自己的图标。
//   ② 断言插件窗的 AppUserModelID === "Lume.Plugin.file-search"（独立任务栏
//      项的身份；任务栏按钮因此不与其它 Lume 窗口合并）。
//   ③ 无 icon 的插件（hello-mode）→ ICON_BIG 与启动器**相同**（Lume 回退）。
//
//   任务栏像素本身（按钮分离/选中态）在 CI 式脚本里不可靠断言，这里断言的是
//   两个可编程事实（每窗口图标、窗口身份）；逐窗口图标位图存
//   test/plugin_icon_check/ 供人工比对。
//
//   node scripts/cdp_plugin_icon_verify.mjs
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, existsSync, openSync, readFileSync } from "node:fs";

const PORT = 9235;
const APP = "src-tauri/target/release/lume.exe";
const OUT = "test/plugin_icon_check";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" });
} catch {}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// Fixtures: prefer the installed copies (they ship detachable + titlebar).
for (const id of ["file-search", "hello-mode"]) {
  if (!existsSync(`src-tauri/target/release/plugins/${id}`)) {
    cpSync(`examples/plugins/${id}`, `src-tauri/target/release/plugins/${id}`, { recursive: true });
  }
}

// PowerShell dump: every Lume window's title / visibility / ICON_BIG sha1
// (SHGetPropertyStoreForWindow + IPropertyStore can't be used to read the
// AUMID back — the window store forwards it to the shell without persisting,
// so the taskbar identity is asserted through UI Automation instead, below).
// Output is a UTF-8 JSON file — the console codepage would mangle the
// Chinese titles.
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
  [DllImport("shell32.dll")] public static extern int SHGetPropertyStoreForWindow(IntPtr hwnd, ref Guid iid, out IntPtr store);
  [DllImport("ole32.dll")] public static extern int PropVariantClear(ref PROPVARIANT pv);

  [StructLayout(LayoutKind.Sequential, Pack = 4)]
  public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Explicit)]
  public struct PROPVARIANT {
    [FieldOffset(0)] public ushort vt;
    [FieldOffset(8)] public IntPtr ptr;
  }

  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IPropertyStore {
    void GetCount(out uint c);
    void GetAt(uint i, IntPtr key);
    void GetValue(ref PROPERTYKEY key, out PROPVARIANT v);
    void SetValue(ref PROPERTYKEY key, ref PROPVARIANT v);
    void Commit();
  }

  public static List<IntPtr> ProcWindows(int pid) {
    List<IntPtr> list = new List<IntPtr>();
    EnumWindows(delegate(IntPtr h, IntPtr lp) {
      uint p;
      GetWindowThreadProcessId(h, out p);
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
  public static string Aumid(IntPtr hwnd) {
    Guid iid = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    IntPtr p;
    if (SHGetPropertyStoreForWindow(hwnd, ref iid, out p) != 0 || p == IntPtr.Zero) { return null; }
    try {
      IPropertyStore store = (IPropertyStore)Marshal.GetObjectForIUnknown(p);
      PROPERTYKEY key;
      key.fmtid = new Guid("9f4c2855-9f79-4b39-a8d0-e1d42de1d5f3");
      key.pid = 5;
      PROPVARIANT pv;
      store.GetValue(ref key, out pv);
      string s = null;
      if (pv.vt == 31 && pv.ptr != IntPtr.Zero) { s = Marshal.PtrToStringUni(pv.ptr); }
      if (pv.vt != 0) { PropVariantClear(ref pv); }
      return s;
    } finally {
      Marshal.Release(p);
    }
  }
}
'@
[W]::SetProcessDPIAware() | Out-Null
$procs = @(Get-Process lume -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { "no lume process"; exit 1 }
$sha1 = [System.Security.Cryptography.SHA1]::Create()
$rows = @()
$i = 0
foreach ($pr in $procs) {
  foreach ($h in [W]::ProcWindows([int]$pr.Id)) {
    $i++
    $sha = $null
    $big = [W]::SendMessage($h, 0x7F, [IntPtr]1, [IntPtr]::Zero)
    if ($big -ne [IntPtr]::Zero) {
      try {
        $ico = [System.Drawing.Icon]::FromHandle($big)
        $bmp = $ico.ToBitmap()
        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bytes = $ms.ToArray()
        $sha = ([System.BitConverter]::ToString($sha1.ComputeHash($bytes)) -replace '-', '').ToLower()
        [System.IO.File]::WriteAllBytes(($PngDir + '/win' + $i + '_big.png'), $bytes)
        $ms.Dispose()
        $bmp.Dispose()
      } catch { }
    }
    $rows += [pscustomobject]@{
      hwnd = [int64]$h
      pid = $pr.Id
      title = [W]::TitleOf($h)
      visible = [W]::IsWindowVisible($h)
      iconSha1 = $sha
      aumid = [W]::Aumid($h)
    }
  }
}
$json = $rows | ConvertTo-Json -Depth 4
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
"saved " + $rows.Count + " window records"
`;
writeFileSync(OUT + "/dump.ps1", DUMP_PS);

// Taskbar identities via UI Automation: every taskbar button's AutomationId
// is "Appid: <AppUserModelID>" — the programmatic form of "the detached
// window has its own taskbar entry".
const TASKBAR_PS = String.raw`
param([string]$Out = "taskbar.json")
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$ids = @()
foreach ($cls in @("Shell_TrayWnd", "Shell_SecondaryTrayWnd")) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, $cls)
  $tb = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
  if ($tb -eq $null) { continue }
  $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $buttons = $tb.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
  foreach ($b in $buttons) {
    $aid = $b.Current.AutomationId
    if ($aid.StartsWith("Appid: ")) { $ids += $aid.Substring(7) }
  }
}
$json = $ids | ConvertTo-Json -Depth 2
if ($ids.Count -eq 0) { $json = "[]" }
[System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))
"saved " + $ids.Count + " taskbar app ids"
`;
writeFileSync(OUT + "/taskbar.ps1", TASKBAR_PS);

function taskbarIds() {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File ${OUT}/taskbar.ps1 -Out ${OUT}/taskbar.json`, {
    stdio: "ignore",
  });
  const parsed = JSON.parse(readFileSync(OUT + "/taskbar.json", "utf8"));
  return Array.isArray(parsed) ? parsed : [parsed];
}

const logFd = openSync(OUT + "/lume.log", "w");
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
});

async function listTargets() {
  try {
    return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  } catch {
    return null;
  }
}
async function findTarget(match) {
  const pages = ((await listTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes(match));
  return pages[0] ?? null;
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.id && p.has(d.id)) {
      p.get(d.id)(d);
      p.delete(d.id);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params) =>
    new Promise((res) => {
      const k = ++id;
      p.set(k, res);
      ws.send(JSON.stringify({ id: k, method, params }));
    });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    return r?.result?.result?.value;
  };
  return { ws, send, evalJs };
}

function dump() {
  execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File ${OUT}/dump.ps1 -Out ${OUT}/dump.json -PngDir ${OUT}`, {
    stdio: "ignore",
  });
  return JSON.parse(readFileSync(OUT + "/dump.json", "utf8"));
}

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : " — " + extra));
  ok ? pass++ : fail++;
};

// Launcher target.
let mainT = null;
for (let i = 0; i < 60 && !mainT; i++) {
  const pages = ((await listTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      if (await c.evalJs(`!!document.getElementById("search-input")`)) {
        mainT = t;
        c.ws.close();
        break;
      }
      c.ws.close();
    } catch {}
  }
  if (!mainT) await sleep(500);
}
if (!mainT) {
  console.error("launcher target missing");
  process.exit(1);
}
const m = await connect(mainT.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

await invoke("toggle_launcher");
await sleep(1500);
for (const id of ["file-search", "hello-mode"]) {
  const off = await m.evalJs(`window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => (s.plugins?.disabled ?? []).includes(${JSON.stringify(id)}))`);
  if (off) {
    await invoke("set_plugin_enabled", { id, enabled: true });
    await sleep(800);
  }
}

// Baseline: the launcher window's own ICON_BIG (the Lume theme icon). Several
// hidden windows (main / settings / preview) share the title "Lume" — any of
// them with an icon works as the fallback reference.
const baseline = dump();
const launcher = baseline.find((w) => w.title === "Lume" && w.iconSha1);
check("baseline: launcher ICON_BIG present", !!(launcher && launcher.iconSha1), JSON.stringify(baseline));

const clickKwRow = async (label) => {
  const idx = await m.evalJs(`[...document.querySelectorAll(".result-box")].findIndex((el) => el.textContent.includes(${JSON.stringify(label)}))`);
  if (idx < 0) return false;
  await m.evalJs(`[...document.querySelectorAll(".result-box")][${idx}].dispatchEvent(new MouseEvent("click", { bubbles: true })); "ok"`);
  return true;
};

// ① real detach: enter the mode page, click the detach button.
let entered = await clickKwRow("进入 文件秒搜");
if (!entered) {
  await m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = "秒搜"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  await sleep(700);
  entered = await clickKwRow("进入 文件秒搜");
}
let btn = false;
for (let i = 0; i < 40 && !btn; i++) {
  await sleep(300);
  btn = !!(await m.evalJs(`!!document.querySelector(".detach-btn")`));
}
if (!entered || !btn) {
  console.error(`detach path missing (entered=${entered}, button=${btn})`);
  process.exit(1);
}
await m.evalJs(`document.querySelector(".detach-btn").click(); "ok"`);
let pt = null;
for (let i = 0; i < 40 && !pt; i++) {
  await sleep(150);
  pt = await findTarget("plugin.html?plugin=file-search");
}
if (!pt) {
  console.error("plugin window target missing");
  process.exit(1);
}
await sleep(3500);
const c = await connect(pt.webSocketDebuggerUrl);
const probe = await c.evalJs(`(() => { const s = window.__frameStates || []; return { viewReady: s.some((x) => x.name === "" && x.reason === "ready") }; })()`);
check("①a detached view is up (bridge ready)", probe?.viewReady === true, JSON.stringify(probe));

const after = dump();
const fsWin = after.find((w) => w.title.includes("秒搜"));
check("①b detached window has an ICON_BIG", !!(fsWin && fsWin.iconSha1), JSON.stringify(after));
check(
  "①c plugin icon differs from the launcher icon",
  !!(launcher && fsWin && fsWin.iconSha1 !== launcher.iconSha1),
  `launcher=${launcher?.iconSha1} plugin=${fsWin?.iconSha1}`
);
const ids = taskbarIds();
check(
  "② detached window owns its taskbar entry (AppUserModelID)",
  ids.includes("Lume.Plugin.file-search"),
  `taskbar ids: ${JSON.stringify(ids)}`
);

// ③ icon-less plugin → Lume fallback (no icon upload, same as the frontend
//    path for a manifest without `icon`).
await invoke("plugin_window_close", { id: "file-search" });
await sleep(1200);
await invoke("plugin_window_open", { id: "hello-mode" });
await sleep(2800);
const after2 = dump();
const hmWin = after2.find((w) => w.title === "Hello Mode");
check("③a icon-less plugin window present", !!hmWin, JSON.stringify(after2));
check(
  "③b icon-less plugin falls back to the Lume icon",
  !!(hmWin && launcher && hmWin.iconSha1 === launcher.iconSha1),
  `launcher=${launcher?.iconSha1} hello=${hmWin?.iconSha1}`
);
const ids2 = taskbarIds();
check(
  "③c icon-less plugin still gets its own taskbar entry",
  ids2.includes("Lume.Plugin.hello-mode"),
  `taskbar ids: ${JSON.stringify(ids2)}`
);

await invoke("plugin_window_close", { id: "hello-mode" });
console.log(`\nPLUGIN ICON VERIFY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
