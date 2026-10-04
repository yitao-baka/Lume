//! SearchBox — the launcher's search-row widget: the fixed head every page
//! splices under (uTools-style), with the magnifier, the query input, the page
//! pills and the settings gear. Pure presentation — the shell owns the query
//! routing, page switching and placeholder resolution; this component only
//! renders them and reports input/clicks back.

import { For } from "solid-js";
import { t } from "../i18n";
import settingsIcon from "../../res/icons/settings.svg";

/** One page pill (the home page first, then plugin modes). */
export interface SearchBoxPage {
  id: string;
  label: string;
  icon?: string;
  active: boolean;
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
              classList={{ active: p.active }}
              role="tab"
              aria-selected={p.active}
              onClick={() => props.onSwitchPage(p.id)}
            >
              <img class="mode-switch-icon" src={p.icon} alt="" draggable={false} />
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
