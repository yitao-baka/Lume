//! Detached plugin windows (P6) — a disk mode plugin's page hosted in its
//! own window.
//!
//! Window label convention: `plugin-<plugin id>`; the page is
//! `plugin.html?plugin=<id>` (third Vite entry, mirrors the preview
//! satellite). The page hosts the same sandboxed bridge iframe as the
//! in-launcher mode page and answers its RPCs locally; launcher-bound state
//! (query / `enter` payloads / declarative settings) is pushed from the main
//! window's registry over `plugin_window_push_state` → `plugin-state`.
//!
//! Lifecycle:
//! - `plugin_window_open` creates (hidden → show) or focuses the window.
//!   Re-open with an existing window = raise + focus (idempotent).
//! - The page calls `plugin_window_ready` once its listeners are up; the
//!   main window's registry answers by pushing the current state (the
//!   cross-window equivalent of the bridge's `__lumeReady` handshake).
//! - Close (× button, `plugin_window_close`, Esc) destroys the window; the
//!   `CloseRequested` handler remembers the geometry in
//!   `settings.plugins.window_bounds` and tells the main window
//!   (`plugin-window-closed`) so the registry can clear its detached set.
//!
//! This is the first runtime-created window in the codebase — the
//! startup-created windows avoid it deliberately (a GPU-hang risk noted in
//! `window.rs`). Detach is a user action on a visible window, so the risk
//! window is small; creation is hidden-then-shown and per-plugin windows are
//! reused, never duplicated.

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::paths::base_dir;
use crate::settings::{self, SettingsState};

/// The window label for a detached plugin window.
pub fn window_label(id: &str) -> String {
    format!("plugin-{}", id)
}

/// Open (or focus) the detached window for one mode plugin. Returns
/// `"opened"` when a new window was created, `"focused"` when an existing
/// one was raised.
///
/// **Must be an `async` command**: window creation has to be dispatched to
/// the main thread's event loop, and a sync command *occupies* that thread —
/// build() from a sync command deadlocks (the webview can never be
/// constructed). From the async worker, Tauri's builder dispatches to the
/// main loop and waits on a channel, which is the supported path.
#[tauri::command]
pub async fn plugin_window_open(
    id: String,
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let label = window_label(&id);
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        let _ = win.emit("plugin-window-shown", id.clone());
        let _ = app.emit_to("main", "plugin-window-shown", id.clone());
        return Ok("focused".into());
    }
    let snapshot = settings::snapshot(&state);
    if snapshot.plugins.disabled.iter().any(|d| d == &id) {
        return Err(format!("plugin \"{id}\" is disabled"));
    }
    let manifests = crate::plugins::list_plugins(&base_dir(), &[], &[], false);
    let m = manifests
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown plugin \"{id}\""))?;
    if m.kind != "mode" || !m.detachable {
        return Err(format!("plugin \"{id}\" is not a detachable mode"));
    }
    let remembered = snapshot.plugins.window_bounds.get(&id).copied();
    let fallback_height = m.height.map(|h| h as f64).unwrap_or(480.0).clamp(240.0, 2000.0);
    let (width, height) = remembered
        .map(|b| (b.width, b.height))
        .unwrap_or((720.0, fallback_height));
    // Theme before first paint, same as the main/settings windows.
    let config_json = serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".into());
    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("plugin.html?plugin={id}").into()),
    )
    .title(if m.name.is_empty() { id.clone() } else { m.name.clone() })
    .inner_size(width, height)
    .min_inner_size(360.0, 240.0)
    .resizable(true)
    .visible(false)
    .initialization_script(&format!("window.__LUME_CONFIG__ = {config_json};"));
    builder = match remembered {
        Some(b) => builder.position(b.x, b.y),
        None => builder.center(),
    };
    let win = builder.build().map_err(|e| e.to_string())?;
    let app2 = app.clone();
    let id2 = id.clone();
    let win2 = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { .. } = event {
            remember_bounds(&app2, &id2, &win2);
            // One emit point for both close paths (× button and the command).
            let _ = app2.emit_to("main", "plugin-window-closed", id2.clone());
        }
    });
    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit("plugin-window-shown", id.clone());
    let _ = app.emit_to("main", "plugin-window-shown", id.clone());
    Ok("opened".into())
}

/// The plugin window page announces its listeners are up → the main window's
/// registry pushes the current page state (`plugin-window-ready` →
/// `plugin_window_push_state`).
#[tauri::command]
pub fn plugin_window_ready(
    id: String,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    if window.label() != window_label(&id) {
        return Err("plugin_window_ready: wrong window".into());
    }
    app.emit_to("main", "plugin-window-ready", id)
        .map_err(|e| e.to_string())
}

/// The manifest fields the plugin window page needs to load the view HTML
/// (dir + view relative path) and title itself. Served to the matching
/// window only.
#[tauri::command]
pub fn plugin_window_meta(
    id: String,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    if window.label() != window_label(&id) {
        return Err("plugin_window_meta: wrong window".into());
    }
    let manifests = crate::plugins::list_plugins(&base_dir(), &[], &[], false);
    let m = manifests
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown plugin \"{id}\""))?;
    Ok(serde_json::json!({
        "dir": m.dir,
        "view": m.view,
        "name": m.name,
    }))
}

/// A detached plugin page called `app.redirect` — hand the payload to the
/// launcher, which routes it like any feature activation (switches modes,
/// enters providers, focuses another detached window).
#[tauri::command]
pub fn plugin_window_redirect(
    from: String,
    plugin_id: String,
    info: serde_json::Value,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    if window.label() != window_label(&from) {
        return Err("plugin_window_redirect: wrong window".into());
    }
    app.emit_to(
        "main",
        "plugin-window-redirect",
        serde_json::json!({ "from": from, "pluginId": plugin_id, "info": info }),
    )
    .map_err(|e| e.to_string())
}

/// The main window's registry pushes page state (query / enter payload /
/// declarative settings / show) into the plugin window. The payload shape is
/// frontend-owned (`registry.ts`).
#[tauri::command]
pub fn plugin_window_push_state(
    id: String,
    state: serde_json::Value,
    app: AppHandle,
) -> Result<(), String> {
    app.emit_to(window_label(&id), "plugin-state", state)
        .map_err(|e| e.to_string())
}

/// Close (destroy) a detached plugin window. Fires `CloseRequested`, whose
/// handler persists the geometry and notifies the main window.
#[tauri::command]
pub fn plugin_window_close(id: String, app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&window_label(&id)) {
        let _ = win.close();
    }
    Ok(())
}

/// Persist one window's geometry (logical px) into
/// `settings.plugins.window_bounds` — silent, no settings-applied: a
/// geometry write must not re-run the frontend refresh pipeline.
fn remember_bounds(app: &AppHandle, id: &str, win: &tauri::WebviewWindow) {
    let scale = win.scale_factor().unwrap_or(1.0);
    let size = win.inner_size().ok().map(|s| s.to_logical::<f64>(scale));
    let pos = win.outer_position().ok().map(|p| p.to_logical::<f64>(scale));
    if let (Some(size), Some(pos)) = (size, pos) {
        settings::remember_plugin_window_bounds(
            app,
            id,
            settings::WindowBounds {
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
            },
        );
    }
}
