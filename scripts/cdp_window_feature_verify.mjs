// 活动窗口匹配验证（P4，ROADMAP #29 / [[features]] type="window"）：
//   ① 匹配      真实前台窗口（PowerShell AppActivate 激活编辑器 → toggle_launcher
//               呼出时 Rust 侧捕获 FocusState）→ 空查询主菜单出现「窗口工具」行；
//               process 维度（exe 名/stem OR）与 process+title AND 维度
//   ② 负例      标题不含「验证用」的编辑器 → AND 规则不出行
//   ③ 激活      点行 → onFeature 收到 info.window（process/className/title）
//   ④ 一次性    前台换成非编辑器后行消失（summon-scoped）
//   ⑤ app.foreground(ctx 层)  权限拒绝/放行 + 快照形状 + 未知插件 fail-closed
// 边界：Explorer 的 class 维度（CabinetWClass）与 path 解析依赖真实 Explorer
// 窗口激活，自动化不稳定 —— 由 window-demo 的手工步骤覆盖（docs/TESTING.md）。
// 说明：本机 notepad 可能被 Notepad3 等替换（System32\notepad.exe 是 stub、
// 其 PID 没有窗口、顶层窗口类不是 "Notepad"），所以自动化用脚本生成的测试
// 插件（process 匹配 notepad/notepad3 双词）并按标题前缀激活激活夹具。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, cpSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM notepad.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM Notepad3.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
const CDP_PORT = 9237;
mkdirSync("test", { recursive: true });
rmSync(`${BASE}/plugins/window-demo`, { recursive: true, force: true });
cpSync(`examples/plugins/window-demo`, `${BASE}/plugins/window-demo`, { recursive: true });

// 本机记事本可能被 Notepad3 替换 —— window-demo 的 notepad 规则只面向真实
// notepad；自动化断言用脚本生成的测试插件，process 两词通吃。
const TEST_PLUGIN = `${BASE}/plugins/window-test`;
rmSync(TEST_PLUGIN, { recursive: true, force: true });
mkdirSync(TEST_PLUGIN, { recursive: true });
writeFileSync(
  `${TEST_PLUGIN}/plugin.toml`,
  'id = "window-test"\nname = "Window Test"\nkind = "provider"\nentry = "main.js"\npermissions = ["window"]\n\n' +
    '[[features]]\ncode = "editor"\nlabel = "窗口工具：编辑器（process）"\ntype = "window"\nprocess = ["notepad", "notepad3"]\n\n' +
    '[[features]]\ncode = "editor-verified"\nlabel = "窗口工具：编辑器（验证用）"\ntype = "window"\nprocess = ["notepad", "notepad3"]\ntitle = ["验证用"]\n'
);
writeFileSync(
  `${TEST_PLUGIN}/main.js`,
  'export default function create(ctx) { return { async search(q) { return []; }, onFeature(info) { const w = info.window ?? {}; ctx.app.toast("命中窗口规则「" + info.code + "」：进程 " + w.process + "｜类名 " + w.className + "｜标题「" + w.title + "」"); } }; }\n'
);

// 两个夹具：A 无「验证用」（AND 规则负例），B 有（正例）。绝对+反斜杠路径
// （Start-Process 不接受正斜杠相对路径）；文件名同时是窗口标题的前缀。
const FIX_A = process.cwd().replaceAll("/", "\\") + "\\p29_a.txt";
const FIX_B = process.cwd().replaceAll("/", "\\") + "\\p29_验证用.txt";
writeFileSync(FIX_A, "window demo fixture a\n");
writeFileSync(FIX_B, "window demo fixture b\n");

const NOTEPAD = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\notepad.exe";
const startNotepad = (file) => execSync(
  `powershell -NoProfile -Command "Start-Process '${NOTEPAD}' -ArgumentList '\"${file}\"'"`,
  { stdio: "ignore" }
);
// 按标题前缀激活（AppActivate 支持前缀/后缀匹配；PID 不可用 —— System32 的
// notepad 在 Win11 上可能是 Store 版 stub，其 PID 没有窗口）。轮询直到成功。
function activate(prefix, tries = 15) {
  for (let i = 0; i < tries; i++) {
    const out = execSync(
      `powershell -NoProfile -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; (New-Object -ComObject WScript.Shell).AppActivate('${prefix}')"`,
      { encoding: "utf8" }
    ).trim();
    if (out === "True") return true;
    sleep(400);
  }
  return false;
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

// ── 预热：启动编辑器 A，首次呼出让清单/插件/前台管线就绪 ──
startNotepad(FIX_A);
await sleep(2500);
if (!activate("p29_a")) console.error("WARN: editor A not activated (results may be flaky)");
await invoke("toggle_launcher");
await sleep(2200);
await invoke("toggle_launcher");
await sleep(800);

// ── ① + ② 编辑器 A（标题无「验证用」）：process 规则命中、AND 规则不命中 ──
activate("p29_a");
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

// ── ① 编辑器 B（标题含「验证用」）：两条规则都出行 ──
try { execSync("taskkill /F /IM notepad.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM Notepad3.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(600);
startNotepad(FIX_B);
await sleep(2500);
if (!activate("p29_验证用")) console.error("WARN: editor B not activated (results may be flaky)");
await summon();
names = await rowNames();
check("AND 规则正例：标题含「验证用」出行",
  names.some((n) => n.includes("窗口工具：编辑器（验证用）")), JSON.stringify(names.filter((n) => n.includes("窗口"))));
check("两条规则同时出行（不同 code 的行并存）",
  names.filter((n) => n.includes("窗口工具")).length === 2, JSON.stringify(names.filter((n) => n.includes("窗口"))));

// ── ④ 前台不再是编辑器：process 规则消失 ──
try { execSync("taskkill /F /IM notepad.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM Notepad3.exe 2>NUL", { stdio: "ignore" }); } catch {}
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
rmSync(TEST_PLUGIN, { recursive: true, force: true });

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
