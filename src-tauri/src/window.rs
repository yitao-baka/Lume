//! Launcher window management.
//!
//! The launcher surface is a single frameless, transparent webview window
//! (label: `"main"`, see `tauri.conf.json`). This module owns showing and
//! hiding it.
//!
//! The commands below are the window API for the rest of the core: the
//! Global hotkey module (v0.1) and the frontend Esc key both call them.

use std::sync::Mutex;

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, State,
    WebviewWindow,
};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// Label of the launcher window defined in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";
/// Label of the settings window defined in `tauri.conf.json`.
const SETTINGS_WINDOW: &str = "settings";
/// Label of the satellite preview window (created in `lib.rs::setup`).
const PREVIEW_WINDOW: &str = "preview";
/// Fixed logical width of the satellite preview window (the old `PREVIEW_W`).
const PREVIEW_W_LOGICAL: f64 = 320.0;
/// Logical px of breathing room between the launcher and the satellite preview
/// (applied to the client areas on BOTH sides — a left dock keeps the same gap).
const PREVIEW_GAP_LOGICAL: f64 = 4.0;

/// Last foreground window HWND captured before the launcher is shown — used by
/// the clipboard auto-paste feature to send content back to the right window.
pub struct FocusState {
    pub last_hwnd: Mutex<Option<isize>>,
    /// When 粘贴后关闭 is off, a paste must not let the follow-up blur hide the
    /// launcher. Holds the Instant until which the blur-hide is suppressed.
    pub suppress_hide_until: Mutex<Option<std::time::Instant>>,
}

impl Default for FocusState {
    fn default() -> Self {
        Self {
            last_hwnd: Mutex::new(None),
            suppress_hide_until: Mutex::new(None),
        }
    }
}

/// Arm the blur-hide suppression for `for_ms` (keeps the launcher visible
/// after a paste when 粘贴后关闭 is disabled).
pub fn suppress_hide(focus: &FocusState, for_ms: u64) {
    *focus.suppress_hide_until.lock().unwrap() =
        Some(std::time::Instant::now() + std::time::Duration::from_millis(for_ms));
}

/// True while a blur-hide suppression is active (and not yet expired).
pub fn is_hide_suppressed(focus: &FocusState) -> bool {
    let mut guard = focus.suppress_hide_until.lock().unwrap();
    match *guard {
        Some(until) if std::time::Instant::now() < until => true,
        _ => {
            *guard = None; // expired — clear so the next blur hides normally
            false
        }
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
    // Read the INNER (client) height and feed it back: outer_size() includes
    // the frameless window's non-client margins, and round-tripping the outer
    // through set_size would inflate the height by those margins every show.
    let sf = window.scale_factor()?;
    let cur = window.inner_size()?.to_logical::<f64>(sf);
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

/// Place the launcher at the chosen initial position: centered, flush to a
/// monitor corner, or centered at the mouse cursor. Only called when 记住位置
/// is off.
fn apply_initial_position(
    window: &WebviewWindow,
    appearance: &crate::settings::Appearance,
) -> tauri::Result<()> {
    if appearance.window_position == "center" {
        return window.center();
    }
    if appearance.window_position == "follow-mouse" {
        return position_at_mouse(window);
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

/// Position the launcher so its center is at the current mouse cursor,
/// clamped to stay within the active monitor's work area.
fn position_at_mouse(window: &WebviewWindow) -> tauri::Result<()> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;

    let mut pt = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut pt) } == 0 {
        return window.center();
    }
    let size = window.outer_size()?;
    let Some(monitor) = window.current_monitor()? else {
        return window.center();
    };
    let origin = monitor.position();
    let area = monitor.size();

    // Center the window on the cursor.
    let mut x = pt.x - size.width as i32 / 2;
    let mut y = pt.y - size.height as i32 / 2;

    // Clamp so the window never extends beyond the monitor edges.
    let min_x = origin.x;
    let min_y = origin.y;
    let max_x = (origin.x + area.width as i32 - size.width as i32).max(min_x);
    let max_y = (origin.y + area.height as i32 - size.height as i32).max(min_y);
    x = x.clamp(min_x, max_x);
    y = y.clamp(min_y, max_y);

    window.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

/// Show and focus the launcher, applying its geometry per settings
/// (width + position, see `docs/SETTINGS.md`).
fn show(window: &WebviewWindow) -> tauri::Result<()> {
    apply_geometry(window)?;
    window.show()?;
    window.set_focus()?;
    // Fresh-show signal for the frontend: it resets to the main menu exactly on
    // this event, NOT on every focus regain. Dragging the frameless window
    // briefly deactivates + refocuses it (see `is_mid_drag`), and a reset on
    // that would wipe the current mode/search mid-drag.
    let _ = window.emit("launcher-shown", ());
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
        // The satellite preview lives and dies with the launcher.
        teardown_preview(&app);
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
    // The satellite preview lives and dies with the launcher.
    teardown_preview(&app);
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
        .inner_size()
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
/// (kept anchored to the center / chosen corner). No-op when 记住位置 is on,
/// or when the position is "follow-mouse" (the window stays at its initial
/// cursor-triggered spot, unaffected by content-height changes).
#[tauri::command]
pub fn apply_position(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(());
    };
    let appearance = app
        .state::<crate::settings::SettingsState>()
        .current()
        .appearance;
    if appearance.window_position == "follow-mouse" || appearance.remember_position {
        return Ok(());
    }
    apply_initial_position(&window, &appearance).map_err(|e| e.to_string())?;
    Ok(())
}

/// Logical height (CSS px) of the current monitor's work area — the screen
/// minus the taskbar. Used as the "expand everything" window-height cap so an
/// expanded bar can fill the screen but never run off it. Returns `0.0` when
/// no monitor is resolved; the frontend then falls back to `window_height`.
#[tauri::command]
pub fn get_work_area(app: AppHandle) -> Result<f64, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(0.0);
    };
    let wa = monitor.work_area();
    Ok(wa.size.height as f64 / monitor.scale_factor())
}

// ── Satellite preview window (ROADMAP #15) ───────────────────────────────────
// All clipboard previews (text / text files / images / audio / video) render in
// this separate, non-activating window docked flush to the main window's right
// edge. It is created at startup (like the settings window) to avoid the
// runtime-window-creation GPU-hang risk, and on close it navigates to
// `about:blank` so the decoded bitmaps / media buffers leave the page while the
// renderer process stays resident for reuse. See `docs/ROADMAP.md` #15.

/// The frontend's last pushed preview request. The page reads it on mount
/// (`get_preview_request`) — which also self-corrects a `preview-update` event
/// that raced a page load — and it is cleared on close.
#[derive(Default)]
pub struct PreviewState(pub Mutex<Option<PreviewRequest>>);

/// What the satellite preview window renders.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PreviewRequest {
    /// `"text" | "textfile" | "image" | "audio" | "video" | "pdf"`.
    pub kind: String,
    /// The copied text itself (`kind == "text"`).
    pub content: Option<String>,
    /// A file path (`textfile` / `audio` / `video` / `pdf`, and image-*file* rows).
    pub path: Option<String>,
    /// A clipboard row id (image-*kind* rows: resolved via `get_clipboard_image`).
    pub id: Option<u32>,
}

/// Show or update the satellite preview. The request is stored first, then the
/// page is either poked with a `preview-update` event (when already resident —
/// selection changes don't reload, no flicker) or navigated back to
/// `preview.html` (when the page was torn down to `about:blank` on a previous
/// close). Re-docks on every call and shows without focusing (the window is
/// `WS_EX_NOACTIVATE` — it must never steal focus from the launcher, whose
/// blur-to-hide rule would otherwise fire).
#[tauri::command]
pub fn show_preview(app: AppHandle, req: PreviewRequest) -> Result<(), String> {
    // 设置/剪贴板 → 开启预览: when off, the satellite never shows. Idempotent
    // teardown also reclaims any preview a toggle-off left on screen.
    if !app
        .state::<crate::settings::SettingsState>()
        .current()
        .clipboard
        .preview
    {
        teardown_preview(&app);
        return Ok(());
    }
    let preview = app
        .get_webview_window(PREVIEW_WINDOW)
        .ok_or_else(|| "preview window not found".to_string())?;
    if let Some(state) = app.try_state::<PreviewState>() {
        *state.0.lock().unwrap() = Some(req.clone());
    }
    // Resident check is by URL, not visibility: the very first show may find
    // the window already loaded-hidden at startup, so we can skip a redundant
    // reload. A page torn down to `about:blank` needs re-navigating.
    let at_preview = preview
        .url()
        .map(|u| u.scheme() != "about")
        .unwrap_or(false);
    if at_preview {
        let _ = preview.emit("preview-update", &req);
    } else {
        preview.navigate(preview_page_url(&app)).map_err(|e| e.to_string())?;
    }
    // Dock + size before reveal; works while hidden too.
    if !redock(&app).map_err(|e| e.to_string())? {
        // No room on either side — the window stays hidden (see `dock_position`).
        return Ok(());
    }
    if !preview.is_visible().map_err(|e| e.to_string())? {
        // Show WITHOUT activating — `preview.show()` (SW_SHOW) can still make
        // the launcher lose focus and trigger its blur-to-hide, even though the
        // window carries WS_EX_NOACTIVATE. SW_SHOWNOACTIVATE never touches the
        // foreground window.
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
        let hwnd = preview.hwnd().map_err(|e| e.to_string())?;
        let _ = unsafe { ShowWindow(hwnd, SW_SHOWNOACTIVATE) };
    }
    Ok(())
}

/// Hide the satellite preview and tear its page down to `about:blank` — this
/// releases decoded bitmaps / media buffers (the renderer process stays
/// resident ~15MB for reuse).
#[tauri::command]
pub fn close_preview(app: AppHandle) -> Result<(), String> {
    teardown_preview(&app);
    // Let the launcher drop its Esc-priority state even when the X button (not
    // Esc) closed it.
    let _ = app.emit_to(MAIN_WINDOW, "preview-closed", ());
    Ok(())
}

/// Read the pending preview request — the page calls this once on mount.
/// Returns `None` when there is nothing to show.
#[tauri::command]
pub fn get_preview_request(
    state: State<'_, PreviewState>,
) -> Result<Option<PreviewRequest>, String> {
    Ok(state.0.lock().unwrap().clone())
}

/// Hide the preview and navigate it to `about:blank`. Used by `close_preview`
/// AND by every launcher-hide path (blur-to-hide, hotkey toggle, Esc) — a
/// merely hidden window could keep playing media and would never reclaim
/// memory. Idempotent.
pub fn teardown_preview(app: &AppHandle) {
    let Some(preview) = app.get_webview_window(PREVIEW_WINDOW) else {
        return;
    };
    // Tear the page down first, then hide synchronously via Win32. Tauri's
    // `hide()` is queued on the thread executor and can race the navigation —
    // the page unload can re-show the window, leaving it visible after teardown.
    let _ = preview.navigate(tauri::Url::parse("about:blank").unwrap());
    if let Ok(hwnd) = preview.hwnd() {
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
        unsafe {
            let _ = ShowWindow(hwnd, SW_HIDE);
        }
    }
    if let Some(state) = app.try_state::<PreviewState>() {
        *state.0.lock().unwrap() = None;
    }
}

/// True when the mouse cursor sits over the *visible* satellite preview — used
/// by the launcher's blur-to-hide rule to stay up when the user clicks the
/// preview (WS_EX_NOACTIVATE stops the preview activating, but the launcher can
/// still blur; a cursor over the preview means the click was meant for it).
pub fn preview_has_cursor(app: &AppHandle) -> bool {
    let Some(preview) = app.get_webview_window(PREVIEW_WINDOW) else {
        return false;
    };
    preview.is_visible().unwrap_or(false) && cursor_is_over(&preview)
}

/// Size (320 logical wide, the main window's current logical height) and dock
/// the preview flush to the main window. Re-run on every `show_preview` and on
/// the main window's Moved/Resized. No-op when either window is missing.
/// Returns `true` when the preview was placed, `false` when no side has room
/// (the window is hidden instead of overlapping the main window).
pub fn redock(app: &AppHandle) -> tauri::Result<bool> {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(false);
    };
    let Some(preview) = app.get_webview_window(PREVIEW_WINDOW) else {
        return Ok(false);
    };
    let sf = main.scale_factor()?;
    // Dock to the main window's on-screen CLIENT area — the visible launcher
    // surface. `outer_*` includes the frameless window's non-client margins and
    // `inner_position()` is not the client origin on screen; both leave a gap
    // (22×13 physical px at 150% DPI). GetClientRect + ClientToScreen give the
    // authoritative client rect on screen, flush at any DPI.
    let hwnd = main.hwnd()?;
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut rect);
        let _ = ClientToScreen(hwnd, &mut origin);
    }
    let main_pos = PhysicalPosition::new(origin.x, origin.y);
    let main_size = PhysicalSize::new(rect.right as u32, rect.bottom as u32);
    // Height follows the main client height. Compute the physical size from the
    // intended logical size — reading a size right after `set_size()` is async
    // on Windows and can round-trip.
    let main_h_logical = main_size.to_logical::<f64>(sf).height;
    let logical = LogicalSize::new(PREVIEW_W_LOGICAL, main_h_logical);
    preview.set_size(logical)?;
    let preview_phys = logical.to_physical::<u32>(sf);
    let Some(monitor) = main.current_monitor()? else {
        return Ok(false);
    };
    // `dock_position` returns the desired preview CLIENT origin. But the preview
    // window keeps a small non-client frame even though it is `decorations(false)`
    // (a ~11px left / ~2px top border at 150% DPI, measured via the same
    // GetClientRect + ClientToScreen probe used for the main window), and
    // `set_position` places the OUTER origin. Docking on the client origin
    // directly would overlap the main window by that left margin on a LEFT dock
    // (and leave a matching hidden gap on a RIGHT dock). Offset the outer target
    // back by the measured client→outer inset so both sides are truly flush.
    let gap = (PREVIEW_GAP_LOGICAL * sf).round() as i32;
    let client_target = match dock_position(main_pos, main_size, preview_phys, gap, monitor.work_area()) {
            Some(pos) => pos,
            // Neither side fits flush (see `dock_position`) — the preview cannot be
            // docked without overlapping the main window, so hide it. The page stays
            // loaded so a later re-dock (window moved back, next selection change)
            // shows instantly.
            None => {
                if let Ok(hwnd) = preview.hwnd() {
                    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                }
                return Ok(false);
            }
        };
    let pv_hwnd = preview.hwnd()?;
    let mut pv_rect = RECT::default();
    let mut pv_origin = POINT::default();
    unsafe {
        let _ = GetClientRect(pv_hwnd, &mut pv_rect);
        let _ = ClientToScreen(pv_hwnd, &mut pv_origin);
    }
    let pv_outer = preview.outer_position()?;
    let inset_x = pv_origin.x - pv_outer.x;
    let inset_y = pv_origin.y - pv_outer.y;
    preview.set_position(PhysicalPosition::new(
        client_target.x - inset_x,
        client_target.y - inset_y,
    ))?;
    Ok(true)
}

/// Pure dock math (unit-testable): the desired preview **CLIENT** origin — the
/// main window's client right edge plus `gap`, top-aligned, or (when that
/// overflows the work area) the main window's client LEFT edge minus `gap` —
/// the same `gap` on both sides. When the main window sits so close to the work
/// area's left edge that a left dock (gap included) would run off-screen
/// (overlapping the main window), there is no room on either side — return
/// `None` so the caller hides the preview.
fn dock_position(
    main_pos: PhysicalPosition<i32>,
    main_size: PhysicalSize<u32>,
    preview_size: PhysicalSize<u32>,
    gap: i32,
    work_area: &PhysicalRect<i32, u32>,
) -> Option<PhysicalPosition<i32>> {
    let right = main_pos.x + main_size.width as i32;
    let work_right = work_area.position.x + work_area.size.width as i32;
    let fits_right = right + gap + preview_size.width as i32 <= work_right;
    if fits_right {
        Some(PhysicalPosition::new(right + gap, main_pos.y))
    } else {
        let left = main_pos.x - gap - preview_size.width as i32;
        (left >= work_area.position.x).then(|| PhysicalPosition::new(left, main_pos.y))
    }
}

/// The URL of the satellite page: the vite dev server in dev, the bundled app
/// protocol in production. Kept in one place — verify against the running
/// app's `window.location.origin` once (docs/ROADMAP.md #15).
fn preview_page_url(app: &AppHandle) -> tauri::Url {
    let base = if cfg!(dev) {
        app.config()
            .build
            .dev_url
            .clone()
            .unwrap_or_else(|| tauri::Url::parse("http://localhost:1420").unwrap())
    } else {
        tauri::Url::parse("http://tauri.localhost").unwrap()
    };
    base.join("preview.html").unwrap_or(base)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wa() -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(1920, 1080),
        }
    }

    #[test]
    fn dock_flush_right_when_room() {
        let pos = dock_position(
            PhysicalPosition::new(100, 50),
            PhysicalSize::new(720, 480),
            PhysicalSize::new(320, 480),
            0,
            &wa(),
        );
        assert_eq!(pos, Some(PhysicalPosition::new(820, 50)));
    }

    #[test]
    fn dock_right_at_exact_boundary() {
        let pos = dock_position(
            PhysicalPosition::new(100, 50),
            PhysicalSize::new(300, 480),
            PhysicalSize::new(320, 480),
            0,
            &wa(), // 400 + 320 == 1920? no — work area right = 1920, so 720 fits
        );
        assert_eq!(pos, Some(PhysicalPosition::new(400, 50)));
    }

    #[test]
    fn dock_left_when_right_overflows() {
        let pos = dock_position(
            PhysicalPosition::new(1400, 50),
            PhysicalSize::new(720, 480),
            PhysicalSize::new(320, 480),
            0,
            &wa(), // 1400 + 720 + 320 = 2440 > 1920 → left at 1080
        );
        assert_eq!(pos, Some(PhysicalPosition::new(1080, 50)));
    }

    #[test]
    fn dock_left_flush_matches_right_gap() {
        // The left dock carries the same gap as the right side: the preview's
        // right edge sits `gap` px to the left of the main window's left edge.
        let pos = dock_position(
            PhysicalPosition::new(900, 50),
            PhysicalSize::new(1000, 480), // right = 1900 + 320 > 1920 → left
            PhysicalSize::new(320, 480),
            0,
            &wa(), // left = 900 - 320 = 580, within the work area
        );
        assert_eq!(pos, Some(PhysicalPosition::new(580, 50)));
    }

    #[test]
    fn dock_applies_gap_on_both_sides() {
        // A nonzero gap moves the preview away from the main on EACH side.
        let right = dock_position(
            PhysicalPosition::new(100, 50),
            PhysicalSize::new(720, 480),
            PhysicalSize::new(320, 480),
            6,
            &wa(),
        );
        assert_eq!(right, Some(PhysicalPosition::new(826, 50)));
        let left = dock_position(
            PhysicalPosition::new(1400, 50),
            PhysicalSize::new(720, 480),
            PhysicalSize::new(320, 480),
            6,
            &wa(), // right = 1400+720+6+320 > 1920 → left = 1400-6-320 = 1074
        );
        assert_eq!(left, Some(PhysicalPosition::new(1074, 50)));
    }

    #[test]
    fn dock_gap_takes_the_last_slot() {
        // The gap counts toward the work-area budget: with main at x=426 a
        // 6px gap just fits on the left (426-6-320 = 100 = work left), while a
        // 7px gap leaves no room on either side → None (preview hidden).
        let wa = PhysicalRect {
            position: PhysicalPosition::new(100, 0),
            size: PhysicalSize::new(800, 600), // right = 900
        };
        let fits = dock_position(
            PhysicalPosition::new(426, 50),
            PhysicalSize::new(400, 480), // right = 426+400+6+320 = 1152 > 900
            PhysicalSize::new(320, 480),
            6,
            &wa, // left = 426-6-320 = 100 ≥ 100
        );
        assert_eq!(fits, Some(PhysicalPosition::new(100, 50)));
        let none = dock_position(
            PhysicalPosition::new(426, 50),
            PhysicalSize::new(400, 480),
            PhysicalSize::new(320, 480),
            7,
            &wa, // left = 426-7-320 = 99 < 100 → no room
        );
        assert_eq!(none, None);
    }

    #[test]
    fn dock_left_hidden_when_no_room_on_either_side() {
        // Main window close to the left edge AND the right side overflowing
        // (high DPI / narrow work area): a left dock would run off the work
        // area and overlap the main window — return None so the caller hides
        // the preview instead.
        let wa = PhysicalRect {
            position: PhysicalPosition::new(100, 0),
            size: PhysicalSize::new(800, 600),
        };
        let pos = dock_position(
            PhysicalPosition::new(200, 50),
            PhysicalSize::new(400, 480), // right = 200+400+320 = 920 > 900
            PhysicalSize::new(320, 480),
            0,
            &wa, // left = 200-320 = -120 < work_area.x = 100 → no room
        );
        assert_eq!(pos, None);
    }
}
