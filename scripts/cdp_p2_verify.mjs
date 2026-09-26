// P2 验证（ROADMAP #25）：入口矩阵与搜索链路。
//   ① features：over 命中 → 「文本工具：转为大写」行；激活把查询作为 payload
//      投递给 onFeature（剪贴板收到大写结果）；regex 命中 URL 才出行；
//      min_length 边界不命中；catch-all 正则被忽略。
//   ② 下钻：drill 行 → select 的行替换网格；Esc 回上一级（父行恢复）。
//   ③ filter：下钻层输入过滤（宿主把文字喂给 provider.filter）。
//   ④ 子输入框：mode 调 setSubInput 后按键进插件（页面回显），removeSubInput 交还；
//      切模式/再次呼出自动释放。
//   ⑤ redirect：跳到 hello-mode（进入载荷回显）＋ 目标不存在时 toast 提示。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
const logFd = openSync("test/p2_lume.log", "w");
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
    if (r?.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description ?? "eval failed"));
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
const rowNames = () => m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
const clickRow = (name) => m.evalJs(`(() => { const b = Array.from(document.querySelectorAll(".result-box")).find((x) => x.querySelector(".result-box-name")?.textContent === ${JSON.stringify(name)}); if (!b) return "missing"; b.click(); return "clicked"; })()`);
const key = (k) => m.evalJs(`(() => { const e = new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; })()`);
const placeholder = () => m.evalJs(`document.getElementById("search-input").placeholder`);
const clipText = () => ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()`);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS" : "FAIL") + " " + name + (extra ? " — " + extra : "")); ok ? pass++ : fail++; };

await invoke("toggle_launcher");
await sleep(1500);

// ── ① features：over / regex / 边界 ──
await type("hello world");
await sleep(1800);
let names = await rowNames();
check("over feature row appears for plain text", names.includes("文本工具：转为大写"), JSON.stringify(names));
check("regex feature row absent for plain text", !names.includes("文本工具：打开这个网址"));
await type("https://example.com/a");
await sleep(1800);
names = await rowNames();
check("regex feature row appears for a URL", names.includes("文本工具：打开这个网址"), JSON.stringify(names));
check("over feature still matches the URL text", names.includes("文本工具：转为大写"));

// min_length 边界：1 个字符不该命中 over（min_length = 2）
await type("x");
await sleep(1500);
names = await rowNames();
check("min_length boundary blocks the 1-char query", !names.includes("文本工具：转为大写"), JSON.stringify(names));

// 命中 over 后激活 → payload 投递 → 剪贴板得到大写
await type("hello world");
await sleep(1800);
await clickRow("文本工具：转为大写");
await sleep(1200);
const upper = clipText();
check("onFeature received the query payload (uppercased into the clipboard)", upper === "HELLO WORLD", upper);

// ── ② 下钻 + ③ filter + Esc 回退 ──
await type("hello drill");
await sleep(1800);
names = await rowNames();
check("drill row present", names.includes("文本转换…"), JSON.stringify(names));
await clickRow("文本转换…");
await sleep(1500);
names = await rowNames();
check("select() rows replace the grid", names.includes("转换为大写") && names.includes("转换为反转"), JSON.stringify(names));
check("drilled level claims the search box (placeholder set)", (await placeholder()).includes("搜索"), await placeholder());

// filter：输入「反」只剩「转换为反转」
await type("反");
await sleep(1200);
names = await rowNames();
check("provider.filter narrows the drilled level", names.length === 1 && names[0] === "转换为反转", JSON.stringify(names));

// Esc 回上一级（父行恢复）
const escPrevented = await key("Escape");
await sleep(1000);
names = await rowNames();
const backAtParent = names.includes("文本转换…") && names.includes("在 Hello Mode 里打开");
check("Esc pops the drilled level back to the parent rows", backAtParent, JSON.stringify(names));
check("Esc was consumed by the drill level (launcher stayed up)", escPrevented === true, String(escPrevented));

// ── ⑤ redirect：目标存在 / 不存在 ──
await clickRow("在 Hello Mode 里打开");
await sleep(2000);
const activeModeName = await m.evalJs(`document.querySelector(".mode-switch-item.active")?.textContent?.trim() ?? ""`);
check("redirect switched to hello-mode", activeModeName.includes("Hello Mode"), activeModeName);
const enterEcho = await m.evalJs(`(() => { const f = document.querySelector("iframe.plugin-frame"); const d = f && f.contentDocument; return d ? (d.getElementById("enterView")?.textContent ?? "(no node)") : "(no iframe)"; })()`);
check("mode received the redirect payload (enter event)", String(enterEcho).includes("from-text-tools") && String(enterEcho).includes("hello drill"), String(enterEcho));
await m.shot("p2_redirect_enter.png");

// ── ④ 子输入框：接管 → 按键进插件 → 交还 ──
const clickInFrame = (id) => m.evalJs(`(() => { const f = document.querySelector("iframe.plugin-frame"); const d = f && f.contentDocument; const el = d && d.getElementById(${JSON.stringify(id)}); if (!el) return "missing"; el.click(); return "clicked"; })()`);
check("hello-mode subInput button clicked", (await clickInFrame("sub")) === "clicked");
await sleep(800);
const ph = await placeholder();
check("subInput placeholder took over the box", ph.includes("子输入框"), ph);
await type("sub-input probe");
await sleep(800);
const subEcho = await m.evalJs(`(() => { const f = document.querySelector("iframe.plugin-frame"); const d = f && f.contentDocument; return d ? (d.getElementById("subView")?.textContent ?? "") : ""; })()`);
check("keystrokes reached the plugin's onSubInput", subEcho === "sub-input probe", subEcho);
const subModeQuery = await m.evalJs(`document.getElementById("search-input").value`);
check("the box still shows what the user typed", subModeQuery === "sub-input probe", subModeQuery);
await m.shot("p2_subinput.png");

// 交还搜索框
await clickInFrame("subEnd");
await sleep(600);
check("removeSubInput released the box (placeholder back to mode default)", !(await placeholder()).includes("子输入框"), await placeholder());

// 切模式释放所有权（再接管后切回导航页）
await clickInFrame("sub");
await sleep(600);
await invoke("toggle_launcher"); // hide
await sleep(800);
await invoke("toggle_launcher"); // show → clearSearch releases ownership
await sleep(1500);
check("a fresh summon releases search-box ownership", !(await placeholder()).includes("子输入框"), await placeholder());

// ── catch-all 正则守卫：label 永不出现（manifest 里刻意留了一条 regex = ".*"）──
await type("hello guard");
await sleep(1500);
names = await rowNames();
check(
  "catch-all regex rule is ignored (no row, no keystroke spam)",
  !names.includes("文本工具：catch-all（不应出现）"),
  JSON.stringify(names)
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
