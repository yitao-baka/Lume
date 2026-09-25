//! Plugin host capabilities: file dialogs and screen geometry (P1.4 / P1.5 of
//! docs/PLUGIN_GAP_ANALYSIS.md).
//!
//! Two small surfaces that plugins otherwise cannot reach from the webview:
//!
//! - **Dialogs** — the native open/save pickers. They go through
//!   `tauri-plugin-dialog` (already a dependency; the settings window uses its
//!   JS side), driven from the Rust side so the launcher window's capability
//!   set does not grow: a plugin cannot pop a dialog on its own, only through
//!   this command. Blocking pickers are called on a worker thread (the plugin
//!   itself dispatches to the main thread).
//! - **Screen** — cursor position and the monitor list (physical pixels), for
//!   plugins that position their own windows or react to where the user is.
//!
//! Permissions: `dialog` and `screen` (manifest-declared; enforcement is P3.2,
//! these are the documented ledger entries).

use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use windows::core::BOOL;
use windows::Win32::Foundation::{LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, MONITORINFOF_PRIMARY};

// ── Dialogs ──

/// A file-type filter for the native pickers: display name + extensions
/// (without dots). An empty extension list means "all files".
#[derive(serde::Deserialize)]
pub struct DialogFilter {
    pub name: String,
    #[serde(default)]
    pub extensions: Vec<String>,
}

#[derive(serde::Deserialize)]
pub struct OpenDialogParams {
    pub title: Option<String>,
    /// Directory the picker opens in.
    pub default_path: Option<String>,
    /// Pre-filled file name (save dialog / convenience for open).
    pub file_name: Option<String>,
    pub filters: Option<Vec<DialogFilter>>,
    /// Allow selecting several files (default false = one).
    #[serde(default)]
    pub multiple: bool,
    /// Pick directories instead of files.
    #[serde(default)]
    pub folder: bool,
}

#[derive(serde::Deserialize)]
pub struct SaveDialogParams {
    pub title: Option<String>,
    pub default_path: Option<String>,
    pub file_name: Option<String>,
    pub filters: Option<Vec<DialogFilter>>,
}

/// Configure a dialog builder from the shared option shape.
fn build_dialog(
    app: &AppHandle,
    title: Option<String>,
    default_path: Option<String>,
    file_name: Option<String>,
    filters: Option<Vec<DialogFilter>>,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().file();
    if let Some(t) = title {
        b = b.set_title(t);
    }
    if let Some(p) = default_path {
        b = b.set_directory(PathBuf::from(p));
    }
    if let Some(n) = file_name {
        b = b.set_file_name(n);
    }
    for f in filters.unwrap_or_default() {
        let exts: Vec<&str> = f.extensions.iter().map(String::as_str).collect();
        b = b.add_filter(f.name, &exts);
    }
    b
}

/// Native open picker. Returns the chosen absolute paths (empty when the user
/// cancelled — cancellation is not an error, the plugin decides what to say).
/// Permission: `dialog` — enforced Rust-side (plugin_perm.rs).
#[tauri::command]
pub async fn plugin_dialog_open(
    app: AppHandle,
    params: OpenDialogParams,
    plugin_id: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<Vec<String>, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        "dialog",
    )?;
    let started = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let b = build_dialog(&app, params.title, params.default_path, params.file_name, params.filters);
        let picked: Vec<FilePath> = if params.folder {
            if params.multiple {
                b.blocking_pick_folders().unwrap_or_default()
            } else {
                b.blocking_pick_folder().into_iter().collect()
            }
        } else if params.multiple {
            b.blocking_pick_files().unwrap_or_default()
        } else {
            b.blocking_pick_file().into_iter().collect()
        };
        picked
            .into_iter()
            .filter_map(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
            .collect::<Vec<String>>()
    })
    .await
    .map_err(|e| format!("dialog worker panicked: {e}"))?;
    eprintln!(
        "[plugins] dialog.open → {} path(s) ({}ms)",
        out.len(),
        started.elapsed().as_millis()
    );
    Ok(out)
}

/// Native save picker. Returns the chosen path, or null when cancelled.
/// Permission: `dialog` — enforced Rust-side (plugin_perm.rs).
#[tauri::command]
pub async fn plugin_dialog_save(
    app: AppHandle,
    params: SaveDialogParams,
    plugin_id: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<Option<String>, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        "dialog",
    )?;
    let started = std::time::Instant::now();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let b = build_dialog(&app, params.title, params.default_path, params.file_name, params.filters);
        b.blocking_save_file()
            .and_then(|f| f.into_path().ok())
            .map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("dialog worker panicked: {e}"))?;
    eprintln!(
        "[plugins] dialog.save → {:?} ({}ms)",
        out,
        started.elapsed().as_millis()
    );
    Ok(out)
}

// ── Screen ──

/// One monitor, in **physical** pixels (the same space as `cursor()`).
#[derive(serde::Serialize, Clone, Copy, Debug)]
pub struct DisplayInfo {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// Work area (the monitor minus the taskbar).
    pub work_x: i32,
    pub work_y: i32,
    pub work_width: i32,
    pub work_height: i32,
    pub primary: bool,
}

/// Cursor position in physical screen pixels.
#[derive(serde::Serialize, Clone, Copy, Debug)]
pub struct CursorPos {
    pub x: i32,
    pub y: i32,
}

/// Cursor position in physical screen pixels.
/// Permission: `screen` — enforced Rust-side (plugin_perm.rs).
#[tauri::command]
pub fn plugin_cursor_pos(
    plugin_id: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
    settings: tauri::State<crate::settings::SettingsState>,
) -> Result<CursorPos, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        "screen",
    )?;
    cursor_impl()
}

fn cursor_impl() -> Result<CursorPos, String> {
    let mut pt = Default::default();
    if unsafe { GetCursorPos(&mut pt) }.is_err() {
        return Err("GetCursorPos failed".into());
    }
    Ok(CursorPos { x: pt.x, y: pt.y })
}

/// Every monitor, physical pixels, in the shell's enumeration order.
/// Permission: `screen` — enforced Rust-side (plugin_perm.rs).
#[tauri::command]
pub fn plugin_displays(
    plugin_id: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
    settings: tauri::State<crate::settings::SettingsState>,
) -> Result<Vec<DisplayInfo>, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        "screen",
    )?;
    displays_impl()
}

fn displays_impl() -> Result<Vec<DisplayInfo>, String> {
    let mut out: Vec<DisplayInfo> = Vec::new();
    let ptr = &mut out as *mut Vec<DisplayInfo> as isize;
    let ok = unsafe { EnumDisplayMonitors(None, None, Some(enum_monitor), LPARAM(ptr)) };
    if !ok.as_bool() && out.is_empty() {
        return Err("EnumDisplayMonitors failed".into());
    }
    Ok(out)
}

unsafe extern "system" fn enum_monitor(
    hmonitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    let out = unsafe { &mut *(data.0 as *mut Vec<DisplayInfo>) };
    let mut mi = MONITORINFOEXW::default();
    mi.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
    if unsafe {
        GetMonitorInfoW(
            hmonitor,
            &mut mi.monitorInfo as *mut MONITORINFO as *mut _,
        )
    }
    .as_bool()
    {
        let m = &mi.monitorInfo;
        out.push(DisplayInfo {
            x: m.rcMonitor.left,
            y: m.rcMonitor.top,
            width: m.rcMonitor.right - m.rcMonitor.left,
            height: m.rcMonitor.bottom - m.rcMonitor.top,
            work_x: m.rcWork.left,
            work_y: m.rcWork.top,
            work_width: m.rcWork.right - m.rcWork.left,
            work_height: m.rcWork.bottom - m.rcWork.top,
            primary: m.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    TRUE
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displays_include_a_primary_monitor() {
        let displays = displays_impl().expect("enumeration should succeed");
        assert!(!displays.is_empty(), "at least one monitor");
        assert_eq!(
            displays.iter().filter(|d| d.primary).count(),
            1,
            "exactly one primary monitor"
        );
        for d in &displays {
            assert!(d.width > 0 && d.height > 0, "monitor must have an area: {d:?}");
            assert!(
                d.work_width > 0 && d.work_width <= d.width,
                "work area fits the monitor: {d:?}"
            );
        }
    }

    #[test]
    fn cursor_is_inside_some_monitor() {
        let pos = cursor_impl().expect("cursor position");
        let displays = displays_impl().unwrap();
        let inside = displays.iter().any(|d| {
            pos.x >= d.x && pos.x < d.x + d.width && pos.y >= d.y && pos.y < d.y + d.height
        });
        assert!(inside, "cursor {pos:?} should be on a monitor {displays:?}");
    }
}
