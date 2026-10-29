//! Atomic launcher geometry transaction.
//!
//! The renderer owns content measurement, but never commits a raw OS size.
//! It submits a logical client-size request here; this module re-reads the
//! current monitor's work area, clamps the request, resolves the placement
//! anchor, and commits client size + outer position in one `SetWindowPos`.
//!
//! During a show the window is still hidden. `prepare_show` emits a generation
//! and waits for the renderer's matching measurement; only then does
//! `window.rs` reveal the window. A timeout falls back to the last target so a
//! broken renderer cannot make the hotkey unresponsive.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, WebviewWindow,
};
use windows::Win32::Foundation::RECT;
use windows::Win32::UI::WindowsAndMessaging::{
    GetClientRect, GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOZORDER,
};

const MAIN_WINDOW: &str = "main";
const MIN_W: f64 = 240.0;
const MIN_H: f64 = 60.0;
const SHOW_PREPARE_TIMEOUT: Duration = Duration::from_millis(700);

#[derive(Default)]
pub struct GeometryState {
    inner: Mutex<GeometryInner>,
}

#[derive(Default)]
struct GeometryInner {
    generation: u64,
    target: Option<LauncherGeometry>,
    prepared: Option<u64>,
    /// The renderer registered its show listener. Before this flips, a hotkey
    /// uses the stored target immediately; it must not wait for an event the
    /// page cannot receive.
    renderer_ready: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct LauncherGeometry {
    width: f64,
    height: f64,
    expanded: bool,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherGeometryRequest {
    width: f64,
    height: f64,
    #[serde(default)]
    pub expanded: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct LauncherGeometryResponse {
    width: f64,
    height: f64,
}

/// The one normalized target for the hidden renderer. Width and height are
/// logical client sizes; work-area clamping happens at commit time.
fn normalize(
    request: LauncherGeometryRequest,
    work: &PhysicalRect<i32, u32>,
    scale: f64,
) -> LauncherGeometry {
    let max_w = (work.size.width as f64 / scale).max(MIN_W);
    let max_h = (work.size.height as f64 / scale).max(MIN_H);
    LauncherGeometry {
        width: request.width.clamp(MIN_W, max_w).round(),
        height: request.height.clamp(MIN_H, max_h).round(),
        expanded: request.expanded,
    }
}

fn monitor_work(window: &WebviewWindow) -> tauri::Result<(tauri::Monitor, PhysicalRect<i32, u32>)> {
    let monitor = window
        .current_monitor()?
        .or(window.primary_monitor()?)
        .ok_or_else(|| tauri::Error::Anyhow(std::io::Error::other("no monitor").into()))?;
    let work = *monitor.work_area();
    Ok((monitor, work))
}

fn frame_margins(window: &WebviewWindow) -> tauri::Result<(i32, i32)> {
    let hwnd = window.hwnd().map_err(|e| tauri::Error::Anyhow(e.into()))?;
    let mut outer = RECT::default();
    let mut client = RECT::default();
    unsafe {
        GetWindowRect(hwnd, &mut outer)
            .map_err(|e| tauri::Error::Anyhow(std::io::Error::other(e.to_string()).into()))?;
        GetClientRect(hwnd, &mut client)
            .map_err(|e| tauri::Error::Anyhow(std::io::Error::other(e.to_string()).into()))?;
    }
    Ok((
        (outer.right - outer.left) - (client.right - client.left),
        (outer.bottom - outer.top) - (client.bottom - client.top),
    ))
}

fn corner_position(
    anchor: &str,
    work: &PhysicalRect<i32, u32>,
    w: i32,
    h: i32,
) -> Option<PhysicalPosition<i32>> {
    let left = work.position.x;
    let top = work.position.y;
    let right = (left + work.size.width as i32 - w).max(left);
    let bottom = (top + work.size.height as i32 - h).max(top);
    match anchor {
        "top-left" => Some(PhysicalPosition::new(left, top)),
        "top-right" => Some(PhysicalPosition::new(right, top)),
        "bottom-left" => Some(PhysicalPosition::new(left, bottom)),
        "bottom-right" => Some(PhysicalPosition::new(right, bottom)),
        _ => None,
    }
}

fn center_position(work: &PhysicalRect<i32, u32>, w: i32, h: i32) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        work.position.x + (work.size.width as i32 - w).max(0) / 2,
        work.position.y + (work.size.height as i32 - h).max(0) / 2,
    )
}

fn mouse_position(window: &WebviewWindow, w: i32, h: i32) -> tauri::Result<PhysicalPosition<i32>> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    let got = unsafe { GetCursorPos(&mut point) } != 0;
    let monitor = if got {
        window
            .monitor_from_point(point.x as f64, point.y as f64)?
            .or(window.current_monitor()?)
    } else {
        window.current_monitor()?
    };
    let fallback = PhysicalRect {
        position: PhysicalPosition::new(0, 0),
        size: PhysicalSize::new(1920u32, 1080u32),
    };
    let work = match monitor {
        Some(monitor) => *monitor.work_area(),
        None => fallback,
    };
    if !got {
        return Ok(center_position(&work, w, h));
    }
    let min_x = work.position.x;
    let min_y = work.position.y;
    let max_x = (work.position.x + work.size.width as i32 - w).max(min_x);
    let max_y = (work.position.y + work.size.height as i32 - h).max(min_y);
    Ok(PhysicalPosition::new(
        (point.x - w / 2).clamp(min_x, max_x),
        (point.y - h / 2).clamp(min_y, max_y),
    ))
}

/// Resolve and commit one geometry. `preserve_spot` is the placement policy
/// decision from `window.rs` (manual spot / 记住位置). When false the preset
/// anchor is recomputed for the final outer size, so a center/corner move and
/// resize land in the same frame.
fn commit(
    window: &WebviewWindow,
    appearance: &crate::settings::Appearance,
    request: LauncherGeometryRequest,
    preserve_spot: bool,
) -> tauri::Result<LauncherGeometry> {
    let scale = window.scale_factor()?;
    let (_monitor, work) = monitor_work(window)?;
    let target = normalize(request, &work, scale);
    let client_w = (target.width * scale).round() as u32;
    let client_h = (target.height * scale).round() as u32;
    let (extra_w, extra_h) = frame_margins(window)?;
    let outer_w = (client_w as i32 + extra_w).max(1);
    let outer_h = (client_h as i32 + extra_h).max(1);

    let position = if appearance.window_position == "follow-mouse" && !preserve_spot {
        mouse_position(window, outer_w, outer_h)?
    } else if preserve_spot {
        let current = window
            .outer_position()
            .unwrap_or(PhysicalPosition::new(work.position.x, work.position.y));
        let max_x = (work.position.x + work.size.width as i32 - outer_w).max(work.position.x);
        let max_y = (work.position.y + work.size.height as i32 - outer_h).max(work.position.y);
        PhysicalPosition::new(
            current.x.clamp(work.position.x, max_x),
            current.y.clamp(work.position.y, max_y),
        )
    } else if let Some(position) =
        corner_position(&appearance.window_position, &work, outer_w, outer_h)
    {
        position
    } else {
        center_position(&work, outer_w, outer_h)
    };

    let hwnd = window.hwnd().map_err(|e| tauri::Error::Anyhow(e.into()))?;
    unsafe {
        SetWindowPos(
            hwnd,
            None,
            position.x,
            position.y,
            outer_w,
            outer_h,
            SWP_NOZORDER | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
        )
    }
    .map_err(|e| tauri::Error::Anyhow(std::io::Error::other(e.to_string()).into()))?;
    if !preserve_spot {
        crate::window::record_geometry_anchor(window);
    }
    Ok(target)
}

fn fallback_target(
    _window: &WebviewWindow,
    appearance: &crate::settings::Appearance,
) -> LauncherGeometry {
    LauncherGeometry {
        width: appearance.window_width as f64,
        height: appearance.window_height as f64,
        expanded: false,
    }
}

/// Show-path geometry: use the renderer's prepared target, otherwise the
/// configured initial target (never the previous page's HWND height).
pub fn apply_show_geometry(
    window: &WebviewWindow,
    appearance: &crate::settings::Appearance,
) -> Result<(), String> {
    let state = window.app_handle().state::<GeometryState>();
    let target = state
        .inner
        .lock()
        .unwrap()
        .target
        .unwrap_or_else(|| fallback_target(window, appearance));
    let preserve = crate::window::preserve_manual_spot(window, appearance);
    commit(
        window,
        appearance,
        LauncherGeometryRequest {
            width: target.width,
            height: target.height,
            expanded: target.expanded,
        },
        preserve,
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Apply the current target without a new measurement (legacy compatibility
/// hook). The only geometry write is still the atomic transaction.
pub fn apply_stored_geometry(
    window: &WebviewWindow,
    appearance: &crate::settings::Appearance,
) -> Result<(), String> {
    apply_show_geometry(window, appearance)
}

/// Settings Save/Apply. Width is a live geometry change; height stays at the
/// page's current measured size until the renderer submits its next target.
pub fn apply_settings(
    window: &WebviewWindow,
    appearance: &crate::settings::Appearance,
    preserve_spot: bool,
) -> Result<(), String> {
    let work = monitor_work(window)
        .map(|(_, w)| w)
        .map_err(|e| e.to_string())?;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let current_h = window
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale)
        .height;
    let target = normalize(
        LauncherGeometryRequest {
            width: appearance.window_width as f64,
            height: current_h,
            expanded: false,
        },
        &work,
        scale,
    );
    window
        .app_handle()
        .state::<GeometryState>()
        .inner
        .lock()
        .unwrap()
        .target = Some(target);
    if window.is_visible().map_err(|e| e.to_string())? {
        commit(
            window,
            appearance,
            LauncherGeometryRequest {
                width: target.width,
                height: target.height,
                expanded: target.expanded,
            },
            preserve_spot,
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Emit a show-preparation generation and wait for the renderer's matching
/// geometry submission. The polling task is outside the main thread.
pub async fn prepare_show(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle();
    let geometry = app.state::<GeometryState>();
    // A hotkey can arrive while the hidden renderer is still mounting. Wait for
    // its listener instead of revealing the fallback size; a stuck renderer
    // still falls back at the same bounded deadline.
    let ready_deadline = Instant::now() + SHOW_PREPARE_TIMEOUT;
    while !geometry.inner.lock().unwrap().renderer_ready {
        if Instant::now() >= ready_deadline {
            return Ok(());
        }
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(4)))
            .await
            .map_err(|e| tauri::Error::Anyhow(std::io::Error::other(e.to_string()).into()))?;
    }
    let generation = {
        let mut inner = geometry.inner.lock().unwrap();
        inner.generation = inner.generation.wrapping_add(1);
        inner.prepared = None;
        inner.generation
    };
    window
        .emit(
            "launcher-prepare-show",
            serde_json::json!({ "generation": generation }),
        )
        .map_err(|e| tauri::Error::Anyhow(std::io::Error::other(e.to_string()).into()))?;
    let deadline = Instant::now() + SHOW_PREPARE_TIMEOUT;
    while Instant::now() < deadline {
        if geometry.inner.lock().unwrap().prepared == Some(generation) {
            return Ok(());
        }
        tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(4)))
            .await
            .map_err(|e| tauri::Error::Anyhow(std::io::Error::other(e.to_string()).into()))?;
    }
    Ok(())
}

/// The renderer's listeners are installed. Any show after this point can use
/// the hidden preparation handshake.
#[tauri::command]
pub fn launcher_renderer_ready(app: AppHandle) -> Result<(), String> {
    app.state::<GeometryState>()
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .renderer_ready = true;
    Ok(())
}

/// Geometry state for the CDP regression probe. This is read-only diagnostics:
/// it lets a failed hotkey test distinguish "never prepared" from "failed reveal".
#[tauri::command]
pub fn launcher_geometry_diagnostics(app: AppHandle) -> Result<serde_json::Value, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    let state = app.state::<GeometryState>();
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    Ok(serde_json::json!({
        "rendererReady": inner.renderer_ready,
        "generation": inner.generation,
        "prepared": inner.prepared,
        "target": inner.target.map(|t| serde_json::json!({
            "width": t.width, "height": t.height, "expanded": t.expanded
        })),
        "visible": window.is_visible().map_err(|e| e.to_string())?,
        "outer": window.outer_position().map(|p| serde_json::json!({"x": p.x, "y": p.y})).ok(),
        "inner": window.inner_size().map(|s| serde_json::json!({"width": s.width, "height": s.height})).ok(),
    }))
}

/// Renderer-confirmed geometry command. While hidden it records the target and
/// releases the show handshake; when visible it commits size + anchor at once.
#[tauri::command]
pub fn apply_launcher_geometry(
    app: AppHandle,
    request: LauncherGeometryRequest,
    generation: Option<u64>,
) -> Result<LauncherGeometryResponse, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    let appearance = app
        .state::<crate::settings::SettingsState>()
        .current()
        .appearance;
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let work = monitor_work(&window)
        .map(|(_, w)| w)
        .map_err(|e| e.to_string())?;
    let target = normalize(request, &work, scale);
    let visible = window.is_visible().map_err(|e| e.to_string())?;
    let state = app.state::<GeometryState>();
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        if let Some(generation) = generation {
            if generation != inner.generation {
                return Err(format!("stale launcher geometry generation {generation}"));
            }
        }
        inner.target = Some(target);
        if !visible {
            if let Some(generation) = generation {
                inner.prepared = Some(generation);
            }
            return Ok(LauncherGeometryResponse {
                width: target.width,
                height: target.height,
            });
        }
    }
    let preserve = crate::window::preserve_manual_spot(&window, &appearance);
    let applied = commit(
        &window,
        &appearance,
        LauncherGeometryRequest {
            width: target.width,
            height: target.height,
            expanded: target.expanded,
        },
        preserve,
    )
    .map_err(|e| e.to_string())?;
    Ok(LauncherGeometryResponse {
        width: applied.width,
        height: applied.height,
    })
}

/// Keep the native canvas on the same opaque surface as the launcher panel.
/// This is the pre-paint/compositor fallback on a non-transparent window.
pub fn set_panel_background(win: &WebviewWindow, skin: &str, color_mode: &str) {
    let (r, g, b) = crate::window::panel_surface_rgb(win, skin, color_mode);
    let _ = win.set_background_color(Some(tauri::window::Color(r, g, b, 255)));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn work() -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(100, 40),
            size: PhysicalSize::new(1600, 900),
        }
    }

    #[test]
    fn normalization_uses_work_area_and_shared_floor() {
        let got = normalize(
            LauncherGeometryRequest {
                width: 9999.0,
                height: 1.0,
                expanded: false,
            },
            &work(),
            1.0,
        );
        assert_eq!(got.width, 1600.0);
        assert_eq!(got.height, MIN_H);
    }

    #[test]
    fn corners_are_work_area_corners_not_monitor_corners() {
        let got = corner_position("bottom-right", &work(), 735, 286).unwrap();
        assert_eq!(got, PhysicalPosition::new(965, 654));
    }

    #[test]
    fn center_uses_work_area_origin() {
        let got = center_position(&work(), 800, 460);
        assert_eq!(got, PhysicalPosition::new(500, 260));
    }
}
