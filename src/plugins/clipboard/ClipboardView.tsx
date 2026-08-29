//! Clipboard-mode view — category tabs, the virtualized history list and the
//! status bar. Pure rendering: rows and windowing come from props + the
//! clipboard store; interactions go back out through callbacks.

import { Show } from "solid-js";
import { t } from "../../i18n";
import clipboardIcon from "../../../res/icons/clipboard.svg";
import multifilesIcon from "../../../res/icons/multifiles.svg";
import { basename, clipMeta, clipTitle, detectColor, fileContent, isUrl } from "../../launcher/clipData";
import { CLIP_CATS, CLIP_ROW_H, type ClipboardItem } from "../../launcher/types";
import type { PluginServices } from "../../plugins/types";
import type { ClipboardStore } from "./store";

export interface ClipboardViewProps {
  clip: ClipboardStore;
  services: PluginServices;
}

/** Left tile of a clipboard row: image thumb is rendered by the caller; the
 * file / link / color / plain-text fallbacks live here. */
function clipTile(item: ClipboardItem, color: string | null, link: boolean) {
  if (item.kind === "file") {
    const paths = item.content.split("\n").filter(Boolean);
    // 混合类型的多文件行 (item 6): 无论首文件类型，统一用 multifiles 图标；
    // 全部同类型时仍按该类型显示（音频音符 / 视频摄像 / 图片 / 文本 / 通用）。
    if (paths.length >= 2) {
      const kinds = new Set(paths.map((p) => fileContent(basename(p))));
      if (kinds.size > 1) {
        return (
          <span class="clip-row-tile">
            <img class="clip-row-tile-icon" src={multifilesIcon} alt="" draggable={false} />
          </span>
        );
      }
    }
    const first = paths[0] ?? "";
    const content = fileContent(basename(first));
    if (content === "audio") {
      return (
        <span class="clip-row-tile">
          <svg class="clip-row-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M9 18V5l12-2v13" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="16" r="3" />
          </svg>
        </span>
      );
    }
    if (content === "video") {
      return (
        <span class="clip-row-tile">
          <svg class="clip-row-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polygon points="23 7 16 12 23 17 23 7" />
            <rect x="1" y="5" width="15" height="14" rx="2" />
          </svg>
        </span>
      );
    }
    if (content === "image") {
      return (
        <span class="clip-row-tile">
          <svg class="clip-row-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
        </span>
      );
    }
    if (content === "text") {
      return (
        <span class="clip-row-tile">
          <svg class="clip-row-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="4 7 4 4 20 4 20 7" />
            <line x1="9" y1="20" x2="15" y2="20" />
            <line x1="12" y1="4" x2="12" y2="20" />
          </svg>
        </span>
      );
    }
    return (
      <span class="clip-row-tile">
        <svg
          class="clip-row-tile-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>
      </span>
    );
  }
  if (link) {
    return (
      <span class="clip-row-tile">
        <svg
          class="clip-row-tile-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
      </span>
    );
  }
  if (color) {
    return <span class="clip-row-tile clip-row-tile-color" style={{ background: color }} />;
  }
  return <span class="clip-row-tile clip-row-tile-text">T</span>;
}

export function ClipboardView(props: ClipboardViewProps) {
  const clip = props.clip;
  const services = props.services;

  /** A single clipboard history row: tile, two-line body, hover actions. */
  function clipRow(item: ClipboardItem, idx: number) {
    const isSelected = idx === clip.selected();
    const color = item.kind === "text" ? detectColor(item.content) : null;
    const link = item.kind === "text" && isUrl(item.content);
    return (
      <div
        class="clip-row"
        classList={{
          "result-selected": isSelected,
          "clip-row-deleting": clip.deletingId() === item.id,
          "clip-row-multi": clip.multiIds().has(item.id),
          // 失效条目 (item 7): 内容已不存在 → 划线变灰，复制/粘贴被拦截。
          "clip-row-invalid": item.valid === false,
        }}
        role="option"
        aria-selected={isSelected}
        onMouseMove={() => {
          // Hover-selection is a setting (default off — then only a click
          // selects). It is also ignored while keyboard nav is active.
          if (!clip.hoverSelect() || services.selectionSource() === "keyboard") return;
          services.markMouse();
          clip.setSelected(idx);
        }}
        onClick={() => {
          services.markMouse();
          // First click selects the entry; a second click on the already
          // selected row pastes it.
          if (clip.selected() === idx) {
            clip.activate();
          } else {
            clip.setSelected(idx);
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          // Right-click must leave the window state (selection → preview pane
          // → window width) unchanged: the menu acts on `item` directly, so we
          // don't re-select the row here.
          services.openMenu({ kind: "clip", x: e.clientX, y: e.clientY, item });
        }}
      >
        <div class="clip-row-tile-box">
          <Show when={item.kind === "image" && item.thumb} fallback={clipTile(item, color, link)}>
            <span class="clip-row-tile">
              <img class="clip-row-img" src={item.thumb ?? undefined} alt="" draggable={false} />
            </span>
          </Show>
        </div>
        <div class="clip-row-body">
          <div class="clip-row-title" title={item.content}>
            {clipTitle(item)}
          </div>
          <div class="clip-row-meta">{clipMeta(item, clip.showSourceApp(), clip.timeDisplayAbs())}</div>
        </div>
        <Show when={item.pinned}>
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
            title={t("copyToClipboard")}
            aria-label={t("copyToClipboard")}
            onClick={(e) => {
              e.stopPropagation();
              clip.copyOnly(item);
            }}
          >
            <svg
              class="clip-act-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          </button>
          <button
            class="clip-act"
            title={t("paste")}
            aria-label={t("paste")}
            onClick={(e) => {
              e.stopPropagation();
              clip.pasteClip(item);
            }}
          >
            <svg
              class="clip-act-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
              <rect x="8" y="2" width="8" height="4" rx="1" />
            </svg>
          </button>
          <button
            class="clip-act clip-act-danger"
            title={t("delete")}
            aria-label={t("delete")}
            onClick={(e) => {
              e.stopPropagation();
              clip.requestDelete(item.id);
            }}
          >
            <svg
              class="clip-act-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        </div>
        <Show when={clip.multiIds().has(item.id)}>
          <span class="clip-row-check">✓</span>
        </Show>
      </div>
    );
  }

  return (
    <div class="clip-page">
      <div class="clip-cats" role="tablist" aria-label="Clipboard category">
        {CLIP_CATS.map((c) => (
          <button
            class="clip-cat"
            classList={{ active: clip.clipKind() === c.kind }}
            role="tab"
            aria-selected={clip.clipKind() === c.kind}
            onClick={() => clip.setClipKindAndSearch(c.kind)}
          >
            {t(c.label)}
          </button>
        ))}
      </div>
      <div class="clip-main">
        <Show
          when={clip.clips().length > 0}
          fallback={
            <div class="clip-empty">
              <img class="clip-empty-icon" src={clipboardIcon} alt="" draggable={false} />
              <p class="clip-empty-title">
                {clip.clipQuery() ? t("noResults") : t("noClipboardHistory")}
              </p>
              <Show when={!clip.clipQuery()}>
                <p class="clip-empty-hint">{t("clipEmptyHint")}</p>
              </Show>
            </div>
          }
        >
          <div
            class="clip-list"
            ref={(el) => clip.bindScrollEl(el)}
            role="listbox"
            onScroll={(e) =>
              clip.setClipScrollTop((e.currentTarget as HTMLDivElement).scrollTop)
            }
          >
            <div
              class="clip-spacer"
              style={{
                height: `${clip.clips().length * CLIP_ROW_H}px`,
                position: "relative",
              }}
            >
              <div
                class="clip-window"
                style={{
                  position: "absolute",
                  top: `${clip.clipStart() * CLIP_ROW_H}px`,
                  left: 0,
                  right: 0,
                }}
              >
                {clip
                  .clips()
                  .slice(clip.clipStart(), clip.clipEnd())
                  .map((item, i) => clipRow(item, clip.clipStart() + i))}
              </div>
            </div>
          </div>
        </Show>
      </div>
      <div class="clip-statusbar">
        <span class="clip-status-count">
          {clip.multiIds().size > 0
            ? t("clipSelected", { count: String(clip.multiIds().size) })
            : t("clipTotal", { count: String(clip.clips().length) })}
        </span>
        <div class="clip-status-actions">
          <button
            class="clip-status-btn"
            classList={{ paused: clip.clipPaused() }}
            title={clip.clipPaused() ? t("clipResume") : t("clipPause")}
            onClick={clip.toggleClipPause}
          >
            {clip.clipPaused() ? t("clipResume") : t("clipPause")}
          </button>
          <button class="clip-clear-btn" onClick={() => clip.setClearOpen(true)}>
            {t("clipClear")}
          </button>
        </div>
      </div>

      <Show when={clip.clearOpen()}>
        <div class="clip-confirm">
          <p class="clip-confirm-title">{t("clipClearConfirm")}</p>
          <label class="clip-confirm-check">
            <input
              type="checkbox"
              checked={clip.keepPinned()}
              onChange={(e) =>
                clip.setKeepPinned((e.currentTarget as HTMLInputElement).checked)
              }
            />
            <span>{t("keepPinned")}</span>
          </label>
          <div class="clip-confirm-actions">
            <button class="clip-confirm-cancel" onClick={() => clip.setClearOpen(false)}>
              {t("cancel")}
            </button>
            <button class="clip-confirm-ok" onClick={clip.doClear}>
              {t("clipClear")}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
