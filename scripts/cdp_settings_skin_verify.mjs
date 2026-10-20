// Settings redesign + skin-switch regression. Build first:
//   pnpm run build && pnpm run tauri build --debug --no-bundle
// Run:
//   node scripts/cdp_settings_skin_verify.mjs
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PORT = 9262;
const BASE = "src-tauri/target/debug";
const APP = `${BASE}/lume.exe`;
const OUT = "test/settings-skin-verify";
const SETTINGS_TOML = resolve(BASE, "settings/settings.toml");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (ok) pass++;
  else fail++;
};

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(350);
mkdirSync(OUT, { recursive: true });
cpSync("examples/plugins/notes", `${BASE}/plugins/notes`, { recursive: true, force: true });
const log = openSync(`${OUT}/lume.log`, "w");
spawn(APP, [], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: ["ignore", log, log],
});

async function targets() {
  for (let i = 0; i < 80; i++) {
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

let mainTarget = null;
let settings = null;
for (let attempt = 0; attempt < 80 && (!settings || !mainTarget); attempt++) {
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
      }
      else client.ws.close();
    } catch {}
  }
  if (!settings || !mainTarget) await sleep(200);
}
if (!settings || !mainTarget) throw new Error("main/settings targets missing");
const main = await connect(mainTarget.webSocketDebuggerUrl);
await main.evalJs(`window.__TAURI_INTERNALS__.invoke('open_settings').then(() => true)`);
for (let i = 0; i < 40; i++) {
  if (await settings.evalJs(`!!document.querySelector('.settings-page-content')`)) break;
  await sleep(150);
}

const waitReady = async () => {
  for (let i = 0; i < 40; i++) {
    if (await settings.evalJs(`!!document.querySelector('.settings-page-content')`)) return;
    await sleep(150);
  }
  throw new Error("settings did not become ready");
};
const reloadSettings = async () => {
  await settings.evalJs(`location.reload(); true`).catch(() => undefined);
  await sleep(700);
  await waitReady();
};
const setAppearance = async (skin, colorMode) => {
  await settings.evalJs(`window.__TAURI_INTERNALS__.invoke('save_settings_patch', { patch: {
    appearance: { settings_skin: '${skin}', color_mode: '${colorMode}' }
  }}).then(() => true)`);
  await reloadSettings();
};
const clickSkin = async (skin) => {
  await settings.evalJs(`(() => {
    const row = document.querySelector('[data-setting-id="appearance.settings_skin"]');
    const radio = row?.querySelector('[role="radio"][data-skin="${skin}"], [role="radio"][aria-checked]');
    const choices = row ? Array.from(row.querySelectorAll('[role="radio"]')) : [];
    const target = choices.find((el) => el.textContent.toLowerCase().includes('${skin}'));
    target?.focus();
    target?.click();
    return !!target;
  })()`);
  await sleep(600);
};
const go = async (section) => {
  await settings.evalJs(`document.querySelector('.settings-nav[data-section="${section}"]')?.click(); true`);
  await sleep(180);
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

await setAppearance("quiet", "dark");
await go("appearance");
const initial = await settings.evalJs(`({
  skin: document.documentElement.dataset.settingsSkin,
  theme: document.documentElement.dataset.theme,
  nav: Array.from(document.querySelectorAll('.settings-nav')).map((el) => el.dataset.section),
  saveButtons: Array.from(document.querySelectorAll('.settings-footer button')).filter((el) => el.textContent.includes('保存并应用')).length,
  status: document.querySelector('.settings-save-status')?.textContent.trim(),
  pageRadius: getComputedStyle(document.querySelector('.settings-group-panel')).borderRadius,
  pageNumber: getComputedStyle(document.querySelector('.settings-page-number')).display,
})`);
check("settings opens with Quiet + dark theme", initial.skin === "quiet" && initial.theme === "dark");
check("grouped nav keeps the nine-section order", JSON.stringify(initial.nav) === JSON.stringify(["appearance", "launcher", "clipboard", "search", "hotkeys", "automation", "plugins", "system", "about"]), JSON.stringify(initial.nav));
check("global Save & Apply is gone", initial.saveButtons === 0);
check("status starts at All changes saved", initial.status?.includes("所有更改已自动保存"), initial.status);
check("Quiet has rounded panels and no page number", initial.pageRadius !== "0px" && initial.pageNumber === "none", JSON.stringify(initial));
const a11y = await settings.evalJs(`({
  lang: document.documentElement.lang,
  tabs: Array.from(document.querySelectorAll('.settings-nav')).map((tab) => ({
    role: tab.getAttribute('role'),
    controls: tab.getAttribute('aria-controls'),
  })),
  radios: Array.from(document.querySelectorAll('.settings-segmented [role="radio"], .settings-theme-grid [role="radio"]')).map((radio) => radio.getAttribute('aria-checked')),
  switches: Array.from(document.querySelectorAll('.settings-toggle')).map((toggle) => ({ role: toggle.getAttribute('role'), checked: toggle.getAttribute('aria-checked') })),
  help: Array.from(document.querySelectorAll('.settings-help-btn')).map((button) => button.getAttribute('aria-expanded')),
})`);
check("document language follows a supported locale", ["en", "zh-CN", "zh-TW"].includes(a11y.lang), a11y.lang);
check("navigation exposes tab/tabpanel relationships", a11y.tabs.every((tab) => tab.role === "tab" && tab.controls === "settings-active-panel"), JSON.stringify(a11y.tabs));
check("segmented controls expose radio checked state", a11y.radios.length > 0 && a11y.radios.every((value) => value === "true" || value === "false"), JSON.stringify(a11y.radios));
check("switches and help disclosures expose ARIA state", a11y.switches.every((item) => item.role === "switch" && (item.checked === "true" || item.checked === "false")) && a11y.help.every((value) => value === "true" || value === "false"), JSON.stringify({ switches: a11y.switches.length, help: a11y.help.length }));

const helpInteraction = await settings.evalJs(`(async () => {
  const button = document.querySelector('.settings-help-btn');
  const row = button.closest('.settings-setting-row');
  const before = row.getBoundingClientRect();
  button.dispatchEvent(new PointerEvent('pointerenter', { bubbles: false }));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const tooltip = document.querySelector('.settings-help-tooltip');
  const tooltipPositioned = tooltip ? getComputedStyle(tooltip).position : '';
  const during = row.getBoundingClientRect();
  button.click();
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const dialog = document.querySelector('.settings-help-dialog[role="dialog"]');
  const inert = !!document.querySelector('.settings[inert]');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  return {
    tooltip: !!tooltip,
    tooltipPositioned,
    reflow: Math.abs(during.height - before.height),
    dialog: !!dialog,
    inert,
    closed: !document.querySelector('.settings-help-dialog'),
    focusReturned: document.activeElement === button,
    inlineHelp: !!document.querySelector('.settings-help'),
  };
})()`);
check("help hover uses a fixed tooltip without reflowing the row", helpInteraction.tooltip && helpInteraction.tooltipPositioned === "fixed" && helpInteraction.reflow === 0 && !helpInteraction.inlineHelp, JSON.stringify(helpInteraction));
check("help click opens an inert modal and Escape restores focus", helpInteraction.dialog && helpInteraction.inert && helpInteraction.closed && helpInteraction.focusReturned, JSON.stringify(helpInteraction));
await settings.evalJs(`document.querySelector('.settings-help-btn')?.click(); true`);
await sleep(120);
await settings.shot("help-dialog");
await settings.evalJs(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(120);

await settings.evalJs(`document.querySelector('[data-setting-id="appearance.settings_skin"]').__stable = 42; document.querySelector('.settings-body').scrollTop = 24; true`);
await clickSkin("chromatic");
const switched = await settings.evalJs(`(async () => ({
  skin: document.documentElement.dataset.settingsSkin,
  focused: document.activeElement?.closest('[data-setting-id="appearance.settings_skin"]') !== null,
  stable: document.querySelector('[data-setting-id="appearance.settings_skin"]').__stable,
  scroll: document.querySelector('.settings-body').scrollTop,
  saved: (await window.__TAURI_INTERNALS__.invoke('get_settings')).appearance.settings_skin,
  radius: getComputedStyle(document.querySelector('.settings-group-panel')).borderRadius,
  pageNumber: getComputedStyle(document.querySelector('.settings-page-number')).display,
  border: getComputedStyle(document.querySelector('.settings-group-panel')).borderLeftWidth,
  lineWidth: getComputedStyle(document.querySelector('.settings')).getPropertyValue('--settings-line-width').trim(),
}))()`);
check("skin switch updates data-settings-skin immediately", switched.skin === "chromatic");
check("skin switch keeps focus on the same control", switched.focused === true);
check("skin switch does not rebuild the pane", switched.stable === 42);
check("skin switch preserves scroll position", switched.scroll === 24, String(switched.scroll));
check("skin persists through autosave", switched.saved === "chromatic", String(switched.saved));
check("Chromatic uses square 1.5px panels and a page number", switched.radius === "0px" && switched.lineWidth === "1.5px" && switched.pageNumber !== "none", JSON.stringify(switched));
await settings.shot("chromatic-appearance");

const combo = async (skin, mode, expectedBg) => {
  await setAppearance(skin, mode);
  const state = await settings.evalJs(`({
    skin: document.documentElement.dataset.settingsSkin,
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.querySelector('.settings')).backgroundColor,
  })`);
  check(`${skin} × ${mode} applies`, state.skin === skin && state.theme === mode && state.bg === expectedBg, JSON.stringify(state));
};
await combo("quiet", "dark", "rgb(25, 26, 29)");
await combo("quiet", "light", "rgb(245, 246, 248)");
await combo("chromatic", "dark", "rgb(30, 30, 32)");
await combo("chromatic", "light", "rgb(243, 239, 230)");
const systemCombo = async (skin, darkBg, lightBg) => {
  await setAppearance(skin, "system");
  const state = await settings.evalJs(`({
    skin: document.documentElement.dataset.settingsSkin,
    theme: document.documentElement.dataset.theme,
    bg: getComputedStyle(document.querySelector('.settings')).backgroundColor,
  })`);
  check(
    `${skin} × system follows the resolved OS mode`,
    state.skin === skin && (state.theme === "light" || state.theme === "dark") && state.bg === (state.theme === "light" ? lightBg : darkBg),
    JSON.stringify(state),
  );
};
await systemCombo("quiet", "rgb(25, 26, 29)", "rgb(245, 246, 248)");
await systemCombo("chromatic", "rgb(30, 30, 32)", "rgb(243, 239, 230)");

await go("launcher");
const positionPreview = await settings.evalJs(`(() => {
  const grid = document.querySelector('.settings-position-grid');
  const cells = Array.from(document.querySelectorAll('.settings-position-cell'));
  const marks = cells.map((cell) => cell.querySelector('span').getBoundingClientRect());
  const active = document.querySelector('.settings-position-cell.active span');
  return {
    count: cells.length,
    markSizes: marks.map((r) => [Math.round(r.width), Math.round(r.height)]),
    activeBorder: active ? getComputedStyle(active).borderTopColor : '',
    gridBackground: getComputedStyle(grid).backgroundColor,
  };
})()`);
check("window-position presets use large visible marks in every slot", positionPreview.count === 5 && positionPreview.markSizes.every(([w, h]) => w >= 20 && h >= 12) && !!positionPreview.activeBorder, JSON.stringify(positionPreview));
await settings.shot("launcher-position");

await go("search");
const indexHints = await settings.evalJs(`Array.from(document.querySelectorAll('[data-setting-id^="index.system_dirs."] .settings-row-summary')).map((el) => el.textContent.trim())`);
check("system index rows explain Desktop, System32, and Start Menu separately", indexHints.length === 3 && new Set(indexHints).size === 3, JSON.stringify(indexHints));

await go("automation");
await sleep(300);
const switchGeometry = await settings.evalJs(`(() => {
  const toggles = Array.from(document.querySelectorAll('.settings-toggle'));
  const measure = (toggle) => {
    const box = toggle.getBoundingClientRect();
    const knob = toggle.querySelector('.settings-toggle-knob').getBoundingClientRect();
    return { left: knob.left - box.left, top: knob.top - box.top, width: knob.width, height: knob.height, boxWidth: box.width, boxHeight: box.height };
  };
  const on = toggles.find((toggle) => toggle.classList.contains('on'));
  const off = toggles.find((toggle) => !toggle.classList.contains('on'));
  return { on: on ? measure(on) : null, off: off ? measure(off) : null };
})()`);
const near = (value, expected) => Math.abs(value - expected) <= 1;
check("switches keep their knobs centered inside the track in both states", !!switchGeometry.on && !!switchGeometry.off && near(switchGeometry.off.left, 6) && near(switchGeometry.on.left, 22) && near(switchGeometry.off.top, 10) && near(switchGeometry.on.top, 10) && near(switchGeometry.on.width, 16) && near(switchGeometry.on.height, 16), JSON.stringify(switchGeometry));
await settings.shot("automation-switches");

await go("plugins");
await sleep(500);
const pluginLayout = await settings.evalJs(`(() => {
  const master = document.querySelector('.plg-master-detail');
  const list = document.querySelector('.plg-list');
  const detail = document.querySelector('.plg-detail-pane');
  const m = master?.getBoundingClientRect();
  const l = list?.getBoundingClientRect();
  return {
    masterHeight: Math.round(m?.height ?? 0),
    listHeight: Math.round(l?.height ?? 0),
    listOverflow: list ? getComputedStyle(list).overflowY : '',
    detailOverflow: detail ? getComputedStyle(detail).overflowY : '',
    columns: master ? getComputedStyle(master).gridTemplateColumns : '',
  };
})()`);
check("plugin list and detail scroll independently inside the master-detail frame", pluginLayout.masterHeight > 300 && Math.abs(pluginLayout.listHeight - pluginLayout.masterHeight) <= 4 && pluginLayout.listOverflow === "auto" && pluginLayout.detailOverflow === "auto" && pluginLayout.columns.split(" ").length >= 2, JSON.stringify(pluginLayout));
await settings.shot("plugins-master-detail");

await go("appearance");
await typeSearch("设置窗皮肤");
const search = await settings.evalJs(`({
  count: document.querySelectorAll('.settings-search-result').length,
  labels: Array.from(document.querySelectorAll('.settings-result-label')).map((el) => el.textContent),
  expanded: document.querySelector('.settings-search-input').getAttribute('aria-expanded'),
})`);
check("catalog search finds the skin setting once", search.count === 1 && search.labels.some((label) => label.includes("设置窗皮肤")), JSON.stringify(search));
await settings.evalJs(`document.querySelector('.settings-search-result').click(); true`);
await sleep(300);
const jumped = await settings.evalJs(`({
  query: document.querySelector('.settings-search-input').value,
  active: document.querySelector('.settings-nav.active')?.dataset.section,
  focused: document.activeElement?.getAttribute('data-setting-id'),
  highlighted: document.querySelector('[data-setting-id="appearance.settings_skin"]')?.classList.contains('settings-jump-highlight'),
})`);
check("search result jumps to the exact row and focuses it", jumped.query === "" && jumped.active === "appearance" && jumped.focused === "appearance.settings_skin" && jumped.highlighted === true, JSON.stringify(jumped));

await go("plugins");
await sleep(500);
await typeSearch("列表前缀");
const pluginResult = await settings.evalJs(`Array.from(document.querySelectorAll('.settings-result-label')).map((el) => el.textContent)`);
check("dynamic plugin setting is searchable", pluginResult.some((label) => label.includes("列表前缀")), JSON.stringify(pluginResult));
await settings.evalJs(`Array.from(document.querySelectorAll('.settings-search-result')).find((el) => el.textContent.includes('列表前缀'))?.click(); true`);
await sleep(900);
const pluginJump = await settings.evalJs(`({
  active: document.querySelector('.settings-nav.active')?.dataset.section,
  focused: document.activeElement?.getAttribute('data-setting-id'),
  detail: !!document.querySelector('.plg-master-detail.has-selection'),
})`);
check("plugin search opens the detail row", pluginJump.active === "plugins" && pluginJump.focused === "plugin.notes.setting.prefix" && pluginJump.detail, JSON.stringify(pluginJump));

await go("appearance");
await setAppearance("chromatic", "dark");
let readOnlySet = false;
try {
  execSync(`attrib +R "${SETTINGS_TOML}"`, { stdio: "ignore" });
  readOnlySet = true;
} catch {}
check("settings.toml can be made read-only for failure simulation", readOnlySet, SETTINGS_TOML);
await clickSkin("quiet");
const failed = await settings.evalJs(`({
  skin: document.documentElement.dataset.settingsSkin,
  state: document.documentElement.dataset.settingsSaveState,
  inline: document.querySelector('[data-setting-id="appearance.settings_skin"] .settings-inline-error')?.textContent,
  retry: document.querySelector('.settings-retry-status')?.textContent,
})`);
check("failed save rolls the skin and DOM back together", failed.skin === "chromatic" && failed.state === "error", JSON.stringify(failed));
check("failed skin save is shown inline and in the status bar", !!failed.inline && failed.retry?.includes("重试"), JSON.stringify(failed));
execSync(`attrib -R "${SETTINGS_TOML}"`, { stdio: "ignore" });
await settings.evalJs(`document.querySelector('.settings-retry-status')?.click(); true`);
await sleep(700);
const retried = await settings.evalJs(`({ skin: document.documentElement.dataset.settingsSkin, state: document.documentElement.dataset.settingsSaveState })`);
check("retry re-applies and saves the failed skin", retried.skin === "quiet" && retried.state === "saved", JSON.stringify(retried));
const undoBefore = await settings.evalJs(`Array.from(document.querySelectorAll('.settings-footer-action')).find((el) => el.textContent.includes('撤销'))?.textContent ?? ''`);
await settings.evalJs(`Array.from(document.querySelectorAll('.settings-footer-action')).find((el) => el.textContent.includes('撤销'))?.click(); true`);
await sleep(500);
const undone = await settings.evalJs(`({ skin: document.documentElement.dataset.settingsSkin, state: document.documentElement.dataset.settingsSaveState })`);
check("successful autosave exposes a six-second undo", undoBefore.includes("撤销"), undoBefore);
check("undo submits the inverse skin through autosave", undone.skin === "chromatic" && undone.state === "saved", JSON.stringify(undone));

await settings.evalJs(`Array.from(document.querySelectorAll('.settings-footer-action')).find((el) => el.textContent.includes('恢复应用默认值'))?.click(); true`);
await sleep(120);
const dialog = await settings.evalJs(`({ open: !!document.querySelector('.settings-confirm[role="dialog"]'), title: document.querySelector('.settings-confirm-title')?.textContent })`);
check("restore defaults uses a real confirmation dialog", dialog.open && dialog.title?.includes("默认值"), JSON.stringify(dialog));
await settings.evalJs(`document.querySelector('.settings-confirm-actions .settings-action:not(.settings-action-primary)')?.click(); true`);
await sleep(120);

await settings.send("Emulation.setDeviceMetricsOverride", {
  width: 560, height: 420, deviceScaleFactor: 1, mobile: false,
});
await sleep(250);
for (const skin of ["quiet", "chromatic"]) {
  await setAppearance(skin, "dark");
  for (const section of ["appearance", "launcher", "clipboard", "search", "hotkeys", "automation", "plugins", "system", "about"]) {
    await go(section);
    const sizes = await settings.evalJs(`({
      doc: document.documentElement.scrollWidth,
      viewport: innerWidth,
      main: document.querySelector('.settings-main').scrollWidth,
      mainClient: document.querySelector('.settings-main').clientWidth,
      body: document.querySelector('.settings-body').scrollWidth,
      bodyClient: document.querySelector('.settings-body').clientWidth,
    })`);
    check(`560×420 ${skin} ${section} has no horizontal overflow`, sizes.doc <= sizes.viewport + 1 && sizes.main <= sizes.mainClient + 1 && sizes.body <= sizes.bodyClient + 1, JSON.stringify(sizes));
  }
  const navFit = await settings.evalJs(`(() => {
    const navs = Array.from(document.querySelectorAll('.settings-nav'));
    const last = navs[navs.length - 1]?.getBoundingClientRect();
    const band = document.querySelector('.settings-main')?.getBoundingClientRect();
    const sidebar = document.querySelector('.settings-sidebar');
    const pageNumber = document.querySelector('.settings-page-number');
    return {
      lastBottom: last?.bottom ?? 0,
      bandBottom: band?.bottom ?? 0,
      sidebarClient: sidebar?.clientHeight ?? 0,
      sidebarScroll: sidebar?.scrollHeight ?? 0,
      pageNumber: pageNumber ? getComputedStyle(pageNumber).display : 'none',
    };
  })()`);
  check(
    `560×420 ${skin} keeps navigation above the footer and hides page numbers`,
    navFit.lastBottom <= navFit.bandBottom + 1 && navFit.sidebarScroll <= navFit.sidebarClient + 1 && navFit.pageNumber === "none",
    JSON.stringify(navFit),
  );
}
await settings.shot("narrow-about");
await settings.send("Emulation.clearDeviceMetricsOverride", {});
await setAppearance("quiet", "dark");

console.log(`\n[settings-skin] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
