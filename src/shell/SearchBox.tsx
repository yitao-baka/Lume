//! SearchBox — the launcher's search-row widget: the fixed head every page
//! splices under (uTools-style), with the magnifier, the query input, the page
//! pills and the settings gear. Pure presentation — the shell owns the query
//! routing, page switching and placeholder resolution; this component only
//! renders them and reports input/clicks back.

import { For, Show } from "solid-js";
import { t } from "../i18n";
import settingsIcon from "../../res/icons/settings.svg";

/** One page pill (the home page first, then plugin modes). */
export interface SearchBoxPage {
  id: string;
  label: string;
  icon?: string;
  active: boolean;
  /** The page is still loading: the pill carries the feedback (accent label +
   * a spinner on the icon) while the window is collapsed to the search row. */
  loading?: boolean;
}

export interface SearchBoxProps {
  query: () => string;
  placeholder: () => string;
  pages: () => SearchBoxPage[];
  /** The query input changed (already routed by the shell). */
  onInput: (text: string) => void;
  onSwitchPage: (id: string) => void;
  onOpenSettings: () => void;
}

export function SearchBox(props: SearchBoxProps) {
  return (
    // The frameless window is draggable from the search row's empty space
    // (direct clicks only — the input/pills/gear are clickable and block it,
    // per Tauri's data-tauri-drag-region semantics).
    <div class="search" data-tauri-drag-region>
      <svg
        class="search-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <circle cx="11" cy="11" r="7" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        id="search-input"
        class="search-input"
        type="text"
        value={props.query()}
        onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value)}
        placeholder={props.placeholder()}
        spellcheck={false}
        autocomplete="off"
      />
      <div class="mode-switch" role="tablist" aria-label="Search mode">
        <For each={props.pages()}>
          {(p) => (
            <button
              class="mode-switch-item"
              classList={{ active: p.active, loading: p.loading }}
              role="tab"
              aria-selected={p.active}
              aria-busy={p.loading}
              onClick={() => props.onSwitchPage(p.id)}
            >
              <span class="mode-switch-icon-wrap">
                <img class="mode-switch-icon" src={p.icon} alt="" draggable={false} />
                <Show when={p.loading}>
                  <span class="mode-switch-spinner" aria-hidden="true" />
                </Show>
              </span>
              {p.label}
            </button>
          )}
        </For>
      </div>
      <button
        class="icon-btn"
        title={t("settings")}
        aria-label={t("settings")}
        onClick={() => props.onOpenSettings()}
      >
        <img class="icon-btn-icon" src={settingsIcon} alt="" draggable={false} />
      </button>
    </div>
  );
}
