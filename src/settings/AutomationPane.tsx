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

import { createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { Row, Toggle } from "./controls";
import { ComboRecorder } from "./ComboRecorder";
import { ProgramPicker } from "./ProgramPicker";
import deleteIcon from "../../res/icons/delete.svg";
import plusIcon from "../../res/icons/plus.svg";

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

/** A compact 延迟触发 number field (milliseconds, clamped to the supported range). */
function DelayInput(props: { value: number; onChange: (ms: number) => void }) {
  return (
    <span class="settings-delay" title={t("autoDelayTitle")}>
      <input
        class="settings-delay-input"
        type="number"
        min={0}
        max={MAX_DELAY_MS}
        step={50}
        value={props.value}
        onInput={(e) => {
          const n = Math.round(e.currentTarget.valueAsNumber);
          props.onChange(Number.isFinite(n) ? Math.min(Math.max(n, 0), MAX_DELAY_MS) : 0);
        }}
      />
      <span class="settings-delay-unit">{t("autoDelayUnit")}</span>
    </span>
  );
}

export default function AutomationPane(props: {
  settings: SettingsData;
  onChange: (patch: Partial<SettingsData["automation"]>) => void;
}) {
  const automation = () => props.settings.automation;

  /** Draft for the "add rule" row: program text + recorded shortcut + delay. */
  const [process, setProcess] = createSignal("");
  const [combo, setCombo] = createSignal("");
  const [delayMs, setDelayMs] = createSignal(DEFAULT_DELAY_MS);
  /** 选择 — the running-programs picker is open. */
  const [picking, setPicking] = createSignal(false);
  /** 测试 — result message for the last test press. */
  const [toast, setToast] = createSignal<string | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(text: string) {
    setToast(text);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 4000);
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
      showToast(t(key, { process: res.detail, combo: action.combo }));
    } catch (err) {
      showToast(String(err));
    }
  }

  function addAction() {
    const p = process().trim();
    const c = combo();
    if (!p || !c) return;
    const actions = automation().actions ?? [];
    // De-duplicate by process so a rule never silently duplicates.
    if (actions.some((a) => a.process.toLowerCase() === p.toLowerCase())) return;
    props.onChange({
      actions: [...actions, { process: p, combo: c, enabled: true, delay_ms: delayMs() }],
    });
    setProcess("");
    setCombo("");
    setDelayMs(DEFAULT_DELAY_MS);
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
      <div class="settings-group">
        <Row label={t("autoEnabled")}>
          <Toggle
            checked={automation().enabled ?? true}
            onChange={(v) => props.onChange({ enabled: v })}
          />
        </Row>
        <Row label={t("autoForceFocus")}>
          <Toggle
            checked={automation().force_focus ?? false}
            onChange={(v) => props.onChange({ force_focus: v })}
          />
        </Row>
        <p class="settings-hint">{t("autoForceFocusHint")}</p>
        <Row label={t("autoUseAgent")}>
          <Toggle
            checked={automation().use_agent ?? true}
            onChange={(v) => props.onChange({ use_agent: v })}
          />
        </Row>
        <p class="settings-hint">{t("autoUseAgentHint")}</p>
        <Row label={t("autoAgentResident")}>
          <Toggle
            checked={automation().agent_resident ?? false}
            onChange={(v) => props.onChange({ agent_resident: v })}
          />
        </Row>
        <p class="settings-hint">{t("autoAgentResidentHint")}</p>
        <p class="settings-hint">{t("autoHint")}</p>

        <div class="settings-blocktitle">{t("groupAutomation")}</div>
        <Show
          when={(automation().actions ?? []).length > 0}
          fallback={<span class="settings-empty">{t("autoEmpty")}</span>}
        >
          <For each={automation().actions ?? []}>
            {(action, i) => (
              <div class="settings-row-between settings-listrow">
                <span class="settings-index-name" title={action.process}>{action.process}</span>
                <ComboRecorder
                  value={action.combo}
                  placeholder={t("autoComboPlaceholder")}
                  onCommit={(v) => updateAction(i(), { combo: v })}
                />
                <button
                  class="settings-test-btn"
                  title={t("autoTestHint")}
                  onClick={() => void testRule(action)}
                >
                  {t("autoTest")}
                </button>
                <DelayInput
                  value={action.delay_ms ?? DEFAULT_DELAY_MS}
                  onChange={(ms) => updateAction(i(), { delay_ms: ms })}
                />
                <Toggle
                  checked={action.enabled}
                  onChange={(v) => updateAction(i(), { enabled: v })}
                />
                <button
                  class="settings-icon-btn"
                  title={t("delete")}
                  aria-label={t("delete")}
                  onClick={() => removeAction(i())}
                >
                  <img class="settings-icon-btn-icon" src={deleteIcon} alt="" draggable={false} />
                </button>
              </div>
            )}
          </For>
        </Show>

        <div class="settings-row settings-listadd">
          <input
            class="settings-text-input"
            type="text"
            placeholder={t("autoProcessPlaceholder")}
            value={process()}
            onInput={(e) => setProcess(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addAction();
              }
            }}
          />
          <button
            class="settings-pick-btn"
            title={t("autoPickTitle")}
            onClick={() => setPicking(true)}
          >
            {t("autoPick")}
          </button>
          <ComboRecorder
            value={combo()}
            placeholder={t("autoComboPlaceholder")}
            onCommit={setCombo}
          />
          <DelayInput value={delayMs()} onChange={setDelayMs} />
          <button
            class="settings-icon-btn"
            title={t("autoAdd")}
            aria-label={t("autoAdd")}
            disabled={!process().trim() || !combo()}
            onClick={addAction}
          >
            <img class="settings-icon-btn-icon" src={plusIcon} alt="" draggable={false} />
          </button>
        </div>
        <p class="settings-hint">{t("autoDelayHint")}</p>
        <p class="settings-hint">{t("autoNotice")}</p>
      </div>
      <Show when={toast()}>
        <div class="settings-toast" role="status">{toast()}</div>
      </Show>
      <Show when={picking()}>
        <ProgramPicker onPick={setProcess} onClose={() => setPicking(false)} />
      </Show>
    </>
  );
}