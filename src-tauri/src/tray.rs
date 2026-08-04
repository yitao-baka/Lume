//! System tray icon with a right-click menu: Restart / Exit.
//!
//! Left-clicking the tray toggles the launcher window. Menu labels follow the
//! system UI language (the only Rust-side UI strings).

use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

/// Create the tray icon; logs and skips if there is no default window icon.
pub fn setup(app: &tauri::App) {
    let Some(icon) = app.default_window_icon() else {
        eprintln!("[tray] no default icon, skipping tray");
        return;
    };
    let icon = icon.clone();
    let (settings_label, restart_label, exit_label) = tray_labels();

    if let Err(e) = build_tray(app, icon, settings_label, restart_label, exit_label) {
        eprintln!("[tray] failed to create tray: {e}");
    }
}

fn build_tray(
    app: &tauri::App,
    icon: tauri::image::Image<'_>,
    settings_label: &'static str,
    restart_label: &'static str,
    exit_label: &'static str,
) -> tauri::Result<()> {
    let settings = MenuItemBuilder::with_id("settings", settings_label).build(app)?;
    let restart = MenuItemBuilder::with_id("restart", restart_label).build(app)?;
    let exit = MenuItemBuilder::with_id("exit", exit_label).build(app)?;
    let menu = MenuBuilder::new(app)
        .items(&[&settings, &restart, &exit])
        .build()?;

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Lume")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            // Left-click toggles the launcher window.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = crate::window::toggle_launcher(app.clone());
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => {
                let _ = crate::window::open_settings(app.clone());
            }
            // `request_restart` / `exit` are built-in AppHandle methods.
            "restart" => app.request_restart(),
            "exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Tray menu labels follow the system UI language (Chinese vs English).
fn tray_labels() -> (&'static str, &'static str, &'static str) {
    use windows::Win32::Globalization::GetUserDefaultUILanguage;
    // LANGID: low 10 bits are the primary language; Chinese primary = 0x04.
    let lang = unsafe { GetUserDefaultUILanguage() };
    if (lang & 0x3FF) == 0x04 {
        ("设置", "重启", "关闭")
    } else {
        ("Settings", "Restart", "Exit")
    }
}
