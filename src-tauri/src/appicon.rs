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
//!
//! P6.8 (ROADMAP #34): a detached plugin window gets its own taskbar icon —
//! the plugin's manifest `icon`, rasterized by the launcher's webview at
//! detach time (this crate has no SVG decoder; `image` is PNG-only) and
//! uploaded through `plugin_window_open`. Icon-less plugins keep the Lume
//! theme icon; the separate taskbar identity (AppUserModelID) is set in
//! `plugin_window.rs`.
//!
//! Themed variants (ROADMAP #44): a plugin declaring `icon_light`/`icon_dark`
//! uploads BOTH rasterized variants; the pick is rendered as-is (no
//! inversion), so the artwork is exactly what the author shipped. Only the
//! legacy single-icon upload keeps the historical dark-mode inversion (the
//! same treatment as the launcher's `--icon-filter` on in-app pills) —
//! existing plugins render unchanged.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

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
        hicon_from_rgba(img.width(), img.height(), img.rgba())
    })
    .as_ref()
    .map(|h| h.0)
}

/// Build an HICON from raw RGBA: BGRA pixel order + inverted-alpha AND mask
/// — the format `CreateIcon` expects (mirrors tray-icon's RGBA → HICON
/// conversion). Shared by the theme icons and the per-plugin icons (P6.8).
fn hicon_from_rgba(width: u32, height: u32, rgba: &[u8]) -> Option<SendHicon> {
    let mut xor: Vec<u8> = rgba.to_vec();
    for px in xor.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let and: Vec<u8> = rgba
        .chunks_exact(4)
        .map(|px| 255u8.wrapping_sub(px[3]))
        .collect();
    unsafe {
        CreateIcon(
            None,
            width as i32,
            height as i32,
            1,
            32,
            and.as_ptr(),
            xor.as_ptr(),
        )
    }
    .ok()
    .map(SendHicon)
}

/// Per-plugin taskbar icons for detached windows (P6.8, ROADMAP #34; themed
/// variants ROADMAP #44): the RGBA the launcher rasterized at detach, plus
/// the built HICONs — one per theme, so a theme flip rebuilds without
/// another round trip.
#[derive(Default)]
pub struct PluginIcons(Mutex<PluginIconStore>);

/// One uploaded icon set for a plugin (see `PluginIcons::remember`).
#[derive(Default)]
struct PluginIconRecord {
    /// Explicit light-theme variant (themed uploads only).
    light: Option<(u32, u32, Vec<u8>)>,
    /// Explicit dark-theme variant (themed uploads only).
    dark: Option<(u32, u32, Vec<u8>)>,
    /// true = light/dark are explicit variants, rendered as-is and never
    /// inverted; false = a legacy single upload that dark mode inverts.
    themed: bool,
}

#[derive(Default)]
struct PluginIconStore {
    rgba: HashMap<String, PluginIconRecord>,
    hicons: HashMap<(String, bool), SendHicon>,
}

impl PluginIcons {
    /// Decode the uploaded base64 PNG(s) and remember them for `id` (the
    /// cached HICONs are dropped so the next apply rebuilds them).
    /// `themed` marks an explicit pair: `light_png`/`dark_png` are then the
    /// two variants; otherwise `light_png` is the legacy single icon that
    /// dark mode inverts. Failures are logged and ignored — the window keeps
    /// the Lume theme icon (or the other variant when one decoded).
    pub fn remember(
        &self,
        id: &str,
        light_png: Option<&str>,
        dark_png: Option<&str>,
        themed: bool,
    ) {
        let light = light_png.and_then(|png| decode_plugin_png(id, png));
        let dark = if themed {
            dark_png.and_then(|png| decode_plugin_png(id, png))
        } else {
            None
        };
        if light.is_none() && dark.is_none() {
            return; // nothing decodable — keep whatever was remembered before
        }
        let mut store = self.0.lock().unwrap();
        store.rgba.insert(
            id.to_string(),
            PluginIconRecord {
                light,
                dark,
                themed,
            },
        );
        store.hicons.remove(&(id.to_string(), true));
        store.hicons.remove(&(id.to_string(), false));
    }

    /// The theme HICON for `id`, built on first use; None when this plugin
    /// never uploaded a decodable icon.
    fn hicon(&self, id: &str, dark: bool) -> Option<HICON> {
        let mut store = self.0.lock().unwrap();
        if let Some(icon) = store.hicons.get(&(id.to_string(), dark)) {
            return Some(icon.0);
        }
        let (width, height, pixels) = {
            let record = store.rgba.get(id)?;
            pixels_for(record, dark)?
        };
        let icon = hicon_from_rgba(width, height, &pixels)?;
        let handle = icon.0;
        store.hicons.insert((id.to_string(), dark), icon);
        Some(handle)
    }
}

/// Decode one uploaded base64 PNG into RGBA, resized to `ICON_PX`.
fn decode_plugin_png(id: &str, png_base64: &str) -> Option<(u32, u32, Vec<u8>)> {
    use base64::Engine as _;
    let bytes = match base64::engine::general_purpose::STANDARD.decode(png_base64) {
        Ok(bytes) => bytes,
        Err(e) => {
            eprintln!("[appicon] plugin \"{id}\" icon: bad base64 ({e})");
            return None;
        }
    };
    match image::load_from_memory(&bytes) {
        Ok(img) => {
            let img = img
                .resize_exact(ICON_PX, ICON_PX, image::imageops::FilterType::Lanczos3)
                .into_rgba8();
            Some((ICON_PX, ICON_PX, img.into_raw()))
        }
        Err(e) => {
            eprintln!("[appicon] plugin \"{id}\" icon: decode failed ({e})");
            None
        }
    }
}

/// Pick the RGBA pixels for one theme from an uploaded set: explicit
/// variants are used as-is (falling back to the other variant when one is
/// missing); the legacy single icon is inverted in dark mode. Pure, so the
/// selection is unit tested.
fn pixels_for(record: &PluginIconRecord, dark: bool) -> Option<(u32, u32, Vec<u8>)> {
    if record.themed {
        let (primary, fallback) = if dark {
            (&record.dark, &record.light)
        } else {
            (&record.light, &record.dark)
        };
        primary.clone().or_else(|| fallback.clone())
    } else {
        record
            .light
            .clone()
            .map(|(w, h, rgba)| (w, h, if dark { invert_rgb(&rgba) } else { rgba }))
    }
}

/// Invert RGB, keep alpha — the same treatment as `--icon-filter: invert(1)`
/// (theme.css) the launcher applies to plugin icons in dark mode.
fn invert_rgb(rgba: &[u8]) -> Vec<u8> {
    rgba.chunks_exact(4)
        .flat_map(|px| [255 - px[0], 255 - px[1], 255 - px[2], px[3]])
        .collect()
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
    // Detached plugin windows (P6.8): re-derive their variant on a theme
    // flip — the plugin's own icon when one was uploaded, the Lume theme
    // icon otherwise (icon-less plugins only got it at creation). Each window
    // uses its plugin's **effective** mode (ROADMAP #36): a plugin pinned to
    // dark keeps the dark variant while the launcher flips to light, exactly
    // like the canvas and chrome of that window.
    let icons = app.state::<PluginIcons>();
    let prefs = app.state::<crate::settings::SettingsState>().current();
    for (label, win) in app.webview_windows() {
        if let Some(id) = label.strip_prefix("plugin-") {
            let plugin_dark = is_dark(
                app,
                prefs
                    .plugins
                    .color_mode_for(id, &prefs.appearance.color_mode),
            );
            match icons.hicon(id, plugin_dark) {
                Some(hicon) => set_hicon(&win, hicon),
                None => set_window_icon(&win, plugin_dark),
            }
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

/// Apply a detached plugin window's OWN icon (`PluginIcons`, P6.8). Returns
/// false when no icon was uploaded for `id` — the caller then falls back to
/// `apply_window` (the Lume theme icon).
pub fn apply_plugin_window<R: Runtime>(
    win: &WebviewWindow<R>,
    icons: &PluginIcons,
    id: &str,
    color_mode: &str,
) -> bool {
    let dark = is_dark(win.app_handle(), color_mode);
    match icons.hicon(id, dark) {
        Some(hicon) => {
            set_hicon(win, hicon);
            true
        }
        None => false,
    }
}

/// Set both icon slots (ICON_BIG = taskbar / Alt-Tab, ICON_SMALL = title bar)
/// on one window from the theme HICON.
fn set_window_icon<R: Runtime>(win: &WebviewWindow<R>, dark: bool) {
    if let Some(hicon) = themed_hicon(dark) {
        set_hicon(win, hicon);
    }
}

/// Set both icon slots on one window — shared by the theme icons and the
/// per-plugin icons (P6.8).
fn set_hicon<R: Runtime>(win: &WebviewWindow<R>, hicon: HICON) {
    let Ok(hwnd) = win.hwnd() else {
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

#[cfg(test)]
mod themed_icon_tests {
    use super::*;

    fn px(r: u8, g: u8, b: u8) -> Vec<u8> {
        vec![r, g, b, 255]
    }

    #[test]
    fn themed_picks_the_exact_variant_without_inversion() {
        let record = PluginIconRecord {
            light: Some((1, 1, px(1, 2, 3))),
            dark: Some((1, 1, px(200, 201, 202))),
            themed: true,
        };
        assert_eq!(pixels_for(&record, false).unwrap().2, px(1, 2, 3));
        assert_eq!(pixels_for(&record, true).unwrap().2, px(200, 201, 202));
    }

    #[test]
    fn themed_falls_back_to_the_other_variant() {
        let dark_only = PluginIconRecord {
            light: None,
            dark: Some((1, 1, px(9, 9, 9))),
            themed: true,
        };
        assert_eq!(pixels_for(&dark_only, false).unwrap().2, px(9, 9, 9));
    }

    #[test]
    fn legacy_still_inverts_on_dark() {
        let legacy = PluginIconRecord {
            light: Some((1, 1, px(10, 20, 30))),
            dark: None,
            themed: false,
        };
        assert_eq!(pixels_for(&legacy, false).unwrap().2, px(10, 20, 30));
        assert_eq!(pixels_for(&legacy, true).unwrap().2, px(245, 235, 225));
    }
}
