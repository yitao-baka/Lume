//! Compact alternate Navigate Presenter: one flat list, same Page Model and
//! intents as the default grid. The list keeps the visual language of the bar
//! headers and result rows rather than falling back to an unstyled text index.

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { t } from "../../i18n";
import { pickIcon } from "../../launcher/iconSpec";
import type { ResourceRef } from "../../page-runtime/contracts";
import type { NavigateItem, NavigateModel, NavigateSection } from "../../page-runtime/schemas";
import type { NavigateGridProps } from "../navigate-grid/NavigateGridPresenter";
import unknownIcon from "../../../res/icons/unknow_universal.svg";

function resourceSrc(icon: ResourceRef | undefined): string | undefined {
  if (!icon) return undefined;
  const chosen = pickIcon({ light: icon.light || icon.src, dark: icon.dark || icon.src });
  return chosen?.src ?? icon.src;
}

function itemDetail(item: NavigateItem): string | undefined {
  if (item.description) return item.description;
  if (item.source === "provider" || item.source === "feature") return t("recommended");
  if (item.source === "explorer" || item.source === "folder") return t("explorerBar");
  return item.path;
}

function ItemIcon(props: { item: NavigateItem; iconFor: (path: string) => string | undefined }) {
  const [failed, setFailed] = createSignal(false);
  const src = () => resourceSrc(props.item.icon) ?? (props.item.path ? props.iconFor(props.item.path) : undefined);
  createEffect(() => {
    src();
    setFailed(false);
  });
  return (
    <span class="nav-list-icon" aria-hidden="true">
      <Show
        when={src() && !failed()}
        fallback={<img class="nav-list-icon-img icon-unknown" src={unknownIcon} alt="" draggable={false} />}
      >
        <img
          class="nav-list-icon-img"
          classList={{ "folder-icon-svg": props.item.mono }}
          src={src()}
          alt=""
          draggable={false}
          onError={() => setFailed(true)}
        />
      </Show>
    </span>
  );
}

function NavRow(props: {
  item: NavigateItem;
  selected: () => boolean;
  iconFor: (path: string) => string | undefined;
  markMouse: () => void;
  dispatch: NavigateGridProps["dispatch"];
  onDragStart?: (event: PointerEvent) => void;
}) {
  const detail = () => itemDetail(props.item);
  const select = () => {
    if (props.item.disabled) return;
    props.markMouse();
    if (props.selected()) return;
    void props.dispatch({ type: "selection.set", targetId: props.item.id, payload: { selectedIds: [props.item.id] } });
  };
  return (
    <div
      class="nav-list-row"
      classList={{ active: props.selected(), disabled: !!props.item.disabled, draggable: !!props.onDragStart }}
      role="option"
      aria-selected={props.selected()}
      aria-disabled={props.item.disabled || undefined}
      data-target-id={props.item.id}
      title={props.item.description || props.item.path || props.item.label}
      onMouseMove={select}
      onClick={() => {
        if (props.item.disabled) return;
        select();
        void props.dispatch({ type: "item.activate", targetId: props.item.id });
      }}
      onContextMenu={(event) => {
        if (props.item.disabled) return;
        event.preventDefault();
        props.markMouse();
        void props.dispatch({ type: "selection.set", targetId: props.item.id, payload: { selectedIds: [props.item.id] } });
        void props.dispatch({ type: "item.action", targetId: props.item.id, actionId: "menu", payload: { x: event.clientX, y: event.clientY } });
      }}
      onPointerDown={
        props.onDragStart
          ? (event) => {
              if (event.button !== 0) return;
              props.markMouse();
              props.onDragStart!(event);
            }
          : undefined
      }
    >
      <ItemIcon item={props.item} iconFor={props.iconFor} />
      <span class="nav-list-copy">
        <span class="nav-list-label">{props.item.label}</span>
        <Show when={detail()}>
          <span class="nav-list-desc">{detail()}</span>
        </Show>
      </span>
      <Show when={(props.item.source === "provider" || props.item.source === "feature") && !!props.item.description}>
        <span class="nav-list-source">{t("recommended")}</span>
      </Show>
    </div>
  );
}

function Section(props: NavigateGridProps, section: NavigateSection) {
  const data = () => props.data();
  const selectedSection = () => data()?.selectedSectionId === section.id;
  const shown = () => (section.expandable && !section.expanded ? section.items.slice(0, 1) : section.items);
  const toggle = () => {
    if (!section.expandable) return;
    props.markMouse();
    const first = section.items[0];
    if (section.expanded && first && selectedSection() && (section.selectedIndex ?? 0) > 0) {
      void props.dispatch({ type: "selection.set", targetId: first.id, payload: { selectedIds: [first.id] } });
    }
    void props.dispatch({ type: "section.toggle", targetId: section.id });
  };
  return (
    <section class="nav-list-section" role="group" aria-labelledby={`nav-list-heading-${section.id}`}>
      <button
        id={`nav-list-heading-${section.id}`}
        class="nav-list-heading"
        classList={{ static: !section.expandable }}
        type="button"
        disabled={!section.expandable}
        data-nav-section-id={section.id}
        aria-expanded={section.expandable ? section.expanded : undefined}
        aria-controls={`nav-list-items-${section.id}`}
        onClick={toggle}
      >
        <span class="nav-list-heading-title">{section.title}</span>
        <span class="nav-list-heading-count">{section.items.length}</span>
        <Show when={section.expandable}>
          <svg class="nav-list-chevron" classList={{ expanded: section.expanded }} viewBox="0 0 12 12" aria-hidden="true">
            <path d="m3 4.5 3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </Show>
      </button>
      <div
        id={`nav-list-items-${section.id}`}
        class="nav-list-items"
        data-bar-id={section.id}
        role="listbox"
        aria-label={section.title}
      >
        <For each={shown()}>
          {(item, index) => (
            <NavRow
              item={item}
              selected={() => selectedSection() && index() === section.selectedIndex}
              iconFor={props.iconFor}
              markMouse={props.markMouse}
              dispatch={props.dispatch}
              onDragStart={
                section.draggable
                  ? (event) => void props.dispatch({
                      type: "section.reorder.start",
                      targetId: section.id,
                      payload: {
                        sectionId: section.id,
                        from: index(),
                        clientX: event.clientX,
                        clientY: event.clientY,
                      },
                    })
                  : undefined
              }
            />
          )}
        </For>
      </div>
    </section>
  );
}

export function NavigateListPresenter(props: NavigateGridProps) {
  const data = (): NavigateModel | undefined => props.data();
  const results = () => data()?.results?.items ?? [];
  const pluginStart = () => Math.min(Math.max(data()?.results?.pluginStart ?? 0, 0), results().length);
  const [edges, setEdges] = createSignal({ top: false, bottom: false });
  let scroller: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;

  const updateEdges = () => {
    if (!scroller) return;
    const top = scroller.scrollTop > 1;
    const bottom = scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    const next = { top, bottom };
    if (next.top !== edges().top || next.bottom !== edges().bottom) setEdges(next);
  };

  const scrollSelectedIntoView = () => {
    const id = props.selectedId();
    if (!id || !scroller) return;
    const row = [...scroller.querySelectorAll<HTMLElement>("[data-target-id]")].find((el) => el.dataset.targetId === id);
    if (!row) return;
    const rowRect = row.getBoundingClientRect();
    const viewRect = scroller.getBoundingClientRect();
    if (rowRect.top < viewRect.top) scroller.scrollTop -= viewRect.top - rowRect.top;
    else if (rowRect.bottom > viewRect.bottom) scroller.scrollTop += rowRect.bottom - viewRect.bottom;
    updateEdges();
  };

  createEffect(() => {
    props.data();
    props.selectedId();
    const keyboard = props.selectionSource() === "keyboard";
    queueMicrotask(() => {
      if (keyboard) scrollSelectedIntoView();
      updateEdges();
    });
  });

  onMount(() => {
    resizeObserver = new ResizeObserver(() => queueMicrotask(updateEdges));
    if (scroller) resizeObserver.observe(scroller);
    queueMicrotask(() => {
      scrollSelectedIntoView();
      updateEdges();
    });
  });
  onCleanup(() => resizeObserver?.disconnect());

  return (
    <div class="nav-list-presenter">
      <div
        class="nav-list-scroll"
        ref={scroller}
        onScroll={() => {
          updateEdges();
        }}
      >
        <Show
          when={(data()?.query ?? "") === ""}
          fallback={
            <Show
              when={results().length > 0}
              fallback={<div class="page-hint"><span class="hint">{data()?.emptyText || t("noResults")}</span></div>}
            >
              <div class="nav-list-results" role="listbox" aria-label={t("navigate")}>
                <For each={results()}>
                  {(item, index) => (
                    <>
                      <Show when={pluginStart() < results().length && index() === pluginStart()}>
                        <div class="nav-list-split" classList={{ first: pluginStart() === 0 }} role="separator">
                          <span class="bar-title">{t("recommended")}</span>
                        </div>
                      </Show>
                      <NavRow
                        item={item}
                        selected={() => props.selectedId() === item.id}
                        iconFor={props.iconFor}
                        markMouse={props.markMouse}
                        dispatch={props.dispatch}
                      />
                    </>
                  )}
                </For>
              </div>
            </Show>
          }
        >
          <Show when={(data()?.sections?.length ?? 0) > 0}>
            <For each={data()?.sections ?? []}>{(section) => Section(props, section)}</For>
          </Show>
        </Show>
      </div>
      <Show when={edges().top}><div class="scroll-fade top" aria-hidden="true" /></Show>
      <Show when={edges().bottom}><div class="scroll-fade bottom" aria-hidden="true" /></Show>
    </div>
  );
}
