//! Compact clipboard Presenter — the same windowed model and intents as the
//! default history list. It keeps the dense 44px rhythm while preserving row
//! identity, source/time metadata, multi-select, pin and invalid states.

import { For, Show, createEffect, onCleanup, onMount } from "solid-js";
import { t } from "../../i18n";
import { basename, clipMeta, clipTitle, detectColor, fileContent, isUrl } from "../../launcher/clipData";
import type { ClipboardItem } from "../../launcher/types";
import type { ClipboardRowModel } from "../../page-runtime/schemas";
import type { ClipboardListProps } from "../clipboard-list/ClipboardListPresenter";
import clipboardIcon from "../../../res/icons/clipboard.svg";
import multifilesIcon from "../../../res/icons/multifiles.svg";

const COMPACT_ROW_H = 44;

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

function kindLabel(row: ClipboardRowModel): string {
  if (row.kind === "text") return t("clipCategoryText");
  if (row.kind === "image") return t("clipCategoryImage");
  if (row.kind === "audio") return t("clipCategoryMusic");
  if (row.kind === "video") return t("clipCategoryVideo");
  if (row.kind === "file") {
    const first = row.content.split(/\r?\n/).find(Boolean) ?? "";
    const kind = fileContent(basename(first));
    if (kind === "audio") return t("clipCategoryMusic");
    if (kind === "video") return t("clipCategoryVideo");
    if (kind === "image") return t("clipCategoryImage");
    if (kind === "text") return t("clipCategoryTextFile");
    return t("pluginFeatureTypeFiles");
  }
  return t("pluginFeatureTypeFiles");
}

function CompactTile(props: { row: ClipboardRowModel }) {
  if (props.row.kind === "image") {
    return (
      <span class="clip-compact-tile clip-compact-tile-media">
        <Show when={props.row.thumb} fallback={<span class="clip-compact-glyph">▧</span>}>
          <img class="clip-compact-thumb" src={props.row.thumb!.src} alt="" draggable={false} />
        </Show>
      </span>
    );
  }
  if (props.row.kind === "file") {
    const paths = props.row.content.split(/\r?\n/).filter(Boolean);
    if (paths.length >= 2) {
      return <span class="clip-compact-tile"><img class="clip-compact-tile-icon" src={multifilesIcon} alt="" /></span>;
    }
    const name = basename(paths[0] ?? "");
    const kind = fileContent(name);
    const glyph = kind === "audio" ? "♪" : kind === "video" ? "▷" : kind === "image" ? "▧" : kind === "text" ? "≡" : kind === "pdf" ? "PDF" : (name.split(".").pop() || "FILE").slice(0, 4).toUpperCase();
    return <span class="clip-compact-tile"><span class="clip-compact-glyph" classList={{ small: glyph.length > 2 }}>{glyph}</span></span>;
  }
  const color = props.row.kind === "text" ? detectColor(props.row.content) : null;
  if (color) return <span class="clip-compact-tile clip-compact-color" style={{ background: color }} />;
  if (props.row.kind === "text" && isUrl(props.row.content)) {
    return <span class="clip-compact-tile"><span class="clip-compact-glyph">↗</span></span>;
  }
  return <span class="clip-compact-tile"><span class="clip-compact-glyph text">T</span></span>;
}

export function ClipboardCompactPresenter(props: ClipboardListProps) {
  const data = () => props.data();
  const rows = () => data()?.items ?? [];
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
  const measureViewport = () => {
    if (!list) return;
    void props.dispatch({
      type: "viewport.request",
      payload: { scrollTop: list.scrollTop, viewportHeight: list.clientHeight, rowHeight: COMPACT_ROW_H },
    });
  };
  const bindList = (el: HTMLDivElement) => {
    list = el;
    resizeObserver?.disconnect();
    resizeObserver ??= new ResizeObserver(() => queueMicrotask(measureViewport));
    resizeObserver.observe(el);
    queueMicrotask(measureViewport);
  };
  onMount(() => queueMicrotask(measureViewport));
  onCleanup(() => resizeObserver?.disconnect());

  createEffect(() => {
    const open = !!data()?.clearState?.open;
    if (open && !clearWasOpen) queueMicrotask(() => cancelButton?.focus());
    if (!open && clearWasOpen) queueMicrotask(() => document.getElementById("search-input")?.focus());
    clearWasOpen = open;
  });
  // Keyboard selection can move outside the present model window. Scroll the
  // authoritative index into view; the resulting scroll event asks the Page
  // Service for a fresh row slice.
  createEffect(() => {
    const index = data()?.selectedIndex ?? -1;
    if (index < 0 || !list || props.selectionSource() !== "keyboard") return;
    const top = index * COMPACT_ROW_H;
    const bottom = top + COMPACT_ROW_H;
    if (top < list.scrollTop) list.scrollTop = top;
    else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 8;
  });

  const trapConfirm = (event: KeyboardEvent) => {
    if (event.key !== "Tab" || !confirm) return;
    const focusable = [...confirm.querySelectorAll<HTMLElement>('button,input,[tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hasAttribute("disabled"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div class="clip-page clip-compact-presenter">
      <div class="clip-cats" role="tablist" aria-label={t("clipboardCategory")}>
        <For each={data()?.categories ?? []}>
          {(category) => (
            <button
              class="clip-cat"
              classList={{ active: data()?.activeCategory === category.id }}
              type="button"
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
        <Show when={(data()?.window.offset ?? 0) > 0}><div class="scroll-fade top" aria-hidden="true" /></Show>
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
            class="clip-list clip-compact-list"
            ref={bindList}
            role="listbox"
            aria-label={t("clipboard")}
            onScroll={(event) => void props.dispatch({
              type: "viewport.request",
              payload: {
                scrollTop: event.currentTarget.scrollTop,
                viewportHeight: event.currentTarget.clientHeight,
                rowHeight: COMPACT_ROW_H,
              },
            })}
          >
            <div class="clip-compact-spacer" style={{ height: (data()?.total ?? 0) * COMPACT_ROW_H + "px" }}>
              <div class="clip-compact-window" style={{ top: (data()?.window.offset ?? 0) * COMPACT_ROW_H + "px" }}>
                <For each={rows()}>
                  {(row) => {
                    const item = asItem(row);
                    return (
                      <div
                        class="clip-compact-row"
                        classList={{
                          "result-selected": selected(row),
                          "clip-row-invalid": !row.valid,
                          "clip-row-multi": checked(row),
                          "clip-compact-pinned": row.pinned,
                        }}
                        role="option"
                        aria-selected={selected(row)}
                        tabIndex={-1}
                        data-target-id={row.id}
                        title={row.content || row.title}
                        onMouseMove={() => {
                          if (!data()?.hoverSelect) return;
                          props.markMouse();
                          select(row);
                        }}
                        onClick={() => activate(row)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          menu(row, event.clientX, event.clientY);
                        }}
                      >
                        <CompactTile row={row} />
                        <span class="clip-compact-copy">
                          <span class="clip-compact-title">{clipTitle(item) || row.title}</span>
                          <span class="clip-compact-meta">
                            <span class="clip-compact-kind">{kindLabel(row)}</span>
                            <span class="clip-compact-dot" aria-hidden="true">·</span>
                            <span>{clipMeta(item, data()?.showSourceApp ?? true, data()?.timeDisplay === "absolute")}</span>
                          </span>
                        </span>
                        <span class="clip-compact-badges">
                          <Show when={row.pinned}>
                            <svg class="clip-row-pin" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                              <path d="M12 17v5" />
                              <path d="M9 3h6l1 4H8l1-4z" />
                              <path d="M10 7v4l-2 3h8l-2-3V7" />
                            </svg>
                          </Show>
                          <Show when={checked(row)}><span class="clip-row-check">✓</span></Show>
                        </span>
                      </div>
                    );
                  }}
                </For>
              </div>
            </div>
          </div>
        </Show>
        <Show when={(data()?.window.offset ?? 0) + (data()?.window.limit ?? 0) < (data()?.total ?? 0)}>
          <div class="scroll-fade bottom" aria-hidden="true" />
        </Show>
      </div>
      <div class="clip-statusbar">
        <span class="clip-status-count">{data()?.status.text}</span>
        <div class="clip-status-actions">
          <button class="clip-status-btn" classList={{ paused: data()?.paused }} onClick={() => void props.dispatch({ type: "page.pause" })}>{data()?.paused ? t("clipResume") : t("clipPause")}</button>
          <button class="clip-clear-btn" onClick={() => void props.dispatch({ type: "clear.open" })}>{t("clipClear")}</button>
        </div>
      </div>
      <Show when={data()?.clearState?.open}>
        <>
          <div class="clip-confirm-overlay" onClick={() => void props.dispatch({ type: "clear.close" })} />
          <div class="clip-confirm" ref={(el) => { confirm = el; }} role="dialog" aria-modal="true" aria-labelledby="clip-compact-clear-title" onKeyDown={trapConfirm}>
            <p class="clip-confirm-title" id="clip-compact-clear-title">{t("clipClearConfirm")}</p>
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
