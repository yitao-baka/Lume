//! Default clipboard Presenter. All rows/actions come from the windowed Page
//! Model; Tauri commands and the ClipboardStore stay in the Page Service.

import { For, Show, createEffect, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { t } from "../../i18n";
import { basename, clipMeta, detectColor, fileContent, isUrl } from "../../launcher/clipData";
import type { ClipboardItem } from "../../launcher/types";
import { currentSkin } from "../../skins/runtime";
import { clipboardRowHeight } from "../../skins/registry";
import type { ClipboardModel, ClipboardRowModel } from "../../page-runtime/schemas";
import { clipboardScrollFades } from "../clipboard-scroll";
import browserIcon from "../../../res/icons/browser.svg";
import clipboardIcon from "../../../res/icons/clipboard.svg";
import multifilesIcon from "../../../res/icons/multifiles.svg";

export interface ClipboardListProps {
  data: () => ClipboardModel | undefined;
  selectedId: () => string | undefined;
  dispatch: (intent: { type: string; targetId?: string; actionId?: string; payload?: unknown }) => Promise<unknown>;
  markMouse: () => void;
  selectionSource: () => "keyboard" | "mouse" | "other";
}

function asItem(row: ClipboardRowModel): ClipboardItem {
  return {
    id: row.numericId,
    kind: row.kind as ClipboardItem["kind"],
    content: row.content,
    pinned: row.pinned,
    created_at: row.createdAt,
    thumb: row.thumb?.src ?? null,
    source_app: row.sourceApp ?? "",
    has_html: row.hasHtml,
    merged_count: row.mergedCount,
    valid: row.valid,
    checked: row.checked ?? null,
  };
}

function tile(row: ClipboardRowModel) {
  if (row.kind === "image" && row.thumb) {
    return <span class="clip-row-tile"><img class="clip-row-img" src={row.thumb.src} alt="" draggable={false} /></span>;
  }
  if (row.kind === "image" && !row.thumb) {
    // Search publishes the row before the viewport thumbnail batch lands.
    return <span class="clip-row-tile"><span class="clip-row-emoji">▧</span></span>;
  }
  if (row.kind === "file") {
    const paths = row.content.split("\n").filter(Boolean);
    const count = row.fileCount ?? paths.length;
    if (count >= 2) return <span class="clip-row-tile"><img class="clip-row-tile-icon" src={multifilesIcon} alt="" /></span>;
    if (row.icon) {
      return (
        <span class="clip-row-tile">
          <img class="clip-row-tile-icon clip-row-file-icon" src={row.icon.src} alt="" draggable={false} />
        </span>
      );
    }
    const kind = row.fileKind ?? fileContent(basename(paths[0] ?? ""));
    if (kind === "audio") return <span class="clip-row-tile"><span class="clip-row-emoji">♪</span></span>;
    if (kind === "video") return <span class="clip-row-tile"><span class="clip-row-emoji">▷</span></span>;
    if (kind === "image") return <span class="clip-row-tile"><span class="clip-row-emoji">▧</span></span>;
    if (kind === "text") return <span class="clip-row-tile"><span class="clip-row-emoji">≡</span></span>;
  }
  const color = row.kind === "text" ? detectColor(row.content) : null;
  if (color) return <span class="clip-row-tile clip-row-tile-color" style={{ background: color }} />;
  if (row.kind === "text" && isUrl(row.content)) {
    return (
      <span class="clip-row-tile">
        <img class="clip-row-tile-icon clip-row-file-icon" src={row.icon?.src ?? browserIcon} alt="" draggable={false} />
      </span>
    );
  }
  return <span class="clip-row-tile clip-row-tile-text">T</span>;
}

export function ClipboardListPresenter(props: ClipboardListProps) {
  const data = () => props.data();
  const rows = () => data()?.items ?? [];
  const rowHeight = () => clipboardRowHeight(currentSkin(), "clipboard-list");
  const selected = (row: ClipboardRowModel) => props.selectedId() === row.id;
  const checked = (row: ClipboardRowModel) =>
    (data()?.status.selected ?? 0) > 0 && (data()?.selectedIds ?? []).includes(row.id);
  const select = (row: ClipboardRowModel) => void props.dispatch({ type: "selection.set", targetId: row.id, payload: { selectedIds: [row.id] } });
  const activate = (row: ClipboardRowModel) => {
    props.markMouse();
    if (!selected(row)) {
      select(row);
      return;
    }
    void props.dispatch({ type: "item.activate", targetId: row.id });
  };
  const menu = (row: ClipboardRowModel, x: number, y: number) => {
    props.markMouse();
    void props.dispatch({ type: "item.action", targetId: row.id, actionId: "menu", payload: { x, y } });
  };
  let list: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let cancelButton: HTMLButtonElement | undefined;
  let confirm: HTMLDivElement | undefined;
  let clearWasOpen = false;
  const [fadeTop, setFadeTop] = createSignal(false);
  const [fadeBottom, setFadeBottom] = createSignal(false);
  const updateFades = () => {
    if (!list) return;
    const fades = clipboardScrollFades(list.scrollTop, list.clientHeight, list.scrollHeight);
    setFadeTop(fades.top);
    setFadeBottom(fades.bottom);
  };
  const measureViewport = () => {
    if (!list) return;
    updateFades();
    void props.dispatch({
      type: "viewport.request",
      payload: { scrollTop: list.scrollTop, viewportHeight: list.clientHeight, rowHeight: rowHeight() },
    });
  };
  onMount(() => {
    queueMicrotask(measureViewport);
  });
  // A skin change can alter the row rhythm without rebuilding the Presenter.
  // Only row-height changes re-anchor the selected row; following every model
  // revision here would snap wheel scrolling back to the selection as soon as
  // the Page Service published the new viewport window.
  createEffect(on(rowHeight, (height) => {
    const index = untrack(() => data()?.selectedIndex ?? -1);
    if (index >= 0 && list) {
      const top = index * height;
      const bottom = top + height;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = bottom - list.clientHeight + 8;
      }
    }
    queueMicrotask(measureViewport);
  }));
  createEffect(() => {
    void data();
    queueMicrotask(updateFades);
  });
  createEffect(() => {
    const open = !!data()?.clearState?.open;
    if (open && !clearWasOpen) queueMicrotask(() => cancelButton?.focus());
    if (!open && clearWasOpen) queueMicrotask(() => document.getElementById("search-input")?.focus());
    clearWasOpen = open;
  });
  // The Page Service owns the windowed row slice, but only the Presenter owns
  // the scroll element. Keep keyboard selection visible here and feed the new
  // scroll position back as a viewport intent.
  createEffect(on(() => data()?.selectedIndex ?? -1, (index) => {
    if (index < 0 || !list || props.selectionSource() !== "keyboard") return;
    const height = untrack(rowHeight);
    const top = index * height;
    const bottom = top + height;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8;
  }));
  const bindList = (el: HTMLDivElement) => {
    list = el;
    resizeObserver?.disconnect();
    resizeObserver ??= new ResizeObserver(() => queueMicrotask(measureViewport));
    resizeObserver.observe(el);
    queueMicrotask(measureViewport);
  };
  onCleanup(() => resizeObserver?.disconnect());
  const trapConfirm = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !confirm) return;
    const focusable = [...confirm.querySelectorAll<HTMLElement>('button,input,[tabindex]:not([tabindex="-1"])')].filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };
  return (
    <div class="clip-page" style={{ "--clip-row-height": rowHeight() + "px" }}>
      <div class="clip-cats" role="tablist" aria-label={t("clipboardCategory")}>
        <For each={data()?.categories ?? []}>
          {(category) => (
            <button
              class="clip-cat"
              classList={{ active: data()?.activeCategory === category.id }}
              role="tab"
              aria-selected={data()?.activeCategory === category.id}
              onClick={() => void props.dispatch({ type: "category.select", payload: { kind: category.id } })}
            >
              {category.label}
            </button>
          )}
        </For>
      </div>
      <div class="clip-main">
        <Show when={fadeTop()}><div class="scroll-fade top" aria-hidden="true" /></Show>
        <Show
          when={rows().length > 0}
          fallback={
            <div class="clip-empty">
              <img class="clip-empty-icon" src={clipboardIcon} alt="" draggable={false} />
              <p class="clip-empty-title">{data()?.emptyText || t("noClipboardHistory")}</p>
              <Show when={!data()?.query}><p class="clip-empty-hint">{t("clipEmptyHint")}</p></Show>
            </div>
          }
        >
          <div
            class="clip-list"
            ref={bindList}
            role="listbox"
            onWheel={() => props.markMouse()}
            onScroll={(event) => {
              if (!list) return;
              updateFades();
              void props.dispatch({
                type: "viewport.request",
                payload: { scrollTop: event.currentTarget.scrollTop, viewportHeight: list.clientHeight, rowHeight: rowHeight() },
              });
            }}
          >
            <div class="clip-spacer" style={{ height: (data()?.total ?? 0) * rowHeight() + "px", position: "relative" }}>
              <div class="clip-window" style={{ position: "absolute", top: (data()?.window.offset ?? 0) * rowHeight() + "px", left: 0, right: 0 }}>
                <For each={rows()}>
                  {(row) => {
                    const item = asItem(row);
                    return (
                      <div
                        class="clip-row"
                        classList={{
                          "result-selected": selected(row),
                          "clip-row-invalid": !row.valid,
                          "clip-row-multi": checked(row),
                        }}
                        role="option"
                        aria-selected={selected(row)}
                        data-target-id={row.id}
                        onMouseMove={() => {
                          if (!data()?.hoverSelect) return;
                          props.markMouse();
                          select(row);
                        }}
                        onClick={() => activate(row)}
                        onContextMenu={(event) => { event.preventDefault(); menu(row, event.clientX, event.clientY); }}
                      >
                        <div class="clip-row-tile-box">{tile(row)}</div>
                        <div class="clip-row-body">
                          <div class="clip-row-title" title={row.content}>{row.title}</div>
                          <div class="clip-row-meta">{clipMeta(item, data()?.showSourceApp ?? true, data()?.timeDisplay === "absolute")}</div>
                        </div>
                        <Show when={row.pinned}>
                          <svg
                            class="clip-row-pin"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            aria-hidden="true"
                          >
                            <path d="M12 17v5" />
                            <path d="M9 3h6l1 4H8l1-4z" />
                            <path d="M10 7v4l-2 3h8l-2-3V7" />
                          </svg>
                        </Show>
                        <div class="clip-row-actions">
                          <button
                            class="clip-act"
                            type="button"
                            title={t("copyToClipboard")}
                            aria-label={t("copyToClipboard")}
                            tabIndex={selected(row) ? 0 : -1}
                            onClick={(event) => {
                              event.stopPropagation();
                              void props.dispatch({ type: "item.action", targetId: row.id, actionId: "copy" });
                            }}
                          >
                            <svg class="clip-act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          </button>
                          <button
                            class="clip-act"
                            type="button"
                            title={t("paste")}
                            aria-label={t("paste")}
                            tabIndex={selected(row) ? 0 : -1}
                            onClick={(event) => {
                              event.stopPropagation();
                              void props.dispatch({ type: "item.action", targetId: row.id, actionId: "paste" });
                            }}
                          >
                            <svg class="clip-act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
                              <rect x="8" y="2" width="8" height="4" rx="1" />
                            </svg>
                          </button>
                          <button
                            class="clip-act clip-act-danger"
                            type="button"
                            title={t("delete")}
                            aria-label={t("delete")}
                            tabIndex={selected(row) ? 0 : -1}
                            onClick={(event) => {
                              event.stopPropagation();
                              void props.dispatch({ type: "item.action", targetId: row.id, actionId: "delete" });
                            }}
                          >
                            <svg class="clip-act-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              <line x1="10" y1="11" x2="10" y2="17" />
                              <line x1="14" y1="11" x2="14" y2="17" />
                            </svg>
                          </button>
                        </div>
                        <Show when={checked(row)}><span class="clip-row-check">✓</span></Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </div>
        </Show>
        <Show when={fadeBottom()}>
          <div class="scroll-fade bottom" aria-hidden="true" />
        </Show>
      </div>
      <div class="clip-statusbar">
        <span class="clip-status-count">{data()?.status.text}</span>
        <div class="clip-status-actions">
          <button class="clip-status-btn" classList={{ paused: data()?.paused }} onClick={() => void props.dispatch({ type: "page.pause" })}>
            {data()?.paused ? t("clipResume") : t("clipPause")}
          </button>
          <button class="clip-clear-btn" onClick={() => void props.dispatch({ type: "clear.open" })}>{t("clipClear")}</button>
        </div>
      </div>
      <Show when={data()?.clearState?.open}>
        <>
          <div class="clip-confirm-overlay" onClick={() => void props.dispatch({ type: "clear.close" })} />
          <div class="clip-confirm" ref={(el) => { confirm = el; }} role="dialog" aria-modal="true" aria-labelledby="clip-clear-title" onKeyDown={trapConfirm}>
            <p class="clip-confirm-title" id="clip-clear-title">{t("clipClearConfirm")}</p>
            <label class="clip-confirm-check">
              <input type="checkbox" checked={data()?.clearState?.keepPinned} onChange={(event) => void props.dispatch({ type: "clear.keep-pinned", payload: { keepPinned: event.currentTarget.checked } })} />
              <span>{t("keepPinned")}</span>
            </label>
            <div class="clip-confirm-actions">
              <button class="clip-confirm-cancel" ref={(el) => { cancelButton = el; }} onClick={() => void props.dispatch({ type: "clear.close" })}>{t("cancel")}</button>
              <button class="clip-confirm-ok" onClick={() => void props.dispatch({ type: "clear.confirm" })}>{t("clipClear")}</button>
            </div>
          </div>
        </>
      </Show>
    </div>
  );
}
