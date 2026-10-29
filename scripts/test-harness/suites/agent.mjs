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

    const toggleState = (id) => evaluate(`(() => {
      const row = document.querySelector('[data-setting-id=${JSON.stringify(id)}]');
      const toggle = row?.querySelector('.settings-toggle');
      return {
        found: !!toggle,
        checked: toggle?.getAttribute('aria-checked') === 'true' || toggle?.classList.contains('on') === true,
        disabled: toggle?.disabled === true || row?.classList.contains('disabled') === true,
      };
    })()`);

    const useAgent = await toggleState("automation.use_agent");
    const resident = await toggleState("automation.agent_resident");
    const stored = await invoke("get_settings");
    const status = await invoke("agent_status");
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

    await evaluate('document.querySelector(\'.settings-nav[data-section="system"]\').click()');
    await settings.waitFor('document.querySelector(".settings-nav.active")?.dataset.section === "system"', 5000);
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
