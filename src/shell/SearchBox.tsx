//! SearchBox — the launcher's search-row widget: the fixed head every page
//! splices under (uTools-style), with the magnifier, the query input, the page
//! pills and the settings gear. Pure presentation — the shell owns the query
//! routing, page switching and placeholder resolution; this component only
//! renders them and reports input/clicks back.

import { For, Show } from "solid-js";
import { t } from "../i18n";
import { pickIcon } from "../launcher/iconSpec";
import type { HostIcon, PickedIcon } from "../launcher/types";
import settingsIcon from "../../res/icons/settings.svg";
import unknownIcon from "../../res/icons/unknow_universal.svg";

/** Fallback for a mode that declares no icon (docs/ROADMAP_HISTORY.md #47): the bundled
 * unknown icon, so an icon-only pill is never blank — and a label pill never
 * shows a broken image. `legacy` keeps the dark-mode inversion the other
 * bundled SVGs get. */
const UNKNOWN_ICON: PickedIcon = { src: unknownIcon, legacy: true };

/** One page pill (the home page first, then plugin modes). */
export interface SearchBoxPage {
  id: string;
  label: string;
  /** Pill icon: a compiled-in URL for built-ins, a resolved light/dark spec
   * for disk modes (#44). */
  icon?: HostIcon;
  active: boolean;
  /** The page is still loading: the pill carries the feedback (accent label +
   * a spinner on the icon) while the window is collapsed to the search row. */
  loading?: boolean;
}

export interface SearchBoxProps {
  query: () => string;
  placeholder: () => string;
  pages: () => SearchBoxPage[];
  /** 仅图标（设置 → 导航页，默认关）：胶囊隐藏名称，title/aria-label 保名. */
  iconsOnly: () => boolean;
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
      <div
        class="mode-switch"
        classList={{ "icons-only": props.iconsOnly() }}
        role="tablist"
        aria-label="Search mode"
      >
        <For each={props.pages()}>
          {(p) => {
            // Theme-reactive (#44): pickIcon reads themeMode(), so a flip
            // swaps the pill's variant live; an explicit pick opts out of
            // the legacy `--icon-filter` inversion. No icon at all falls
            // back to UNKNOWN_ICON (#47) in both presentations.
            const icon = () => pickIcon(p.icon) ?? UNKNOWN_ICON;
            return (
              <button
                class="mode-switch-item"
                classList={{ active: p.active, loading: p.loading }}
                role="tab"
                aria-selected={p.active}
                aria-busy={p.loading}
                title={p.label}
                aria-label={p.label}
                onClick={() => props.onSwitchPage(p.id)}
              >
                <span class="mode-switch-icon-wrap">
                  <img
                    class="mode-switch-icon"
                    classList={{ "icon-explicit": !icon().legacy }}
                    src={icon().src}
                    alt=""
                    draggable={false}
                  />
                  <Show when={p.loading}>
                    <span class="mode-switch-spinner" aria-hidden="true" />
                  </Show>
                </span>
                <span class="mode-switch-label">{p.label}</span>
              </button>
            );
          }}
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
