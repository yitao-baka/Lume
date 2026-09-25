//! Self-drawn window chrome — the shared titlebar for the frameless
//! windows (docs/UI_GUIDELINES.md "Window chrome").
//!
//! Two surfaces use it:
//! - detached plugin windows: the standalone <TitleBar> row above the view;
//! - the settings window: `.settings-topbar` embeds <TitleBarControls> and
//!   takes the drag region + double-click itself (that row is also the
//!   settings search box, so the chrome and the content share one bar).
//!
//! Dragging uses `data-tauri-drag-region` (direct clicks only — buttons and
//! inputs keep their own semantics, same contract as App.tsx's search row).
//! Double-click maximize/restore is Tauri's built-in drag-region behavior
//! (`plugin:window|internal_toggle_maximize`, granted by `core:default`), so
//! no custom handler here — the maximize glyph re-syncs from live window
//! state on `tauri://resize` (Win+方向键 / taskbar interactions bypass the
//! buttons). The control commands operate on the calling window only —
//! Tauri injects the `window` parameter server-side.

import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { t } from "../i18n";
import "./TitleBar.css";

/** Shared state + actions for one window's chrome. Create it in the
    component that owns the chrome row and hand it to <TitleBarControls>. */
export interface ChromeControls {
  maximized: () => boolean;
  pinned: () => boolean;
  minimize: () => void;
  toggleMaximize: () => void;
  togglePin: () => void;
}

export function useChromeControls(): ChromeControls {
  const [maximized, setMaximized] = createSignal(false);
  const [pinned, setPinned] = createSignal(false);
  let unlistenResize: (() => void) | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    const win = getCurrentWindow();
    void win.isMaximized().then(setMaximized).catch(() => {});
    // Resync the glyph from live window state (debounced — resize fires
    // continuously while drag-resizing).
    void listen("tauri://resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        void win.isMaximized().then(setMaximized).catch(() => {});
      }, 120);
    }).then((u) => (unlistenResize = u));
  });
  onCleanup(() => {
    unlistenResize?.();
    clearTimeout(resizeTimer);
  });

  const minimize = () => void invoke("window_minimize").catch(() => {});
  const toggleMaximize = () =>
    void invoke<boolean>("window_toggle_maximize")
      .then((next) => setMaximized(next))
      .catch(() => {});
  const togglePin = () =>
    void invoke<boolean>("window_toggle_pin")
      .then((next) => setPinned(next))
      .catch(() => {});

  return { maximized, pinned, minimize, toggleMaximize, togglePin };
}

/** The window-control button cluster (pin? / minimize / maximize / close).
    Embed in any self-drawn chrome row; pair with useChromeControls(). The
    close action is caller-owned (settings hides via `close_settings`, a
    plugin window destroys itself via `plugin_window_close`). */
export function TitleBarControls(props: {
  controls: ChromeControls;
  pin?: boolean;
  onClose: () => void;
}) {
  const c = props.controls;
  return (
    <div class="titlebar-buttons">
      <Show when={props.pin}>
        <button
          class="titlebar-btn"
          classList={{ active: c.pinned() }}
          title={c.pinned() ? t("winUnpin") : t("winPin")}
          aria-label={c.pinned() ? t("winUnpin") : t("winPin")}
          aria-pressed={c.pinned()}
          onClick={() => c.togglePin()}
        >
          <PinIcon />
        </button>
      </Show>
      <button
        class="titlebar-btn"
        title={t("winMinimize")}
        aria-label={t("winMinimize")}
        onClick={() => c.minimize()}
      >
        <MinimizeIcon />
      </button>
      <button
        class="titlebar-btn"
        title={c.maximized() ? t("winRestore") : t("winMaximize")}
        aria-label={c.maximized() ? t("winRestore") : t("winMaximize")}
        onClick={() => c.toggleMaximize()}
      >
        <Show when={c.maximized()} fallback={<MaximizeIcon />}>
          <RestoreIcon />
        </Show>
      </button>
      <button
        class="titlebar-btn titlebar-close"
        title={t("winClose")}
        aria-label={t("winClose")}
        onClick={() => props.onClose()}
      >
        <CloseIcon />
      </button>
    </div>
  );
}

/** Full titlebar row for windows whose chrome is just a title (detached
    plugin windows). The settings window embeds <TitleBarControls> in its
    own topbar instead.
    `slot` (plugin windows only) hosts the plugin's titlebar page between
    the title and the controls — a second sandboxed bridge iframe owned by
    pluginWindow.tsx. The container keeps the drag region: clicks on its
    gap drag/maximize via the built-in drag-region script, clicks INSIDE
    the iframe belong to the plugin document (events never cross the
    iframe boundary), which drags via `lume.app.dragWindow()`. */
export function TitleBar(props: {
  title: string;
  pin?: boolean;
  slot?: JSX.Element;
  onClose: () => void;
}) {
  const c = useChromeControls();
  return (
    <div class="titlebar" classList={{ "has-slot": props.slot != null }} data-tauri-drag-region>
      <span class="titlebar-title" data-tauri-drag-region>
        {props.title}
      </span>
      {props.slot != null && (
        <div class="titlebar-slot" data-tauri-drag-region>
          {props.slot}
        </div>
      )}
      <TitleBarControls controls={c} pin={props.pin} onClose={props.onClose} />
    </div>
  );
}

// Windows-style caption glyphs (stroke follows the button color via CSS).
function MinimizeIcon() {
  return (
    <svg viewBox="0 0 10 10" stroke-width="1" aria-hidden="true">
      <path d="M0.5 5.5h9" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg viewBox="0 0 10 10" stroke-width="1" aria-hidden="true">
      <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg viewBox="0 0 10 10" stroke-width="1" aria-hidden="true">
      <path d="M2.5 2.5v-2h7v7h-2" />
      <rect x="0.5" y="2.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 10 10" stroke-width="1" aria-hidden="true">
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <line x1="12" x2="12" y1="17" y2="22" />
      <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
    </svg>
  );
}
