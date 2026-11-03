//! SearchBox — the launcher's search-row widget: the fixed head every page
//! splices under (uTools-style), with the magnifier, the query input, the page
//! pills and the settings gear. Pure presentation — the shell owns the query
//! routing, page switching and placeholder resolution; this component only
//! renders them and reports input/clicks back.

import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
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
  /** Navigate-only direct input mode: keep the field read-only so Windows IMEs
   * cannot enter a composition, while SearchBox applies single-line text edits. */
  imeDisabled: () => boolean;
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
  const [caretStyle, setCaretStyle] = createSignal<{
    left: number;
    top: number;
    height: number;
  } | null>(null);
  const [caretTyping, setCaretTyping] = createSignal(false);
  let caretRaf = 0;
  let caretTypingTimer = 0;
  let caretCanvas: CanvasRenderingContext2D | null = null;
  const primaryPages = () => props.pages().slice(0, 3);
  const overflowPages = () => props.pages().slice(3);

  const WORD_CHAR = /[\p{L}\p{N}_]/u;

  function singleLineText(text: string): string {
    return text.replace(/[\r\n]+/g, " ");
  }

  function selectionBounds(input: HTMLInputElement): [number, number] {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    return start <= end ? [start, end] : [end, start];
  }

  function textWidthForCaret(input: HTMLInputElement, text: string): number {
    if (!text) return 0;
    const style = getComputedStyle(input);
    caretCanvas ??= document.createElement("canvas").getContext("2d");
    if (!caretCanvas) return 0;
    caretCanvas.font = style.font;
    let width = caretCanvas.measureText(text).width;
    const letterSpacing = Number.parseFloat(style.letterSpacing);
    if (Number.isFinite(letterSpacing)) width += Math.max(0, text.length - 1) * letterSpacing;
    return width;
  }

  function updateCaret() {
    caretRaf = 0;
    const input = searchInputEl;
    const search = searchRowEl;
    if (
      !input ||
      !search ||
      !props.imeDisabled() ||
      document.activeElement !== input ||
      input.selectionStart !== input.selectionEnd
    ) {
      setCaretStyle(null);
      return;
    }

    const style = getComputedStyle(input);
    const inputRect = input.getBoundingClientRect();
    const searchRect = search.getBoundingClientRect();
    const paddingLeft = Number.parseFloat(style.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(style.paddingRight) || 0;
    const borderLeft = Number.parseFloat(style.borderLeftWidth) || 0;
    const fontSize = Number.parseFloat(style.fontSize) || 22;
    const height = Math.max(18, Math.min(inputRect.height - 4, fontSize * 1.2));
    const contentLeft = inputRect.left + borderLeft + paddingLeft;
    const contentRight = inputRect.right - paddingRight - borderLeft - 1;
    const text = input.value.slice(0, input.selectionStart ?? input.value.length);
    const nextLeft = contentLeft + textWidthForCaret(input, text) - input.scrollLeft;
    const left = Math.max(contentLeft, Math.min(nextLeft, contentRight));
    setCaretStyle({
      left: left - searchRect.left,
      top: inputRect.top - searchRect.top + (inputRect.height - height) / 2,
      height,
    });
  }

  function scheduleCaretUpdate() {
    cancelAnimationFrame(caretRaf);
    caretRaf = requestAnimationFrame(updateCaret);
  }

  function pulseCaret() {
    setCaretTyping(true);
    window.clearTimeout(caretTypingTimer);
    caretTypingTimer = window.setTimeout(() => setCaretTyping(false), 500);
    scheduleCaretUpdate();
  }

  function replaceManualRange(
    input: HTMLInputElement,
    start: number,
    end: number,
    text: string,
    inputType: string
  ) {
    const next = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    input.value = next;
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, inputType, data: text || null })
    );
    // Solid mirrors the query signal back into the controlled value. Restore
    // the caret after that render so programmatic edits behave like typing.
    queueMicrotask(() => {
      if (document.activeElement === input) {
        input.setSelectionRange(caret, caret);
        pulseCaret();
      }
    });
  }

  function insertManualText(input: HTMLInputElement, text: string, inputType = "insertText") {
    if (!text) return;
    const [start, end] = selectionBounds(input);
    replaceManualRange(input, start, end, text, inputType);
  }

  function previousWordBoundary(value: string, from: number): number {
    let i = from;
    while (i > 0 && /\s/.test(value[i - 1])) i--;
    if (i === 0) return 0;
    if (WORD_CHAR.test(value[i - 1])) {
      while (i > 0 && WORD_CHAR.test(value[i - 1])) i--;
    } else {
      while (i > 0 && !WORD_CHAR.test(value[i - 1]) && !/\s/.test(value[i - 1])) i--;
    }
    return i;
  }

  function nextWordBoundary(value: string, from: number): number {
    let i = from;
    while (i < value.length && /\s/.test(value[i])) i++;
    if (i === value.length) return i;
    if (WORD_CHAR.test(value[i])) {
      while (i < value.length && WORD_CHAR.test(value[i])) i++;
    } else {
      while (i < value.length && !WORD_CHAR.test(value[i]) && !/\s/.test(value[i])) i++;
    }
    return i;
  }

  function deleteManualText(
    input: HTMLInputElement,
    direction: "backward" | "forward",
    byWord: boolean
  ) {
    const [selectionStart, selectionEnd] = selectionBounds(input);
    if (selectionStart !== selectionEnd) {
      replaceManualRange(input, selectionStart, selectionEnd, "", "deleteContentBackward");
      return;
    }
    const start =
      direction === "backward"
        ? byWord
          ? previousWordBoundary(input.value, selectionStart)
          : Math.max(0, selectionStart - 1)
        : selectionStart;
    const end =
      direction === "forward"
        ? byWord
          ? nextWordBoundary(input.value, selectionEnd)
          : Math.min(input.value.length, selectionEnd + 1)
        : selectionEnd;
    if (start !== end) {
      replaceManualRange(
        input,
        start,
        end,
        "",
        direction === "backward" ? "deleteContentBackward" : "deleteContentForward"
      );
    }
  }

  async function pasteManualText(input: HTMLInputElement) {
    try {
      const text = await invoke<string | null>("get_clipboard_text", {
        pluginId: null,
        hostToken: null,
      });
      if (!text || !props.imeDisabled() || document.activeElement !== input) return;
      insertManualText(input, singleLineText(text), "insertFromPaste");
    } catch {
      // Clipboard permission/content failure leaves the query untouched.
    }
  }

  async function cutManualText(input: HTMLInputElement) {
    const [start, end] = selectionBounds(input);
    if (start === end) return;
    const text = input.value.slice(start, end);
    try {
      await invoke("set_clipboard_text", {
        text,
        pluginId: null,
        hostToken: null,
      });
      if (input.value.slice(start, end) !== text) return;
      replaceManualRange(input, start, end, "", "deleteByCut");
    } catch {
      // Keep the selection if the clipboard write fails.
    }
  }

  function onManualKeyDown(e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (!props.imeDisabled() || e.isComposing || e.keyCode === 229) return;
    const input = e.currentTarget;
    const shortcut = (e.ctrlKey || e.metaKey) && !e.altKey;
    if (shortcut) {
      const key = e.key.toLowerCase();
      if (key === "v") {
        e.preventDefault();
        void pasteManualText(input);
        return;
      }
      if (key === "x") {
        e.preventDefault();
        void cutManualText(input);
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        deleteManualText(input, "backward", true);
        return;
      }
      if (e.key === "Delete") {
        e.preventDefault();
        deleteManualText(input, "forward", true);
        return;
      }
      // Ctrl+A/C and native caret navigation remain enabled by read-only inputs.
      return;
    }
    if (e.shiftKey && e.key === "Insert") {
      e.preventDefault();
      void pasteManualText(input);
      return;
    }
    if (e.shiftKey && e.key === "Delete") {
      const [start, end] = selectionBounds(input);
      if (start !== end) {
        e.preventDefault();
        void cutManualText(input);
      }
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      deleteManualText(input, "backward", false);
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      deleteManualText(input, "forward", false);
      return;
    }
    // Ctrl+Alt is AltGr on Windows layouts; let it produce the resolved key.
    if (e.key.length === 1 && !e.metaKey && (!e.ctrlKey || e.altKey)) {
      e.preventDefault();
      insertManualText(input, e.key);
    }
  }

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

  createEffect(() => {
    void props.query();
    if (!props.imeDisabled()) {
      setCaretStyle(null);
      setCaretTyping(false);
      return;
    }
    scheduleCaretUpdate();
  });

  onMount(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.target === searchInputEl) {
        setShortPlaceholder(entry.contentRect.width < 160);
        scheduleCaretUpdate();
      }
      scheduleModeMeasure();
    });
    if (searchInputEl) observer.observe(searchInputEl);
    if (searchRowEl) observer.observe(searchRowEl);
    const onResize = () => {
      scheduleModeMeasure();
      scheduleCaretUpdate();
    };
    window.addEventListener("resize", onResize);
    scheduleModeMeasure();
    onCleanup(() => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
      cancelAnimationFrame(modeMeasureRaf);
      cancelAnimationFrame(caretRaf);
      window.clearTimeout(caretTypingTimer);
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
        onKeyDown={(e) => onManualKeyDown(e)}
        onKeyUp={scheduleCaretUpdate}
        onSelect={scheduleCaretUpdate}
        onFocus={scheduleCaretUpdate}
        onBlur={() => setCaretStyle(null)}
        onClick={scheduleCaretUpdate}
        onPointerUp={scheduleCaretUpdate}
        onScroll={scheduleCaretUpdate}
        onPaste={(e) => {
          if (!props.imeDisabled()) return;
          const text = e.clipboardData?.getData("text/plain") ?? "";
          e.preventDefault();
          if (text) insertManualText(e.currentTarget, singleLineText(text), "insertFromPaste");
        }}
        readOnly={props.imeDisabled()}
        placeholder={placeholder()}
        title={props.placeholder()}
        aria-label={props.placeholder()}
        spellcheck={false}
        autocomplete="off"
      />
      <span
        class="search-caret"
        classList={{ visible: !!caretStyle(), typing: caretTyping() }}
        style={{
          left: `${caretStyle()?.left ?? 0}px`,
          top: `${caretStyle()?.top ?? 0}px`,
          height: `${caretStyle()?.height ?? 24}px`,
        }}
        aria-hidden="true"
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
