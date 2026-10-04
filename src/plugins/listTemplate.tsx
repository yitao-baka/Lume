//! Built-in list template (P2.5b) — manifest `template = "list"`.
//!
//! A `kind = "mode"` plugin that declares `template = "list"` ships only its
//! `entry` logic — no `view` HTML. The registry loads the module in the
//! launcher window (the same trust model and host-API surface as provider
//! plugins) and this module adapts it to the ModeInstance contract: the
//! plugin's rows render in the standard built-in list below the search box,
//! keyboard ↑/↓/Enter ride the shared selection (the root reads `rows()`).
//!
//! Logic contract (all names mirror the provider/service hooks):
//!   search(q)      → ProviderResult[]  (required — the row source)
//!   onEnter(item)  row activation (click/Enter; the launcher stays open —
//!                  call ctx.app.hide() when done)
//!   onFeature(info) declarative `[[features]]` payload delivery
//!   onShow/onHide/onQuery/onSubInput/onSettings  optional lifecycle hooks

import { createSignal } from "solid-js";
import { For, Show } from "solid-js";
import type { Component } from "solid-js";
import type {
  FeatureEnterInfo,
  ModeInstance,
  PluginManifest,
  PluginServices,
  ProviderResult,
} from "./types";
import type { ClipboardItem } from "../launcher/types";
import { callHook } from "./registry";
import { plog } from "./log";
import { t } from "../i18n";

/** One rendered list row: icon (optional) + name + description. */
function ListTemplateView(props: {
  rows: () => ProviderResult[];
  selected: () => number;
  onSelect: (i: number) => void;
  onActivate: (i: number) => void;
  query: () => string;
}) {
  return (
    <div class="plugin-list" role="listbox">
      <Show
        when={props.rows().length > 0}
        fallback={<span class="hint">{props.query().trim() === "" ? t("pluginListEmpty") : t("noResults")}</span>}
      >
        <For each={props.rows()}>
          {(row, i) => (
            <div
              class="plugin-list-row"
              classList={{ "plugin-list-selected": i() === props.selected() }}
              role="option"
              aria-selected={i() === props.selected()}
              onMouseMove={() => props.onSelect(i())}
              onClick={() => props.onActivate(i())}
            >
              <Show when={row.icon}>
                <img class="plugin-list-icon" src={row.icon} alt="" draggable={false} />
              </Show>
              <span class="plugin-list-name">{row.name}</span>
              <Show when={row.description}>
                <span class="plugin-list-desc">{row.description}</span>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

/** Build the ModeInstance for a `template = "list"` disk mode plugin. */
export function createListTemplateMode(
  m: PluginManifest,
  logic: Record<string, unknown>,
  services: PluginServices
): ModeInstance {
  const [query, setQuerySig] = createSignal("");
  const [rows, setRows] = createSignal<ProviderResult[]>([]);
  const [selected, setSelected] = createSignal(0);
  // Loading gate (`ModeInstance.ready`): the page stays hidden until the first
  // search settles — later switches reuse the rows already in memory (no
  // spinner flash on an already-warm page).
  const [loaded, setLoaded] = createSignal(false);
  const hook = (name: string, ...args: unknown[]) => callHook(m.id, logic, name, ...args);

  const activateRow = (i: number) => {
    const item = rows()[i];
    if (!item) return;
    setSelected(i);
    try {
      const onEnter = logic.onEnter;
      if (typeof onEnter === "function") (onEnter as (it: ProviderResult) => void)(item);
      else plog.warn(m.id, "list row activated but no onEnter(item) hook — nothing happened");
    } catch (err) {
      plog.error(m.id, "list onEnter failed:", err);
    }
  };

  return {
    query,
    setQuery: (q: string) => {
      setQuerySig(q);
      hook("onQuery", q);
    },
    search: async (q: string) => {
      setQuerySig(q);
      try {
        const search = logic.search;
        if (typeof search !== "function") {
          plog.error(m.id, "list template needs search(q) — got", typeof search);
          setRows([]);
        } else {
          const out = await (search as (q: string) => Promise<ProviderResult[]> | ProviderResult[])(q);
          setRows(Array.isArray(out) ? out.filter((r) => r && typeof r.name === "string") : []);
        }
      } catch (err) {
        plog.error(m.id, "list search failed:", err);
        setRows([]);
      }
      setLoaded(true); // the loading gate opens even on an error — never stuck
      // ModeInstance contract: every search ends with a resize request.
      services.scheduleResize();
    },
    reset: () => {
      setSelected(0);
      hook("onShow");
      services.scheduleResize();
    },
    selected,
    setSelected,
    // The list template's own rows — typed as ClipboardItem[] by the
    // ModeInstance contract (the root reads only length/index semantics off
    // them; the View renders the real ProviderResult rows).
    rows: rows as unknown as () => ClipboardItem[],
    activate: () => activateRow(selected()),
    onKey: () => false,
    onEscape: () => false,
    previewTarget: () => null,
    previewEnabled: () => false,
    measureViewport: () => {},
    ready: loaded,
    desiredHeight: () => (m.height != null && m.height > 0 ? m.height : null),
    pageKind: () => "main",
    restorePage: () => {},
    applySettings: () => {},
    onHide: () => hook("onHide"),
    onEnter: (info: FeatureEnterInfo) => hook("onFeature", info),
    onSubInput: (text: string) => hook("onSubInput", text),
    onSettings: (values: Record<string, unknown>) => hook("onSettings", values),
    View: (() => (
      <ListTemplateView
        rows={rows}
        selected={selected}
        onSelect={(i) => setSelected(i)}
        onActivate={(i) => activateRow(i)}
        query={query}
      />
    )) as unknown as Component,
  };
}
