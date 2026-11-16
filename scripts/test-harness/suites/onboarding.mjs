import { readFileSync } from "node:fs";
import { join } from "node:path";

export default {
  id: "onboarding",
  description: "Independent welcome window, launcher lessons, settings autostart decision and replay",
  tags: ["ui", "onboarding"],
  firstRun: true,
  async run(t) {
    const welcome = await t.session.welcome();
    const welcomeVisible = await welcome.connection.invoke("plugin:window|is_visible", {
      label: "welcome",
    });
    const mainHidden = await t.main
      .invoke("plugin:window|is_visible", { label: "main" })
      .then((visible) => !visible);
    t.check("first run opens the welcome window", welcomeVisible);
    t.check("first run keeps the launcher hidden behind the welcome", mainHidden);
    t.check(
      "welcome explains shortcut summoning",
      await welcome.connection.evaluate(
        '!!document.querySelector("#welcome-title") && !!document.querySelector("#welcome-continue")',
      ),
    );
    await t.screenshot("welcome-first-run", welcome.connection);

    await welcome.connection.evaluate('document.getElementById("welcome-continue").click()');
    await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" })',
      8000,
    );
    await t.waitFor('!!document.querySelector(".onboarding-coach[data-step=\\"2\\"]")', 8000);
    t.check("welcome hands off to the mode lesson", true);
    await t.screenshot("launcher-mode-lesson");

    const beforeMode = await t.evaluate('document.querySelector(".mode-switch-item.active")?.textContent?.trim() ?? ""');
    await t.evaluate(`(() => {
      const input = document.getElementById("search-input");
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }));
      return true;
    })()`);
    await t.waitFor('!!document.querySelector(".onboarding-coach[data-step=\\"3\\"]")', 5000);
    const afterMode = await t.evaluate('document.querySelector(".mode-switch-item.active")?.textContent?.trim() ?? ""');
    t.check("Tab advances to the Settings lesson", beforeMode !== afterMode, {
      beforeMode,
      afterMode,
    });

    await t.evaluate('document.getElementById("onboarding-open-settings").click()');
    const settings = await t.session.settings();
    await settings.connection.waitFor(
      '!!document.querySelector(".settings-nav.active[data-section=\\"system\\"]")',
      8000,
    );
    t.check(
      "Settings route opens the System page with the autostart lesson",
      await settings.connection.evaluate('!!document.getElementById("settings-onboarding-card")'),
    );
    await settings.connection.waitFor(
      '!!document.querySelector("#onboarding-autostart-done, #onboarding-autostart-decline-settings:not(:disabled)")',
      5000,
    );
    await t.screenshot("settings-autostart-lesson", settings.connection);

    await settings.connection.invoke("close_settings");
    await t.ensureLauncherVisible();
    await t.waitFor(`!!document.querySelector('.onboarding-coach[data-step="4"]')`, 5000);
    t.check("closing Settings resumes the final lesson in the launcher", true);
    await t.evaluate('document.getElementById("onboarding-open-settings").click()');
    await settings.connection.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "settings" })',
      8000,
    );
    await settings.connection.waitFor(
      '!!document.getElementById("settings-onboarding-card")',
      5000,
    );

    const autostartAlreadyOn = await settings.connection.evaluate(
      `!!document.querySelector('button[role="switch"][aria-label]')?.classList.contains("on")`,
    );
    const chosen = await settings.connection.evaluate(`(() => {
      const finish = document.getElementById("onboarding-autostart-done");
      if (finish) { finish.click(); return "enabled"; }
      const decline = document.getElementById("onboarding-autostart-decline-settings");
      if (decline) { decline.click(); return "declined"; }
      return null;
    })()`);
    await settings.connection.waitFor(
      '!document.getElementById("settings-onboarding-card")',
      5000,
    );
    t.check(
      "the autostart lesson records an explicit choice",
      chosen === (autostartAlreadyOn ? "enabled" : "declined"),
      { autostartAlreadyOn, chosen },
    );

    const completed = await t.invoke("onboarding_get");
    t.deepEqual(
      "onboarding completes after the autostart decision",
      completed,
      { status: "completed", step: 4, replay: false },
    );
    const persisted = JSON.parse(
      readFileSync(join(t.runtimeDir, "data", "onboarding.json"), "utf8"),
    );
    t.check(
      "completed onboarding is persisted independently of settings",
      persisted.status === "completed" &&
        persisted.outcome === (autostartAlreadyOn ? "autostart_enabled" : "autostart_declined"),
      persisted,
    );

    await settings.connection.invoke("close_settings");
    await t.ensureLauncherVisible();
    t.check(
      "completed onboarding no longer covers the launcher",
      await t.evaluate('!document.querySelector(".onboarding-coach")'),
    );

    const replaySettings = await t.openSettings();
    await replaySettings.evaluate('document.getElementById("settings-tab-about").click()');
    await replaySettings.waitFor('!!document.querySelector(".settings-about")', 5000);
    await replaySettings.evaluate(
      `document.querySelector('[data-setting-id="about.onboarding"] button').click()`,
    );
    const replay = await t.session.welcome();
    await replay.connection.waitFor('!!document.querySelector(".welcome-window")', 5000);
    t.check(
      "replay opens the welcome window again",
      await replay.connection.invoke("plugin:window|is_visible", { label: "welcome" }),
    );
    await replay.connection.evaluate('document.getElementById("welcome-skip").click()');
    await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" })',
      8000,
    );
    const afterReplay = await t.invoke("onboarding_get");
    t.deepEqual(
      "abandoning a replay preserves the durable completed state",
      afterReplay,
      { status: "completed", step: 4, replay: false },
    );
    t.check(
      "skipping replay does not show the coach",
      await t.evaluate('!document.querySelector(".onboarding-coach")'),
    );
  },
};
