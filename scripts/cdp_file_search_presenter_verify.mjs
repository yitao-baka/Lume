// File-search Page Runtime verification: one Page Service model, two
// Presenters, query/model retention and restricted Presenter APIs.
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
const PORT = 9251;
const ID = "file-search";
const BASE = "src-tauri/target/debug";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => { console.log("[" + (ok ? "PASS" : "FAIL") + "] " + name + (extra ? " — " + extra : "")); if (!ok) failures++; };
function kill() { try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {} try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {} }
async function targets() { for (let i=0;i<60;i++){ try { return await (await fetch("http://127.0.0.1:"+PORT+"/json/list")).json(); } catch { await sleep(250); } } throw new Error("CDP unavailable"); }
async function connect(url) { const ws=new WebSocket(url); let id=0; const p=new Map(); ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}}; await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j}); const send=(method,params={})=>new Promise(r=>{const k=++id;p.set(k,r);ws.send(JSON.stringify({id:k,method,params}))}); const ev=async expr=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true}); if(r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description||"eval failed")); return r.result?.result?.value}; return {ws,ev}; }
async function findMain(){ for(let i=0;i<60;i++){ for(const t of (await targets()).filter(x=>x.type==="page"&&x.url.includes("tauri.localhost"))){ try{const c=await connect(t.webSocketDebuggerUrl); if(await c.ev('!!document.getElementById("search-input")')) return c; c.ws.close();}catch{} } await sleep(250);} throw new Error("main missing"); }
async function waitFor(c,expr,timeout=8000){const start=Date.now();while(Date.now()-start<timeout){try{if(await c.ev(expr))return true}catch{}await sleep(150)}return false}
mkdirSync("test",{recursive:true}); mkdirSync(BASE+"/plugins",{recursive:true}); rmSync(BASE+"/plugins/"+ID,{recursive:true,force:true}); cpSync("examples/plugins/"+ID,BASE+"/plugins/"+ID,{recursive:true});
let main;
try {
  kill(); await sleep(400);
  spawn(BASE+"/lume.exe",[],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:"--remote-debugging-port="+PORT},stdio:"ignore"});
  main=await findMain(); await sleep(1500);
  const invoke=(cmd,args={})=>main.ev('window.__TAURI_INTERNALS__.invoke('+JSON.stringify(cmd)+','+JSON.stringify(args)+')');
  if(!(await invoke("plugin:window|is_visible",{label:"main"}))){await invoke("toggle_launcher");await sleep(900)}
  await main.ev('(() => { const i=document.getElementById("search-input"); i.focus(); i.value="秒搜"; i.dispatchEvent(new Event("input",{bubbles:true})); return "ok"; })()');
  await waitFor(main,'[...document.querySelectorAll("[data-target-id]")].some((el)=>el.textContent.includes("文件秒搜"))');
  await main.ev('(() => { const row=[...document.querySelectorAll("[data-target-id]")].find((el)=>el.textContent.includes("文件秒搜")); row?.click(); return !!row; })()');
  await waitFor(main,'!!document.querySelector("iframe.presenter-frame") && window.__pageRuntimeLatestModel("file-search")?.schema === "lume.collection/v1"');
  let model=await main.ev('window.__pageRuntimeLatestModel("file-search")');
  const srcdoc=await main.ev('document.querySelector("iframe.presenter-frame")?.getAttribute("srcdoc") || ""');
  check("file-search mounts the default Presenter", /lume\.page/.test(srcdoc) && !/lume\.(http|storage|db|fs|clipboard|secrets)/.test(srcdoc));
  check("file-search uses the shared collection model", model?.schema === "lume.collection/v1", JSON.stringify({schema:model?.schema,revision:model?.revision}));
  const revision=model?.revision;
  await main.ev('(() => { const i=document.getElementById("search-input"); i.value="readme"; i.dispatchEvent(new Event("input",{bubbles:true})); return "ok"; })()');
  await waitFor(main,'window.__pageRuntimeLatestModel("file-search")?.data?.query === "readme"');
  model=await main.ev('window.__pageRuntimeLatestModel("file-search")');
  check("query reaches the Page Service", model?.data?.query === "readme", JSON.stringify({query:model?.data?.query,status:model?.status}));
  await main.ev('window.__pageRuntimeSwitchPresenter("file-search","compact")');
  await waitFor(main,'window.__presenterStates.some((state)=>state.pageId==="file-search"&&state.presenterId==="compact"&&state.status==="ready")');
  const compactModel=await main.ev('window.__pageRuntimeLatestModel("file-search")');
  const compactSrc=await main.ev('document.querySelector("iframe.presenter-frame")?.getAttribute("srcdoc") || ""');
  check("file-search switches to the alternate Presenter", compactSrc.includes("item") && compactSrc.includes("lume.page"));
  check("Presenter switch preserves query and service model", compactModel?.data?.query === "readme" && compactModel?.revision >= revision, JSON.stringify({query:compactModel?.data?.query,revision:[revision,compactModel?.revision]}));
  await main.ev('window.__pageRuntimeSwitchPresenter("file-search","default")');
} catch(error){ console.error("FILE SEARCH RUNTIME ERROR",error); failures++; }
finally { try{main?.ws.close()}catch{} kill(); }
console.log("\nFILE-SEARCH-RUNTIME-VERIFY "+(failures===0?"PASS":"FAIL")+" ("+failures+" failure(s))"); process.exit(failures===0?0:1);
