// Network-isolation regression: an api-2 Page Service and Presenter both try
// every native browser exfiltration path without declaring `network`. CSP must
// stop each request before it reaches a loopback HTTP probe.
import { execSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

const PORT = 9249;
const APP = "src-tauri/target/debug/lume.exe";
const PLUGIN_ID = "presenter-network-probe";
const PLUGIN_DIR = `src-tauri/target/debug/plugins/${PLUGIN_ID}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

const requests = [];
const server = createServer((request, response) => {
  requests.push({ method: request.method, url: request.url });
  response.writeHead(204).end();
});
server.on("upgrade", (request, socket) => {
  requests.push({ method: "UPGRADE", url: request.url });
  socket.destroy();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const probeBase = `http://127.0.0.1:${server.address().port}`;

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
mkdirSync("src-tauri/target/debug/plugins", { recursive: true });
cpSync(`scripts/fixtures/${PLUGIN_ID}`, PLUGIN_DIR, { recursive: true, force: true });
for (const file of ["service.js", "view.html"]) {
  const path = `${PLUGIN_DIR}/${file}`;
  writeFileSync(path, readFileSync(path, "utf8").replaceAll("__PROBE_BASE__", probeBase));
}
const logFd = openSync("test/presenter_network_lume.log", "w");
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
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

async function waitFor(client, expression, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await client.evaluate(expression).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}

async function findDetached() {
  for (let i = 0; i < 50; i++) {
    const target = (await targets()).find((item) => item.type === "page" && item.url.includes(`plugin.html?plugin=${PLUGIN_ID}`));
    if (target) return connect(target.webSocketDebuggerUrl);
    await sleep(200);
  }
  return null;
}

let main;
let detached;
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
  await sleep(700);
  await main.evaluate('document.querySelectorAll(".mode-switch-item")[0]?.click(); true');
  await sleep(300);
  const manifest = await main.evaluate(`window.__TAURI_INTERNALS__.invoke("get_plugins").then((list) => list.find((plugin) => plugin.id === ${JSON.stringify(PLUGIN_ID)}) || null)`);
  check("network probe manifest is loadable", !!manifest && !manifest.apiError && manifest.enabled, JSON.stringify(manifest));
  await main.evaluate(`(() => {
    const input = document.getElementById("search-input");
    input.focus(); input.value = "presenternetworkprobe";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  const keyword = await waitFor(main, `[...document.querySelectorAll("[data-target-id]")].some((el) => el.textContent.includes("Presenter Network Probe"))`);
  if (!keyword) {
    console.log("DIAG", JSON.stringify(await main.evaluate(`({
      query: document.getElementById("search-input")?.value,
      pills: [...document.querySelectorAll(".mode-switch-item")].map((el) => el.textContent.trim()),
      names: [...document.querySelectorAll(".result-box-name")].map((el) => el.textContent.trim()).slice(0, 30),
      match: (() => {
        const leaf = [...document.querySelectorAll("body *")].find((el) => el.children.length === 0 && el.textContent.includes("进入 Presenter Network Probe"));
        return leaf ? leaf.parentElement?.parentElement?.outerHTML.slice(0, 1000) : null;
      })(),
      body: document.body.innerText.slice(0, 1200),
    })`)));
  }
  check("network probe mode is discoverable", keyword);
  const entered = await main.evaluate(`(async () => {
    const find = () => [...document.querySelectorAll("[data-target-id]")].find((el) => el.textContent.includes("Presenter Network Probe"));
    const first = find();
    first?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return !!first;
  })()`);
  check("network probe result dispatches activation", entered);
  const ready = await waitFor(main, 'window.__presenterStates.some((state) => state.pageId === "presenter-network-probe" && state.status === "ready")');
  if (!ready) {
    console.log("READY DIAG", JSON.stringify(await main.evaluate(`({
      states: window.__presenterStates ?? [],
      plog: (window.__plog ?? []).slice(-20),
      body: document.body.innerText.slice(0, 500),
    })`)));
    console.log("TARGETS DIAG", JSON.stringify((await targets()).map((target) => ({ type: target.type, title: target.title, url: target.url }))));
  }
  check("Presenter still reaches ready under CSP", ready);
  await sleep(1600);
  check("fetch/form/socket/image/service and self-navigation requests all stay inside the WebView", requests.length === 0, JSON.stringify(requests));
  const frame = await main.evaluate(`(() => {
    const el = document.querySelector("iframe.presenter-frame");
    return el ? { sandbox: el.getAttribute("sandbox") || "", srcdoc: el.getAttribute("srcdoc") || "" } : null;
  })()`);
  check("network CSP is present and connect-src is disabled", !!frame?.srcdoc.includes("connect-src 'none'"));

  // Detached windows are a separate WebView2 creation path. Their Presenter
  // executes the same view.html, so it must be covered by the native guard
  // even though the embedded frame checks already passed.
  const detachClicked = await main.evaluate('(() => { const button = document.querySelector(".detach-btn"); button?.click(); return !!button; })()');
  check("network probe exposes detached Presenter", detachClicked);
  detached = await findDetached();
  check("detached Presenter window opens", !!detached);
  if (detached) {
    const detachedReady = await waitFor(detached, '!!document.querySelector("iframe.presenter-frame")');
    check("detached Presenter reaches the isolated page", detachedReady);
    await sleep(1600);
    check("detached Presenter self-navigation stays inside the WebView", requests.length === 0, JSON.stringify(requests));
  }
} catch (error) {
  console.error("PRESENTER NETWORK VERIFY ERROR", error);
  failures++;
} finally {
  try { detached?.ws.close(); } catch {}
  try { main?.ws.close(); } catch {}
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  await new Promise((resolve) => server.close(resolve));
  try { rmSync(PLUGIN_DIR, { recursive: true, force: true }); } catch {}
}

console.log(failures === 0 ? "PRESENTER NETWORK VERIFY OK" : `PRESENTER NETWORK VERIFY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
