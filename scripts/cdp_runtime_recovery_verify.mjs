// Page Service / Presenter failure recovery: failed boots must leave the
// loading gate, render a visible error, and a retry must be able to recover.
import { execSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const PORT = 9251;
const APP = "src-tauri/target/debug/lume.exe";
const PLUGINS = "src-tauri/target/debug/plugins";
const FIXTURES = ["service-retry", "presenter-failure", "fit-sizing"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

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

async function waitFor(client, expression, timeout = 9000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await client.evaluate(expression).catch(() => false)) return true;
    await sleep(150);
  }
  return false;
}

async function enterByKeyword(main, query, label) {
  await main.evaluate(`(() => {
    const input = document.getElementById("search-input");
    input.focus(); input.value = ${JSON.stringify(query)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await waitFor(main, `[...document.querySelectorAll("[data-target-id]")].some((el) => el.textContent.includes(${JSON.stringify(label)}))`);
  await main.evaluate(`[...document.querySelectorAll("[data-target-id]")].find((el) => el.textContent.includes(${JSON.stringify(label)}))?.click(); true`);
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
  await sleep(700);

  await enterByKeyword(main, "serviceretry", "Service Retry");
  const serviceError = await waitFor(main, '!!document.querySelector(".presenter-error")');
  const serviceGate = await main.evaluate(`(() => {
    const pill = document.querySelector(".mode-switch-item.active");
    return { loading: pill?.classList.contains("loading") ?? true, text: document.querySelector(".presenter-error")?.textContent || "" };
  })()`);
  check("Page Service failure leaves loading and renders an error", serviceError && !serviceGate.loading && serviceGate.text.length > 0, JSON.stringify(serviceGate));
  await main.evaluate('document.querySelector(".presenter-error-retry")?.click(); true');
  const serviceRecovered = await waitFor(main, 'window.__presenterStates.some((state) => state.pageId === "service-retry" && state.status === "ready") && !document.querySelector(".presenter-error")');
  check("retry recovers a failed Page Service boot", serviceRecovered);

  await main.evaluate('document.querySelectorAll(".mode-switch-item")[0]?.click(); true');
  await sleep(300);
  await enterByKeyword(main, "presenterfailure", "Presenter Failure");
  const presenterError = await waitFor(main, '!!document.querySelector(".presenter-error")');
  const presenterState = await main.evaluate('window.__presenterStates.filter((state) => state.pageId === "presenter-failure").at(-1)');
  check(
    "all-Presenter failure is visible and not ready",
    presenterError && presenterState?.status === "error" && !(await main.evaluate('document.querySelector(".mode-switch-item.active")?.classList.contains("loading") ?? true')),
    JSON.stringify(presenterState)
  );

  await main.evaluate('document.querySelectorAll(".mode-switch-item")[0]?.click(); true');
  await sleep(300);
  await enterByKeyword(main, "fitsizing", "Fit Sizing");
  const fitState = await waitFor(
    main,
    'window.__presenterStates.some((state) => state.pageId === "fit-sizing" && state.layout?.sizing === "fit" && state.layout?.contentHeight === 320)'
  );
  await sleep(500);
  const fitHeight = await main.evaluate("window.innerHeight");
  check("Presenter fit/contentHeight drives the launcher sizer", fitState && fitHeight > 300 && fitHeight < 600, String(fitHeight));
  await main.evaluate(`(() => {
    const input = document.getElementById("search-input");
    input.focus(); input.value = "fixed";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  const fixedState = await waitFor(
    main,
    'window.__presenterStates.some((state) => state.pageId === "fit-sizing" && state.layout?.sizing === "fixed" && state.layout?.height === 480)'
  );
  await sleep(500);
  const fixedHeight = await main.evaluate("window.innerHeight");
  check("Presenter fixed sizing takes back over", fixedState && fixedHeight >= 460 && fixedHeight <= 500, String(fixedHeight));
} catch (error) {
  console.error("RUNTIME RECOVERY VERIFY ERROR", error);
  failures++;
} finally {
  try { main?.ws.close(); } catch {}
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  for (const id of FIXTURES) {
    try { rmSync(`${PLUGINS}/${id}`, { recursive: true, force: true }); } catch {}
  }
}

console.log(failures === 0 ? "RUNTIME RECOVERY VERIFY OK" : `RUNTIME RECOVERY VERIFY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
