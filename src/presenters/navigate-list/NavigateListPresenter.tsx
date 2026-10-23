//! Compact alternate Navigate Presenter: one flat list, same Page Model and
//! intents as the default grid.

import { For, Show } from "solid-js";
import { t } from "../../i18n";
import type { NavigateModel, NavigateSection } from "../../page-runtime/schemas";
import type { NavigateGridProps } from "../navigate-grid/NavigateGridPresenter";

function NavRow(props: NavigateGridProps, itemId: string, label: string, description?: string) {
  const selected = () => props.selectedId() === itemId;
  return (
    <button
      class="nav-list-row"
      classList={{ active: selected() }}
      type="button"
      data-target-id={itemId}
      onMouseMove={() => void props.dispatch({ type: "selection.set", targetId: itemId, payload: { selectedIds: [itemId] } })}
      onClick={() => {
        void props.dispatch({ type: "selection.set", targetId: itemId, payload: { selectedIds: [itemId] } });
        void props.dispatch({ type: "item.activate", targetId: itemId });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        void props.dispatch({ type: "item.action", targetId: itemId, actionId: "menu", payload: { x: e.clientX, y: e.clientY } });
      }}
    >
      <span class="nav-list-label">{label}</span>
      <Show when={description}><span class="nav-list-desc">{description}</span></Show>
    </button>
  );
}

function Section(props: NavigateGridProps, section: NavigateSection) {
  return (
    <section class="nav-list-section">
      <button class="nav-list-heading" type="button" onClick={() => void props.dispatch({ type: "section.toggle", targetId: section.id })}>
        <span>{section.title}</span>
        <Show when={section.expandable}><span class="settings-chip-mini">{section.expanded ? "−" : "+"}</span></Show>
      </button>
      <Show when={section.expanded || !section.expandable}>
        <For each={section.items}>{(item) => NavRow(props, item.id, item.label, item.description)}</For>
      </Show>
    </section>
  );
}

export function NavigateListPresenter(props: NavigateGridProps) {
  const data = (): NavigateModel | undefined => props.data();
  return (
    <div class="nav-list-presenter">
      <Show
        when={(data()?.query ?? "") === ""}
        fallback={
          <Show when={(data()?.results?.items.length ?? 0) > 0} fallback={<div class="page-hint"><span class="hint">{t("noResults")}</span></div>}>
            <div class="nav-list-results">
              <For each={data()?.results?.items ?? []}>{(item) => NavRow(props, item.id, item.label, item.description)}</For>
            </div>
          </Show>
        }
      >
        <For each={data()?.sections ?? []}>{(section) => Section(props, section)}</For>
      </Show>
    </div>
  );
}
