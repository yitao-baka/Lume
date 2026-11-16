pub mod agent;
pub mod appicon;
mod apps;
mod bounded;
mod automation;
pub mod cache;
mod clipboard;
mod dirwatch;
mod envwatch;
pub mod everything;
mod explorer;
mod filesearch;
mod hotkey;
mod i18n;
mod icons;
pub mod input;
mod notify;
pub mod onboarding;
pub mod paths;
mod pins;
pub mod pipe;
mod plugin_devwatch;
mod plugin_fs;
mod plugin_host;
mod plugin_install;
mod plugin_logic;
mod plugin_net;
mod plugin_page;
mod plugin_perm;
mod plugin_secret;
pub mod plugin_sign;
mod plugin_store;
mod plugin_window;
mod plugins;
pub mod recent;
pub mod settings;
pub mod svc;
mod texts;
mod tray;
pub mod usnidx;
mod webview_guard;
mod window;
mod window_geometry;

use std::ffi::c_void;
use std::sync::atomic::{AtomicPtr, Ordering};

use tauri::{Manager, WindowEvent};

/// The held single-instance mutex handle. Keeping the handle here rather than in
/// a stack local lets the tray restart path release it before Tauri spawns the
/// replacement process.
static INSTANCE_MUTEX: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

/// Manual-reset event held by the first instance. A second launch signals this
/// once and exits; the resident instance wakes and reveals the launcher.
static INSTANCE_ACTIVATION_EVENT: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

fn instance_suffix() -> String {
    // The verification harness runs isolated copies of the debug executable
    // beside a private data directory. Give those copies their own kernel
    // objects so tests never attach to the user's launcher.
    #[cfg(debug_assertions)]
    {
        std::env::var("LUME_INSTANCE_ID")
            .ok()
            .filter(|value| {
                !value.is_empty()
                    && value.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
            })
            .map(|value| format!("-{value}"))
            .unwrap_or_default()
    }
    #[cfg(not(debug_assertions))]
    {
        String::new()
    }
}

fn instance_object_name(stem: &str, suffix: &str) -> Vec<u16> {
    format!("{stem}{suffix}")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

/// Tell an already-running instance to reveal the launcher. Retry briefly so a
/// very fast second launch cannot race the first process creating its event.
fn signal_existing_instance(suffix: &str) {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};

    let name = instance_object_name("LumeLauncher_Activate", suffix);
    for _ in 0..20 {
        if let Ok(event) = unsafe { OpenEventW(EVENT_MODIFY_STATE, false, PCWSTR(name.as_ptr())) } {
            let _ = unsafe { SetEvent(event) };
            let _ = unsafe { CloseHandle(event) };
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    eprintln!("[lume] second launch could not signal the running instance");
}

/// Single-instance guard: a per-session named mutex held for the process
/// lifetime. A second launch signals the resident instance, then exits, so
/// Lume never multi-opens and re-launching its exe/shortcut summons the window.
fn acquire_single_instance() -> bool {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::{CreateEventW, CreateMutexW};

    let suffix = instance_suffix();
    let mutex_name = instance_object_name("LumeLauncher_SingleInstance", &suffix);
    let handle = match unsafe { CreateMutexW(None, true, PCWSTR(mutex_name.as_ptr())) } {
        Ok(handle) => handle,
        Err(e) => {
            // Can't acquire the mutex — fail open so a mutex fault never
            // blocks the app from starting.
            eprintln!("[lume] single-instance mutex error: {e}");
            return true;
        }
    };
    if handle.0.is_null() || unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        if !handle.0.is_null() {
            let _ = unsafe { CloseHandle(handle) };
        }
        signal_existing_instance(&suffix);
        return false;
    }
    INSTANCE_MUTEX.store(handle.0, Ordering::SeqCst);

    let event_name = instance_object_name("LumeLauncher_Activate", &suffix);
    match unsafe { CreateEventW(None, true, false, PCWSTR(event_name.as_ptr())) } {
        Ok(event) => INSTANCE_ACTIVATION_EVENT.store(event.0, Ordering::SeqCst),
        Err(error) => eprintln!("[lume] instance activation event failed: {error}"),
    }
    true
}

/// Wait for second-launch signals and reveal/focus the resident launcher. The
/// manual-reset event coalesces rapid duplicate launches; each wake activates
/// the window once.
fn install_activation_listener(app: tauri::AppHandle) {
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{ResetEvent, WaitForSingleObject, INFINITE};

    let raw = INSTANCE_ACTIVATION_EVENT.load(Ordering::SeqCst) as usize;
    if raw == 0 {
        return;
    }
    let result = std::thread::Builder::new()
        .name("instance-activation".into())
        .spawn(move || loop {
            let wait = unsafe { WaitForSingleObject(HANDLE(raw as _), INFINITE) };
            if wait != WAIT_OBJECT_0 {
                break;
            }
            let _ = unsafe { ResetEvent(HANDLE(raw as _)) };
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = onboarding::activate_launcher(app).await {
                    eprintln!("[lume] second-launch activation failed: {error}");
                }
            });
        });
    if let Err(error) = result {
        eprintln!("[lume] instance activation listener failed: {error}");
    }
}

/// Drop the process-lifetime single-instance guard. Tauri restarts by spawning
/// the new process before the old process exits, so the replacement otherwise
/// races this mutex and is mistaken for a duplicate launch.
fn release_single_instance() {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};

    let event = INSTANCE_ACTIVATION_EVENT.swap(std::ptr::null_mut(), Ordering::SeqCst);
    if !event.is_null() {
        let _ = unsafe { CloseHandle(HANDLE(event)) };
    }
    let handle = INSTANCE_MUTEX.swap(std::ptr::null_mut(), Ordering::SeqCst);
    if !handle.is_null() {
        let _ = unsafe { CloseHandle(HANDLE(handle)) };
    }
}

/// Restart through Tauri after handing the single-instance mutex to the new
/// process. The release must happen before `request_restart` because Tauri's
/// request-exit failure fallback also spawns directly.
pub(crate) fn restart_app(app: &tauri::AppHandle) {
    release_single_instance();
    app.request_restart();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Single instance: hold a named mutex for the process lifetime; a second
    // launch signals the resident window and exits (docs/ARCHITECTURE.md).
    if !acquire_single_instance() {
        return;
    }

    tauri::Builder::default()
        .manage(apps::AppIndex::default())
        .manage(hotkey::ActiveHotkey::default())
        .manage(automation::AutomationState::default())
        .manage(window::FocusState::default())
        .manage(window::PlacementState::default())
        .manage(window_geometry::GeometryState::default())
        .manage(dirwatch::DirWatchState::default())
        .manage(plugin_devwatch::DevWatchState::default())
        .manage(window::PreviewState::default())
        .manage(plugin_perm::PluginPermState::default())
        .manage(plugin_window::ClosingSet::default())
        .manage(appicon::PluginIcons::default())
        .plugin(hotkey::build())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            // Migrate the legacy DB into the data/ dir first, so clipboard/pins
            // open the new location (docs/ARCHITECTURE.md).
            paths::migrate_db(app);
            // Installed layout: copy any exe-adjacent data/settings/languages
            // into the writable %LOCALAPPDATA% base before settings init.
            paths::migrate_installed();
            // A killed process mid-`.lupx`-install must not leave staging
            // junk under data/ (plugin_install.rs).
            plugin_install::cleanup_staging(&paths::base_dir());
            // Settings: ensure settings/default.toml/settings.toml exist and
            // manage the effective settings state (docs/SETTINGS.md). The
            // returned first-run bit also seeds the one-time onboarding state.
            let first_run = settings::init(app);
            onboarding::init(app, first_run);

            // ── Inject settings into the frontend before the first render ──
            // Serialize the effective settings and set window.__LUME_CONFIG__
            // via an initialization script so SolidJS can read them synchronously
            // from createSignal defaults — no async IPC race on first paint.
            let current = app.state::<settings::SettingsState>().current();
            let config_json = serde_json::to_string(&current).unwrap_or_else(|_| "{}".into());
            let onboarding_json = serde_json::to_string(
                &app.state::<onboarding::OnboardingStateStore>().snapshot(),
            )
            .unwrap_or_else(|_| "{}".into());
            let init_script = format!(
                "window.__LUME_CONFIG__ = {config_json};window.__LUME_ONBOARDING__ = {onboarding_json};{}",
                window::debug_flag_script()
            );

            // Clipboard, pins and recent must be managed before the first
            // webview exists: the hidden launcher can invoke these commands as
            // soon as its document loads (state-not-managed startup race).
            clipboard::init(app);
            pins::init(app);
            recent::init(app);

            // Must run before the first WebView2 environment is created.
            webview_guard::configure_browser_environment();

            // All startup webviews are hidden, but Tauri focuses both the
            // native window and WebView2 by default. `visible(false)` only
            // hides the top-level HWND, so it must be paired with
            // `focused(false)` (which propagates to the WebView controller) or
            // startup steals the foreground three times while the windows are
            // still invisible. Show paths focus explicitly after `show()`.
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
            .shadow(true)
            // CSS owns the surface so the configured opacity can reveal the
            // desktop; keep the native window and WebView controller transparent.
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            // : the Tauri drag-drop handler is ENABLED here (the only
            // window) so OS file drags arrive as `tauri://drag-drop` with real
            // paths (WebView2's HTML5 drop never exposes paths). The handler
            // swallows non-file HTML5 drags, which is why pinned-bar reordering
            // runs on pointer events (src/launcher/navigate.ts) and the other
            // windows keep it disabled.
            .initialization_script(&init_script)
            .build()?;
            // Keep the DWM strip in step with the launcher surface. At 100%
            // opacity it is painted the surface color; below 100% it is
            // cleared because DWM border colors cannot carry alpha. The
            // shadow and Win11 rounded corners stay.
            if let Some(mw) = app.get_webview_window("main") {
                if let Err(error) = window::set_webview_default_background(&mw, (0, 0, 0, 0)) {
                    eprintln!("[window] transparent WebView2 background failed: {error}");
                }
                webview_guard::install(&mw);
                window::apply_launcher_chrome(&mw, &current.appearance);
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
            // No Acrylic backdrop on the launcher (intentionally removed): the
            // panel is opaque `--surface` (src/App.css `.launcher`), so a
            // backdrop effect would be invisible — while its translucent
            // composite can never be reproduced by the opaque DWM frame strip,
            // which is what produced the edge/corner ring
            // (docs/UI_GUIDELINES.md 拼接面，docs/ROADMAP_HISTORY.md).
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
                            // Central hide path: emits `launcher-hidden` (the
                            // idle-reset anchor), tears the preview down and
                            // arms the memory trim.
                            let _ = window::hide_main(&app_handle);
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
            // 颜色模式 = system: the OS app theme can flip at runtime (the
            // frontend follows it via `prefers-color-scheme`). Repaint the DWM
            // frame border strip so the ring keeps matching the panel — a
            // settings save would do it too, but this flip never saves.
            if let Some(win) = app.get_webview_window("main") {
                let themed = win.clone();
                let app_handle = app.handle().clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::ThemeChanged(_) = event {
                        let current = app_handle
                            .try_state::<settings::SettingsState>()
                            .map(|s| s.current())
                            .unwrap_or_default();
                        window::apply_launcher_chrome(&themed, &current.appearance);
                        appicon::apply(&app_handle, &current.appearance.color_mode);
                    }
                });
            }
            // Register the configured toggle hotkey (设置 → 快捷键) — a
            // single attempt with no silent fallback: a combo another app
            // already owns stays a settings problem resolved there
            // (docs/ARCHITECTURE.md).
            hotkey::register(app, &current.hotkeys.toggle);
            // 自动动作 — send a configured hotkey when a configured program
            // takes the foreground with a fresh window (shell hook, event-driven).
            automation::init(app);
            // Keep our process env block in sync with system env changes
            // (WM_SETTINGCHANGE + registry notify) so launched apps inherit a
            // fresh PATH / variables. Event-driven, zero CPU when idle.
            envwatch::init();
            // Watch the index dirs for file changes and refresh on change
            // (FindFirstChangeNotification, event-driven — no polling).
            dirwatch::start(app.handle());
            // Dev-mode plugin directory watch (edit → auto hot-reload, #32.7).
            plugin_devwatch::start(app.handle());
            // System tray icon (Restart / Exit right-click menu).
            tray::setup(app);
            // Theme-matched app icon (dark/light artwork pair) on the windows'
            // taskbar icons and the tray (docs/ROADMAP_HISTORY.md #31).
            appicon::apply(app.handle(), &current.appearance.color_mode);
            // Main and preview start hidden; settings has no page until first
            // use. Sync the controller visibility and idle memory of the pages
            // that do exist so the launch baseline is minimal. The first hotkey
            // restores Normal in `window::show` before the window is painted.
            window::trim_main_now(app.handle());
            window::sync_aux_memory_targets(app.handle());
            // Run last so startup memory bookkeeping cannot make a just-revealed
            // launcher controller invisible. First launch opens the independent
            // welcome; a resumed tour reveals the launcher at its saved lesson.
            onboarding::show_startup(app.handle());
            install_activation_listener(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window::toggle_launcher,
            window::hide_launcher,
            window::open_settings,
            window::close_settings,
            onboarding::onboarding_get,
            onboarding::onboarding_advance,
            onboarding::onboarding_continue_from_welcome,
            onboarding::onboarding_open_settings,
            onboarding::onboarding_finish,
            onboarding::onboarding_skip,
            onboarding::onboarding_replay,
            window::settings_renderer_ready,
            window::window_minimize,
            window::window_toggle_maximize,
            window::window_toggle_pin,
            window::apply_position,
            window_geometry::apply_launcher_geometry,
            window_geometry::launcher_show_ready,
            window_geometry::launcher_renderer_ready,
            window_geometry::launcher_geometry_diagnostics,
            window::get_work_area,
            window::show_preview,
            window::close_preview,
            window::get_preview_request,
            window::preview_renderer_ready,
            window::allow_asset_path,
            window::plugin_allow_asset_path,
            explorer::get_foreground_context,
            explorer::plugin_foreground_context,
            explorer::open_terminal_in_folder,
            explorer::copy_path,
            explorer::trash_to_recycle,
            explorer::get_terminal_icons,
            apps::search_apps,
            apps::refresh_index,
            apps::rebuild_index,
            apps::open_path,
            apps::launch_app,
            apps::reveal_in_folder,
            filesearch::file_search,
            filesearch::file_search_status,
            hotkey::get_hotkey,
            hotkey::validate_hotkey,
            hotkey::validate_mode_hotkey,
            automation::validate_auto_combo,
            automation::list_window_programs,
            automation::test_automation_rule,
            i18n::load_language_files,
            clipboard::search_clipboard,
            clipboard::get_clipboard_thumbnails,
            clipboard::copy_clipboard,
            clipboard::paste_clipboard,
            clipboard::paste_clipboard_multi,
            clipboard::delete_clipboard,
            clipboard::restore_clipboard,
            clipboard::pin_clipboard,
            clipboard::clear_clipboard,
            clipboard::set_clipboard_paused,
            clipboard::get_file_text,
            clipboard::get_file_bytes,
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
            settings::validate_index_dir,
            settings::save_settings,
            settings::save_settings_patch,
            settings::export_settings,
            settings::import_settings,
            settings::restore_default,
            settings::restore_backup,
            settings::save_last_page,
            settings::set_remember_checks,
            plugins::get_plugins,
            plugin_store::plugin_storage_get,
            plugin_store::plugin_storage_set,
            plugins::reload_plugin,
            plugin_install::plugin_lupx_inspect,
            plugin_install::plugin_lupx_install,
            plugin_install::plugin_uninstall,
            plugin_window::plugin_window_open,
            plugin_window::plugin_window_ready,
            plugin_window::plugin_window_meta,
            plugin_window::plugin_window_redirect,
            plugin_window::plugin_window_push_state,
            plugin_window::plugin_page_bridge_call,
            plugin_window::plugin_page_bridge_reply,
            plugin_window::plugin_window_close,
            plugin_window::plugin_window_close_report,
            plugin_window::set_plugin_color_mode,
            plugin_logic::plugin_logic_host_ensure,
            plugin_logic::plugin_logic_host_close,
            plugin_logic::plugin_logic_meta,
            plugin_logic::plugin_logic_read_file,
            plugin_logic::plugin_logic_register_tokens,
            plugin_logic::plugin_logic_push,
            plugin_logic::plugin_logic_action,
            plugin_logic::plugin_logic_result,
            plugin_logic::plugin_logic_supervisor_ready,
            plugin_secret::plugin_secret_status,
            plugin_secret::plugin_secret_set,
            plugin_secret::plugin_secret_clear,
            plugin_secret::plugin_secret_service_has,
            plugin_secret::plugin_secret_service_get,
            plugin_page::plugin_page_publish,
            plugin_page::plugin_page_emit,
            plugin_page::plugin_page_error,
            plugin_page::plugin_page_clear_error,
            plugin_store::plugin_db_get,
            plugin_store::plugin_db_put,
            plugin_store::plugin_db_remove,
            plugin_store::plugin_db_all_docs,
            plugin_store::plugin_db_bulk_docs,
            plugin_store::plugin_settings_get,
            plugin_store::plugin_settings_put,
            plugin_store::plugin_presenter_settings_get,
            plugin_store::plugin_presenter_settings_put,
            plugin_fs::plugin_fs_private_write,
            plugin_fs::plugin_fs_private_write_b64,
            plugin_fs::plugin_fs_private_read,
            plugin_fs::plugin_fs_private_list,
            plugin_fs::plugin_fs_private_path,
            plugin_fs::plugin_fs_private_remove,
            plugin_fs::plugin_fs_write_any,
            plugin_net::plugin_http_fetch,
            notify::plugin_notify,
            clipboard::plugin_clipboard_write_image,
            clipboard::plugin_clipboard_write_files,
            clipboard::plugin_clipboard_read_files,
            clipboard::plugin_clipboard_has_image,
            clipboard::plugin_clipboard_read_image,
            clipboard::plugin_clipboard_paste,
            plugin_host::plugin_dialog_open,
            plugin_host::plugin_dialog_save,
            plugin_host::plugin_cursor_pos,
            plugin_host::plugin_displays,
            plugin_host::file_kinds,
            settings::set_plugin_enabled,
            settings::set_plugin_trusted,
            settings::set_plugin_dev_mode,
            settings::set_plugin_trust_all,
            settings::set_plugin_keep_session,
            settings::clear_plugin_keep_session,
            clipboard::get_clipboard_text,
            clipboard::set_clipboard_text,
            clipboard::normalize_clipboard_ignore_app,
            clipboard::clipboard_ignore_app_icons,
            svc::svc_status,
            svc::svc_install,
            svc::svc_uninstall,
            svc::svc_start,
            svc::svc_restart,
            svc::autostart_get,
            svc::autostart_set,
            agent::agent_status,
            agent::agent_install,
            agent::agent_uninstall,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Lume")
        // 记住上次所在页面 (docs/ROADMAP_HISTORY.md #40): no app-exit hook — the bookmark now
        // survives restarts. It is only written while the toggle is on, and the
        // frontend restores it under the same toggle; search words and page
        // snapshots stay memory-only either way.
        .run(|_app, _event| {});
}
