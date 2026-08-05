//! Launcher window management.
//!
//! The launcher surface is a single frameless, transparent webview window
//! (label: `"main"`, see `tauri.conf.json`). This module owns showing and
//! hiding it.
//!
//! The commands below are the window API for the rest of the core: the
//! Global hotkey module (v0.1) and the frontend Esc key both call them.

use std::sync::Mutex;

use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// Label of the launcher window defined in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";
/// Label of the settings window defined in `tauri.conf.json`.
const SETTINGS_WINDOW: &str = "settings";

/// Last foreground window HWND captured before the launcher is shown — used by
/// the clipboard auto-paste feature to send content back to the right window.
pub struct FocusState {
    pub last_hwnd: Mutex<Option<isize>>,
}

impl Default for FocusState {
    fn default() -> Self {
        Self { last_hwnd: Mutex::new(None) }
    }
}

/// Apply the configured width and (unless 记住位置) the chosen initial
/// position to the launcher. Called on every show.
fn apply_geometry(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    let appearance = app
        .state::<crate::settings::SettingsState>()
        .current()
        .appearance;
    // Width from settings; the frontend keeps the height content-adaptive.
    let sf = window.scale_factor()?;
    let cur = window.outer_size()?.to_logical::<f64>(sf);
    window.set_size(LogicalSize::new(appearance.window_width as f64, cur.height))?;
    if !appearance.remember_position {
        apply_initial_position(window, &appearance)?;
    }
    Ok(())
}

/// Whether the launcher is currently being dragged with the mouse — the left
/// button is held and the cursor sits over the window. The hide-on-focus-loss
/// rule skips the dismiss in this state: moving a frameless window via
/// `WM_NCLBUTTONDOWN`/HTCAPTION briefly deactivates it (a `Focused(false)`
/// fires) even though the user is only repositioning it.
pub fn is_mid_drag(window: &WebviewWindow) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    let left_down = (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as i32) & 0x8000 != 0;
    left_down && cursor_is_over(window)
}

/// Whether the mouse cursor currently sits within the window's outer bounds.
fn cursor_is_over(window: &WebviewWindow) -> bool {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut pt) } == 0 {
        return false;
    }
    let Ok(pos) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let x = pt.x;
    let y = pt.y;
    x >= pos.x && x < pos.x + size.width as i32 && y >= pos.y && y < pos.y + size.height as i32
}

/// Place the launcher at the chosen initial position: centered, or flush to a
/// monitor corner. Only called when 记住位置 is off.
fn apply_initial_position(
    window: &WebviewWindow,
    appearance: &crate::settings::Appearance,
) -> tauri::Result<()> {
    if appearance.window_position == "center" {
        return window.center();
    }
    let Some(monitor) = window.current_monitor()? else {
        return window.center();
    };
    let origin = monitor.position();
    let area = monitor.size();
    let size = window.outer_size()?;
    let (x, y) = match appearance.window_position.as_str() {
        "top-left" => (0, 0),
        "top-right" => (area.width as i32 - size.width as i32, 0),
        "bottom-left" => (0, area.height as i32 - size.height as i32),
        "bottom-right" => (
            area.width as i32 - size.width as i32,
            area.height as i32 - size.height as i32,
        ),
        _ => return window.center(),
    };
    window.set_position(PhysicalPosition::new(origin.x + x, origin.y + y))?;
    Ok(())
}

/// Show and focus the launcher, applying its geometry per settings
/// (width + position, see `docs/SETTINGS.md`).
fn show(window: &WebviewWindow) -> tauri::Result<()> {
    apply_geometry(window)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// Toggle the launcher window.
///
/// Hidden → shown (centered + focused); shown → hidden.
/// When about to show, records the current foreground window for
/// clipboard auto-paste.
#[tauri::command]
pub fn toggle_launcher(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    if window.is_visible().map_err(|e| e.to_string())? {
        window.hide().map_err(|e| e.to_string())?;
    } else {
        // Record which window had focus before the launcher appeared.
        if let Some(focus) = app.try_state::<FocusState>() {
            let fg = unsafe { GetForegroundWindow() };
            *focus.last_hwnd.lock().unwrap() = Some(fg.0 as isize);
        }
        show(&window).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide the launcher window.
#[tauri::command]
pub fn hide_launcher(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    window.hide().map_err(|e| e.to_string())?;
    Ok(())
}

/// Open (show + focus) the settings window.
#[tauri::command]
pub fn open_settings(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(SETTINGS_WINDOW)
        .ok_or_else(|| "settings window not found".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// Hide the settings window (keeps its state so re-opening is instant).
#[tauri::command]
pub fn close_settings(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(SETTINGS_WINDOW)
        .ok_or_else(|| "settings window not found".to_string())?;
    window.hide().map_err(|e| e.to_string())?;
    Ok(())
}

/// Apply the window-geometry settings to the launcher immediately (used by
/// Save / Apply). Width applies now; the chosen initial position applies now
/// too when 记住位置 is off (so picking a corner gives instant feedback), and
/// on the next show regardless.
pub fn apply_settings(app: &AppHandle, settings: &crate::settings::Settings) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(());
    };
    let sf = window.scale_factor().map_err(|e| e.to_string())?;
    let cur = window
        .outer_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(sf);
    window
        .set_size(LogicalSize::new(settings.appearance.window_width as f64, cur.height))
        .map_err(|e| e.to_string())?;
    if !settings.appearance.remember_position {
        apply_initial_position(&window, &settings.appearance).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Re-apply the launcher's position after the frontend resized its height
/// (kept anchored to the center / chosen corner). No-op when 记住位置 is on —
/// the window keeps its current spot.
#[tauri::command]
pub fn apply_position(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(());
    };
    let appearance = app
        .state::<crate::settings::SettingsState>()
        .current()
        .appearance;
    if !appearance.remember_position {
        apply_initial_position(&window, &appearance).map_err(|e| e.to_string())?;
    }
    Ok(())
}
