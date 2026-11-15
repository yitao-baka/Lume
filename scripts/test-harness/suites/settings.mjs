import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../cdp.mjs";

const EXPECTED_SECTIONS = [
  "appearance",
  "launcher",
  "clipboard",
  "search",
  "hotkeys",
  "automation",
  "plugins",
  "system",
  "about",
];

export default {
  id: "settings",
  description: "Lazy settings lifecycle, navigation, search surface and clipboard pane",
  tags: ["ui", "settings"],
  // Keep the production five-minute warm window while exercising the same
  // destroy/recreate path inside the isolated harness.
  env: { LUME_SETTINGS_IDLE_DESTROY_SECS: "2" },
  async run(t) {
    const settingsPresentAtStartup = await t.main.evaluate(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "settings" }).then(() => true).catch(() => false)',
    );
    t.equal("settings webview is absent until first open", settingsPresentAtStartup, false);

    const settings = await t.openSettings();
    const settingsContext = {
      evaluate: (expression, options) => settings.evaluate(expression, options),
      waitFor: (expression, timeoutMs) => settings.waitFor(expression, timeoutMs),
    };

    await settingsContext.waitFor('window.__settingsShownAt > 0', 5000);
    const firstShow = await settingsContext.evaluate(`(() => ({
      readyAt: window.__settingsReadyAt ?? 0,
      shownAt: window.__settingsShownAt ?? 0,
      readyState: document.readyState,
      loadingPane: !!document.querySelector(".settings-page-loading"),
      contentText: document.querySelector("#settings-page-content")?.textContent.trim().length ?? 0,
    }))()`);
    t.check(
      "settings window is revealed only after its first pane is ready",
      firstShow.readyAt > 0 &&
        firstShow.shownAt >= firstShow.readyAt &&
        firstShow.readyState === "complete" &&
        !firstShow.loadingPane &&
        firstShow.contentText > 0,
      firstShow,
    );

    t.check("settings footer exposes restore but no global save", await settingsContext.evaluate(`(() => {
      const buttons = [...document.querySelectorAll(".settings-footer button")];
      return buttons.length === 1 && buttons[0].classList.contains("settings-footer-action");
    })()`));

    const taskbarIconPath = join(t.resultDir, "settings-taskbar-icon.png");
    const taskbarIconProbe = spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-File",
        join(ROOT, "scripts", "test-harness", "probe-window-icon.ps1"),
        "-ProcessId",
        String(t.session.pid),
        "-OutputPath",
        taskbarIconPath,
      ],
      { encoding: "utf8" },
    );
    const taskbarIconOutput = taskbarIconProbe.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    let taskbarIcon = null;
    try { taskbarIcon = JSON.parse(taskbarIconOutput); } catch {}
    t.artifacts.push(taskbarIconPath);
    t.check(
      "settings taskbar icon uses the opaque bundle artwork",
      taskbarIconProbe.status === 0 &&
        taskbarIcon?.bigHandle > 0 &&
        taskbarIcon?.smallHandle > 0 &&
        taskbarIcon?.width === 32 &&
        taskbarIcon?.height === 32 &&
        taskbarIcon?.rightAlpha === 255 &&
        taskbarIcon?.rightR > 220 &&
        taskbarIcon?.rightG > 220 &&
        taskbarIcon?.rightB > 210,
      {
        status: taskbarIconProbe.status,
        stderr: taskbarIconProbe.stderr.trim(),
        icon: taskbarIcon,
      },
    );

    await settings.invoke("save_settings_patch", {
      patch: { appearance: { settings_skin: "quiet", color_mode: "light" } },
    });
    await settingsContext.waitFor(
      'document.documentElement.dataset.skin === "quiet" && document.documentElement.dataset.theme === "light"',
      5000,
    );
    const quietLightSurfaces = await settingsContext.evaluate(`(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        skin: document.documentElement.dataset.skin,
        theme: document.documentElement.dataset.theme,
        canvas: getComputedStyle(document.querySelector(".settings-main")).backgroundColor,
        rail: getComputedStyle(document.querySelector(".settings-sidebar")).backgroundColor,
        panel: getComputedStyle(document.querySelector(".settings-group-panel")).backgroundColor,
        control: getComputedStyle(document.querySelector(".settings-search")).backgroundColor,
        canvasToken: root.getPropertyValue("--settings-canvas-base").trim(),
        railToken: root.getPropertyValue("--settings-rail-base").trim(),
        panelToken: root.getPropertyValue("--settings-panel-base").trim(),
        controlToken: root.getPropertyValue("--settings-control-base").trim(),
      };
    })()`);
    t.check(
      "Quiet light settings surfaces use warm rice-white layers instead of pure white",
      quietLightSurfaces.skin === "quiet" &&
        quietLightSurfaces.theme === "light" &&
        quietLightSurfaces.canvasToken === "#f0ede6" &&
        quietLightSurfaces.railToken === "#f4f0e8" &&
        quietLightSurfaces.panelToken === "#f8f4ea" &&
        quietLightSurfaces.controlToken === "#ece7dd" &&
        quietLightSurfaces.canvas === "rgb(240, 237, 230)" &&
        quietLightSurfaces.rail === "rgb(244, 240, 232)" &&
        quietLightSurfaces.panel === "rgb(248, 244, 234)" &&
        quietLightSurfaces.control === "rgb(236, 231, 221)" &&
        quietLightSurfaces.panel !== "rgb(255, 255, 255)",
      quietLightSurfaces,
    );

    await settings.invoke("save_settings_patch", {
      patch: { appearance: { settings_skin: "chromatic", color_mode: "light" } },
    });
    await settingsContext.waitFor(
      'document.documentElement.dataset.skin === "chromatic" && document.documentElement.dataset.theme === "light"',
      5000,
    );
    const chromaticLightRail = await settingsContext.evaluate(`(() => {
      const root = getComputedStyle(document.documentElement);
      return {
        skin: document.documentElement.dataset.skin,
        theme: document.documentElement.dataset.theme,
        rail: getComputedStyle(document.querySelector(".settings-sidebar")).backgroundColor,
        canvas: getComputedStyle(document.querySelector(".settings-main")).backgroundColor,
        railToken: root.getPropertyValue("--settings-rail-base").trim(),
      };
    })()`);
    t.check(
      "Chromatic light settings rail stays a warm neutral near the canvas",
      chromaticLightRail.skin === "chromatic" &&
        chromaticLightRail.theme === "light" &&
        chromaticLightRail.railToken === "#ebe6dc" &&
        chromaticLightRail.rail === "rgb(235, 230, 220)" &&
        chromaticLightRail.canvas === "rgb(243, 239, 230)" &&
        chromaticLightRail.rail !== chromaticLightRail.canvas,
      chromaticLightRail,
    );

    // Settings owns the foreground when it opens. Summoning the launcher from
    // there must move both the native HWND focus and the WebView document focus
    // back to main; otherwise keyboard navigation silently targets Settings.
    const mainHidden = await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }).then((visible) => !visible)',
      5000,
    );
    t.check("opening settings hides the launcher", mainHidden);
    await settings.invoke("toggle_launcher");
    const mainHasDomFocus = await t.waitFor(
      'document.hasFocus() && document.activeElement?.id === "search-input"',
      5000,
    );
    const mainHasNativeFocus = await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_focused", { label: "main" })',
      3000,
    );
    const settingsHasDomFocus = await settings.evaluate("document.hasFocus()");
    t.check(
      "summon from settings restores launcher native and document focus",
      mainHasDomFocus && mainHasNativeFocus && !settingsHasDomFocus,
      { mainHasDomFocus, mainHasNativeFocus, settingsHasDomFocus },
    );

    await settings.invoke("save_settings_patch", {
      patch: { appearance: { color_mode: "dark" } },
    });
    await settingsContext.waitFor('document.documentElement.dataset.theme === "dark"', 5000);
    const darkIconFilter = await settingsContext.evaluate(`(() => {
      const icon = document.querySelector(".settings-nav-icon");
      const root = document.documentElement;
      return {
        theme: root.dataset.theme,
        token: getComputedStyle(root).getPropertyValue("--icon-filter").trim(),
        filter: icon ? getComputedStyle(icon).filter : "",
      };
    })()`);
    t.check(
      "dark settings navigation icons invert their bundled dark artwork",
      darkIconFilter.theme === "dark" &&
        darkIconFilter.token === "invert(1)" &&
        darkIconFilter.filter !== "none" &&
        darkIconFilter.filter !== "",
      darkIconFilter,
    );

    const measurePane = (section, selector) => settingsContext.evaluate(`(async () => {
      const start = performance.now();
      document.querySelector('.settings-nav[data-section="${section}"]')?.click();
      while (!document.querySelector(${JSON.stringify(selector)})) {
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return performance.now() - start;
    })()`);
    const paneLatency = {
      search: await measurePane("search", '[data-setting-id="index.full_drive_group"]'),
      about: await measurePane("about", '[data-setting-id="about.version"]'),
      plugins: await measurePane("plugins", ".plg-card"),
    };
    t.check(
      "Search, About and Plugins panes are warm on first activation",
      Object.values(paneLatency).every((elapsed) => elapsed < 1000),
      paneLatency,
    );
    await measurePane("appearance", '[data-setting-id="appearance.window_color"]');

    await settings.invoke("save_settings_patch", {
      patch: { appearance: { accent: "#6f7cff" } },
    });
    await settingsContext.waitFor(
      'document.documentElement.style.getPropertyValue("--ui-accent-raw").trim() === "#6f7cff"',
      5000,
    );
    const clickTheme = (index) => settingsContext.evaluate(
      `document.querySelectorAll('[data-setting-id="appearance.color_mode"] [role="radio"]')[${index}]?.click(); true`,
    );
    await clickTheme(2);
    await settingsContext.waitFor(
      'document.documentElement.dataset.theme === "light" && document.documentElement.dataset.settingsSaveState === "saved"',
      5000,
    );
    await clickTheme(1);
    await settingsContext.waitFor(
      'document.documentElement.dataset.theme === "dark" && document.documentElement.dataset.settingsSaveState === "saved" && document.querySelector(".settings-save-symbol")?.textContent === "✓"',
      5000,
    );
    const autosaveAccent = await settingsContext.evaluate(`(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ui-accent)";
      document.body.append(probe);
      const accent = getComputedStyle(probe).color;
      probe.style.color = "var(--settings-success)";
      const success = getComputedStyle(probe).color;
      probe.remove();
      return {
        theme: document.documentElement.dataset.theme,
        state: document.documentElement.dataset.settingsSaveState,
        symbol: getComputedStyle(document.querySelector(".settings-save-symbol")).color,
        accent,
        success,
      };
    })()`);
    t.check(
      "dark autosave confirmation follows the live accent instead of semantic success",
      autosaveAccent.theme === "dark" &&
        autosaveAccent.state === "saved" &&
        autosaveAccent.symbol === autosaveAccent.accent &&
        autosaveAccent.symbol !== autosaveAccent.success,
      autosaveAccent,
    );

    const sections = await settingsContext.evaluate(
      '[...document.querySelectorAll(".settings-nav")].map((item) => item.dataset.section)',
    );
    t.deepEqual("settings navigation exposes the current section set", sections, EXPECTED_SECTIONS);
    t.check("settings command search is present", await settingsContext.evaluate('!!document.querySelector(".settings-search-input")'));
    await settingsContext.evaluate('document.querySelector(\'.settings-nav[data-section="appearance"]\').click()');
    await settingsContext.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "appearance"', 5000);
    await settingsContext.waitFor('!document.querySelector(".settings-page-loading")', 5000);
    const launcherSurfaceControls = await settingsContext.evaluate(`(() => {
      const color = document.querySelector('[data-setting-id="appearance.window_color"] input[type="color"]');
      const opacity = document.querySelector('[data-setting-id="appearance.window_opacity"] input[type="range"]');
      return {
        color: !!color,
        opacity: !!opacity,
        opacityMin: opacity?.min,
        opacityMax: opacity?.max,
        followSkin: !!document.querySelector('[data-setting-id="appearance.window_color"] .settings-chip'),
      };
    })()`);
    t.check(
      "launcher color and opacity controls are visible",
      launcherSurfaceControls.color &&
        launcherSurfaceControls.opacity &&
        launcherSurfaceControls.opacityMin === "70" &&
        launcherSurfaceControls.opacityMax === "100" &&
        launcherSurfaceControls.followSkin,
      launcherSurfaceControls,
    );
    await settingsContext.evaluate(`(() => {
      const input = document.querySelector('[data-setting-id="appearance.window_color"] input[type="color"]');
      input.value = "#dce6f2";
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    const launcherColorSaved = await settingsContext.waitFor(
      'window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.appearance.window_color === "#dce6f2")',
      5000,
    );
    t.check("launcher color persists", launcherColorSaved);
    await settingsContext.evaluate(`(() => {
      const input = document.querySelector('[data-setting-id="appearance.window_opacity"] input[type="range"]');
      input.value = "84";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const launcherOpacitySaved = await settingsContext.waitFor(
      'window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.appearance.window_opacity === 84)',
      5000,
    );
    t.check("launcher opacity persists", launcherOpacitySaved);
    const launcherSurfaceApplied = await t.waitFor(
      'getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() === "#dce6f2" && getComputedStyle(document.documentElement).getPropertyValue("--main-window-opacity").trim() === "0.84"',
      5000,
    );
    t.check("launcher applies its custom surface and opacity", launcherSurfaceApplied);
    await settingsContext.evaluate('document.querySelector(\'[data-setting-id="appearance.window_color"] .settings-chip\').click()');
    await settingsContext.evaluate(`(() => {
      const input = document.querySelector('[data-setting-id="appearance.window_opacity"] input[type="range"]');
      input.value = "100";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    const launcherSurfaceReset = await settingsContext.waitFor(
      'window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.appearance.window_color === "" && s.appearance.window_opacity === 100)',
      5000,
    );
    t.check("launcher surface controls reset to follow skin and full opacity", launcherSurfaceReset);

    await settingsContext.evaluate(
      'document.querySelector(\'[data-setting-id="appearance.window_color"]\')?.scrollIntoView({ block: "center" }); true',
    );
    await t.sleep(100);
    await t.screenshot("settings-appearance-window", settings);

    await settingsContext.evaluate('document.querySelector(\'.settings-nav[data-section="about"]\').click()');
    await settingsContext.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "about"', 5000);
    await settingsContext.waitFor('!document.querySelector(".settings-page-loading")', 5000);
    t.equal(
      "settings navigation reaches About",
      await settingsContext.evaluate('document.querySelector(".settings-nav.active")?.dataset.section'),
      "about",
    );

    await settingsContext.evaluate('document.querySelector(\'.settings-nav[data-section="launcher"]\').click()');
    await settingsContext.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "launcher"', 5000);
    await settingsContext.waitFor('!document.querySelector(".settings-page-loading")', 5000);
    await settingsContext.waitFor(
      '!!document.querySelector(\'[data-setting-id="appearance.disable_ime_on_navigate"]\')',
      5000,
    );
    const navigateIme = await settingsContext.evaluate(`(() => {
      const row = document.querySelector('[data-setting-id="appearance.disable_ime_on_navigate"]');
      const toggle = row?.querySelector('button[role="switch"]');
      return {
        present: !!toggle,
        checked: toggle?.getAttribute("aria-checked"),
        summary: row?.querySelector(".settings-row-summary")?.textContent.trim() ?? "",
      };
    })()`);
    t.check(
      "Navigate IME opt-in is visible and defaults off",
      navigateIme.present && navigateIme.checked === "false" && navigateIme.summary.length > 0,
      navigateIme,
    );
    await settingsContext.evaluate(
      'document.querySelector(\'[data-setting-id="appearance.disable_ime_on_navigate"] button[role="switch"]\')?.click()',
    );
    await settingsContext.waitFor(
      'document.querySelector(\'[data-setting-id="appearance.disable_ime_on_navigate"] button[role="switch"]\')?.getAttribute("aria-checked") === "true"',
      5000,
    );
    const navigateImeOn = await settingsContext.waitFor(
      'window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.appearance.disable_ime_on_navigate === true)',
      5000,
    );
    t.check("Navigate IME setting persists when enabled", navigateImeOn);
    const directInput = await t.waitFor(
      'document.getElementById("search-input")?.readOnly === true',
      5000,
    );
    t.check("Navigate search uses direct input while IME is disabled", directInput);
    await settingsContext.evaluate(
      'document.querySelector(\'[data-setting-id="appearance.disable_ime_on_navigate"] button[role="switch"]\')?.click()',
    );
    const navigateImeOff = await settingsContext.waitFor(
      'window.__TAURI_INTERNALS__.invoke("get_settings").then((s) => s.appearance.disable_ime_on_navigate === false)',
      5000,
    );
    t.check("Navigate IME setting restores the default-off state", navigateImeOff);
    const nativeImeRestored = await t.waitFor(
      'document.getElementById("search-input")?.readOnly === false',
      5000,
    );
    t.check("turning the setting off restores the native input field", nativeImeRestored);

    await settingsContext.evaluate('document.querySelector(\'.settings-nav[data-section="clipboard"]\').click()');
    await settingsContext.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "clipboard"', 5000);
    await settingsContext.waitFor('!document.querySelector(".settings-page-loading")', 5000);
    const clipboardGroups = await settingsContext.evaluate(
      '[...document.querySelectorAll(".settings-grouptitle")].map((item) => item.textContent.trim())',
    );
    t.check("clipboard pane renders grouped settings", clipboardGroups.length >= 2, clipboardGroups);
    await t.screenshot("settings-clipboard", settings);

    await settingsContext.evaluate('document.querySelector(\'.settings-nav[data-section="search"]\').click()');
    await settingsContext.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "search"', 5000);
    await settingsContext.waitFor('!document.querySelector(".settings-page-loading")', 5000);
    await settingsContext.waitFor(
      '!document.querySelector(\'[data-setting-id="index.full_drive_search"] button[role="switch"]\')?.disabled',
      5000,
    );
    const maintenance = await settingsContext.evaluate(`[
      ...document.querySelectorAll(".settings-index-maintenance button")
    ].map((button) => ({
      id: button.dataset.settingId,
      text: button.textContent.trim(),
      hasIcon: !!button.querySelector("img,svg"),
    }))`);
    t.deepEqual(
      "index maintenance exposes two text-only actions",
      maintenance.map((button) => button.id),
      ["action.refresh_index", "action.rebuild_index"],
    );
    t.check(
      "index maintenance actions use labels instead of icons",
      maintenance.every((button) => button.text.length > 0 && !button.hasIcon),
      maintenance,
    );
    const fullDrive = await settingsContext.evaluate(`(() => {
      const row = document.querySelector('[data-setting-id="index.full_drive_search"]');
      const group = document.querySelector('[data-setting-id="index.full_drive_group"]');
      const systemGroup = document.querySelector('[data-setting-id="index.system_dirs"]');
      const userGroup = document.querySelector('[data-setting-id="index.user_index_group"]');
      const toggle = row?.querySelector('button[role="switch"]');
      const summary = row?.querySelector(".settings-row-summary");
      const summaryStyle = summary ? getComputedStyle(summary) : null;
      return {
        present: !!toggle,
        checked: toggle?.getAttribute("aria-checked"),
        standalone: !!group?.contains(row) && !systemGroup?.contains(row),
        afterUserIndex: userGroup?.nextElementSibling === group,
        summarySingleLine: !!summary &&
          summaryStyle?.whiteSpace === "nowrap" &&
          summary.scrollHeight <= summary.clientHeight + 1,
      };
    })()`);
    t.check(
      "whole-drive search is an explicit opt-in switch",
      fullDrive.present && fullDrive.checked === "false",
      fullDrive,
    );
    t.check(
      "whole-drive search is a standalone group after user index with a single-line hint",
      fullDrive.standalone && fullDrive.afterUserIndex && fullDrive.summarySingleLine,
      fullDrive,
    );
    const svcStatus = await t.invoke("svc_status");
    await settingsContext.evaluate(
      'document.querySelector(\'[data-setting-id="index.full_drive_search"] button[role="switch"]\')?.click()',
    );
    if (svcStatus?.installed === true) {
      const enabled = await settingsContext.waitFor(
        'document.querySelector(\'[data-setting-id="index.full_drive_search"] button[role="switch"]\')?.getAttribute("aria-checked") === "true"',
        5000,
      );
      t.check("whole-drive search can enable after service registration", enabled, svcStatus);
      await settingsContext.evaluate(
        'document.querySelector(\'[data-setting-id="index.full_drive_search"] button[role="switch"]\')?.click()',
      );
      await settingsContext.waitFor(
        'document.querySelector(\'[data-setting-id="index.full_drive_search"] button[role="switch"]\')?.getAttribute("aria-checked") === "false"',
        5000,
      );
    } else {
      await settingsContext.waitFor('!!document.querySelector(".settings-confirm")', 5000);
      const intercepted = await settingsContext.evaluate(`({
        modal: !!document.querySelector(".settings-confirm"),
        checked: document.querySelector('[data-setting-id="index.full_drive_search"] button[role="switch"]')?.getAttribute("aria-checked"),
      })`);
      t.check(
        "whole-drive search is blocked with a registration prompt when the service is absent",
        intercepted.modal && intercepted.checked === "false",
        { ...intercepted, svcStatus },
      );
      await settingsContext.evaluate('document.querySelector(".settings-confirm-actions button:last-child")?.click()');
      await settingsContext.waitFor('!document.querySelector(".settings-confirm")', 5000);
    }
    const nativeFileSearch = await t.invoke("file_search", { query: "lume" });
    t.check(
      "Navigate file search stays disabled until whole-drive indexing is enabled",
      nativeFileSearch?.backend === "none" && nativeFileSearch?.entries?.length === 0,
      nativeFileSearch,
    );
    await settingsContext.evaluate(
      'document.querySelector(\'[data-setting-id="action.rebuild_index"]\').click()',
    );
    await settingsContext.waitFor('!!document.querySelector(".settings-confirm")', 5000);
    t.check(
      "rebuild action asks for destructive confirmation",
      await settingsContext.evaluate('!!document.querySelector(".settings-confirm .settings-confirm-actions button")'),
    );
    await t.sleep(220);
    const confirmLayout = await settingsContext.evaluate(`(() => {
      const overlay = document.querySelector(".settings-confirm-overlay");
      const dialog = document.querySelector(".settings-confirm");
      const overlayRect = overlay?.getBoundingClientRect();
      const rect = dialog?.getBoundingClientRect();
      const style = dialog ? getComputedStyle(dialog) : null;
      return {
        overlayPosition: overlay ? getComputedStyle(overlay).position : "",
        overlayCoversViewport: !!overlayRect &&
          overlayRect.left <= 0.5 &&
          overlayRect.top <= 0.5 &&
          overlayRect.right >= innerWidth - 0.5 &&
          overlayRect.bottom >= innerHeight - 0.5,
        centerX: rect ? Math.abs(rect.left + rect.width / 2 - innerWidth / 2) : Infinity,
        centerY: rect ? Math.abs(rect.top + rect.height / 2 - innerHeight / 2) : Infinity,
        width: rect?.width ?? 0,
        display: style?.display ?? "",
        background: style?.backgroundColor ?? "",
        borderStyle: style?.borderStyle ?? "",
        shadow: style?.boxShadow ?? "",
      };
    })()`);
    t.check(
      "settings confirmations render as a centered, styled modal",
      confirmLayout.overlayPosition === "fixed" &&
        confirmLayout.overlayCoversViewport &&
        confirmLayout.centerX <= 1 &&
        confirmLayout.centerY <= 1 &&
        confirmLayout.width >= 300 &&
        confirmLayout.display === "flex" &&
        confirmLayout.background !== "rgba(0, 0, 0, 0)" &&
        confirmLayout.borderStyle === "solid" &&
        confirmLayout.shadow !== "none",
      confirmLayout,
    );
    await settingsContext.evaluate('document.querySelector(".settings-confirm-actions button:last-child")?.click()');
    await settingsContext.waitFor('!document.querySelector(".settings-confirm")', 5000);
    const rebuilt = await settingsContext.evaluate(
      'window.__TAURI_INTERNALS__.invoke("rebuild_index").then(() => true).catch(() => false)',
    );
    const dataDir = join(t.runtimeDir, "data");
    t.check(
      "rebuild_index recreates all local index databases",
      rebuilt &&
        existsSync(join(dataDir, "user_cache.db")) &&
        existsSync(join(dataDir, "system32_cache.db")) &&
        existsSync(join(dataDir, "icons.db")),
      { rebuilt, dataDir },
    );
    await settingsContext.evaluate(
      'document.querySelector(\'[data-setting-id="index.full_drive_group"]\')?.scrollIntoView({ block: "center" }); true',
    );
    await t.sleep(100);
    await t.screenshot("settings-search-index", settings);

    await settingsContext.evaluate('window.__settingsWarmProbe = "first"; true');
    await t.invoke("close_settings");
    await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "settings" }).then((visible) => !visible)',
      5000,
    );
    t.check("close_settings hides the settings window", true);

    const reopenedSettings = await t.openSettings();
    const warmReopen = await reopenedSettings.evaluate('window.__settingsWarmProbe');
    t.equal("recent settings reopen reuses the warm page", warmReopen, "first");
    await t.invoke("close_settings");

    let reopenCyclesOk = true;
    for (let cycle = 0; cycle < 10; cycle++) {
      await t.invoke("open_settings");
      await t.waitFor(
        'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "settings" })',
        5000,
      );
      const visible = await reopenedSettings.waitFor(
        'document.visibilityState === "visible" && !!document.querySelector(".settings-page-content")',
        5000,
      );
      await t.invoke("close_settings");
      await t.waitFor(
        'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "settings" }).then((value) => !value)',
        5000,
      );
      if (!visible) {
        reopenCyclesOk = false;
        break;
      }
    }
    t.check("10 settings open/close cycles preserve the page and visibility", reopenCyclesOk);
    await t.sleep(2500);
    const destroyed = await t.evaluate(`window.__TAURI_INTERNALS__
      .invoke("plugin:window|is_visible", { label: "settings" })
      .then(() => false)
      .catch(() => true)`);
    t.check("idle settings webview is destroyed after its warm window", destroyed === true, destroyed);
    const coldSettings = await t.openSettings();
    const coldReopen = await coldSettings.evaluate('typeof window.__settingsWarmProbe');
    t.equal("settings reopen after idle destroy rebuilds the page", coldReopen, "undefined");
    await t.invoke("close_settings");
  },
};
