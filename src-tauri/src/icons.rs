//! Real application icons, extracted via the Windows shell.
//!
//! Icons are **not** persisted to SQL (project constraint): they live in an
//! in-memory cache keyed by the `.lnk` path and are reused within the process.
//! Extraction uses `IShellItemImageFactory`, which resolves the shortcut and
//! returns a correctly-sized icon.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::cache;

use windows::core::{HSTRING, Interface};
use windows::Win32::Foundation::SIZE;
use windows::Win32::Graphics::Gdi::{
    GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
    HGDIOBJ, BI_RGB,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT, COINIT_APARTMENTTHREADED, COINIT_MULTITHREADED};
use windows::Win32::UI::Shell::{
    IShellItem, IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF, SIIGBF_ICONONLY,
    SIIGBF_BIGGERSIZEOK, SIIGBF_SCALEUP, SIIGBF_THUMBNAILONLY,
};

/// Icon extraction size (px). 64px stays crisp on HiDPI grids.
const ICON_SIZE: i32 = 64;
/// Video poster size (px) — wide enough to fill the 320px preview pane.
const VIDEO_THUMB_SIZE: i32 = 320;
/// General file/document thumbnail size for the 320px preview pane.
const FILE_THUMB_SIZE: i32 = 400;

/// Process-local path → data-URI cache. The SQLite store can only resolve a
/// path through the app index; plugin searches also return arbitrary files
/// that are never inserted there, so without this cache those paths would be
/// re-extracted through the shell on every selection.
static ICON_MEMORY: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn icon_memory() -> &'static Mutex<HashMap<String, String>> {
    ICON_MEMORY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remember_icon(path: &str, uri: &str) {
    let mut cache = icon_memory().lock().unwrap();
    // Start over rather than grow without bound for a long-lived launcher.
    if cache.len() >= 2048 && !cache.contains_key(path) {
        cache.clear();
    }
    cache.insert(path.to_string(), uri.to_string());
}

/// An extracted icon, as sent to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct IconData {
    pub path: String,
    /// Base64 PNG data URI, or `None` when extraction failed.
    pub icon: Option<String>,
}

/// Stable FNV-1a hash of PNG bytes — the dedup key for the icon store. Stable
/// across runs so identical icons (e.g. the default exe icon) are stored once.
fn stable_hash(data: &[u8]) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in data {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// Extract a PNG image for a file path via the shell at the given size.
/// `flags` picks icon (`SIIGBF_ICONONLY`) vs. a real thumbnail
/// (`SIIGBF_THUMBNAILONLY` — video frames included). The shell APIs need COM
/// initialized on the calling thread in the given apartment, so this is done
/// per call.
fn extract_shell_png(path: &str, size: i32, flags: SIIGBF, com: COINIT) -> Option<Vec<u8>> {
    if unsafe { CoInitializeEx(None, com) }.is_err() {
        return None;
    }
    let result = (|| {
        let item: IShellItem =
            unsafe { SHCreateItemFromParsingName(&HSTRING::from(path), None) }.ok()?;
        let factory: IShellItemImageFactory = item.cast().ok()?;
        let bitmap = unsafe { factory.GetImage(SIZE { cx: size, cy: size }, flags) }.ok()?;
        bitmap_to_png(bitmap)
    })();
    unsafe { CoUninitialize() };
    result
}

/// Extract a PNG for a `.lnk` path via the shell (the file-type icon). Icons
/// work from MTA, so this runs on the caller's thread (async command workers).
pub(crate) fn extract_icon_png(path: &str) -> Option<Vec<u8>> {
    let result = extract_shell_png(
        path,
        ICON_SIZE,
        SIIGBF_ICONONLY | SIIGBF_SCALEUP,
        COINIT_MULTITHREADED,
    );
    if result.is_none() {
        eprintln!("[icons] failed to extract icon for {path}");
    }
    result
}

/// Extract a real shell thumbnail (never the file-type icon) on a dedicated
/// STA thread. Thumbnail providers commonly require STA; video and document
/// providers both follow this path.
fn extract_shell_thumb_png(path: &str, size: i32) -> Option<Vec<u8>> {
    let owned = path.to_string();
    let result = std::thread::spawn(move || {
        // Providers disagree on sizing flags. Prefer the provider's native
        // larger size, then fall back to a scaled square and the classic
        // thumbnail call. THUMBNAILONLY is fixed so an icon is never mistaken
        // for document content.
        for (requested, flags) in [
            (size, SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK),
            (
                size,
                SIIGBF_THUMBNAILONLY | SIIGBF_BIGGERSIZEOK | SIIGBF_SCALEUP,
            ),
            (256, SIIGBF_THUMBNAILONLY),
        ] {
            if let Some(png) =
                extract_shell_png(&owned, requested, flags, COINIT_APARTMENTTHREADED)
            {
                return Some(png);
            }
        }
        None
    })
    .join()
    .ok()
    .flatten();
    if result.is_none() {
        eprintln!("[icons] no shell thumbnail for {path}");
    }
    result
}

/// Document/image preview thumbnail used by `fs.thumb`.
pub fn extract_file_thumb_png(path: &str) -> Option<Vec<u8>> {
    extract_shell_thumb_png(path, FILE_THUMB_SIZE)
}

/// Video poster frame used by `fs.videoPoster`.
pub fn extract_video_thumb_png(path: &str) -> Option<Vec<u8>> {
    extract_shell_thumb_png(path, VIDEO_THUMB_SIZE)
}

/// Convert an `HBITMAP` to PNG bytes (32-bit BGRA → RGBA → PNG).
pub(crate) fn bitmap_to_png(bitmap: windows::Win32::Graphics::Gdi::HBITMAP) -> Option<Vec<u8>> {
    unsafe {
        let mut bm: BITMAP = std::mem::zeroed();
        if GetObjectW(
            HGDIOBJ(bitmap.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        ) == 0
        {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if w <= 0 || h <= 0 {
            return None;
        }

        let hdc = GetDC(None);
        if hdc.is_invalid() {
            return None;
        }
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = w;
        bi.bmiHeader.biHeight = -h; // top-down
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = BI_RGB.0;
        let mut pixels = vec![0u8; (w * h * 4) as usize];
        let got = GetDIBits(
            hdc,
            bitmap,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut bi,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, hdc);
        if got == 0 {
            return None;
        }

        // 32-bit DIBs are BGRA on Windows → swap to RGBA for the PNG encoder.
        let mut rgba = Vec::with_capacity(pixels.len());
        for px in pixels.as_chunks::<4>().0 {
            rgba.extend_from_slice(&[px[2], px[1], px[0], px[3]]);
        }

        let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba)?;
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .ok()?;
        Some(buf)
    }
}

/// Resolve icons for many paths: serve the deduplicated DB cache, lazily
/// extracting (and storing) the missing ones. Identical icons share one row in
/// `data/icons.db`, so e.g. the default exe icon is stored once and reused.
#[tauri::command]
pub async fn get_app_icons(
    paths: Vec<String>,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<Vec<IconData>, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "fs.read",
    )?;
    get_app_icons_inner(paths).await
}

/// Internal first-party icon lookup (clipboard ignore-list resolution uses
/// this without manufacturing a webview caller identity).
pub(crate) async fn get_app_icons_inner(paths: Vec<String>) -> Result<Vec<IconData>, String> {
    let mut by_path: HashMap<String, Option<String>> = HashMap::new();

    for path in &paths {
        if let Some(uri) = icon_memory().lock().unwrap().get(path).cloned() {
            by_path.insert(path.clone(), Some(uri));
        }
    }

    let unresolved: Vec<String> = paths
        .iter()
        .filter(|path| !by_path.contains_key(*path))
        .cloned()
        .collect();
    let db_cached = cache::icons_for(&unresolved);

    for (path, icon) in db_cached {
        if let Some(uri) = &icon {
            remember_icon(&path, uri);
        }
        by_path.insert(path, icon);
    }

    let mut missing: Vec<String> = Vec::new();
    for path in &paths {
        if by_path.get(path).and_then(Option::as_ref).is_none()
            && !missing.iter().any(|candidate| candidate == path)
        {
            missing.push(path.clone());
        }
    }

    if !missing.is_empty() {
        let extracted = tauri::async_runtime::spawn_blocking(move || {
            missing
                .into_iter()
                .map(|path| {
                    let icon = extract_icon_png(&path).map(|png| {
                        let hash = stable_hash(&png);
                        let _ = cache::store_icon(&hash, &png);
                        let _ = cache::set_file_icon_hash(&path, &hash);
                        cache::encode_png_uri(&png)
                    });
                    (path, icon)
                })
                .collect::<Vec<(String, Option<String>)>>()
        })
        .await
        .unwrap_or_default();

        for (path, icon) in extracted {
            if let Some(uri) = &icon {
                remember_icon(&path, uri);
            }
            by_path.insert(path, icon);
        }
    }

    for path in &paths {
        if let Some(Some(uri)) = by_path.get(path) {
            remember_icon(path, uri);
        }
    }

    Ok(paths
        .into_iter()
        .map(|path| IconData {
            icon: by_path.get(&path).cloned().flatten(),
            path,
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_real_icon_as_png() {
        // The Start Menu scan was removed in 6.5 — walk it here to find a real
        // .lnk for extraction.
        let mut links: Vec<String> = Vec::new();
        let programs = std::path::Path::new("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs");
        for env in ["ProgramData", "APPDATA"] {
            if let Some(root) = std::env::var_os(env) {
                let mut stack = vec![std::path::PathBuf::from(root).join(&programs)];
                while let Some(dir) = stack.pop() {
                    if let Ok(entries) = std::fs::read_dir(&dir) {
                        for e in entries.flatten() {
                            let p = e.path();
                            if p.is_dir() {
                                stack.push(p);
                            } else if p.extension().and_then(|x| x.to_str()) == Some("lnk") {
                                links.push(p.to_string_lossy().into_owned());
                            }
                        }
                    }
                }
            }
        }
        assert!(!links.is_empty(), "expected Start Menu .lnk files");
        let mut ok = 0;
        let mut reasons: Vec<String> = Vec::new();
        for link in links.iter().take(10) {
            match extract_icon_png(link) {
                Some(png) if png.len() > 8 => ok += 1,
                Some(_) => reasons.push(format!("{link}: short/empty png")),
                None => reasons.push(format!("{link}: extraction returned None")),
            }
        }
        eprintln!("extracted {ok}/10; failures: {reasons:?}");
        assert!(ok > 0, "at least one .lnk should yield a PNG: {reasons:?}");
        let png = extract_icon_png(&links[0]).expect("first link should extract");
        assert_eq!(
            &png[..8],
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a],
            "result must be a PNG"
        );
    }

    #[test]
    fn icon_hash_is_stable_and_dedupes() {
        // Same bytes → same hash (the icon-store dedup key), stable across runs.
        let data = b"fake-png-bytes";
        assert_eq!(stable_hash(data), stable_hash(data));
        assert_ne!(stable_hash(data), stable_hash(b"different"));
        assert!(stable_hash(data).chars().all(|c| c.is_ascii_hexdigit()));
    }
}
