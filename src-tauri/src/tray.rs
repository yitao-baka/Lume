//! System tray icon with a right-click menu: Restart / Exit.
//!
//! Left-clicking the tray toggles the launcher window. Menu labels follow the
//! configured launcher language, falling back to the system UI language.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

/// Fixed tray id — `appicon::apply` looks the tray up by it to swap the icon
/// when the color mode changes.
pub const TRAY_ID: &str = "lume-tray";

/// Create the tray icon; logs and skips if there is no default window icon.
pub fn setup(app: &tauri::App) {
    let Some(icon) = app.default_window_icon() else {
        eprintln!("[tray] no default icon, skipping tray");
        return;
    };
    let icon = icon.clone();
    let menu = match build_menu(app, &tray_labels(app)) {
        Ok(menu) => menu,
        Err(e) => {
            eprintln!("[tray] failed to build menu: {e}");
            return;
        }
    };

    if let Err(e) = build_tray(app, icon, menu) {
        eprintln!("[tray] failed to create tray: {e}");
    }
}

fn build_tray(
    app: &tauri::App,
    icon: tauri::image::Image<'_>,
    menu: Menu<tauri::Wry>,
) -> tauri::Result<()> {
    TrayIconBuilder::with_id(TRAY_ID)
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
                let app = tray.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::onboarding::toggle_launcher(app).await;
                });
            }
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "settings" => {
                let _ = crate::window::open_settings(app.clone());
            }
            // Release the single-instance guard before Tauri spawns the
            // replacement process; the reverse order makes the new instance
            // lose the mutex and exit silently.
            "restart" => crate::restart_app(app),
            "exit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn build_menu(
    manager: &impl Manager<tauri::Wry>,
    labels: &crate::texts::TrayText,
) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItemBuilder::with_id("settings", labels.settings.clone()).build(manager)?;
    let restart = MenuItemBuilder::with_id("restart", labels.restart.clone()).build(manager)?;
    let exit = MenuItemBuilder::with_id("exit", labels.exit.clone()).build(manager)?;
    MenuBuilder::new(manager)
        .items(&[&settings, &restart, &exit])
        .build()
}

/// Rebuild the tray menu after a settings save/import so its labels follow
/// the launcher's configured language, not only the startup system language.
pub fn refresh_labels(app: &AppHandle) -> tauri::Result<()> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_menu(Some(build_menu(app, &tray_labels(app))?))
}

/// `appearance.language` wins when it is an explicit locale; `"system"` falls
/// back to the Windows UI language. The wording itself lives in
/// `languages/*.json` (see `crate::texts`), so it follows user overrides.
fn tray_labels(app: &impl Manager<tauri::Wry>) -> crate::texts::TrayText {
    let configured = app
        .try_state::<crate::settings::SettingsState>()
        .map(|s| s.current().appearance.language)
        .unwrap_or_else(|| "system".into());
    crate::texts::tray(crate::i18n::UiLang::from_setting(&configured))
}
