//! 「快捷键」页 — the two global hotkey slots (docs/SETTINGS.md). Each slot
//! keeps the preset chips (WebView2 can't capture Alt+Space, so presets are
//! the only way back to the default toggle combo) plus a compact recorder
//! button with live `validate_hotkey` validation.

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t, type Messages } from "../i18n";
import type { SettingsData } from "./types";
import { Chip, Row } from "./controls";
import { comboFromEvent } from "./hotkeyCapture";

/** Machine reason codes from the Rust validator → localized message keys. */
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

/** A hotkey slot: preset chips + a recorder button with live validation
 * (format + Lume conflict + system occupancy). Esc cancels recording. */
function HotkeyControl(props: {
  presets: string[];
  value: string;
  other: string;
  label: string;
  modeKey?: boolean;
  onCommit: (v: string) => void;
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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) {
      stop();
      return; // keep Tab as focus navigation, not a stuck capture
    }
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      stop();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    const seq = ++captureSeq;
    void (async () => {
      try {
        const res = await invoke<HotkeyCheck>(
          props.modeKey ? "validate_mode_hotkey" : "validate_hotkey",
          {
            combo,
            other: props.other,
          },
        );
        if (seq !== captureSeq) return; // recording was cancelled / focus moved
        if (res.ok) {
          setError(null);
          stop();
          props.onCommit(combo);
        } else {
          setError(t(REASON_KEY[res.reason ?? ""] ?? "hotkeyInvalid"));
          // stay recording — the user can retry
        }
      } catch {
        if (seq === captureSeq) setError(t("hotkeyInvalid"));
      }
    })();
  }

  const isPreset = () => props.presets.includes(props.value);

  onMount(() => {
    // Clicking another control must cancel immediately, even before the
    // browser's focus transition has finished. The blur handler below remains
    // the keyboard/focus path; this covers pointer-first dismissal.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (recording() && target && buttonEl && !buttonEl.contains(target)) stop();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    onCleanup(() => document.removeEventListener("pointerdown", onPointerDown, true));
  });

  return (
    <>
      <div class="settings-row settings-row-chips">
        <For each={props.presets}>
          {(p) => (
            <Chip
              label={p}
              active={props.value === p && !recording()}
              onClick={() => {
                stop();
                props.onCommit(p);
              }}
            />
          )}
        </For>
        <button
          ref={(el) => (buttonEl = el)}
          class="settings-hotkey-btn"
          classList={{ active: recording() || !isPreset() }}
          aria-label={`${props.label}: ${
            recording()
              ? t("hotkeyRecording")
              : isPreset()
                ? t("hotkeyCustomButton")
                : props.value
          }`}
          onClick={(e) => {
            e.currentTarget.focus();
            if (recording()) stop();
            else {
              setRecording(true);
              setError(null);
            }
          }}
          onKeyDown={(e) => {
            // Button-scoped capture: once focus moves to the settings search
            // or another field, it cannot intercept that field's keystrokes.
            if (recording()) onKeyDown(e);
          }}
          onBlur={() => {
            if (recording()) stop();
          }}
        >
          {recording()
            ? t("hotkeyRecording")
            : isPreset()
              ? t("hotkeyCustomButton")
              : props.value}
        </button>
      </div>
      <Show when={error()}>
        <span class="settings-error" role="alert">{error()}</span>
      </Show>
    </>
  );
}

export default function HotkeysPane(props: {
  settings: SettingsData;
  onChangeHotkeys: (patch: Partial<SettingsData["hotkeys"]>) => void;
}) {
  const h = () => props.settings.hotkeys;
  return (
    <>
      <h2 class="settings-grouptitle">{t("settingsHotkeys")}</h2>
      <div class="settings-group">
        <Row label={t("settingsToggleLauncher")}>
          <HotkeyControl
            presets={["Alt+Space", "Ctrl+Space"]}
            value={h().toggle}
            other={h().switch_mode}
            label={t("settingsToggleLauncher")}
            onCommit={(v) => props.onChangeHotkeys({ toggle: v })}
          />
        </Row>
        <Row label={t("settingsSwitchMode")}>
          <HotkeyControl
            presets={["Tab"]}
            value={h().switch_mode}
            other={h().toggle}
            label={t("settingsSwitchMode")}
            modeKey
            onCommit={(v) => props.onChangeHotkeys({ switch_mode: v })}
          />
        </Row>
        <span class="settings-hint">{t("hotkeyModeHint")}</span>
      </div>
    </>
  );
}
