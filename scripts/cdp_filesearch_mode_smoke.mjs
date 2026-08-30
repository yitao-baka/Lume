// One-off verification for the file-search MODE plugin: keyword entry →
// bridged iframe renders host `search.files` hits → keyboard navigation.
// Run with the debug exe + vite dev server: `npm run dev` first.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
spawn("src-tauri/target/debug/lume.exe", [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  stdio: "ignore",
});
async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch("http://127.0.0.1:9222/json/list")).json(); } catch { await sleep(500); }
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
let mainT = null;
for (let i = 0; i < 40 && !mainT; i++) {
  const pages = ((await getTargets()) ?? []).filter(
    (t) => t.type === "page" && (t.url.includes("tauri.localhost") || t.url.includes("localhost:1420")),
  );
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
await sleep(1200);

// 1) Keyword entry: type 秒搜 → 「进入 文件秒搜」 row → click + Enter.
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await type("秒搜");
await sleep(1500);
const kw = await m.evalJs(
  `[...document.querySelectorAll(".result-box")].findIndex((el) => el.textContent.includes("进入 文件秒搜"))`,
);
console.log("keyword row index:", kw);
if (kw < 0) { console.error("keyword row missing — plugin not loaded?"); process.exit(1); }
await m.evalJs(`(() => {
  const el = [...document.querySelectorAll(".result-box")][${kw}];
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  return "clicked";
})()`);
await sleep(200);
await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))`);
await sleep(1200);
const frameReady = await m.evalJs(
  `(() => { const f = document.querySelector(".plugin-frame"); return f && f.contentDocument ? !!f.contentDocument.getElementById("list") : false; })()`,
);
console.log("mode iframe ready:", frameReady);

// 2) Search inside the mode: the query flows lume.on.query → search.files.
await type("readme");
await sleep(2500);
const rows = await m.evalJs(
  `(() => { const d = document.querySelector(".plugin-frame").contentDocument;
     return { n: d.querySelectorAll(".row").length,
              first: d.querySelector(".row .name")?.textContent,
              path: d.querySelector(".row.sel .path")?.textContent,
              meta: d.getElementById("meta").textContent }; })()`,
);
console.log("mode rows:", JSON.stringify(rows));

// 3) Keyboard: ArrowDown moves the selection inside the iframe.
await m.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }))`);
await sleep(300);
const sel2 = await m.evalJs(
  `(() => { const d = document.querySelector(".plugin-frame").contentDocument;
     return [...d.querySelectorAll(".row")].findIndex((r) => r.classList.contains("sel")); })()`,
);
console.log("selected after ArrowDown:", sel2);
await m.shot("filesearch_mode.png");

const ok = frameReady && rows.n > 0 && rows.meta.includes("everything") && sel2 === 1;
console.log(ok ? "MODE SMOKE OK" : "MODE SMOKE FAILED");
process.exit(ok ? 0 : 1);
