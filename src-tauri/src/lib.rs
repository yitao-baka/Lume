mod apps;
pub mod cache;
mod clipboard;
mod dirwatch;
mod envwatch;
mod explorer;
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
        .manage(dirwatch::DirWatchState::default())
        .manage(window::PreviewState::default())
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

            // Satellite preview window (ROADMAP #15): all clipboard previews
            // (text / text files / images / audio / video) render here, docked
            // flush to the launcher's right edge. Created at startup (hidden)
            // like the settings window to avoid runtime window creation;
            // non-activating (`WS_EX_NOACTIVATE` via set_focusable) so clicking
            // it never steals focus from the launcher.
            tauri::WebviewWindowBuilder::new(
                app,
                "preview",
                tauri::WebviewUrl::App("preview.html".into()),
            )
            .title("Lume Preview")
            .inner_size(320.0, 480.0) // real size set on every dock
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .background_color(tauri::window::Color(30, 30, 32, 255))
            .disable_drag_drop_handler()
            .build()?;
            if let Some(pv) = app.get_webview_window("preview") {
                // tao maps focusable(false) → WS_EX_NOACTIVATE on Windows.
                let _ = pv.set_focusable(false);
            }

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
                let app_handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Focused(false) = event {
                        // Skip the auto-hide while dragging, or right after a
                        // paste when 粘贴后关闭 is off (the launcher stays up).
                        let preview_click = window::preview_has_cursor(&app_handle);
                        let suppressed = window::is_mid_drag(&hide_on_blur)
                            || app_handle
                                .try_state::<window::FocusState>()
                                .map(|f| window::is_hide_suppressed(&f))
                                .unwrap_or(false)
                            // Clicking the satellite preview blurs the launcher
                            // too; the cursor being over the preview means the
                            // click was meant for it, not for another app.
                            || preview_click;
                        if !suppressed {
                            let _ = hide_on_blur.hide();
                            // The satellite preview dies with the launcher: a
                            // merely hidden window could keep playing media and
                            // never reclaim its decoded memory.
                            window::teardown_preview(&app_handle);
                            // Main renderer goes Low only after it stays hidden
                            // (frequent focus-loss re-shows stay instant).
                            window::trim_main_when_idle(&app_handle);
                        } else if preview_click {
                            // The blur came from clicking the satellite — hand
                            // focus BACK to the launcher. Otherwise the preview's
                            // webview keeps the keyboard (list arrows stop working)
                            // and the launcher is left unfocused-but-visible, so
                            // a later click-away never re-fires its blur-to-hide.
                            let _ = hide_on_blur.set_focus();
                        }
                    }
                });
            }
            // Keep the satellite preview docked: whenever the launcher moves or
            // resizes (drag, preset, content-height change), re-dock it. Gated
            // on visibility so idle Moved/Resized noise is a no-op.
            if let Some(win) = app.get_webview_window("main") {
                let app_handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::Moved(_) | WindowEvent::Resized(_) = event {
                        let preview_visible = app_handle
                            .get_webview_window("preview")
                            .and_then(|w| w.is_visible().ok())
                            .unwrap_or(false);
                        if preview_visible {
                            let _ = window::redock(&app_handle);
                        }
                    }
                });
            }
            // Settings window: the title-bar X hides instead of destroying the
            // window, so `open_settings` can re-show the same instance.
            if let Some(win) = app.get_webview_window("settings") {
                let keep = win.clone();
                let app_handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = keep.hide();
                        // Title-bar X bypasses the `close_settings` command —
                        // sync the aux windows' memory target here too.
                        window::sync_aux_memory_targets(&app_handle);
                    }
                });
            }
            // Alt+Space toggles the launcher (docs/ARCHITECTURE.md).
            hotkey::register(app);
            // Keep our process env block in sync with system env changes
            // (WM_SETTINGCHANGE + registry notify) so launched apps inherit a
            // fresh PATH / variables. Event-driven, zero CPU when idle.
            envwatch::init();
            // Watch the index dirs for file changes and refresh on change
            // (FindFirstChangeNotification, event-driven — no polling).
            dirwatch::start(&app.handle());
            // Clipboard history listener + SQLite store (docs/ARCHITECTURE.md).
            clipboard::init(app);
            // Pinned-apps store (Navigate main-menu bar).
            pins::init(app);
            // Recent-opens store (Navigate main-menu bar, above the pins).
            recent::init(app);
            // System tray icon (Restart / Exit right-click menu).
            tray::setup(app);
            // All three webviews start hidden — swap their idle memory out now so
            // the launch baseline is minimal. The first hotkey restores Normal
            // in `window::show` (before the window is painted).
            window::trim_main_now(app.handle());
            window::sync_aux_memory_targets(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::toggle_launcher,
            window::hide_launcher,
            window::open_settings,
            window::close_settings,
            window::apply_position,
            window::get_work_area,
            window::show_preview,
            window::close_preview,
            window::get_preview_request,
            explorer::get_foreground_context,
            explorer::open_terminal_in_folder,
            explorer::copy_path,
            explorer::get_terminal_icons,
            apps::search_apps,
            apps::refresh_index,
            apps::launch_app,
            apps::reveal_in_folder,
            hotkey::get_hotkey,
            hotkey::validate_hotkey,
            i18n::load_language_files,
            clipboard::search_clipboard,
            clipboard::copy_clipboard,
            clipboard::paste_clipboard,
            clipboard::paste_clipboard_multi,
            clipboard::delete_clipboard,
            clipboard::restore_clipboard,
            clipboard::pin_clipboard,
            clipboard::clear_clipboard,
            clipboard::set_clipboard_paused,
            clipboard::get_file_text,
            clipboard::get_file_thumb,
            clipboard::get_video_thumb,
            clipboard::get_clipboard_image,
            clipboard::check_file_exists,
            clipboard::set_clipboard_checked,
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
            settings::save_last_page,
            settings::set_remember_checks,
            svc::svc_status,
            svc::svc_install,
            svc::svc_uninstall,
            svc::autostart_get,
            svc::autostart_set,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Lume")
        .run(|app, event| {
            // 记住上次所在页面: clearing the bookmark when Lume closes means the
            // next launch starts on the initial page — the memory is in-session
            // only (hide/show keeps it; a full exit resets it). Both the tray
            // Exit and Restart fire ExitRequested. Safe from the single-instance
            // duplicate process (it returns before the Tauri app is built).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<settings::SettingsState>() {
                    let _ = settings::clear_last_page(&state);
                }
            }
        });
}
