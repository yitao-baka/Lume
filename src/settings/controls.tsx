//! Shared settings controls — semantic rows/groups, segmented choices, help
//! disclosure and the small primitives reused by every settings pane. The
//! visual language lives in `skins/*.css`; these components only own
//! structure and accessibility.

import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js";
import { t } from "../i18n";

let helpRowSeq = 0;

/** A small selectable chip used across the settings panes. */
export function Chip(props: {
  label: string;
  active: boolean;
  icon?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      class="settings-chip"
      classList={{ active: props.active }}
      type="button"
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Show when={props.icon}>
        <img class="settings-chip-icon" src={props.icon} alt="" draggable={false} />
      </Show>
      {props.label}
    </button>
  );
}

/** A preset-button group for a numeric value (entry box / window size). */
export function NumberPreset(props: {
  value: number;
  presets: { label: string; value: number }[];
  onCommit: (v: number) => void;
  /** Optional free-form value beside the presets. */
  custom?: { min: number; max: number; step: number; label: string };
  disabled?: boolean;
}) {
  const [editing, setEditing] = createSignal(false);
  const isPreset = () => props.presets.some((p) => p.value === props.value);
  const showInput = () => !!props.custom && (editing() || !isPreset());
  let input: HTMLInputElement | undefined;

  function commitCustom(raw: string) {
    const custom = props.custom;
    if (!custom) return;
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return;
    const value = Math.min(Math.max(n, custom.min), custom.max);
    props.onCommit(value);
    setEditing(false);
  }

  return (
    <div class="settings-preset-row">
      <For each={props.presets}>
        {(p) => (
          <Chip
            label={p.label}
            active={props.value === p.value}
            disabled={props.disabled}
            onClick={() => props.onCommit(p.value)}
          />
        )}
      </For>
      <Show when={props.custom && !showInput()}>
        <button
          type="button"
          class="settings-chip settings-chip-more"
          aria-label={`${props.custom!.label}: ${t("settingsMore")}`}
          disabled={props.disabled}
          onClick={() => {
            setEditing(true);
            requestAnimationFrame(() => input?.focus());
          }}
        >
          {t("settingsMore")}
        </button>
      </Show>
      <Show when={showInput()}>
        <input
          ref={(el) => (input = el)}
          class="settings-text-input settings-number-input"
          type="number"
          min={props.custom!.min}
          max={props.custom!.max}
          step={props.custom!.step}
          value={props.value}
          aria-label={props.custom!.label}
          disabled={props.disabled}
          onChange={(e) => commitCustom(e.currentTarget.value)}
          onBlur={(e) => {
            if (e.currentTarget.value !== String(props.value)) {
              commitCustom(e.currentTarget.value);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitCustom(e.currentTarget.value);
              e.currentTarget.blur();
            }
          }}
        />
      </Show>
    </div>
  );
}

export interface SegmentedOption {
  value: string;
  label: string;
  icon?: string;
}

/** A 2–4 option radio group with roving tabindex and arrow/Home/End keys. */
export function SegmentedControl(props: {
  value: string;
  options: SegmentedOption[];
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
  class?: string;
}) {
  let buttons: HTMLButtonElement[] = [];
  const activeIndex = () => {
    const found = props.options.findIndex((option) => option.value === props.value);
    return found < 0 ? 0 : found;
  };
  const move = (next: number, focus: boolean) => {
    if (props.options.length === 0) return;
    const index = (next + props.options.length) % props.options.length;
    const option = props.options[index];
    props.onChange(option.value);
    if (focus) requestAnimationFrame(() => buttons[index]?.focus());
  };
  return (
    <div
      class={`settings-segmented${props.class ? ` ${props.class}` : ""}`}
      role="radiogroup"
      aria-label={props.label}
      aria-disabled={props.disabled || undefined}
    >
      <For each={props.options}>
        {(option, index) => (
          <button
            ref={(el) => (buttons[index()] = el)}
            class="settings-segment"
            classList={{ active: props.value === option.value }}
            type="button"
            role="radio"
            aria-checked={props.value === option.value}
            tabIndex={activeIndex() === index() ? 0 : -1}
            disabled={props.disabled}
            onClick={() => props.onChange(option.value)}
            onKeyDown={(event) => {
              if (props.disabled) return;
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index() + 1, true);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index() - 1, true);
              } else if (event.key === "Home") {
                event.preventDefault();
                move(0, true);
              } else if (event.key === "End") {
                event.preventDefault();
                move(props.options.length - 1, true);
              }
            }}
          >
            <Show when={option.icon}>
              <img class="settings-segment-icon" src={option.icon} alt="" draggable={false} />
            </Show>
            {option.label}
          </button>
        )}
      </For>
    </div>
  );
}

/** Inline, one-at-a-time help disclosure. The caller supplies already-localized
 * detail blocks; opening a row closes any other open help band in the page. */
export function HelpDisclosure(props: {
  label: string;
  details: string[];
}) {
  const id = `settings-help-${++helpRowSeq}`;
  const [open, setOpen] = createSignal(false);
  onMount(() => {
    const closeOther = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== id) setOpen(false);
    };
    document.addEventListener("settings-help-open", closeOther);
    onCleanup(() => document.removeEventListener("settings-help-open", closeOther));
  });
  function toggle() {
    const next = !open();
    if (next) {
      document.dispatchEvent(new CustomEvent("settings-help-open", { detail: id }));
    }
    setOpen(next);
  }
  return (
    <>
      <button
        class="settings-help-btn"
        type="button"
        aria-label={`${props.label}: ${t("settingsHelp")}`}
        aria-expanded={open()}
        aria-controls={id}
        title={t("settingsHelp")}
        onClick={toggle}
      >
        i
      </button>
      <div
        id={id}
        class="settings-help"
        hidden={!open()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            setOpen(false);
            requestAnimationFrame(() =>
              document.querySelector<HTMLButtonElement>(`[aria-controls='${id}']`)?.focus(),
            );
          }
        }}
      >
        <For each={props.details}>
          {(detail) => <p>{detail}</p>}
        </For>
      </div>
    </>
  );
}

/** Standard setting row: label + optional help/summary + a right-side control. */
export function SettingRow(props: {
  id?: string;
  label: string;
  summary?: string;
  details?: string[];
  children: JSX.Element;
  changed?: boolean;
  onReset?: () => void;
  disabled?: boolean;
  class?: string;
}) {
  return (
    <div
      id={props.id}
      class={`settings-row-between settings-setting-row${props.class ? ` ${props.class}` : ""}`}
      classList={{ changed: !!props.changed, disabled: !!props.disabled }}
      data-setting-id={props.id}
      tabIndex={-1}
    >
      <div class="settings-setting-copy">
        <div class="settings-setting-label-row">
          <Show when={props.changed}>
            <span class="settings-changed-dot" aria-hidden="true" />
          </Show>
          <span class="settings-sub-label">{props.label}</span>
          <Show when={props.details && props.details.length > 0}>
            <HelpDisclosure label={props.label} details={props.details!} />
          </Show>
          <Show when={props.changed && props.onReset}>
            <button
              class="settings-reset-row"
              type="button"
              title={t("settingsRestoreField")}
              aria-label={`${props.label}: ${t("settingsRestoreField")}`}
              onClick={props.onReset}
            >
              ↶
            </button>
          </Show>
        </div>
        <Show when={props.summary}>
          <span class="settings-row-summary">{props.summary}</span>
        </Show>
      </div>
      <div class="settings-setting-control">{props.children}</div>
    </div>
  );
}

/** A titled card of related setting rows. */
export function SettingGroup(props: {
  id?: string;
  title: string;
  number?: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <section
      class={`settings-group settings-setting-group${props.class ? ` ${props.class}` : ""}`}
      id={props.id}
      data-setting-id={props.id}
      tabIndex={props.id ? -1 : undefined}
    >
      <div class="settings-group-heading">
        <Show when={props.number}>
          <span class="settings-group-number" aria-hidden="true">{props.number}</span>
        </Show>
        <h2 class="settings-grouptitle">{props.title}</h2>
        <span class="settings-group-rule" aria-hidden="true" />
      </div>
      <div class="settings-group-panel">{props.children}</div>
    </section>
  );
}

/** A status ticket used by service/agent/plugin/system areas. */
export function StatusTicket(props: {
  id?: string;
  title: string;
  status: string;
  tone?: "neutral" | "ok" | "warn" | "error";
  children?: JSX.Element;
}) {
  return (
    <div
      class="settings-status-ticket"
      data-tone={props.tone ?? "neutral"}
      id={props.id}
      data-setting-id={props.id}
      tabIndex={props.id ? -1 : undefined}
    >
      <div class="settings-status-ticket-head">
        <strong>{props.title}</strong>
        <span class="settings-status-ticket-state">
          <span class="settings-status-dot" aria-hidden="true" />
          {props.status}
        </span>
      </div>
      {props.children}
    </div>
  );
}

/** An on/off switch. */
export function Toggle(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Required accessible name — every switch must say what it controls. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      class="settings-toggle"
      classList={{ on: props.checked }}
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      onClick={() => {
        if (!props.disabled) props.onChange(!props.checked);
      }}
    >
      <span class="settings-toggle-knob" />
    </button>
  );
}
