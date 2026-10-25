//! SearchBox — the launcher's search-row widget: the fixed head every page
//! splices under (uTools-style), with the magnifier, the query input, the page
//! pills and the settings gear. Pure presentation — the shell owns the query
//! routing, page switching and placeholder resolution; this component only
//! renders them and reports input/clicks back.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
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

function ModePill(props: { page: SearchBoxPage; onSwitch: (id: string) => void }) {
  // Theme-reactive (#44): pickIcon reads themeMode(), so a flip swaps the
  // pill's variant live; an explicit pick opts out of the legacy icon-filter
  // inversion. No icon at all falls back to UNKNOWN_ICON (#47).
  const icon = () => pickIcon(props.page.icon) ?? UNKNOWN_ICON;
  return (
    <button
      class="mode-switch-item"
      classList={{ active: props.page.active, loading: props.page.loading }}
      role="tab"
      aria-selected={props.page.active}
      aria-busy={props.page.loading}
      title={props.page.label}
      aria-label={props.page.label}
      onClick={() => props.onSwitch(props.page.id)}
    >
      <span class="mode-switch-icon-wrap">
        <img
          class="mode-switch-icon"
          classList={{ "icon-explicit": !icon().legacy }}
          src={icon().src}
          alt=""
          draggable={false}
        />
        <Show when={props.page.loading}>
          <span class="mode-switch-spinner" aria-hidden="true" />
        </Show>
      </span>
      <span class="mode-switch-label">{props.page.label}</span>
    </button>
  );
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
  let searchRowEl: HTMLDivElement | undefined;
  let modeSwitchEl: HTMLDivElement | undefined;
  let searchInputEl: HTMLInputElement | undefined;
  let modeMeasureRaf = 0;
  const [shortPlaceholder, setShortPlaceholder] = createSignal(false);
  const [modeBarWidth, setModeBarWidth] = createSignal(0);
  const [modeBarMaxWidth, setModeBarMaxWidth] = createSignal(0);
  const [modeBarTruncated, setModeBarTruncated] = createSignal(false);
  const primaryPages = () => props.pages().slice(0, 3);
  const overflowPages = () => props.pages().slice(3);

  /** Size the viewport to the first three pills' natural width, capped by the
   * current row budget. Only an overflowing trio activates shrinking; otherwise
   * the bar keeps its content width instead of padding itself out to the cap. */
  function measureModeBar() {
    const shell = modeSwitchEl?.parentElement;
    const row = searchRowEl;
    if (!shell || !row || !modeSwitchEl) return;
    const items = Array.from(
      modeSwitchEl.querySelectorAll<HTMLElement>(".mode-switch-item"),
    ).slice(0, 3);
    if (items.length === 0) {
      setModeBarWidth(0);
      setModeBarMaxWidth(0);
      setModeBarTruncated(false);
      return;
    }

    const oldWidth = shell.style.width;
    const oldMaxWidth = shell.style.maxWidth;
    const oldFlex = shell.style.flex;
    const wasTruncated = shell.classList.contains("is-truncated");
    shell.classList.remove("is-truncated");
    shell.style.flex = "0 0 auto";
    shell.style.width = "max-content";
    shell.style.maxWidth = "none";
    const style = getComputedStyle(modeSwitchEl);
    const gap = Number.parseFloat(style.columnGap || style.gap) || 0;
    const padding =
      (Number.parseFloat(style.paddingLeft) || 0) +
      (Number.parseFloat(style.paddingRight) || 0);
    const naturalWidth =
      items.reduce((sum, item) => sum + item.getBoundingClientRect().width, 0) +
      gap * Math.max(0, items.length - 1) +
      padding;
    shell.style.width = oldWidth;
    shell.style.maxWidth = oldMaxWidth;
    shell.style.flex = oldFlex;
    shell.classList.toggle("is-truncated", wasTruncated);

    const rowStyle = getComputedStyle(row);
    const available =
      row.clientWidth -
      (Number.parseFloat(rowStyle.paddingLeft) || 0) -
      (Number.parseFloat(rowStyle.paddingRight) || 0);
    const iconsPresentation =
      props.iconsOnly() || window.matchMedia("(max-width: 640px)").matches;
    const maxWidth = Math.min(
      available,
      iconsPresentation ? 104 : Math.min(available * 0.44, 320),
    );
    const truncated = naturalWidth > maxWidth + 0.5;
    setModeBarMaxWidth(Math.floor(maxWidth));
    setModeBarWidth(Math.ceil(Math.min(naturalWidth, maxWidth)));
    setModeBarTruncated(truncated);
  }

  function scheduleModeMeasure() {
    cancelAnimationFrame(modeMeasureRaf);
    modeMeasureRaf = requestAnimationFrame(measureModeBar);
  }

  // The mode bar scrolls horizontally when plugins outgrow the row. Keep the
  // active pill visible after Tab cycling / keyword jumps, even when it was
  // clipped before the switch.
  createEffect(() => {
    props.pages();
    props.iconsOnly();
    scheduleModeMeasure();
    requestAnimationFrame(() => {
      modeSwitchEl
        ?.querySelector<HTMLElement>(".mode-switch-item.active")
        ?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
  });

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.target === searchInputEl) {
        setShortPlaceholder(entry.contentRect.width < 160);
      }
      scheduleModeMeasure();
    });
    if (searchInputEl) observer.observe(searchInputEl);
    if (searchRowEl) observer.observe(searchRowEl);
    const onResize = () => scheduleModeMeasure();
    window.addEventListener("resize", onResize);
    scheduleModeMeasure();
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      cancelAnimationFrame(modeMeasureRaf);
    });
  });

  const placeholder = () => (shortPlaceholder() ? t("searchPlaceholderShort") : props.placeholder());

  return (
    // The frameless window is draggable from the search row's empty space
    // (direct clicks only — the input/pills/gear are clickable and block it,
    // per Tauri's data-tauri-drag-region semantics).
    <div class="search" ref={(el) => (searchRowEl = el)} data-tauri-drag-region>
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
        ref={(el) => (searchInputEl = el)}
        type="text"
        value={props.query()}
        onInput={(e) => props.onInput((e.currentTarget as HTMLInputElement).value)}
        placeholder={placeholder()}
        title={props.placeholder()}
        aria-label={props.placeholder()}
        spellcheck={false}
        autocomplete="off"
      />
      <div
        class="mode-switch-shell"
        classList={{
          "icons-only": props.iconsOnly(),
          "is-truncated": modeBarTruncated(),
        }}
        style={{
          width: modeBarWidth() > 0 ? `${modeBarWidth()}px` : undefined,
          "max-width": modeBarMaxWidth() > 0 ? `${modeBarMaxWidth()}px` : undefined,
        }}
      >
        <div
          class="mode-switch"
          classList={{ "icons-only": props.iconsOnly() }}
          ref={(el) => (modeSwitchEl = el)}
          role="tablist"
          aria-label={t("searchMode")}
          onWheel={(e) => {
            // A vertical wheel over the chip strip scrolls it horizontally,
            // matching the hidden-scrollbar treatment used elsewhere.
            if (!modeSwitchEl || modeSwitchEl.scrollWidth <= modeSwitchEl.clientWidth) return;
            if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
            modeSwitchEl.scrollLeft += e.deltaY;
            e.preventDefault();
          }}
        >
          <div class="mode-switch-primary" role="presentation">
            <For each={primaryPages()}>
              {(page) => <ModePill page={page} onSwitch={props.onSwitchPage} />}
            </For>
          </div>
          <div class="mode-switch-overflow" role="presentation">
            <For each={overflowPages()}>
              {(page) => <ModePill page={page} onSwitch={props.onSwitchPage} />}
            </For>
          </div>
        </div>
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
