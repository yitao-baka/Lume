//! Navigate-mode view — the empty-query main menu (最近使用 / 已固定 /
//! Explorer-folder bars) and the search results grid. Pure rendering: state
//! comes in as accessors + the navigate store; interactions go back out
//! through callbacks.

import { For, Show } from "solid-js";
import { t } from "../i18n";
import copyIcon from "../../res/icons/copy.svg";
import runIcon from "../../res/icons/normal_run.svg";
import unknownIcon from "../../res/icons/unknow_universal.svg";
import type { AppEntry, MenuState } from "./types";
import type { NavigateStore } from "./navigate";

export interface NavigateViewProps {
  apps: () => AppEntry[];
  appsQuery: () => string;
  selected: () => number;
  nav: NavigateStore;
  barCols: () => number;
  iconFor: (path: string) => string | undefined;
  /** Settings: show the 「最近使用」 bar. */
  showRecent: () => boolean;
  activate: () => void;
  /** selectionSource = "mouse" (hover/click takes over from keyboard nav). */
  markMouse: () => void;
  openMenu: (m: MenuState) => void;
  setSelected: (i: number) => void;
  /** Expanded-bar toggles invalidate the cached work area + re-measure. */
  invalidateWorkArea: () => void;
}

/** A single app box (grid or bar) with a cached icon + unknown-icon fallback. */
function appBox(
  props: NavigateViewProps,
  app: AppEntry,
  selected: boolean,
  handlers: {
    onActivate: () => void;
    onSelect: () => void;
    onContext: (e: MouseEvent) => void;
    draggable?: boolean;
    onDragStart?: (e: DragEvent) => void;
  }
) {
  return (
    <div
      class="result-box"
      classList={{
        "result-selected": selected,
      }}
      role="option"
      aria-selected={selected}
      draggable={handlers.draggable ?? false}
      onMouseMove={handlers.onSelect}
      onClick={handlers.onActivate}
      onContextMenu={(e) => {
        e.preventDefault();
        handlers.onContext(e);
      }}
      onDragStart={handlers.onDragStart}
    >
      <Show
        when={props.iconFor(app.path)}
        fallback={
          <span class="result-box-tile result-box-icon">
            <img class="result-box-img icon-unknown" src={unknownIcon} alt="" />
          </span>
        }
      >
        <span class="result-box-tile result-box-icon">
          <img class="result-box-img" src={props.iconFor(app.path)} alt="" />
        </span>
      </Show>
      <span class="result-box-name">{app.name}</span>
    </div>
  );
}

/** A titled, expandable bar (最近使用 / 已固定) on the empty-query main menu.
 * Collapsed = the measured column count (one row); expanded = everything.
 * The 展开 button only appears when content exceeds one row. */
function barSection(
  props: NavigateViewProps,
  opts: {
    title: string;
    items: AppEntry[];
    expanded: boolean;
    zoneActive: boolean;
    selected: number;
    draggable?: boolean;
    onToggle: () => void;
    onActivate: (i: number) => void;
    onSelect: (i: number) => void;
    onContext: (e: MouseEvent, app: AppEntry) => void;
    onDragStart?: (i: number, e: DragEvent) => void;
  }
) {
  const cols = Math.max(props.barCols(), 1);
  const shown = opts.expanded ? opts.items : opts.items.slice(0, cols);

  return (
    <div class="bar-section">
      <div class="bar-header">
        <span class="bar-title">{opts.title}</span>
        <Show when={opts.items.length > cols}>
          <button class="bar-expand" onClick={opts.onToggle}>
            {opts.expanded ? t("collapse") : t("expand")}
          </button>
        </Show>
      </div>
      <div class="bar-grid" classList={{ collapsed: !opts.expanded }}>
        <For each={shown}>
          {(app, i) =>
            appBox(props, app, opts.zoneActive && i() === opts.selected, {
              onActivate: () => opts.onActivate(i()),
              onSelect: () => opts.onSelect(i()),
              onContext: (e) => opts.onContext(e, app),
              draggable: opts.draggable,
              onDragStart: opts.onDragStart ? (e) => opts.onDragStart!(i(), e) : undefined,
            })
          }
        </For>
      </div>
    </div>
  );
}

export function NavigateView(props: NavigateViewProps) {
  const nav = props.nav;

  /** The 「Windows 资源管理器」 bar: shown on the empty-query main menu when the
   * launcher was summoned from an Explorer folder. Tiles open a terminal in that
   * folder or copy the folder path; right-click a terminal tile for 启动 /
   * 以管理员身份启动. It participates in the continuous bar navigation. */
  function folderBarSection() {
    const ctx = nav.folderCtx();
    if (!ctx) return null;
    const icons = nav.termIcons();
    const items = [
      {
        label: t("openInCmd"),
        icon: icons.cmd ?? runIcon,
        act: (elev: boolean) => nav.activateFolder(0, elev),
      },
      {
        label: t("openInPowerShell"),
        icon: icons.powershell ?? runIcon,
        act: (elev: boolean) => nav.activateFolder(1, elev),
      },
      { label: t("copyPath"), icon: copyIcon, mono: true, act: () => nav.activateFolder(2, false) },
    ];
    return (
      <div class="bar-section">
        <div class="bar-header">
          <span class="bar-title">{t("explorerBar")}</span>
        </div>
        <div class="bar-grid">
          <For each={items}>
            {(item, i) => (
              <div
                class="result-box folder-box"
                classList={{ "result-selected": nav.zone() === "folder" && i() === nav.folderSelected() }}
                role="option"
                aria-selected={nav.zone() === "folder" && i() === nav.folderSelected()}
                onMouseMove={() => {
                  // Mouse movement over an entry always takes over selection —
                  // no keyboard-precedence gate that could leave hover stalled.
                  props.markMouse();
                  nav.setZone("folder");
                  nav.setFolderSelected(i());
                }}
                onClick={() => item.act(false)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.markMouse();
                  nav.setZone("folder");
                  nav.setFolderSelected(i());
                  props.openMenu({ kind: "folder", x: e.clientX, y: e.clientY, idx: i() });
                }}
              >
                <span class="result-box-tile result-box-icon">
                  <img
                    class={`result-box-img${item.mono ? " folder-icon-svg" : ""}`}
                    src={item.icon}
                    alt=""
                    draggable={false}
                  />
                </span>
                <span class="result-box-name">{item.label}</span>
              </div>
            )}
          </For>
        </div>
      </div>
    );
  }

  return (
    <Show
      when={props.appsQuery() === ""}
      fallback={
        <Show when={props.apps().length > 0} fallback={<span class="hint">{t("noResults")}</span>}>
          <div class="result-grid" role="grid">
            {props.apps().map((app, i) =>
              appBox(props, app, i === props.selected(), {
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
        <Show when={props.showRecent() && nav.recentApps().length > 0}>
          {barSection(props, {
            title: t("recent"),
            items: nav.recentApps(),
            expanded: nav.recentExpanded(),
            zoneActive: nav.zone() === "recent",
            selected: nav.recentSelected(),
            onToggle: () => {
              nav.setRecentExpanded(!nav.recentExpanded());
              props.invalidateWorkArea();
            },
            onActivate: (i) => {
              props.markMouse();
              nav.setZone("recent");
              nav.setRecentSelected(i);
              props.activate();
            },
            onSelect: (i) => {
              props.markMouse();
              nav.setZone("recent");
              nav.setRecentSelected(i);
            },
            onContext: (e, app) => {
              nav.setZone("recent");
              nav.setRecentSelected(nav.recentApps().findIndex((r) => r.path === app.path));
              props.openMenu({ kind: "app", x: e.clientX, y: e.clientY, app, fromRecent: true });
            },
          })}
        </Show>
        <Show when={nav.pinnedApps().length > 0}>
          {barSection(props, {
            title: t("pinned"),
            items: nav.pinnedApps(),
            expanded: nav.pinnedExpanded(),
            zoneActive: nav.zone() === "pinned",
            selected: nav.pinnedSelected(),
            draggable: true,
            onToggle: () => {
              nav.setPinnedExpanded(!nav.pinnedExpanded());
              props.invalidateWorkArea();
            },
            onActivate: (i) => {
              props.markMouse();
              nav.setZone("pinned");
              nav.setPinnedSelected(i);
              props.activate();
            },
            onSelect: (i) => {
              props.markMouse();
              nav.setZone("pinned");
              nav.setPinnedSelected(i);
            },
            onContext: (e, app) => {
              nav.setZone("pinned");
              nav.setPinnedSelected(nav.pinnedApps().findIndex((p) => p.path === app.path));
              props.openMenu({ kind: "app", x: e.clientX, y: e.clientY, app });
            },
            onDragStart: (i, e) => {
              const items = nav.pinnedApps();
              nav.beginDrag(items[i], i);
              const src = e.currentTarget as HTMLElement;
              src.classList.add("result-dragging");
              if (e.dataTransfer) {
                e.dataTransfer.setData("text/plain", "");
                e.dataTransfer.effectAllowed = "move";
                const clone = src.cloneNode(true) as HTMLElement;
                clone.style.opacity = "0.6";
                clone.style.position = "absolute";
                clone.style.top = "-9999px";
                clone.style.pointerEvents = "none";
                document.body.appendChild(clone);
                const rect = src.getBoundingClientRect();
                e.dataTransfer.setDragImage(clone, rect.width / 2, rect.height / 2);
                setTimeout(() => clone.remove(), 0);
              }
            },
          })}
        </Show>
        <Show when={nav.folderCtx()}>{folderBarSection()}</Show>
      </div>
    </Show>
  );
}
