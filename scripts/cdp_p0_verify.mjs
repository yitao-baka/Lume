// P0 验证：① provider enter/description/icon 动作条目（actions 示例）；
// ② 多文件入口（actions 的 dist/ 目录 + 相对导入）；③ 关键字拼音匹配
// （ms/miao → 「秒搜」）；④ reload_plugin 热重载事件路径。
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
spawn("src-tauri/target/debug/lume.exe", [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9223" },
  stdio: "ignore",
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
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("test/" + name, Buffer.from(r.result.data, "base64"));
    console.log("saved", name);
  };
  return { ws, evalJs, shot };
}
mkdirSync("test", { recursive: true });
const type = (q) => `(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`;

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
await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`);
await sleep(1500);

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { console.log((ok ? "PASS" : "FAIL") + " " + name + (extra ? " — " + extra : "")); ok ? pass++ : fail++; };

// ── ①+② provider 新契约 + 多文件入口 ──
await m.evalJs(type("zzqx"));
await sleep(2500);
const rows = await m.evalJs(`Array.from(document.querySelectorAll(".result-box")).map((b) => ({
  name: b.querySelector(".result-box-name")?.textContent,
  desc: b.querySelector(".result-box-desc")?.textContent ?? null,
}))`);
const actionRow = rows.find((r) => r.name === "复制当前时间");
const searchRow = rows.find((r) => r.name === `搜索 "zzqx"`);
check("provider action row present (enter/description, multi-file module)", !!actionRow, JSON.stringify(actionRow));
check("provider normal row present", !!searchRow, JSON.stringify(searchRow));
check("description second line rendered", actionRow && !!actionRow.desc, actionRow?.desc ?? "");
await m.shot("p0_provider_rows.png");

// enter 动作：点击动作条目 → onEnter 写剪贴板 + toast，不隐藏启动器
await m.evalJs(`(() => { const boxes = Array.from(document.querySelectorAll(".result-box")); boxes.find((b) => b.querySelector(".result-box-name")?.textContent === "复制当前时间")?.click(); return "ok"; })()`);
await sleep(1200);
const toastText = await m.evalJs(`document.querySelector(".toast, [class*=toast]")?.textContent ?? null`);
const stillVisible = await m.evalJs(`!!document.getElementById("search-input") && document.visibilityState === "visible"`);
check("enter action ran (toast + launcher stays open)", !!toastText && stillVisible, "toast=" + toastText);

// ── ③ 关键字拼音匹配 ──
await m.evalJs(type("ms"));
await sleep(1500);
let names = await m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
check("keyword initials pinyin (ms → 秒搜/file-search)", names.some((n) => n.includes("进入") && n.includes("秒搜")), JSON.stringify(names));
await m.evalJs(type("miao"));
await sleep(1500);
names = await m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
check("keyword full pinyin prefix (miao → 秒搜)", names.some((n) => n.includes("进入") && n.includes("秒搜")), JSON.stringify(names));
// 精确匹配仍工作
await m.evalJs(type("秒搜"));
await sleep(1500);
names = await m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
check("keyword exact match (秒搜)", names.some((n) => n.includes("进入") && n.includes("秒搜")), JSON.stringify(names));

// ── ④ reload_plugin 热重载事件路径 ──
const reloadOk = await m.evalJs(`window.__TAURI_INTERNALS__.invoke("reload_plugin", { id: "actions" })`);
await sleep(2000);
await m.evalJs(type("zzqx2"));
await sleep(2500);
names = await m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
check("reload_plugin → provider still works after reload", reloadOk === null && names.some((n) => n.includes(`搜索 "zzqx2"`)), JSON.stringify(names));

await m.shot("p0_final.png");
console.log(`\\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
