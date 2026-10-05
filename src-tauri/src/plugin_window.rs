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
//! The windows are frameless (opaque, system-rounded on Win11) — the page
//! draws its own titlebar via the shared `src/components/TitleBar.tsx`, and
//! the window-control buttons run through the self-chrome commands in
//! `window.rs` (`window_minimize` / `window_toggle_maximize` /
//! `window_toggle_pin`, all scoped to the calling window).
//!
//! Lifecycle:
//! - `plugin_window_open` creates (hidden → show) or focuses the window.
//!   Re-open with an existing window = raise + focus (idempotent).
//! - The page calls `plugin_window_ready` once its listeners are up; the
//!   main window's registry answers by pushing the current state (the
//!   cross-window equivalent of the bridge's `__lumeReady` handshake).
//! - Close paths (P6.5 snapshot hand-off): a USER-initiated close
//!   (× / Esc / Alt+F4) is intercepted once — the page is asked to snapshot
//!   its state first and reports back via `plugin_window_close_report`,
//!   which remembers the geometry, delivers the closed event WITH the
//!   snapshot payload and destroys the window. A 3s watchdog force-destroys
//!   when the page never answers (hung plugin must not wedge the close).
//!   The programmatic path (`plugin_window_close`, disable/reload cleanup)
//!   skips the snapshot: the code is about to be replaced, restoring old
//!   state into new code is meaningless.
//!
//! This is the first runtime-created window in the codebase — the
//! startup-created windows avoid it deliberately (a GPU-hang risk noted in
//! `window.rs`). Detach is a user action on a visible window, so the risk
//! window is small; creation is hidden-then-shown and per-plugin windows are
//! reused, never duplicated.
//!
//! Taskbar identity (P6.8, ROADMAP #34): the window carries its own
//! AppUserModelID (`Lume.Plugin.<id>`) so the shell gives it a separate
//! taskbar entry — own button, own icon, individually pinnable — instead of
//! merging it into the launcher's. The icon is the plugin's manifest `icon`
//! (rasterized by the launcher's webview and uploaded as a base64 PNG, since
//! Rust has no SVG decoder); icon-less plugins keep the Lume theme icon.
//! Both are applied before the first `show()`.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::appicon::{self, PluginIcons};
use crate::paths::base_dir;
use crate::settings::{self, SettingsState};

/// Per-detached-window close bookkeeping: ids whose close is already in
/// flight (reported, forced, or programmatic). The `CloseRequested`
/// interceptor lets those through unchanged and asks the page for a
/// snapshot otherwise.
#[derive(Clone, Default)]
pub struct ClosingSet(pub Arc<Mutex<HashSet<String>>>);

impl ClosingSet {
    fn contains(&self, id: &str) -> bool {
        self.0.lock().unwrap().contains(id)
    }
    fn insert(&self, id: &str) {
        self.0.lock().unwrap().insert(id.to_string());
    }
}

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
    icon_png: Option<String>,
    app: AppHandle,
    state: State<'_, SettingsState>,
    closing: State<'_, ClosingSet>,
    icons: State<'_, PluginIcons>,
) -> Result<String, String> {
    let label = window_label(&id);
    if let Some(win) = app.get_webview_window(&label) {
        // 重新聚焦取消一次在途的关闭簿记（防御：closing 已置位但窗口仍在的
        // 窗口期内用户再次打开 —— 此时destroy尚未完成，重开视为取消）。
        closing.0.lock().unwrap().remove(&id);
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
    // Frameless like the launcher — the page draws its own titlebar
    // (src/pluginWindow.tsx + src/components/TitleBar.tsx). Opaque (no
    // transparent): Win11 rounds the corners via DWM and tao keeps its native
    // invisible resize borders, which a transparent resizable window would
    // turn into a visible dead zone (see window.rs redock notes).
    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("plugin.html?plugin={id}").into()),
    )
    .title(if m.name.is_empty() { id.clone() } else { m.name.clone() })
    .inner_size(width, height)
    .min_inner_size(360.0, 240.0)
    .resizable(true)
    .decorations(false)
    .shadow(true)
    // Opaque canvas in the theme's surface color, same as the preview window:
    // the plugin pages are cross-process (OOPIF) frames — with the default
    // canvas their transparent pixels composite against WebView2's own dark
    // background (#121212) instead of anything the host page paints.
    .background_color(tauri::window::Color(30, 30, 32, 255))
    .visible(false)
    .initialization_script(&format!("window.__LUME_CONFIG__ = {config_json};"));
    builder = match remembered {
        Some(b) => builder.position(b.x, b.y),
        None => builder.center(),
    };
    let win = builder.build().map_err(|e| e.to_string())?;
    // shadow(true) windows draw DWM's documented 1px white border — suppress
    // it (shadow + Win11 rounded corners stay).
    crate::window::clear_dwm_border(&win);
    // Separate taskbar identity before the window is ever shown (P6.8). The
    // property-store write must run on the window's owning (main) thread: a
    // store obtained elsewhere accepts SetValue with S_OK and drops the
    // value (实测回读为空 —— PowerShell 复现同款行为), so this hops over
    // and waits a moment.
    {
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        let win_main = win.clone();
        let id_main = id.clone();
        app.run_on_main_thread(move || {
            set_window_aumid(&win_main, &id_main);
            let _ = tx.send(());
        })
        .map_err(|e| e.to_string())?;
        let _ = rx.recv_timeout(std::time::Duration::from_millis(500));
    }
    // Icon before the first paint: the plugin's own (uploaded at detach) or
    // — for icon-less plugins — the theme-matched Lume icon, which
    // `appicon::apply` never covered (created after startup).
    if let Some(b64) = icon_png.as_deref() {
        icons.remember(&id, b64);
    }
    if !appicon::apply_plugin_window(&win, &icons, &id, &snapshot.appearance.color_mode) {
        appicon::apply_window(&win, &snapshot.appearance.color_mode);
    }
    let app2 = app.clone();
    let id2 = id.clone();
    let win2 = win.clone();
    let closing2 = closing.inner().clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if closing2.contains(&id2) {
                // 已在关闭流程中（close_report / 程序化关闭 / 看门狗）——
                // 记账后放行（P6.5 之前的行为）。
                remember_bounds(&app2, &id2, &win2);
                let _ = app2
                    .emit_to("main", "plugin-window-closed", serde_json::json!({ "id": id2 }));
            } else {
                // 用户发起的关闭：拦截一次，让页面先快照（P6.5）。页面应答
                // plugin_window_close_report 完成销毁；3s 内无应答（插件卡死）
                // 由看门狗强制销毁 —— 关闭必须总能完成。
                api.prevent_close();
                let _ = win2.emit("plugin-window-close-requested", id2.clone());
                let app3 = app2.clone();
                let id3 = id2.clone();
                let win3 = win2.clone();
                let closing3 = closing2.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !closing3.contains(&id3) {
                        remember_bounds(&app3, &id3, &win3);
                        let _ = app3.emit_to(
                            "main",
                            "plugin-window-closed",
                            serde_json::json!({ "id": id3 }),
                        );
                        closing3.insert(&id3);
                        let _ = win3.destroy();
                    }
                });
            }
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
        "titlebar": m.titlebar,
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

/// Close (destroy) a detached plugin window WITHOUT a snapshot — the
/// programmatic path (disable / reload / uninstall cleanup): the plugin's
/// code is about to be replaced, so restoring its old page state into the
/// new code is meaningless. Marks the closing set first so the
/// `CloseRequested` interceptor lets the close straight through.
#[tauri::command]
pub fn plugin_window_close(
    id: String,
    app: AppHandle,
    closing: State<'_, ClosingSet>,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&window_label(&id)) {
        closing.insert(&id);
        let _ = win.close();
    }
    Ok(())
}

/// The page-reported close (P6.5): the frontend snapshotted the view on a
/// user-initiated close (× / Esc / close-requested answer) and hands the
/// state back here. Remember the geometry, deliver the closed event WITH
/// the snapshot payload, then destroy. `win.destroy()` skips
/// `CloseRequested`, so the bookkeeping happens here.
#[tauri::command]
pub fn plugin_window_close_report(
    id: String,
    snapshot: Option<serde_json::Value>,
    query: Option<String>,
    window: tauri::WebviewWindow,
    app: AppHandle,
    closing: State<'_, ClosingSet>,
) -> Result<(), String> {
    if window.label() != window_label(&id) {
        return Err("plugin_window_close_report: wrong window".into());
    }
    closing.insert(&id);
    if let Some(win) = app.get_webview_window(&window_label(&id)) {
        remember_bounds(&app, &id, &win);
        let _ = app.emit_to(
            "main",
            "plugin-window-closed",
            serde_json::json!({ "id": id, "snapshot": snapshot, "query": query }),
        );
        let _ = win.destroy();
    }
    Ok(())
}

/// Persist one window's geometry (logical px) into
/// `settings.plugins.window_bounds` — silent, no settings-applied: a
/// geometry write must not re-run the frontend refresh pipeline.
fn remember_bounds(app: &AppHandle, id: &str, win: &tauri::WebviewWindow) {
    // A close while maximized must not store the maximized geometry — the
    // restore path would reopen a huge non-maximized window. Skip the write
    // and keep the last normal bounds instead (there is no maximized flag in
    // `WindowBounds`, and rcNormalPosition plumbing is not worth it).
    if win.is_maximized().unwrap_or(false) {
        return;
    }
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

/// Give a detached window its own AppUserModelID (`Lume.Plugin.<id>`) so the
/// taskbar treats it as a separate app: own button, own icon, individually
/// pinnable — Electron's `setAppDetails({ appId })` equivalent, for which
/// Tauri has no API. Runs before the window is ever shown; the id is stable
/// per plugin (pinning keys off it) and needs no registry registration — for
/// an unregistered id the shell falls back to the window icon, which
/// `appicon` sets from the plugin's manifest `icon`.
///
/// COM note: the window store write is dispatched to the main thread (see
/// the call site) — the apartment is initialized here anyway as a safety
/// net, uninit stays balanced and only when this call did the init
/// (RPC_E_CHANGED_MODE / already-inited S_FALSE tell us someone else owns
/// the apartment choice).
fn set_window_aumid(win: &tauri::WebviewWindow, id: &str) {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};
    use windows::Win32::Storage::EnhancedStorage::PKEY_AppUserModel_ID;

    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    unsafe {
        let initialized = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        if let Some(store) = property_store(hwnd) {
            if let Some(pv) = str_propvariant(&format!("Lume.Plugin.{id}")) {
                match store.SetValue(&PKEY_AppUserModel_ID, &pv) {
                    Ok(()) => {
                        // Belt and braces: some store implementations only
                        // publish on Commit (E_NOTIMPL here is harmless).
                        let _ = store.Commit();
                    }
                    Err(e) => eprintln!("[plugin_window] AUMID for \"{id}\" rejected: {e}"),
                }
            }
        }
        if initialized {
            CoUninitialize();
        }
    }
}

/// The window's `IPropertyStore` (`SHGetPropertyStoreForWindow`). Errors are
/// logged — a window without an AUMID simply merges into the launcher's
/// taskbar entry, the pre-P6.8 behaviour.
unsafe fn property_store(
    hwnd: windows::Win32::Foundation::HWND,
) -> Option<windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore> {
    use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, SHGetPropertyStoreForWindow};

    match SHGetPropertyStoreForWindow::<IPropertyStore>(hwnd) {
        Ok(store) => Some(store),
        Err(e) => {
            eprintln!("[plugin_window] SHGetPropertyStoreForWindow failed: {e}");
            None
        }
    }
}

/// A VT_LPWSTR `PROPVARIANT` — what `InitPropVariantFromString` produces, but
/// that function is not exposed by windows-rs 0.61 and the crate's
/// `From<&str>` impl yields VT_BSTR, which the shell's window property store
/// does not accept for this key. The allocation is CoTaskMem (freed by
/// `PROPVARIANT`'s Drop → `PropVariantClear`).
unsafe fn str_propvariant(s: &str) -> Option<windows::Win32::System::Com::StructuredStorage::PROPVARIANT> {
    use windows::core::PWSTR;
    use windows::Win32::System::Com::CoTaskMemAlloc;
    use windows::Win32::System::Com::StructuredStorage::{
        PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;

    let mut wide: Vec<u16> = s.encode_utf16().collect();
    wide.push(0);
    let mem = CoTaskMemAlloc(wide.len() * 2) as *mut u16;
    if mem.is_null() {
        return None;
    }
    std::ptr::copy_nonoverlapping(wide.as_ptr(), mem, wide.len());
    // The exact shape the crate's own `variant_from_value!` macro builds —
    // spelled out because windows-rs has no `From<&str>` for VT_LPWSTR (its
    // string impl is VT_BSTR) and `InitPropVariantFromString` is not
    // generated in 0.61.
    Some(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_LPWSTR,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 { pwszVal: PWSTR(mem) },
            }),
        },
    })
}
