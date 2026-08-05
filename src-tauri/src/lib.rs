mod apps;
pub mod cache;
mod clipboard;
mod envwatch;
mod hotkey;
mod i18n;
mod icons;
pub mod paths;
mod pins;
pub mod recent;
pub mod settings;
pub mod svc;
mod tray;
mod window;

use tauri::{Manager, WindowEvent};

/// Result of the single-instance check.
enum InstanceGuard {
    /// This is the first instance — hold the mutex until the process exits.
    Held(windows::Win32::Foundation::HANDLE),
    /// Another instance holds the mutex — this process must exit.
    Exit,
}

/// Single-instance guard: a per-session named mutex held for the process
/// lifetime. A second launch fails to acquire it and exits immediately, so
/// Lume never multi-opens. The handle must stay alive for the whole run.
fn acquire_single_instance() -> InstanceGuard {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{
        CloseHandle, GetLastError, HANDLE, ERROR_ALREADY_EXISTS,
    };
    use windows::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = "LumeLauncher_SingleInstance"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = match unsafe { CreateMutexW(None, true, PCWSTR(name.as_ptr())) } {
        Ok(h) => h,
        Err(e) => {
            // Can't acquire the mutex — fail open so a mutex fault never
            // blocks the app from starting.
            eprintln!("[lume] single-instance mutex error: {e}");
            return InstanceGuard::Held(HANDLE(std::ptr::null_mut()));
        }
    };
    if handle.0.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        if !handle.0.is_null() {
            let _ = unsafe { CloseHandle(handle) };
        }
        return InstanceGuard::Exit;
    }
    InstanceGuard::Held(handle)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single instance: hold a named mutex for the process lifetime; a second
    // launch exits immediately (docs/NORMS.md).
    let _guard = match acquire_single_instance() {
        InstanceGuard::Held(h) => h,
        InstanceGuard::Exit => return,
    };

    tauri::Builder::default()
        .manage(apps::AppIndex::default())
        .manage(hotkey::ActiveHotkey::default())
        .manage(window::FocusState::default())
        .plugin(hotkey::build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Migrate the legacy DB into the data/ dir first, so clipboard/pins
            // open the new location (docs/NORMS.md).
            paths::migrate_db(app);
            // Installed layout: copy any exe-adjacent data/settings/languages
            // into the writable %LOCALAPPDATA% base before settings init.
            paths::migrate_installed();
            // Settings: ensure settings/default.toml/settings.toml exist and
            // manage the effective settings state (docs/SETTINGS.md).
            settings::init(app);

            // ── Inject settings into the frontend before the first render ──
            // Serialize the effective settings and set window.__LUME_CONFIG__
            // via an initialization script so SolidJS can read them synchronously
            // from createSignal defaults — no async IPC race on first paint.
            let current = app
                .state::<settings::SettingsState>()
                .current();
            let config_json = serde_json::to_string(&current)
                .unwrap_or_else(|_| "{}".into());
            let init_script = format!("window.__LUME_CONFIG__ = {config_json};");

            // Main launcher window (replaces tauri.conf.json windows[0]).
            tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Lume")
            .inner_size(720.0, 480.0)
            .center()
            .resizable(false)
            .decorations(false)
            .transparent(true)
            .shadow(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .disable_drag_drop_handler()
            .initialization_script(&init_script)
            .build()?;

            // Settings window (replaces tauri.conf.json windows[1]).
            tauri::WebviewWindowBuilder::new(
                app,
                "settings",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("Lume")
            .inner_size(720.0, 560.0)
            .min_inner_size(560.0, 420.0)
            .center()
            .resizable(true)
            .decorations(true)
            .visible(false)
            .initialization_script(&init_script)
            .build()?;
            // Build the System32 preset DB once (background), then refresh the
            // user cache at startup and on the configured interval (minutes).
            // The GUI is the sole refresher — the LumeSVC service is a dormant
            // bridge for future features and never scans.
            let app_handle = app.handle().clone();
            std::thread::spawn(move || {
                let index = app_handle.state::<apps::AppIndex>();
                index.refresh_sys32();
                let settings = app_handle.state::<settings::SettingsState>().current();
                index.refresh_user(&settings);
                loop {
                    let minutes = app_handle
                        .state::<settings::SettingsState>()
                        .current()
                        .index
                        .cache_refresh_interval_minutes
                        .max(1) as u64;
                    std::thread::sleep(std::time::Duration::from_secs(minutes * 60));
                    let settings = app_handle.state::<settings::SettingsState>().current();
                    index.refresh_user(&settings);
                }
            });
            // Acrylic frosted-glass blur for the launcher surface
            // (docs/UI_GUIDELINES.md). Requires a transparent window.
            if let Some(win) = app.get_webview_window("main") {
                win.set_effects(tauri::utils::config::WindowEffectsConfig {
                    effects: vec![tauri::window::Effect::Acrylic],
                    ..Default::default()
                })?;
            }
            // Dismiss the launcher whenever it loses focus (click elsewhere) —
            // but not while it's being dragged, which briefly deactivates the
            // frameless window even though the cursor is still over it.
            if let Some(win) = app.get_webview_window("main") {
                let hide_on_blur = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        if !window::is_mid_drag(&hide_on_blur) {
                            let _ = hide_on_blur.hide();
                        }
                    }
                });
            }
            // Settings window: the title-bar X hides instead of destroying the
            // window, so `open_settings` can re-show the same instance.
            if let Some(win) = app.get_webview_window("settings") {
                let keep = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = keep.hide();
                    }
                });
            }
            // Alt+Space toggles the launcher (docs/ARCHITECTURE.md).
            hotkey::register(app);
            // Keep our process env block in sync with system env changes
            // (WM_SETTINGCHANGE + registry notify) so launched apps inherit a
            // fresh PATH / variables. Event-driven, zero CPU when idle.
            envwatch::init();
            // Clipboard history listener + SQLite store (docs/ARCHITECTURE.md).
            clipboard::init(app);
            // Pinned-apps store (Navigate main-menu bar).
            pins::init(app);
            // Recent-opens store (Navigate main-menu bar, above the pins).
            recent::init(app);
            // System tray icon (Restart / Exit right-click menu).
            tray::setup(app);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::toggle_launcher,
            window::hide_launcher,
            window::open_settings,
            window::close_settings,
            window::apply_position,
            window::get_work_area,
            apps::search_apps,
            apps::launch_app,
            apps::reveal_in_folder,
            hotkey::get_hotkey,
            hotkey::validate_hotkey,
            i18n::load_language_files,
            clipboard::search_clipboard,
            clipboard::copy_clipboard,
            clipboard::paste_clipboard,
            clipboard::delete_clipboard,
            clipboard::pin_clipboard,
            clipboard::clear_clipboard,
            icons::get_app_icons,
            pins::get_pinned_apps,
            pins::pin_app,
            pins::unpin_app,
            pins::reorder_pins,
            recent::get_recent_apps,
            recent::delete_recent,
            settings::get_settings,
            settings::save_settings,
            settings::export_settings,
            settings::import_settings,
            settings::restore_default,
            settings::restore_backup,
            svc::svc_status,
            svc::svc_install,
            svc::svc_uninstall,
            svc::autostart_get,
            svc::autostart_set,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Lume");
}
