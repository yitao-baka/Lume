//! Detached plugin window (P6) — the third window entry (plugin.html), the
//! host page for one mode plugin's page living in its own window.
//!
//! Mirrors the in-launcher disk mode exactly where it can: the same
//! `createIframeView` renders the plugin's `view` HTML in a sandboxed bridge
//! iframe, the same `execHostRpc` answers `window.lume` traffic, and the
//! same permission layers (frontend ledger + Rust whitelist) apply. What
//! differs is the `PluginServices` — this window answers window-locally
//! (toast / hide / resize / drag) and forwards launcher-bound actions
//! (placeholder / sub-input are meaningless here; redirect goes back through
//! the launcher over a Rust event). `setQuery` is real here: the query lives
//! in this window's iframes (the titlebar page drives the view through it).
//!
//! Titlebar slot (optional manifest `titlebar` field): a SECOND bridge
//! iframe rendered inside the chrome row (src/components/TitleBar.tsx),
//! same sandbox, same RPC router. State pushes fan out to both iframes;
//! keys forwarded out of the slot still reach the view via `lume.on.key`.
//!
//! State flow: the page announces itself with `plugin_window_ready` → the
//! launcher's registry pushes `{show, query, enter, settings}` as the
//! `plugin-state` event → this page posts each piece into the iframes. A
//! hidden window never re-loads on re-show, so re-focus only needs a
//! `plugin-window-shown` → `show` replay.

import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { applyColorMode } from "./theme";
import { TitleBar } from "./components/TitleBar";
import type { FeatureEnterInfo, PluginManifest, PluginServices } from "./plugins/types";
import { setPermissionSource } from "./plugins/permissions";
import { createIframeView, injectBridge } from "./plugins/iframeBridge";
import { execHostRpc } from "./plugins/rpc";
import { fetchDiskFile } from "./plugins/disk";
import { plog } from "./plugins/log";
import "./pluginWindow.css";

const id = new URLSearchParams(location.search).get("plugin") ?? "";

function App() {
  // Theme before first paint (the Rust init script injected __LUME_CONFIG__,
  // same as the main/settings windows).
  const cfg = (window as unknown as { __LUME_CONFIG__?: { appearance?: { color_mode?: string } } })
    .__LUME_CONFIG__;
  applyColorMode(cfg?.appearance?.color_mode ?? "system");

  // Titlebar label — the manifest name once plugin_window_meta answers.
  const [pluginName, setPluginName] = createSignal(id);
  /** The titlebar page's HTML — set only when the manifest declares a
      `titlebar` file and it loaded (drives the slot in the chrome row). */
  const [titlebarHtml, setTitlebarHtml] = createSignal("");

  // Last state pushed from the launcher, cached: the titlebar page's ready
  // handshake replays it locally (the registry answers only the view's).
  const lastState: {
    show?: boolean;
    query?: string | null;
    enter?: FeatureEnterInfo | null;
    settings?: Record<string, unknown> | null;
    theme?: string | null;
  } = {};

  let slotPost: ((type: string, payload?: unknown) => void) | undefined;
  /** Fan an event out to every mounted iframe (view + titlebar slot). */
  const fan = (type: string, payload?: unknown) => {
    post(type, payload);
    slotPost?.(type, payload);
  };

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const localToast = (text: string) => {
    const el = document.getElementById("plugin-window-toast");
    if (!el) return;
    el.textContent = text;
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.style.opacity = "0";
    }, 1800);
  };

  // Window-local PluginServices (rpc.ts's router needs the full shape).
  const services: PluginServices = {
    showToast: (text) => localToast(text),
    markEntryOpened: () => {},
    // `app.hide()` hides THIS window (the plugin decides when it should go
    // away); re-open via the launcher's pill/keyword focuses it again.
    resetAndHide: () => void getCurrentWindow().hide().catch((err) => plog.error(id, "hide failed:", err)),
    persistLastPage: () => {},
    runSearch: async () => {
      plog.debug(id, "runSearch ignored in the detached window");
    },
    scheduleResize: () => {},
    searchToken: () => 0,
    selectionSource: () => "other",
    markMouse: () => {},
    openMenu: () => {},
    mode: () => id,
    requestMode: () => {
      plog.debug(id, "requestMode ignored in the detached window");
    },
    setModePlaceholder: () => {
      plog.debug(id, "setPlaceholder ignored in the detached window (no search box here)");
    },
    setQuery: (q) => {
      // Real here (the launcher's search box is not reachable): a detached
      // window keeps its query in THIS window's iframes. The titlebar
      // page's search box drives the view's result list through it; the
      // echo back to the caller matches the launcher's own setQuery →
      // on.query round-trip.
      lastState.query = q;
      fan("query", q);
    },
    resizeWindow: (size) => {
      void (async () => {
        const win = getCurrentWindow();
        const cur = (await win.innerSize()).toLogical(await win.scaleFactor());
        const width = Math.max(360, Math.round(size?.width ?? cur.width));
        const height = Math.max(240, Math.round(size?.height ?? cur.height));
        await win.setSize(new LogicalSize(width, height));
      })().catch((err) => plog.error(id, "resize failed:", err));
    },
    dragWindow: () => {
      // Events inside the slot iframe never reach the host drag region —
      // the titlebar page calls this on its blank areas instead.
      void getCurrentWindow().startDragging().catch((err) =>
        plog.error(id, "drag failed:", err)
      );
    },
    setSubInput: () => {
      plog.debug(id, "setSubInput ignored in the detached window");
    },
    subInputOwner: () => null,
    enterPlugin: (pluginId, info: FeatureEnterInfo) => {
      // Redirect out of a detached window: hand the payload to the launcher
      // (which routes it like any feature activation) and close/raise there.
      void invoke("plugin_window_redirect", { from: id, pluginId, info }).catch((err) =>
        plog.error(id, "redirect failed:", err)
      );
      return true;
    },
  };

  const { View, post } = createIframeView(
    (method, args) => execHostRpc(id, method, args, services),
    () => {
      // The bridge is live — ask the launcher to push the current state
      // (query / enter / settings / show). This is the cross-window version
      // of the in-launcher ready handshake.
      void invoke("plugin_window_ready", { id }).catch((err) => plog.error(id, "ready failed:", err));
    }
  );

  // Titlebar slot viewer (optional manifest `titlebar`): the same bridge and
  // RPC router, one row up. Its ready handshake replays the cached state
  // locally — plugin_window_ready is NOT re-invoked, so the launcher's
  // registry never double-pushes.
  const slotView = createIframeView(
    (method, args) => execHostRpc(id, method, args, services),
    () => {
      if (lastState.show) slotPost?.("show");
      if (typeof lastState.query === "string") slotPost?.("query", lastState.query);
      if (lastState.enter) slotPost?.("enter", lastState.enter);
      if (lastState.settings) slotPost?.("settings", lastState.settings);
      if (lastState.theme) slotPost?.("theme", lastState.theme);
    },
    { class: "titlebar-frame", name: "titlebar" }
  );
  slotPost = slotView.post;
  // The slot element is created EXACTLY ONCE, outside any reactive
  // expression: a `<slotView.View />` written inline in the `slot={…}` prop
  // getter is re-invoked whenever its dependencies change (titlebarHtml,
  // pluginName), which strands the wired instance — the mounted iframe ends
  // up with no message listener and the whole slot channel dies. One static
  // element + a reactive classList (visibility only) keeps one component
  // instance, one listener, one live iframe; plugins without a titlebar page
  // just keep it empty and non-interactive (the drag region shows through).
  const slotHost = (
    <div class="titlebar-slot-host" classList={{ "titlebar-slot-empty": titlebarHtml() === "" }}>
      <slotView.View />
    </div>
  );

  onMount(() => {
    // Fetch + bridge the view page (same as createDiskModeInstance).
    let dir = "";
    let view = "";
    void invoke<{ dir: string; view: string; titlebar: string; name: string }>("plugin_window_meta", { id })
      .then((meta) => {
        dir = meta.dir;
        view = meta.view;
        document.title = meta.name || id;
        setPluginName(meta.name || id);
        // The permission ledger's manifest source lives in the registry, which
        // only runs in the launcher window — wire it here from the same
        // command the settings pane uses, BEFORE the view HTML lands (the
        // page's first guarded RPC would otherwise be refused with
        // "unknown plugin": this window has no registry to look manifests up).
        const wirePerms = invoke<PluginManifest[]>("get_plugins")
          .then((list) => {
            setPermissionSource((pid) => list.find((x) => x.id === pid));
          })
          .catch((err) => plog.error(id, "permission source wire failed:", err));
        // Titlebar page (optional manifest `titlebar`): same permission-wire
        // order as the view; a failure just leaves the slot empty (the
        // chrome row stays title + controls). setHtml runs BEFORE the signal
        // mounts the iframe so it renders with its document in place.
        if (meta.titlebar) {
          void wirePerms
            .then(() => fetchDiskFile(dir + "\\" + meta.titlebar))
            .then((html) => {
              slotView.View.setHtml(injectBridge(html));
              setTitlebarHtml(html);
            })
            .catch((err) => plog.error(id, "titlebar load failed:", err));
        }
        return wirePerms.then(() => fetchDiskFile(dir + "\\" + view));
      })
      .then((html) => {
        View.setHtml(injectBridge(html));
      })
      .catch((err) => {
        plog.error(id, "detached view load failed:", err);
        View.setHtml(
          `<body style="font:13px sans-serif;color:#f66;padding:16px">plugin view load failed: ${String(err)}</body>`
        );
      });

    // Launcher pushes: initial state (after ready) and per-activation updates.
    let unlisteners: (UnlistenFn | undefined)[] = [];
    void listen<{
      show?: boolean;
      query?: string | null;
      enter?: FeatureEnterInfo | null;
      settings?: Record<string, unknown> | null;
      theme?: string | null;
    }>("plugin-state", (e) => {
      const s = e.payload;
      plog.debug(id, "plugin-state:", JSON.stringify(s).slice(0, 200));
      // Debug tap for the CDP verify scripts (same pattern as __plog): an
      // append-only history, since pushes interleave (shown vs enter).
      const w = window as unknown as { __pluginStates?: unknown[] };
      (w.__pluginStates ??= []).push(s);
      // Fan out to every mounted iframe (view + titlebar slot) and cache for
      // the slot's ready replay.
      if (s.show) {
        lastState.show = true;
        fan("show");
      }
      if (typeof s.query === "string") {
        lastState.query = s.query;
        fan("query", s.query);
      }
      if (s.enter) {
        lastState.enter = s.enter;
        fan("enter", s.enter);
      }
      if (s.settings) {
        lastState.settings = s.settings;
        fan("settings", s.settings);
      }
      if (s.theme) {
        lastState.theme = s.theme;
        fan("theme", s.theme);
      }
    }).then((u) => (unlisteners.push(u), undefined));

    // Re-focus: replay `show` into the page (the window never unloads, so
    // this is all a re-summon needs).
    void listen<string>("plugin-window-shown", () => {
      lastState.show = true;
      fan("show");
    }).then(
      (u) => (unlisteners.push(u), undefined)
    );

    // Theme follows the launcher's settings while the window is open; the
    // permission source rides along (启用/权限清单可能在窗口存续期间变化).
    void listen("settings-applied", () => {
      void invoke<{ appearance?: { color_mode?: string } }>("get_settings")
        .then((s) => applyColorMode(s.appearance?.color_mode ?? "system"))
        .catch(() => {});
      void invoke<PluginManifest[]>("get_plugins")
        .then((list) => setPermissionSource((pid) => list.find((x) => x.id === pid)))
        .catch(() => {});
    }).then((u) => (unlisteners.push(u), undefined));

    // Keys: the bridge forwards non-editable keydowns here (synthetic
    // re-dispatch on this window). There is no host router in this window —
    // every forwarded key is delivered to the page as `lume.on.key`, and an
    // UNCONSUMED Esc closes the window (a page that wants Esc keeps it by
    // preventDefault-ing, the same contract as the launcher).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void invoke("plugin_window_close", { id }).catch(() => {});
        return;
      }
      post("key", { key: e.key, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey });
    };
    window.addEventListener("keydown", onKey);

    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      for (const u of unlisteners) u?.();
      clearTimeout(toastTimer);
    });
  });

  return (
    <div class="plugin-window-root">
      {/* Frameless chrome row — the pin toggle makes sense only here (a
          detached window a user keeps on top while working elsewhere). The
          slot hosts the plugin's titlebar page (optional manifest
          `titlebar` field) between the title and the window controls. */}
      <TitleBar
        title={pluginName()}
        pin
        slot={slotHost}
        onClose={() => void invoke("plugin_window_close", { id }).catch(() => {})}
      />
      <View />
      <div id="plugin-window-toast" role="status" />
    </div>
  );
}

render(() => <App />, document.getElementById("root") as HTMLElement);
