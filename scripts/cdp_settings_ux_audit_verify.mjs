// Settings UX audit regression (docs/UX_SETTINGS_AUDIT_2026-10-18.md).
// Usage: pnpm run tauri build --debug --no-bundle
//        node scripts/cdp_settings_ux_audit_verify.mjs
import { spawn, execSync } from "node:child_process";
import { cpSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "src-tauri/target/debug";
const APP = `${BASE}/lume.exe`;
const PORT = 9253;
const OUT = "test/settings-ux-audit-fix";
const TMP_INDEX = resolve(OUT, "index-dir");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
let minIconHeight = Infinity;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (ok) pass++;
  else fail++;
};

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(400);
mkdirSync(`${OUT}/shots`, { recursive: true });
mkdirSync(TMP_INDEX, { recursive: true });
// The declarative-settings search assertion needs a disk plugin fixture.
cpSync("examples/plugins/notes", `${BASE}/plugins/notes`, { recursive: true, force: true });

const logFd = openSync(`${OUT}/lume.log`, "w");
const app = spawn(APP, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: ["ignore", logFd, logFd],
});

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    } catch {
      await sleep(250);
    }
  }
  throw new Error("CDP unavailable");
}

async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  const send = (method, params) =>
    new Promise((res) => {
      const key = ++id;
      pending.set(key, res);
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
    writeFileSync(`${OUT}/shots/${name}.png`, Buffer.from(image.result.data, "base64"));
  };
  return { ws, send, evalJs, shot };
}

async function findSettings() {
  for (let i = 0; i < 40; i++) {
    const pages = (await targets()).filter(
      (t) => t.type === "page" && t.url.includes("tauri.localhost"),
    );
    let mainPage = null;
    let settingsPage = null;
    for (const page of pages) {
      try {
        const client = await connect(page.webSocketDebuggerUrl);
        const kind = await client.evalJs(`(
          document.body.classList.contains('settings-window')
            ? 'settings'
            : document.querySelector('#search-input')
              ? 'main'
              : ''
        )`);
        if (kind === "settings") {
          if (!settingsPage) settingsPage = { page, client };
          else client.ws.close();
        } else if (kind === "main") {
          mainPage ??= page;
          client.ws.close();
        } else {
          client.ws.close();
        }
      } catch {}
    }
    if (settingsPage && mainPage) {
      return { settings: settingsPage.client, mainPage };
    }
    settingsPage?.client.ws.close();
    await sleep(300);
  }
  return null;
}

let settings;
let main;
let originalPluginState = null;
try {
  const found = await findSettings();
  if (!found) throw new Error("settings target missing");
  settings = found.settings;
  const mainTarget = found.mainPage;
  if (!mainTarget) throw new Error("main target missing");
  main = await connect(mainTarget.webSocketDebuggerUrl);
  await main.evalJs(`window.__TAURI_INTERNALS__.invoke("open_settings").then(() => true)`);

  for (let i = 0; i < 40; i++) {
    const ready = await settings.evalJs(
      `!!document.querySelector('.settings-nav') && !!document.querySelector('.settings-search-input')`,
    );
    if (ready) break;
    await sleep(250);
  }

  const goSection = async (section) => {
    await settings.evalJs(`(() => {
      const nav = document.querySelector('.settings-nav[data-section="${section}"]');
      nav?.click();
      return !!nav;
    })()`);
    for (let i = 0; i < 20; i++) {
      const active = await settings.evalJs(
        `document.querySelector('.settings-nav.active')?.getAttribute('data-section') ?? ''`,
      );
      if (active === section) return;
      await sleep(50);
    }
  };
  originalPluginState = await settings.evalJs(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => ({ dev: s.plugins.dev_mode === true, trust: s.plugins.trust_all === true }))`,
  );

  const baseA11y = await settings.evalJs(`({
    lang: document.documentElement.lang,
    tabpanel: document.querySelector('#settings-active-panel')?.getAttribute('role'),
    tabs: Array.from(document.querySelectorAll('.settings-nav')).map((t) => ({
      role: t.getAttribute('role'),
      controls: t.getAttribute('aria-controls'),
      tabindex: t.tabIndex,
    })),
    chips: Array.from(document.querySelectorAll('.settings-chip')).map((c) => c.getAttribute('aria-pressed')),
  })`);
  check("document language is a supported locale", ["en", "zh-CN", "zh-TW"].includes(baseA11y.lang), baseA11y.lang);
  check("settings has a tabpanel and tabs control it",
    baseA11y.tabpanel === "tabpanel" && baseA11y.tabs.every((t) => t.role === "tab" && t.controls === "settings-active-panel"));
  check("option chips expose aria-pressed", baseA11y.chips.length > 0 && baseA11y.chips.every((v) => v === "true" || v === "false"));

  const arrowNav = await settings.evalJs(`(() => {
    const first = document.querySelector('.settings-nav');
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(100);
  const focusedTab = await settings.evalJs(`document.activeElement?.id ?? ""`);
  check("tablist arrow navigation moves focus", arrowNav && focusedTab === "settings-tab-launcher", focusedTab);

  // Dirty status is a real baseline diff: dark → system must disable Save.
  await goSection("appearance");
  const dirtyRevert = await settings.evalJs(`(() => {
    const color = document.querySelectorAll('.settings-row-chips')[1];
    const chips = color.querySelectorAll('.settings-chip');
    const original = Array.from(chips).findIndex((c) => c.classList.contains('active'));
    const changed = original === 0 ? 1 : 0;
    chips[changed].click();
    chips[original].click();
    return { original, changed };
  })()`);
  await sleep(150);
  const saveDisabled = await settings.evalJs(
    `document.querySelector('.settings-footer .settings-action-primary').disabled`,
  );
  check("reverting a draft clears dirty/save", saveDisabled === true, JSON.stringify(dirtyRevert));

  // Force a deterministic Chinese UI through the live-preview language chip.
  await settings.evalJs(`(() => {
    const chips = document.querySelectorAll('.settings-row-chips .settings-chip');
    chips[2]?.click();
    return true;
  })()`);
  await sleep(400);
  const languageState = await settings.evalJs(`({
    lang: document.documentElement.lang,
    switches: Array.from(document.querySelectorAll('[role="switch"]')).map((s) => s.getAttribute('aria-label')),
  })`);
  check("document language follows active locale", languageState.lang === "zh-CN", languageState.lang);

  await goSection("launcher");
  const switchNames = await settings.evalJs(
    `Array.from(document.querySelectorAll('[role="switch"]')).map((s) => s.getAttribute('aria-label'))`,
  );
  check("switches have accessible names", switchNames.length > 0 && switchNames.every(Boolean), JSON.stringify(switchNames));
  const customNumber = await settings.evalJs(`(() => {
    const more = document.querySelector('.settings-chip-more');
    more?.click();
    return { more: !!more, input: !!document.querySelector('.settings-number-input') };
  })()`);
  check("numeric presets expose a free-form value", customNumber.more && customNumber.input, JSON.stringify(customNumber));
  await goSection("appearance");

  // Create a draft, then verify modal focus, inert background, Tab trap, Esc.
  await settings.evalJs(`(() => {
    const color = document.querySelectorAll('.settings-row-chips')[1];
    const chips = color.querySelectorAll('.settings-chip');
    const active = Array.from(chips).findIndex((c) => c.classList.contains('active'));
    chips[active === 0 ? 1 : 0].click();
    document.querySelector('.titlebar-close').click();
    return true;
  })()`);
  await sleep(200);
  const modalState = await settings.evalJs(`(() => {
    const dialog = document.querySelector('.settings-confirm');
    const active = document.activeElement;
    const buttons = Array.from(dialog?.querySelectorAll('button:not(:disabled)') ?? []);
    return {
      open: !!dialog,
      focusInside: !!dialog && !!active && dialog.contains(active),
      inert: ['.settings-topbar', '.settings-content', '.settings-footer']
        .every((s) => document.querySelector(s)?.hasAttribute('inert')),
      buttons: buttons.map((b) => b.textContent.trim()),
    };
  })()`);
  check("confirm dialog takes focus", modalState.open && modalState.focusInside, JSON.stringify(modalState));
  check("confirm dialog makes background inert", modalState.inert);
  const tabTrap = await settings.evalJs(`(() => {
    const dialog = document.querySelector('.settings-confirm');
    const buttons = Array.from(dialog.querySelectorAll('button:not(:disabled)'));
    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    const back = document.activeElement === buttons[buttons.length - 1];
    buttons[buttons.length - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    return back && document.activeElement === buttons[0];
  })()`);
  check("confirm dialog traps Tab / Shift+Tab", tabTrap === true);
  await settings.evalJs(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
  await sleep(100);
  const modalClosed = await settings.evalJs(`({
    gone: !document.querySelector('.settings-confirm'),
    focusClose: document.activeElement?.classList.contains('titlebar-close') === true,
  })`);
  check("Esc closes confirm and returns focus", modalClosed.gone && modalClosed.focusClose, JSON.stringify(modalClosed));

  // Search the actual visible strings and a plugin-declared setting.
  const search = async (query) => {
    await settings.evalJs(`(() => {
      const input = document.querySelector('.settings-search-input');
      input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(400);
    return settings.evalJs(`({
      sections: Array.from(document.querySelectorAll('.settings-section')).map((s) => s.dataset.section),
      hit: document.querySelector('.settings-search-hit')?.textContent?.trim() ?? '',
    })`);
  };
  const posSearch = await search("居中");
  check("search finds visible position labels", posSearch.sections.includes("launcher") && posSearch.hit.includes("居中"), JSON.stringify(posSearch));
  const mergeSearch = await search("合并窗口");
  check("search finds merge-window label", mergeSearch.sections.includes("clipboard") && mergeSearch.hit.includes("合并窗口"), JSON.stringify(mergeSearch));
  const indexSearch = await search("索引文件");
  check("search finds index-files label", indexSearch.sections.includes("search") && indexSearch.hit.includes("索引文件"), JSON.stringify(indexSearch));
  const pluginSearch = await search("列表前缀");
  const pluginHit = await settings.evalJs(`({
    sections: Array.from(document.querySelectorAll('.settings-section')).map((s) => s.dataset.section),
    openSetting: document.querySelector('.plg-card.open .plg-setting.search-hit')?.textContent?.trim() ?? '',
  })`);
  check("search finds plugin declarative settings", pluginHit.sections.includes("plugins") && pluginHit.openSetting.includes("列表前缀"), JSON.stringify(pluginHit));
  await search("");

  // Plugin card header is a keyboard-expandable control.
  await goSection("plugins");
  await sleep(500);
  const pluginHead = await settings.evalJs(`(() => {
    const head = document.querySelector('.plg-head');
    const before = { role: head?.getAttribute('role'), tab: head?.tabIndex, expanded: head?.getAttribute('aria-expanded'), controls: head?.getAttribute('aria-controls') };
    head?.focus();
    head?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return before;
  })()`);
  await sleep(200);
  const pluginOpened = await settings.evalJs(`({
    expanded: document.querySelector('.plg-head')?.getAttribute('aria-expanded'),
    detail: !!document.querySelector('.plg-card.open .plg-detail'),
  })`);
  check("plugin header is keyboard reachable and Enter expands",
    pluginHead.role === "button" && pluginHead.tab === 0 && pluginHead.controls && pluginOpened.expanded === "true" && pluginOpened.detail,
    JSON.stringify({ pluginHead, pluginOpened }));
  const pluginClosed = await settings.evalJs(`(() => {
    const head = document.querySelector('.plg-head');
    head.focus();
    head.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }));
    return head.getAttribute('aria-expanded');
  })()`);
  await sleep(100);
  check("Space collapses plugin header", pluginClosed === "false", pluginClosed);

  // Developer mode always clears the global trust escape hatch; re-enabling
  // developer mode requires a fresh explicit trust acknowledgement.
  await settings.evalJs(`(() => {
    const dev = document.querySelector('.plg-devmode .settings-toggle');
    if (dev?.classList.contains('on')) dev.click();
    return true;
  })()`);
  await sleep(500);
  await settings.evalJs(`document.querySelector('.plg-devmode .settings-toggle')?.click()`);
  await sleep(500);
  await settings.evalJs(`document.querySelectorAll('.plg-devmode .settings-toggle')[1]?.click()`);
  await sleep(500);
  const trustOn = await settings.evalJs(`({
    banner: !!document.querySelector('.settings-warning[role="alert"]'),
    checked: document.querySelectorAll('.plg-devmode .settings-toggle')[1]?.getAttribute('aria-checked'),
  })`);
  await settings.evalJs(`document.querySelector('.plg-devmode .settings-toggle')?.click()`);
  await sleep(600);
  const trustCleared = await settings.evalJs(
    `window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => ({ dev: s.plugins.dev_mode, trust: s.plugins.trust_all }))`,
  );
  check("trust-all is visible/flagged and cleared with developer mode",
    trustOn.banner && trustOn.checked === "true" && trustCleared.dev === false && trustCleared.trust === false,
    JSON.stringify({ trustOn, trustCleared }));

  // Single-key mode recorder and blur cancellation.
  await goSection("hotkeys");
  const hotkeyBlur = await settings.evalJs(`(() => {
    const btn = document.querySelectorAll('.settings-hotkey-btn')[1];
    btn.click();
    const recording = btn.textContent.trim();
    return { recording };
  })()`);
  await sleep(60);
  await settings.evalJs(`(() => {
    const search = document.querySelector('.settings-search-input');
    search.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    search.focus();
    return true;
  })()`);
  await sleep(100);
  const hotkeyBlurAfter = await settings.evalJs(`document.querySelectorAll('.settings-hotkey-btn')[1].textContent.trim()`);
  check("hotkey recording ends when focus/click moves away", hotkeyBlur.recording.includes("按下") && hotkeyBlurAfter !== hotkeyBlur.recording, JSON.stringify({ hotkeyBlur, hotkeyBlurAfter }));
  await settings.evalJs(`(() => {
    const btn = document.querySelectorAll('.settings-hotkey-btn')[1];
    btn.click();
    return true;
  })()`);
  await sleep(60);
  const singleKey = await settings.evalJs(`(() => {
    const btn = document.querySelectorAll('.settings-hotkey-btn')[1];
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(500);
  const singleKeyState = await settings.evalJs(`({
    text: document.querySelectorAll('.settings-hotkey-btn')[1].textContent.trim(),
    errors: Array.from(document.querySelectorAll('.settings-error')).map((e) => e.textContent.trim()),
  })`);
  check("mode switch accepts a bare key", singleKey && singleKeyState.text === "K" && singleKeyState.errors.length === 0, JSON.stringify(singleKeyState));

  // User-index validation: missing path, normalization and case-insensitive duplicate.
  await goSection("search");
  const addIndex = async (path) => {
    await settings.evalJs(`(() => {
      const row = document.querySelector('.settings-listadd');
      const input = row.querySelectorAll('input')[1];
      input.value = ${JSON.stringify(path)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      row.querySelectorAll('.settings-icon-btn')[1].click();
      return true;
    })()`);
    await sleep(300);
    return settings.evalJs(`({
      rows: document.querySelectorAll('.settings-listitem').length,
      error: Array.from(document.querySelectorAll('.settings-error')).map((e) => e.textContent.trim()).join(' | '),
    })`);
  };
  const beforeRows = await settings.evalJs(`document.querySelectorAll('.settings-listitem').length`);
  const invalid = await addIndex("Z:\\__lume_missing_index__");
  check("invalid index path is rejected inline", invalid.rows === beforeRows && invalid.error.includes("不存在"), JSON.stringify(invalid));
  const valid = await addIndex(TMP_INDEX.toUpperCase() + "\\");
  check("valid index path is normalized and added", valid.rows === beforeRows + 1, JSON.stringify(valid));
  const duplicate = await addIndex(TMP_INDEX.toLowerCase() + "\\");
  check("case-insensitive duplicate index path is rejected", duplicate.rows === beforeRows + 1 && duplicate.error.includes("已在列表"), JSON.stringify(duplicate));
  const indexIconHeights = await settings.evalJs(
    `Array.from(document.querySelectorAll('.settings-icon-btn')).map((b) => b.getBoundingClientRect().height)`,
  );
  minIconHeight = Math.min(...indexIconHeights);

  const refreshStart = await settings.evalJs(`(() => {
    const btn = document.querySelector('.settings-title-row .settings-icon-btn');
    btn.click();
    return { disabled: btn.disabled, busy: btn.getAttribute('aria-busy') };
  })()`);
  check("index refresh enters busy state before completion", refreshStart.disabled === true && refreshStart.busy === "true", JSON.stringify(refreshStart));
  for (let i = 0; i < 80; i++) {
    const done = await settings.evalJs(`document.querySelector('.settings-title-row .settings-icon-btn')?.getAttribute('aria-busy') === 'false'`);
    if (done) break;
    await sleep(250);
  }
  const refreshDone = await settings.evalJs(`({
    busy: document.querySelector('.settings-title-row .settings-icon-btn')?.getAttribute('aria-busy'),
    status: Array.from(document.querySelectorAll('.settings-status')).map((s) => s.textContent.trim()).join(' | '),
  })`);
  check("index refresh reports success only after completion", refreshDone.busy === "false" && refreshDone.status.includes("已刷新"), JSON.stringify(refreshDone));

  // Automation dependency, duplicate feedback, and delay inline validation.
  await goSection("automation");
  const residentDependency = await settings.evalJs(`(() => {
    const switches = Array.from(document.querySelectorAll('[role="switch"]'));
    const useAgent = switches.find((s) => s.getAttribute('aria-label')?.includes("使用提权代理"));
    const resident = switches.find((s) => s.getAttribute('aria-label')?.includes("登录后常驻代理"));
    const wasOn = useAgent?.classList.contains('on');
    if (wasOn) useAgent.click();
    return { wasOn, disabled: resident?.disabled };
  })()`);
  await sleep(100);
  const residentDisabled = await settings.evalJs(`(() => {
    const s = Array.from(document.querySelectorAll('[role="switch"]')).find((x) => x.getAttribute('aria-label')?.includes("登录后常驻代理"));
    return s?.disabled;
  })()`);
  check("resident agent is disabled without use-agent", residentDependency.wasOn === true && residentDisabled === true, JSON.stringify({ residentDependency, residentDisabled }));
  await settings.evalJs(`(() => {
    const s = Array.from(document.querySelectorAll('[role="switch"]')).find((x) => x.getAttribute('aria-label')?.includes("使用提权代理"));
    if (s && !s.classList.contains('on')) s.click();
    return true;
  })()`);

  const addRule = async (process) => {
    await settings.evalJs(`(() => {
      const row = document.querySelector('.settings-listadd');
      const input = row.querySelector('input[type="text"]');
      input.value = ${JSON.stringify(process)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rec = row.querySelector('.settings-hotkey-btn');
      rec.click();
      return true;
    })()`);
    await sleep(80);
    await settings.evalJs(`(() => {
      const rec = document.querySelector('.settings-listadd .settings-hotkey-btn');
      rec.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(500);
    const recorded = await settings.evalJs(`(() => {
      const row = document.querySelector('.settings-listadd');
      return {
        combo: row.querySelector('.settings-hotkey-btn')?.textContent.trim() ?? '',
        addDisabled: row.querySelector('.settings-icon-btn[aria-label]')?.disabled,
      };
    })()`);
    await settings.evalJs(`document.querySelector('.settings-listadd .settings-icon-btn[aria-label]')?.click()`);
    await sleep(250);
    const result = await settings.evalJs(`({
      rows: document.querySelectorAll('.settings-automation-row').length,
      alert: document.querySelector('.settings-automation-error')?.textContent?.trim() ?? '',
    })`);
    return { ...result, recorded };
  };
  const uniqueProcess = `notepad-ux-${Date.now()}.exe`;
  const rule1 = await addRule(uniqueProcess);
  const rule2 = await addRule(uniqueProcess.toUpperCase());
  check("duplicate automation rule is explained", rule1.rows >= 1 && rule2.rows === rule1.rows && rule2.alert.includes("已存在"), JSON.stringify({ rule1, rule2 }));
  const delayInvalid = await settings.evalJs(`(() => {
    const input = document.querySelector('.settings-listadd .settings-delay-input');
    input.focus();
    input.value = "";
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return true;
  })()`);
  await sleep(100);
  const delayError = await settings.evalJs(`Array.from(document.querySelectorAll('.settings-error')).some((e) => e.textContent.includes("60000"))`);
  check("empty automation delay validates on blur", delayInvalid && delayError === true);

  // Clipboard ignored-app picker + duplicate normalization.
  await goSection("clipboard");
  const clipPicker = await settings.evalJs(`!!document.querySelector('.settings-listadd .settings-pick-btn')`);
  check("clipboard ignore editor exposes a running-app picker", clipPicker === true);
  const addIgnore = async (name) => {
    await settings.evalJs(`(() => {
      const row = document.querySelector('.settings-listadd');
      const input = row.querySelector('input');
      input.value = ${JSON.stringify(name)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      row.querySelector('.settings-icon-btn[aria-label]').click();
      return true;
    })()`);
    await sleep(150);
    return settings.evalJs(`({
      rows: document.querySelectorAll('.settings-listrow').length,
      error: Array.from(document.querySelectorAll('.settings-error')).map((e) => e.textContent.trim()).join(' | '),
    })`);
  };
  const ignore1 = await addIgnore("Chrome");
  const ignore2 = await addIgnore("chrome.exe");
  check("ignored app duplicate is reported after executable normalization", ignore2.rows === ignore1.rows && ignore2.error.includes("忽略列表"), JSON.stringify({ ignore1, ignore2 }));

  // Click targets and immediate-effect labeling.
  await goSection("system");
  const targetsState = await settings.evalJs(`({
    toggles: Array.from(document.querySelectorAll('.settings-toggle')).map((e) => e.getBoundingClientRect().height),
    icons: Array.from(document.querySelectorAll('.settings-icon-btn')).map((e) => e.getBoundingClientRect().height),
    immediate: document.querySelectorAll('.settings-immediate').length,
    statusLive: Array.from(document.querySelectorAll('[role="status"]')).length,
    restore: document.querySelector('.settings-footer .settings-action')?.textContent.trim(),
    restoreHint: document.querySelector('.settings-footer-hint')?.textContent.trim(),
  })`);
  check("toggle / icon click targets meet audit floor",
    targetsState.toggles.every((n) => n >= 24) && minIconHeight >= 30,
    JSON.stringify({ toggles: targetsState.toggles, minIconHeight }));
  check("immediate writes are labeled and restore scope is explicit",
    targetsState.immediate > 0 && targetsState.statusLive > 0 && targetsState.restore.includes("恢复应用默认值") && targetsState.restoreHint.includes("插件"),
    JSON.stringify(targetsState));
  await settings.shot("settings-ux-final");

  await goSection("about");
  const aboutLinkHeight = await settings.evalJs(
    `document.querySelector('.settings-link')?.getBoundingClientRect().height ?? 0`,
  );
  check("about link meets the 24px hit-target floor", aboutLinkHeight >= 24, String(aboutLinkHeight));

  await settings.send("Emulation.setDeviceMetricsOverride", {
    width: 560,
    height: 420,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const overflowSections = [];
  for (const section of ["launcher", "clipboard", "search", "system", "automation", "plugins", "about"]) {
    await goSection(section);
    const overflow = await settings.evalJs(`({
      doc: document.documentElement.scrollWidth > window.innerWidth + 1,
      main: (() => {
        const el = document.querySelector('.settings-main');
        return !!el && el.scrollWidth > el.clientWidth + 1;
      })(),
    })`);
    if (overflow.doc || overflow.main) overflowSections.push({ section, ...overflow });
  }
  check("settings sections have no horizontal overflow at 560x420", overflowSections.length === 0, JSON.stringify(overflowSections));
  await settings.send("Emulation.clearDeviceMetricsOverride");

  // Discard every draft change used by this probe.
  await settings.evalJs(`document.querySelector('.titlebar-close').click()`);
  await sleep(150);
  await settings.evalJs(`(() => {
    const buttons = Array.from(document.querySelectorAll('.settings-confirm button'));
    buttons.find((b) => b.textContent.includes('丢弃未保存的草稿'))?.click();
    return true;
  })()`);
  await sleep(250);
} catch (err) {
  console.error("PROBE ERROR", err);
  fail++;
} finally {
  if (settings && originalPluginState) {
    try {
      await settings.evalJs(`(async () => {
        await window.__TAURI_INTERNALS__.invoke('set_plugin_dev_mode', { enabled: ${originalPluginState.dev} });
        if (${originalPluginState.dev && originalPluginState.trust}) {
          await window.__TAURI_INTERNALS__.invoke('set_plugin_trust_all', { enabled: true });
        }
        return true;
      })()`);
    } catch {}
  }
  try { settings?.ws.close(); } catch {}
  try { main?.ws.close(); } catch {}
  try { app.kill(); } catch {}
  try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
  rmSync(TMP_INDEX, { recursive: true, force: true });
}

console.log(`\n[settings-ux-audit] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
