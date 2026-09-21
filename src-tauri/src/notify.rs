//! Plugin host capability: system notifications (P1.2 of
//! docs/PLUGIN_GAP_ANALYSIS.md).
//!
//! A plugin needs a way to reach the user when the launcher is hidden — the
//! in-app toast only exists while the window is up. This module registers a
//! **hidden** notification-area icon of its own (NIS_HIDDEN: it never shows in
//! the tray) and drives Windows notifications through its `NIF_INFO` balloon:
//! on Windows 10/11 the shell renders those as normal toasts (Action Center
//! entries), so no AUMID / Start-menu shortcut registration is required — which
//! matters because Lume also runs portable, where the toast APIs of packaged
//! apps are unavailable.
//!
//! The icon is created lazily on the first notification, from the calling
//! thread (Tauri commands run on the main thread, which pumps messages).
//!
//! Permission: `notify` (declared in the manifest; the enforcement layer is
//! P3.2 — until then this module is the documented ledger entry).

use std::sync::Mutex;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Shell::{
    ExtractIconExW, Shell_NotifyIconW, NIF_ICON, NIF_INFO, NIF_MESSAGE, NIF_TIP, NIIF_INFO,
    NIIF_RESPECT_QUIET_TIME, NIM_ADD, NIM_MODIFY, NIM_SETVERSION, NIS_HIDDEN, NOTIFYICONDATAW,
    NOTIFYICONDATAW_0, NOTIFYICON_VERSION_4,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyIcon, LoadIconW, RegisterClassExW, HICON, HWND_MESSAGE,
    IDI_APPLICATION, WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WNDCLASSEXW, WNDCLASS_STYLES,
};

/// One hidden notification icon owned by this process (created on first use).
/// Handles are kept as raw `isize` values: the shell owns their lifetime and
/// raw pointers are not `Send`, which the `Mutex` requires.
struct NotifyIcon {
    hwnd: isize,
    /// Owned only when extracted from our own exe (stock icons are not ours).
    own_icon: Option<isize>,
}

impl NotifyIcon {
    fn hwnd(&self) -> HWND {
        HWND(self.hwnd as *mut std::ffi::c_void)
    }
}

static ICON: Mutex<Option<NotifyIcon>> = Mutex::new(None);

/// Copy a &str into a fixed-size NUL-terminated UTF-16 buffer (truncating).
fn fill_wide(dst: &mut [u16], src: &str) {
    let units: Vec<u16> = src.encode_utf16().take(dst.len().saturating_sub(1)).collect();
    dst[..units.len()].copy_from_slice(&units);
    for slot in &mut dst[units.len()..] {
        *slot = 0;
    }
}

/// Load the notification icon: Lume's own exe icon when extractable (works in
/// dev and portable alike — the icon is embedded in the binary), else the
/// stock application icon. Returns (icon, did we allocate it).
fn load_icon() -> (HICON, bool) {
    let exe = std::env::current_exe().ok();
    if let Some(path) = exe {
        let wide: Vec<u16> = path
            .to_string_lossy()
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut large = HICON::default();
        // 1 icon starting at index 0; only the large one is needed.
        let found = unsafe {
            ExtractIconExW(PCWSTR(wide.as_ptr()), 0, Some(&mut large), None, 1)
        };
        if found > 0 && !large.0.is_null() {
            return (large, true);
        }
    }
    match unsafe { LoadIconW(None, IDI_APPLICATION) } {
        Ok(h) => (h, false),
        Err(_) => (HICON::default(), false),
    }
}

/// Create (once) the hidden notification icon. Idempotent.
fn ensure_icon() -> Result<(), String> {
    let mut guard = ICON.lock().unwrap();
    if guard.is_some() {
        return Ok(());
    }
    let hinst = match unsafe { GetModuleHandleW(None) } {
        Ok(h) => HINSTANCE(h.0),
        Err(e) => return Err(format!("GetModuleHandleW: {e}")),
    };
    let class: Vec<u16> = "LumePluginNotify\0".encode_utf16().collect();
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(wnd_proc),
        hInstance: hinst,
        lpszClassName: PCWSTR(class.as_ptr()),
        ..Default::default()
    };
    // RegisterClassExW fails with ERROR_CLASS_ALREADY_EXISTS when the class is
    // already registered (a second launcher instance in dev); that's fine.
    let _ = unsafe { RegisterClassExW(&wc) };
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class.as_ptr()),
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinst),
            None,
        )
    }
    .map_err(|e| format!("CreateWindowExW: {e}"))?;
    if hwnd.0.is_null() {
        return Err("CreateWindowExW returned a null window".into());
    }

    let (hicon, owned) = load_icon();
    let mut data = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: hwnd,
        uID: 1,
        uFlags: NIF_ICON | NIF_MESSAGE | NIF_TIP,
        uCallbackMessage: WM_APP + 1,
        hIcon: hicon,
        // Hidden: the icon exists only as a notification source, never as a
        // second tray entry (Lume already owns a tray icon).
        dwState: NIS_HIDDEN,
        dwStateMask: NIS_HIDDEN,
        ..Default::default()
    };
    fill_wide(&mut data.szTip, "Lume");
    if !unsafe { Shell_NotifyIconW(NIM_ADD, &data) }.as_bool() {
        if owned && !hicon.0.is_null() {
            let _ = unsafe { DestroyIcon(hicon) };
        }
        return Err("Shell_NotifyIconW(NIM_ADD) failed".into());
    }
    // Version 4 gives consistent balloon semantics on modern shells.
    let mut version = data;
    version.Anonymous = NOTIFYICONDATAW_0 { uVersion: NOTIFYICON_VERSION_4 };
    version.uFlags = NIF_MESSAGE;
    let _ = unsafe { Shell_NotifyIconW(NIM_SETVERSION, &version) };

    eprintln!("[plugins] notify: hidden notification icon registered (hwnd {hwnd:?})");
    *guard = Some(NotifyIcon {
        hwnd: hwnd.0 as isize,
        own_icon: owned.then_some(hicon.0 as isize),
    });
    Ok(())
}

/// Show one notification: title + body, ≤ 63 / ≤ 255 UTF-16 units (truncated).
/// Returns Ok when the shell accepted the notification.
pub fn notify(title: &str, body: &str) -> Result<(), String> {
    ensure_icon()?;
    let guard = ICON.lock().unwrap();
    let icon = guard.as_ref().ok_or("notification icon unavailable")?;
    let (hicon, _) = load_icon();
    let mut data = NOTIFYICONDATAW {
        cbSize: std::mem::size_of::<NOTIFYICONDATAW>() as u32,
        hWnd: icon.hwnd(),
        uID: 1,
        uFlags: NIF_INFO,
        hIcon: hicon,
        dwInfoFlags: NIIF_INFO | NIIF_RESPECT_QUIET_TIME,
        ..Default::default()
    };
    fill_wide(&mut data.szInfoTitle, title);
    fill_wide(&mut data.szInfo, body);
    let ok = unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) }.as_bool();
    if !ok {
        return Err("Shell_NotifyIconW(NIM_MODIFY) failed".into());
    }
    Ok(())
}

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // The icon's callback messages (WM_APP+1: click / balloon dismissed) are
    // not acted on in v1 — a click could focus the launcher, but the balloon
    // is informational. Everything else is default handling.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// Plugin host command: show a system notification. `title`/`body` are
/// truncated by the shell's field widths (64/256 UTF-16 units).
#[tauri::command]
pub fn plugin_notify(title: String, body: String, plugin_id: Option<String>) -> Result<(), String> {
    eprintln!(
        "[plugins] notify ({}) {}",
        plugin_id.as_deref().unwrap_or("-"),
        title
    );
    notify(&title, &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fill_wide_truncates_and_nul_terminates() {
        let mut buf = [0xFFFFu16; 6];
        fill_wide(&mut buf, "abcdefgh");
        assert_eq!(&buf[..5], &[b'a' as u16, b'b' as u16, b'c' as u16, b'd' as u16, b'e' as u16]);
        assert_eq!(buf[5], 0, "must stay NUL-terminated");

        let mut buf = [0xFFFFu16; 8];
        fill_wide(&mut buf, "hi");
        assert_eq!(&buf[..3], &[b'h' as u16, b'i' as u16, 0]);
        assert_eq!(buf[3], 0, "rest zeroed");
    }

    #[test]
    fn load_icon_returns_something() {
        let (icon, _owned) = load_icon();
        assert!(!icon.0.is_null(), "an icon must always be available");
    }

    /// Real notification-area registration. Ignored by default because it
    /// touches the shell notification area (and pops a balloon): run
    /// `cargo test -- --ignored live_notify`.
    #[test]
    #[ignore]
    fn live_notify_registers_and_shows() {
        notify("Lume plugin host", "notify module live test").expect("notify should succeed");
        // Second call reuses the registered icon.
        notify("Lume plugin host", "second call").expect("second notify should succeed");
    }
}
