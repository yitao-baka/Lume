// Second-round plugin/navigation/clipboard audit regressions.
// Covers auto-snapshot password redaction, synthetic-row menu/pin boundaries,
// list-template stale-search/onShow handling, and isolated feature regexes.
//
// Run after: pnpm run build && pnpm run tauri build --debug --no-bundle

import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";

const BASE = "src-tauri/target/debug";
const PORT = 9270;
const FIXTURES = "test/audit_r2_fixtures";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}

const manifests = {
  "audit-r2-password": `id = "audit-r2-password"
name = "R2 Password"
version = "1.0.0"
kind = "mode"
api = 2
model = "audit.r2/v1"
page_runtime = true
entry = "service.js"
keywords = ["r2password"]
[[features]]
code = "r2-password-entry"
label = "R2 Password Entry"
regex = "^r2password:cold$"
[[presenters]]
id = "password-probe"
name = "Password Probe"
entry = "probe.html"
`,
  "audit-r2-provider": `id = "audit-r2-provider"
name = "R2 Provider"
version = "1.0.0"
kind = "provider"
api = 2
entry = "main.js"
[[features]]
code = "r2-feature"
label = "R2 Feature"
regex = "^r2feature$"
[[features]]
code = "r2-catastrophic"
label = "R2 Catastrophic"
regex = "^(a+)+$"
`,
  "audit-r2-list": `id = "audit-r2-list"
name = "R2 List"
version = "1.0.0"
kind = "mode"
api = 2
template = "list"
entry = "main.js"
model = "lume.collection/v1"
default_presenter = "collection-list"
keywords = ["r2list"]
`,
};

const service = `export default function create(ctx) {
  let revision = 1;
  let shown = false;
  let entered = null;
  let query = "";
  const events = [];
  function snapshot() {
    return {
      runtime: "lume.page/v1",
      schema: "audit.r2/v1",
      revision: revision++,
      status: "ready",
      data: { title: "R2 Password", shown, entered, query, events },
    };
  }
  return {
    async getModel() {
      await new Promise(function (resolve) { setTimeout(resolve, 700); });
      return snapshot();
    },
    onShow() { shown = true; ctx.page.publish(snapshot()); },
    onQuery(q) { query = q; ctx.page.publish(snapshot()); },
    onEnter(info) { entered = info; ctx.page.publish(snapshot()); },
    onIntent(intent) {
      events.push(intent.type);
      ctx.page.publish(snapshot());
      return { status: "accepted" };
    },
  };
};
`;
const presenter = `<!doctype html><html><head><meta charset="utf-8"><title>R2 Password</title></head>
<body><h1>Password redaction probe</h1><input id="api-key" type="password" autocomplete="off"></body>
<script>
lume.on.query = function (q) { lume.page.dispatch({ type: "probe.query", payload: q || "" }); };
lume.on.show = function () { lume.page.dispatch({ type: "probe.show" }); };
lume.on.enter = function () { lume.page.dispatch({ type: "probe.enter" }); };
setTimeout(function () {
  var input = document.getElementById("api-key");
  input.value = "sk-live-audit-r2";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}, 250);
</script></html>`;

const provider = `export default function create(ctx) {
  return {
    async search(q) {
      if (q !== "r2provider") return [];
      return [
        { name: "R2 Action", enter: true },
        { name: "R2 Invalid" },
        { name: "R2 Bad Drill", drill: true },
      ];
    },
    onEnter() { ctx.app.toast("R2 provider entered"); },
  };
};
`;

const list = `export default function create() {
  let shown = 0;
  return {
    onShow() { shown += 1; },
    async search(q) {
      await new Promise(function (resolve) { setTimeout(resolve, q === "slow" ? 650 : 20); });
      return [{ name: "row-" + q + "-show" + shown, path: "https://example.com/" + q }];
    },
  };
};
`;

rmSync(FIXTURES, { recursive: true, force: true });
mkdirSync(FIXTURES, { recursive: true });
const files = {
  "audit-r2-password/plugin.toml": manifests["audit-r2-password"],
  "audit-r2-password/service.js": service,
  "audit-r2-password/probe.html": presenter,
  "audit-r2-provider/plugin.toml": manifests["audit-r2-provider"],
  "audit-r2-provider/main.js": provider,
  "audit-r2-list/plugin.toml": manifests["audit-r2-list"],
  "audit-r2-list/main.js": list,
};
for (const [name, content] of Object.entries(files)) {
  const path = `${FIXTURES}/${name}`;
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, content);
}
for (const id of Object.keys(manifests)) {
  rmSync(`${BASE}/plugins/${id}`, { recursive: true, force: true });
  cpSync(`${FIXTURES}/${id}`, `${BASE}/plugins/${id}`, { recursive: true });
}

const logFd = openSync("test/audit_r2_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
});
async function targets() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
    catch { await sleep(300); }
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
  const send = (method, params) => new Promise((resolve) => {
    const callId = ++id;
    pending.set(callId, resolve);
    ws.send(JSON.stringify({ id: callId, method, params }));
  });
  const ev = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result?.result?.exceptionDetails) throw new Error(result.result.exceptionDetails.exception?.description ?? "eval failed");
    return result?.result?.result?.value;
  };
  return { ws, ev };
}
let main;
for (let i = 0; i < 60 && !main; i++) {
  for (const target of (await targets()).filter((item) => item.type === "page")) {
    try {
      const candidate = await connect(target.webSocketDebuggerUrl);
      if (await candidate.ev('!!document.getElementById("search-input")')) { main = candidate; break; }
      candidate.ws.close();
    } catch {}
  }
  if (!main) await sleep(300);
}
if (!main) throw new Error("launcher missing");

const invoke = (command, args = {}) =>
  main.ev(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
const typeQuery = async (query) => {
  await main.ev(`(() => { const input=document.getElementById("search-input"); input.focus(); input.value=${JSON.stringify(query)}; input.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
};
const clickPill = async (text) => {
  await main.ev(`(() => { const el=[...document.querySelectorAll(".mode-switch-item")].find((node)=>node.textContent.includes(${JSON.stringify(text)})); el?.click(); return !!el; })()`);
};
const waitText = async (selector, text, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    const found = await main.ev(`[...document.querySelectorAll(${JSON.stringify(selector)})].some((node)=>node.textContent.includes(${JSON.stringify(text)}))`);
    if (found) return true;
    await sleep(150);
  }
  return false;
};
const checks = [];
const check = (name, ok, extra = "") => {
  checks.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
};
await invoke("set_plugin_enabled", { id: "audit-r2-password", enabled: true });
await invoke("set_plugin_enabled", { id: "audit-r2-provider", enabled: true });
await invoke("set_plugin_enabled", { id: "audit-r2-list", enabled: true });
await sleep(1200);
await invoke("toggle_launcher");
await sleep(1200);

// F-01/F-02: a cold feature enters a slow Page Service in query -> show ->
// enter order, the Presenter replays show, and password values stay redacted.
await typeQuery("r2password:cold");
await waitText(".result-box-name", "R2 Password Entry");
await main.ev(`(() => { const row=[...document.querySelectorAll(".result-box")].find((node)=>node.textContent.includes("R2 Password Entry")); row?.click(); return !!row; })()`);
await sleep(2600);
const lifecycle = await main.ev('window.__pageRuntimeLatestModel?.("audit-r2-password")?.data ?? null');
check("cold Page Service receives onQuery/onShow/onEnter", lifecycle?.shown === true && lifecycle?.entered?.code === "r2-password-entry" && lifecycle?.entered?.payload === "r2password:cold" && lifecycle?.events?.includes("probe.query") && lifecycle?.events?.includes("probe.show") && lifecycle?.events?.includes("probe.enter"), JSON.stringify(lifecycle));
const passwordStates = await main.ev('JSON.stringify(window.__frameStates ?? [])');
check("Presenter receives query/show before enter", lifecycle?.events?.indexOf("probe.query") >= 0 && lifecycle?.events?.indexOf("probe.query") < lifecycle?.events?.indexOf("probe.show") && lifecycle?.events?.indexOf("probe.show") < lifecycle?.events?.indexOf("probe.enter"), JSON.stringify(lifecycle?.events));
check("password auto-snapshot value is redacted", passwordStates.includes('"secret":true') && !passwordStates.includes("sk-live-audit-r2"), passwordStates.slice(0, 500));

// Plugin clipboard writes go through the launcher self-write guard: text,
// image and file payloads must not be captured as external history. First
// seed a real external copy through the capture listener, then verify each
// host write leaves that row unchanged (no duplicate, reorder or source-app
// misattribution).
const originalSettings = await invoke("get_settings");
const originalDedup = originalSettings?.clipboard?.dedup ?? true;
try {
  await invoke("save_settings_patch", { patch: { clipboard: { dedup: false } } });
  await sleep(250);
  const clipText = `R2-SEQUENCE-${Date.now()}`;
  await invoke("set_clipboard_text", { text: clipText });
  await sleep(900);
  await invoke("plugin_clipboard_write_image", { data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" });
  await sleep(900);
  await invoke("set_clipboard_text", { text: clipText });
  await sleep(900);
  const sequenceReply = await invoke("search_clipboard", { query: clipText, kind: "all" });
  const sequenceRows = Array.isArray(sequenceReply) ? sequenceReply : sequenceReply.items;
  check("self-written text/image do not enter clipboard history", Array.isArray(sequenceRows) && sequenceRows.length === 0, JSON.stringify(sequenceRows));
  const whitespace = `  R2-WS-${Date.now()}  `;
  const beforeWsReply = await invoke("search_clipboard", { query: "R2-WS-", kind: "all" });
  const beforeWs = Array.isArray(beforeWsReply) ? beforeWsReply : beforeWsReply.items;
  await invoke("set_clipboard_text", { text: whitespace });
  await sleep(900);
  const wsReply = await invoke("search_clipboard", { query: "R2-WS-", kind: "all" });
  const wsRows = Array.isArray(wsReply) ? wsReply : wsReply.items;
  const wsBeforeIds = new Set(beforeWs.map((row) => row.id));
  check("plugin text writes do not enter clipboard history",
    Array.isArray(wsRows) && wsRows.length === beforeWs.length && wsRows.every((row) => wsBeforeIds.has(row.id)),
    JSON.stringify({ beforeWs, wsRows }));
  for (const row of [...(sequenceRows ?? []), ...(wsRows ?? [])]) {
    await invoke("delete_clipboard", { id: row.id }).catch(() => {});
  }
} finally {
  await invoke("save_settings_patch", { patch: { clipboard: { dedup: originalDedup } } }).catch(() => {});
}

// F-08: provider rows without a usable activation path are dropped, and
// synthetic rows expose activation only (never Pin / reveal / admin).
await clickPill("导航");
await sleep(500);
await typeQuery("r2provider");
await waitText(".result-box-name", "R2 Action");
const providerNames = await main.ev('[...document.querySelectorAll(".result-box-name")].map((node)=>node.textContent)');
check("provider action row present", providerNames.includes("R2 Action"), JSON.stringify(providerNames));
check("pathless non-action provider row dropped", !providerNames.includes("R2 Invalid"), JSON.stringify(providerNames));
check("drill row without select dropped", !providerNames.includes("R2 Bad Drill"), JSON.stringify(providerNames));
await main.ev(`(() => { const row=[...document.querySelectorAll(".result-box")].find((node)=>node.textContent.includes("R2 Action")); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles:true, cancelable:true, clientX:360, clientY:260 })); return !!row; })()`);
await sleep(250);
const providerMenu = await main.ev('({ count:document.querySelectorAll(".ctx-menu .ctx-item").length, text:document.querySelector(".ctx-menu")?.textContent ?? "" })');
check("provider-enter menu has one activation item", providerMenu.count === 1, JSON.stringify(providerMenu));
check("provider-enter menu hides app-only actions", !/收藏|Pin/i.test(providerMenu.text) && !/打开文件位置|Open location/i.test(providerMenu.text) && !/管理员|Administrator/i.test(providerMenu.text), providerMenu.text);
await main.ev('document.querySelector(".ctx-overlay")?.click(); "ok"');
await typeQuery("r2feature");
await waitText(".result-box-name", "R2 Feature");
await main.ev(`(() => { const row=[...document.querySelectorAll(".result-box")].find((node)=>node.textContent.includes("R2 Feature")); row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles:true, cancelable:true, clientX:360, clientY:260 })); return !!row; })()`);
await sleep(250);
const featureMenu = await main.ev('({ count:document.querySelectorAll(".ctx-menu .ctx-item").length, text:document.querySelector(".ctx-menu")?.textContent ?? "" })');
check("feature menu has one activation item", featureMenu.count === 1, JSON.stringify(featureMenu));
await main.ev('document.querySelector(".ctx-overlay")?.click(); "ok"');
let internalPinRejected = false;
try { await invoke("pin_app", { path: "lume-feature://audit-r2-provider/r2-feature", name: "bad" }); }
catch { internalPinRejected = true; }
check("Rust pin command rejects internal lume schemes", internalPinRejected);

// F-11: stale list search cannot overwrite the newer query, and first
// activation runs onShow exactly once (the displayed counter derives from it).
await typeQuery("r2list");
const listKeyword = await waitText(".result-box-name", "R2 List");
const listKeywordState = await main.ev('({ input:document.getElementById("search-input")?.value ?? "", names:[...document.querySelectorAll(".result-box-name")].map((node)=>node.textContent), overlay:!!document.querySelector(".ctx-overlay") })');
check("list mode keyword row offered", listKeyword, JSON.stringify(listKeywordState));
await main.ev(`(() => { const row=[...document.querySelectorAll(".result-box")].find((node)=>node.textContent.includes("R2 List")); row?.click(); return !!row; })()`);
await sleep(1200);
await typeQuery("slow");
await sleep(80);
await typeQuery("fast");
await sleep(900);
const listState = await main.ev('({ active:!!document.querySelector(".mode-host[data-mode=audit-r2-list].active"), body:document.querySelector(".plugin-list")?.textContent ?? "", names:[...document.querySelectorAll(".plugin-list-name")].map((node)=>node.textContent), input:document.getElementById("search-input")?.value ?? "" })');
const listNames = listState.names;
check("list template keeps the newest delayed query", listNames.includes("row-fast-show1") && !listNames.includes("row-slow-show1"), JSON.stringify(listState));

// F-12.4: a catastrophic feature regex is terminated in a worker and cannot
// freeze the launcher main thread.
await clickPill("导航");
await sleep(500);
await main.ev('window.__r2Ping = 0; setTimeout(()=>{ window.__r2Ping = performance.now(); }, 25); "ok"');
const hostile = "a".repeat(28) + "!";
await typeQuery(hostile);
await sleep(400);
const responsive = await Promise.race([
  main.ev('({ ping: window.__r2Ping, input: document.getElementById("search-input")?.value ?? "" })'),
  sleep(2000).then(() => null),
]);
check("catastrophic feature regex is timeout-isolated", !!responsive && responsive.ping > 0 && responsive.input === hostile, JSON.stringify(responsive));

console.log(`\nAUDIT R2 VERIFY ${checks.every((item) => item.ok) ? "OK" : "FAILED"} (${checks.filter((item) => item.ok).length}/${checks.length})`);
main.ws.close();
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
process.exit(checks.every((item) => item.ok) ? 0 : 1);