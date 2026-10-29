export default {
  id: "smoke",
  description: "Launcher shell, mode switching and basic clipboard surface",
  tags: ["ui", "smoke"],
  async run(t) {
    await t.ensureLauncherVisible();

    t.check("launcher exposes the search input", await t.evaluate('!!document.getElementById("search-input")'));
    const modes = await t.evaluate(
      '[...document.querySelectorAll(".mode-switch-item")].map((item) => item.textContent.trim())',
    );
    t.check("mode bar renders at least Navigate and Clipboard", modes.length >= 2, modes);

    await t.setQuery("lume");
    t.equal("search input accepts text", await t.evaluate('document.getElementById("search-input").value'), "lume");
    await t.screenshot("launcher-search");

    await t.evaluate(
      'window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }))',
    );
    await t.waitFor('!!document.querySelector(".clip-page")', 8000);
    t.check("Tab opens the Clipboard page", await t.evaluate('!!document.querySelector(".clip-page")'));
    t.check("Clipboard page renders its status bar", await t.evaluate('!!document.querySelector(".clip-statusbar")'));
    await t.screenshot("clipboard-shell");

    await t.invoke("hide_launcher");
    await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }).then((visible) => !visible)',
      5000,
    );
    t.check("hide_launcher hides the main window", true);
  },
};
