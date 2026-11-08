export default {
  id: "agent",
  description: "Elevation-agent settings, status shape and fail-closed registration gate",
  tags: ["ui", "settings", "agent"],
  extraFiles: ["lume-agent.exe"],
  async run(t) {
    const settings = await t.openSettings();
    const evaluate = (expression, options) => settings.evaluate(expression, options);
    const invoke = (command, args, options) => settings.invoke(command, args, options);

    await evaluate('document.querySelector(\'.settings-nav[data-section="automation"]\').click()');
    await settings.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "automation"', 5000);
    await settings.waitFor(
      '!document.querySelector(".settings-page-loading") && !!document.querySelector(\'[data-setting-id="automation.use_agent"]\')',
      5000,
    );

    const toggleState = (id) => evaluate(`(() => {
      const row = document.querySelector('[data-setting-id=${JSON.stringify(id)}]');
      const toggle = row?.querySelector('.settings-toggle');
      return {
        found: !!toggle,
        checked: toggle?.getAttribute('aria-checked') === 'true' || toggle?.classList.contains('on') === true,
        disabled: toggle?.disabled === true || row?.classList.contains('disabled') === true,
      };
    })()`);

    const stored = await invoke("get_settings");
    const status = await invoke("agent_status");
    if (status?.installed === true && stored?.automation?.use_agent === true) {
      await settings.waitFor(
        'document.querySelector(\'[data-setting-id="automation.use_agent"] .settings-toggle\')?.getAttribute("aria-checked") === "true"',
        5000,
      );
    }
    const useAgent = await toggleState("automation.use_agent");
    const resident = await toggleState("automation.agent_resident");
    t.check("agent switches render in Automation", useAgent.found && resident.found, { useAgent, resident });
    t.check(
      "stored agent preference is on-demand and not resident",
      stored?.automation?.use_agent === true && stored?.automation?.agent_resident === false,
      stored?.automation,
    );
    t.check(
      "use-agent switch fails closed until registration is confirmed",
      status?.installed === true ? useAgent.checked === stored?.automation?.use_agent : useAgent.checked === false,
      { installed: status?.installed, useAgent, preferred: stored?.automation?.use_agent },
    );
    t.check(
      "resident switch is unavailable without an effective agent",
      status?.installed === true ? resident.found : resident.found && resident.disabled && resident.checked === false,
      { installed: status?.installed, resident },
    );

    await evaluate('document.querySelector(\'[data-setting-id="automation.use_agent"] .settings-help-btn\')?.click()');
    await settings.waitFor('!!document.querySelector(".settings-help-dialog-body")', 5000);
    const helpText = await evaluate(
      '[...document.querySelectorAll(".settings-help-dialog-body")].map((node) => node.textContent).join(" ")',
    );
    t.check("the UIPI boundary is explained to the user", helpText.includes("UIPI"), helpText);
    await evaluate('document.querySelector(".settings-help-backdrop")?.click()');
    await settings.waitFor('!document.querySelector(".settings-help-dialog")', 5000);

    await evaluate(`(() => {
      const add = document.querySelector(".settings-rule-add");
      if (add) add.open = true;
      document.querySelector(".settings-pick-btn")?.click();
      return true;
    })()`);
    await settings.waitFor('!!document.querySelector(".picker-backdrop .picker")', 5000);
    await t.sleep(220);
    const pickerLayout = await evaluate(`(() => {
      const overlay = document.querySelector(".picker-backdrop");
      const picker = document.querySelector(".picker");
      const overlayRect = overlay?.getBoundingClientRect();
      const rect = picker?.getBoundingClientRect();
      const style = picker ? getComputedStyle(picker) : null;
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
      "program picker renders as a centered, styled settings modal",
      pickerLayout.overlayPosition === "fixed" &&
        pickerLayout.overlayCoversViewport &&
        pickerLayout.centerX <= 1 &&
        pickerLayout.centerY <= 1 &&
        pickerLayout.width >= 400 &&
        pickerLayout.display === "flex" &&
        pickerLayout.background !== "rgba(0, 0, 0, 0)" &&
        pickerLayout.borderStyle === "solid" &&
        pickerLayout.shadow !== "none",
      pickerLayout,
    );
    await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); true');
    await settings.waitFor('!document.querySelector(".picker-backdrop")', 5000);

    await evaluate('document.querySelector(\'.settings-nav[data-section="system"]\').click()');
    await settings.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "system"', 5000);
    await settings.waitFor(
      '!document.querySelector(".settings-page-loading") && !!document.querySelector(\'[data-setting-id="system.agent"]\')',
      5000,
    );
    const system = await evaluate(`(() => ({
      groups: [...document.querySelectorAll(".settings-grouptitle")].map((node) => node.textContent.trim()),
      tickets: [...document.querySelectorAll(".settings-status-ticket")].map((node) => ({
        id: node.dataset.settingId,
        title: node.querySelector("strong")?.textContent.trim(),
        status: node.querySelector(".settings-status-ticket-state")?.textContent.trim(),
        button: node.querySelector("button.settings-action")?.textContent.trim(),
      })),
      hints: [...document.querySelectorAll('[data-setting-id="system.agent"] .settings-row-summary')]
        .map((node) => node.textContent.trim()),
    }))()`);
    const agentTicket = system.tickets.find((ticket) => ticket.id === "system.agent");
    t.check(
      "System pane exposes service and agent tickets",
      system.tickets.some((ticket) => ticket.id === "system.service") && !!agentTicket,
    );
    t.check(
      "agent ticket has status and a registration action",
      !!agentTicket?.status && !!agentTicket?.button,
      agentTicket,
    );
    t.check("agent capability limit stays visible", system.hints.some((hint) => hint.length > 0), system.hints);

    t.check(
      "agent_status returns the documented shape",
      typeof status?.installed === "boolean" &&
        typeof status?.running === "boolean" &&
        typeof status?.elevated === "boolean" &&
        typeof status?.sent_total === "number" &&
        status?.task_name === "Lume\\LumeAgent" &&
        typeof status?.idle_exit_secs === "number",
      status,
    );
    t.check(
      "agent_status points at the isolated runtime helper",
      typeof status?.bin_path === "string" && status.bin_path.endsWith("lume-agent.exe"),
      status?.bin_path,
    );
    await t.screenshot("agent-system", settings);
  },
};
