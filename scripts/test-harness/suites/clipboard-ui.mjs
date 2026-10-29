export default {
  id: "clipboard-ui",
  description: "Clipboard surface, pause acknowledgement and clear confirmation",
  tags: ["ui", "clipboard"],
  async run(t) {
    await t.ensureLauncherVisible();
    await t.evaluate(
      'window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true }))',
    );
    await t.waitFor('!!document.querySelector(".clip-page")', 8000);
    await t.waitFor('document.querySelectorAll(".clip-cat").length >= 4', 8000);

    const categories = await t.evaluate(
      '[...document.querySelectorAll(".clip-cat")].map((item) => item.textContent.trim())',
    );
    t.check("clipboard categories render", categories.length >= 4, categories);
    const initialSurface = await t.evaluate(`({
      rows: document.querySelectorAll(".clip-row").length,
      empty: !!document.querySelector(".clip-empty"),
    })`);
    t.check(
      "history surface renders rows or the empty state",
      initialSurface.rows > 0 || initialSurface.empty,
      initialSurface,
    );

    const pauseBefore = await t.evaluate('document.querySelector(".clip-status-btn")?.classList.contains("paused") === true');
    await t.evaluate('document.querySelector(".clip-status-btn")?.click()');
    await t.waitFor(
      'document.querySelector(".clip-status-btn")?.classList.contains("paused") === true',
      5000,
    );
    t.check("pause button receives backend acknowledgement", pauseBefore === false);
    await t.evaluate('document.querySelector(".clip-status-btn")?.click()');
    await t.waitFor(
      'document.querySelector(".clip-status-btn")?.classList.contains("paused") === false',
      5000,
    );
    t.check("pause button resumes recording", true);

    await t.evaluate('document.querySelector(".clip-clear-btn")?.click()');
    await t.waitFor('!!document.querySelector(".clip-confirm")', 5000);
    const confirm = await t.evaluate(`({
      modal: document.querySelector(".clip-confirm")?.getAttribute("aria-modal"),
      cancelFocused: document.activeElement === document.querySelector(".clip-confirm-cancel"),
      hasKeepPinned: !!document.querySelector(".clip-confirm input[type=checkbox]"),
    })`);
    t.check(
      "clear confirmation is modal, focuses the safe action and offers keep-pinned",
      confirm.modal === "true" && confirm.cancelFocused && confirm.hasKeepPinned,
      confirm,
    );
    await t.evaluate('document.querySelector(".clip-confirm-cancel")?.click()');
    await t.waitFor('!document.querySelector(".clip-confirm")', 5000);
    t.check("clear confirmation cancel leaves the page usable", true);
    await t.screenshot("clipboard-empty");
  },
};
