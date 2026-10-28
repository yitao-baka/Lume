// Dev helper: smoke-test clipboard phase 2 — pause toggle + auto-merge.
// Writes the release settings.toml with merge_copy enabled (3 s window),
// launches the app, switches to Clipboard mode, then verifies:
//  1. 暂停记录 button exists; while paused a copy is NOT recorded; resuming
//     records again.
//  2. Two copies within the merge window fold into one 「合并复制 2 条」 row.
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync as writeFile } from "node:fs";

const CDP_PORT = 9222;
const APP = "src-tauri/target/debug/lume.exe";
const SETTINGS = "src-tauri/target/debug/settings/settings.toml";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const runId = Date.now();
let failures = 0;
const check = (ok, label, extra = "") => {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${extra ? " — " + extra : ""}`);
  if (!ok) failures++;
};

const originalSettings = existsSync(SETTINGS) ? readFileSync(SETTINGS) : null;
process.on("exit", () => {
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  try { if (originalSettings) writeFile(SETTINGS, originalSettings); } catch {}
});

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

// Enable auto-merge in the release settings (a fresh file with defaults + merge on).
writeFile(
  SETTINGS,
  `[meta]
version = 1

[appearance]
language = "system"
color_mode = "system"
entry_size = 110
window_width = 720
window_height = 520
window_position = "center"
remember_position = false
show_recent = true
expand_pinned = false
shift_enter_admin = true
recent_count = 20
search_placeholder_apps = ""
search_placeholder_clipboard = ""

[hotkeys]
toggle = "Alt+Space"
switch_mode = "Tab"

[index]
system_dirs = [
  { path = "Desktop", enabled = true },
  { path = "System32", enabled = true },
  { path = "StartMenu", enabled = false },
]
user_dirs = []
user_dirs_no_files = []
cache_refresh_interval_minutes = 60

[clipboard]
history_cap = 200
record_images = true
record_files = true
paste_close = true
show_source_app = true
time_display = "relative"
ignore_apps = []
merge_copy = true
merge_window_ms = 3000
`,
);

const app = spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function targets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP not available");
}
async function probeLauncher(url) {
  const w = new WebSocket(url);
  let i = 0; const pend = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const snd = (method, params) => new Promise((res) => { const k = ++i; pend.set(k, res); w.send(JSON.stringify({ id: k, method, params })); });
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  const r = await snd("Runtime.evaluate", { expression: "!!document.querySelector('.search')", returnByValue: true });
  w.close();
  return r.result?.result?.value === true;
}

let wsUrl = null;
const ts = await targets();
for (const t of ts.filter((x) => x.type === "page")) {
  if (await probeLauncher(t.webSocketDebuggerUrl)) { wsUrl = t.webSocketDebuggerUrl; break; }
}
if (!wsUrl) { console.error("launcher page not found"); process.exit(1); }

const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const setClip = (v) => execSync(`powershell -NoProfile -Command "Set-Clipboard -Value '${v}'"`);
/** Re-trigger the clipboard search so the view reflects the DB (the recorder
 * captures in the background; the UI only re-searches on input/mode change). */
const refresh = async () => {
  await evalJs(`(() => { const i = document.getElementById("search-input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return "refresh"; })()`);
  await sleep(500);
};
const count = async () => {
  const txt = await evalJs(`document.querySelector(".clip-status-count")?.textContent ?? ""`);
  return Number((txt.match(/\d+/) ?? [0])[0]);
};
const titles = async () => evalJs(`[...document.querySelectorAll(".clip-row-title, .clip-compact-title")].map((x) => x.textContent.trim())`);
const waitForTitle = async (fragment, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    if ((await titles()).some((title) => title.includes(fragment))) return true;
    await sleep(200);
  }
  return false;
};
const dbSearch = async (query) => {
  const reply = await evalJs(`window.__TAURI_INTERNALS__.invoke("search_clipboard", { query: ${JSON.stringify(query)}, kind: "all" })`);
  return Array.isArray(reply) ? reply : reply.items;
};
const waitForDbRow = async (content, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    const rows = await dbSearch(content);
    if ((rows || []).some((row) => String(row.content || "").includes(content))) return true;
    await sleep(200);
  }
  return false;
};

// Switch to Clipboard mode.
await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); "tab"`);
await sleep(900);
await refresh();
for (let i = 0; i < 20 && (await count()) === 0; i++) await sleep(250);
const clipboardSettings = await evalJs('window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.clipboard)');
if (!clipboardSettings?.merge_copy) console.log("[settings] merge_copy is off:", JSON.stringify(clipboardSettings));

// ── 1. Pause toggle ──
const pauseBtnText = await evalJs(`document.querySelector(".clip-status-btn")?.textContent ?? null`);
console.log("[pause] button =", JSON.stringify(pauseBtnText));

const before = await count();
await evalJs(`document.querySelector(".clip-status-btn")?.click(); "paused"`);
await sleep(300);
setClip(`paused-probe-${runId}`);
await sleep(800);
await refresh();
const whilePaused = await count();
const pausedRecorded = (await dbSearch(`paused-probe-${runId}`)).length > 0;
check(!pausedRecorded, "paused clipboard copy is not recorded", `count ${before} -> ${whilePaused}`);

await evalJs(`document.querySelector(".clip-status-btn")?.click(); "resumed"`);
await sleep(300);
setClip(`resumed-probe-${runId}`);
await sleep(800);
await refresh();
const afterResume = await count();
const resumedRecorded = await waitForDbRow(`resumed-probe-${runId}`);
check(resumedRecorded, "resumed clipboard copy is recorded", `count ${whilePaused} -> ${afterResume}`);

// ── 2. Auto-merge: wait past the merge window so the merge probe starts a
// fresh row, then copy twice quickly → one 「合并复制 2 条」 row. ──
await sleep(4000);
const beforeRows = await count();
setClip(`merge-alpha-${runId}`);
await sleep(1000);
setClip(`merge-beta-${runId}`);
await sleep(1200);
await refresh();
const mergedRows = await count();
const nowTitles = await titles();
const mergeReply = await evalJs(`window.__TAURI_INTERNALS__.invoke("search_clipboard", { query: "merge-", kind: "all" })`);
const mergeDb = Array.isArray(mergeReply) ? mergeReply : mergeReply.items;
const merged = (mergeDb || []).filter((row) =>
  String(row.content || "").includes(`merge-alpha-${runId}`) &&
  String(row.content || "").includes(`merge-beta-${runId}`)
);
console.log("[merge] rows before=", beforeRows, " after=", mergedRows, "delta=", mergedRows - beforeRows);
check(merged.length >= 1, "two rapid copies produce a merged row", JSON.stringify({ titles: nowTitles.slice(0, 3), merged }));

writeFile("smoke-clipboard-p2.png", Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result?.data ?? "", "base64"));
console.log("[smoke] screenshot saved: smoke-clipboard-p2.png");
process.exit(failures === 0 ? 0 : 1);
