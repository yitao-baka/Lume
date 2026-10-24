// Negative regression for the strict plugin-api gate. Both fixtures declare
// api = 1: one is a provider with a feature + provider marker, the other a
// page-runtime mode. Neither may execute or open a detached window.
import { execSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const PORT = 9248;
const APP = "src-tauri/target/debug/lume.exe";
const PLUGINS = "src-tauri/target/debug/plugins";
const FIXTURES = ["legacy-api-provider", "legacy-api-mode"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

function cleanupFixtures() {
  for (const id of FIXTURES) {
    try { rmSync(`${PLUGINS}/${id}`, { recursive: true, force: true }); } catch {}
  }
}

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
mkdirSync(PLUGINS, { recursive: true });
for (const id of FIXTURES) cpSync(`scripts/fixtures/${id}`, `${PLUGINS}/${id}`, { recursive: true, force: true });
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

async function targets() {
  for (let i = 0; i < 50; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(200); }
  }
  throw new Error("CDP unavailable");
}

async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve) => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  };
  return { ws, evaluate };
}

async function waitFor(client, expression, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await client.evaluate(expression).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}

let main;
try {
  for (let i = 0; i < 50 && !main; i++) {
    for (const target of (await targets()).filter((item) => item.type === "page" && item.url.includes("tauri.localhost"))) {
      try {
        const candidate = await connect(target.webSocketDebuggerUrl);
        if (await candidate.evaluate('!!document.getElementById("search-input")')) { main = candidate; break; }
        candidate.ws.close();
      } catch {}
    }
    if (!main) await sleep(200);
  }
  if (!main) throw new Error("launcher target missing");
  await main.evaluate('window.__TAURI_INTERNALS__.invoke("toggle_launcher")');
  await sleep(800);
  await main.evaluate('document.querySelectorAll(".mode-switch-item")[0]?.click(); true');
  await sleep(300);

  const manifests = await main.evaluate('window.__TAURI_INTERNALS__.invoke("get_plugins")');
  for (const id of FIXTURES) {
    const plugin = manifests.find((entry) => entry.id === id);
    check(`${id} remains visible with an api error`, !!plugin?.apiError, plugin?.apiError || "missing");
  }

  const search = async (query) => {
    await main.evaluate(`(() => {
      const input = document.getElementById("search-input");
      input.focus(); input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await sleep(900);
    return main.evaluate('document.body.innerText');
  };
  const featureText = await search("legacy-api:test");
  check("api-1 feature never renders", !featureText.includes("API1-FEATURE-LOADED"));
  const providerText = await search("zzlegacy");
  check("api-1 provider never executes", !providerText.includes("API1-PROVIDER-LOADED"));
  const modeText = await search("legacyapimode");
  check("api-1 mode never appears or loads", !modeText.includes("Legacy API Mode") && !modeText.includes("API1-MODE-LOADED"));

  const openError = await main.evaluate(`(async () => {
    try { await window.__TAURI_INTERNALS__.invoke("plugin_window_open", { id: "legacy-api-mode" }); return ""; }
    catch (error) { return String(error); }
  })()`);
  check("api-1 mode cannot open a detached window", openError.includes("rejected"), openError);
} catch (error) {
  console.error("API GATE VERIFY ERROR", error);
  failures++;
} finally {
  try { main?.ws.close(); } catch {}
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  cleanupFixtures();
}

console.log(failures === 0 ? "API GATE VERIFY OK" : `API GATE VERIFY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
