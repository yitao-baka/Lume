//! 「快捷键」页 — the two global hotkey slots (docs/SETTINGS.md). Each slot
//! keeps the preset chips (WebView2 can't capture Alt+Space, so presets are
//! the only way back to the default toggle combo) plus a compact recorder
//! button with live `validate_hotkey` validation.

import { createEffect, createSignal, For, Show } from "solid-js";
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
  onCommit: (v: string) => void;
}) {
  const [recording, setRecording] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  function onKeyDown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      setRecording(false);
      setError(null);
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return;
    void (async () => {
      const res = await invoke<HotkeyCheck>("validate_hotkey", {
        combo,
        other: props.other,
      });
      if (res.ok) {
        setError(null);
        setRecording(false);
        props.onCommit(combo);
      } else {
        setError(t(REASON_KEY[res.reason ?? ""] ?? "hotkeyInvalid"));
        // stay recording — the user can retry
      }
    })();
  }

  createEffect(() => {
    if (recording()) {
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }
  });

  const isPreset = () => props.presets.includes(props.value);

  return (
    <>
      <div class="settings-row settings-row-chips">
        <For each={props.presets}>
          {(p) => (
            <Chip
              label={p}
              active={props.value === p && !recording()}
              onClick={() => {
                setRecording(false);
                setError(null);
                props.onCommit(p);
              }}
            />
          )}
        </For>
        <button
          class="settings-hotkey-btn"
          classList={{ active: recording() || !isPreset() }}
          onClick={() => {
            setRecording((r) => !r);
            setError(null);
          }}
        >
          {recording()
            ? t("hotkeyRecording")
            : isPreset()
              ? t("settingsCustom")
              : props.value}
        </button>
      </div>
      <Show when={error()}>
        <span class="settings-error">{error()}</span>
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
            onCommit={(v) => props.onChangeHotkeys({ toggle: v })}
          />
        </Row>
        <Row label={t("settingsSwitchMode")}>
          <HotkeyControl
            presets={["Tab"]}
            value={h().switch_mode}
            other={h().toggle}
            onCommit={(v) => props.onChangeHotkeys({ switch_mode: v })}
          />
        </Row>
      </div>
    </>
  );
}
