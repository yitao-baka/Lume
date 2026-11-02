import { existsSync } from "node:fs";
import { join } from "node:path";

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
  description: "Settings window navigation, search surface and clipboard pane",
  tags: ["ui", "settings"],
  async run(t) {
    const settings = await t.openSettings();
    const settingsContext = {
      evaluate: (expression, options) => settings.evaluate(expression, options),
      waitFor: (expression, timeoutMs) => settings.waitFor(expression, timeoutMs),
    };

    const sections = await settingsContext.evaluate(
      '[...document.querySelectorAll(".settings-nav")].map((item) => item.dataset.section)',
    );
    t.deepEqual("settings navigation exposes the current section set", sections, EXPECTED_SECTIONS);
    t.check("settings command search is present", await settingsContext.evaluate('!!document.querySelector(".settings-search-input")'));
    t.check("settings footer exposes restore but no global save", await settingsContext.evaluate(`(() => {
      const buttons = [...document.querySelectorAll(".settings-footer button")];
      return buttons.length === 1 && buttons[0].classList.contains("settings-footer-action");
    })()`));

    await settingsContext.evaluate('document.querySelector(\'.settings-nav[data-section="about"]\').click()');
    await settingsContext.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "about"', 5000);
    t.equal(
      "settings navigation reaches About",
      await settingsContext.evaluate('document.querySelector(".settings-nav.active")?.dataset.section'),
      "about",
    );

    await settingsContext.evaluate('document.querySelector(\'.settings-nav[data-section="clipboard"]\').click()');
    await settingsContext.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "clipboard"', 5000);
    const clipboardGroups = await settingsContext.evaluate(
      '[...document.querySelectorAll(".settings-grouptitle")].map((item) => item.textContent.trim())',
    );
    t.check("clipboard pane renders grouped settings", clipboardGroups.length >= 2, clipboardGroups);
    await t.screenshot("settings-clipboard", settings);

    await settingsContext.evaluate('document.querySelector(\'.settings-nav[data-section="search"]\').click()');
    await settingsContext.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "search"', 5000);
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

    await t.invoke("close_settings");
    await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "settings" }).then((visible) => !visible)',
      5000,
    );
    t.check("close_settings hides the settings window", true);
  },
};
