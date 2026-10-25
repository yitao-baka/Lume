// Unified skin-system acceptance: shared surfaces, first-frame application,
// embedded/detached plugin canvases, clipboard row rhythm, and global accent.
// Build first:
//   pnpm run build && pnpm run tauri build --debug --no-bundle
// Run:
//   node scripts/cdp_skin_system_verify.mjs
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const PORT = 9264;
const BASE = "src-tauri/target/debug";
const APP = `${BASE}/lume.exe`;
const OUT = "test/skin-system-verify";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  ok ? pass++ : fail++;
};

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(400);
mkdirSync(OUT, { recursive: true });
cpSync("examples/plugins/hello-mode", `${BASE}/plugins/hello-mode`, { recursive: true, force: true });
try {
  execSync('powershell -NoProfile -Command "Set-Clipboard -Value \'Lume skin clipboard sample\'"', { stdio: "ignore" });
} catch {}
const log = openSync(`${OUT}/lume.log`, "w");
spawn(APP, [], {
  cwd: process.cwd(),
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", log, log],
});

async function targets() {
  for (let i = 0; i < 100; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
    catch { await sleep(200); }
  }
  throw new Error("CDP unavailable");
}

function pngPixel(buf) {
  let pos = 8, w = 0, h = 0, depth = 0, ctype = 0;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  const channels = ctype === 6 ? 4 : ctype === 2 ? 3 : ctype === 4 ? 2 : ctype === 0 ? 1 : 0;
  if (!channels || depth !== 8) throw new Error(`unsupported PNG ctype=${ctype} depth=${depth}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const out = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const x = line[i];
      cur[i] = (filter === 0 ? x
        : filter === 1 ? x + a
        : filter === 2 ? x + b
        : filter === 3 ? x + ((a + b) >> 1)
        : x + paeth(a, b, c)) & 255;
    }
  }
  const offset = (h - 1) * stride;
  return [out[offset], out[offset + 1], out[offset + 2], channels === 4 ? out[offset + 3] : 255];
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
    const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description ?? "eval failed");
    }
    return reply.result?.result?.value;
  };
  const pixel = async (x, y) => {
    const reply = await send("Page.captureScreenshot", {
      format: "png",
      clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1, scale: 1 },
    });
    return pngPixel(Buffer.from(reply.result.data, "base64"));
  };
  const shot = async (name) => {
    const reply = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(reply.result.data, "base64"));
  };
  return { ws, send, evalJs, pixel, shot };
}

async function findPage(probe, match = "tauri.localhost") {
  for (let i = 0; i < 80; i++) {
    for (const target of await targets()) {
      if (target.type !== "page" || !target.url.includes(match)) continue;
      try {
        const client = await connect(target.webSocketDebuggerUrl);
        if (await probe(client)) return client;
        client.ws.close();
      } catch {}
    }
    await sleep(250);
  }
  return null;
}

const isMain = (client) => client.evalJs(`!!document.getElementById("search-input")`);
const isSettings = (client) => client.evalJs(`document.body.classList.contains("settings-window")`);
let main = await findPage(isMain);
if (!main) throw new Error("launcher target missing");
let settings = await findPage(isSettings);
await main.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher").then(() => true)`);
if (!settings) {
  await main.evalJs(`window.__TAURI_INTERNALS__.invoke("open_settings").then(() => true)`);
  settings = await findPage(isSettings);
}
if (!settings) throw new Error("settings target missing");

const invoke = (cmd, args = {}) => main.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const writeClipboard = (text) => {
  // The launcher samples the clipboard in the background; an immediate
  // Set-Clipboard can lose the open race. Retry briefly instead of failing the
  // whole run on a transient CLIPBRD_E_CANT_OPEN.
  let lastError;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      execSync(`powershell -NoProfile -Command "Set-Clipboard -Value '${text}'"`, { stdio: "ignore" });
      return;
    } catch (error) {
      lastError = error;
      execSync(`powershell -NoProfile -Command "Start-Sleep -Milliseconds 80"`, { stdio: "ignore" });
    }
  }
  throw lastError;
};
const seedClipboard = async (label) => {
  const text = `Lume skin ${label} ${Date.now()}`;
  writeClipboard(text);
  await sleep(1600);
};
const seedClipboardRows = async (count) => {
  for (let i = 0; i < count; i++) {
    const text = `Lume wheel row ${Date.now()}-${i}`;
    writeClipboard(text);
    await sleep(360);
  }
};
const setSettings = async (patch) => {
  const current = await invoke("get_settings");
  const appearance = patch.appearance ?? {};
  Object.assign(current.appearance, appearance);
  if (appearance.skin !== undefined && appearance.settings_skin === undefined) {
    current.appearance.settings_skin = appearance.skin;
  }
  if (patch.colorModes !== undefined) current.plugins.color_modes = patch.colorModes;
  if (patch.presenters !== undefined) current.pages.presenters = patch.presenters;
  await invoke("save_settings", { new: current });
  await sleep(650);
};
const reloadSettings = async () => {
  await settings.evalJs(`location.reload(); true`).catch(() => undefined);
  await sleep(650);
  for (let i = 0; i < 50; i++) {
    if (await settings.evalJs(`!!document.querySelector(".settings-page-content")`)) return;
    await sleep(120);
  }
  throw new Error("settings did not reload");
};
const type = (text) => main.evalJs(`(() => {
  const input = document.getElementById("search-input");
  input.focus();
  input.value = ${JSON.stringify(text)};
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
const enterHelloMode = async () => {
  await type("hello");
  await sleep(1200);
  const index = await main.evalJs(`[...document.querySelectorAll(".result-box")].findIndex((el) => el.textContent.includes("进入 Hello Mode"))`);
  if (index < 0) return false;
  await main.evalJs(`[...document.querySelectorAll(".result-box")][${index}].dispatchEvent(new MouseEvent("click", { bubbles: true })); true`);
  await sleep(220);
  await main.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })); true`);
  await sleep(2200);
  return true;
};
const pagePoint = (client) => client.evalJs(`(() => {
  const frame = document.querySelector(".plugin-frame");
  if (!frame) return null;
  const rect = frame.getBoundingClientRect();
  return { x: rect.left + 8, y: rect.top + 8 };
})()`);
const panelPoint = () => main.evalJs(`(() => {
  const rect = document.querySelector(".search").getBoundingClientRect();
  return { x: rect.left + 12, y: rect.top + 4 };
})()`);
const near = (a, b, tolerance = 4) => a.slice(0, 3).every((value, index) => Math.abs(value - b[index]) <= tolerance);
const rgb = (value) => {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
};
const hex = (pixel) => "#" + pixel.slice(0, 3).map((value) => value.toString(16).padStart(2, "0")).join("");
const SURFACES = {
  quiet: { dark: "#1e1e20", light: "#fbfbfd" },
  chromatic: { dark: "#1e1e20", light: "#f3efe6" },
};

await seedClipboard("baseline");
await invoke("set_plugin_enabled", { id: "hello-mode", enabled: true });
await setSettings({
  appearance: { skin: "quiet", color_mode: "dark", accent: "", accent_custom: "" },
  colorModes: {},
  presenters: { clipboard: "clipboard-list" },
});
await main.evalJs(`document.querySelector(".search-input")?.focus(); true`);
await seedClipboardRows(14);

// Independent window skins are intentional input, not a transient mismatch.
await setSettings({
  appearance: { skin: "quiet", settings_skin: "chromatic", color_mode: "light", accent: "" },
  colorModes: {},
});
await reloadSettings();
const independentOne = await settings.evalJs(`({
  settingsSkin: document.documentElement.dataset.skin,
  surface: document.documentElement.style.getPropertyValue("--surface").trim(),
})`);
const launcherOne = await main.evalJs(`({
  launcherSkin: document.documentElement.dataset.skin,
  surface: document.documentElement.style.getPropertyValue("--surface").trim(),
})`);
check("launcher Quiet + settings Chromatic apply independently",
  launcherOne.launcherSkin === "quiet" && launcherOne.surface === SURFACES.quiet.light &&
  independentOne.settingsSkin === "chromatic" && independentOne.surface === SURFACES.chromatic.light,
  JSON.stringify({ launcherOne, independentOne }));

await setSettings({
  appearance: { skin: "chromatic", settings_skin: "quiet", color_mode: "light", accent: "" },
  colorModes: {},
});
await reloadSettings();
const independentTwo = await settings.evalJs(`({
  settingsSkin: document.documentElement.dataset.skin,
  surface: document.documentElement.style.getPropertyValue("--surface").trim(),
})`);
const launcherTwo = await main.evalJs(`({
  launcherSkin: document.documentElement.dataset.skin,
  surface: document.documentElement.style.getPropertyValue("--surface").trim(),
})`);
check("launcher Chromatic + settings Quiet apply independently",
  launcherTwo.launcherSkin === "chromatic" && launcherTwo.surface === SURFACES.chromatic.light &&
  independentTwo.settingsSkin === "quiet" && independentTwo.surface === SURFACES.quiet.light,
  JSON.stringify({ launcherTwo, independentTwo }));

// ── ① first-frame persistence + shared surface source ───────────────────
for (const [skin, modes] of Object.entries(SURFACES)) {
  for (const [mode, surface] of Object.entries(modes)) {
    await setSettings({ appearance: { skin, color_mode: mode, accent: "" }, colorModes: {} });
    await reloadSettings();
    const settingsFrame = await settings.evalJs(`(async () => ({
      skin: document.documentElement.dataset.skin,
      theme: document.documentElement.dataset.theme,
      surface: document.documentElement.style.getPropertyValue("--surface").trim(),
      configured: (await window.__TAURI_INTERNALS__.invoke("get_settings")).appearance.settings_skin,
    }))()`);
    check(`${skin}/${mode} settings refresh uses the shared skin metadata`,
      settingsFrame.skin === skin && settingsFrame.theme === mode &&
        settingsFrame.surface === surface && settingsFrame.configured === skin,
      JSON.stringify(settingsFrame));

    const mainFrame = await main.evalJs(`({
      skin: document.documentElement.dataset.skin,
      theme: document.documentElement.dataset.theme,
      surface: document.documentElement.style.getPropertyValue("--surface").trim(),
      bg: getComputedStyle(document.querySelector(".launcher")).backgroundColor,
    })`);
    const panel = await main.pixel(...Object.values(await panelPoint()));
    check(`${skin}/${mode} launcher CSS and pixels share one surface`,
      mainFrame.skin === skin && mainFrame.theme === mode && mainFrame.surface === surface && mainFrame.bg === `rgb(${rgb(surface).join(", ")})` && near(panel, rgb(surface)),
      JSON.stringify({ ...mainFrame, pixel: hex(panel) }));
  }
}

// ── ② navigation query / selection / scroll survive a skin switch ───────
await setSettings({
  appearance: {
    skin: "quiet",
    color_mode: "light",
    accent: "",
    window_height: 160,
  },
  colorModes: {},
  presenters: { apps: "navigate-grid", clipboard: "clipboard-list" },
});
const navMode = await main.evalJs(`(() => {
  const button = Array.from(document.querySelectorAll(".mode-switch-item"))
    .find((el) => /导航|navigate/i.test((el.getAttribute("aria-label") || "") + " " + (el.title || "")));
  button?.click();
  return button?.getAttribute("aria-label") ?? "";
})()`);
check("switched back to the navigation page", !!navMode, navMode);
await sleep(450);
let navQuery = "";
for (const candidate of ["a", "e", "cmd", "c"]) {
  await type(candidate);
  await sleep(550);
  if (await main.evalJs(`(() => {
    const grid = document.querySelector(".mode-host.active .result-grid");
    return !!grid && grid.scrollHeight > grid.clientHeight && !!grid.querySelector(".result-box");
  })()`)) {
    navQuery = candidate;
    break;
  }
}
check("navigation search produced a scrollable result grid", !!navQuery, navQuery || "no query");
if (navQuery) {
  await main.evalJs(`(() => {
    const grid = document.querySelector(".mode-host.active .result-grid");
    const first = grid?.querySelector(".result-box");
    if (!grid || !first) return false;
    grid.__skinStable = 91;
    grid.scrollTop = 64;
    first.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    return true;
  })()`);
  await sleep(250);
  const navBefore = await main.evalJs(`(() => {
    const grid = document.querySelector(".mode-host.active .result-grid");
    return {
      query: document.getElementById("search-input").value,
      selected: grid?.querySelector(".result-selected")?.dataset.targetId ?? "",
      scroll: grid?.scrollTop ?? 0,
      stable: grid?.__skinStable ?? 0,
      radius: grid?.querySelector(".result-box") ? getComputedStyle(grid.querySelector(".result-box")).borderRadius : "",
    };
  })()`);
  await setSettings({ appearance: { skin: "chromatic" } });
  await sleep(550);
  const navAfter = await main.evalJs(`(() => {
    const grid = document.querySelector(".mode-host.active .result-grid");
    return {
      query: document.getElementById("search-input").value,
      selected: grid?.querySelector(".result-selected")?.dataset.targetId ?? "",
      scroll: grid?.scrollTop ?? 0,
      stable: grid?.__skinStable ?? 0,
      radius: grid?.querySelector(".result-box") ? getComputedStyle(grid.querySelector(".result-box")).borderRadius : "",
    };
  })()`);
  check("skin switch preserves navigation query, selection, DOM and scroll",
    navBefore.selected !== "" &&
      navAfter.query === navBefore.query &&
      navAfter.selected === navBefore.selected &&
      Math.abs(navAfter.scroll - navBefore.scroll) <= 2 &&
      navAfter.stable === navBefore.stable,
    JSON.stringify({ before: navBefore, after: navAfter }));
  check("Chromatic launcher rules reach navigation content without rebuilding it",
    navBefore.radius !== navAfter.radius && navAfter.radius === "2px",
    JSON.stringify({ before: navBefore.radius, after: navAfter.radius }));
}

// ── ③ embedded plugin canvas follows skin + plugin-resolved mode ────────
await setSettings({
  appearance: {
    skin: "quiet",
    color_mode: "light",
    accent: "#d96c95",
    accent_custom: "#d96c95",
    window_height: 520,
  },
  colorModes: {},
});
check("entered hello-mode for canvas checks", await enterHelloMode());
let area = await pagePoint(main);
check("embedded plugin frame mounted", !!area, JSON.stringify(area));
const presenterInjection = await main.evalJs(`document.querySelector(".plugin-frame")?.getAttribute("srcdoc") ?? ""`);
check("embedded Presenter receives skin, surface and accent before page load",
  presenterInjection.includes('--lume-page-bg:#fbfbfd') &&
    presenterInjection.includes('--lume-page-accent:#d96c95') &&
    presenterInjection.includes('dataset.lumeSkin="quiet"'),
  presenterInjection.slice(0, 240));
for (const [skin, mode] of [["quiet", "light"], ["quiet", "dark"], ["chromatic", "light"], ["chromatic", "dark"]]) {
  await setSettings({ appearance: { skin, color_mode: mode, accent: "" }, colorModes: {} });
  await sleep(250);
  area = await pagePoint(main);
  const pixel = area ? await main.pixel(area.x, area.y) : null;
  check(`${skin}/${mode} embedded plugin canvas equals the launcher surface`,
    !!pixel && near(pixel, rgb(SURFACES[skin][mode])),
    pixel ? hex(pixel) : "no frame");
}

// Plugin's own color override must stay orthogonal to the global skin.
await setSettings({ appearance: { skin: "chromatic", color_mode: "dark", accent: "" }, colorModes: { "hello-mode": "light" } });
await sleep(700);
area = await pagePoint(main);
const pinnedLight = area ? await main.pixel(area.x, area.y) : null;
check("plugin light override picks Chromatic light canvas while launcher stays dark",
  !!pinnedLight && near(pinnedLight, rgb(SURFACES.chromatic.light)),
  pinnedLight ? hex(pinnedLight) : "no frame");
await type("theme:system");
await sleep(700);
await setSettings({ colorModes: {} });

// ── ④ detached window first frame + canvas + accent shell ──────────────
await setSettings({
  appearance: {
    skin: "chromatic",
    color_mode: "light",
    accent: "#d96c95",
    accent_custom: "#d96c95",
  },
  colorModes: {},
});
await main.evalJs(`document.querySelector(".detach-btn")?.click(); true`);
await sleep(1800);
let detached = await findPage(
  async (client) => client.evalJs(`!!document.querySelector(".plugin-window-root")`),
  "plugin.html?plugin=hello-mode",
);
if (!detached) {
  for (let i = 0; i < 20 && !detached; i++) {
    await sleep(300);
    detached = await findPage(
      async (client) => client.evalJs(`!!document.querySelector(".plugin-window-root")`),
      "plugin.html?plugin=hello-mode",
    );
  }
}
check("detached plugin window created", !!detached);
if (detached) {
  const frame = await detached.evalJs(`({
    skin: document.documentElement.dataset.skin,
    theme: document.documentElement.dataset.theme,
    surface: document.documentElement.style.getPropertyValue("--surface").trim(),
    accent: document.documentElement.style.getPropertyValue("--ui-accent-raw").trim(),
    accentText: document.documentElement.style.getPropertyValue("--ui-accent-text").trim(),
    accentBorder: document.documentElement.style.getPropertyValue("--ui-accent-border").trim(),
    focus: document.documentElement.style.getPropertyValue("--ui-focus-ring").trim(),
  })`);
  check("detached window first frame carries Chromatic light surface and accent",
    frame.skin === "chromatic" && frame.theme === "light" &&
      frame.surface === SURFACES.chromatic.light && frame.accent === "#d96c95" &&
      [frame.accentText, frame.accentBorder, frame.focus].every((value) => /^#[0-9a-f]{6}$/.test(value)),
    JSON.stringify(frame));
  const detachedArea = await pagePoint(detached);
  const detachedPixel = detachedArea ? await detached.pixel(detachedArea.x, detachedArea.y) : null;
  check("detached plugin canvas equals its window surface",
    !!detachedPixel && near(detachedPixel, rgb(SURFACES.chromatic.light)),
    detachedPixel ? hex(detachedPixel) : "no frame");
  await detached.shot("detached-chromatic-light");
  await detached.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true`);
  await sleep(1200);
  detached.ws.close();
}

// ── ⑤ clipboard skin rhythm + selection/scroll preservation ─────────────
await seedClipboard("row-rhythm");
await setSettings({ appearance: { skin: "quiet", color_mode: "dark", accent: "" }, presenters: { clipboard: "clipboard-list" } });
await main.evalJs(`[...document.querySelectorAll(".mode-switch-item")].find((el) => el.textContent.includes("剪贴板") || el.textContent.toLowerCase().includes("clipboard"))?.click(); true`);
await sleep(250);
await main.evalJs(`(() => {
  const input = document.getElementById("search-input");
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
for (let i = 0; i < 20; i++) {
  if (await main.evalJs(`!!document.querySelector(".mode-host.active .clip-row")`)) break;
  await sleep(150);
}
await sleep(250);

// A real wheel gesture must survive the viewport intent round-trip. The old
// model-driven auto-scroll snapped back to the selected row on every publish.
for (const presenter of ["clipboard-list", "clipboard-compact"]) {
  await setSettings({ appearance: { skin: "quiet" }, presenters: { clipboard: presenter } });
  await sleep(500);
  await main.evalJs(`(() => {
    document.getElementById("search-input")?.focus();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    return true;
  })()`);
  await sleep(160);
  const point = await main.evalJs(`(() => {
    const list = document.querySelector(".mode-host.active .clip-list");
    if (!list) return null;
    list.scrollTop = 0;
    const rect = list.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + Math.min(rect.height / 2, 120) };
  })()`);
  if (point) {
    await main.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: point.x,
      y: point.y,
      deltaX: 0,
      deltaY: 420,
    });
  }
  await sleep(350);
  const early = await main.evalJs(`document.querySelector(".mode-host.active .clip-list")?.scrollTop ?? -1`);
  await sleep(500);
  const settled = await main.evalJs(`document.querySelector(".mode-host.active .clip-list")?.scrollTop ?? -1`);
  check(`${presenter} wheel scroll does not snap back after model refresh`,
    !!point && early > 100 && settled > 100 && Math.abs(settled - early) <= 2,
    JSON.stringify({ point, early, settled }));
}

for (const [skin, listH, compactH] of [["quiet", 52, 44], ["chromatic", 56, 48]]) {
  await setSettings({ appearance: { skin }, presenters: { clipboard: "clipboard-list" } });
  await sleep(450);
  const listState = await main.evalJs(`(() => {
    const page = document.querySelector(".mode-host.active .clip-page");
    const row = document.querySelector(".mode-host.active .clip-row");
    page && (page.__skinStable = page.__skinStable ?? ${JSON.stringify(skin)});
    return {
      cssVar: page ? getComputedStyle(page).getPropertyValue("--clip-row-height").trim() : "",
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      selected: document.querySelector(".mode-host.active .result-selected")?.dataset.targetId ?? "",
      stable: page?.__skinStable ?? "",
    };
  })()`);
  check(`${skin} clipboard-list publishes ${listH}px row height`,
    listState.cssVar === `${listH}px` && (listState.rowHeight === null || listState.rowHeight === listH),
    JSON.stringify(listState));

  await setSettings({ presenters: { clipboard: "clipboard-compact" } });
  await sleep(450);
  const compactState = await main.evalJs(`(() => {
    const page = document.querySelector(".mode-host.active .clip-page");
    const row = document.querySelector(".mode-host.active .clip-compact-row");
    return {
      cssVar: page ? getComputedStyle(page).getPropertyValue("--clip-row-height").trim() : "",
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      selected: document.querySelector(".mode-host.active .result-selected")?.dataset.targetId ?? "",
    };
  })()`);
  check(`${skin} clipboard-compact publishes ${compactH}px row height`,
    compactState.cssVar === `${compactH}px` && (compactState.rowHeight === null || compactState.rowHeight === compactH),
    JSON.stringify(compactState));
  check(`${skin} presenter switch keeps the selected clipboard id`,
    !listState.selected || compactState.selected === listState.selected,
    JSON.stringify({ before: listState.selected, after: compactState.selected }));
}

await setSettings({ appearance: { skin: "quiet" }, presenters: { clipboard: "clipboard-list" } });
await sleep(400);
const selectionBefore = await main.evalJs(`document.querySelector(".mode-host.active .result-selected")?.dataset.targetId ?? ""`);
await main.evalJs(`(() => { const page = document.querySelector(".mode-host.active .clip-page"); page.__skinStable = 73; return true; })()`);
await setSettings({ appearance: { skin: "chromatic" } });
await sleep(500);
const selectionAfter = await main.evalJs(`(() => ({
  selected: document.querySelector(".mode-host.active .result-selected")?.dataset.targetId ?? "",
  stable: document.querySelector(".mode-host.active .clip-page")?.__skinStable ?? 0,
  rowHeight: Math.round(document.querySelector(".mode-host.active .clip-row")?.getBoundingClientRect().height ?? 0),
}))()`);
check("skin switch preserves clipboard selection and DOM identity",
  (!selectionBefore || selectionAfter.selected === selectionBefore) && selectionAfter.stable === 73,
  JSON.stringify({ before: selectionBefore, after: selectionAfter }));
check("skin switch updates the active clipboard row rhythm", selectionAfter.rowHeight === 56, JSON.stringify(selectionAfter));

// Keyboard navigation must keep working after the virtual row height changes.
await main.evalJs(`document.getElementById("search-input")?.focus(); true`);
for (let i = 0; i < 18; i++) {
  await main.evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" })); true`);
  await sleep(30);
}
await sleep(450);
const keyboardAfterResize = await main.evalJs(`(() => {
  const list = document.querySelector(".mode-host.active .clip-list");
  const row = document.querySelector(".mode-host.active .result-selected");
  if (!list || !row) return null;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  return {
    selected: row.dataset.targetId ?? "",
    scrollTop: list.scrollTop,
    rowHeight: Math.round(row.getBoundingClientRect().height),
    visible: rowRect.top >= listRect.top && rowRect.bottom <= listRect.bottom,
  };
})()`);
check("keyboard navigation remains visible after Chromatic row-height growth",
  !!keyboardAfterResize && keyboardAfterResize.visible &&
    keyboardAfterResize.scrollTop > 0 && keyboardAfterResize.rowHeight === 56,
  JSON.stringify(keyboardAfterResize));

// ── ⑥ global accent changes emphasis but never the outer surface ────────
await setSettings({ appearance: { skin: "chromatic", color_mode: "dark", accent: "#d96c95", accent_custom: "#d96c95" }, colorModes: {} });
await reloadSettings();
const accentState = await main.evalJs(`(() => {
  const root = document.documentElement;
  const page = document.querySelector(".mode-host.active .clip-page");
  return {
    accent: root.dataset.accent,
    raw: root.style.getPropertyValue("--ui-accent-raw").trim(),
    safe: root.style.getPropertyValue("--ui-accent").trim(),
    surface: root.style.getPropertyValue("--surface").trim(),
    bg: getComputedStyle(document.querySelector(".launcher")).backgroundColor,
    selectedBorder: page ? getComputedStyle(page).getPropertyValue("--accent-border").trim() : "",
  };
})()`);
const accentSurface = await main.pixel(...Object.values(await panelPoint()));
check("custom accent is global but the launcher outer surface stays skin-owned",
  accentState.accent === "custom" && accentState.raw === "#d96c95" && accentState.safe !== "#d96c95" &&
    accentState.surface === SURFACES.chromatic.dark && accentState.bg === "rgb(30, 30, 32)" && near(accentSurface, rgb(SURFACES.chromatic.dark)),
  JSON.stringify({ ...accentState, pixel: hex(accentSurface) }));
await main.shot("chromatic-dark-accent");

// ── ⑦ fresh-process first paint ─────────────────────────────────────────
await setSettings({
  appearance: { skin: "chromatic", color_mode: "light", accent: "", accent_custom: "" },
  colorModes: {},
  presenters: { clipboard: "clipboard-list" },
});
main.ws.close();
settings.ws.close();
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(700);
const restartedLog = openSync(`${OUT}/lume-restart.log`, "w");
spawn(APP, [], {
  cwd: process.cwd(),
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", restartedLog, restartedLog],
});
main = await findPage(isMain);
settings = await findPage(isSettings);
if (!main || !settings) throw new Error("restarted windows missing");
const firstMain = await main.evalJs(`({
  skin: document.documentElement.dataset.skin,
  theme: document.documentElement.dataset.theme,
  surface: document.documentElement.style.getPropertyValue("--surface").trim(),
  configured: window.__LUME_CONFIG__?.appearance?.skin,
})`);
const firstSettings = await settings.evalJs(`({
  skin: document.documentElement.dataset.skin,
  theme: document.documentElement.dataset.theme,
  surface: document.documentElement.style.getPropertyValue("--surface").trim(),
  configured: window.__LUME_CONFIG__?.appearance?.skin,
})`);
check("fresh process injects the current skin into the launcher before render",
  firstMain.skin === "chromatic" && firstMain.theme === "light" && firstMain.surface === SURFACES.chromatic.light && firstMain.configured === "chromatic",
  JSON.stringify(firstMain));
check("fresh process injects the current skin into settings before render",
  firstSettings.skin === "chromatic" && firstSettings.theme === "light" && firstSettings.surface === SURFACES.chromatic.light && firstSettings.configured === "chromatic",
  JSON.stringify(firstSettings));

// ── ⑧ reset scratch settings ────────────────────────────────────────────
await setSettings({
  appearance: { skin: "quiet", color_mode: "dark", accent: "", accent_custom: "" },
  colorModes: {},
  presenters: { clipboard: "clipboard-list" },
});
console.log(`\nSKIN SYSTEM VERIFY ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
main.ws.close();
settings.ws.close();
process.exit(fail === 0 ? 0 : 1);
