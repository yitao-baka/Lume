// Presenter control-plane verification for disk api 2 modes.
// Covers the settings selector, Presenter-scoped values, live delivery,
// selection persistence and restart restoration without touching Page Model.
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const PORT = 9248;
const PLUGIN_ID = "translation-demo";
const BASE = "src-tauri/target/debug";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log("[" + (ok ? "PASS" : "FAIL") + "] " + name + (extra ? " — " + extra : ""));
  if (!ok) failures++;
};
function kill() {
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
}
async function targets() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch("http://127.0.0.1:" + PORT + "/json/list")).json(); } catch { await sleep(250); }
  }
  throw new Error("CDP unavailable");
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params = {}) => new Promise((resolve) => {
    const key = ++id;
    pending.set(key, resolve);
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evalJs = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) throw new Error(String(reply.result.exceptionDetails.exception?.description || "eval failed"));
    return reply.result?.result?.value;
  };
  return { ws, evalJs };
}
async function findPage(test) {
  for (let i = 0; i < 60; i++) {
    for (const target of (await targets()).filter((item) => item.type === "page" && item.url.includes("tauri.localhost"))) {
      try {
        const client = await connect(target.webSocketDebuggerUrl);
        if (await client.evalJs(test)) return client;
        client.ws.close();
      } catch {}
    }
    await sleep(250);
  }
  throw new Error("page target missing");
}
async function waitFor(client, expression, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await client.evalJs(expression)) return true; } catch {}
    await sleep(150);
  }
  return false;
}
async function launch() {
  kill();
  await sleep(400);
  spawn(BASE + "/lume.exe", [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + PORT },
    stdio: "ignore",
  });
  const main = await findPage('!!document.getElementById("search-input")');
  await sleep(1500);
  return main;
}
async function ensureVisible(main) {
  const invoke = (cmd, args = {}) => main.evalJs(
    'window.__TAURI_INTERNALS__.invoke(' + JSON.stringify(cmd) + ', ' + JSON.stringify(args) + ')'
  );
  if (!(await invoke("plugin:window|is_visible", { label: "main" }))) {
    await invoke("toggle_launcher");
    await sleep(900);
  }
  return invoke;
}
async function enterMode(main) {
  await main.evalJs('(() => { const i=document.getElementById("search-input"); i.focus(); i.value="translate-demo"; i.dispatchEvent(new Event("input",{bubbles:true})); return "ok"; })()');
  await waitFor(main, '[...document.querySelectorAll("[data-target-id]")].some((el) => el.textContent.includes("Translation Demo"))');
  await main.evalJs('(() => { const row=[...document.querySelectorAll("[data-target-id]")].find((el) => el.textContent.includes("Translation Demo")); row?.click(); return !!row; })()');
  await waitFor(main, 'window.__presenterStates.some((state) => state.pageId === "translation-demo" && state.presenterId === "default" && state.status === "ready")');
  await waitFor(main, 'window.__presenterStates.filter((state) => state.pageId === "translation-demo").some((state) => state.layout?.height === 560)');
}
async function presenterState(main) {
  return main.evalJs('window.__presenterStates.filter((state) => state.pageId === "translation-demo").at(-1) ?? null');
}

mkdirSync("test", { recursive: true });
mkdirSync(BASE + "/plugins", { recursive: true });
rmSync(BASE + "/plugins/" + PLUGIN_ID, { recursive: true, force: true });
cpSync("examples/plugins/" + PLUGIN_ID, BASE + "/plugins/" + PLUGIN_ID, { recursive: true });

let main;
let settings;
let originalSettings = null;
let originalPresenterSettings = null;
let originalChoice;
let restoreInvoke = null;
try {
  main = await launch();
  const invoke = await ensureVisible(main);
  restoreInvoke = invoke;
  originalSettings = await invoke("get_settings");
  originalChoice = originalSettings?.pages?.presenters?.[PLUGIN_ID];
  originalPresenterSettings = await invoke("plugin_presenter_settings_get", { id: PLUGIN_ID });
  const startMap = { ...(originalSettings?.pages?.presenters ?? {}), [PLUGIN_ID]: "default" };
  await invoke("save_settings_patch", { patch: { pages: { presenters: startMap } } });
  await invoke("plugin_presenter_settings_put", {
    id: PLUGIN_ID,
    presenter: "default",
    key: "density",
    value: "comfortable",
  });
  await enterMode(main);
  const initialModel = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  let state = await presenterState(main);
  check("default Presenter receives its initial setting", state?.presenterId === "default" && state?.layout?.height === 560, JSON.stringify(state));

  await invoke("open_settings");
  settings = await findPage('!!document.querySelector("[data-settings-skin]")');
  await settings.evalJs('document.querySelector("#settings-tab-plugins")?.click(); "ok"');
  await sleep(500);
  await settings.evalJs('(() => { const input=document.querySelector(".plg-filter-input"); if(!input) return false; input.value="translation-demo"; input.dispatchEvent(new Event("input",{bubbles:true})); return true; })()');
  await sleep(450);
  await settings.evalJs('(() => { const head=[...document.querySelectorAll(".plg-head")].find((el) => el.textContent.includes("Translation Demo")); head?.click(); return !!head; })()');
  await waitFor(settings, `!!document.querySelector('[data-setting-id="plugin.translation-demo.presenter"]')`);
  const selector = await settings.evalJs(`(() => { const el=document.querySelector('[data-setting-id="plugin.translation-demo.presenter"]'); return el ? { value: el.value, options: [...el.options].map((option) => option.value) } : null; })()`);
  check("settings lists compatible Presenters", selector?.value === "default" && selector?.options?.includes("compact"), JSON.stringify(selector));
  const densitySelector = '[data-setting-id="plugin.translation-demo.presenter.default.setting.density"]';
  check("settings renders the selected Presenter's declared settings", await settings.evalJs(`!!document.querySelector(${JSON.stringify(densitySelector)})`));
  await settings.evalJs(`(() => { const row=document.querySelector(${JSON.stringify(densitySelector)}); const chip=[...row.querySelectorAll(".settings-chip")].find((el) => el.textContent.includes("Compact")); chip?.click(); return !!chip; })()`);
  await waitFor(main, '(() => { const state=window.__presenterStates.filter((state) => state.pageId === "translation-demo").at(-1); return state?.layout?.height === 320; })()');
  state = await presenterState(main);
  const deliveries = await main.evalJs('window.__presenterSettings ?? []');
  check("Presenter setting reaches the live iframe", state?.presenterId === "default" && state?.layout?.height === 320, JSON.stringify({ state, deliveries }));

  await settings.evalJs(`(() => { const el=document.querySelector('[data-setting-id="plugin.translation-demo.presenter"]'); el.value="compact"; el.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`);
  await waitFor(main, 'window.__presenterStates.some((state) => state.pageId === "translation-demo" && state.presenterId === "compact" && state.status === "ready")');
  state = await presenterState(main);
  check("settings switches the live Presenter", state?.presenterId === "compact", JSON.stringify(state));

  await settings.evalJs(`(() => { const el=document.querySelector('[data-setting-id="plugin.translation-demo.presenter"]'); el.value="default"; el.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`);
  await waitFor(main, '(() => { const state=window.__presenterStates.filter((state) => state.pageId === "translation-demo").at(-1); return state?.presenterId === "default" && state?.layout?.height === 320; })()');
  state = await presenterState(main);
  check("Presenter switch preserves its scoped setting", state?.presenterId === "default" && state?.layout?.height === 320, JSON.stringify(state));
  const modelBefore = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  const statesBeforeModel = await main.evalJs('window.__presenterStates.filter((state) => state.pageId === "translation-demo")');
  check("Presenter changes retain the Page Model/service", initialModel?.schema === "translator.translation/v1" && modelBefore?.schema === initialModel?.schema && modelBefore?.revision >= initialModel?.revision && modelBefore?.status !== "loading", JSON.stringify({ initial: initialModel?.revision, after: modelBefore?.revision, states: statesBeforeModel }));

  await settings.evalJs(`(() => { const el=document.querySelector('[data-setting-id="plugin.translation-demo.presenter"]'); el.value="compact"; el.dispatchEvent(new Event("change",{bubbles:true})); return true; })()`);
  await waitFor(main, 'window.__presenterStates.some((state) => state.pageId === "translation-demo" && state.presenterId === "compact" && state.status === "ready")');
  const persisted = await settings.evalJs('window.__TAURI_INTERNALS__.invoke("get_settings")');
  check("disk Presenter selection persists in settings", persisted?.pages?.presenters?.[PLUGIN_ID] === "compact", JSON.stringify(persisted?.pages?.presenters));
  const stored = await settings.evalJs(`window.__TAURI_INTERNALS__.invoke("plugin_presenter_settings_get", { id: ${JSON.stringify(PLUGIN_ID)} })`);
  check("Presenter values persist by presenter namespace", stored?.default?.density === "compact", JSON.stringify(stored));
  settings.ws.close();
  settings = null;

  main.ws.close();
  main = await launch();
  const invoke2 = await ensureVisible(main);
  restoreInvoke = invoke2;
  await enterMode(main);
  await waitFor(main, 'window.__presenterStates.some((state) => state.pageId === "translation-demo" && state.presenterId === "compact" && state.status === "ready")');
  state = await presenterState(main);
  check("selected disk Presenter restores after restart", state?.presenterId === "compact", JSON.stringify(state));

} catch (error) {
  console.error("PRESENTER CONTROL ERROR", error);
  failures++;
} finally {
  try {
    if (restoreInvoke && originalSettings) {
      const restoreMap = { ...(originalSettings?.pages?.presenters ?? {}) };
      if (originalChoice) restoreMap[PLUGIN_ID] = originalChoice;
      else delete restoreMap[PLUGIN_ID];
      await restoreInvoke("save_settings_patch", { patch: { pages: { presenters: restoreMap } } });
      await restoreInvoke("plugin_presenter_settings_put", {
        id: PLUGIN_ID,
        presenter: "default",
        key: "density",
        value: originalPresenterSettings?.default?.density ?? "comfortable",
      });
    }
  } catch (error) {
    console.error("PRESENTER CONTROL CLEANUP", error);
  }
  try { settings?.ws.close(); } catch {}
  try { main?.ws.close(); } catch {}
  kill();
}
console.log("\nPRESENTER-CONTROL-VERIFY " + (failures === 0 ? "PASS" : "FAIL") + " (" + failures + " failure(s))");
process.exit(failures === 0 ? 0 : 1);
