//! Live environment-variable synchronization.
//!
//! When the user edits environment variables (System Properties → Environment
//! Variables, or `setx`), the new values land in the registry and Windows
//! broadcasts `WM_SETTINGCHANGE`. Lume keeps its **own process environment
//! block** in sync with those changes, so everything it launches afterwards —
//! apps opened via `ShellExecuteW`, and future "run a command" features —
//! inherits the fresh PATH / variables instead of the ones frozen at launcher
//! startup.
//!
//! ## Why this is free (no polling)
//!
//! The watcher is **event-driven**: a dedicated thread parks in
//! `MsgWaitForMultipleObjectsEx`, a kernel wait. While the system is quiet the
//! thread is suspended and consumes **zero CPU**; the OS wakes it only when a
//! `WM_SETTINGCHANGE` broadcast arrives or one of the two environment registry
//! keys is rewritten. There is deliberately no registry polling, which would
//! burn a wakeup every tick for nothing.
//!
//! ## Coverage
//!
//! - The Environment Variables **dialog** broadcasts `WM_SETTINGCHANGE` with
//!   `lParam = "Environment"` — caught by a message-only window.
//! - `setx` and direct registry edits do **not** broadcast, so we additionally
//!   `RegNotifyChangeKeyValue` on `HKCU\Environment` and the HKLM session
//!   manager environment key (also event-driven, same cost).
//!
//! ## Semantics
//!
//! On a change we rebuild the effective block from the registry:
//! - `PATH` = system PATH + user PATH (Windows' concatenation order), replaced
//!   wholesale so removed entries are honored.
//! - other variables: user overrides system.
//! - `REG_EXPAND_SZ` values are expanded (`%SystemRoot%` → its value).
//!
//! Vars present in the current process but no longer in the registry are left
//! alone (removing them could break the launcher's own runtime). Only newly
//! **started** processes are affected — already-running ones keep their
//! original environment, as Windows never rewrites a live process.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, HINSTANCE, HANDLE, HWND, LPARAM, LRESULT, WAIT_EVENT, WAIT_OBJECT_0, WIN32_ERROR,
    WPARAM,
};
use windows::Win32::Graphics::Gdi::HBRUSH;
use windows::Win32::System::Environment::{ExpandEnvironmentStringsW, SetEnvironmentVariableW};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Registry::{
    RegCloseKey, RegEnumValueW, RegNotifyChangeKeyValue, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER,
    HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_NOTIFY_CHANGE_LAST_SET,
    REG_NOTIFY_THREAD_AGNOSTIC,
};
use windows::Win32::System::Threading::CreateEventW;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW,
    RegisterClassExW, RegisterWindowMessageW, TranslateMessage, MSG_WAIT_FOR_MULTIPLE_OBJECTS_EX_FLAGS,
    WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASS_STYLES, WNDCLASSEXW, HCURSOR, HICON, HWND_MESSAGE, MSG,
    PM_REMOVE, QS_ALLINPUT, WM_QUIT,
};

/// Success code for the `WIN32_ERROR`-returning APIs (see `svc.rs`).
const ZERO: WIN32_ERROR = WIN32_ERROR(0);

/// User environment lives in `HKCU\Environment`.
const USER_KEY: &str = "Environment";
/// System environment lives in the Session Manager's key.
const SYSTEM_KEY: &str = r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";

/// Value buffer for a single registry value (Windows caps env vars at 32 KiB).
const BUF_LEN: usize = 32768;

/// Runtime id of `RegisterWindowMessageW("WM_SETTINGCHANGE")`, set once by the
/// watcher thread and read by the window proc.
static ENV_CHANGE_MSG: AtomicU32 = AtomicU32::new(0);

/// Start the background watcher. One thread, parked in a kernel wait — no
/// polling, no timers.
pub fn init() {
    let _ = std::thread::Builder::new()
        .name("envwatch".into())
        .spawn(env_watch_thread);
}

/// Watcher thread: a hidden message-only window for the broadcast, plus
/// registry-change events for `setx`/direct edits. All waits are kernel
/// waits, so the thread is fully suspended while the environment is stable.
fn env_watch_thread() {
    unsafe {
        let class = wide("LumeEnvWatchWindow");
        let hinst = match GetModuleHandleW(None) {
            Ok(hm) => HINSTANCE(hm.0),
            Err(_) => {
                eprintln!("[envwatch] GetModuleHandleW failed");
                return;
            }
        };
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: WNDCLASS_STYLES(0),
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: HICON::default(),
            hCursor: HCURSOR::default(),
            hbrBackground: HBRUSH::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: PCWSTR(class.as_ptr()),
            hIconSm: HICON::default(),
        };
        if RegisterClassExW(&wc) == 0 {
            eprintln!("[envwatch] RegisterClassExW failed");
            return;
        }
        let hwnd = match CreateWindowExW(
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
        ) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[envwatch] CreateWindowExW failed: {e}");
                return;
            }
        };
        if hwnd.0.is_null() {
            eprintln!("[envwatch] CreateWindowExW returned a null window");
            return;
        }
        ENV_CHANGE_MSG.store(RegisterWindowMessageW(w!("WM_SETTINGCHANGE")), Ordering::Relaxed);
        eprintln!(
            "[envwatch] listening for environment changes (msg 0x{:04X})",
            ENV_CHANGE_MSG.load(Ordering::Relaxed)
        );

        // Registry notify covers setx / direct edits, which skip the broadcast.
        let hk_user = open_key(HKEY_CURRENT_USER, USER_KEY);
        let hk_sys = open_key(HKEY_LOCAL_MACHINE, SYSTEM_KEY);
        let ev_user = match CreateEventW(None, false, false, None) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[envwatch] CreateEventW failed: {e}");
                return;
            }
        };
        let ev_sys = match CreateEventW(None, false, false, None) {
            Ok(h) => h,
            Err(e) => {
                eprintln!("[envwatch] CreateEventW failed: {e}");
                return;
            }
        };
        let handles = [ev_user, ev_sys];
        // handles[0] → HKCU (user), handles[1] → HKLM (system). Order must
        // match the WAIT_EVENT offsets below.
        if let Some(k) = hk_user {
            arm_notify(k, ev_user);
        }
        if let Some(k) = hk_sys {
            arm_notify(k, ev_sys);
        }

        loop {
            let wake = MsgWaitForMultipleObjectsEx(
                Some(&handles),
                u32::MAX,
                QS_ALLINPUT,
                MSG_WAIT_FOR_MULTIPLE_OBJECTS_EX_FLAGS(0),
            );
            if wake == WAIT_OBJECT_0 {
                // HKCU\Environment rewritten (e.g. non-admin setx).
                if let Some(k) = hk_user {
                    arm_notify(k, ev_user);
                }
                refresh_env();
            } else if wake == WAIT_EVENT(1) {
                // HKLM session-manager environment rewritten (e.g. admin setx).
                if let Some(k) = hk_sys {
                    arm_notify(k, ev_sys);
                }
                refresh_env();
            } else if wake == WAIT_EVENT(2) {
                // A message is pending — this is what dispatches the sent
                // WM_SETTINGCHANGE broadcast to the window proc.
                if !pump_messages() {
                    break; // WM_QUIT
                }
            } else {
                eprintln!(
                    "[envwatch] MsgWaitForMultipleObjectsEx returned {wake:?}, stopping watcher"
                );
                break;
            }
        }
        let _ = CloseHandle(ev_user);
        let _ = CloseHandle(ev_sys);
        if let Some(k) = hk_user {
            let _ = RegCloseKey(k);
        }
        if let Some(k) = hk_sys {
            let _ = RegCloseKey(k);
        }
    }
}

/// Window proc for the message-only window: forwards `WM_SETTINGCHANGE` with
/// `lParam = "Environment"` into a refresh.
unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == ENV_CHANGE_MSG.load(Ordering::Relaxed) {
        if lparam.0 != 0 && read_wide(lparam.0 as *const u16) == "Environment" {
            refresh_env();
        }
        return LRESULT(0);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

/// Dispatch all pending window messages. Returns false when `WM_QUIT` arrives.
unsafe fn pump_messages() -> bool {
    let mut msg = std::mem::zeroed::<MSG>();
    while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE).as_bool() {
        if msg.message == WM_QUIT {
            return false;
        }
        let _ = TranslateMessage(&msg);
        let _ = DispatchMessageW(&msg);
    }
    true
}

/// Rebuild this process's environment block from the registry.
///
/// `PATH` is replaced wholesale with system + user (Windows' concatenation
/// order, so removals are honored); other variables are user-over-system.
/// `REG_EXPAND_SZ` values are expanded against the current block.
fn refresh_env() {
    unsafe {
        let system = read_env_key(HKEY_LOCAL_MACHINE, SYSTEM_KEY);
        let user = read_env_key(HKEY_CURRENT_USER, USER_KEY);

        let merged_path = merge_path(
            system.get("PATH").map(String::as_str).unwrap_or(""),
            user.get("PATH").map(String::as_str).unwrap_or(""),
        );
        set_var("PATH", &merged_path);

        for (name, value) in system.iter().filter(|(n, _)| n.as_str() != "PATH") {
            set_var(name, value);
        }
        for (name, value) in user.iter().filter(|(n, _)| n.as_str() != "PATH") {
            set_var(name, value);
        }
        eprintln!(
            "[envwatch] environment refreshed from registry (PATH: {} entries)",
            merged_path.split(';').count()
        );
    }
}

/// Read a registry key into a `name → (expanded) value` map. Missing keys and
/// failed reads yield an empty map — refresh is best-effort and never blocks
/// the launcher.
unsafe fn read_env_key(root: HKEY, subkey: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let sub = wide(subkey);
    let mut hkey = HKEY(std::ptr::null_mut());
    if RegOpenKeyExW(root, PCWSTR(sub.as_ptr()), None, KEY_READ, &mut hkey) != ZERO {
        return map;
    }
    let mut index = 0u32;
    let mut name_buf = [0u16; 512];
    let mut val_buf = [0u16; BUF_LEN];
    loop {
        let mut name_len = name_buf.len() as u32;
        let mut val_len = (val_buf.len() * 2) as u32; // bytes
        let mut ty = 0u32;
        let rc = RegEnumValueW(
            hkey,
            index,
            Some(PWSTR(name_buf.as_mut_ptr())),
            &mut name_len,
            None,
            Some(&mut ty),
            Some(val_buf.as_mut_ptr() as *mut u8),
            Some(&mut val_len),
        );
        if rc != ZERO {
            break;
        }
        index += 1;
        let name = String::from_utf16_lossy(&name_buf[..name_len as usize]);
        if name.is_empty() {
            continue; // the key's default value is not an environment variable
        }
        // val_len is in bytes; trim any trailing NULs.
        let mut chars = (val_len as usize / 2).min(val_buf.len());
        while chars > 0 && val_buf[chars - 1] == 0 {
            chars -= 1;
        }
        let mut value = String::from_utf16_lossy(&val_buf[..chars]);
        if ty == REG_EXPAND_SZ.0 {
            value = expand(&value);
        }
        map.insert(name, value);
    }
    let _ = RegCloseKey(hkey);
    map
}

/// Expand `%VAR%` references in a `REG_EXPAND_SZ` value. Unknown variables are
/// left as-is (same as explorer's behavior for a missing variable).
fn expand(value: &str) -> String {
    unsafe {
        let src = wide(value);
        let mut buf = [0u16; BUF_LEN];
        let n = ExpandEnvironmentStringsW(PCWSTR(src.as_ptr()), Some(&mut buf[..]));
        if n == 0 {
            return value.to_string();
        }
        let n = (n as usize).min(buf.len());
        let chars = if n > 0 && buf[n - 1] == 0 { n - 1 } else { n };
        String::from_utf16_lossy(&buf[..chars])
    }
}

/// Set one variable in this process's environment block.
fn set_var(name: &str, value: &str) {
    unsafe {
        let n = wide(name);
        let v = wide(value);
        if SetEnvironmentVariableW(PCWSTR(n.as_ptr()), PCWSTR(v.as_ptr())).is_err() {
            eprintln!("[envwatch] SetEnvironmentVariableW({name}) failed");
        }
    }
}

/// Windows' effective PATH is the system PATH followed by the user PATH.
fn merge_path(system: &str, user: &str) -> String {
    match (system.is_empty(), user.is_empty()) {
        (true, true) => String::new(),
        (true, false) => user.to_string(),
        (false, true) => system.to_string(),
        (false, false) => format!("{system};{user}"),
    }
}

unsafe fn open_key(root: HKEY, subkey: &str) -> Option<HKEY> {
    let sub = wide(subkey);
    let mut hkey = HKEY(std::ptr::null_mut());
    if RegOpenKeyExW(root, PCWSTR(sub.as_ptr()), None, KEY_READ, &mut hkey) == ZERO {
        Some(hkey)
    } else {
        None
    }
}

/// Arm a one-shot registry-change notification. Must be re-armed after each
/// signal. `REG_NOTIFY_THREAD_AGNOSTIC` lets the change signal the event from
/// any thread, avoiding a missed notification during re-arm.
unsafe fn arm_notify(hkey: HKEY, event: HANDLE) {
    let rc = RegNotifyChangeKeyValue(
        hkey,
        false,
        REG_NOTIFY_CHANGE_LAST_SET | REG_NOTIFY_THREAD_AGNOSTIC,
        Some(event),
        true,
    );
    if rc != ZERO {
        eprintln!("[envwatch] RegNotifyChangeKeyValue failed: {rc:?}");
    }
}

/// UTF-16 (NUL-terminated) copy of a Rust string.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read a NUL-terminated UTF-16 string from a raw pointer (capped at 128
/// chars — enough for a setting name like "Environment").
fn read_wide(ptr: *const u16) -> String {
    let mut out = Vec::new();
    let mut i = 0usize;
    while i < 128 {
        let c = unsafe { *ptr.add(i) };
        if c == 0 {
            break;
        }
        out.push(c);
        i += 1;
    }
    String::from_utf16_lossy(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_merges_system_then_user() {
        assert_eq!(merge_path("C:\\Windows", "C:\\Tools"), "C:\\Windows;C:\\Tools");
    }

    #[test]
    fn path_handles_missing_sides() {
        assert_eq!(merge_path("", "C:\\Tools"), "C:\\Tools");
        assert_eq!(merge_path("C:\\Windows", ""), "C:\\Windows");
        assert_eq!(merge_path("", ""), "");
    }
}
