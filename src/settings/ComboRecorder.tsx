//! A press-to-record shortcut button for the 自动化 page. Mirrors the 快捷键
//! page's recorder, with one crucial difference: the key listener lives on the
//! button itself (not on `window`). A window-level listener would have to
//! `preventDefault()` every key while armed, which silently blocks typing in
//! the neighbouring program field. Button-scoped capture + cancel-on-blur means
//! the recorder can never interfere with another input.

import { createSignal, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t, type Messages } from "../i18n";
import { comboFromEvent } from "./hotkeyCapture";

interface AutoComboCheck {
  ok: boolean;
  reason: string | null;
}

/** `validate_auto_combo` reason → localized message key. */
const REASON_KEY: Record<string, keyof Messages> = {
  need_modifier: "autoNeedModifier",
  unsupported: "autoComboUnsupported",
  invalid: "autoComboInvalid",
};

export function ComboRecorder(props: {
  /** Current combination ("" = none yet). */
  value: string;
  /** Shown on the button when `value` is empty and not recording. */
  placeholder: string;
  onCommit: (combo: string) => void;
}) {
  const [recording, setRecording] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /** Re-arm or disarm; the button keeps focus so it receives the next keys. */
  function stop() {
    setRecording(false);
    setError(null);
  }

  function onKeyDown(e: KeyboardEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      stop();
      return;
    }
    const combo = comboFromEvent(e);
    if (!combo) return; // modifier alone — keep waiting
    void (async () => {
      try {
        const res = await invoke<AutoComboCheck>("validate_auto_combo", { combo });
        if (res.ok) {
          stop();
          props.onCommit(combo);
        } else {
          setError(t(REASON_KEY[res.reason ?? ""] ?? "autoComboInvalid"));
          // stay recording — the user can retry
        }
      } catch {
        setError(t("autoComboInvalid"));
      }
    })();
  }

  return (
    <>
      <button
        class="settings-hotkey-btn"
        classList={{ active: recording() }}
        onClick={(e) => {
          // Focus explicitly: the keydown capture lives on the button, so it
          // must hold focus to receive the combination.
          e.currentTarget.focus();
          setRecording((r) => !r);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (recording()) onKeyDown(e);
        }}
        onBlur={() => {
          // Clicking another field (e.g. the program input) cancels recording,
          // so it never swallows that field's keystrokes.
          if (recording()) stop();
        }}
      >
        {recording() ? t("hotkeyRecording") : props.value || props.placeholder}
      </button>
      <Show when={error()}>
        <span class="settings-error">{error()}</span>
      </Show>
    </>
  );
}