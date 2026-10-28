// Focused CDP regression for the 2026-10-26 plugin/navigation/clipboard audit.
// Covers disable/unload boundaries, contribution budgets, provider generations,
// HTTP icon refusal and native Space activation in the clipboard page.
import { createServer } from "node:http";
import { execFileSync, execSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = 9253;
const ICON_PORT = 18777;
const BASE = "src-tauri/target/debug";
const APP = `${BASE}/lume.exe`;
const PLUGINS = `${BASE}/plugins`;
const INVALID_DIR = `${PLUGINS}/bad id`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

let iconRequests = 0;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nQAAAABJRU5ErkJggg==",
  "base64"
);
const server = createServer((_req, res) => {
  iconRequests++;
  res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
  res.end(png);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(ICON_PORT, "127.0.0.1", resolve);
});

for (const id of ["audit-fix-service", "audit-fix-provider", "bad id"]) {
  rmSync(`${PLUGINS}/${id}`, { recursive: true, force: true });
}
mkdirSync(PLUGINS, { recursive: true });
cpSync("scripts/fixtures/audit-fix-service", `${PLUGINS}/audit-fix-service`, { recursive: true });
cpSync("scripts/fixtures/audit-fix-provider", `${PLUGINS}/audit-fix-provider`, { recursive: true });
mkdirSync(INVALID_DIR, { recursive: true });
writeFileSync(
  `${INVALID_DIR}/plugin.toml`,
  'id = "bad id"\nname = "Invalid Id"\nkind = "provider"\napi = 2\nentry = "main.js"\n'
);
writeFileSync(`${INVALID_DIR}/main.js`, "export default { search() { return []; } };\n");

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
const logFd = openSync("test/plugin_nav_clipboard_fix.log", "w");
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
});

async function targets() {
  for (let i = 0; i < 70; i++) {
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
    const resolveCall = pending.get(message.id);
    if (resolveCall) { pending.delete(message.id); resolveCall(message); }
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

async function findLogicTarget() {
  for (let i = 0; i < 60; i++) {
    for (const target of (await targets()).filter((item) => item.type === "page" && item.url.includes("pluginLogic.html"))) {
      const client = await connect(target.webSocketDebuggerUrl).catch(() => undefined);
      if (client) return client;
    }
    await sleep(200);
  }
  return undefined;
}

let main;
let logic;
let clipboardInitiallyEnabled = true;
let initialClipboardPresenter = "";
try {
  for (let i = 0; i < 60 && !main; i++) {
    for (const target of (await targets()).filter((item) => item.type === "page" && item.url.includes("tauri.localhost"))) {
      const candidate = await connect(target.webSocketDebuggerUrl).catch(() => undefined);
      if (candidate && await candidate.evaluate('!!document.getElementById("search-input")')) { main = candidate; break; }
      candidate?.ws.close();
    }
    if (!main) await sleep(200);
  }
  if (!main) throw new Error("launcher target missing");

  const invoke = (cmd, args = {}) => main.evaluate(
    `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
  );
  const type = async (query) => main.evaluate(`window.__lumeHandleInput(${JSON.stringify(query)})`);
  const pressSpace = async () => {
    await main.send("Input.dispatchKeyEvent", {
      type: "keyDown", key: " ", code: "Space", text: " ", unmodifiedText: " ",
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });
    await main.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: " ", code: "Space",
      windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32,
    });
  };
  const waitRow = (text, timeout = 12000) => waitFor(
    main,
    `[...document.querySelectorAll("[data-target-id]")].some((el) => el.textContent.includes(${JSON.stringify(text)}))`,
    timeout
  );

  const initialManifests = await invoke("get_plugins");
  clipboardInitiallyEnabled = initialManifests.find((plugin) => plugin.id === "clipboard")?.enabled ?? true;
  const initialSettings = await invoke("get_settings");
  initialClipboardPresenter = initialSettings.pages?.presenters?.clipboard ?? "";
  await invoke("set_plugin_enabled", { id: "clipboard", enabled: true });
  await invoke("save_settings_patch", { patch: { pages: { presenters: { clipboard: "clipboard-list" } } } });
  await invoke("set_plugin_enabled", { id: "audit-fix-service", enabled: true });
  await invoke("set_plugin_enabled", { id: "audit-fix-provider", enabled: true });
  await main.send("Page.bringToFront", {});
  await invoke("toggle_launcher");
  await sleep(4500);

  const manifests = await invoke("get_plugins");
  const serviceManifest = manifests.find((plugin) => plugin.id === "audit-fix-service");
  const providerManifest = manifests.find((plugin) => plugin.id === "audit-fix-provider");
  const invalidManifest = manifests.find((plugin) => plugin.id === "bad id");
  check("service/provider fixtures load", !!serviceManifest?.enabled && !!providerManifest?.enabled);
  check("invalid manual id is rejected at the manifest gate",
    !!invalidManifest?.apiError?.includes("invalid plugin id"), JSON.stringify(invalidManifest));
  check("invalid manifest registers no contribution",
    await main.evaluate('(window.__pluginRegistryProbe?.plugins?.() ?? []).every((item) => item.id !== "bad id")'));

  await waitFor(main, `(window.__pageRuntimeLatestModel?.("apps")?.data?.sections ?? []).some((section) => section.id.startsWith("audit-fix-provider:flood-"))`, 15000);
  const homeBudget = await main.evaluate(`(() => {
    const model = window.__pageRuntimeLatestModel?.("apps");
    const flood = (model?.data?.sections ?? []).filter((section) => section.id.startsWith("audit-fix-provider:flood-"));
    return {
      status: model?.status,
      floodBars: flood.length,
      floodItems: flood.reduce((sum, section) => sum + section.items.length, 0),
      sectionCount: model?.data?.sections?.length ?? 0,
      probe: (window.__navBarsProbe ?? []).slice(-5),
    };
  })()`);
  check("oversized navBars keep the home model renderable",
    homeBudget.status !== "error" && homeBudget.floodBars > 0 && homeBudget.floodBars <= 8,
    JSON.stringify(homeBudget));
  check("navBars per-plugin item budget is enforced", homeBudget.floodItems <= 120, JSON.stringify(homeBudget));

  logic = await findLogicTarget();
  check("logic host target is available", !!logic);
  if (logic) {
    check("service logic frame reaches loaded state",
      await waitFor(logic, 'window.__logicEntries?.get("audit-fix-service")?.loaded === true', 12000));
  await waitFor(main, `(() => {
    const probe = window.__pluginRegistryProbe?.logic?.();
    return !!probe && probe.loaded.includes("audit-fix-service") && !probe.pending.includes("audit-fix-service");
  })()`, 12000);
  }

  execFileSync("powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value 'audit-disable-clipboard-sentinel'"], { stdio: "ignore" });
  const warm = `warm-${Date.now()}`;
  await type(warm);
  await sleep(700);
  const warmState = await main.evaluate(`Promise.all([
    window.__TAURI_INTERNALS__.invoke("plugin_storage_get", { id: "audit-fix-service", key: "lastQuery" }),
    window.__TAURI_INTERNALS__.invoke("plugin_storage_get", { id: "audit-fix-service", key: "queryCount" })
  ])`);
  check("enabled service receives queries", warmState[0] === JSON.stringify(warm), JSON.stringify(warmState));

  await invoke("set_plugin_enabled", { id: "audit-fix-service", enabled: false });
  await sleep(1200);
  const disabledManifest = (await invoke("get_plugins")).find((plugin) => plugin.id === "audit-fix-service");
  const logicGone = logic
    ? await waitFor(logic, '!window.__logicEntries?.get("audit-fix-service")', 8000)
    : false;
  check("disabling a service removes its logic iframe", logicGone);

  const marker = `disabled-${Date.now()}`;
  await type(marker);
  await sleep(1500);
  const disabledState = await main.evaluate(`Promise.all([
    window.__TAURI_INTERNALS__.invoke("plugin_storage_get", { id: "audit-fix-service", key: "lastQuery" }),
    window.__TAURI_INTERNALS__.invoke("plugin_storage_get", { id: "audit-fix-service", key: "queryCount" })
  ])`);
  check("disabled service receives no lifecycle hook", disabledState[0] === warmState[0] && disabledState[1] === warmState[1],
    JSON.stringify({ warmState, disabledState, marker }));

  const disabledCapability = await main.evaluate(`window.__TAURI_INTERNALS__.invoke("get_clipboard_text", { pluginId: "audit-fix-service" })
    .then(() => "ALLOWED", (error) => String(error))`);
  check("disabled manifest is reported", disabledManifest?.enabled === false, JSON.stringify(disabledManifest));
  check("disabled plugin capability calls fail closed",
    String(disabledCapability).includes("disabled"), String(disabledCapability));

  await invoke("set_plugin_enabled", { id: "audit-fix-service", enabled: true });
  if (logic) {
    check("re-enabling the service rebuilds its logic frame",
      await waitFor(logic, 'window.__logicEntries?.get("audit-fix-service")?.loaded === true', 12000));
  }
  const reenabled = `reenabled-${Date.now()}`;
  await type(reenabled);
  await sleep(1000);
  const reenabledQuery = await main.evaluate(`window.__TAURI_INTERNALS__.invoke("plugin_storage_get", { id: "audit-fix-service", key: "lastQuery" })`);
  check("re-enabled service receives new queries", reenabledQuery === JSON.stringify(reenabled), JSON.stringify({ reenabledQuery, reenabled }));

  await type("budgetprobe");
  check("oversized provider result remains bounded",
    await waitFor(main, `(() => {
      const names = [...document.querySelectorAll(".result-box-name")].map((node) => node.textContent || "");
      return names.filter((name) => name.startsWith("BUDGET_ROW_")).length > 0;
    })()`, 15000));
  const budgetRows = await main.evaluate(`({
    names: [...document.querySelectorAll(".result-box-name")].map((node) => node.textContent || ""),
    count: document.querySelectorAll(".result-box").length,
    status: window.__pageRuntimeLatestModel?.("apps")?.status,
  })`);
  check("provider budget drops malformed rows", !budgetRows.names.includes("BAD_PATH_TYPE") && !budgetRows.names.includes("BAD_ICON_TYPE"),
    JSON.stringify(budgetRows));
  check("provider result stays within the merged twenty-row cap", budgetRows.count <= 20 && budgetRows.status === "ready",
    JSON.stringify(budgetRows));

  await type("raceparent");
  check("provider drill parent is visible", await waitRow("RACE_PARENT", 12000));
  await main.evaluate(`(() => {
    const row = [...document.querySelectorAll(".result-box")].find((el) => el.textContent.includes("RACE_PARENT"));
    row?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return !!row;
  })()`);
  await sleep(100);
  await type("racesecond");
  await sleep(1800);
  const raceState = await main.evaluate(`({
    input: document.getElementById("search-input")?.value,
    names: [...document.querySelectorAll(".result-box-name")].map((node) => node.textContent || ""),
  })`);
  check("stale provider select cannot overwrite a newer query",
    raceState.input === "racesecond" && raceState.names.includes("RACE_SECOND") && !raceState.names.includes("RACE_STALE_CHILD"),
    JSON.stringify(raceState));

  await type("httpicon");
  check("HTTP icon row renders", await waitRow("HTTP_ICON_ROW", 12000));
  const iconState = await main.evaluate(`(() => {
    const name = [...document.querySelectorAll(".result-box-name")].find((node) => node.textContent === "HTTP_ICON_ROW");
    const image = name?.closest(".result-box")?.querySelector("img.result-box-img");
    return { src: image?.src ?? "", naturalWidth: image?.naturalWidth ?? 0 };
  })()`);
  await sleep(300);
  check("HTTP(S) icon URL is not used as a WebView request",
    iconRequests === 0 && !iconState.src.includes(`127.0.0.1:${ICON_PORT}`),
    JSON.stringify({ iconRequests, iconState }));
  check("remote icon row falls back to a local plugin icon", iconState.naturalWidth > 0, JSON.stringify(iconState));

  execFileSync("powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value 'audit-space-row'"], { stdio: "ignore" });
  await sleep(1000);
  await main.evaluate(`[...document.querySelectorAll(".mode-switch-item")].find((node) => /剪贴板|Clipboard/.test(node.textContent || ""))?.click()`);
  await sleep(2500);
  await type("");
  check("clipboard page and native buttons are visible",
    await waitFor(main, '!!document.querySelector(".clip-page") && !!document.querySelector(".clip-status-btn")', 12000));
  check("clipboard list Presenter exposes row action buttons",
    await waitFor(main, '!!document.querySelector(".clip-row-actions .clip-act")', 12000));

  const categoryBefore = await main.evaluate('document.querySelector(".clip-cat.active")?.textContent?.trim() ?? ""');
  await main.evaluate('document.querySelectorAll(".clip-cat")[1]?.focus()');
  await pressSpace();
  await sleep(500);
  const categoryAfter = await main.evaluate(`({
    active: document.querySelector(".clip-cat.active")?.textContent?.trim() ?? "",
    checks: document.querySelectorAll(".clip-row-check").length,
  })`);
  check("Space on a category activates the tab instead of multi-select",
    categoryAfter.active !== categoryBefore && categoryAfter.checks === 0,
    JSON.stringify({ categoryBefore, categoryAfter }));

  await main.evaluate('document.querySelector(".clip-status-btn")?.focus()');
  await pressSpace();
  await sleep(500);
  const pauseState = await main.evaluate(`({
    paused: document.querySelector(".clip-status-btn")?.classList.contains("paused") ?? false,
    checks: document.querySelectorAll(".clip-row-check").length,
  })`);
  check("Space on pause activates the button instead of multi-select", pauseState.paused && pauseState.checks === 0,
    JSON.stringify(pauseState));
  await main.evaluate('document.querySelector(".clip-status-btn")?.focus()');
  await pressSpace();
  await sleep(400);

  await main.evaluate('document.querySelector(".clip-clear-btn")?.focus()');
  const clearFocus = await main.evaluate('document.activeElement?.className ?? ""');
  await pressSpace();
  await sleep(500);
  const clearState = await main.evaluate(`({
    dialog: !!document.querySelector(".clip-confirm"),
    checks: document.querySelectorAll(".clip-row-check").length,
  })`);
  check("Space on clear opens the confirm dialog instead of multi-select",
    clearFocus.includes("clip-clear-btn") && clearState.dialog && clearState.checks === 0,
    JSON.stringify({ clearFocus, clearState }));
  await main.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await main.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await sleep(400);

  execFileSync("powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value 'AUDIT_SPACE_OTHER'"], { stdio: "ignore" });
  await main.evaluate(`(() => {
    window.__auditSpaceEvents = [];
    window.__auditClicks = [];
    document.addEventListener("click", (event) => {
      if (event.target?.closest?.(".clip-act, .clip-act-danger")) {
        window.__auditClicks.push(event.target.className || "");
      }
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== " ") return;
      const target = event.target;
      setTimeout(() => window.__auditSpaceEvents.push({
        cls: target?.className ?? "",
        prevented: event.defaultPrevented,
      }), 0);
    }, { capture: true, once: true });
  })()`);
  const rowActionMeta = await main.evaluate(`(() => {
    const button = document.querySelector(".clip-row.result-selected .clip-act");
    return button ? {
      tabIndex: button.tabIndex,
      rowSelected: button.closest(".clip-row")?.classList.contains("result-selected") ?? false,
      visible: button.getBoundingClientRect().width > 0,
    } : null;
  })()`);
  await main.evaluate('document.querySelector(".clip-row.result-selected .clip-act")?.focus()');
  const copyFocus = await main.evaluate('document.activeElement?.className ?? ""');
  await pressSpace();
  await sleep(700);
  const copyState = await main.evaluate(`({
    checks: document.querySelectorAll(".clip-row-check").length,
    events: window.__auditSpaceEvents ?? [],
    clicks: window.__auditClicks ?? [],
  })`);
  check("Space on copy activates the row action instead of multi-select",
    copyFocus.includes("clip-act") && copyState.checks === 0 && copyState.clicks.some((cls) => cls.includes("clip-act")),
    JSON.stringify({ rowActionMeta, copyFocus, copyState }));

  await main.evaluate('document.querySelector(".clip-row.result-selected .clip-act:nth-of-type(2)")?.focus()');
  const pasteFocus = await main.evaluate('document.activeElement?.className ?? ""');
  await pressSpace();
  await sleep(500);
  const actionClicks = await main.evaluate('window.__auditClicks ?? []');
  check("Space on paste activates the paste action instead of multi-select",
    pasteFocus.includes("clip-act") && actionClicks.filter((cls) => cls.includes("clip-act")).length >= 2,
    JSON.stringify({ pasteFocus, actionClicks }));

  const beforeDelete = await main.evaluate('window.__pageRuntimeLatestModel?.("clipboard")?.data?.total ?? -1');
  await main.evaluate('document.querySelector(".clip-row.result-selected .clip-act-danger")?.focus()');
  const deleteFocus = await main.evaluate('document.activeElement?.className ?? ""');
  await pressSpace();
  await sleep(1200);
  const deleteState = await main.evaluate(`({
    total: window.__pageRuntimeLatestModel?.("clipboard")?.data?.total ?? -1,
    checks: document.querySelectorAll(".clip-row-check").length,
    clicks: window.__auditClicks ?? [],
  })`);
  check("Space on delete activates the delete button instead of multi-select",
    deleteFocus.includes("clip-act-danger") && deleteState.checks === 0 &&
      deleteState.clicks.some((cls) => cls.includes("clip-act-danger")),
    JSON.stringify({ deleteFocus, beforeDelete, deleteState }));

  const missingId = 9999999;
  const missingPin = await invoke("pin_clipboard", { id: missingId, pinned: true }).then(() => false, () => true);
  const missingChecked = await invoke("set_clipboard_checked", { id: missingId, checked: [] }).then(() => false, () => true);
  check("clipboard pin rejects a missing id", missingPin);
  check("clipboard checked-state rejects a missing id", missingChecked);
  const countsReply = await invoke("search_clipboard", { query: "", kind: "all" });
  check("clipboard search returns stable category metadata",
    !Array.isArray(countsReply) && Number.isFinite(countsReply.total) && Number.isFinite(countsReply.categories?.all),
    JSON.stringify(countsReply?.categories ?? null));

  const existsStarted = Date.now();
  const existsCount = await main.evaluate(`window.__TAURI_INTERNALS__.invoke("check_file_exists", {
    paths: Array.from({ length: 256 }, (_, i) => "C:\\\\audit-missing\\\\" + i)
  }).then((rows) => rows.length)`);
  const existsMs = Date.now() - existsStarted;
  check("batched file-existence command remains responsive", existsCount === 256 && existsMs < 2000,
    JSON.stringify({ existsCount, existsMs }));
} catch (error) {
  console.error("PLUGIN NAV CLIPBOARD FIX VERIFY ERROR", error);
  failures++;
} finally {
  try { await main?.evaluate('window.__TAURI_INTERNALS__.invoke("set_clipboard_paused", { paused: false })'); } catch {}
  try { await main?.evaluate(`window.__TAURI_INTERNALS__.invoke("set_plugin_enabled", { id: "clipboard", enabled: ${JSON.stringify(clipboardInitiallyEnabled)} })`); } catch {}
  try { await main?.evaluate(`window.__TAURI_INTERNALS__.invoke("save_settings_patch", { patch: { pages: { presenters: { clipboard: ${JSON.stringify(initialClipboardPresenter)} } } } })`); } catch {}
  try { await main?.evaluate('window.__TAURI_INTERNALS__.invoke("set_plugin_enabled", { id: "audit-fix-service", enabled: true })'); } catch {}
  try { await main?.evaluate('window.__TAURI_INTERNALS__.invoke("set_plugin_enabled", { id: "audit-fix-provider", enabled: true })'); } catch {}
  try { main?.ws.close(); } catch {}
  try { logic?.ws.close(); } catch {}
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  try { server.close(); } catch {}
  for (const id of ["audit-fix-service", "audit-fix-provider", "bad id"]) {
    try { rmSync(`${PLUGINS}/${id}`, { recursive: true, force: true }); } catch {}
  }
}

console.log(failures === 0 ? "PLUGIN NAV CLIPBOARD FIX VERIFY OK" : `PLUGIN NAV CLIPBOARD FIX VERIFY FAILED (${failures})`);
process.exit(failures === 0 ? 0 : 1);
