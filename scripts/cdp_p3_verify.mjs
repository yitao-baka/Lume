// P3 验证（ROADMAP #26）：数据层、权限强制层、私有文件、声明式设置。
//   ① 文档库     notes 插件的 [[features]] 保存 → db.put；同一 _rev 写两次被
//                `conflict:` 拒绝；bulkDocs 逐条返回；宿主端 stale rev 同样被拒；
//                `__` 前缀（宿主内部文档）不可被插件写。
//   ② 迁移       旧的 plugins/<id>/storage.json 首次访问即搬进 store 的 __storage
//                文档，文件改名为 storage.json.migrated（不删）。
//   ③ 权限层      未声明 network 的插件调 http.request → 明确拒绝文案；
//                已声明 clipboard 的调用 → 通过。
//   ④ 私有文件    fs.writeText → plugins/<id>/files/（无需权限），文件真的落盘。
//   ⑤ 设置        plugin_settings_put（设置窗路径）→ 启动器收到 plugin-settings →
//                插件 onSettings；新值立刻影响行为（列表前缀）；设置页渲染
//                权限 chips + 设置项控件。
// 截图：test/p3_notes.png、test/p3_plugin_pane.png
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, openSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

// ── 预置：一个带旧 storage.json 的插件（迁移必须在 store 首次访问前就位）──
const BASE = "src-tauri/target/debug";
const legacyDir = `${BASE}/plugins/p3store`;
rmSync(`${BASE}/data/plugin_store.db`, { force: true });
rmSync(`${BASE}/data/plugin_store.db-wal`, { force: true });
rmSync(`${BASE}/data/plugin_store.db-shm`, { force: true });
mkdirSync(legacyDir, { recursive: true });
writeFileSync(`${legacyDir}/plugin.toml`, 'id = "p3store"\nname = "P3 Storage Migration Probe"\nkind = "service"\nentry = "main.js"\n');
writeFileSync(`${legacyDir}/main.js`, "export default {};\n");
writeFileSync(`${legacyDir}/storage.json`, '{"legacyKey":"\\"legacy-value\\""}\n');

const logFd = openSync("test/p3_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9224" },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch("http://127.0.0.1:9224/json/list")).json(); } catch { await sleep(500); }
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

/** Find the launcher window (it owns #search-input) and the settings window. */
async function findWindows() {
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  let main = null, settings = null;
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      if (await c.evalJs(`!!document.getElementById("search-input")`)) main = t;
      else if (await c.evalJs(`document.body.classList.contains("settings-window")`)) settings = t;
      c.ws.close();
    } catch {}
  }
  return { main, settings };
}
let { main: mainT } = await findWindows();
for (let i = 0; i < 40 && !mainT; i++) {
  await sleep(500);
  ({ main: mainT } = await findWindows());
}
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const invokeErr = (cmd, args = {}) =>
  m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)}).then(() => "").catch((e) => String(e))`);
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const rowNames = () => m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
const clickRow = (name) => m.evalJs(`(() => { const b = Array.from(document.querySelectorAll(".result-box")).find((x) => x.querySelector(".result-box-name")?.textContent === ${JSON.stringify(name)}); if (!b) return "missing"; b.click(); return "clicked"; })()`);
const toastText = () => m.evalJs(`document.querySelector(".toast-text")?.textContent ?? ""`);
/** Click an action row and wait for its toast (it auto-dismisses after 1.6s,
 * so polling beats a fixed sleep). Returns the toast text, "" on timeout. */
async function clickAndToast(name, timeoutMs = 4000) {
  const clicked = await clickRow(name);
  let text = "";
  for (let waited = 0; waited < timeoutMs && !text; waited += 150) {
    await sleep(150);
    text = await toastText();
  }
  return { clicked, text };
}
const clipText = () => ps(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()`);

// The frontend's plog goes to the DevTools console, not to stderr (the Rust
// side logs to stderr). Tap it so permission refusals can be asserted.
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

await invoke("toggle_launcher");
await sleep(1800);

// ── ① 文档库：[[features]] 保存 → db.put ──
const probe = "p3 probe " + Date.now();
await type(probe);
await sleep(1800);
let names = await rowNames();
check("notes feature row appears for plain text", names.includes("速记：保存这段文字"), JSON.stringify(names));
check("save row clicked", (await clickRow("速记：保存这段文字")) === "clicked");
await sleep(1200);
let toast = await toastText();
check("saved toast reports the document rev", toast.includes("已保存") && toast.includes("_rev 1"), toast);

let docs = await invoke("plugin_db_all_docs", { id: "notes", prefix: "note:" });
const saved = (docs ?? []).find((d) => String(d.json).includes(probe));
check("the document is in the store with rev 1", !!saved && saved.rev === 1, JSON.stringify(saved));
check("allDocs hides host-internal docs", (docs ?? []).every((d) => !d.id.startsWith("__")));

// ── ② 列表渲染：设置里的前缀 + 文档字段 ──
await type("笔记");
await sleep(1800);
names = await rowNames();
const listRow = names.find((n) => n.includes(probe));
check("the note renders in the list with the default prefix", listRow === "· " + probe, JSON.stringify(names.slice(0, 4)));
for (const label of [
  "速记：导出到插件目录（fs.writeText）",
  "速记：导出到选定路径…（dialog + fs.write）",
  "速记：清空全部笔记（逐条 remove）",
  "文档库：bulkDocs 批量写入 3 条",
  "文档库：乐观锁演示（同一 _rev 写两次）",
  "权限：调用 http.request（未声明 network）",
  "权限：写剪贴板（已声明 clipboard）",
]) {
  check("action row present: " + label, names.includes(label));
}
await m.shot("p3_notes.png");

// ── ③ 乐观锁：同一 _rev 写两次被拒绝（插件侧 + 宿主侧各验一次）──
const conflict = await clickAndToast("文档库：乐观锁演示（同一 _rev 写两次）");
check("conflict demo clicked", conflict.clicked === "clicked");
toast = conflict.text;
check("stale _rev write rejected with a conflict message", toast.includes("已按预期拒绝") && toast.includes("conflict:"), toast);
const leftover = await invoke("plugin_db_get", { id: "notes", docId: "demo:conflict" });
check("the conflict demo cleaned up after itself", leftover == null, JSON.stringify(leftover));

const hostErr = await invokeErr("plugin_db_put", { id: "notes", docId: "note:hostcheck", json: '{"text":"a"}', rev: 9 });
check("host-side stale rev is refused too", hostErr.includes("conflict:"), hostErr);
const internalErr = await invokeErr("plugin_db_put", { id: "notes", docId: "__settings", json: "{}", rev: null });
check("plugins cannot write host-internal docs", internalErr.includes("reserved"), internalErr);

// ── ④ bulkDocs：一次事务逐条返回 ──
const bulk = await clickAndToast("文档库：bulkDocs 批量写入 3 条");
check("bulk demo clicked", bulk.clicked === "clicked");
toast = bulk.text;
check("bulkDocs reports per-document results", toast.includes("bulkDocs：3/3"), toast);

// ── ⑤ 权限层：未声明 network → 拒绝；已声明 clipboard → 通过 ──
const denied = await clickAndToast("权限：调用 http.request（未声明 network）");
check("denied demo clicked", denied.clicked === "clicked");
toast = denied.text;
check(
  "an undeclared capability is refused with the missing word",
  toast.includes("权限层拒绝") && toast.includes("network") && toast.includes("permissions"),
  toast
);
const allowed = await clickAndToast("权限：写剪贴板（已声明 clipboard）");
check("allowed demo clicked", allowed.clicked === "clicked");
toast = allowed.text;
check("a declared capability passes", toast.includes("剪贴板写入成功"), toast);
check("...and really wrote the clipboard", clipText().includes("clipboard"), JSON.stringify(clipText()));

// ── ⑥ 私有文件：fs.writeText 落盘（无需权限）──
const exported = await clickAndToast("速记：导出到插件目录（fs.writeText）");
check("private export clicked", exported.clicked === "clicked");
toast = exported.text;
const privateFile = `${BASE}/plugins/notes/files/notes.txt`;
check("export toast names the private path", toast.includes("已导出") && toast.includes("notes.txt"), toast);
check("the private file exists on disk", existsSync(privateFile), privateFile);
check("the export contains the saved note", existsSync(privateFile) && readFileSync(privateFile, "utf8").includes(probe));

// ── ⑦ 迁移：旧 storage.json → __storage 文档 ──
const legacyValue = await invoke("plugin_storage_get", { id: "p3store", key: "legacyKey" });
check("legacy value readable after the migration", legacyValue === '"legacy-value"', String(legacyValue));
check("legacy file retired (renamed, not deleted)", existsSync(`${legacyDir}/storage.json.migrated`) && !existsSync(`${legacyDir}/storage.json`));
const legacyDocs = await invoke("plugin_db_all_docs", { id: "p3store" });
check("the migrated map lives in a host-internal doc", Array.isArray(legacyDocs) && legacyDocs.length === 0, JSON.stringify(legacyDocs));

// ── ⑧ 设置：设置窗写入 → 启动器转交插件 → 行为改变 ──
await invoke("plugin_settings_put", { id: "notes", key: "prefix", value: "★ " });
toast = "";
for (let waited = 0; waited < 4000 && !toast; waited += 150) {
  await sleep(150);
  toast = await toastText();
}
check("the plugin heard the settings change (onSettings)", toast.includes("速记设置已更新") && toast.includes("★"), toast);
await type("笔记");
await sleep(1500);
names = await rowNames();
check("the new value changes the plugin's behaviour", names.some((n) => n === "★ " + probe), JSON.stringify(names.slice(0, 3)));

// 排序换成最早在前：新值同样立即生效
await invoke("plugin_settings_put", { id: "notes", key: "sort", value: "oldest" });
await sleep(1200);
const values = await invoke("plugin_settings_get", { id: "notes" });
check(
  "effective settings = defaults ⊕ stored",
  values.sort === "oldest" && values.autoCopy === false && values.prefix === "★ ",
  JSON.stringify(values)
);
const unknownErr = await invokeErr("plugin_settings_put", { id: "notes", key: "nope", value: 1 });
check("undeclared setting keys are refused (manifest is the schema)", unknownErr.includes("unknown setting"), unknownErr);

// ── ⑨ 设置页：权限 chips + 全部授权 + 设置项控件 ──
await m.evalJs(`document.querySelector(".icon-btn[aria-label]")?.click(); "clicked"`);
await sleep(1500);
let settingsT = null;
for (let i = 0; i < 20 && !settingsT; i++) {
  ({ settings: settingsT } = await findWindows());
  if (!settingsT) await sleep(500);
}
if (!settingsT) {
  check("settings window opened", false);
} else {
  const s = await connect(settingsT.webSocketDebuggerUrl);
  await sleep(800);
  await s.evalJs(`(() => { const b = Array.from(document.querySelectorAll(".settings-nav")).find((x) => x.textContent.includes("插件")); if (b) b.click(); return "ok"; })()`);
  await sleep(600);
  const pane = await s.evalJs(`(() => {
    const row = Array.from(document.querySelectorAll(".settings-row-between")).find((r) => r.textContent.includes("速记"));
    if (!row) return null;
    return {
      chips: Array.from(row.querySelectorAll(".settings-chip-mini")).map((c) => c.textContent),
      perms: Array.from(row.querySelectorAll(".settings-plugin-perms .settings-chip-mini")).map((c) => c.textContent),
      trustAll: !!row.querySelector(".settings-trust-all .settings-toggle"),
      settingsBtn: Array.from(row.querySelectorAll(".settings-mini-btn")).map((b) => b.textContent.trim()),
    };
  })()`);
  check("plugin row lists the declared capabilities", JSON.stringify(pane?.perms) === JSON.stringify(["clipboard", "dialog", "fs.write"]), JSON.stringify(pane));
  check("plugin row offers 全部授权", pane?.trustAll === true);
  check("plugin row offers the settings block", (pane?.settingsBtn ?? []).some((t) => t.includes("设置项")), JSON.stringify(pane?.settingsBtn));

  // 展开设置项 → 3 行控件（text / toggle / select chips）
  await s.evalJs(`(() => { const b = Array.from(document.querySelectorAll(".settings-mini-btn")).find((x) => x.textContent.includes("设置项")); if (b) b.click(); return "ok"; })()`);
  await sleep(700);
  const block = await s.evalJs(`(() => {
    const box = document.querySelector(".settings-plugin-settings");
    if (!box) return null;
    const rows = Array.from(box.querySelectorAll(".settings-row-between"));
    return {
      rows: rows.map((r) => r.textContent.trim()),
      textInputs: box.querySelectorAll("input.settings-text-input").length,
      toggles: box.querySelectorAll(".settings-toggle").length,
      chips: Array.from(box.querySelectorAll(".settings-chip")).map((c) => c.textContent.trim()),
    };
  })()`);
  check(
    "settings block renders one control per declaration",
    block?.rows.length === 3 && block.textInputs === 1 && block.toggles === 1 && block.chips.length === 2,
    JSON.stringify(block)
  );
  check("select options render as chips", JSON.stringify(block?.chips) === JSON.stringify(["最新在前", "最早在前"]), JSON.stringify(block?.chips));
  await s.shot("p3_plugin_pane.png");
  s.ws.close();
}

// 收尾：把设置改回默认，别把用户的示例状态留在非默认值上
await invoke("plugin_settings_put", { id: "notes", key: "prefix", value: "· " });
await invoke("plugin_settings_put", { id: "notes", key: "sort", value: "newest" });
await sleep(500);

const log = readFileSync("test/p3_lume.log", "utf8");
check("Rust logged the document write", log.includes("[plugins] db put (notes)"), "");
check("Rust logged the private-file write", log.includes("[plugins] fs private write (notes)"), "");
check("Rust logged the store migration", log.includes("storage migrate"), "");
const plog = await m.evalJs(`(window.__plog || []).join("\\n")`);
check(
  "host logged the permission refusal (plog)",
  plog.includes("permission denied") && plog.includes('needs "network"'),
  plog.includes("permission denied") ? "" : "no permission-denied line in the console tap"
);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
