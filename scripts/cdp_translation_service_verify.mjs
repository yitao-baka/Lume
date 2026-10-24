// Translation Page Service / Presenter verification.
// - local HTTP service (no external network)
// - one model shared by two Presenters
// - secret stays in Credential Manager and never enters the model
// - cache hit, cancellation and error recovery
import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const PORT = 18765;
const CDP_PORT = 9236;
const PLUGIN_ID = "translation-demo";
const SECRET = "local-test-key-7f4c";
const FIRST_TEXT = "hello runtime " + Date.now();
const TIMEOUT_TEXT = "__slow__ timeout " + Date.now();
const requests = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {}
    requests.push({ authorization: req.headers.authorization || "", body });
    if (String(body.text || "").includes("__slow__")) await sleep(2500);
    if (String(body.text || "").includes("__fail__")) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("forced translation failure");
      return;
    }
    const text = String(body.text || "");
    const translation = body.engine === "upper" ? text.toUpperCase() : "[" + body.source + "->" + body.target + "] " + text;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ translation }));
  });
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(300);
const BASE = "src-tauri/target/debug";
mkdirSync(BASE + "/plugins", { recursive: true });
rmSync(BASE + "/plugins/" + PLUGIN_ID, { recursive: true, force: true });
cpSync("examples/plugins/" + PLUGIN_ID, BASE + "/plugins/" + PLUGIN_ID, { recursive: true });
mkdirSync("test", { recursive: true });
spawn(BASE + "/lume.exe", [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=" + CDP_PORT },
  stdio: "ignore",
});

let failures = 0;
const check = (name, condition, extra = "") => {
  console.log("[" + (condition ? "PASS" : "FAIL") + "] " + name + (extra ? " — " + extra : ""));
  if (!condition) failures++;
};
async function targets() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch("http://127.0.0.1:" + CDP_PORT + "/json/list")).json(); }
    catch { await sleep(250); }
  }
  throw new Error("CDP unavailable");
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => {
    const key = ++id; pending.set(key, res); ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description || "eval failed"));
    return r?.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("test/" + name, Buffer.from(r.result.data, "base64"));
  };
  return { ws, evalJs, shot };
}
async function findMain() {
  for (let i = 0; i < 60; i++) {
    for (const t of (await targets()).filter((x) => x.type === "page" && x.url.includes("tauri.localhost"))) {
      try {
        const c = await connect(t.webSocketDebuggerUrl);
        if (await c.evalJs('!!document.getElementById("search-input")')) return { target: t, client: c };
        c.ws.close();
      } catch {}
    }
    await sleep(250);
  }
  throw new Error("main target missing");
}
async function findSettings() {
  for (let i = 0; i < 60; i++) {
    for (const t of (await targets()).filter((x) => x.type === "page")) {
      try {
        const c = await connect(t.webSocketDebuggerUrl);
        if (await c.evalJs("!!document.querySelector('[data-settings-skin]')")) return c;
        c.ws.close();
      } catch {}
    }
    await sleep(250);
  }
  throw new Error("settings target missing");
}

let main;
try {
  const found = await findMain();
  main = found.client;
  await main.evalJs('window.__TAURI_INTERNALS__.invoke("toggle_launcher")');
  await sleep(1200);
  await main.evalJs('(() => { const i = document.getElementById("search-input"); i.focus(); i.value = "translate-demo"; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()');
  await sleep(1800);
  const row = await main.evalJs('[...document.querySelectorAll("[data-target-id]")].findIndex((el) => el.textContent.includes("进入 Translation Demo"))');
  check("keyword row reaches translation mode", row >= 0, String(row));
  await main.evalJs('[...document.querySelectorAll("[data-target-id]")][' + row + ']?.click(); "ok"');
  await sleep(2500);
  check("api 2 Presenter iframe mounted", await main.evalJs('!!document.querySelector("iframe.presenter-frame")'));
  check("Presenter sandbox is opaque", await main.evalJs('(() => { const f=document.querySelector("iframe.presenter-frame"); return !!f && (f.getAttribute("sandbox")||"").includes("allow-scripts") && !(f.getAttribute("sandbox")||"").includes("allow-same-origin") && f.contentDocument === null; })()'));
  const srcdoc = await main.evalJs('document.querySelector("iframe.presenter-frame")?.getAttribute("srcdoc") || ""');
  check("Presenter bridge has no sensitive APIs", !/lume\.(http|storage|db|fs|clipboard|secrets)|"http\.request"|"secrets\.get"/.test(srcdoc));
  check("Presenter ready state recorded", await main.evalJs('window.__presenterStates.some((s) => s.pageId === "translation-demo" && s.status === "ready")'));

  await main.evalJs('window.__TAURI_INTERNALS__.invoke("open_settings")');
  const settings = await findSettings();
  await settings.evalJs('document.querySelector("#settings-tab-plugins")?.click(); "ok"');
  await sleep(500);
  await settings.evalJs('(() => { const f=document.querySelector(".plg-filter-input"); if (!f) return false; f.value="translation-demo"; f.dispatchEvent(new Event("input", { bubbles: true })); return true; })()');
  await sleep(500);
  const opened = await settings.evalJs('(() => { const h=[...document.querySelectorAll(".plg-head")].find((x)=>x.textContent.includes("Translation Demo")); if (!h) return false; h.click(); return true; })()');
  await sleep(500);
  check("settings renders secret editor", opened && await settings.evalJs('!!document.querySelector(".plg-secret input")'));
  await settings.evalJs('(() => { const i=document.querySelector(".plg-secret input"); i.value=' + JSON.stringify(SECRET) + '; i.dispatchEvent(new Event("input", { bubbles: true })); const b=document.querySelector(".plg-secret button.settings-link"); b.click(); return true; })()');
  await sleep(700);
  const secretStatus = await settings.evalJs('window.__TAURI_INTERNALS__.invoke("plugin_secret_status", { id: "translation-demo", key: "api_key" })');
  check("settings UI stores declared secret", secretStatus?.set === true, JSON.stringify(secretStatus));
  settings.ws.close();

  const result = await main.evalJs('window.__pageRuntimeDispatch("translation-demo", { type: "query.submit", payload: { query: ' + JSON.stringify(FIRST_TEXT) + ' } })');
  await sleep(300);
  let model = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("service intent completes", result?.status === "completed", JSON.stringify(result));
  check("translated model reaches Presenter", model?.data?.translatedText === "[auto->en] " + FIRST_TEXT, JSON.stringify(model?.data?.translatedText));
  check("API key was read only by the service", requests[0]?.authorization === "Bearer " + SECRET, requests[0]?.authorization || "(none)");
  check("API key is absent from model", !JSON.stringify(model || {}).includes(SECRET));
  check("model exposes only configured boolean", model?.data?.hasApiKey === true);

  const requestCount = requests.length;
  await main.evalJs('window.__pageRuntimeDispatch("translation-demo", { type: "query.submit", payload: { query: ' + JSON.stringify(FIRST_TEXT) + ' } })');
  await sleep(250);
  model = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("cache avoids a second request", requests.length === requestCount, String(requests.length - requestCount));
  check("cache hit is visible", model?.data?.cacheHit === true);

  await main.evalJs('window.__pageRuntimeDispatch("translation-demo", { type: "item.action", targetId: "translation", actionId: "select-engine", payload: { engine: "upper" } })');
  await main.evalJs('window.__pageRuntimeDispatch("translation-demo", { type: "query.submit", payload: { query: "engine switch" } })');
  await sleep(250);
  model = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("engine switch uses same service", model?.data?.translatedText === "ENGINE SWITCH", JSON.stringify(model?.data?.translatedText));

  const revision = model?.revision;
  await main.evalJs('window.__pageRuntimeSwitchPresenter("translation-demo", "compact")');
  await sleep(400);
  const switchState = await main.evalJs('[...window.__presenterStates].reverse().find((s) => s.pageId === "translation-demo" && s.status === "ready")');
  model = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("second Presenter mounts", switchState?.presenterId === "compact", JSON.stringify(switchState));
  check("Presenter switch keeps model revision", model?.revision === revision, revision + " -> " + model?.revision);

  const pending = main.evalJs('window.__pageRuntimeDispatch("translation-demo", { type: "query.submit", payload: { query: "__slow__ cancel me" } })');
  await sleep(120);
  await main.evalJs('window.__pageRuntimeDispatch("translation-demo", { type: "page.cancel" })');
  await pending;
  await sleep(2700);
  model = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("cancel prevents stale completion", model?.data?.phase === "canceled", JSON.stringify(model?.data?.phase));

  const settingsTimeout = await findSettings();
  await settingsTimeout.evalJs('window.__TAURI_INTERNALS__.invoke("plugin_settings_put", { id: "translation-demo", key: "timeout_ms", value: "200" })');
  const timeoutValues = await settingsTimeout.evalJs('window.__TAURI_INTERNALS__.invoke("plugin_settings_get", { id: "translation-demo" })');
  check("timeout setting persists", timeoutValues?.timeout_ms === "200", JSON.stringify(timeoutValues));
  await sleep(600);
  await main.evalJs('window.__pageRuntimeDispatch("translation-demo", { type: "query.submit", payload: { query: ' + JSON.stringify(TIMEOUT_TEXT) + ' } })');
  await sleep(400);
  model = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("timeout reaches retryable error model", model?.status === "error" && model?.data?.phase === "error", JSON.stringify({ status: model?.status, phase: model?.data?.phase, notice: model?.data?.notice, timeoutMs: model?.data?.timeoutMs }));
  await settingsTimeout.evalJs('window.__TAURI_INTERNALS__.invoke("plugin_settings_put", { id: "translation-demo", key: "timeout_ms", value: "8000" })');
  settingsTimeout.ws.close();
  await sleep(300);

  await main.evalJs('window.__pageRuntimeDispatch("translation-demo", { type: "query.submit", payload: { query: "__fail__" } })');
  await sleep(300);
  model = await main.evalJs('window.__pageRuntimeLatestModel("translation-demo")');
  check("network failure reaches error model", model?.status === "error" && model?.data?.phase === "error", JSON.stringify({ status: model?.status, phase: model?.data?.phase }));

  await main.shot("translation-service-verify.png");
  const settings2 = await findSettings();
  await settings2.evalJs('document.querySelector("#settings-tab-plugins")?.click(); "ok"');
  await sleep(400);
  await settings2.evalJs('(() => { const f=document.querySelector(".plg-filter-input"); if (f) { f.value="translation-demo"; f.dispatchEvent(new Event("input", { bubbles: true })); } const h=[...document.querySelectorAll(".plg-head")].find((x)=>x.textContent.includes("Translation Demo")); if (h && !document.querySelector(".plg-secret input")) h.click(); return true; })()');
  await sleep(500);
  await settings2.evalJs('(() => { const buttons=[...document.querySelectorAll(".plg-secret button.settings-link")]; const clear=buttons[buttons.length-1]; clear?.click(); return !!clear; })()');
  await sleep(700);
  const cleared = await settings2.evalJs('window.__TAURI_INTERNALS__.invoke("plugin_secret_status", { id: "translation-demo", key: "api_key" })');
  check("settings UI clears secret", cleared?.set === false, JSON.stringify(cleared));
  settings2.ws.close();
} finally {
  try { main?.ws.close(); } catch {}
  await new Promise((resolve) => server.close(resolve));
  try { execSync("taskkill /F /T /IM lume.exe", { stdio: "ignore" }); } catch {}
}
console.log(failures === 0 ? "TRANSLATION SERVICE VERIFY OK" : "TRANSLATION SERVICE VERIFY FAILED (" + failures + ")");
process.exit(failures === 0 ? 0 : 1);
