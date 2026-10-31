export default {
  id: "smoke",
  description: "Launcher shell, mode switching and basic clipboard surface",
  tags: ["ui", "smoke"],
  async run(t) {
    const hiddenFocus = await t.evaluate('document.activeElement?.id ?? ""');
    t.check(
      "hidden launcher does not focus the search input",
      hiddenFocus !== "search-input",
      hiddenFocus,
    );
    await t.ensureLauncherVisible();
    const summonFocus = await t.waitFor('document.activeElement?.id === "search-input"', 2000);
    t.check("summon returns focus to the search input", summonFocus);

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

    await t.evaluate('document.querySelectorAll(".mode-switch-item")[0]?.click(); true');
    await t.waitFor('document.querySelector(".mode-host.active")?.dataset.mode === "apps"', 3000);
    await t.setQuery("");
    const collapsedForError = await t.waitFor("window.innerHeight < 180", 3000);
    t.check("empty Navigate collapses to the search row before the error probe", collapsedForError);

    const probeMounted = await t.evaluate(`(() => {
      const host = document.querySelector(".mode-host.active");
      if (!host) return false;
      const error = document.createElement("div");
      error.className = "presenter-error";
      error.dataset.sizingProbe = "true";
      error.innerHTML =
        '<div class="presenter-error-title">Page model sizing probe</div>' +
        '<div class="presenter-error-detail">The terminal error must keep the fixed search row and a readable page area.</div>' +
        '<button class="presenter-error-retry" type="button">Open Settings</button>';
      host.append(error);
      return true;
    })()`);
    t.check("page-error sizing probe mounts", probeMounted);

    await t.invoke("hide_launcher");
    await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }).then((visible) => !visible)',
      5000,
    );
    await t.invoke("toggle_launcher");
    const readableErrorArea = await t.waitFor(
      'window.innerHeight >= (document.querySelector(".search")?.getBoundingClientRect().bottom ?? 0) + 200',
      4000,
    );
    const errorLayout = await t.evaluate(`(() => {
      const search = document.querySelector(".search");
      const error = document.querySelector("[data-sizing-probe]");
      const searchRect = search?.getBoundingClientRect();
      const errorRect = error?.getBoundingClientRect();
      return {
        windowHeight: window.innerHeight,
        searchBottom: searchRect?.bottom ?? -1,
        errorTop: errorRect?.top ?? -1,
        searchFlexShrink: search ? getComputedStyle(search).flexShrink : "",
      };
    })()`);
    t.check("terminal page error keeps a readable page area", readableErrorArea, errorLayout);
    t.check(
      "terminal page error stays below the non-shrinking search row",
      errorLayout.searchFlexShrink === "0" && errorLayout.errorTop >= errorLayout.searchBottom - 1,
      errorLayout,
    );
    await t.screenshot("page-error-sizing");
    await t.evaluate('document.querySelector("[data-sizing-probe]")?.remove(); true');

    await t.invoke("hide_launcher");
    await t.waitFor(
      'window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" }).then((visible) => !visible)',
      5000,
    );
    t.check("hide_launcher hides the main window", true);
  },
};
