// Current Page Runtime smoke: api-2 mode entry, Presenter readiness and the
// opaque sandbox/CSP boundary. It deliberately does not inspect iframe DOM —
// opaque-origin Presenter documents are not reachable from the host target.
import { execSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";

const PORT = 9247;
const APP = "src-tauri/target/debug/lume.exe";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
mkdirSync("src-tauri/target/debug/plugins", { recursive: true });
mkdirSync("test", { recursive: true });
cpSync("examples/plugins/hello-mode", "src-tauri/target/debug/plugins/hello-mode", {
  recursive: true,
  force: true,
});
spawn(APP, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
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
    const response = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result?.result?.value;
  };
  return { ws, evaluate, send };
}

async function waitFor(client, expression, timeout = 7000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await client.evaluate(expression)) return true; } catch {}
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
  await sleep(700);
  await main.evaluate('document.querySelectorAll(".mode-switch-item")[0]?.click(); true');
  await sleep(300);
  await main.evaluate(`(() => {
    const input = document.getElementById("search-input");
    input.focus();
    input.value = "hello";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  const keywordRow = await waitFor(main, `[...document.querySelectorAll("[data-target-id]")].some((el) => el.textContent.includes("Hello Mode"))`);
  check("api-2 mode appears as a keyword row", keywordRow);
  await main.evaluate(`[...document.querySelectorAll("[data-target-id]")].find((el) => el.textContent.includes("Hello Mode"))?.click(); true`);

  const ready = await waitFor(
    main,
    'window.__presenterStates.some((state) => state.pageId === "hello-mode" && state.status === "ready")'
  );
  check("Page Service and Presenter reach ready", ready);
  const frame = await main.evaluate(`(() => {
    const el = document.querySelector("iframe.presenter-frame");
    return el ? {
      sandbox: el.getAttribute("sandbox") || "",
      srcdoc: el.getAttribute("srcdoc") || "",
    } : null;
  })()`);
  check(
    "Presenter srcdoc carries the strict CSP",
    !!frame?.srcdoc.includes("Content-Security-Policy") &&
      frame.srcdoc.includes("connect-src 'none'") &&
      frame.srcdoc.includes("form-action 'none'")
  );
  check(
    "Presenter sandbox is opaque and has no popup/form escape hatch",
    !!frame?.sandbox.includes("allow-scripts") &&
      !frame.sandbox.includes("allow-same-origin") &&
      !frame.sandbox.includes("allow-popups") &&
      !frame.sandbox.includes("allow-forms")
  );
  check("Presenter bridge exposes only the page surface", !!frame?.srcdoc.includes("lume.page") && !frame.srcdoc.includes("__TAURI_INTERNALS__"));

  const shot = await main.send("Page.captureScreenshot", { format: "png" });
  if (shot.result?.data) writeFileSync("test/plugin_v2_mode.png", Buffer.from(shot.result.data, "base64"));
} catch (error) {
  console.error("PLUGIN V2 VERIFY ERROR", error);
  failures++;
} finally {
  try { main?.ws.close(); } catch {}
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
}

console.log(failures === 0 ? "PLUGIN V2 VERIFY OK" : `PLUGIN V2 VERIFY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
