//! 自动化 → 「选择」: a modal picker of the programs that currently have
//! windows, so a rule's executable can be chosen instead of typed.
//!
//! Rendered as an in-window overlay: the settings window is already open, so a
//! second WebView2 window would cost a whole renderer for a transient list.

import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n";

interface WindowProgram {
  /** Full image path of the executable. */
  path: string;
  /** Executable file name — what gets written into the rule. */
  name: string;
  /** A representative window title. */
  title: string;
  /** How many top-level windows the executable owns. */
  windows: number;
}

export function ProgramPicker(props: {
  onPick: (name: string) => void;
  onClose: () => void;
}) {
  const [items, setItems] = createSignal<WindowProgram[]>([]);
  const [filter, setFilter] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  let filterRef: HTMLInputElement | undefined;

  onMount(() => {
    filterRef?.focus();
    void invoke<WindowProgram[]>("list_window_programs")
      .then((list) => setItems(Array.isArray(list) ? list : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    // Esc closes. Only Escape is intercepted — other keys still reach the
    // filter input (a blanket preventDefault would swallow typing).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const filtered = createMemo(() => {
    const q = filter().trim().toLowerCase();
    if (!q) return items();
    return items().filter(
      (p) => p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)
    );
  });

  return (
    <div class="picker-backdrop" onClick={props.onClose}>
      <div class="picker" role="dialog" aria-label={t("autoPickTitle")} onClick={(e) => e.stopPropagation()}>
        <div class="picker-head">
          <span class="picker-title">{t("autoPickTitle")}</span>
          <input
            ref={filterRef}
            class="settings-text-input picker-filter"
            type="text"
            placeholder={t("autoPickFilter")}
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <button
            class="settings-icon-btn"
            title={t("cancel")}
            aria-label={t("cancel")}
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>
        <div class="picker-list">
          <Show when={!loading()} fallback={<span class="picker-empty">{t("autoPickLoading")}</span>}>
            <Show
              when={filtered().length > 0}
              fallback={<span class="picker-empty">{t("autoPickEmpty")}</span>}
            >
              <For each={filtered()}>
                {(p) => (
                  <button
                    class="picker-row"
                    onClick={() => {
                      props.onPick(p.name);
                      props.onClose();
                    }}
                  >
                    <span class="picker-name">{p.name}</span>
                    <span class="picker-meta" title={p.title}>
                      {p.windows > 1
                        ? t("autoPickWindows", { count: String(p.windows) })
                        : p.title}
                    </span>
                    <span class="picker-path" title={p.path}>{p.path}</span>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </div>
    </div>
  );
}