// P2b 验证（P2 余项）：files 拖入、img 剪贴板图片进入、template="list" 列表模板、
// 磁贴重排改指针事件后的基本行为。
//   ① files   拖入事件（Tauri drag-drop → tauri://drag-drop）携带真实路径 →
//            files 规则出行（文案带命中数，只含扩展名命中的子集；#43 起落在
//            「推荐使用」栏，最近使用/已固定栏保持可见，拖入自动聚焦首行，
//            Enter 直接激活）→ onFeature 收 paths → fs.readText 真实读取
//   ② img     剪贴板有图（Set-Clipboard -Image）→ 空查询出「图片处理器」行 →
//            激活后 clipboard.readImage() 真读到 PNG data URI；剪贴板换文本
//            后该行消失（每次空查询渲染都探测）
//   ③ list    list-demo（kind=mode + template="list"，零 HTML）：关键字进入 →
//            内置列表渲染两行演示数据 → onFeature 快速添加 → Enter 复制行名；
//            顺带断言非空查询的分块（#43：正常结果在上、「推荐使用」分隔行
//            下方是插件行——关键字/feature/provider）
//   ④ 重排    磁贴重排（pointer events 版）：pointerdown+move+up 交换两个
//            已固定条目并持久化（reorder_pins）。
//   ⑤ ctx 面一致（静态，ROADMAP #38）：逻辑帧 ctx 必须与视图桥同面，
//            且每个方法都要被 rpc.ts 的 switch 认领——P6.5 的漂移
//            （clipboard.readImage 无 case、逻辑帧缺 fs/theme/detach）就是这
//            两层各写一份却无断言钉住导致的。
// 说明：①的拖入用 `plugin:event|emit_to` 模拟 tauri://drag-drop —— 真实 OS
// 拖拽无法在自动化里合成；wry 的 OLE drop target（真实路径的来源）已由启用
// drag-drop handler 打开，真实拖放留了手工验证步骤（docs/TESTING.md）。
// 截图：test/p2b_files.png、test/p2b_list.png
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, cpSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
// ── 预置：装两个示例插件 + 三个拖拽夹具文件 ──
for (const id of ["files-img-demo", "list-demo"]) {
  rmSync(`${BASE}/plugins/${id}`, { recursive: true, force: true });
  cpSync(`examples/plugins/${id}`, `${BASE}/plugins/${id}`, { recursive: true });
}
const FIX_MD = `${BASE}/p2b_hello.md`;
const FIX_TXT = `${BASE}/p2b_note.txt`;
const FIX_PNG = `${BASE}/p2b_other.png`;
const FIX_DIR = `${BASE}/p2b_folder`; // fileType="folder" 规则的真实文件夹夹具
rmSync(FIX_DIR, { recursive: true, force: true });
mkdirSync(FIX_DIR, { recursive: true });
writeFileSync(FIX_MD, "hello from p2b 烟测文件\n");
writeFileSync(FIX_TXT, "second text file\n");
writeFileSync(FIX_PNG, "not a real png\n"); // 扩展名命中过滤的陪衬（不应进 payload）

const logFd = openSync("test/p2b_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9226" },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch("http://127.0.0.1:9226/json/list")).json(); } catch { await sleep(500); }
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
// PowerShell with UTF-8 output so non-ASCII clipboard text survives the pipe.
const ps = (cmd) => execSync(
  `powershell -NoProfile -STA -Command "[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${cmd.replace(/"/g, '\\"')}"`,
  { encoding: "utf8" }
).trim();
mkdirSync("test", { recursive: true });

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
let mainT = await findMain();
for (let i = 0; i < 40 && !mainT; i++) {
  await sleep(500);
  mainT = await findMain();
}
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);

// 夹具必须处于启用态：`settings.plugins.disabled` 是逐机状态，其它脚本或
// 手工操作可能把它们关过。幂等启用（已启用则不动；settings-applied 会让
// 注册表重载，等一会儿再跑检查）。
const disabledIds = (await invoke("get_settings"))?.plugins?.disabled ?? [];
for (const id of ["files-img-demo", "list-demo"]) {
  if (disabledIds.includes(id)) {
    await invoke("set_plugin_enabled", { id, enabled: true });
    await sleep(900);
  }
}
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const rowNames = () => m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
const barIds = () => m.evalJs(`Array.from(document.querySelectorAll(".bar-grid")).map((g) => g.dataset.barId)`);
const clickRow = (name) => m.evalJs(`(() => { const b = Array.from(document.querySelectorAll(".result-box")).find((x) => x.querySelector(".result-box-name")?.textContent === ${JSON.stringify(name)}); if (!b) return "missing"; b.click(); return "clicked"; })()`);
const toastText = () => m.evalJs(`document.querySelector(".toast-text")?.textContent ?? ""`);
const waitToastGone = async (timeoutMs = 4000) => {
  for (let waited = 0; waited < timeoutMs; waited += 200) {
    if (!(await toastText())) return true;
    await sleep(200);
  }
  return false;
};
const pressEnter = () => m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`);
async function clickAndToast(name, timeoutMs = 5000) {
  const clicked = await clickRow(name);
  let text = "";
  for (let waited = 0; waited < timeoutMs && !text; waited += 150) {
    await sleep(150);
    text = await toastText();
  }
  return { clicked, text };
}

// 模拟 Tauri drag-drop（真实路径的唯一来源是 wry 的 OLE drop target；自动化里
// 只能把同一事件投回给监听器——见文件头说明）。
const emitDrop = (paths) => m.evalJs(`window.__TAURI_INTERNALS__.invoke("plugin:event|emit_to", {
  target: { kind: "Webview", label: "main" },
  event: "tauri://drag-drop",
  payload: { type: "drop", paths: ${JSON.stringify(paths)}, position: { x: 10, y: 10 } }
}).then(() => "emitted").catch((e) => "emit-failed: " + e)`);

// Frontend plog tap (DevTools console) — see the p3 script's note.
await m.evalJs(`(() => {
  if (window.__plog) return "already";
  window.__plog = [];
  for (const level of ["debug", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...a) => { window.__plog.push(a.map(String).join(" ")); orig(...a); };
  }
  return "hooked";
})()`);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS" : "FAIL") + " " + name + (extra ? " — " + extra : "")); ok ? pass++ : fail++; };

// #43：先固定一个应用，「推荐使用」与标准栏目条并存的断言才是真实断言
// （cmd.exe 不启动，只写 pins；重排段/文末的 unpin 会撤销）。
await invoke("pin_app", { path: "C:\Windows\System32\cmd.exe", name: "cmd" });

// 保证一次真正的 show：debug exe 启动时窗口已可见，第一次 toggle 会变成
// hide；launcher-shown 的 onShow 才会刷新栏目，刚写入的 pin 才会渲染。
await invoke("hide_launcher");
await sleep(500);
await invoke("toggle_launcher");
await sleep(1800);

// ── ② 前置：剪贴板无图 → 空查询无 img 行 ──
ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText("plain text probe")`);
await type("clear");
await sleep(600);
await type("");
await sleep(900);
let names = await rowNames();
check("no image row when clipboard holds text",
  !names.some((n) => n.includes("图片处理器")), JSON.stringify(names));

// ── ② 剪贴板放图 → 空查询出 img 行 → readImage 真读 ──
ps(`Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $b = New-Object System.Drawing.Bitmap 64,64; [System.Windows.Forms.Clipboard]::SetImage($b)`);
await type("x");
await sleep(500);
await type(""); // 重新触发空查询渲染（含 has_image 探测）
await sleep(1200);
names = await rowNames();
check("clipboard image offers the img row",
  names.some((n) => n.includes("图片处理器")), JSON.stringify(names));
// #43：插件行落在「推荐使用」栏里，标准栏目条不再被整个顶掉。
const settings0 = await invoke("get_settings");
const recentExpected = ((await invoke("get_recent_apps")) ?? []).length > 0
  && (settings0?.appearance?.show_recent ?? true);
const pinnedExpected = ((await invoke("get_pinned_apps")) ?? []).length > 0;
const imgBarIds = await barIds();
check("img row lands in the 推荐使用 section (bars stay, no forced grid)",
  imgBarIds.includes("recommended") && !(await m.evalJs(`!!document.querySelector(".result-grid")`))
    && (!recentExpected || imgBarIds.includes("recent"))
    && (!pinnedExpected || imgBarIds.includes("pinned")),
  JSON.stringify({ imgBarIds, recentExpected, pinnedExpected }));
if (names.some((n) => n.includes("图片处理器"))) {
  const { clicked, text } = await clickAndToast(names.find((n) => n.includes("图片处理器")));
  check("img row clicked", clicked === "clicked", text);
  check("plugin really read the clipboard image", text.includes("读到图片：PNG base64"), text);
  await m.evalJs(`document.querySelector(".toast") === null ? 0 : 0`); // no-op settle
}
await m.shot("p2b_files.png");

// ── ① files：剪贴板先换回文本（探测消陈旧 img 行），再模拟拖入 ──
ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText("plain text probe")`);
const emit = await emitDrop([FIX_MD, FIX_TXT, FIX_PNG]);
await sleep(1500);
names = await rowNames();
check("drop event accepted", emit === "emitted", emit);
check("files row appears with the matched count",
  names.some((n) => n.includes("文件处理器：处理文本文件（2 个文件）")), JSON.stringify(names));
check("stale img row dropped once the clipboard holds text",
  !names.some((n) => n.includes("图片处理器")), JSON.stringify(names));
const dropBarIds = await barIds();
check("drop rows land in the 推荐使用 section (bars stay, no forced grid)",
  dropBarIds.includes("recommended") && !(await m.evalJs(`!!document.querySelector(".result-grid")`))
    && (!recentExpected || dropBarIds.includes("recent"))
    && (!pinnedExpected || dropBarIds.includes("pinned")),
  JSON.stringify({ dropBarIds, recentExpected, pinnedExpected }));
if (names.some((n) => n.includes("文件处理器"))) {
  // #43：拖入把选中焦点放到「推荐使用」的首行（Enter 直接可用）。
  const focused = await m.evalJs(`(() => {
    const sel = document.querySelector(".bar-grid[data-bar-id=recommended] .result-box.result-selected");
    return sel?.querySelector(".result-box-name")?.textContent ?? null;
  })()`);
  check("drop focuses the 推荐使用 section's first row",
    focused === "文件处理器：处理文本文件（2 个文件）", JSON.stringify(focused));
  await waitToastGone();
  await pressEnter();
  let text = "";
  for (let waited = 0; waited < 5000 && !text; waited += 150) { await sleep(150); text = await toastText(); }
  // 一支 toast 同时断言路径子集（只命中 .md/.txt，png 被过滤）与真实读取。
  check("Enter on the focused row activates the plugin (subset + real read)",
    text.includes("收到 2 个文件") && text.includes("hello from p2b"), text);
}

// ── ① 拖拽行是一次性的：隐藏再呼出后消失 ──
await invoke("toggle_launcher"); // hide
await sleep(800);
await invoke("toggle_launcher"); // show
await sleep(1500);
names = await rowNames();
check("drop rows clear after hide + re-summon",
  !names.some((n) => n.includes("文件处理器")), JSON.stringify(names.slice(0, 4)));
const summonBarIds = await barIds();
check("推荐使用 section drops with the summon-scoped rows",
  !summonBarIds.includes("recommended"), JSON.stringify(summonBarIds));

// ── ①b fileType（P4, ROADMAP #28）：folder / image 类别规则 ──
// 一次拖入 文件夹 + .png + .md：extensions 规则只报 .md（文件夹不再冒充
// 扩展名），fileType=folder 只报文件夹，fileType=image 按类别表报 .png。
const emit2 = await emitDrop([FIX_DIR, FIX_PNG, FIX_MD]);
await sleep(1500);
names = await rowNames();
check("fileType drop accepted", emit2 === "emitted", emit2);
check("fileType=folder row offered with the folder only",
  names.some((n) => n.includes("文件夹工具：处理文件夹（1 个文件）")), JSON.stringify(names));
check("fileType=image row offered with the image only",
  names.some((n) => n.includes("图片工具：处理图片文件（1 个文件）")), JSON.stringify(names));
check("extensions rule no longer counts the folder as .md-like",
  names.some((n) => n.includes("文件处理器：处理文本文件（1 个文件）")), JSON.stringify(names));
const folderRow = names.find((n) => n.includes("文件夹工具"));
if (folderRow) {
  const { clicked, text } = await clickAndToast(folderRow);
  check("folder row clicked and paths delivered",
    clicked === "clicked" && text.includes("收到 1 个文件夹"), text);
}
// 清场：隐藏再呼出，避免影响后续段落
await invoke("toggle_launcher");
await sleep(800);
await invoke("toggle_launcher");
await sleep(1500);

// ── ③ list-demo：关键字进入 → 内置列表渲染 ──
await type("清单");
await sleep(1200);
names = await rowNames();
const enterRow = names.find((n) => n.startsWith("进入") && n.includes("清单"));
check("list-demo keyword row offered", !!enterRow, JSON.stringify(names));
// #43：非空查询也分块 —— 正常结果（原生索引 + 文件搜索）在上，插件行在
// 「推荐使用」分隔行之下。
const split = await m.evalJs(`(() => {
  const el = document.querySelector(".result-grid .result-split");
  if (!el) return null;
  const boxes = Array.from(document.querySelectorAll(".result-grid .result-box"));
  const firstPlugin = boxes.findIndex((b) => (el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0);
  return { title: el.textContent ?? "", normal: firstPlugin, plugin: boxes.length - firstPlugin };
})()`);
check("non-empty query shows the 推荐使用 block",
  !!split && split.title.includes("推荐使用"), JSON.stringify(split));
check("plugin rows sit below the normal results",
  !!split && split.normal > 0 && split.plugin > 0, JSON.stringify(split));
if (enterRow) {
  await clickRow(enterRow);
  await sleep(1800);
  const listNames = await m.evalJs(
    `Array.from(document.querySelectorAll(".plugin-list-row .plugin-list-name")).map((n) => n.textContent)`
  );
  check("built-in list renders the plugin rows",
    JSON.stringify(listNames).includes("买牛奶") && JSON.stringify(listNames).includes("还书"),
    JSON.stringify(listNames));
  await m.shot("p2b_list.png");

  // onFeature（声明式进入 quick-add）：显式点回导航 pill（#40 起呼出不再
  // 自动回导航页——会话续存），输入「买 咖啡」出行并激活。
  await m.evalJs(`document.querySelector(".mode-switch-item")?.click()`);
  await sleep(900);
  await type("买 咖啡");
  await sleep(1200);
  names = await rowNames();
  const addRow = names.find((n) => n.includes("清单：快速添加一条"));
  check("quick-add feature row offered", !!addRow, JSON.stringify(names));
  if (addRow) {
    await clickRow(addRow);
    await sleep(1800);
    const after = await m.evalJs(
      `Array.from(document.querySelectorAll(".plugin-list-row .plugin-list-name")).map((n) => n.textContent)`
    );
    check("onFeature added the payload as a row (mode switched first)",
      JSON.stringify(after).includes("咖啡"), JSON.stringify(after));
  }
}

// ── ④ 磁贴重排（pointer events）：交换前两个已固定条目并持久化 ──
// quick-add 可能已把模式切到 list-demo —— 回导航页（重排只发生在主菜单）。
await m.evalJs(`document.querySelector(".mode-switch-item")?.click()`);
await sleep(1200);
await invoke("pin_app", { path: "C:\Windows\System32\notepad.exe", name: "notepad" });
await invoke("pin_app", { path: "C:\Windows\System32\cmd.exe", name: "cmd" });
// 重新呼出一次：栏目（已固定）在召唤时刷新，刚写入的 pin 才会渲染出来。
await invoke("toggle_launcher");
await sleep(700);
await invoke("toggle_launcher");
await sleep(1500);
const before = await invoke("get_pinned_apps");
if (Array.isArray(before) && before.length >= 2) {
  const geo = await m.evalJs(`(() => {
    const boxes = Array.from(document.querySelectorAll(".bar-grid[data-bar-id=pinned] .result-box"));
    if (boxes.length < 2) return null;
    const a = boxes[0].getBoundingClientRect(), b = boxes[1].getBoundingClientRect();
    return { ax: a.x + a.width / 2, ay: a.y + a.height / 2, bx: b.x + b.width / 2, by: b.y + b.height / 2 };
  })()`);
  if (geo) {
    const pe = (type, x, y, target) => m.evalJs(`document.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, {
      bubbles: true, cancelable: true, button: 0, clientX: ${x}, clientY: ${y} }))`);
    // pointerdown 需落在第一个盒子上（beginDrag 读 currentTarget）。
    await m.evalJs(`(() => {
      const box = document.querySelector(".bar-grid[data-bar-id=pinned] .result-box");
      box.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0,
        clientX: ${geo.ax}, clientY: ${geo.ay} }));
      return "down";
    })()`);
    await pe("pointermove", (geo.ax + geo.bx) / 2, (geo.ay + geo.by) / 2);
    await sleep(120);
    await pe("pointermove", geo.bx, geo.by);
    await sleep(120);
    await pe("pointerup", geo.bx, geo.by);
    await sleep(1000);
    const after = await invoke("get_pinned_apps");
    check("pointer reorder swaps the first two pins",
      after.length === before.length &&
        after[0].path === before[1].path && after[1].path === before[0].path,
      `${before[0].path} -> ${after[0].path}`);
  } else {
    check("pointer reorder swaps the first two pins", false, "pinned boxes not found");
  }
} else {
  console.log("SKIP pointer reorder — fewer than two pinned apps");
}
await invoke("unpin_app", { path: "C:\Windows\System32\notepad.exe" });
await invoke("unpin_app", { path: "C:\Windows\System32\cmd.exe" });

// ── Rust 日志断言 ──
// The registry's load lines are FRONTEND plog (DevTools console), and they
// fired before this script's console tap. Reload both plugins via the
// settings-pane command: the reload path logs the same lines with the tap
// already installed.
await invoke("reload_plugin", { id: "list-demo" });
await invoke("reload_plugin", { id: "files-img-demo" });
await sleep(2500);
const plogText = await m.evalJs(`(window.__plog ?? []).join(String.fromCharCode(10))`);
check("list-demo loaded as template=list",
  plogText.includes("registered mode proxy (template=list, entry=main.js"), "");
check("files-img-demo loaded as provider",
  plogText.includes("registered provider proxy (entry=main.js"), "");

// ── ⑤ ctx 面一致性（静态，ROADMAP #38）──
// 两个 ctx 面（视图桥 iframeBridge.tsx 的客户端、逻辑帧 public/pluginLogicFrame.js）
// 必须方法集合一致，且每个方法都在 rpc.ts 的 switch 里有 case（否则调用会落到
// `unknown lume rpc`）。静态比对源文件，不依赖 exe 状态。
const callsOf = (file) =>
  new Set([...readFileSync(file, "utf8").matchAll(/call\("([^"]+)"/g)].map((m) => m[1]));
const rpcCases = new Set(
  [...readFileSync("src/plugins/rpc.ts", "utf8").matchAll(/case "([^"]+)"/g)].map((m) => m[1])
);
const bridgeCalls = callsOf("src/plugins/iframeBridge.tsx");
const logicCalls = callsOf("public/pluginLogicFrame.js");
const missingInLogic = [...bridgeCalls].filter((x) => !logicCalls.has(x));
const missingRpc = [...logicCalls].filter((x) => !rpcCases.has(x));
check("logic-frame ctx mirrors the view bridge", missingInLogic.length === 0, JSON.stringify(missingInLogic));
check("every ctx method has an rpc.ts case", missingRpc.length === 0, JSON.stringify(missingRpc));

// 收尾：撤销 #43 预置的 pin（重排段通常已撤销；重复 unpin 幂等）。
await invoke("unpin_app", { path: "C:\Windows\System32\cmd.exe" });

console.log(`\\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
