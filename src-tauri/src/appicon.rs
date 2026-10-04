//! Theme-aware application icon (docs/ROADMAP.md #31).
//!
//! The icon pair in `res/icons/` replaces the retired `software.png` artwork:
//! `application_dark_mode.png` (white artwork) shows on the dark theme and
//! `application_white_mode.png` (black artwork) on the light theme. Applied at
//! runtime to every window's taskbar icon and the system tray icon, following
//! the same resolved color mode as the DWM frame strip
//! (`window::panel_surface_rgb`) — so icon, frame strip and panel never
//! disagree. The static exe/Explorer icon cannot follow the theme; it comes
//! from the bundle `icon.ico`, regenerated from the light variant.
//!
//! Windows note: tauri's `set_icon` only feeds ICON_SMALL (title-bar icon),
//! which a frameless window never shows — the taskbar / Alt-Tab icon is
//! ICON_BIG, and nothing set it (the shell fell back to the exe's embedded
//! icon). Both sizes are set here via `WM_SETICON` with an HICON built from
//! the same decoded RGBA the tray uses.

use std::sync::OnceLock;

use tauri::{image::Image, AppHandle, Manager, Runtime, WebviewWindow};
use windows::Win32::Foundation::{LPARAM, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateIcon, SendMessageW, HICON, ICON_BIG, ICON_SMALL, WM_SETICON,
};

use crate::tray;

const DARK_MODE_PNG: &[u8] = include_bytes!("../../res/icons/application_dark_mode.png");
const WHITE_MODE_PNG: &[u8] = include_bytes!("../../res/icons/application_white_mode.png");

/// Rendered size for the runtime icons — the bundle icon.ico's top layer is
/// 256×256; the shell scales it down to the tray / taskbar / Alt-Tab sizes.
const ICON_PX: u32 = 256;

static DARK_ICON: OnceLock<Option<Image<'static>>> = OnceLock::new();
static LIGHT_ICON: OnceLock<Option<Image<'static>>> = OnceLock::new();

/// Decode and downscale one of the embedded PNGs (once per theme, cached).
fn themed_icon(dark: bool) -> Option<Image<'static>> {
    let slot = if dark { &DARK_ICON } else { &LIGHT_ICON };
    slot.get_or_init(|| {
        let png = if dark { DARK_MODE_PNG } else { WHITE_MODE_PNG };
        let img = image::load_from_memory(png)
            .ok()?
            .resize_exact(ICON_PX, ICON_PX, image::imageops::FilterType::Lanczos3);
        Some(Image::new_owned(
            img.into_rgba8().into_raw(),
            ICON_PX,
            ICON_PX,
        ))
    })
    .clone()
}

/// `HICON` is a raw pointer, but the two icons are process-lifetime constants
/// (never destroyed — the windows keep using the handle), so sharing them
/// across threads is sound.
#[derive(Clone, Copy)]
struct SendHicon(HICON);
unsafe impl Send for SendHicon {}
unsafe impl Sync for SendHicon {}

static DARK_HICON: OnceLock<Option<SendHicon>> = OnceLock::new();
static LIGHT_HICON: OnceLock<Option<SendHicon>> = OnceLock::new();

/// Build the WM_SETICON HICON from the decoded RGBA (once per theme, cached).
fn themed_hicon(dark: bool) -> Option<HICON> {
    let slot = if dark { &DARK_HICON } else { &LIGHT_HICON };
    slot.get_or_init(|| {
        let img = themed_icon(dark)?;
        // BGRA pixel order + inverted-alpha AND mask — the format CreateIcon
        // expects (mirrors tray-icon's RGBA → HICON conversion).
        let mut xor: Vec<u8> = img.rgba().to_vec();
        for px in xor.chunks_exact_mut(4) {
            px.swap(0, 2);
        }
        let and: Vec<u8> = img
            .rgba()
            .chunks_exact(4)
            .map(|px| 255u8.wrapping_sub(px[3]))
            .collect();
        unsafe {
            CreateIcon(
                None,
                img.width() as i32,
                img.height() as i32,
                1,
                32,
                and.as_ptr(),
                xor.as_ptr(),
            )
        }
        .ok()
        .map(SendHicon)
    })
    .as_ref()
    .map(|h| h.0)
}

/// Whether the effective color mode is dark — an explicit dark/light setting
/// wins, otherwise the OS theme the main window reports (the same rule as
/// `window::panel_surface_rgb`, so icon and frame strip never disagree).
fn is_dark(app: &AppHandle<impl Runtime>, color_mode: &str) -> bool {
    match color_mode {
        "light" => false,
        "dark" => true,
        _ => app
            .get_webview_window("main")
            .and_then(|w| w.theme().ok())
            .map(|t| t == tauri::Theme::Dark)
            .unwrap_or(true),
    }
}

/// Apply the theme-matched icon everywhere: all windows (main, settings,
/// preview — detached plugin windows are covered at their creation) and the
/// tray icon. Call sites: startup, settings save/apply and the OS theme flip
/// in system mode (lib.rs `WindowEvent::ThemeChanged`).
pub fn apply(app: &AppHandle<impl Runtime>, color_mode: &str) {
    let dark = is_dark(app, color_mode);
    for label in ["main", "settings", "preview"] {
        if let Some(win) = app.get_webview_window(label) {
            set_window_icon(&win, dark);
        }
    }
    match (themed_icon(dark), app.tray_by_id(tray::TRAY_ID)) {
        (Some(icon), Some(tray)) => {
            if let Err(e) = tray.set_icon(Some(icon)) {
                eprintln!("[appicon] failed to set tray icon: {e}");
            }
        }
        (None, _) => eprintln!("[appicon] failed to decode the embedded theme icons"),
        _ => {}
    }
}

/// Apply the theme-matched icon to one window (detached plugin windows are
/// created after startup, so `apply` misses them).
pub fn apply_window<R: Runtime>(win: &WebviewWindow<R>, color_mode: &str) {
    set_window_icon(win, is_dark(win.app_handle(), color_mode));
}

/// Set both icon slots (ICON_BIG = taskbar / Alt-Tab, ICON_SMALL = title bar)
/// on one window from the theme HICON.
fn set_window_icon<R: Runtime>(win: &WebviewWindow<R>, dark: bool) {
    let (Ok(hwnd), Some(hicon)) = (win.hwnd(), themed_hicon(dark)) else {
        return;
    };
    unsafe {
        let _ = SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_BIG as usize)),
            Some(LPARAM(hicon.0 as isize)),
        );
        let _ = SendMessageW(
            hwnd,
            WM_SETICON,
            Some(WPARAM(ICON_SMALL as usize)),
            Some(LPARAM(hicon.0 as isize)),
        );
    }
}
