// Detached api 2 Page Runtime verification: the launcher-owned Page Service
// answers intents from a Presenter mounted in the plugin window; model,
// settings, presenter selection and re-dock remain shared.
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const PORT = 9250;
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
  return { ws, send, evalJs };
}
async function findMain() {
  for (let i = 0; i < 60; i++) {
    for (const target of (await targets()).filter((item) => item.type === "page" && item.url.includes("tauri.localhost"))) {
      try {
        const client = await connect(target.webSocketDebuggerUrl);
        if (await client.evalJs('!!document.getElementById("search-input")')) return client;
        client.ws.close();
      } catch {}
    }
    await sleep(250);
  }
  throw new Error("main target missing");
}
async function findDetached() {
  for (let i = 0; i < 60; i++) {
    const target = (await targets()).find(
      (item) => item.type === "page" && item.url.includes("plugin.html?plugin=" + PLUGIN_ID)
    );
    if (target) {
      try {
        const client = await connect(target.webSocketDebuggerUrl);
        if (await client.evalJs("!!window.__detachedPageRuntime")) return client;
        client.ws.close();
      } catch {}
    }
    await sleep(250);
  }
  throw new Error("detached target missing");
}
async function waitFor(client, expression, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await client.evalJs(expression)) return true; } catch {}
    await sleep(150);
  }
  return false;
}
async function clickSelector(client, selector) {
  const rect = await client.evalJs(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, width: r.width, height: r.height };
  })()`);
  if (!rect) return null;
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y, button: "none" });
  await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x: rect.x, y: rect.y, button: "left", buttons: 1, clickCount: 1 });
  await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: rect.x, y: rect.y, button: "left", buttons: 0, clickCount: 1 });
  return rect;
}

async function pressEscape(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
}

mkdirSync("test", { recursive: true });
mkdirSync(BASE + "/plugins", { recursive: true });
rmSync(BASE + "/plugins/" + PLUGIN_ID, { recursive: true, force: true });
cpSync("examples/plugins/" + PLUGIN_ID, BASE + "/plugins/" + PLUGIN_ID, { recursive: true });

let main;
let detached;
let invoke;
let originalSettings = null;
let originalPresenterSettings = null;
let originalChoice;
try {
  kill();
  await sleep(400);
  spawn(BASE + "/lume.exe", [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + PORT },
    stdio: "ignore",
  });
  main = await findMain();
  await sleep(1500);
  invoke = (cmd, args = {}) => main.evalJs(
    'window.__TAURI_INTERNALS__.invoke(' + JSON.stringify(cmd) + ', ' + JSON.stringify(args) + ')'
  );
  if (!(await invoke("plugin:window|is_visible", { label: "main" }))) {
    await invoke("toggle_launcher");
    await sleep(900);
  }
  originalSettings = await invoke("get_settings");
  originalChoice = originalSettings?.pages?.presenters?.[PLUGIN_ID];
  originalPresenterSettings = await invoke("plugin_presenter_settings_get", { id: PLUGIN_ID });
  const startMap = { ...(originalSettings?.pages?.presenters ?? {}), [PLUGIN_ID]: "default" };
  await invoke("save_settings_patch", { patch: { pages: { presenters: startMap } } });
  await invoke("plugin_presenter_settings_put", {
    id: PLUGIN_ID, presenter: "default", key: "density", value: "comfortable",
  });
  await main.evalJs('(() => { const i=document.getElementById("search-input"); i.focus(); i.value="translate-demo"; i.dispatchEvent(new Event("input",{bubbles:true})); return "ok"; })()');
  await waitFor(main, '[...document.querySelectorAll(".result-box")].some((el) => el.textContent.includes("Translation Demo"))');
  await main.evalJs('(() => { const row=[...document.querySelectorAll(".result-box")].find((el) => el.textContent.includes("Translation Demo")); row?.click(); return !!row; })()');
  await waitFor(main, 'window.__presenterStates.some((state) => state.pageId === "translation-demo" && state.presenterId === "default" && state.status === "ready")');
  const launcherModel = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("launcher Page Service owns the translation model", launcherModel?.schema === "translator.translation/v1", JSON.stringify({ schema: launcherModel?.schema, revision: launcherModel?.revision }));

  await invoke("plugin_presenter_settings_put", {
    id: PLUGIN_ID, presenter: "default", key: "density", value: "compact",
  });
  await waitFor(main, '(() => { const state=window.__presenterStates.filter((state) => state.pageId === "translation-demo").at(-1); return state?.layout?.height === 320; })()');
  const clicked = await main.evalJs('(() => { const b=document.querySelector(".detach-btn"); b?.click(); return !!b; })()');
  check("detach affordance is available", clicked);
  detached = await findDetached();
  await waitFor(detached, '!!document.querySelector("iframe.presenter-frame") && !!window.__detachedPageRuntime');
  await waitFor(detached, 'window.__detachedPageRuntime.getState()?.status === "ready"');
  const initial = await detached.evalJs('({ model: window.__detachedPageRuntime.getModel(), state: window.__detachedPageRuntime.getState() })');
  check("detached Presenter receives the shared model", initial.model?.schema === "translator.translation/v1" && initial.model?.revision >= launcherModel.revision, JSON.stringify({ model: initial.model?.revision, state: initial.state }));
  check("detached Presenter receives its scoped setting", initial.state?.presenterId === "default" && initial.state?.layout?.height === 320, JSON.stringify(initial.state));
  const srcdoc = await detached.evalJs('document.querySelector("iframe.presenter-frame")?.getAttribute("srcdoc") || ""');
  check("detached Presenter uses the restricted bridge", /lume.page/.test(srcdoc) && !/lume.(http|storage|db|fs|clipboard|secrets)/.test(srcdoc));

  const intentResult = await detached.evalJs('window.__detachedPageRuntime.dispatch({ type: "item.action", targetId: "translation", actionId: "select-engine", payload: { engine: "upper" } })');
  check("detached intent completes through the launcher Page Service", intentResult?.status === "completed", JSON.stringify(intentResult));
  await waitFor(main, 'window.__pageRuntimeLatestModel("translation-demo")?.data?.engine === "upper"');
  await waitFor(detached, 'window.__detachedPageRuntime.getModel()?.data?.engine === "upper"');
  const synced = await detached.evalJs('window.__detachedPageRuntime.getModel()');
  check("model update returns to the detached Presenter", synced?.data?.engine === "upper", JSON.stringify({ engine: synced?.data?.engine, revision: synced?.revision }));

  await waitFor(detached, 'window.__detachedPageRuntime.titlebarLive() === true');
  const titlebar = await detached.evalJs('!!document.querySelector("iframe.titlebar-frame")');
  const titlebarSrcdoc = await detached.evalJs('document.querySelector("iframe.titlebar-frame")?.getAttribute("srcdoc") || ""');
  check("detached Presenter mounts its titlebar slot", titlebar && /lume\.page/.test(titlebarSrcdoc) && !/lume\.(http|storage|db|fs|clipboard|secrets)/.test(titlebarSrcdoc) && /__LUME_TITLEBAR__/.test(titlebarSrcdoc) && /app\.dragWindow/.test(titlebarSrcdoc), JSON.stringify({ titlebar, srcdoc: titlebarSrcdoc.slice(0, 120) }));
  const titlebarShot = await detached.send("Page.captureScreenshot", { format: "png" });
  if (titlebarShot.result?.data) writeFileSync("test/detached-runtime-titlebar.png", Buffer.from(titlebarShot.result.data, "base64"));
  const titlebarRect = await clickSelector(detached, "iframe.titlebar-frame");
  await waitFor(main, 'window.__pageRuntimeLatestModel("translation-demo")?.data?.engine === "local"');
  const titlebarResult = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("titlebar Presenter dispatches into the same session", !!titlebarRect && titlebarResult?.data?.engine === "local", JSON.stringify({ rect: titlebarRect, engine: titlebarResult?.data?.engine }));

  await invoke("plugin_presenter_settings_put", {
    id: PLUGIN_ID, presenter: "default", key: "density", value: "comfortable",
  });
  await waitFor(detached, 'window.__detachedPageRuntime.getState()?.layout?.height === 560');
  const resetDensity = await detached.evalJs('window.__detachedPageRuntime.getState()');
  check("settings update reaches the detached Presenter", resetDensity?.layout?.height === 560, JSON.stringify(resetDensity));

  const beforePresenter = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  const switchMap = { ...(startMap), [PLUGIN_ID]: "compact" };
  await invoke("save_settings_patch", { patch: { pages: { presenters: switchMap } } });
  await waitFor(detached, 'window.__detachedPageRuntime.getPresenter() === "compact" && window.__detachedPageRuntime.getState()?.status === "ready"');
  const switched = await detached.evalJs('window.__detachedPageRuntime.getState()');
  const afterPresenter = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("detached Presenter switches without replacing the Page Model", switched?.presenterId === "compact" && afterPresenter?.revision >= beforePresenter.revision && afterPresenter?.data?.engine === "local" && !(await detached.evalJs('!!document.querySelector("iframe.titlebar-frame")')), JSON.stringify({ switched, before: beforePresenter?.revision, after: afterPresenter?.revision }));

  await pressEscape(detached);
  await waitFor(main, 'document.querySelector(".mode-host[data-mode=\"translation-demo\"]")?.classList.contains("active")');
  await waitFor(main, 'window.__presenterStates.filter((state) => state.pageId === "translation-demo").at(-1)?.presenterId === "compact" && window.__presenterStates.filter((state) => state.pageId === "translation-demo").at(-1)?.status === "ready"');
  const redocked = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("closing the detached window re-docks the same Page Session", redocked?.revision >= afterPresenter.revision && redocked?.data?.engine === "local", JSON.stringify({ revision: redocked?.revision, engine: redocked?.data?.engine }));
} catch (error) {
  console.error("DETACHED PAGE RUNTIME ERROR", error);
  failures++;
} finally {
  try {
    if (invoke && originalSettings) {
      const restoreMap = { ...(originalSettings?.pages?.presenters ?? {}) };
      if (originalChoice) restoreMap[PLUGIN_ID] = originalChoice;
      else delete restoreMap[PLUGIN_ID];
      await invoke("plugin_window_close", { id: PLUGIN_ID }).catch(() => {});
      await invoke("save_settings_patch", { patch: { pages: { presenters: restoreMap } } });
      await invoke("plugin_presenter_settings_put", {
        id: PLUGIN_ID, presenter: "default", key: "density",
        value: originalPresenterSettings?.default?.density ?? "comfortable",
      });
    }
  } catch (error) {
    console.error("DETACHED PAGE RUNTIME CLEANUP", error);
  }
  try { detached?.ws.close(); } catch {}
  try { main?.ws.close(); } catch {}
  kill();
}
console.log("\nDETACHED-PAGE-RUNTIME-VERIFY " + (failures === 0 ? "PASS" : "FAIL") + " (" + failures + " failure(s))");
process.exit(failures === 0 ? 0 : 1);
