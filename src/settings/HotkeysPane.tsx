//! 「快捷键」页 — the two global key slots plus the keyboard reference.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t, type Messages } from "../i18n";
import type { SettingsData } from "./types";
import { Chip, SettingGroup, SettingRow } from "./controls";
import { comboFromEvent } from "./hotkeyCapture";

const REASON_KEY: Record<string, keyof Messages> = {
  need_modifier: "hotkeyNeedModifier",
  conflict_lume: "hotkeyConflictLume",
  taken: "hotkeyTaken",
  reserved: "hotkeyReserved",
  invalid: "hotkeyInvalid",
};

interface HotkeyCheck {
  ok: boolean;
  reason: string | null;
}

function Keycaps(props: { combo: string; recording: boolean }) {
  return (
    <span class="settings-keycaps" classList={{ recording: props.recording }} aria-live="polite">
      <Show
        when={!props.recording}
        fallback={<span class="settings-recording-hint">{t("hotkeyRecording")}</span>}
      >
        <For each={props.combo.split("+")}>
          {(key, index) => (
            <>
              <Show when={index() > 0}>
                <span class="settings-keycap-plus" aria-hidden="true">+</span>
              </Show>
              <kbd class="settings-keycap">{key}</kbd>
            </>
          )}
        </For>
      </Show>
    </span>
  );
}

function HotkeyControl(props: {
  presets: string[];
  value: string;
  other: string;
  label: string;
  modeKey?: boolean;
  onCommit: (value: string) => void;
}) {
  const [recording, setRecording] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let captureSeq = 0;
  let buttonEl: HTMLButtonElement | undefined;

  function stop() {
    captureSeq++;
    setRecording(false);
    setError(null);
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Tab" && !event.ctrlKey && !event.altKey && !event.metaKey) {
      stop();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stop();
      return;
    }
    const combo = comboFromEvent(event);
    if (!combo) return;
    const sequence = ++captureSeq;
    void (async () => {
      try {
        const result = await invoke<HotkeyCheck>(
          props.modeKey ? "validate_mode_hotkey" : "validate_hotkey",
          { combo, other: props.other },
        );
        if (sequence !== captureSeq) return;
        if (result.ok) {
          setError(null);
          stop();
          props.onCommit(combo);
        } else {
          setError(t(REASON_KEY[result.reason ?? ""] ?? "hotkeyInvalid"));
        }
      } catch {
        if (sequence === captureSeq) setError(t("hotkeyInvalid"));
      }
    })();
  }

  onMount(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (recording() && target && buttonEl && !buttonEl.contains(target)) stop();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });

  return (
    <div class="settings-hotkey-control">
      <div class="settings-keycap-card">
        <Keycaps combo={props.value} recording={recording()} />
        <button
          ref={(el) => (buttonEl = el)}
          class="settings-action settings-keycap-change"
          type="button"
          aria-label={`${props.label}: ${t("hotkeyChange")}`}
          onClick={() => {
            if (recording()) stop();
            else {
              setRecording(true);
              setError(null);
              requestAnimationFrame(() => buttonEl?.focus());
            }
          }}
          onKeyDown={(event) => {
            if (recording()) onKeyDown(event);
          }}
          onBlur={() => {
            if (recording()) stop();
          }}
        >
          {recording() ? t("hotkeyRecording") : t("hotkeyChange")}
        </button>
      </div>
      <details class="settings-hotkey-presets">
        <summary>{t("hotkeyPresets")}</summary>
        <div class="settings-row settings-row-chips">
          <For each={props.presets}>
            {(preset) => (
              <Chip
                label={preset}
                active={props.value === preset && !recording()}
                onClick={() => {
                  stop();
                  props.onCommit(preset);
                }}
              />
            )}
          </For>
        </div>
      </details>
      <Show when={error()}>
        <span class="settings-inline-error" role="alert">{error()}</span>
      </Show>
    </div>
  );
}

const CHEATSHEET = [
  { keys: "F6 / Shift+F6", label: "hotkeyCheatFocus" },
  { keys: "Ctrl+Tab", label: "hotkeyCheatMode" },
  { keys: "Ctrl+,", label: "hotkeyCheatSettings" },
  { keys: "Shift+F10", label: "hotkeyCheatMenu" },
] as const;

export default function HotkeysPane(props: {
  settings: SettingsData;
  onChangeHotkeys: (patch: Partial<SettingsData["hotkeys"]>) => void;
}) {
  const h = () => props.settings.hotkeys;
  const [activeHotkey, setActiveHotkey] = createSignal<string | null>(null);
  createEffect(() => {
    const expected = h().toggle;
    const timer = setTimeout(() => {
      void invoke<string>("get_hotkey")
        .then((active) => {
          if (h().toggle === expected) setActiveHotkey(active);
        })
        .catch(() => setActiveHotkey(""));
    }, 120);
    onCleanup(() => clearTimeout(timer));
  });
  return (
    <>
      <SettingGroup title={t("settingsToggleLauncher")} number="05.1">
        <SettingRow
          id="hotkeys.toggle"
          label={t("settingsToggleLauncher")}
          summary={t("settingsToggleHotkeyHint")}
        >
          <HotkeyControl
            presets={["Alt+Space", "Ctrl+Space"]}
            value={h().toggle}
            other={h().switch_mode}
            label={t("settingsToggleLauncher")}
            onCommit={(value) => props.onChangeHotkeys({ toggle: value })}
          />
          <Show when={activeHotkey() !== null && activeHotkey() !== h().toggle}>
            <span class="settings-inline-error" role="alert">{t("hotkeyNotRegistered")}</span>
          </Show>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title={t("settingsSwitchMode")} number="05.2">
        <SettingRow
          id="hotkeys.switch_mode"
          label={t("settingsSwitchMode")}
          summary={t("settingsSwitchHotkeyHint")}
          details={[t("hotkeyModeHint")]}
        >
          <HotkeyControl
            presets={["Tab"]}
            value={h().switch_mode}
            other={h().toggle}
            label={t("settingsSwitchMode")}
            modeKey
            onCommit={(value) => props.onChangeHotkeys({ switch_mode: value })}
          />
        </SettingRow>
      </SettingGroup>
      <details class="settings-cheatsheet">
        <summary>{t("hotkeyCheatSheet")}</summary>
        <div class="settings-cheatsheet-table" role="table">
          <For each={CHEATSHEET}>
            {(row) => (
              <div class="settings-cheatsheet-row" role="row">
                <kbd>{row.keys}</kbd>
                <span>{t(row.label)}</span>
              </div>
            )}
          </For>
        </div>
      </details>
    </>
  );
}
