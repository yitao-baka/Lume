//! Default Navigate Presenter. Reads only lume.navigate/v1 data and emits
//! semantic selection/action/reorder intents.

import { For, Show, createEffect, onMount } from "solid-js";
import { t } from "../../i18n";
import { pickIcon } from "../../launcher/iconSpec";
import type { ResourceRef } from "../../page-runtime/contracts";
import type { NavigateItem, NavigateModel, NavigateSection } from "../../page-runtime/schemas";
import unknownIcon from "../../../res/icons/unknow_universal.svg";

export interface NavigateGridProps {
  data: () => NavigateModel | undefined;
  selectedId: () => string | undefined;
  barCols: () => number;
  iconFor: (path: string) => string | undefined;
  dispatch: (intent: { type: string; targetId?: string; actionId?: string; payload?: unknown }) => Promise<unknown>;
  markMouse: () => void;
  selectionSource: () => "keyboard" | "mouse" | "other";
}

function resourceSrc(icon: ResourceRef | undefined): string | undefined {
  if (!icon) return undefined;
  const chosen = pickIcon({ light: icon.light || icon.src, dark: icon.dark || icon.src });
  return chosen?.src ?? icon.src;
}

function ItemBox(props: {
  item: NavigateItem;
  selected: boolean;
  barCols: () => number;
  iconFor: (path: string) => string | undefined;
  onSelect: () => void;
  onActivate: () => void;
  onMenu: (x: number, y: number) => void;
  onDragStart?: (event: PointerEvent) => void;
}) {
  const src = () => resourceSrc(props.item.icon) ?? (props.item.path ? props.iconFor(props.item.path) : undefined);
  return (
    <div
      class="result-box"
      classList={{ "result-selected": props.selected, "folder-box": !!props.item.wrap }}
      role="option"
      aria-selected={props.selected}
      data-target-id={props.item.id}
      onMouseMove={props.onSelect}
      onClick={props.onActivate}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onMenu(e.clientX, e.clientY);
      }}
      onPointerDown={props.onDragStart}
    >
      <span class="result-box-tile result-box-icon">
        <Show when={src()} fallback={<img class="result-box-img icon-unknown" src={unknownIcon} alt="" />}>
          <img class={"result-box-img" + (props.item.mono ? " folder-icon-svg" : "")} src={src()} alt="" draggable={false} />
        </Show>
      </span>
      <span class="result-box-name" title={props.item.label}>{props.item.label}</span>
      <Show when={props.item.description}>
        <span class="result-box-desc" title={props.item.description}>{props.item.description}</span>
      </Show>
    </div>
  );
}

function SectionView(props: NavigateGridProps, section: NavigateSection) {
  const cols = () => Math.max(props.barCols(), 1);
  const selectedSection = () => props.data()?.selectedSectionId === section.id;
  const shown = () => (!section.expandable || section.expanded ? section.items : section.items.slice(0, cols()));
  const dispatchSelection = (item: NavigateItem) => {
    props.markMouse();
    void props.dispatch({ type: "selection.set", targetId: item.id, payload: { selectedIds: [item.id] } });
  };
  return (
    <div class="bar-section">
      <div class="bar-header">
        <span class="bar-title">{section.title}</span>
        <Show when={section.expandable && section.items.length > cols()}>
          <button class="bar-expand" onClick={() => void props.dispatch({ type: "section.toggle", targetId: section.id })}>
            {section.expanded ? t("collapse") : t("expand")}
          </button>
        </Show>
      </div>
      <div class="bar-grid" classList={{ collapsed: section.expandable && !section.expanded }} data-bar-id={section.id}>
        <For each={shown()}>
          {(item, index) => (
            <ItemBox
              item={item}
              selected={selectedSection() && index() === section.selectedIndex}
              barCols={props.barCols}
              iconFor={props.iconFor}
              onSelect={() => dispatchSelection(item)}
              onActivate={() => {
                props.markMouse();
                void props.dispatch({ type: "selection.set", targetId: item.id, payload: { selectedIds: [item.id] } });
                void props.dispatch({ type: "item.activate", targetId: item.id });
              }}
              onMenu={(x, y) => {
                dispatchSelection(item);
                void props.dispatch({ type: "item.action", targetId: item.id, actionId: "menu", payload: { x, y } });
              }}
              onDragStart={
                section.draggable
                  ? (event) => {
                      if (event.button !== 0) return;
                      void props.dispatch({
                        type: "section.reorder.start",
                        targetId: section.id,
                        payload: { sectionId: section.id, from: index(), clientX: event.clientX, clientY: event.clientY },
                      });
                    }
                  : undefined
              }
            />
          )}
        </For>
      </div>
    </div>
  );
}

export function NavigateGridPresenter(props: NavigateGridProps) {
  const data = () => props.data();
  const results = () => data()?.results?.items ?? [];
  const pluginStart = () => Math.min(Math.max(data()?.results?.pluginStart ?? 0, 0), results().length);
  const resultSelected = (item: NavigateItem) => !data()?.selectedSectionId && props.selectedId() === item.id;
  const scrollSelectedIntoView = () => {
    document
      .querySelector(".mode-host.active .result-selected")
      ?.scrollIntoView({ block: "nearest" });
  };
  createEffect(() => {
    props.data();
    props.selectedId();
    if (props.selectionSource() !== "keyboard") return;
    queueMicrotask(scrollSelectedIntoView);
  });
  onMount(() => queueMicrotask(scrollSelectedIntoView));
  const result = (item: NavigateItem) => (
    <ItemBox
      item={item}
      selected={resultSelected(item)}
      barCols={props.barCols}
      iconFor={props.iconFor}
      onSelect={() => {
        props.markMouse();
        void props.dispatch({ type: "selection.set", targetId: item.id, payload: { selectedIds: [item.id] } });
      }}
      onActivate={() => {
        props.markMouse();
        void props.dispatch({ type: "selection.set", targetId: item.id, payload: { selectedIds: [item.id] } });
        void props.dispatch({ type: "item.activate", targetId: item.id });
      }}
      onMenu={(x, y) => {
        void props.dispatch({ type: "selection.set", targetId: item.id, payload: { selectedIds: [item.id] } });
        void props.dispatch({ type: "item.action", targetId: item.id, actionId: "menu", payload: { x, y } });
      }}
    />
  );
  return (
    <Show
      when={(data()?.query ?? "") === ""}
      fallback={
        <Show
          when={results().length > 0}
          fallback={<div class="page-hint"><span class="hint">{t("noResults")}</span></div>}
        >
          <div class="result-grid" role="grid">
            {results().slice(0, pluginStart()).map(result)}
            <Show when={pluginStart() < results().length}>
              <div class="result-split" classList={{ first: pluginStart() === 0 }} role="presentation">
                <span class="bar-title">{t("recommended")}</span>
              </div>
            </Show>
            {results().slice(pluginStart()).map(result)}
          </div>
        </Show>
      }
    >
      <div class="bar-list">
        <For each={data()?.sections ?? []}>{(section) => SectionView(props, section)}</For>
      </div>
    </Show>
  );
}
