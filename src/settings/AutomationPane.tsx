//! 「自动化」页 — auto-actions: when a configured program opens a new window
//! and takes the foreground, Lume presses the configured hotkey once
//! (settings.rs 自动化 / automation.rs shell-hook watcher).
//!
//! The shortcut is captured with the same press-to-record control the 快捷键
//! page uses (`ComboRecorder`) — typing a combination into a text box would
//! insert no characters, so a recorder is the only workable input.
//!
//! 延迟触发: each rule carries its own `delay_ms` (default 120, max 60000) —
//! the wait after the window takes the foreground before the key is pressed,
//! so slow-starting programs have time to build their UI.

import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { ConfirmState, SettingsData } from "./types";
import {
  createToastNotice,
  SettingGroup,
  SettingRow,
  ToastNotice,
  Toggle,
} from "./controls";
import { ComboRecorder } from "./ComboRecorder";
import { ProgramPicker } from "./ProgramPicker";
import { settingsError } from "./errors";
import deleteIcon from "../../res/icons/delete.svg";

/** The slice of `agent_status` this page needs: `installed` = the helper's
 * scheduled task is registered, i.e. the agent can be started on demand. */
interface AgentStatus {
  installed: boolean;
}

/** Result of 自动化 → 「测试」 (mirrors `TestRuleResult` in automation.rs). */
interface TestRuleResult {
  ok: boolean;
  reason: string | null;
  detail: string;
}

/** The rule's default 延迟触发 when a value is missing from the settings file. */
const DEFAULT_DELAY_MS = 120;
/** Upper bound mirrored from the Rust clamp (settings::MAX_ACTION_DELAY_MS). */
const MAX_DELAY_MS = 60_000;

type Action = SettingsData["automation"]["actions"][number];

/** A compact 延迟触发 number field (milliseconds, clamped to the supported
 * range). While editing, the raw string is preserved so clearing the field does
 * not immediately become `0`; validation runs on blur / Enter. */
function DelayInput(props: {
  value: number;
  onChange: (ms: number) => void;
  label: string;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [text, setText] = createSignal(String(props.value));
  const [editing, setEditing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  createEffect(() => {
    if (!editing()) setText(String(props.value));
  });

  function commit() {
    const raw = text().trim();
    const n = Number(raw);
    if (!raw || !Number.isFinite(n) || n < 0 || n > MAX_DELAY_MS) {
      setError(t("autoDelayInvalid"));
      props.onValidityChange?.(false);
      return;
    }
    const value = Math.round(n);
    setError(null);
    props.onValidityChange?.(true);
    setText(String(value));
    props.onChange(value);
  }

  return (
    <span class="settings-delay-wrap">
      <span class="settings-delay" title={t("autoDelayTitle")}>
        <input
          class="settings-delay-input"
          type="number"
          min={0}
          max={MAX_DELAY_MS}
          step={50}
          value={text()}
          aria-label={props.label}
          aria-invalid={!!error()}
          onFocus={() => setEditing(true)}
          onInput={(e) => {
            setText(e.currentTarget.value);
            setError(null);
            const raw = e.currentTarget.value.trim();
            const n = Number(raw);
            props.onValidityChange?.(
              raw !== "" && Number.isFinite(n) && n >= 0 && n <= MAX_DELAY_MS,
            );
          }}
          onBlur={() => {
            commit();
            setEditing(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              e.currentTarget.blur();
            }
          }}
        />
        <span class="settings-delay-unit">{t("autoDelayUnit")}</span>
      </span>
      <Show when={error()}>
        <span class="settings-error" role="alert">{error()}</span>
      </Show>
    </span>
  );
}

export default function AutomationPane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["automation"]>) => void;
  onOpenSystem: () => void;
  /** Settings-window modal (title/hint/primary action), rendered by the shell. */
  requestConfirm: (state: ConfirmState) => void;
}) {
  const automation = () => props.settings.automation;

  /** Draft for the "add rule" row: program text + recorded shortcut + delay. */
  const [process, setProcess] = createSignal("");
  const [combo, setCombo] = createSignal("");
  const [delayMs, setDelayMs] = createSignal(DEFAULT_DELAY_MS);
  const [delayValid, setDelayValid] = createSignal(true);
  /** 选择 — the running-programs picker is open. */
  const [picking, setPicking] = createSignal(false);
  /** The button that opened the picker; focus returns here on close. */
  let pickTrigger: HTMLButtonElement | undefined;
  /** 测试 / 代理预检 — 底部提示条状态（4s 自动消失）。 */
  const { state: toast, showToast } = createToastNotice();
  const [addError, setAddError] = createSignal<string | null>(null);
  const [duplicateIndex, setDuplicateIndex] = createSignal<number | null>(null);
  const [highlightIndex, setHighlightIndex] = createSignal<number | null>(null);
  const [expandedRules, setExpandedRules] = createSignal<Record<number, boolean>>({});
  /** 使用提权代理 — the registration check is in flight (switch disabled). */
  const [agentCheckBusy, setAgentCheckBusy] = createSignal(false);
  /** Registration state of the helper (`agent_status`), `null` = unknown yet.
   * Drives the row's summary when the stored value is on without it. */
  const [agentInstalled, setAgentInstalled] = createSignal<boolean | null>(null);
  let rowRefs: Record<string, HTMLElement | undefined> = {};

  /** The stored preference only takes effect once `agent_status` confirms the
   * scheduled task is registered. Unknown/unregistered states are fail-closed,
   * so the switch is off until the OS says the helper can run. */
  const agentEnabled = () =>
    agentInstalled() === true && (automation().use_agent ?? true);

  /** Refresh the helper's registration state (the switch and row summary). */
  async function refreshAgentInstalled() {
    // Only the "on but unregistered" state needs this answer — skip the probe
    // (a sync `schtasks /Query` behind `agent_status`) while the preference is off.
    if (!(automation().use_agent ?? true)) return;
    try {
      setAgentInstalled((await invoke<AgentStatus>("agent_status")).installed);
    } catch (err) {
      // Fail soft and fail closed: the switch remains off, while the
      // turn-on path reports its own failure.
      console.error("[settings] agent_status", err);
      setAgentInstalled(null);
    }
  }

  onMount(() => {
    void refreshAgentInstalled();
  });

  /** 「使用提权代理」 is only honest while the helper is registered: the switch
   * asks the OS first (`agent_status` → the scheduled task) and refuses to turn
   * on otherwise, pointing at the 系统 page where registration lives (one UAC
   * prompt). Turning it off never asks. */
  async function toggleUseAgent(value: boolean) {
    if (!value) {
      props.onChange({ use_agent: false });
      return;
    }
    if (agentCheckBusy()) return;
    setAgentCheckBusy(true);
    try {
      const status = await invoke<AgentStatus>("agent_status");
      setAgentInstalled(status.installed);
      if (!status.installed) {
        props.requestConfirm({
          title: t("autoUseAgentUnregisteredTitle"),
          hint: t("autoUseAgentUnregisteredHint"),
          confirmLabel: t("autoUseAgentOpenSystem"),
          action: async () => {
            props.onOpenSystem();
          },
        });
        return;
      }
      props.onChange({ use_agent: true });
    } catch (err) {
      showToast(settingsError(err, "autoUseAgentCheckFailed"), false);
    } finally {
      setAgentCheckBusy(false);
    }
  }

  /** 测试: fire this rule right now, ignoring the new-window trigger and the
   * rule's delay, so it can be checked against an already-running program. */
  async function testRule(action: Action) {
    try {
      const res = await invoke<TestRuleResult>("test_automation_rule", {
        process: action.process,
        combo: action.combo,
      });
      if (res.ok) {
        showToast(t("autoTestSent", { combo: action.combo, target: res.detail }));
        return;
      }
      // Every failure gets its own wording: the elevation reasons are the ones
      // a user can actually act on (register the helper, or enable it).
      const key =
        res.reason === "not_running"
          ? "autoTestNotRunning"
          : res.reason === "focus_failed"
            ? "autoTestFocusFailed"
            : res.reason === "needs_agent"
              ? "autoTestNeedsAgent"
              : res.reason === "unavailable"
                ? "autoTestAgentUnavailable"
                : res.reason === "blocked" || res.reason === "uipi"
                  ? "autoTestBlocked"
                  : res.reason === "focus_moved"
                    ? "autoTestFocusMoved"
                    : "autoTestInvalid";
      showToast(t(key, { process: res.detail, combo: action.combo }), false);
    } catch (err) {
      showToast(settingsError(err, "autoTestFailed"), false);
    }
  }

  function addAction() {
    const p = process().trim();
    const c = combo();
    if (!p || !c) return;
    if (!delayValid()) {
      setAddError(t("autoDelayInvalid"));
      return;
    }
    const actions = automation().actions ?? [];
    const duplicate = actions.findIndex(
      (a) => a.process.toLowerCase() === p.toLowerCase(),
    );
    if (duplicate >= 0) {
      setDuplicateIndex(duplicate);
      setAddError(t("autoDuplicate", { process: p }));
      jumpToRule(duplicate);
      return;
    }
    props.onChange({
      actions: [...actions, { process: p, combo: c, enabled: true, delay_ms: delayMs() }],
    });
    setAddError(null);
    setDuplicateIndex(null);
    setProcess("");
    setCombo("");
    setDelayMs(DEFAULT_DELAY_MS);
    setDelayValid(true);
  }

  function jumpToRule(index: number) {
    setHighlightIndex(index);
    const action = automation().actions?.[index];
    if (action) {
      rowRefs[action.process.toLowerCase()]?.scrollIntoView({ block: "nearest" });
      rowRefs[action.process.toLowerCase()]?.focus({ preventScroll: true });
    }
    setTimeout(() => setHighlightIndex(null), 1800);
  }

  function updateAction(idx: number, patch: Partial<Action>) {
    const actions = automation().actions ?? [];
    props.onChange({ actions: actions.map((a, i) => (i === idx ? { ...a, ...patch } : a)) });
  }

  function removeAction(idx: number) {
    const actions = automation().actions ?? [];
    props.onChange({ actions: actions.filter((_, i) => i !== idx) });
  }

  return (
    <>
      <SettingGroup title={t("groupAutomation")} number="06.1">
        <SettingRow
          id="automation.enabled"
          label={t("autoEnabled")}
          summary={t("autoHint")}
        >
          <Toggle
            checked={automation().enabled ?? true}
            label={t("autoEnabled")}
            onChange={(value) => props.onChange({ enabled: value })}
          />
        </SettingRow>
        <SettingRow
          id="automation.force_focus"
          label={t("autoForceFocus")}
          summary={t("settingsForceFocusSummary")}
          details={[t("autoForceFocusHint")]}
        >
          <Toggle
            checked={automation().force_focus ?? false}
            label={t("autoForceFocus")}
            onChange={(value) => props.onChange({ force_focus: value })}
          />
        </SettingRow>
        <SettingRow
          id="automation.use_agent"
          label={t("autoUseAgent")}
          summary={
            !agentEnabled() && agentInstalled() === false
              ? t("autoUseAgentUnregisteredSummary")
              : t("settingsUseAgentSummary")
          }
          details={[t("autoUseAgentHint")]}
        >
          <Toggle
            checked={agentEnabled()}
            label={t("autoUseAgent")}
            disabled={agentCheckBusy()}
            onChange={(value) => void toggleUseAgent(value)}
          />
        </SettingRow>
        <SettingRow
          id="automation.agent_resident"
          label={t("autoAgentResident")}
          summary={
            agentEnabled()
              ? t("settingsResidentSummary")
              : t("autoAgentResidentDependency")
          }
          details={[t("autoAgentResidentHint")]}
          disabled={!agentEnabled()}
        >
          <Toggle
            checked={agentEnabled() && (automation().agent_resident ?? false)}
            label={t("autoAgentResident")}
            disabled={!agentEnabled()}
            onChange={(value) => props.onChange({ agent_resident: value })}
          />
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("autoRulesGroup")} number="06.2">
        <SettingRow
          id="automation.actions"
          label={t("settingsAutomationRulesHint")}
          summary={t("autoNotice")}
          class="settings-editor-row"
        >
          <div class="settings-rule-list">
            <Show
              when={(automation().actions ?? []).length > 0}
              fallback={<div class="settings-empty">{t("autoEmpty")}</div>}
            >
              <For each={automation().actions ?? []}>
                {(action, index) => {
                  const expanded = () => expandedRules()[index()] === true;
                  return (
                    <article
                      ref={(el) => (rowRefs[action.process.toLowerCase()] = el)}
                      class="settings-rule-card"
                      classList={{
                        expanded: expanded(),
                        disabled: !action.enabled,
                        "search-hit": highlightIndex() === index(),
                      }}
                      tabIndex={-1}
                    >
                      <div class="settings-rule-summary-row">
                        <button
                          class="settings-rule-toggle"
                          type="button"
                          aria-expanded={expanded()}
                          aria-controls={`automation-rule-${index()}`}
                          onClick={() =>
                            setExpandedRules((current) => ({
                              ...current,
                              [index()]: !expanded(),
                            }))
                          }
                        >
                          <span class="settings-rule-title">{action.process}</span>
                          <span class="settings-rule-sentence">
                            {action.combo} · {action.delay_ms ?? DEFAULT_DELAY_MS}{" "}
                            {t("autoDelayUnit")}
                          </span>
                          <span class="settings-rule-chevron" aria-hidden="true">
                            {expanded() ? "−" : "+"}
                          </span>
                        </button>
                        <div class="settings-rule-actions">
                          <button
                            class="settings-test-btn"
                            type="button"
                            title={t("autoTestHint")}
                            onClick={() => void testRule(action)}
                          >
                            {t("autoTest")}
                          </button>
                          <Toggle
                            checked={action.enabled}
                            label={t("autoRuleEnabledLabel", { process: action.process })}
                            onChange={(value) => updateAction(index(), { enabled: value })}
                          />
                          <button
                            class="settings-icon-btn settings-rule-delete"
                            type="button"
                            title={t("delete")}
                            aria-label={`${t("delete")}: ${action.process}`}
                            onClick={() => removeAction(index())}
                          >
                            <img class="settings-icon-btn-icon" src={deleteIcon} alt="" draggable={false} />
                          </button>
                        </div>
                      </div>
                      <Show when={expanded()}>
                        <div class="settings-rule-detail" id={`automation-rule-${index()}`}>
                          <label class="settings-rule-field">
                            <span>{t("autoProcessLabel")}</span>
                            <input
                              class="settings-text-input"
                              value={action.process}
                              onChange={(event) =>
                                updateAction(index(), { process: event.currentTarget.value.trim() })
                              }
                            />
                          </label>
                          <label class="settings-rule-field">
                            <span>{t("autoComboLabel")}</span>
                            <ComboRecorder
                              value={action.combo}
                              placeholder={t("autoComboPlaceholder")}
                              label={`${t("autoComboLabel")}: ${action.process}`}
                              onCommit={(value) => updateAction(index(), { combo: value })}
                            />
                          </label>
                          <label class="settings-rule-field settings-rule-delay">
                            {/* 标签只留短名：长句会在窄列里折成两行，把输入框顶下去 */}
                            <span title={t("autoDelayTitle")}>{t("autoDelayLabel")}</span>
                            <DelayInput
                              value={action.delay_ms ?? DEFAULT_DELAY_MS}
                              label={`${t("autoDelayTitle")}: ${action.process}`}
                              onChange={(ms) => updateAction(index(), { delay_ms: ms })}
                            />
                          </label>
                        </div>
                      </Show>
                    </article>
                  );
                }}
              </For>
            </Show>

            <details class="settings-rule-add">
              <summary>{t("autoAdd")}</summary>
              <div class="settings-rule-add-grid">
                <input
                  class="settings-text-input"
                  type="text"
                  placeholder={t("autoProcessPlaceholder")}
                  value={process()}
                  aria-label={t("autoProcessLabel")}
                  onInput={(event) => {
                    setProcess(event.currentTarget.value);
                    setAddError(null);
                    setDuplicateIndex(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addAction();
                    }
                  }}
                />
                <button
                  class="settings-pick-btn"
                  type="button"
                  title={t("autoPickTitle")}
                  onClick={(event) => {
                    pickTrigger = event.currentTarget;
                    setPicking(true);
                  }}
                >
                  {t("autoPick")}
                </button>
                <ComboRecorder
                  value={combo()}
                  placeholder={t("autoComboPlaceholder")}
                  onCommit={setCombo}
                />
                <DelayInput
                  value={delayMs()}
                  label={t("autoDelayTitle")}
                  onValidityChange={setDelayValid}
                  onChange={setDelayMs}
                />
                <button
                  class="settings-action settings-action-primary"
                  type="button"
                  disabled={!process().trim() || !combo() || !delayValid()}
                  onClick={addAction}
                >
                  {t("autoAdd")}
                </button>
              </div>
              <Show when={addError()}>
                <span class="settings-inline-error" role="alert">
                  {addError()}
                  <Show when={duplicateIndex() !== null}>
                    <button
                      type="button"
                      class="settings-link"
                      onClick={() => {
                        const index = duplicateIndex();
                        if (index !== null) jumpToRule(index);
                      }}
                    >
                      {t("autoJumpExisting")}
                    </button>
                  </Show>
                </span>
              </Show>
            </details>
          </div>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t("settingsAgentGroup")} number="06.3">
        <SettingRow
          id="action.agent_status"
          label={t("settingsAgentGroup")}
          summary={t("settingsAgentStatusHint")}
        >
          <button class="settings-action" type="button" onClick={props.onOpenSystem}>
            {t("settingsOpenSystem")}
          </button>
        </SettingRow>
      </SettingGroup>

      <ToastNotice state={toast()} />
      <Show when={picking()}>
        <ProgramPicker
          onPick={setProcess}
          onClose={() => setPicking(false)}
          returnFocus={() => pickTrigger ?? null}
        />
      </Show>
    </>
  );
}
