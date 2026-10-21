// Settings-window accent/palette regression. Build first:
//   pnpm run build && pnpm run tauri build --debug --no-bundle
// Run:
//   node scripts/cdp_settings_accent_verify.mjs
import { spawn, execSync } from "node:child_process";
import { mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = 9263;
const BASE = "src-tauri/target/debug";
const APP = `${BASE}/lume.exe`;
const OUT = "test/settings-accent-verify";
const SETTINGS_TOML = resolve(BASE, "settings/settings.toml");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (ok) pass++;
  else fail++;
};

function killApp() {
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
}

function launchApp() {
  const log = openSync(`${OUT}/lume.log`, "a");
  spawn(APP, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    },
    stdio: ["ignore", log, log],
  });
}

killApp();
await sleep(400);
mkdirSync(OUT, { recursive: true });
// `default.toml` is factory state and is only created when missing. If this
// scratch build has a legacy file that predates the current schema, regenerate
// it for the restore-default test and put the original back on exit.
const DEFAULT_TOML = resolve(BASE, "settings/default.toml");
let originalDefault = null;
try { originalDefault = readFileSync(DEFAULT_TOML); } catch {}
if (originalDefault && (
  !originalDefault.toString("utf8").includes("[clipboard]") ||
  !originalDefault.toString("utf8").includes("settings_accent")
)) {
  process.on("exit", () => {
    try { writeFileSync(DEFAULT_TOML, originalDefault); } catch {}
  });
  try { rmSync(DEFAULT_TOML); } catch {}
}
launchApp();

async function targets() {
  for (let i = 0; i < 100; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); }
    catch { await sleep(200); }
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

async function attach() {
  let settings = null;
  let mainTarget = null;
  for (let attempt = 0; attempt < 100 && (!settings || !mainTarget); attempt++) {
    const pages = (await targets()).filter((target) =>
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
    if (!settings || !mainTarget) await sleep(200);
  }
  if (!settings || !mainTarget) throw new Error("main/settings targets missing");
  const main = await connect(mainTarget.webSocketDebuggerUrl);
  return { settings, main };
}

let { settings, main } = await attach();
await main.evalJs(`window.__TAURI_INTERNALS__.invoke('open_settings').then(() => true)`);

const waitReady = async () => {
  for (let i = 0; i < 50; i++) {
    if (await settings.evalJs(`!!document.querySelector('.settings-page-content')`)) return;
    await sleep(150);
  }
  throw new Error("settings did not become ready");
};
await waitReady();

const reloadSettings = async () => {
  await settings.evalJs(`location.reload(); true`).catch(() => undefined);
  await sleep(700);
  await waitReady();
};
const setAppearance = async (skin, colorMode, accent, custom) => {
  const appearance = { settings_skin: skin, color_mode: colorMode };
  if (accent !== undefined) appearance.settings_accent = accent;
  if (custom !== undefined) appearance.settings_accent_custom = custom;
  await settings.evalJs(`window.__TAURI_INTERNALS__.invoke('save_settings_patch', { patch: {
    appearance: ${JSON.stringify(appearance)}
  }}).then(() => true)`);
  await reloadSettings();
};
const getSaved = () => settings.evalJs(`window.__TAURI_INTERNALS__.invoke('get_settings')`);
const go = async (section) => {
  await settings.evalJs(`document.querySelector('.settings-nav[data-section="${section}"]')?.click(); true`);
  await sleep(180);
};
const showAccent = async () => {
  await settings.evalJs(`document.querySelector('[data-setting-id="appearance.settings_accent"]')?.scrollIntoView({ block: 'center' }); true`);
  await sleep(160);
};
const typeSearch = async (text) => {
  await settings.evalJs(`(() => {
    const input = document.querySelector('.settings-search-input');
    input.focus();
    input.value = ${JSON.stringify(text)};
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
    return true;
  })()`);
  await sleep(220);
};

const collect = () => settings.evalJs(`(() => {
  const root = document.documentElement;
  const probe = document.createElement('canvas');
  probe.width = probe.height = 1;
  const context = probe.getContext('2d', { willReadFrequently: true });
  const sample = (selector, property = 'backgroundColor') => {
    const element = document.querySelector(selector);
    if (!element) return null;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(element)[property];
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  };
  const checked = document.querySelector('.settings-accent-option[aria-checked="true"]');
  return {
    accentAttr: root.dataset.settingsAccent,
    userAccent: root.style.getPropertyValue('--settings-user-accent').trim(),
    userStructure: root.style.getPropertyValue('--settings-user-structure').trim(),
    userStructureText: root.style.getPropertyValue('--settings-user-structure-text').trim(),
    theme: root.dataset.theme,
    skin: root.dataset.settingsSkin,
    canvas: sample('.settings'),
    rail: sample('.settings-topbar'),
    panel: sample('.settings-group-panel'),
    control: sample('.settings-accent-option'),
    selected: sample('.settings-accent-preview-nav'),
    structure: sample('.settings-accent-preview-rule'),
    structureText: sample('.settings-accent-preview-text', 'color'),
    selectedText: sample('.settings-accent-preview-nav', 'color'),
    navIndexText: sample('.settings-accent-preview-index', 'color'),
    navActive: sample('.settings-nav.active'),
    checked: checked?.dataset.accentValue ?? null,
    customValue: document.querySelector('.settings-accent-input')?.value ?? '',
    customLabel: document.querySelector('.settings-accent-custom code')?.textContent ?? '',
    customActive: document.querySelector('.settings-accent-custom')?.classList.contains('active') ?? false,
    inputBox: document.querySelector('.settings-accent-input')?.getBoundingClientRect().toJSON(),
    accentTabStops: Array.from(document.querySelectorAll('.settings-accent-option')).filter((el) => el.tabIndex === 0).length,
    panelRadius: getComputedStyle(document.querySelector('.settings-group-panel')).borderRadius,
    docWidth: root.scrollWidth,
    viewport: innerWidth,
    row: document.querySelector('[data-setting-id="appearance.settings_accent"]')?.getBoundingClientRect().toJSON(),
    controlBox: document.querySelector('.settings-accent-control')?.getBoundingClientRect().toJSON(),
    options: Array.from(document.querySelectorAll('.settings-accent-option')).map((el) => el.getBoundingClientRect().toJSON()),
  };
})()`);

function contrast(foreground, background) {
  const channel = (value) => {
    const v = value / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (rgba) => 0.2126 * channel(rgba[0]) + 0.7152 * channel(rgba[1]) + 0.0722 * channel(rgba[2]);
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}
const minContrast = (foreground, backgrounds) =>
  Math.min(...backgrounds.map((background) => contrast(foreground, background)));
const sameRgb = (left, right) =>
  Array.isArray(left) && Array.isArray(right) && left.slice(0, 3).every((value, index) => value === right[index]);
const opaque = (...colors) => colors.every((color) => Array.isArray(color) && color[3] === 255);

await setAppearance("quiet", "dark", "");
await go("appearance");
const nativeQuietDark = await collect();
check("empty accent keeps the native Quiet dark surface", nativeQuietDark.accentAttr === undefined && sameRgb(nativeQuietDark.canvas, [25, 26, 29]), JSON.stringify(nativeQuietDark.canvas));

await setAppearance("quiet", "dark", "#6F7CFF");
await go("appearance");
const firstFrame = await collect();
check("custom accent is present on the first frame after reload", firstFrame.accentAttr === "custom" && firstFrame.userAccent === "#6f7cff", JSON.stringify({ attr: firstFrame.accentAttr, accent: firstFrame.userAccent }));
check("first frame exposes normalized derived accent tokens", /^#[0-9a-f]{6}$/.test(firstFrame.userStructure) && /^#[0-9a-f]{6}$/.test(firstFrame.userStructureText), JSON.stringify({ structure: firstFrame.userStructure, text: firstFrame.userStructureText }));
check("native color input keeps a 32×32px hit area", firstFrame.inputBox.width >= 32 && firstFrame.inputBox.height >= 32, JSON.stringify(firstFrame.inputBox));
check("all five tinted surfaces differ from native and stay opaque", opaque(firstFrame.canvas, firstFrame.rail, firstFrame.panel, firstFrame.control, firstFrame.selected) && [firstFrame.canvas, firstFrame.rail, firstFrame.panel, firstFrame.control, firstFrame.selected].every((surface, index) => !sameRgb(surface, [nativeQuietDark.canvas, nativeQuietDark.rail, nativeQuietDark.panel, nativeQuietDark.control, nativeQuietDark.selected][index])), JSON.stringify({ canvas: firstFrame.canvas, rail: firstFrame.rail, panel: firstFrame.panel, control: firstFrame.control, selected: firstFrame.selected }));
const surfaces = [firstFrame.canvas, firstFrame.rail, firstFrame.panel, firstFrame.selected, firstFrame.navActive];
const textContrast = minContrast(firstFrame.structureText, surfaces);
const structureContrast = minContrast(firstFrame.structure, surfaces);
const selectedContrast = minContrast(firstFrame.selectedText, [firstFrame.selected]);
check("accent text clears 4.5:1 on every relevant surface", textContrast >= 4.5, textContrast.toFixed(2));
check("accent structure and selected text clear their contrast floors", structureContrast >= 3 && selectedContrast >= 4.5, JSON.stringify({ structure: structureContrast.toFixed(2), selected: selectedContrast.toFixed(2) }));
const portalAccent = await settings.evalJs(`(async () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const sample = (element, property) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = getComputedStyle(element)[property];
    context.fillRect(0, 0, 1, 1);
    return Array.from(context.getImageData(0, 0, 1, 1).data);
  };
  const button = document.querySelector('[data-setting-id="appearance.color_mode"] .settings-help-btn');
  button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const tooltip = document.querySelector('.settings-help-tooltip');
  const tooltipBorder = sample(tooltip, 'borderLeftColor');
  const tooltipPanel = sample(tooltip, 'backgroundColor');
  button.click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const dialog = document.querySelector('.settings-help-dialog');
  const dialogBorder = sample(dialog, 'borderLeftColor');
  const dialogPanel = sample(dialog, 'backgroundColor');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return {
    structure: sample(document.querySelector('.settings-accent-preview-rule'), 'backgroundColor'),
    tooltipBorder,
    tooltipPanel,
    dialogBorder,
    dialogPanel,
  };
})()`);
check("Portal help surfaces inherit the accent structure and panel tint", sameRgb(portalAccent.tooltipBorder, portalAccent.structure) && sameRgb(portalAccent.dialogBorder, portalAccent.structure) && !sameRgb(portalAccent.tooltipPanel, nativeQuietDark.panel) && !sameRgb(portalAccent.dialogPanel, nativeQuietDark.panel) && opaque(portalAccent.tooltipPanel, portalAccent.dialogPanel), JSON.stringify(portalAccent));

await go("launcher");
const spinner = await settings.evalJs(`(async () => {
  const row = document.querySelector('[data-setting-id="appearance.recent_count"]');
  row?.querySelector('.settings-chip-more')?.click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  row?.scrollIntoView({ block: 'center' });
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const input = row?.querySelector('.settings-number-input');
  return {
    exists: !!input,
    appearance: input ? getComputedStyle(input).appearance : '',
    spinner: input ? getComputedStyle(input, '::-webkit-inner-spin-button').display : '',
    spinnerAppearance: input ? getComputedStyle(input, '::-webkit-inner-spin-button').webkitAppearance : '',
  };
})()`);
check("More number input uses the spinner-free text-field presentation", spinner.exists && spinner.appearance === "textfield", JSON.stringify(spinner));
await settings.shot("number-more");
await go("appearance");

await showAccent();
await settings.shot("quiet-dark-indigo");

for (const [skin, mode] of [["quiet", "light"], ["chromatic", "dark"], ["chromatic", "light"]]) {
  await setAppearance(skin, mode, "#6f7cff");
  await go("appearance");
  const state = await collect();
  const stateContrast = minContrast(state.structureText, [state.canvas, state.rail, state.panel, state.selected, state.navActive]);
  check(`${skin} × ${mode} applies the same accent`, state.accentAttr === "custom" && state.skin === skin && state.theme === mode && !sameRgb(state.canvas, nativeQuietDark.canvas), JSON.stringify({ skin: state.skin, theme: state.theme, canvas: state.canvas }));
  check(`${skin} × ${mode} keeps derived text readable`, stateContrast >= 4.5, stateContrast.toFixed(2));
  await showAccent();
  if (skin === "quiet" && mode === "light") await settings.shot("quiet-light-indigo");
  if (skin === "chromatic" && mode === "dark") await settings.shot("chromatic-dark-indigo");
  if (skin === "chromatic" && mode === "light") await settings.shot("chromatic-light-indigo");
}

await setAppearance("quiet", "dark", "#6f7cff");
const darkTokens = await collect();
await setAppearance("quiet", "light", "#6f7cff");
const lightTokens = await collect();
check("theme flip re-derives accent colors for the new mode", darkTokens.userStructureText !== lightTokens.userStructureText || darkTokens.userStructure !== lightTokens.userStructure, JSON.stringify({ dark: darkTokens.userStructureText, light: lightTokens.userStructureText }));

await setAppearance("quiet", "system", "#6f7cff");
await settings.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await sleep(250);
const systemDark = await collect();
await settings.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
await sleep(250);
const systemLight = await collect();
check("system mode re-derives when Windows light/dark changes", systemDark.theme === "dark" && systemLight.theme === "light" && systemDark.userStructureText !== systemLight.userStructureText, JSON.stringify({ dark: systemDark.userStructureText, light: systemLight.userStructureText }));
await settings.send("Emulation.setEmulatedMedia", { features: [] });

await setAppearance("quiet", "dark", "");
await go("appearance");
await settings.evalJs(`(() => {
  const target = document.querySelector('.settings-accent-option[data-accent-value="#6f7cff"]');
  target?.focus();
  target?.click();
  return !!target;
})()`);
await sleep(550);
const preset = await collect();
const presetSaved = await getSaved();
const presetFocus = await settings.evalJs(`document.activeElement?.dataset?.accentValue ?? null`);
check("preset click updates radio, DOM, and persisted value", preset.checked === "#6f7cff" && preset.accentAttr === "custom" && presetSaved.appearance.settings_accent === "#6f7cff" && presetFocus === "#6f7cff", JSON.stringify({ checked: preset.checked, saved: presetSaved.appearance.settings_accent, focus: presetFocus }));

await settings.evalJs(`(() => {
  const input = document.querySelector('.settings-accent-input');
  input.value = '#ABCDEF';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await sleep(80);
const previewOnly = await collect();
check("color input preview updates the DOM without waiting for disk", previewOnly.accentAttr === "custom" && previewOnly.userAccent === "#abcdef" && previewOnly.customLabel === "#abcdef" && !sameRgb(previewOnly.panel, nativeQuietDark.panel), JSON.stringify({ accent: previewOnly.userAccent, label: previewOnly.customLabel, panel: previewOnly.panel }));
await settings.evalJs(`document.querySelector('.settings-accent-input').dispatchEvent(new Event('change', { bubbles: true })); true`);
await sleep(550);
const custom = await collect();
const customSaved = await getSaved();
check("custom color commits as normalized lowercase hex", custom.customActive && custom.checked === null && custom.customValue === "#abcdef" && customSaved.appearance.settings_accent === "#abcdef", JSON.stringify({ custom: custom.customValue, checked: custom.checked, saved: customSaved.appearance.settings_accent }));
check("custom commit also remembers the color for the picker", customSaved.appearance.settings_accent_custom === "#abcdef", JSON.stringify(customSaved.appearance));
check("custom state keeps one preset in the keyboard tab order", custom.accentTabStops === 1, String(custom.accentTabStops));

await settings.evalJs(`Array.from(document.querySelectorAll('.settings-footer-action')).find((el) => el.textContent.includes('Undo') || el.textContent.includes('撤销') || el.textContent.includes('復原'))?.click(); true`);
await sleep(450);
const undone = await collect();
const undoSaved = await getSaved();
check("undo restores the previous accent in DOM and settings", undone.checked === "#6f7cff" && undoSaved.appearance.settings_accent === "#6f7cff", JSON.stringify({ checked: undone.checked, saved: undoSaved.appearance.settings_accent }));

await settings.evalJs(`document.querySelector('.settings-footer button[data-setting-id="system.restore_default"]')?.click(); true`);
await sleep(150);
await settings.evalJs(`document.querySelector('.settings-confirm-actions .settings-action-primary')?.click(); true`);
await sleep(700);
const restored = await collect();
const restoredSaved = await getSaved();
check("restore defaults clears the accent override", restored.accentAttr === undefined && restored.userAccent === "" && restoredSaved.appearance.settings_accent === "", JSON.stringify({ attr: restored.accentAttr, saved: restoredSaved.appearance.settings_accent }));

await setAppearance("quiet", "dark", "#3fb98b");
await go("appearance");
let readOnlySet = false;
try {
  execSync(`attrib +R "${SETTINGS_TOML}"`, { stdio: "ignore" });
  readOnlySet = true;
} catch {}
check("settings.toml can be made read-only for accent rollback", readOnlySet, SETTINGS_TOML);
await settings.evalJs(`document.querySelector('.settings-accent-option[data-accent-value="#d96c95"]')?.click(); true`);
await sleep(650);
const failed = await collect();
const failedInline = await settings.evalJs(`({
  inline: document.querySelector('[data-setting-id="appearance.settings_accent"] .settings-inline-error')?.textContent ?? '',
  state: document.documentElement.dataset.settingsSaveState,
  retry: document.querySelector('.settings-retry-status')?.textContent ?? '',
})`);
check("failed accent save rolls DOM and radio back together", failed.checked === "#3fb98b" && failed.accentAttr === "custom" && failed.userAccent === "#3fb98b", JSON.stringify({ checked: failed.checked, accent: failed.userAccent }));
check("failed accent save shows row and footer errors", failedInline.state === "error" && !!failedInline.inline && !!failedInline.retry, JSON.stringify(failedInline));
execSync(`attrib -R "${SETTINGS_TOML}"`, { stdio: "ignore" });
await settings.evalJs(`document.querySelector('.settings-retry-status')?.click(); true`);
await sleep(700);
const retried = await collect();
const retriedSaved = await getSaved();
check("retry re-applies and persists the failed accent", retried.checked === "#d96c95" && retriedSaved.appearance.settings_accent === "#d96c95" && (await settings.evalJs(`document.documentElement.dataset.settingsSaveState`)) === "saved", JSON.stringify({ checked: retried.checked, saved: retriedSaved.appearance.settings_accent }));

await typeSearch("调色盘");
const search = await settings.evalJs(`({
  count: document.querySelectorAll('.settings-search-result').length,
  labels: Array.from(document.querySelectorAll('.settings-result-label')).map((el) => el.textContent),
})`);
check("catalog search finds the accent palette by 调色盘", search.count >= 1 && search.labels.some((label) => label.includes('主题色') || label.includes('accent') || label.includes('主題色')), JSON.stringify(search));
await settings.evalJs(`document.querySelector('.settings-search-result')?.click(); true`);
await sleep(300);
const jumped = await settings.evalJs(`({
  active: document.querySelector('.settings-nav.active')?.dataset.section,
  focused: document.activeElement?.getAttribute('data-setting-id'),
  highlighted: document.querySelector('[data-setting-id="appearance.settings_accent"]')?.classList.contains('settings-jump-highlight'),
})`);
check("search jumps to and focuses the accent row", jumped.active === "appearance" && jumped.focused === "appearance.settings_accent" && jumped.highlighted, JSON.stringify(jumped));
await typeSearch("強調色");
check("catalog keyword works for Traditional Chinese", await settings.evalJs(`document.querySelectorAll('.settings-search-result').length > 0`));

await settings.send("Emulation.setDeviceMetricsOverride", { width: 560, height: 420, deviceScaleFactor: 1, mobile: false });
await sleep(250);
await go("appearance");
const narrow = await collect();
check("560×420 palette has no horizontal overflow", narrow.docWidth <= narrow.viewport + 1 && narrow.row.right <= narrow.viewport + 1 && narrow.controlBox.right <= narrow.row.right + 1 && narrow.options.every((box) => box.right <= narrow.controlBox.right + 1), JSON.stringify({ doc: narrow.docWidth, viewport: narrow.viewport, row: narrow.row, control: narrow.controlBox }));
await showAccent();
await settings.shot("narrow-560x420");
await settings.send("Emulation.setDeviceMetricsOverride", { width: 1040, height: 720, deviceScaleFactor: 1, mobile: false });
await sleep(200);
const wide = await collect();
check("1040×720 palette has no horizontal overflow", wide.docWidth <= wide.viewport + 1 && wide.row.right <= wide.viewport + 1, JSON.stringify({ doc: wide.docWidth, viewport: wide.viewport, row: wide.row }));
await settings.send("Emulation.clearDeviceMetricsOverride", {});

await setAppearance("quiet", "dark", "#d96c95");
await sleep(450);
const launcher = await main.evalJs(`({
  accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
  attr: document.documentElement.dataset.settingsAccent ?? null,
  userAccent: getComputedStyle(document.documentElement).getPropertyValue('--settings-user-accent').trim(),
})`);
check("launcher accent tokens remain independent from the settings accent", launcher.accent === "#5ac8fa" && launcher.attr === null && launcher.userAccent === "", JSON.stringify(launcher));

settings.ws.close();
main.ws.close();
killApp();
await sleep(700);
launchApp();
({ settings, main } = await attach());
await sleep(500);
await waitReady();
const restarted = await collect();
check("accent survives a full process restart on the first frame", restarted.accentAttr === "custom" && restarted.userAccent === "#d96c95", JSON.stringify({ attr: restarted.accentAttr, accent: restarted.userAccent }));


// ── ⑧ picker ownership + skin defaults ────────────────────────────────────
/** Resolve the live skin tokens the palette renders from. */
const palette = () => settings.evalJs(`(() => {
  const root = document.documentElement;
  const host = document.querySelector('.settings');
  const read = (token) => {
    const probe = document.createElement('span');
    probe.style.display = 'none';
    probe.style.color = getComputedStyle(host).getPropertyValue(token).trim();
    document.body.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  };
  const hex = (rgb) => {
    const parts = rgb.match(/[0-9]+/g);
    return parts && parts.length >= 3
      ? '#' + parts.slice(0, 3).map((part) => Number(part).toString(16).padStart(2, '0')).join('')
      : rgb;
  };
  return {
    skin: root.dataset.settingsSkin,
    theme: root.dataset.theme,
    structure: hex(read('--settings-structure')),
    options: Array.from(document.querySelectorAll('.settings-accent-option')).map((el) => el.dataset.accentValue),
    labels: Array.from(document.querySelectorAll('.settings-accent-option')).map((el) => el.textContent.trim()),
    custom: document.querySelector('.settings-accent-input')?.value ?? '',
    defaultSwatch: hex((() => {
      const swatch = document.querySelector('.settings-accent-option[data-accent-value="default"] .settings-accent-swatch');
      return swatch ? getComputedStyle(swatch).backgroundColor : '';
    })()),
    defaultLabel: document.querySelector('.settings-accent-option[data-accent-value="default"]')?.textContent.trim() ?? '',
  };
})()`);

await setAppearance("quiet", "dark", "#3fb98b", "#abcdef");
await go("appearance");
const keptPicker = await palette();
check("custom picker shows the remembered color, not the applied preset", keptPicker.custom === "#abcdef" && keptPicker.structure === "#3fb98b", JSON.stringify({ custom: keptPicker.custom, structure: keptPicker.structure }));
await settings.evalJs(`document.querySelector('.settings-accent-option[data-accent-value="#6f7cff"]')?.click(); true`);
await sleep(550);
const afterPreset = await palette();
const afterPresetSaved = await getSaved();
check("picking a preset leaves the remembered custom color untouched", afterPreset.custom === "#abcdef" && afterPresetSaved.appearance.settings_accent === "#6f7cff" && afterPresetSaved.appearance.settings_accent_custom === "#abcdef", JSON.stringify({ custom: afterPreset.custom, saved: afterPresetSaved.appearance.settings_accent, savedCustom: afterPresetSaved.appearance.settings_accent_custom }));

await setAppearance("quiet", "dark", "", "");
await go("appearance");
const quietDefault = await palette();
check("an empty remembered color falls back to pure white", quietDefault.custom === "#ffffff" && quietDefault.structure === "#5ac8fa", JSON.stringify({ custom: quietDefault.custom, structure: quietDefault.structure }));

await setAppearance("chromatic", "dark", "", "");
await go("appearance");
const chromaticDark = await palette();
check("chromatic dark follows 湖蓝 and leads its palette with the skin's original color", chromaticDark.structure === "#5ac8fa" && chromaticDark.options[1] === "#ac8e97" && !chromaticDark.options.includes("#5ac8fa"), JSON.stringify({ structure: chromaticDark.structure, options: chromaticDark.options }));
check("chromatic dark keeps that color as a labeled preset", /浅粉|淺粉|Blush/.test(chromaticDark.labels[1] ?? ''), JSON.stringify(chromaticDark.labels));
check("chromatic dark's picker default is pure white too", chromaticDark.custom === "#ffffff", chromaticDark.custom);
await showAccent();
await settings.shot("chromatic-dark-default");

await setAppearance("chromatic", "light", "", "");
await go("appearance");
const chromaticLight = await palette();
check("chromatic light keeps its mineral green default", chromaticLight.structure === "#64796d" && chromaticLight.options[1] === "#ac8e97", JSON.stringify({ structure: chromaticLight.structure, options: chromaticLight.options }));

// The 默认 option keeps the skin's own color on its swatch while another
// accent is in use, and still clears the override when clicked.
await setAppearance("quiet", "dark", "#6f7cff", "");
await go("appearance");
const fixedSwatch = await palette();
check("the 默认 swatch stays on the skin default while a preset is applied", fixedSwatch.defaultSwatch === "#5ac8fa" && fixedSwatch.options[0] === "default", JSON.stringify({ swatch: fixedSwatch.defaultSwatch, options: fixedSwatch.options }));
check("the first option is labeled 默认", /默认|預設|Default/.test(fixedSwatch.defaultLabel), fixedSwatch.defaultLabel);
await settings.evalJs(`document.querySelector('.settings-accent-option[data-accent-value="default"]')?.click(); true`);
await sleep(550);
const cleared = await collect();
check("clicking 默认 clears the override again", cleared.accentAttr === undefined && cleared.checked === "default" && cleared.userAccent === "", JSON.stringify({ attr: cleared.accentAttr, checked: cleared.checked }));

// Clicking the custom entry applies its stored color straight away.
await setAppearance("quiet", "dark", "", "#abcdef");
await go("appearance");
await settings.evalJs(`document.querySelector('.settings-accent-custom-apply')?.click(); true`);
await sleep(550);
const appliedCustom = await collect();
const appliedCustomSaved = await getSaved();
check("clicking the custom entry applies the remembered color", appliedCustom.accentAttr === "custom" && appliedCustom.userAccent === "#abcdef" && appliedCustomSaved.appearance.settings_accent === "#abcdef", JSON.stringify({ accent: appliedCustom.userAccent, saved: appliedCustomSaved.appearance.settings_accent }));

// …and pure white when nothing was stored yet.
await setAppearance("quiet", "dark", "", "");
await go("appearance");
await settings.evalJs(`document.querySelector('.settings-accent-custom-apply')?.click(); true`);
await sleep(550);
const appliedWhite = await collect();
const appliedWhiteSaved = await getSaved();
check("clicking the custom entry with nothing stored applies pure white", appliedWhite.accentAttr === "custom" && appliedWhite.userAccent === "#ffffff" && appliedWhiteSaved.appearance.settings_accent === "#ffffff" && appliedWhiteSaved.appearance.settings_accent_custom === "#ffffff", JSON.stringify({ accent: appliedWhite.userAccent, saved: appliedWhiteSaved.appearance.settings_accent, savedCustom: appliedWhiteSaved.appearance.settings_accent_custom }));

console.log(`\n[settings-accent] ${pass} passed, ${fail} failed`);
killApp();
process.exit(fail === 0 ? 0 : 1);
