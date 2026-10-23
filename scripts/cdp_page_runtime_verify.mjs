// Page Model / Presenter integration for built-in Navigate and Clipboard.
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9245;
let failures = 0;
const check = (name, ok, extra = "") => { console.log("[" + (ok ? "PASS" : "FAIL") + "] " + name + (extra ? " — " + extra : "")); if (!ok) failures++; };
function kill() { try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {} try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {} }
async function targets() { for (let i=0;i<50;i++){ try { return await (await fetch("http://127.0.0.1:"+PORT+"/json/list")).json(); } catch { await sleep(200); } } throw new Error("CDP unavailable"); }
async function connect(url) { const ws=new WebSocket(url); let id=0; const p=new Map(); ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}}; await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j}); const send=(method,params)=>new Promise(r=>{const k=++id;p.set(k,r);ws.send(JSON.stringify({id:k,method,params}))}); const ev=async expr=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true}); if(r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text)); return r.result?.result?.value}; const shot=async name=>{const r=await send("Page.captureScreenshot",{format:"png"}); writeFileSync("test/"+name,Buffer.from(r.result.data,"base64"))}; return {ws,ev,shot}; }
async function waitFor(c, expression, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await c.ev(expression)) return true; } catch {}
    await sleep(200);
  }
  return false;
}
async function findSettings() {
  for (let i = 0; i < 50; i++) {
    for (const t of (await targets()).filter((x) => x.type === "page")) {
      try {
        const c = await connect(t.webSocketDebuggerUrl);
        if (await c.ev("!!document.querySelector('[data-settings-skin]')")) return c;
        c.ws.close();
      } catch {}
    }
    await sleep(200);
  }
  throw new Error("settings missing");
}
async function mainTarget() { for (let i=0;i<50;i++){ for(const t of (await targets()).filter(x=>x.type==="page"&&x.url.includes("tauri.localhost"))){ try{const c=await connect(t.webSocketDebuggerUrl); if(await c.ev('!!document.getElementById("search-input")')) return c; c.ws.close();}catch{} } await sleep(250);} throw new Error("main missing"); }
async function launch() { kill(); await sleep(400); spawn("src-tauri/target/debug/lume.exe",[],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:"--remote-debugging-port="+PORT},stdio:"ignore"}); const c=await mainTarget(); await sleep(1400); return c; }
mkdirSync("test",{recursive:true});
let main;
try { main = await launch(); } catch (e) { console.log("LAUNCH FAIL", String(e)); process.exit(1); }
try {
  await main.ev('window.__TAURI_INTERNALS__.invoke("toggle_launcher")');
  await sleep(900);
  await main.ev('(() => { const i=document.getElementById("search-input"); i.focus(); i.value="e"; i.dispatchEvent(new Event("input",{bubbles:true})); return "ok"; })()');
  await sleep(1500);
  let navModel = await main.ev('window.__pageRuntimeLatestModel("apps")');
  check("navigate grid uses lume.navigate/v1", navModel?.schema === "lume.navigate/v1" && (await main.ev('!!document.querySelector(".bar-list, .result-grid")')));
  const navSelection = navModel?.selection?.primaryId;
  const navRevision = navModel?.revision;
  await main.ev('window.__TAURI_INTERNALS__.invoke("open_settings")');
  const settingsUi = await findSettings();
  await settingsUi.ev('document.querySelector("#settings-tab-launcher")?.click(); "ok"');
  await sleep(350);
  await settingsUi.ev(`(() => { const s=document.querySelector('[data-setting-id="pages.presenters.apps"] select'); if(!s) return false; s.value="navigate-list"; s.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`);
  check("navigation switches to alternate Presenter", await waitFor(main, '!!document.querySelector(".nav-list-presenter")'));
  settingsUi.ws.close();
  navModel = await main.ev('window.__pageRuntimeLatestModel("apps")');
  check("navigation keeps selection across Presenter", navModel?.selection?.primaryId === navSelection && navModel?.revision >= navRevision, JSON.stringify({ before: navSelection, after: navModel?.selection?.primaryId, revision: [navRevision, navModel?.revision] }));
  await main.shot("page-runtime-navigate-list.png");
  await main.ev('window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: { apps: "navigate-grid", clipboard: "clipboard-list" } } } })');
  await sleep(700);
  check("navigation returns to grid Presenter", await main.ev('!!document.querySelector(".bar-list, .result-grid")'));

  await main.ev('document.querySelectorAll(".mode-switch-item")[1]?.click(); "ok"');
  await waitFor(main, '!!document.querySelector(".clip-page")');
  await waitFor(main, 'window.__pageRuntimeLatestModel("clipboard")?.status !== "loading" && (window.__pageRuntimeLatestModel("clipboard")?.data?.total || 0) > 0');
  let clipModel = await main.ev('window.__pageRuntimeLatestModel("clipboard")');
  check("clipboard uses lume.clipboard/v1", clipModel?.schema === "lume.clipboard/v1" && (await main.ev('!!document.querySelector(".clip-page")')));
  const clipSelection = clipModel?.selection?.primaryId;
  const clipRevision = clipModel?.revision;
  const clipTotal = clipModel?.data?.total;
  const clipItems = clipModel?.data?.items?.length;
  check("clipboard model is windowed", typeof clipTotal === "number" && typeof clipItems === "number" && (clipTotal <= 40 || clipItems < clipTotal), JSON.stringify({ total: clipTotal, items: clipItems, window: clipModel?.data?.window }));
  await main.ev('window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: { apps: "navigate-grid", clipboard: "clipboard-compact" } } } })');
  check("clipboard switches to compact Presenter", await waitFor(main, '!!document.querySelector(".clip-compact-presenter")'));
  clipModel = await main.ev('window.__pageRuntimeLatestModel("clipboard")');
  check("clipboard keeps model and selection", clipModel?.selection?.primaryId === clipSelection && clipModel?.revision >= clipRevision, JSON.stringify({ before: clipSelection, after: clipModel?.selection?.primaryId, revision: [clipRevision, clipModel?.revision] }));
  await main.shot("page-runtime-clipboard-compact.png");

  const settings = await main.ev('window.__TAURI_INTERNALS__.invoke("get_settings")');
  check("Presenter selection persists", settings?.pages?.presenters?.clipboard === "clipboard-compact");
  main.ws.close();
  main = await launch();
  await main.ev('window.__TAURI_INTERNALS__.invoke("toggle_launcher")');
  await sleep(900);
  await main.ev('document.querySelectorAll(".mode-switch-item")[1]?.click(); "ok"');
  await sleep(1200);
  check("Presenter selection restores after restart", await main.ev('!!document.querySelector(".clip-compact-presenter")'));
  await main.ev('window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: { apps: "navigate-grid", clipboard: "clipboard-list" } } } })');
} finally {
  try { main?.ws.close(); } catch {}
  kill();
}
console.log(failures === 0 ? "PAGE RUNTIME VERIFY OK" : "PAGE RUNTIME VERIFY FAILED ("+failures+")");
process.exit(failures === 0 ? 0 : 1);
