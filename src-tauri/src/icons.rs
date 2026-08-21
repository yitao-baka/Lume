//! Real application icons, extracted via the Windows shell.
//!
//! Icons are **not** persisted to SQL (project constraint): they live in an
//! in-memory cache keyed by the `.lnk` path and are reused within the process.
//! Extraction uses `IShellItemImageFactory`, which resolves the shortcut and
//! returns a correctly-sized icon.

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
    SIIGBF_SCALEUP, SIIGBF_THUMBNAILONLY,
};

/// Icon extraction size (px). 64px stays crisp on HiDPI grids.
const ICON_SIZE: i32 = 64;
/// Video poster size (px) — wide enough to fill the 320px preview pane.
const VIDEO_THUMB_SIZE: i32 = 320;

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

/// Extract a video thumbnail (a frame) via the shell, for the preview player's
/// `<video poster>`. `SIIGBF_THUMBNAILONLY` requests the real thumbnail and
/// does not fall back to the file-type icon when the shell has no provider.
/// Thumbnail providers commonly require **STA** (icons tolerate MTA but video
/// thumbnails often fail there), so this runs on a dedicated STA thread.
pub fn extract_video_thumb_png(path: &str) -> Option<Vec<u8>> {
    let owned = path.to_string();
    let result = std::thread::spawn(move || {
        extract_shell_png(
            &owned,
            VIDEO_THUMB_SIZE,
            SIIGBF_THUMBNAILONLY | SIIGBF_SCALEUP,
            COINIT_APARTMENTTHREADED,
        )
    })
    .join()
    .ok()
    .flatten();
    if result.is_none() {
        eprintln!("[icons] no shell thumbnail for {path}");
    }
    result
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
        for px in pixels.chunks_exact(4) {
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
pub async fn get_app_icons(paths: Vec<String>) -> Result<Vec<IconData>, String> {
    let cached = cache::icons_for(&paths);
    let mut result = Vec::with_capacity(paths.len());
    let mut missing: Vec<String> = Vec::new();
    for path in &paths {
        match cached.get(path) {
            Some(Some(uri)) => result.push(IconData {
                path: path.clone(),
                icon: Some(uri.clone()),
            }),
            _ => missing.push(path.clone()),
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
            result.push(IconData { path, icon });
        }
    }
    Ok(result)
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
