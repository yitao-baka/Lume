//! 自动化 → 「选择」: a modal picker of the programs that currently have
//! windows, so a rule's executable can be chosen instead of typed.
//!
//! Rendered as an in-window overlay: the settings window is already open, so a
//! second WebView2 window would cost a whole renderer for a transient list.

import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
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
  /** Element that opened the picker; focus returns here on every close path. */
  returnFocus?: () => HTMLElement | null;
}) {
  const [items, setItems] = createSignal<WindowProgram[]>([]);
  const [filter, setFilter] = createSignal("");
  const [loading, setLoading] = createSignal(true);
  const [active, setActive] = createSignal(0);
  let filterRef: HTMLInputElement | undefined;
  let pickerRef: HTMLDivElement | undefined;

  function focusables(): HTMLElement[] {
    if (!pickerRef) return [];
    return Array.from(
      pickerRef.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((el) => el.offsetParent !== null);
  }

  function chooseCurrent() {
    const p = filtered()[active()];
    if (!p) return;
    props.onPick(p.name);
    props.onClose();
  }

  onMount(() => {
    // The picker is portaled outside `.settings`; the settings page behind it
    // is inert, so Tab / assistive navigation cannot escape the modal.
    const settingsRoot = document.querySelector<HTMLElement>(".settings");
    settingsRoot?.setAttribute("inert", "");
    filterRef?.focus();
    void invoke<WindowProgram[]>("list_window_programs")
      .then((list) => setItems(Array.isArray(list) ? list : []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
    // Esc closes; Tab / Shift+Tab wrap inside the dialog; arrows move the
    // list selection (keeping the filter usable); Enter picks.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
        return;
      }
      if (e.key === "Tab") {
        const list = focusables();
        if (list.length === 0) return;
        const first = list[0];
        const last = list[list.length - 1];
        const current = document.activeElement as HTMLElement | null;
        if (!current || !pickerRef?.contains(current)) {
          e.preventDefault();
          first.focus();
        } else if (e.shiftKey && current === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && current === last) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (filtered().length === 0) return;
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        const next = Math.min(Math.max(active() + delta, 0), filtered().length - 1);
        setActive(next);
        // From the filter the caret stays put (typing remains possible); from
        // a row the roving focus follows the highlighted option.
        if (document.activeElement !== filterRef) {
          pickerRef
            ?.querySelectorAll<HTMLElement>(".picker-row")
            [next]?.focus({ preventScroll: true });
        }
        return;
      }
      if (e.key === "Enter" && document.activeElement === filterRef) {
        e.preventDefault();
        chooseCurrent();
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      settingsRoot?.removeAttribute("inert");
      // Unconditional return: Esc, backdrop, ×, picking a row and a mode
      // switch all unmount the picker through the same cleanup.
      props.returnFocus?.()?.focus();
    });
  });

  const filtered = createMemo(() => {
    const q = filter().trim().toLowerCase();
    if (!q) return items();
    return items().filter(
      (p) => p.name.toLowerCase().includes(q) || p.title.toLowerCase().includes(q)
    );
  });

  createEffect(() => {
    void filter();
    void items();
    setActive((n) => Math.min(Math.max(n, 0), Math.max(filtered().length - 1, 0)));
  });

  return (
    <Portal>
      <div class="picker-backdrop" onClick={props.onClose}>
        <div
          class="picker"
          ref={(el) => (pickerRef = el)}
          role="dialog"
          aria-modal="true"
          aria-label={t("autoPickTitle")}
          onClick={(e) => e.stopPropagation()}
        >
          <div class="picker-head">
            <span class="picker-title">{t("autoPickTitle")}</span>
            <input
              ref={filterRef}
              class="settings-text-input picker-filter"
              type="text"
              placeholder={t("autoPickFilter")}
              value={filter()}
              onInput={(e) => {
                setFilter(e.currentTarget.value);
                setActive(0);
              }}
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
          <div class="picker-list" role="listbox" aria-label={t("autoPickTitle")}>
            <Show when={!loading()} fallback={<span class="picker-empty">{t("autoPickLoading")}</span>}>
              <Show
                when={filtered().length > 0}
                fallback={<span class="picker-empty">{t("autoPickEmpty")}</span>}
              >
                <For each={filtered()}>
                  {(p, i) => (
                    <button
                      class="picker-row"
                      classList={{ active: active() === i() }}
                      role="option"
                      aria-selected={active() === i()}
                      onMouseEnter={() => setActive(i())}
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
    </Portal>
  );
}
