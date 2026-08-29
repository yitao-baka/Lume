//! Shared settings controls — chips, toggles and preset rows reused by every
//! settings pane. Extracted from the old InterfacePane when the settings
//! window moved to the grouped-card layout.

import { For, Show, type JSX } from "solid-js";

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
}) {
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
    </div>
  );
}

/** An on/off switch. */
export function Toggle(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      class="settings-toggle"
      classList={{ on: props.checked }}
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
    >
      <span class="settings-toggle-knob" />
    </button>
  );
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
