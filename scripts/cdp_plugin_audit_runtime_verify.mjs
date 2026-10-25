// Focused regression for the plugin/navigation/clipboard audit's runtime
// findings: async navBars, permission hot reload, long result ids, detached
// query replay, provider role boundaries and logic-host listener cleanup.
import { execSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const PORT = 9252;
const BASE = "src-tauri/target/debug";
const APP = `${BASE}/lume.exe`;
const PLUGINS = `${BASE}/plugins`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

for (const id of ["nav-bar", "titlebar-demo", "audit-runtime-probe"]) {
  rmSync(`${PLUGINS}/${id}`, { recursive: true, force: true });
}
mkdirSync(PLUGINS, { recursive: true });
cpSync("examples/plugins/nav-bar", `${PLUGINS}/nav-bar`, { recursive: true });
cpSync("examples/plugins/titlebar-demo", `${PLUGINS}/titlebar-demo`, { recursive: true });
cpSync("scripts/fixtures/audit-runtime-probe", `${PLUGINS}/audit-runtime-probe`, { recursive: true });
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
const logFd = openSync("test/plugin_audit_runtime.log", "w");
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
});

async function targets() {
  for (let i = 0; i < 60; i++) {
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
  return { ws, evaluate, send };
}

async function waitFor(client, expression, timeout = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
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
  const invoke = (cmd, args = {}) => main.evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
  );
  const type = async (query) => {
    await main.evaluate(`window.__launcherTestQuery(${JSON.stringify(query)})`);
  };
  const waitRow = (text, timeout = 12000) => waitFor(
    main,
    `[...document.querySelectorAll("[data-target-id]")].some((el) => el.textContent.includes(${JSON.stringify(text)}))`,
    timeout,
  );

  let manifest = null;
  for (let i = 0; i < 30 && !manifest; i++) {
    const list = await invoke("get_plugins");
    manifest = list.find((plugin) => plugin.id === "audit-runtime-probe") ?? null;
    if (!manifest) await sleep(300);
  }
  check("audit provider manifest is discovered without an API error",
    !!manifest && manifest.enabled && !manifest.apiError, JSON.stringify(manifest));
  await sleep(2500);
  let earlyLogic;
  for (const target of (await targets()).filter((item) => item.url.includes("pluginLogic.html"))) {
    earlyLogic = await connect(target.webSocketDebuggerUrl).catch(() => undefined);
    if (earlyLogic) break;
  }
  const earlyProbe = earlyLogic ? await earlyLogic.evaluate(`(() => ({
    entries: [...(window.__logicEntries?.entries?.() ?? [])].map(([id, entry]) => ({ id, loaded: entry.loaded, calls: entry.calls.size, src: entry.frame?.src })),
    listeners: window.__logicListenerProbe?.listenerCount?.() ?? -1,
    pending: window.__logicListenerProbe?.pendingCalls?.() ?? -1,
  }))()`) : null;
  check("audit provider has a live logic iframe", !!earlyProbe?.entries?.some((entry) => entry.id === "audit-runtime-probe" && entry.loaded), JSON.stringify(earlyProbe));
  earlyLogic?.ws.close();
  check("async navBars contribution reaches the published model",
    await waitFor(main, '(window.__navBarsProbe ?? []).some((entry) => entry.applied && entry.ids.includes("nav-bar:links"))', 15000));
  check("launcher event listeners are ready before the test summons",
    await waitFor(main, 'typeof window.__summonListenerReadyAt === "number"', 15000));
  await invoke("hide_launcher");
  await sleep(500);
  const summonMark = await main.evaluate("Date.now()");
  await invoke("toggle_launcher");
  const summonStarted = await waitFor(main, `(window.__summonStartedAt ?? 0) > ${summonMark}`, 15000);
  check("launcher starts a fresh summon before typing", summonStarted,
    JSON.stringify(await main.evaluate(`({ started: window.__summonStartedAt ?? 0, completed: window.__summonCompletedAt ?? 0, mark: ${summonMark} })`)));
  await sleep(200);
  check("async navBars contribution becomes visible after logic ready",
    await waitFor(main, '!!document.querySelector("[data-bar-id=\\"nav-bar:links\\"]") && document.body.innerText.includes("快速链接")', 8000));

  await type("auditrole");
  const roleReady = await waitRow("AUDIT_ROLE");
  if (!roleReady) {
    console.log("ROLE DIAG", JSON.stringify(await main.evaluate(`({
      input: document.getElementById("search-input")?.value,
      body: document.body.innerText,
      circuit: window.__logicCircuit,
      registry: window.__pluginRegistryProbe ? {
        plugins: window.__pluginRegistryProbe.plugins(),
        logic: window.__pluginRegistryProbe.logic(),
      } : null,
      queryRoute: (window.__queryRoute ?? []).slice(-20),
      pageModels: (window.__pageModels ?? []).slice(-10),
      navBars: (window.__navBarsProbe ?? []).slice(-20),
      navModel: window.__pageRuntimeLatestModel?.("apps")?.data,
      runtime: window.__pageRuntimeLatestModel?.("apps")?.data?.results,
    })`)));
    let debugLogic;
    for (const target of (await targets()).filter((item) => item.url.includes("pluginLogic.html"))) {
      debugLogic = await connect(target.webSocketDebuggerUrl).catch(() => undefined);
      if (debugLogic) break;
    }
    console.log("HOOK DIAG", JSON.stringify(debugLogic ? await debugLogic.evaluate(`window.__logicHookLog?.slice(-12) ?? []`) : null));
    debugLogic?.ws.close();
  }
  check("provider logic receives the general ctx role", roleReady, await main.evaluate("document.body.innerText"));
  const roleText = await main.evaluate(`[...document.querySelectorAll("[data-target-id]")].find((el) => el.textContent.includes("AUDIT_ROLE"))?.textContent || ""`);
  check("provider cannot see page/secrets service APIs", roleText.includes("page:undefined") && roleText.includes("secrets:undefined"), roleText);

  await type("auditlong");
  check("long provider result is visible", await waitRow("AUDIT_LONG_TARGET"));
  const longRow = await main.evaluate(`(() => {
    const el = [...document.querySelectorAll("[data-target-id]")].find((row) => row.textContent.includes("AUDIT_LONG_TARGET"));
    return el ? { id: el.dataset.targetId || "", len: (el.dataset.targetId || "").length } : null;
  })()`);
  check("long path result id stays below the Intent Router limit", !!longRow?.id && longRow.len <= 256, JSON.stringify(longRow));
  const longClicked = await main.evaluate(`(() => {
    const row = [...document.querySelectorAll("[data-target-id]")].find((el) => el.dataset.targetId === ${JSON.stringify(longRow?.id)});
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return !!row;
  })()`);
  check("long result activates through the Intent Router", longClicked);
  check("long result reaches the provider onEnter", await waitFor(main, 'document.querySelector(".toast")?.textContent.includes("AUDIT_LONG_ENTER")', 5000));

  await type("auditperm");
  check("undeclared clipboard permission is denied", await waitRow("AUDIT_PERM DENIED"));
  const manifestPath = `${PLUGINS}/audit-runtime-probe/plugin.toml`;
  writeFileSync(manifestPath, readFileSync(manifestPath, "utf8") + '\npermissions = ["clipboard"]\n');
  await invoke("reload_plugin", { id: "audit-runtime-probe" });
  await sleep(1400);
  await type("auditperm");
  check("permission hot reload allows clipboard without restarting", await waitRow("AUDIT_PERM ALLOWED", 15000));
  for (let i = 0; i < 2; i++) {
    await invoke("reload_plugin", { id: "audit-runtime-probe" });
    await sleep(900);
  }
  await type("auditperm");
  check("plugin remains searchable after repeated reloads", await waitRow("AUDIT_PERM ALLOWED", 15000));

  let logicTarget;
  for (const target of (await targets()).filter((item) => item.type === "page" && item.url.includes("pluginLogic.html"))) {
    logicTarget = await connect(target.webSocketDebuggerUrl).catch(() => undefined);
    if (logicTarget) break;
  }
  const logicProbe = logicTarget ? await logicTarget.evaluate(`(() => ({
    listeners: window.__logicListenerProbe?.listenerCount?.() ?? -1,
    pending: window.__logicListenerProbe?.pendingCalls?.() ?? -1,
    entries: [...(window.__logicEntries?.keys?.() ?? [])].sort(),
  }))()`) : null;
  check("logic host removes one listener per unloaded iframe", !!logicProbe && logicProbe.listeners === logicProbe.entries.length, JSON.stringify(logicProbe));
  check("logic host leaves no pending call timers after reload", !!logicProbe && logicProbe.pending === 0, JSON.stringify(logicProbe));
  logicTarget?.ws.close();

  await type("titlebar");
  await waitRow("Titlebar Demo", 8000);
  await main.evaluate(`(() => {
    const row = [...document.querySelectorAll("[data-target-id]")].find((el) => el.textContent.includes("Titlebar Demo"));
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return !!row;
  })()`);
  await main.evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true');
  await sleep(900);
  await type("an");
  check("detached source query updates the Page Model",
    await waitFor(main, 'window.__pageRuntimeLatestModel("titlebar-demo")?.data?.query === "an"', 8000));
  await main.evaluate('document.querySelector(".detach-btn")?.click(); true');
  let detached;
  for (let i = 0; i < 60 && !detached; i++) {
    for (const target of (await targets()).filter((item) => item.type === "page" && item.url.includes("plugin.html?plugin=titlebar-demo"))) {
      detached = await connect(target.webSocketDebuggerUrl).catch(() => undefined);
      if (detached) break;
    }
    if (!detached) await sleep(200);
  }
  check("titlebar-demo detached window opens", !!detached);
  check("detached ready state replays the current query",
    !!detached && await waitFor(detached, 'window.__pluginStates?.some((state) => state.query === "an" && state.show === true)', 10000));
  const detachedQuery = detached ? await detached.evaluate('({ model: window.__detachedPageRuntime?.getModel()?.data?.query, states: window.__pluginStates ?? [] })') : null;
  check("detached model/query stay aligned", detachedQuery?.model === "an" && detachedQuery.states.some((state) => state.query === "an"), JSON.stringify(detachedQuery));
  detached?.ws.close();
  await invoke("plugin_window_close", { id: "titlebar-demo" }).catch(() => {});
} catch (error) {
  console.error("PLUGIN AUDIT RUNTIME VERIFY ERROR", error);
  failures++;
} finally {
  try { main?.ws.close(); } catch {}
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  for (const id of ["nav-bar", "titlebar-demo", "audit-runtime-probe"]) {
    try { rmSync(`${PLUGINS}/${id}`, { recursive: true, force: true }); } catch {}
  }
}

console.log(failures === 0 ? "PLUGIN AUDIT RUNTIME VERIFY OK" : `PLUGIN AUDIT RUNTIME VERIFY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
