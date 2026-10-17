// Visual-audit regression probe (docs/UI_VISUAL_AUDIT_2026-10-17.md).
//
// Launches the embedded debug build and verifies the repaired contracts:
//   V-01 light accent/focus tokens clear contrast thresholds
//   V-02 secondary text and row actions are readable and not tiny
//   V-03 semantic colors and the destructive fill follow the theme
//   V-04 hidden clipboard row actions stay out of the Tab order
//   V-05 the last settings nav item remains hittable at 560x420
//   V-06 the satellite preview has a title and in-window close button
//   V-07 narrow mode bars fall back to icons and scroll without edge controls
//   V-08 icon-less app rows render deterministic letter tiles
//   V-09 truncated result names/descriptions expose their full text
//
// It snapshots and restores settings, pinned apps and text clipboard content.
// Usage: pnpm run tauri build --debug --no-bundle
//        node scripts/cdp_visual_audit_verify.mjs
import { spawn, execFileSync, execSync } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = "src-tauri/target/debug";
const APP = `${BASE}/lume.exe`;
const PORT = 9247;
const OUT = "test/visual-audit-fix";
const IMAGE = resolve("test/PixPin_2026-08-06_22-03-20.png");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? ` — ${extra}` : ""}`);
  if (ok) pass++;
  else fail++;
};

const rgb = (value) => {
  if (String(value).startsWith("#")) {
    const hex = String(value).slice(1);
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return {
      c: [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)),
      a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
    };
  }
  const nums = String(value).match(/[\d.]+/g)?.map(Number) ?? [];
  return { c: nums.slice(0, 3), a: nums.length > 3 ? nums[3] : 1 };
};
const composite = (fg, bg) =>
  fg.c.map((v, i) => Math.round(v * fg.a + bg[i] * (1 - fg.a)));
const luminance = (c) => {
  const ch = c.map((v) => {
    const x = v / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
};
const contrast = (fg, bg) => {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const contrastOn = (fgValue, bgArray) => {
  const fg = rgb(fgValue);
  return contrast(composite(fg, bgArray), bgArray);
};

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ps = (command) =>
  execFileSync("powershell", ["-NoProfile", "-Command", command], {
    encoding: "utf8",
  }).trimEnd();

try {
  execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" });
} catch {}

mkdirSync(OUT, { recursive: true });
const logFd = openSync(`${OUT}/lume.log`, "w");
spawn(APP, [], {
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
  },
  stdio: ["ignore", logFd, logFd],
});

async function targets() {
  for (let i = 0; i < 50; i++) {
    try {
      return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    } catch {
      await sleep(300);
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
  return { ws, send, evalJs };
}

async function findPage(testExpression) {
  for (let i = 0; i < 40; i++) {
    const pages = (await targets()).filter(
      (t) => t.type === "page" && t.url.includes("tauri.localhost")
    );
    for (const page of pages) {
      try {
        const client = await connect(page.webSocketDebuggerUrl);
        if (await client.evalJs(testExpression)) return client;
        client.ws.close();
      } catch {}
    }
    await sleep(300);
  }
  return null;
}

async function findPreview() {
  for (let i = 0; i < 40; i++) {
    const pages = (await targets()).filter((t) => t.type === "page");
    for (const page of pages) {
      if (!page.url.includes("preview.html")) continue;
      try {
        const client = await connect(page.webSocketDebuggerUrl);
        if (await client.evalJs(`!!document.querySelector(".preview-body")`)) return client;
        client.ws.close();
      } catch {}
    }
    await sleep(250);
  }
  return null;
}

async function keyTab(client) {
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 9,
  });
  await sleep(80);
}

async function click(client, x, y) {
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sleep(250);
}

async function shot(client, name) {
  const reply = await client.send("Page.captureScreenshot", { format: "png" });
  if (reply.result?.data) {
    writeFileSync(`${OUT}/${name}`, Buffer.from(reply.result.data, "base64"));
  }
}

let main = null;
let settings = null;
let preview = null;
let originalSettings = null;
const originalClipboard = (() => {
  try {
    return ps("Get-Clipboard -Raw");
  } catch {
    return "";
  }
})();
const fakePin = "C:\\__lume_visual_audit_missing__\\missing.exe";

try {
  main = await findPage(`!!document.getElementById("search-input")`);
  if (!main) throw new Error("launcher target missing");
  const invoke = (cmd, args = {}) =>
    main.evalJs(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
    );

  originalSettings = await invoke("get_settings");
  await invoke("pin_app", { path: fakePin, name: "Zulu Missing Icon" });
  await invoke("save_settings_patch", {
    patch: {
      appearance: {
        color_mode: "light",
        window_width: 540,
        entry_size: 70,
        mode_switch_icons_only: false,
      },
    },
  });
  await invoke("toggle_launcher");
  await sleep(1800);
  await main.evalJs(`(() => {
    const names = ["导航", "導航", "Navigate"];
    const pill = [...document.querySelectorAll(".mode-switch-item")].find(
      (b) => names.includes(b.getAttribute("title"))
    );
    pill?.click();
    return !!pill;
  })()`);
  await sleep(900);

  // Seed enough distinct text rows for the virtual list and a hidden-action
  // row, while preserving the user's original text clipboard for cleanup.
  for (let i = 0; i < 4; i++) {
    ps(`Set-Clipboard -Value ${psQuote(`lume visual audit row ${Date.now()}-${i}`)}`);
    await sleep(420);
  }

  const light = await main.evalJs(`(() => {
    const root = getComputedStyle(document.documentElement);
    const css = (name) => root.getPropertyValue(name).trim();
    return {
      surface: css("--surface"),
      accent: css("--accent"),
      accentText: css("--accent-text"),
      accentTint: css("--accent-tint"),
      focus: css("--focus-ring"),
      dangerFill: css("--danger-fill"),
      dangerText: css("--danger-text"),
      warningText: css("--warning-text"),
      successText: css("--success-text"),
    };
  })()`);
  const surface = rgb(light.surface).c;
  const accentRatio = contrastOn(light.accentText, surface);
  const focusRatio = contrastOn(light.focus, surface);
  check(
    "V-01 light accent text clears 4.5:1",
    accentRatio >= 4.5,
    `${accentRatio.toFixed(2)}:1 ${light.accentText} on ${light.surface}`
  );
  check(
    "V-01 light focus token clears non-text 3:1",
    focusRatio >= 3,
    `${focusRatio.toFixed(2)}:1 ${light.focus}`
  );

  let home = await main.evalJs(`(() => {
    const mode = document.querySelector(".mode-switch");
    const shell = document.querySelector(".mode-switch-shell");
    const input = document.getElementById("search-input");
    const items = [...document.querySelectorAll(".mode-switch-item")];
    const mr = mode.getBoundingClientRect();
    const fake = [...document.querySelectorAll(".result-box")].find(
      (b) => b.querySelector(".result-box-name")?.textContent === "Zulu Missing Icon"
    );
    const letter = fake?.querySelector(".result-box-letter");
    let barTitleEl = document.querySelector(".bar-title");
    let tempTitle = false;
    if (!barTitleEl) {
      barTitleEl = document.createElement("span");
      barTitleEl.className = "bar-title";
      barTitleEl.textContent = "Synthetic bar";
      document.body.append(barTitleEl);
      tempTitle = true;
    }
    const barStyle = getComputedStyle(barTitleEl);
    const barTitle = { color: barStyle.color, size: barStyle.fontSize };
    if (tempTitle) barTitleEl.remove();
    return {
      labelsHidden: items.every(
        (b) => getComputedStyle(b.querySelector(".mode-switch-label")).display === "none"
      ),
      itemCount: items.length,
      modeShellWidth: Math.round(shell.getBoundingClientRect().width),
      clipped: items.some((b) => b.getBoundingClientRect().right > mr.right + 1),
      overflowRight: mode.scrollLeft + mode.clientWidth < mode.scrollWidth - 1,
      hasScrollButtons: !!document.querySelector(".mode-switch-scroll"),
      beforeContent: getComputedStyle(shell, "::before").content,
      afterContent: getComputedStyle(shell, "::after").content,
      inputWidth: input.getBoundingClientRect().width,
      placeholder: input.getAttribute("placeholder"),
      placeholderIsTitle: input.getAttribute("placeholder") === input.getAttribute("title"),
      letter: letter
        ? {
            char: letter.textContent.trim(),
            background: getComputedStyle(letter).backgroundColor,
          }
        : null,
      namesHaveTitles: [...document.querySelectorAll(".result-box-name")].every(
        (n) => !!n.getAttribute("title")
      ),
      descHaveTitles: [...document.querySelectorAll(".result-box-desc")].every(
        (n) => !!n.getAttribute("title")
      ),
      nameCount: document.querySelectorAll(".result-box-name").length,
      barTitle,
    };
  })()`);

  if (!home.letter || home.nameCount === 0) {
    await main.evalJs(`(() => {
      const input = document.getElementById("search-input");
      input.value = "BetterGI";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return "searched";
    })()`);
    await sleep(1400);
    const searchState = await main.evalJs(`(() => {
      const letter = document.querySelector(".result-box-letter");
      return {
        letter: letter
          ? {
              char: letter.textContent.trim(),
              background: getComputedStyle(letter).backgroundColor,
            }
          : null,
        namesHaveTitles: [...document.querySelectorAll(".result-box-name")].every(
          (n) => !!n.getAttribute("title")
        ),
        descHaveTitles: [...document.querySelectorAll(".result-box-desc")].every(
          (n) => !!n.getAttribute("title")
        ),
        nameCount: document.querySelectorAll(".result-box-name").length,
      };
    })()`);
    home = { ...home, ...searchState };
    await main.evalJs(`(() => {
      const input = document.getElementById("search-input");
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return "cleared";
    })()`);
    await sleep(500);
  }
  check(
    "V-07 540px mode bar falls back to icons",
    home.labelsHidden && home.itemCount >= 3,
    JSON.stringify({ labelsHidden: home.labelsHidden, itemCount: home.itemCount })
  );
  check(
    "V-07 narrow mode strip fits about three icons",
    home.modeShellWidth >= 90 && home.modeShellWidth <= 110,
    JSON.stringify({ modeShellWidth: home.modeShellWidth })
  );
  check(
    "V-07 clipped modes remain horizontally scrollable",
    home.clipped && home.overflowRight,
    JSON.stringify({
      clipped: home.clipped,
      overflowRight: home.overflowRight,
    })
  );
  check(
    "V-07 mode bar has no arrow or fading-edge controls",
    !home.hasScrollButtons &&
      home.beforeContent === "none" &&
      home.afterContent === "none",
    JSON.stringify({
      hasScrollButtons: home.hasScrollButtons,
      beforeContent: home.beforeContent,
      afterContent: home.afterContent,
    })
  );
  check(
    "V-07 search input keeps its floor and adapts the placeholder",
    home.inputWidth >= 120 &&
      (home.inputWidth < 160 ? !home.placeholderIsTitle : home.placeholderIsTitle),
    JSON.stringify({
      width: home.inputWidth,
      placeholder: home.placeholder,
      placeholderIsTitle: home.placeholderIsTitle,
    })
  );
  check(
    "V-08 missing app icon renders a deterministic letter tile",
    !!home.letter && /^[A-Za-z\u00c0-\uffff]$/.test(home.letter.char) &&
      /^rgb\(/.test(home.letter.background),
    JSON.stringify(home.letter)
  );
  check(
    "V-09 result names and descriptions expose full text",
    home.nameCount > 0 && home.namesHaveTitles && home.descHaveTitles,
    JSON.stringify({
      rows: home.nameCount,
      names: home.namesHaveTitles,
      descriptions: home.descHaveTitles,
    })
  );
  const barColor = home.barTitle?.color ?? "rgb(0,0,0)";
  const barSize = parseFloat(home.barTitle?.size ?? "0");
  check(
    "V-02 bar title clears 4.5:1 and stays 12px",
    contrastOn(barColor, surface) >= 4.5 && barSize >= 12,
    `${contrastOn(barColor, surface).toFixed(2)}:1 / ${barSize}px`
  );
  await shot(main, "home-540-light.png");

  // Clipboard page.
  await main.evalJs(`(() => {
    const names = ["剪贴板", "剪貼簿", "Clipboard"];
    const pill = [...document.querySelectorAll(".mode-switch-item")].find(
      (b) => names.includes(b.getAttribute("title"))
    );
    pill?.click();
    return !!pill;
  })()`);
  await sleep(1100);

  const clip = await main.evalJs(`(() => {
    const meta = document.querySelector(".clip-row-meta");
    const act = document.querySelector(".clip-row.result-selected .clip-act");
    const hidden = [...document.querySelectorAll(".clip-row:not(.result-selected) .clip-act")];
    const active = document.querySelector(".clip-cat.active");
    return {
      rows: document.querySelectorAll(".clip-row").length,
      meta: meta
        ? { color: getComputedStyle(meta).color, size: getComputedStyle(meta).fontSize }
        : null,
      action: act
        ? {
            color: getComputedStyle(act).color,
            iconSize: getComputedStyle(act.querySelector("svg")).width,
          }
        : null,
      hiddenTabs: hidden.length,
      hiddenTabStops: hidden.filter((b) => b.tabIndex === 0).length,
      activeColor: active ? getComputedStyle(active).color : null,
      hasFade: !!document.querySelector(".clip-main .scroll-fade.bottom"),
    };
  })()`);
  const metaRatio = contrastOn(clip.meta?.color ?? "rgb(0,0,0)", surface);
  const actionRatio = contrastOn(clip.action?.color ?? "rgb(0,0,0)", surface);
  check(
    "V-02 clipboard metadata clears 4.5:1 at >=12px",
    metaRatio >= 4.5 && parseFloat(clip.meta?.size ?? "0") >= 12,
    `${metaRatio.toFixed(2)}:1 / ${clip.meta?.size}`
  );
  check(
    "V-02 row actions clear 3:1 and use a 16px glyph",
    actionRatio >= 3 && parseFloat(clip.action?.iconSize ?? "0") >= 16,
    `${actionRatio.toFixed(2)}:1 / ${clip.action?.iconSize}`
  );
  check(
    "V-01 active clipboard category uses the light accent-text token",
    clip.activeColor === "rgb(7, 87, 184)",
    clip.activeColor
  );
  check(
    "V-04 unselected row actions are not Tab stops",
    clip.hiddenTabs > 0 && clip.hiddenTabStops === 0,
    JSON.stringify({ hiddenActions: clip.hiddenTabs, tabStops: clip.hiddenTabStops })
  );
  check("scroll cue appears on the long clipboard list", clip.hasFade);

  await main.evalJs(`document.querySelector(".clip-cat:last-child")?.focus(); "focused"`);
  const tabTrace = [];
  for (let i = 0; i < 5; i++) {
    await keyTab(main);
    tabTrace.push(
      await main.evalJs(`(() => {
        const a = document.activeElement;
        const row = a?.closest?.(".clip-row");
        const actions = row?.querySelector(".clip-row-actions");
        return {
          cls: a?.className ?? "",
          rowSelected: !!row?.classList.contains("result-selected"),
          actionsOpacity: actions ? getComputedStyle(actions).opacity : null,
        };
      })()`)
    );
  }
  const reachedActions = tabTrace.filter((t) => String(t.cls).includes("clip-act"));
  check(
    "V-04 every reached row action has a visible selected-row parent",
    reachedActions.length > 0 &&
      reachedActions.every((t) => t.rowSelected && t.actionsOpacity === "1"),
    JSON.stringify(tabTrace)
  );

  await main.evalJs(`document.querySelector(".clip-clear-btn")?.click(); "open"`);
  await sleep(200);
  const danger = await main.evalJs(`(() => {
    const b = document.querySelector(".clip-confirm-ok");
    if (!b) return null;
    const s = getComputedStyle(b);
    return { color: s.color, background: s.backgroundColor };
  })()`);
  check(
    "V-03 destructive button clears 4.5:1 in light mode",
    !!danger && contrastOn(danger.color, rgb(danger.background).c) >= 4.5,
    JSON.stringify({
      colors: danger,
      ratio: danger ? contrastOn(danger.color, rgb(danger.background).c).toFixed(2) : null,
    })
  );
  const semanticRatios = {
    danger: contrastOn(light.dangerText, surface),
    warning: contrastOn(light.warningText, surface),
    success: contrastOn(light.successText, surface),
  };
  check(
    "V-03 danger / warning / success text clear 4.5:1",
    semanticRatios.danger >= 4.5 &&
      semanticRatios.warning >= 4.5 &&
      semanticRatios.success >= 4.5,
    JSON.stringify(
      Object.fromEntries(Object.entries(semanticRatios).map(([k, v]) => [k, v.toFixed(2)]))
    )
  );
  await main.evalJs(`document.querySelector(".clip-confirm-cancel")?.click(); "closed"`);
  await shot(main, "clipboard-540-light.png");

  // Settings window at its declared minimum content size.
  await invoke("open_settings");
  settings = await findPage(`document.body.classList.contains("settings-window")`);
  if (!settings) throw new Error("settings target missing");
  await sleep(500);
  await settings.send("Emulation.setDeviceMetricsOverride", {
    width: 560,
    height: 420,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await sleep(400);
  const settingsAccent = await settings.evalJs(`(() => {
    const chip = document.querySelector(".settings-chip.active");
    const group = document.querySelector(".settings-grouptitle");
    const link = document.querySelector(".settings-link");
    return {
      chip: chip ? getComputedStyle(chip).color : null,
      group: group ? getComputedStyle(group).color : null,
      link: link ? getComputedStyle(link).color : null,
    };
  })()`);
  const minLayout = await settings.evalJs(`(() => {
    const content = document.querySelector(".settings-content").getBoundingClientRect();
    const nav = [...document.querySelectorAll(".settings-nav")];
    const last = nav.at(-1);
    const r = last.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      lastText: last.textContent.trim(),
      lastBottom: r.bottom,
      contentBottom: content.bottom,
      hitNav: hit?.closest(".settings-nav") === last,
      hitClass: hit?.className ?? "",
      sidebar: {
        clientHeight: document.querySelector(".settings-sidebar").clientHeight,
        scrollHeight: document.querySelector(".settings-sidebar").scrollHeight,
      },
    };
  })()`);
  check(
    "V-05 About nav is inside the content band at 560x420",
    minLayout.lastBottom <= minLayout.contentBottom + 0.5,
    JSON.stringify(minLayout)
  );
  check(
    "V-05 About nav center hit-tests as a nav button",
    minLayout.hitNav,
    JSON.stringify({ hit: minLayout.hitClass, text: minLayout.lastText })
  );
  const lastCenter = await settings.evalJs(`(() => {
    const r = [...document.querySelectorAll(".settings-nav")].at(-1).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  await click(settings, lastCenter.x, lastCenter.y);
  const aboutActive = await settings.evalJs(
    `document.querySelector(".settings-nav.active")?.textContent?.trim() ?? ""`
  );
  check("V-05 About is reachable with a real center click", /关于|關於|About/.test(aboutActive), aboutActive);

  const afterAboutAccent = await settings.evalJs(`(() => {
    const group = document.querySelector(".settings-grouptitle");
    const link = document.querySelector(".settings-link");
    return {
      group: group ? getComputedStyle(group).color : null,
      link: link ? getComputedStyle(link).color : null,
    };
  })()`);
  check(
    "V-01 selected chips / group titles / links all use accent text",
    Object.values({ ...settingsAccent, ...afterAboutAccent })
      .filter(Boolean)
      .every((c) => c === "rgb(7, 87, 184)"),
    JSON.stringify({ ...settingsAccent, ...afterAboutAccent })
  );

  await settings.evalJs(`document.querySelectorAll(".settings-nav")[7]?.click(); "plugins"`);
  await sleep(700);
  const pluginFade = await settings.evalJs(
    `!!document.querySelector(".settings-main > .scroll-fade.bottom")`
  );
  check("settings body exposes a scroll cue on the long plugin page", pluginFade);
  await shot(settings, "settings-min-plugins.png");
  await settings.send("Emulation.clearDeviceMetricsOverride");

  // Satellite preview: title + close control (direct request; no clipboard
  // format setup needed because the window itself is under test here).
  await invoke("close_settings");
  await sleep(300);
  await invoke("toggle_launcher");
  await sleep(500);
  await invoke("show_preview", {
    req: { kind: "image", content: null, path: IMAGE, id: null },
  });
  preview = await findPreview();
  if (!preview) throw new Error("preview target missing");
  await sleep(700);
  const previewInfo = await preview.evalJs(`(() => {
    const title = document.querySelector(".preview-title");
    const close = document.querySelector(".preview-close");
    const r = close?.getBoundingClientRect();
    return {
      title: title?.textContent?.trim() ?? null,
      hasClose: !!close,
      closeCenter: r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null,
      viewport: { width: innerWidth, height: innerHeight },
    };
  })()`);
  check(
    "V-06 preview shows the filename in its title",
    String(previewInfo.title).includes("PixPin_2026-08-06_22-03-20.png"),
    String(previewInfo.title)
  );
  check("V-06 preview exposes an in-window close button", previewInfo.hasClose);
  await shot(preview, "preview-title-close.png");
  if (previewInfo.closeCenter) {
    await click(preview, previewInfo.closeCenter.x, previewInfo.closeCenter.y);
  }
  await sleep(500);
  const requestAfterClose = await invoke("get_preview_request");
  check(
    "V-06 clicking the preview close button tears the request down",
    requestAfterClose === null,
    JSON.stringify(requestAfterClose)
  );
} catch (error) {
  console.error("visual audit probe crashed:", error);
  fail++;
} finally {
  try {
    if (main) {
      const invoke = (cmd, args = {}) =>
        main.evalJs(
          `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`
        );
      try {
        await invoke("close_settings");
      } catch {}
      try {
        await invoke("unpin_app", { path: fakePin });
      } catch {}
      if (originalSettings) {
        try {
          await invoke("save_settings", { new: originalSettings });
        } catch (error) {
          console.error("settings restore failed:", error);
        }
      }
    }
  } catch {}
  try {
    ps(`Set-Clipboard -Value ${psQuote(originalClipboard)}`);
  } catch {}
  try {
    execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" });
  } catch {}
  console.log(`\nVISUAL-AUDIT-VERIFY ${fail === 0 ? "PASS" : "FAIL"} (${pass}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
}
