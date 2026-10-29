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

    await t.invoke("close_settings");
    await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "settings" }).then((visible) => !visible)',
      5000,
    );
    t.check("close_settings hides the settings window", true);
  },
};
