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

import { createEffect, createSignal, For, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";
import type { SettingsData } from "./types";
import { Row, Toggle } from "./controls";
import { ComboRecorder } from "./ComboRecorder";
import { ProgramPicker } from "./ProgramPicker";
import { settingsError } from "./errors";
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
  /** 测试 — result message for the last test press. */
  const [toast, setToast] = createSignal<{ ok: boolean; text: string } | null>(null);
  const [addError, setAddError] = createSignal<string | null>(null);
  const [duplicateIndex, setDuplicateIndex] = createSignal<number | null>(null);
  const [highlightIndex, setHighlightIndex] = createSignal<number | null>(null);
  let rowRefs: Record<string, HTMLDivElement | undefined> = {};
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(text: string, ok = true) {
    setToast({ ok, text });
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
      <div class="settings-group">
        <Row label={t("autoEnabled")}>
          <Toggle
            checked={automation().enabled ?? true}
            label={t("autoEnabled")}
            onChange={(v) => props.onChange({ enabled: v })}
          />
        </Row>
        <Row label={t("autoForceFocus")}>
          <Toggle
            checked={automation().force_focus ?? false}
            label={t("autoForceFocus")}
            onChange={(v) => props.onChange({ force_focus: v })}
          />
        </Row>
        <p class="settings-hint">{t("autoForceFocusHint")}</p>
        <Row label={t("autoUseAgent")}>
          <Toggle
            checked={automation().use_agent ?? true}
            label={t("autoUseAgent")}
            onChange={(v) => props.onChange({ use_agent: v })}
          />
        </Row>
        <p class="settings-hint">{t("autoUseAgentHint")}</p>
        <Row label={t("autoAgentResident")}>
          <Toggle
            checked={automation().agent_resident ?? false}
            label={t("autoAgentResident")}
            disabled={!(automation().use_agent ?? true)}
            onChange={(v) => props.onChange({ agent_resident: v })}
          />
        </Row>
        <p class="settings-hint">
          {t(
            (automation().use_agent ?? true)
              ? "autoAgentResidentHint"
              : "autoAgentResidentDependency",
          )}
        </p>
        <p class="settings-hint">{t("autoHint")}</p>

        <div class="settings-blocktitle">{t("groupAutomation")}</div>
        <div class="settings-automation-head" aria-hidden="true">
          <span>{t("autoProcessLabel")}</span>
          <span>{t("autoComboLabel")}</span>
          <span>{t("autoTest")}</span>
          <span>{t("autoDelayTitle")}</span>
          <span>{t("autoEnabled")}</span>
          <span />
        </div>
        <Show
          when={(automation().actions ?? []).length > 0}
          fallback={<span class="settings-empty">{t("autoEmpty")}</span>}
        >
          <For each={automation().actions ?? []}>
            {(action, i) => (
              <div
                ref={(el) => (rowRefs[action.process.toLowerCase()] = el)}
                class="settings-row-between settings-listrow settings-automation-row"
                classList={{ "search-hit": highlightIndex() === i() }}
                tabIndex={-1}
              >
                <span class="settings-index-name" title={action.process}>{action.process}</span>
                <ComboRecorder
                  value={action.combo}
                  placeholder={t("autoComboPlaceholder")}
                  label={`${t("autoComboLabel")}: ${action.process}`}
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
                  label={`${t("autoDelayTitle")}: ${action.process}`}
                  onChange={(ms) => updateAction(i(), { delay_ms: ms })}
                />
                <Toggle
                  checked={action.enabled}
                  label={t("autoRuleEnabledLabel", { process: action.process })}
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
            aria-label={t("autoProcessLabel")}
            onInput={(e) => {
              setProcess(e.currentTarget.value);
              setAddError(null);
              setDuplicateIndex(null);
            }}
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
            onClick={(e) => {
              pickTrigger = e.currentTarget;
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
            class="settings-icon-btn"
            title={t("autoAdd")}
            aria-label={t("autoAdd")}
            disabled={!process().trim() || !combo() || !delayValid()}
            onClick={addAction}
          >
            <img class="settings-icon-btn-icon" src={plusIcon} alt="" draggable={false} />
          </button>
        </div>
        <Show when={addError()}>
          <span class="settings-error settings-automation-error" role="alert">
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
        <p class="settings-hint">{t("autoDelayHint")}</p>
        <p class="settings-hint">{t("autoNotice")}</p>
      </div>
      <Show when={toast()}>
        <div
          class="settings-toast"
          classList={{ error: !toast()!.ok }}
          role={toast()!.ok ? "status" : "alert"}
        >
          {toast()!.text}
        </div>
      </Show>
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
