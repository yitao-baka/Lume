// Dev helper: smoke test for this iteration's features.
//  1. PDF preview renders in the satellite window (pdf.js via asset://, lazy chunk + worker)
//  2. 音乐 category appears between 图片 and 视频 and filters audio rows
//  3. source-code / lyric extensions route into the text preview (.lrc end-to-end)
//  4. 开启预览 toggle: turning it off closes the satellite and keeps it closed
//  5. settings 剪贴板 pane renders the preview toggle
// Usage: node scripts/cdp_feature_smoke.mjs
//
// NOTE: seeds a few clipboard file rows on the release exe's live data dir
// (same convention as cdp_preview_smoke.mjs). The preview setting is flipped
// off then back ON during the gate test, so it is not left modified.
import { spawn, execSync } from "node:child_process";
import { writeFileSync, readFileSync } from "node:fs";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";
const TEST = "E:\\SoftwareDevelopment\\Projects\\LumeLauncher\\test";
const SETTINGS = "src-tauri/target/release/settings/settings.toml";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP not available on :" + CDP_PORT);
}

async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; pending.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { ws, send, evalJs };
}

// Snapshot the user's settings.toml so the gate test can restore it verbatim.
let settingsSnapshot = null;
try { settingsSnapshot = readFileSync(SETTINGS, "utf8"); } catch { console.log("[smoke] (no settings.toml to snapshot)"); }

const targets = await getTargets();
for (const t of targets) console.log("[target]", t.type, JSON.stringify(t.title), t.url);

let main = null, settings = null, preview = null;
for (const t of targets.filter((x) => x.type === "page")) {
  const h = await connect(t.webSocketDebuggerUrl);
  if (await h.evalJs(`!!document.querySelector(".search")`)) main = { ...h, url: t.url };
  else if (await h.evalJs(`document.body.classList.contains("settings-window")`)) settings = { ...h, url: t.url };
  else preview = { ...h, url: t.url };
}
if (!main) throw new Error("launcher (main) page not found");
if (!preview) throw new Error("preview window target not found");
console.log("[smoke] windows — main:", main.url, "| settings:", settings?.url ?? "?", "| preview:", preview.url);

// The launcher starts hidden; the satellite preview only shows while the
// launcher is visible (`show_preview` gates on main.is_visible), so bring it up.
await main.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher"); "shown"`);
await sleep(900);

const seedFile = async (name) => {
  execSync(`powershell -NoProfile -Command "Set-Clipboard -Path '${TEST}\\${name}'"`);
  await sleep(900);
};

// ── 1. PDF preview ─────────────────────────────────────────────────────────
await seedFile("sample.pdf");
await main.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); "tab"`);
await sleep(900);
const title0 = await main.evalJs(`document.querySelector(".clip-row-title")?.textContent?.trim() ?? null`);
console.log("[smoke] clipboard mode — top row:", JSON.stringify(title0));

// Wait for the lazy pdfjs chunk + worker + render (first load is slow).
let pdfOk = false;
for (let i = 0; i < 30; i++) {
  const cw = await preview.evalJs(`document.querySelector(".preview-pdf-canvas")?.width ?? 0`);
  const page = await preview.evalJs(`document.querySelector(".preview-pdf-page")?.textContent?.trim() ?? ""`);
  if (cw > 0) { pdfOk = true; console.log(`[smoke] pdf canvas ${cw}x` + (await preview.evalJs(`document.querySelector(".preview-pdf-canvas")?.height ?? 0`)) + ` | page ${page}`); break; }
  await sleep(300);
}
check("PDF renders a canvas in the satellite", pdfOk, "top row " + JSON.stringify(title0));
const pdfErr = await preview.evalJs(`document.querySelector(".preview-error")?.textContent ?? null`);
check("PDF has no preview error", !pdfErr, JSON.stringify(pdfErr));
if (!pdfOk) {
  console.log("[smoke] pdf debug:", await preview.evalJs(`({ req: window.__req_debug, url: location.href, body: document.body.innerText?.slice(0, 80) })`));
}

// ── 2. 音乐 category (between 图片 and 视频) ─────────────────────────────────
await seedFile("music.mp3");
await seedFile("lyrics.lrc");
const catLabels = await main.evalJs(`[...document.querySelectorAll(".clip-cat")].map(b => b.textContent.trim())`);
console.log("[smoke] categories:", JSON.stringify(catLabels));
check("音乐 tab present", catLabels.includes("音乐") || catLabels.includes("Music") || catLabels.includes("音樂"));
const imgIdx = catLabels.findIndex((x) => x === "图片" || x === "Images" || x === "圖片");
const musIdx = catLabels.findIndex((x) => x === "音乐" || x === "Music" || x === "音樂");
const vidIdx = catLabels.findIndex((x) => x === "视频" || x === "Videos" || x === "影片");
check("音乐 sits between 图片 and 视频", imgIdx >= 0 && musIdx === imgIdx + 1 && vidIdx === musIdx + 1, `[${imgIdx},${musIdx},${vidIdx}]`);

await main.evalJs(`document.querySelectorAll(".clip-cat")[${musIdx}]?.click(); "music-cat"`);
await sleep(800);
const musicRows = await main.evalJs(`[...document.querySelectorAll(".clip-row-title")].map(e => e.textContent.trim())`);
console.log("[smoke] 音乐 category rows:", JSON.stringify(musicRows));
check(
  "音乐 filters to audio rows (includes the seeded mp3)",
  musicRows.some((x) => x.toLowerCase().includes("music.mp3")) && musicRows.length >= 1,
  JSON.stringify(musicRows)
);

// ── 3. .lrc lyric file routes into the text preview ────────────────────────
await main.evalJs(`document.querySelectorAll(".clip-cat")[0]?.click(); "all-cat"`);
await sleep(900);
const allRows = await main.evalJs(`[...document.querySelectorAll(".clip-row-title")].map(e => e.textContent.trim())`);
const lrcIdx = allRows.findIndex((x) => x.toLowerCase().includes("lyrics.lrc"));
check("lyric .lrc row listed under 全部", lrcIdx >= 0, JSON.stringify(allRows));
// The lrc row is the newest → index 0, so the category switch already selected
// it (setSelected(0)) and the satellite is showing its text preview. NOTE: do
// NOT click the row — a click on an already-selected row is "paste".
await sleep(700);
const lrcText = await preview.evalJs(`document.querySelector(".preview-text")?.textContent?.slice(0, 40) ?? null`);
check(".lrc opens the text preview", lrcText !== null && lrcText.includes("歌词"), JSON.stringify(lrcText));

// ── 4. 开启预览 toggle: off closes the satellite and keeps it closed ────────
const invoke = `(window.__TAURI_INTERNALS__?.invoke)`;
const invokeAvail = await main.evalJs(`!!${invoke}`);
check("main has Tauri invoke bridge", !!invokeAvail);
if (invokeAvail) {
  const s = await main.evalJs(`${invoke}("get_settings")`);
  const before = s.clipboard.preview;
  s.clipboard.preview = false;
  await main.evalJs(`${invoke}("save_settings", { new: ${JSON.stringify(s)} })`);
  await sleep(900); // settings-applied → previewEnabled false → close_preview
  // Re-select the pdf row (settings changes reset the list? no — re-click 全部 top row).
  await main.evalJs(`(() => { const els = [...document.querySelectorAll(".clip-row")]; const el = els.find(r => r.querySelector(".clip-row-title")?.textContent?.trim().toLowerCase().includes("sample.pdf")); el?.click(); return !!el; })()`);
  await sleep(700);
  const canvasGone = await preview.evalJs(`!document.querySelector(".preview-pdf-canvas")`);
  check("preview stays closed when the toggle is off", canvasGone);
  // Restore preview=true so the user's settings are left unchanged.
  s.clipboard.preview = true;
  await main.evalJs(`${invoke}("save_settings", { new: ${JSON.stringify(s)} })`);
  await sleep(900);
  const s2 = await main.evalJs(`${invoke}("get_settings")`);
  check("preview setting restored to " + before, s2.clipboard.preview === true && before === true, `before=${before} after=${s2.clipboard.preview}`);
}

// ── 5. settings 剪贴板 pane renders the preview toggle ─────────────────────
// Open the settings window via IPC (the launcher hides on focus loss — fine).
await main.evalJs(`${invoke}("open_settings"); "open"`);
await sleep(1200);
const settingsTargets = await getTargets();
let settingsH = null;
for (const t of settingsTargets.filter((x) => x.type === "page")) {
  const h = await connect(t.webSocketDebuggerUrl);
  if (await h.evalJs(`document.body.classList.contains("settings-window")`)) { settingsH = h; break; }
}
if (settingsH) {
  await settingsH.evalJs(`([...document.querySelectorAll(".settings-nav")].find(b => /剪贴板|Clipboard|剪貼板/.test(b.textContent)))?.click(); "clip-nav"`);
  await sleep(400);
  const labels = await settingsH.evalJs(`[...document.querySelectorAll(".settings-sub-label")].map(e => e.textContent.trim())`);
  const toggleExists = await settingsH.evalJs(`!!document.querySelector(".settings-sub [role=switch]")`);
  check("剪贴板 pane shows 开启预览 toggle", toggleExists && labels[0].includes("预览"), JSON.stringify(labels[0]));
} else {
  check("settings window opened for toggle render check", false);
}

// Restore the user's settings.toml verbatim (in case the app was killed before the restore above).
if (settingsSnapshot !== null) {
  try { writeFileSync(SETTINGS, settingsSnapshot); } catch {}
}

console.log(failures === 0 ? "[smoke] ALL PASS" : `[smoke] ${failures} FAILURE(S)`);
console.log("[smoke] leaving app running");
process.exit(failures === 0 ? 0 : 1);
