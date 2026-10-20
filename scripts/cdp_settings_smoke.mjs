// Settings redesign smoke: grouped nav, command search, autosave footer,
// restore confirmation, and the reworked page controls.
// Usage: pnpm run tauri build --debug --no-bundle
//        node scripts/cdp_settings_smoke.mjs
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CDP_PORT = 9222;
const APP = "src-tauri/target/debug/lume.exe";
const OUT = "test/settings-smoke";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, condition, extra = "") => {
  console.log(`[${condition ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
  if (!condition) failures++;
};

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(300);
mkdirSync(OUT, { recursive: true });
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function getTargets() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); }
    catch { await sleep(250); }
  }
  throw new Error(`CDP not available on :${CDP_PORT}`);
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
    const key = ++id;
    pending.set(key, resolve);
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evalJs = async (expression) => {
    const reply = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description ?? "eval failed");
    }
    return reply.result?.result?.value;
  };
  const shot = async (name) => {
    const image = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(image.result.data, "base64"));
  };
  return { ws, send, evalJs, shot };
}

let mainTarget = null;
let settings = null;
for (let attempt = 0; attempt < 60 && (!settings || !mainTarget); attempt++) {
  const pages = (await getTargets()).filter((target) =>
    target.type === "page" && target.url.includes("tauri.localhost"),
  );
  for (const page of pages) {
    if (page.webSocketDebuggerUrl === mainTarget?.webSocketDebuggerUrl) continue;
    try {
      const client = await connect(page.webSocketDebuggerUrl);
      const kind = await client.evalJs(`document.body.classList.contains('settings-window')
        ? 'settings'
        : document.querySelector('#search-input') ? 'main' : ''`);
      if (kind === "settings" && !settings) settings = client;
      else if (kind === "main" && !mainTarget) {
        mainTarget = page;
        client.ws.close();
      } else client.ws.close();
    } catch {}
  }
  if (!settings || !mainTarget) await sleep(250);
}
if (!settings || !mainTarget) throw new Error("main/settings targets missing");
const main = await connect(mainTarget.webSocketDebuggerUrl);
await main.evalJs(`window.__TAURI_INTERNALS__.invoke('open_settings').then(() => true)`);
for (let i = 0; i < 40; i++) {
  if (await settings.evalJs(`!!document.querySelector('.settings-page-content')`)) break;
  await sleep(150);
}

const nav = await settings.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).map((el) => el.dataset.section)`);
check(
  "nine grouped nav sections in task order",
  JSON.stringify(nav) === JSON.stringify(["appearance", "launcher", "clipboard", "search", "hotkeys", "automation", "plugins", "system", "about"]),
  JSON.stringify(nav),
);
const brandAlpha = await settings.evalJs(`(async () => {
  const mark = document.querySelector('.settings-brand-mark');
  if (!mark) return null;
  if (!mark.complete) await new Promise((resolve, reject) => {
    mark.addEventListener('load', resolve, { once: true });
    mark.addEventListener('error', reject, { once: true });
  });
  try {
    const canvas = document.createElement('canvas');
    canvas.width = mark.naturalWidth;
    canvas.height = mark.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(mark, 0, 0);
    const corner = Array.from(ctx.getImageData(0, 0, 1, 1).data);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let maxAlpha = 0;
    for (let i = 3; i < data.length; i += 4) maxAlpha = Math.max(maxAlpha, data[i]);
    return { cornerAlpha: corner[3], maxAlpha };
  } catch {
    return { cornerAlpha: -1, maxAlpha: -1 };
  }
})()`);
const topbar = await settings.evalJs(`(() => {
  const mark = document.querySelector('.settings-brand-mark');
  const cs = mark ? getComputedStyle(mark) : null;
  return {
    tag: mark?.tagName ?? "",
    asset: (mark?.getAttribute('src') || '').split('/').pop() ?? "",
    natural: [mark?.naturalWidth ?? 0, mark?.naturalHeight ?? 0],
    border: cs?.borderTopWidth ?? "",
    background: cs?.backgroundColor ?? "",
    fit: cs?.objectFit ?? "",
    filter: cs?.filter ?? "",
    rootFilter: getComputedStyle(document.documentElement).getPropertyValue('--icon-filter').trim(),
    dragRegion: mark?.hasAttribute('data-tauri-drag-region') ?? false,
    shortcut: document.querySelector('.settings-search-shortcut')?.textContent ?? "",
  };
})()`);
check(
  "settings topbar shows the transparent high-res app icon and the Ctrl+F hint",
  topbar.tag === "IMG" && topbar.natural[0] >= 256 && topbar.natural[1] >= 256
    && topbar.border === "0px" && topbar.background === "rgba(0, 0, 0, 0)"
    && topbar.fit === "contain" && topbar.filter === topbar.rootFilter
    && topbar.dragRegion && topbar.shortcut === "Ctrl+F"
    && /icon-transparent/.test(topbar.asset)
    && brandAlpha?.cornerAlpha === 0 && brandAlpha?.maxAlpha > 200,
  JSON.stringify({ topbar, brandAlpha }),
);
const footer = await settings.evalJs(`({
  status: document.querySelector('.settings-save-status')?.textContent.trim(),
  save: Array.from(document.querySelectorAll('.settings-footer button')).some((el) => el.textContent.includes('保存并应用')),
  restore: Array.from(document.querySelectorAll('.settings-footer button')).some((el) => el.textContent.includes('恢复应用默认值')),
})`);
check("autosave status replaces the global save button", !!footer.status && footer.save === false && footer.restore, JSON.stringify(footer));
check("appearance renders semantic groups", (await settings.evalJs(`document.querySelectorAll('.settings-setting-group').length`)) >= 3);
await settings.shot("appearance");

await settings.evalJs(`(() => {
  const input = document.querySelector('.settings-search-input');
  input.focus();
  input.value = '许可证';
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '许可证' }));
  return true;
})()`);
await sleep(250);
const search = await settings.evalJs(`({
  open: !!document.querySelector('.settings-search-results'),
  labels: Array.from(document.querySelectorAll('.settings-result-label')).map((el) => el.textContent),
})`);
check("command search shows row-level results", search.open && search.labels.some((label) => label.includes('许可证')), JSON.stringify(search));
await settings.evalJs(`document.querySelector('.settings-search-result')?.click(); true`);
await sleep(250);
check("search result jumps to 关于", (await settings.evalJs(`document.querySelector('.settings-nav.active')?.dataset.section`)) === "about");

await settings.evalJs(`document.querySelector('.settings-nav[data-section="search"]')?.click(); true`);
await sleep(200);
const refresh = await settings.evalJs(`!!document.querySelector('[data-setting-id="action.refresh_index"]')`);
const emptyIndex = await settings.evalJs(`document.querySelector('.settings-empty')?.textContent ?? ''`);
check("search page exposes refresh + user-index empty state", refresh && emptyIndex.length > 0, JSON.stringify({ refresh, emptyIndex }));
await settings.shot("search");

await settings.evalJs(`document.querySelector('.settings-nav[data-section="clipboard"]')?.click(); true`);
await sleep(200);
const clipboard = await settings.evalJs(`({
  groups: Array.from(document.querySelectorAll('.settings-grouptitle')).map((el) => el.textContent.trim()),
  mergeSlider: !!document.querySelector('.settings-slider-input'),
  mergeDisabled: document.querySelector('.settings-slider-input')?.disabled === true,
})`);
check("clipboard keeps merge slider visible but disabled", clipboard.groups.includes('忽略应用') && clipboard.mergeSlider && clipboard.mergeDisabled, JSON.stringify(clipboard));
await settings.shot("clipboard");

for (const section of ["hotkeys", "automation", "plugins", "system", "about"]) {
  await settings.evalJs(`document.querySelector('.settings-nav[data-section="${section}"]')?.click(); true`);
  await sleep(200);
  await settings.shot(section);
}
await settings.evalJs(`document.querySelector('.settings-nav[data-section="hotkeys"]')?.click(); true`);
await sleep(200);
const keycaps = await settings.evalJs(`Array.from(document.querySelectorAll('.settings-keycap')).map((el) => el.textContent.trim())`);
check("hotkey slots render as keycaps", keycaps.length >= 2, JSON.stringify(keycaps));
const overflow = await settings.evalJs(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.settings-main').scrollWidth <= document.querySelector('.settings-main').clientWidth`);
check("1040×720 settings has no horizontal overflow", overflow);

console.log(failures === 0 ? "[settings-smoke] ALL PASS" : `[settings-smoke] ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
