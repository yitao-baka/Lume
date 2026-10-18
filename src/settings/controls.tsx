//! Shared settings controls — chips, toggles and preset rows reused by every
//! settings pane. Extracted from the old InterfacePane when the settings
//! window moved to the grouped-card layout.

import { createSignal, For, Show, type JSX } from "solid-js";
import { t } from "../i18n";

/** A small selectable chip used across the settings panes. */
export function Chip(props: {
  label: string;
  active: boolean;
  icon?: string;
  onClick: () => void;
}) {
  return (
    <button
      class="settings-chip"
      classList={{ active: props.active }}
      type="button"
      aria-pressed={props.active}
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
    <div class="settings-row settings-row-chips">
      <For each={props.presets}>
        {(p) => (
          <Chip
            label={p.label}
            active={props.value === p.value}
            onClick={() => props.onCommit(p.value)}
          />
        )}
      </For>
      <Show when={props.custom && !showInput()}>
        <button
          type="button"
          class="settings-chip settings-chip-more"
          aria-label={`${props.custom!.label}: ${t("settingsMore")}`}
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

/** Marks a control/action that writes immediately instead of joining the
 * working-copy draft. */
export function ImmediateBadge(props: { label?: string }) {
  const label = () => props.label ?? t("settingsImmediate");
  return <span class="settings-immediate" title={label()}>{label()}</span>;
}

/** A labeled row inside a group card: label left, control right. */
export function Row(props: {
  label: string;
  children: JSX.Element;
}) {
  return (
    <div class="settings-row-between">
      <span class="settings-sub-label">{props.label}</span>
      {props.children}
    </div>
  );
}
