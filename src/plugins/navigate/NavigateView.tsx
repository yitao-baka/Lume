//! Navigate home-page view — the empty-query main menu (one section per bar:
//! 最近使用 / 已固定 / plugin bars / the Explorer-folder bar) and the search
//! results grid. Pure rendering: state comes in as accessors + the navigate
//! store's section registry; interactions go back out through the section
//! contract and callbacks.

import { For, Show } from "solid-js";
import { t } from "../../i18n";
import unknownIcon from "../../../res/icons/unknow_universal.svg";
import type { AppEntry, MenuState } from "../../launcher/types";
import type { NavSection, NavigateStore } from "./store";

export interface NavigateViewProps {
  apps: () => AppEntry[];
  appsQuery: () => string;
  selected: () => number;
  nav: NavigateStore;
  barCols: () => number;
  iconFor: (path: string) => string | undefined;
  activate: () => void;
  /** selectionSource = "mouse" (hover/click takes over from keyboard nav). */
  markMouse: () => void;
  openMenu: (m: MenuState) => void;
  setSelected: (i: number) => void;
  /** P2.2: render the grid even on an empty query (file-drop / clipboard-
   * image plugin rows replace the bars until the next hide/summon). */
  forceGrid?: () => boolean;
}

/** A single box in a bar or the results grid, with icon resolution: an
 * explicit item icon (explorer tiles / plugin bars) wins, then the cached
 * icon pipeline, then the unknown-icon fallback. `selected` is an accessor —
 * boxes render inside <For> callbacks (not tracking scopes), so the
 * highlight class must be read reactively at the classList position or it
 * freezes at the initial value (no selection feedback at all). */
function itemBox(
  props: NavigateViewProps,
  item: { name: string; path: string; icon?: string; mono?: boolean; description?: string },
  opts: { wrap?: boolean },
  selected: () => boolean,
  handlers: {
    onActivate: () => void;
    onSelect: () => void;
    onContext: (e: MouseEvent) => void;
    /** Pinned-bar pointer reorder: called on left-button pointerdown. */
    onDragPress?: (e: PointerEvent) => void;
  }
) {
  const src = () => item.icon ?? props.iconFor(item.path);
  return (
    <div
      class="result-box"
      classList={{ "result-selected": selected(), "folder-box": opts.wrap }}
      role="option"
      aria-selected={selected()}
      onMouseMove={handlers.onSelect}
      onClick={handlers.onActivate}
      onContextMenu={(e) => {
        e.preventDefault();
        handlers.onContext(e);
      }}
      onPointerDown={handlers.onDragPress}
    >
      <span class="result-box-tile result-box-icon">
        <Show
          when={src()}
          fallback={
            <img class="result-box-img icon-unknown" src={unknownIcon} alt="" />
          }
        >
          <img
            class={`result-box-img${item.mono ? " folder-icon-svg" : ""}`}
            src={src()}
            alt=""
            draggable={false}
          />
        </Show>
      </span>
      <span class="result-box-name">{item.name}</span>
      <Show when={item.description}>
        <span class="result-box-desc">{item.description}</span>
      </Show>
    </div>
  );
}

/** One titled bar (栏目) on the empty-query main menu, rendered from its
 * NavSection contract. Collapsed = the measured column count (one row);
 * expanded (or non-expandable) = everything. The 展开 button only appears
 * when an expandable bar's content exceeds one row. */
function SectionView(props: NavigateViewProps, section: NavSection) {
  const nav = props.nav;
  // Reactive: 条目框大小 / 窗口宽度变化会重测列数，切片与展开按钮随之更新。
  const cols = () => Math.max(props.barCols(), 1);
  const zoneActive = () => nav.zone() === section.id;
  const shown = () =>
    !section.expandable || section.expanded() ? section.items : section.items.slice(0, cols());

  return (
    <div class="bar-section">
      <div class="bar-header">
        <span class="bar-title">{section.title}</span>
        <Show when={section.expandable && section.items.length > cols()}>
          <button class="bar-expand" onClick={() => section.toggleExpanded()}>
            {section.expanded() ? t("collapse") : t("expand")}
          </button>
        </Show>
      </div>
      <div
        class="bar-grid"
        data-bar-id={section.id}
        classList={{ collapsed: section.expandable && !section.expanded() }}
      >
        <For each={shown()}>
          {(item, i) =>
            itemBox(
              props,
              item,
              { wrap: section.wrap },
              () => zoneActive() && i() === section.selected(),
              {
                onActivate: () => {
                  props.markMouse();
                  nav.setZone(section.id);
                  section.setSelected(i());
                  props.activate();
                },
                onSelect: () => {
                  props.markMouse();
                  nav.setZone(section.id);
                  section.setSelected(i());
                },
                onContext: (e) => section.onContext(e, i()),
                onDragPress:
                  section.draggable && section.onDragStart
                    ? (e) => {
                        // Left button only; right/middle stay context/aux-click.
                        if (e.button !== 0) return;
                        section.onDragStart!(i(), e);
                      }
                    : undefined,
              }
            )
          }
        </For>
      </div>
    </div>
  );
}

export function NavigateView(props: NavigateViewProps) {
  const nav = props.nav;

  return (
    <Show
      when={props.appsQuery() === "" && !props.forceGrid?.()}
      fallback={
        <Show
          when={props.apps().length > 0}
          fallback={
            // `.page-hint` is the sizer's measurable row for this state: the
            // fit window shrinks to the search row + this hint.
            <div class="page-hint">
              <span class="hint">{t("noResults")}</span>
            </div>
          }
        >
          <div class="result-grid" role="grid">
            {props.apps().map((app, i) =>
              itemBox(props, app, {}, () => i === props.selected(), {
                onActivate: () => {
                  props.markMouse();
                  props.setSelected(i);
                  props.activate();
                },
                onSelect: () => {
                  // Mouse movement over an entry always takes over selection
                  // (no keyboard-precedence gate that could leave hover
                  // stalled; a stray position won't fire without movement).
                  props.markMouse();
                  props.setSelected(i);
                },
                onContext: (e) => {
                  props.setSelected(i);
                  nav.setZone("grid");
                  props.openMenu({ kind: "app", x: e.clientX, y: e.clientY, app });
                },
              })
            )}
          </div>
        </Show>
      }
    >
      <div class="bar-list">
        <For each={nav.sections()}>{(section) => SectionView(props, section)}</For>
      </div>
    </Show>
  );
}
