// Satellite preview host capability probe.
// Verifies native window visibility for the internal host and the
// manifest-gated plugin path. Preview DOM inspection is best-effort because
// WebView2 can keep a hidden preview target at about:blank in CDP metadata.
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const PORT = 9250;
const BASE = "src-tauri/target/debug";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

rmSync(`${BASE}/plugins/host-tools`, { recursive: true, force: true });
cpSync("examples/plugins/host-tools", `${BASE}/plugins/host-tools`, { recursive: true });
const deniedDir = `${BASE}/plugins/preview-denied`;
rmSync(deniedDir, { recursive: true, force: true });
mkdirSync(deniedDir, { recursive: true });
writeFileSync(`${deniedDir}/plugin.toml`, 'id = "preview-denied"\nkind = "service"\napi = 2\nentry = "main.js"\n');
writeFileSync(`${deniedDir}/main.js`, "export default {};\n");

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(400);
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: "ignore",
});

const targets = async () => {
  for (let i = 0; i < 80; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(250); }
  }
  throw new Error("CDP unavailable");
};

const connect = async (url) => {
  const ws = new WebSocket(url);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result?.result?.value;
  };
  return { ws, evalJs };
};

let main = null;
for (let i = 0; i < 100 && !main; i++) {
  for (const target of (await targets()).filter((item) => item.type === "page")) {
    try {
      const handle = await connect(target.webSocketDebuggerUrl);
      if (await handle.evalJs('!!document.getElementById("search-input")')) {
        main = handle;
        break;
      }
    } catch {}
  }
  if (!main) await sleep(250);
}
if (!main) throw new Error("launcher target missing");

const invoke = (command, args = {}) =>
  main.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
const invokeError = (command, args = {}) =>
  main.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then(() => "").catch((error) => String(error))`);
const visible = (label) =>
  main.evalJs(`window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: ${JSON.stringify(label)} }).catch(() => false)`);

const failures = [];
const check = (condition, label, detail = "") => {
  console.log(`[${condition ? "PASS" : "FAIL"}] ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures.push(label);
};

const summonAndShow = (args) => main.evalJs(
  `window.__TAURI_INTERNALS__.invoke("hide_launcher")
    .then(() => window.__TAURI_INTERNALS__.invoke("toggle_launcher"))
    .then(() => window.__TAURI_INTERNALS__.invoke("show_preview", ${JSON.stringify(args)}))
    .then(() => window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "preview" }))
    .catch((error) => "ERR:" + String(error))`
);

let coreShow = await summonAndShow({ req: { kind: "text", content: "core preview probe" } });
if (coreShow !== true) {
  // The very first synthetic summon can race the frontend's focus/listener
  // boot. Retry once, as the real follow path fires after user interaction.
  await sleep(250);
  coreShow = await summonAndShow({ req: { kind: "text", content: "core preview probe" } });
}
check(coreShow === true, "core preview command shows the window", String(coreShow));
console.log("[probe] launcher visible after core show:", await visible("main"));
await invoke("close_preview");
check(await visible("preview") === false, "core preview closes");

const deniedText = await invokeError("show_preview", {
  pluginId: "preview-denied",
  req: { kind: "text", content: "denied" },
});
check(deniedText.includes("permission denied") && deniedText.includes("preview"), "undeclared plugin preview refused", deniedText);

const pluginShow = await summonAndShow({
  pluginId: "host-tools",
  req: { kind: "text", content: "plugin preview probe" },
});
check(pluginShow === true, "declared plugin reuses the core window", String(pluginShow));
console.log("[probe] launcher visible after plugin show:", await visible("main"));
await invoke("close_preview");
check(await visible("preview") === false, "preview closes after plugin use");

// Exercise the real public path: provider logic -> ctx.preview.show -> Rust.
await main.evalJs(`(() => {
  const input = document.getElementById("search-input");
  input.focus();
  input.value = "h:预览";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return "ok";
})()`);
let clickedPluginAction = false;
for (let i = 0; i < 40 && !clickedPluginAction; i++) {
  clickedPluginAction = await main.evalJs(`(() => {
    const row = Array.from(document.querySelectorAll(".result-box")).find((node) =>
      node.textContent.includes("h: 预览")
    );
    if (!row) return false;
    row.click();
    return true;
  })()`);
  if (!clickedPluginAction) await sleep(200);
}
check(clickedPluginAction, "host-tools preview action is searchable");
await sleep(350);
check(await visible("preview") === true, "ctx.preview.show opens the core window");
await invoke("close_preview");

console.log(`[preview-capability] ${failures.length ? "FAIL" : "PASS"}`);
process.exit(failures.length ? 1 : 0);
