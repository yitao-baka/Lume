//! Compact clipboard Presenter — the same windowed model and intents as the
//! default history list, with a denser layout.

import { For, Show } from "solid-js";
import { t } from "../../i18n";
import { basename, clipTitle } from "../../launcher/clipData";
import type { ClipboardItem } from "../../launcher/types";
import type { ClipboardRowModel } from "../../page-runtime/schemas";
import type { ClipboardListProps } from "../clipboard-list/ClipboardListPresenter";

function item(row: ClipboardRowModel): ClipboardItem {
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

export function ClipboardCompactPresenter(props: ClipboardListProps) {
  const data = () => props.data();
  return (
    <div class="clip-page clip-compact-presenter">
      <div class="clip-cats" role="tablist" aria-label={t("clipboardCategory")}>
        <For each={data()?.categories ?? []}>
          {(category) => (
            <button class="clip-cat" classList={{ active: data()?.activeCategory === category.id }} role="tab" aria-selected={data()?.activeCategory === category.id}
              onClick={() => void props.dispatch({ type: "category.select", payload: { kind: category.id } })}>{category.label}</button>
          )}
        </For>
      </div>
      <div class="clip-main">
        <Show when={(data()?.items.length ?? 0) > 0} fallback={<div class="clip-empty"><p class="clip-empty-title">{data()?.emptyText}</p></div>}>
          <div class="clip-list" role="listbox" onScroll={(event) => void props.dispatch({ type: "viewport.request", payload: { scrollTop: event.currentTarget.scrollTop } })}>
            <div style={{ position: "relative", height: (data()?.total ?? 0) * 38 + "px" }}>
              <div style={{ position: "absolute", top: (data()?.window.offset ?? 0) * 38 + "px", left: 0, right: 0 }}>
                <For each={data()?.items ?? []}>
                  {(row) => {
                    const clip = item(row);
                    const active = props.selectedId() === row.id;
                    return (
                      <button class="nav-list-row" classList={{ active }} type="button" style={{ height: "38px" }} data-target-id={row.id}
                        onMouseMove={() => void props.dispatch({ type: "selection.set", targetId: row.id, payload: { selectedIds: [row.id] } })}
                        onClick={() => void props.dispatch({ type: "item.activate", targetId: row.id })}
                        onContextMenu={(event) => { event.preventDefault(); void props.dispatch({ type: "item.action", targetId: row.id, actionId: "menu", payload: { x: event.clientX, y: event.clientY } }); }}>
                        <span class="nav-list-label">{row.pinned ? "★ " : ""}{clipTitle(clip) || basename(row.content)}</span>
                        <span class="settings-chip-mini">{row.kind}</span>
                      </button>
                    );
                  }}
                </For>
              </div>
            </div>
          </div>
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
        <div class="clip-confirm" role="dialog" aria-modal="true">
          <p class="clip-confirm-title">{t("clipClearConfirm")}</p>
          <label class="clip-confirm-check"><input type="checkbox" checked={data()?.clearState?.keepPinned} onChange={(e) => void props.dispatch({ type: "clear.keep-pinned", payload: { keepPinned: e.currentTarget.checked } })} /><span>{t("keepPinned")}</span></label>
          <div class="clip-confirm-actions"><button class="clip-confirm-cancel" onClick={() => void props.dispatch({ type: "clear.close" })}>{t("cancel")}</button><button class="clip-confirm-ok" onClick={() => void props.dispatch({ type: "clear.confirm" })}>{t("clipClear")}</button></div>
        </div>
      </Show>
    </div>
  );
}
