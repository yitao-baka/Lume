// Page Model / Presenter integration for built-in Navigate and Clipboard.
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 9245;
let failures = 0;
const check = (name, ok, extra = "") => { console.log("[" + (ok ? "PASS" : "FAIL") + "] " + name + (extra ? " — " + extra : "")); if (!ok) failures++; };
function kill() { try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {} try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {} }
async function targets() { for (let i=0;i<50;i++){ try { return await (await fetch("http://127.0.0.1:"+PORT+"/json/list")).json(); } catch { await sleep(200); } } throw new Error("CDP unavailable"); }
async function connect(url) { const ws=new WebSocket(url); let id=0; const p=new Map(); ws.onmessage=e=>{const m=JSON.parse(e.data); if(m.id&&p.has(m.id)){p.get(m.id)(m);p.delete(m.id)}}; await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j}); const send=(method,params)=>new Promise(r=>{const k=++id;p.set(k,r);ws.send(JSON.stringify({id:k,method,params}))}); const ev=async expr=>{const r=await send("Runtime.evaluate",{expression:expr,returnByValue:true,awaitPromise:true}); if(r.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description||r.result.exceptionDetails.text)); return r.result?.result?.value}; const shot=async name=>{const r=await send("Page.captureScreenshot",{format:"png"}); writeFileSync("test/"+name,Buffer.from(r.result.data,"base64"))}; return {ws,ev,shot,send}; }
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
        if (await c.ev("document.body.classList.contains('settings-window')")) return c;
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
let originalPresenters = null;
let presentersRestored = false;
const restorePresenters = async () => {
  if (presentersRestored || !main || originalPresenters == null) return;
  await main.ev(`window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: ${JSON.stringify(originalPresenters)} } } })`);
  presentersRestored = true;
};
try { main = await launch(); } catch (e) { console.log("LAUNCH FAIL", String(e)); process.exit(1); }
try {
  await main.ev('window.__TAURI_INTERNALS__.invoke("toggle_launcher")');
  await sleep(900);
  const initialSettings = await main.ev('window.__TAURI_INTERNALS__.invoke("get_settings")');
  originalPresenters = initialSettings?.pages?.presenters ?? {};
  const defaultMap = { ...originalPresenters, apps: "navigate-grid", clipboard: "clipboard-list" };
  await main.ev(`window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: ${JSON.stringify(defaultMap)} } } })`);
  await sleep(500);
  await main.ev('document.querySelectorAll(".mode-switch-item")[0]?.click(); "ok"');
  await sleep(400);
  await main.ev('(() => { const i=document.getElementById("search-input"); i.focus(); i.value="e"; i.dispatchEvent(new Event("input",{bubbles:true})); return "ok"; })()');
  const navResultsReady = await waitFor(
    main,
    '(window.__pageRuntimeLatestModel("apps")?.data?.results?.items?.length || 0) > 0',
    12000
  );
  check("navigate search has indexed results", navResultsReady);
  let navModel = await main.ev('window.__pageRuntimeLatestModel("apps")');
  check("navigate grid uses lume.navigate/v1", navModel?.schema === "lume.navigate/v1" && (await main.ev('!!document.querySelector(".bar-list, .result-grid")')));
  const gridBeforeArrow = navModel?.selection?.primaryId;
  const gridItems = navModel?.data?.results?.items ?? [];
  const gridIndex = gridItems.findIndex((item) => item.id === gridBeforeArrow);
  const gridArrow = gridIndex >= 0 && gridIndex >= gridItems.length - 1 ? "ArrowUp" : "ArrowDown";
  await main.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(gridArrow)}, bubbles: true }))`);
  await sleep(300);
  navModel = await main.ev('window.__pageRuntimeLatestModel("apps")');
  check("navigate grid restores two-dimensional arrow selection", navModel?.selection?.primaryId !== gridBeforeArrow && (await main.ev('!!document.querySelector(".result-grid .result-selected")')), JSON.stringify({ before: gridBeforeArrow, after: navModel?.selection?.primaryId }));
  const navSelection = navModel?.selection?.primaryId;
  const navRevision = navModel?.revision;
  await main.ev('window.__TAURI_INTERNALS__.invoke("open_settings")');
  const settingsUi = await findSettings();
  await settingsUi.ev('document.querySelector("#settings-tab-launcher")?.click(); "ok"');
  await sleep(350);
  await settingsUi.ev(`(() => { const s=document.querySelector('[data-setting-id="pages.presenters.apps"] select'); if(!s) return false; s.value="navigate-list"; s.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`);
  check("navigation switches to alternate Presenter", await waitFor(main, '!!document.querySelector(".nav-list-presenter")'));
  navModel = await main.ev('window.__pageRuntimeLatestModel("apps")');
  check("navigation keeps selection across Presenter", navModel?.selection?.primaryId === navSelection && navModel?.revision >= navRevision, JSON.stringify({ before: navSelection, after: navModel?.selection?.primaryId, revision: [navRevision, navModel?.revision] }));
  settingsUi.ws.close();
  await main.ev('window.__TAURI_INTERNALS__.invoke("close_settings")');
  await sleep(500);
  const launcherVisible = await main.ev('window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" })');
  if (!launcherVisible) await main.ev('window.__TAURI_INTERNALS__.invoke("toggle_launcher")');
  await sleep(900);
  await sleep(500);
  const navListChrome = await main.ev(`(() => {
    const scroll = document.querySelector(".nav-list-scroll");
    const rows = [...document.querySelectorAll(".nav-list-row")];
    return {
      rows: rows.length,
      icons: document.querySelectorAll(".nav-list-row .nav-list-icon-img").length,
      scrollbar: scroll ? getComputedStyle(scroll).scrollbarWidth : null,
      overflow: scroll ? scroll.scrollHeight > scroll.clientHeight : false,
    };
  })()`);
  check("compact navigation renders icons without a native scrollbar", navListChrome.rows > 0 && navListChrome.icons > 0 && navListChrome.scrollbar === "none", JSON.stringify(navListChrome));
  const beforeNavArrow = navModel?.selection?.primaryId;
  const navItems = navModel?.data?.results?.items ?? [];
  const navIndex = navItems.findIndex((item) => item.id === beforeNavArrow);
  const navArrow = navIndex >= 0 && navIndex >= navItems.length - 1 ? "ArrowUp" : "ArrowDown";
  await main.ev(`window.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(navArrow)}, bubbles: true }))`);
  await sleep(350);
  navModel = await main.ev('window.__pageRuntimeLatestModel("apps")');
  check("compact navigation keeps keyboard selection and the active row visible", navModel?.selection?.primaryId !== beforeNavArrow && (await main.ev('!!document.querySelector(".nav-list-row.active")')), JSON.stringify({ before: beforeNavArrow, after: navModel?.selection?.primaryId }));
  await main.shot("page-runtime-navigate-list.png");

  await main.ev('(() => { const i=document.getElementById("search-input"); i.value=""; i.dispatchEvent(new Event("input",{bubbles:true})); return "ok"; })()');
  await sleep(900);
  let navHome = await main.ev('window.__pageRuntimeLatestModel("apps")');
  check("clearing the query restores a visible compact-home selection", navHome?.data?.query === "" && (await main.ev('!!document.querySelector(".nav-list-row.active")')), JSON.stringify({ query: navHome?.data?.query, selected: navHome?.selection?.primaryId }));
  const sectionCandidate = navHome?.data?.sections?.find((section) => section.expandable && section.items.length > 1);
  if (sectionCandidate) {
    const toggleSection = async () => main.ev(`(() => { const button=[...document.querySelectorAll(".nav-list-heading")].find((el)=>el.dataset.navSectionId===${JSON.stringify(sectionCandidate.id)}); button?.click(); return !!button; })()`);
    let sectionNow = navHome?.data?.sections?.find((section) => section.id === sectionCandidate.id);
    if (!sectionNow?.expanded) { await toggleSection(); await sleep(350); }
    await main.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))');
    await sleep(180);
    await main.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))');
    await sleep(250);
    await toggleSection();
    await sleep(400);
    navHome = await main.ev('window.__pageRuntimeLatestModel("apps")');
    sectionNow = navHome?.data?.sections?.find((section) => section.id === sectionCandidate.id);
    const firstId = sectionCandidate.items[0]?.id;
    check("collapsing a compact section clamps selection to its visible row", sectionNow && !sectionNow.expanded && sectionNow.selectedIndex === 0 && (await main.ev(`!!document.querySelector('.nav-list-row.active[data-target-id=${JSON.stringify(sectionCandidate.items[0]?.id)}]')`)), JSON.stringify({ firstId, selectedIndex: sectionNow?.selectedIndex, selected: navHome?.selection?.primaryId }));
  } else {
    check("collapsing a compact section clamps selection to its visible row", false, "no expandable section fixture");
  }
  await main.shot("page-runtime-navigate-list-home.png");
  await main.ev('window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: { apps: "navigate-grid", clipboard: "clipboard-list" } } } })');
  await sleep(700);
  check("navigation returns to grid Presenter", await main.ev('!!document.querySelector(".bar-list, .result-grid")'));

  await main.ev('document.querySelectorAll(".mode-switch-item")[1]?.click(); "ok"');
  await waitFor(main, '!!document.querySelector(".clip-page")');
  await waitFor(main, 'window.__pageRuntimeLatestModel("clipboard")?.status !== "loading" && (window.__pageRuntimeLatestModel("clipboard")?.data?.total || 0) > 0');
  await main.ev('window.__searchClipboardCalls = 0; true');
  await main.ev('window.__lumeHandleInput("audit-one-search")');
  await sleep(900);
  const searchCalls = await main.ev('window.__searchClipboardCalls');
  check("one clipboard keystroke performs exactly one database search", searchCalls === 1, String(searchCalls));
  await main.ev('(() => { const i=document.getElementById("search-input"); i.value=""; i.dispatchEvent(new Event("input",{bubbles:true})); return true; })()');
  await waitFor(main, 'window.__pageRuntimeLatestModel("clipboard")?.status !== "loading" && (window.__pageRuntimeLatestModel("clipboard")?.data?.total || 0) > 0', 8000);
  await sleep(300);
  let clipModel = await main.ev('window.__pageRuntimeLatestModel("clipboard")');
  check("clipboard uses lume.clipboard/v1", clipModel?.schema === "lume.clipboard/v1" && (await main.ev('!!document.querySelector(".clip-page")')));
  let clipSelection = clipModel?.selection?.primaryId;
  let clipRevision = clipModel?.revision;
  const clipTotal = clipModel?.data?.total;
  const clipItems = clipModel?.data?.items?.length;
  check("clipboard model is windowed", typeof clipTotal === "number" && typeof clipItems === "number" && (clipTotal <= 40 || clipItems < clipTotal), JSON.stringify({ total: clipTotal, items: clipItems, window: clipModel?.data?.window }));
  for (let index = 0; index < 15; index++) {
    await main.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))');
    await sleep(18);
  }
  await sleep(500);
  clipModel = await main.ev('window.__pageRuntimeLatestModel("clipboard")');
  const fullClipScroll = await main.ev(`(() => {
    const scroller = document.querySelector(".clip-list");
    const active = scroller?.querySelector('.clip-row[aria-selected="true"]');
    const sr = scroller?.getBoundingClientRect();
    const ar = active?.getBoundingClientRect();
    return {
      scrollTop: scroller?.scrollTop ?? 0,
      offset: window.__pageRuntimeLatestModel("clipboard")?.data?.window?.offset ?? 0,
      activeVisible: !!(sr && ar && ar.top >= sr.top - 1 && ar.bottom <= sr.bottom + 1),
    };
  })()`);
  check("history list keeps keyboard selection inside its virtual viewport", fullClipScroll.scrollTop > 0 && fullClipScroll.offset > 0 && fullClipScroll.activeVisible, JSON.stringify({ window: clipModel?.data?.window, ...fullClipScroll }));
  await main.ev('(() => { const el=document.querySelector(".clip-list"); el?.dispatchEvent(new WheelEvent("wheel", { bubbles: true })); return !!el; })()');
  const scrollGeometry = await main.ev(`(() => {
    const el = document.querySelector(".clip-list");
    return { max: el ? el.scrollHeight - el.clientHeight : 0 };
  })()`);
  await main.ev('(() => { const el=document.querySelector(".clip-list"); if(!el) return false; el.scrollTop=1; el.dispatchEvent(new Event("scroll")); return true; })()');
  await sleep(120);
  const fadeNearTop = await main.ev('({ top: !!document.querySelector(".scroll-fade.top"), bottom: !!document.querySelector(".scroll-fade.bottom") })');
  check("clipboard fades follow real scrollTop near the top", scrollGeometry.max > 2 && fadeNearTop.top && fadeNearTop.bottom, JSON.stringify({ scrollGeometry, fadeNearTop }));
  await main.ev(`(() => { const el=document.querySelector(".clip-list"); if(!el) return false; el.scrollTop=${scrollGeometry.max - 2}; el.dispatchEvent(new Event("scroll")); return true; })()`);
  await sleep(120);
  const fadeNearBottom = await main.ev('({ top: !!document.querySelector(".scroll-fade.top"), bottom: !!document.querySelector(".scroll-fade.bottom") })');
  check("clipboard bottom fade remains near the end before fractional scroll clamps", fadeNearBottom.top && fadeNearBottom.bottom, JSON.stringify(fadeNearBottom));
  const fadeEndGeometry = await main.ev(`(() => {
    const el=document.querySelector(".clip-list");
    if(!el) return null;
    el.scrollTop=el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
    return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
  })()`);
  await sleep(120);
  const fadeAtBottom = await main.ev('({ top: !!document.querySelector(".scroll-fade.top"), bottom: !!document.querySelector(".scroll-fade.bottom") })');
  const fadeEndActual = await main.ev(`(() => { const el=document.querySelector(".clip-list"); return { scrollTop: el?.scrollTop ?? -1, clientHeight: el?.clientHeight ?? -1, scrollHeight: el?.scrollHeight ?? -1 }; })()`);
  check("clipboard bottom fade disappears only at the true end", fadeAtBottom.top && !fadeAtBottom.bottom, JSON.stringify({ fadeAtBottom, fadeEndGeometry, fadeEndActual }));
  clipSelection = clipModel?.selection?.primaryId;
  clipRevision = clipModel?.revision;
  await main.ev('window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: { apps: "navigate-grid", clipboard: "clipboard-compact" } } } })');
  check("clipboard switches to compact Presenter", await waitFor(main, '!!document.querySelector(".clip-compact-presenter")'));
  await sleep(500);
  clipModel = await main.ev('window.__pageRuntimeLatestModel("clipboard")');
  check("clipboard keeps model and selection", clipModel?.selection?.primaryId === clipSelection && clipModel?.revision >= clipRevision, JSON.stringify({ before: clipSelection, after: clipModel?.selection?.primaryId, revision: [clipRevision, clipModel?.revision] }));
  const compactChrome = await main.ev(`(() => {
    const scroller = document.querySelector(".clip-compact-list");
    const row = scroller?.querySelector(".clip-compact-row");
    return {
      scrollbar: scroller ? getComputedStyle(scroller).scrollbarWidth : null,
      rowHeight: row ? getComputedStyle(row).height : null,
      rendered: scroller?.querySelectorAll(".clip-compact-row").length ?? 0,
      modelRows: window.__pageRuntimeLatestModel("clipboard")?.data?.items?.length ?? -1,
    };
  })()`);
  check("compact clipboard uses 44px rows, hidden scrollbar and the windowed model", compactChrome.scrollbar === "none" && compactChrome.rowHeight === "44px" && compactChrome.rendered === compactChrome.modelRows, JSON.stringify(compactChrome));
  for (let index = 0; index < 30; index++) {
    await main.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }))');
    await sleep(12);
  }
  await sleep(400);
  await main.shot("page-runtime-clipboard-compact-top.png");
  const plainSelectionModel = await main.ev('window.__pageRuntimeLatestModel("clipboard")');
  check("plain selection is not rendered as a multi-select check", plainSelectionModel?.data?.status?.selected === 0 && (await main.ev('!document.querySelector(".clip-compact-row .clip-row-check")')), JSON.stringify({ selected: plainSelectionModel?.data?.status?.selected, checks: await main.ev('document.querySelectorAll(".clip-compact-row .clip-row-check").length') }));

  const hoverWasEnabled = await main.ev('(async () => !!(await window.__TAURI_INTERNALS__.invoke("get_settings"))?.clipboard?.hover_select)()');
  if (hoverWasEnabled) {
    await main.ev('window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { clipboard: { hover_select: false } } })');
    await sleep(300);
  }
  const beforeHover = (await main.ev('window.__pageRuntimeLatestModel("clipboard")'))?.selection?.primaryId;
  const hoverTarget = clipModel?.data?.items?.find((row) => row.id !== beforeHover)?.id;
  await main.ev(`(() => { const row=[...document.querySelectorAll(".clip-compact-row")].find((el)=>el.dataset.targetId===${JSON.stringify(hoverTarget)}); row?.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); return !!row; })()`);
  await sleep(220);
  const afterHover = (await main.ev('window.__pageRuntimeLatestModel("clipboard")'))?.selection?.primaryId;
  check("compact clipboard obeys hoverSelect=false", afterHover === beforeHover, JSON.stringify({ beforeHover, afterHover }));
  await main.ev(`(() => { const row=[...document.querySelectorAll(".clip-compact-row")].find((el)=>el.dataset.targetId===${JSON.stringify(hoverTarget)}); row?.click(); return !!row; })()`);
  await sleep(300);
  const afterClick = (await main.ev('window.__pageRuntimeLatestModel("clipboard")'))?.selection?.primaryId;
  check("first compact-row click selects instead of silently pasting", afterClick === hoverTarget && (await main.ev('!!document.querySelector(".clip-page")')), JSON.stringify({ hoverTarget, afterClick }));

  for (let index = 0; index < 25; index++) {
    await main.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }))');
    await sleep(18);
  }
  await sleep(600);
  const scrolledClip = await main.ev('window.__pageRuntimeLatestModel("clipboard")');
  const scrollCheck = await main.ev(`(() => {
    const scroller = document.querySelector(".clip-compact-list");
    const active = scroller?.querySelector('.clip-compact-row[aria-selected="true"]');
    const sr = scroller?.getBoundingClientRect();
    const ar = active?.getBoundingClientRect();
    return {
      scrollTop: scroller?.scrollTop ?? 0,
      offset: window.__pageRuntimeLatestModel("clipboard")?.data?.window?.offset ?? 0,
      activeVisible: !!(sr && ar && ar.top >= sr.top - 1 && ar.bottom <= sr.bottom + 1),
    };
  })()`);
  check("compact clipboard keeps keyboard selection inside the virtual viewport", scrolledClip?.data?.window?.offset > 0 && scrollCheck.activeVisible, JSON.stringify({ window: scrolledClip?.data?.window, ...scrollCheck }));
  await main.shot("page-runtime-clipboard-compact-scrolled.png");

  await main.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))');
  await sleep(250);
  const multiModel = await main.ev('window.__pageRuntimeLatestModel("clipboard")');
  check("compact clipboard exposes multi-select state", (multiModel?.data?.selectedIds?.length ?? 0) > 0 && (await main.ev('!!document.querySelector(".clip-compact-row .clip-row-check")')));
  await main.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await sleep(200);

  await main.ev('document.querySelector(".clip-clear-btn")?.click(); "ok"');
  check("compact clear confirmation opens with the safe action focused", await waitFor(main, '!!document.querySelector(".clip-confirm-overlay") && document.activeElement?.classList.contains("clip-confirm-cancel")'));
  await main.ev('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  check("closing compact clear confirmation restores search focus", await waitFor(main, '!document.querySelector(".clip-confirm") && document.activeElement?.id === "search-input"'));
  if (hoverWasEnabled) {
    await main.ev('window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { clipboard: { hover_select: true } } })');
    await sleep(200);
  }
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
  await main.ev(`window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: ${JSON.stringify(originalPresenters ?? { apps: "navigate-grid", clipboard: "clipboard-list" })} } } })`);
  presentersRestored = true;
} finally {
  try { await restorePresenters(); } catch {}
  try { main?.ws.close(); } catch {}
  kill();
}
console.log(failures === 0 ? "PAGE RUNTIME VERIFY OK" : "PAGE RUNTIME VERIFY FAILED ("+failures+")");
process.exit(failures === 0 ? 0 : 1);
