//! Synthetic keyboard input and the window/process probes it needs.
//!
//! Two callers share this module and differ only in the token they run under:
//! the in-process fallback (`automation::send_later`, medium IL) and the
//! elevated helper (`agent::serve`, high IL). `SendInput` is subject to UIPI,
//! so the elevated token is what actually decides whether a key reaches a
//! higher-integrity target — see `docs/ROADMAP.md` #22.

use std::str::FromStr;

use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::INPUT;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

/// Windows virtual-key codes (`VK_*` names are not all exported, so the
/// numeric values are spelled out here next to their meaning).
mod vk {
    pub const CONTROL: u16 = 0x11;
    pub const SHIFT: u16 = 0x10;
    pub const MENU: u16 = 0x12; // Alt
    pub const LWIN: u16 = 0x5B;
    pub const A: u16 = 0x41;
    pub const DIGIT0: u16 = 0x30;
    pub const F1: u16 = 0x70;
    pub const SPACE: u16 = 0x20;
    pub const RETURN: u16 = 0x0D;
    pub const ESCAPE: u16 = 0x1B;
    pub const TAB: u16 = 0x09;
    pub const BACK: u16 = 0x08;
    pub const DELETE: u16 = 0x2E;
    pub const HOME: u16 = 0x24;
    pub const END: u16 = 0x23;
    pub const PRIOR: u16 = 0x21; // PageUp
    pub const NEXT: u16 = 0x22; // PageDown
    pub const INSERT: u16 = 0x2D;
    pub const LEFT: u16 = 0x25;
    pub const UP: u16 = 0x26;
    pub const RIGHT: u16 = 0x27;
    pub const DOWN: u16 = 0x28;
    pub const OEM_COMMA: u16 = 0xBC;
    pub const OEM_PERIOD: u16 = 0xBE;
    pub const OEM_MINUS: u16 = 0xBD;
    pub const OEM_PLUS: u16 = 0xBB;
    pub const OEM_1: u16 = 0xBA; // ;
    pub const OEM_7: u16 = 0xDE; // '
    pub const OEM_5: u16 = 0xDC; // \
    pub const OEM_2: u16 = 0xBF; // /
    pub const OEM_3: u16 = 0xC0; // `
    pub const OEM_4: u16 = 0xDB; // [
    pub const OEM_6: u16 = 0xDD; // ]
}

/// Why a combo could not be turned into synthetic input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ComboError {
    /// The combo string does not parse.
    BadCombo,
    /// A key we cannot synthesize (`key_to_vk` has no mapping).
    Unsupported,
}

/// Map a parsed hotkey `Code` to a Windows `VIRTUAL_KEY` for the key set the
/// settings pane accepts. `None` = a key we can't synthesize (rejected at
/// validation time so we never accept a combo we can't send).
pub fn key_to_vk(code: Code) -> Option<u16> {
    use Code::*;
    let c = match code {
        KeyA => vk::A,
        KeyB => vk::A + 1,
        KeyC => vk::A + 2,
        KeyD => vk::A + 3,
        KeyE => vk::A + 4,
        KeyF => vk::A + 5,
        KeyG => vk::A + 6,
        KeyH => vk::A + 7,
        KeyI => vk::A + 8,
        KeyJ => vk::A + 9,
        KeyK => vk::A + 10,
        KeyL => vk::A + 11,
        KeyM => vk::A + 12,
        KeyN => vk::A + 13,
        KeyO => vk::A + 14,
        KeyP => vk::A + 15,
        KeyQ => vk::A + 16,
        KeyR => vk::A + 17,
        KeyS => vk::A + 18,
        KeyT => vk::A + 19,
        KeyU => vk::A + 20,
        KeyV => vk::A + 21,
        KeyW => vk::A + 22,
        KeyX => vk::A + 23,
        KeyY => vk::A + 24,
        KeyZ => vk::A + 25,
        Digit0 => vk::DIGIT0,
        Digit1 => vk::DIGIT0 + 1,
        Digit2 => vk::DIGIT0 + 2,
        Digit3 => vk::DIGIT0 + 3,
        Digit4 => vk::DIGIT0 + 4,
        Digit5 => vk::DIGIT0 + 5,
        Digit6 => vk::DIGIT0 + 6,
        Digit7 => vk::DIGIT0 + 7,
        Digit8 => vk::DIGIT0 + 8,
        Digit9 => vk::DIGIT0 + 9,
        F1 => vk::F1,
        F2 => vk::F1 + 1,
        F3 => vk::F1 + 2,
        F4 => vk::F1 + 3,
        F5 => vk::F1 + 4,
        F6 => vk::F1 + 5,
        F7 => vk::F1 + 6,
        F8 => vk::F1 + 7,
        F9 => vk::F1 + 8,
        F10 => vk::F1 + 9,
        F11 => vk::F1 + 10,
        F12 => vk::F1 + 11,
        F13 => vk::F1 + 12,
        F14 => vk::F1 + 13,
        F15 => vk::F1 + 14,
        F16 => vk::F1 + 15,
        F17 => vk::F1 + 16,
        F18 => vk::F1 + 17,
        F19 => vk::F1 + 18,
        F20 => vk::F1 + 19,
        F21 => vk::F1 + 20,
        F22 => vk::F1 + 21,
        F23 => vk::F1 + 22,
        F24 => vk::F1 + 23,
        Space => vk::SPACE,
        Enter => vk::RETURN,
        Escape => vk::ESCAPE,
        Tab => vk::TAB,
        Backspace => vk::BACK,
        Delete => vk::DELETE,
        Home => vk::HOME,
        End => vk::END,
        PageUp => vk::PRIOR,
        PageDown => vk::NEXT,
        Insert => vk::INSERT,
        ArrowLeft => vk::LEFT,
        ArrowUp => vk::UP,
        ArrowRight => vk::RIGHT,
        ArrowDown => vk::DOWN,
        Comma => vk::OEM_COMMA,
        Period => vk::OEM_PERIOD,
        Minus => vk::OEM_MINUS,
        Equal => vk::OEM_PLUS,
        Semicolon => vk::OEM_1,
        Quote => vk::OEM_7,
        Backslash => vk::OEM_5,
        Slash => vk::OEM_2,
        Backquote => vk::OEM_3,
        BracketLeft => vk::OEM_4,
        BracketRight => vk::OEM_6,
        _ => return None,
    };
    Some(c)
}

/// A modifier bit → its synthetic `VIRTUAL_KEY`.
fn mod_vk(m: Modifiers) -> u16 {
    if m == Modifiers::CONTROL {
        vk::CONTROL
    } else if m == Modifiers::ALT {
        vk::MENU
    } else if m == Modifiers::SHIFT {
        vk::SHIFT
    } else {
        vk::LWIN // SUPER / META (Windows key)
    }
}

/// Keys that must carry `KEYEVENTF_EXTENDEDKEY`: the 0xE0-prefixed ones (the
/// MSDN "Keyboard Input Overview" list — right-hand Alt/Ctrl, Ins/Del/Home/End,
/// PgUp/PgDn, the arrows, Num Lock, the numpad `/` and Print Screen).
///
/// Deliberately narrower than the reference implementation this feature was
/// modelled on, which also flags the *generic* `VK_CONTROL`/`VK_MENU` as
/// extended: those are the non-extended left-hand keys, and our synthesised
/// modifiers are exactly those, so flagging them would be wrong.
pub fn is_extended_key(vk_code: u16) -> bool {
    const RCONTROL: u16 = 0xA3;
    const RMENU: u16 = 0xA5;
    const NUMLOCK: u16 = 0x90;
    const DIVIDE: u16 = 0x6F;
    const SNAPSHOT: u16 = 0x2C;
    matches!(
        vk_code,
        RCONTROL
            | RMENU
            | vk::INSERT
            | vk::DELETE
            | vk::HOME
            | vk::END
            | vk::PRIOR
            | vk::NEXT
            | vk::LEFT
            | vk::UP
            | vk::RIGHT
            | vk::DOWN
            | NUMLOCK
            | DIVIDE
            | SNAPSHOT
    )
}

/// Append one key event to `inputs`.
fn push_key(inputs: &mut Vec<INPUT>, vk_code: u16, up: bool) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MAPVK_VK_TO_VSC,
        MapVirtualKeyW, VIRTUAL_KEY, INPUT_KEYBOARD,
    };

    let mut flags: u32 = 0;
    if is_extended_key(vk_code) {
        flags |= KEYEVENTF_EXTENDEDKEY.0;
    }
    if up {
        flags |= KEYEVENTF_KEYUP.0;
    }
    // The scan code is informational unless KEYEVENTF_SCANCODE is set (it is
    // not — see ROADMAP #22 for why), but the reference implementation that
    // works in protected games fills it, so we match it.
    let scan = unsafe { MapVirtualKeyW(vk_code as u32, MAPVK_VK_TO_VSC) } as u16 & 0xFF;
    let mut input: INPUT = unsafe { std::mem::zeroed() };
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki = KEYBDINPUT {
        wVk: VIRTUAL_KEY(vk_code),
        wScan: scan,
        dwFlags: KEYBD_EVENT_FLAGS(flags),
        time: 0,
        dwExtraInfo: 0,
    };
    inputs.push(input);
}

/// Inject a hotkey combo (parsed like the global-toggle shortcut) into the
/// current foreground window via `SendInput`. Down/up ordering mirrors
/// `clipboard::send_ctrl_v`: modifiers down, main key down/up, modifiers up.
///
/// Returns the number of events `SendInput` reports as inserted — **zero means
/// the input was blocked** (UIPI against a higher-integrity foreground window,
/// or another thread's `BlockInput`). Callers must not treat a successful call
/// as proof the key arrived.
pub fn send_combo(combo: &str) -> Result<u32, ComboError> {
    use windows::Win32::UI::Input::KeyboardAndMouse::SendInput;

    let sc = Shortcut::from_str(combo).map_err(|_| ComboError::BadCombo)?;
    let main_vk = key_to_vk(sc.key).ok_or(ComboError::Unsupported)?;
    let modifiers = [
        Modifiers::CONTROL,
        Modifiers::ALT,
        Modifiers::SHIFT,
        Modifiers::SUPER,
    ];

    let mut inputs: Vec<INPUT> = Vec::with_capacity(8);
    for m in modifiers {
        if sc.mods.contains(m) {
            push_key(&mut inputs, mod_vk(m), false);
        }
    }
    push_key(&mut inputs, main_vk, false);
    push_key(&mut inputs, main_vk, true);
    for m in modifiers.iter().rev() {
        if sc.mods.contains(*m) {
            push_key(&mut inputs, mod_vk(*m), true);
        }
    }

    let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
    Ok(sent)
}

// ---------------------------------------------------------------------------
// Window / process probes
// ---------------------------------------------------------------------------

/// The pid owning a window, or `None` when it can't be resolved.
pub fn pid_of_hwnd(hwnd: HWND) -> Option<u32> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    (pid != 0).then_some(pid)
}

/// The pid owning the current foreground window.
pub fn foreground_pid() -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }
    pid_of_hwnd(hwnd)
}

/// Resolve a process id to its executable's full image path and file name.
/// Returns `None` when the process can't be opened (protected processes,
/// a pid that already exited).
pub fn exe_of_pid(pid: u32) -> Option<(String, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
        QueryFullProcessImageNameW,
    };

    if pid == 0 {
        return None;
    }
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buf = vec![0u16; 4096];
    let mut len = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    ok.ok()?;
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    let name = std::path::Path::new(&full)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| full.clone());
    Some((full, name))
}

/// Resolve a window's owning executable to its full image path and file name.
pub fn exe_of_hwnd(hwnd: HWND) -> Option<(String, String)> {
    exe_of_pid(pid_of_hwnd(hwnd)?)
}

/// Is `pid` running with an elevated token? `None` = the question could not be
/// answered (protected or already-exited process) — callers must treat that as
/// "unknown", never as "not elevated".
pub fn is_process_elevated(pid: u32) -> Option<bool> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TokenElevation};
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::{
        OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return None;
    }
    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut token = windows::Win32::Foundation::HANDLE(std::ptr::null_mut());
    let opened = unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) };
    let _ = unsafe { CloseHandle(process) };
    opened.ok()?;
    let mut elev = TOKEN_ELEVATION { TokenIsElevated: 0 };
    let mut len = 0u32;
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elev as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        )
    };
    let _ = unsafe { CloseHandle(token) };
    ok.ok()?;
    Some(elev.TokenIsElevated != 0)
}

/// Is the *calling* process running with an elevated token?
pub fn is_elevated() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Security::{GetTokenInformation, TOKEN_ELEVATION, TokenElevation};
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = windows::Win32::Foundation::HANDLE(std::ptr::null_mut());
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut elev = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elev as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        let _ = CloseHandle(token);
        ok.is_ok() && elev.TokenIsElevated != 0
    }
}

/// The Terminal Services session the calling process runs in.
pub fn current_session_id() -> Option<u32> {
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    use windows::Win32::System::Threading::GetCurrentProcessId;
    let mut session = 0u32;
    unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) }
        .ok()
        .map(|_| session)
}

/// The window to pull back: the recorded one while it is still alive and owned
/// by `pid`, otherwise any visible titled window of that process.
pub fn target_window(raw_hwnd: isize, pid: Option<u32>) -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    let hwnd = HWND(raw_hwnd as *mut _);
    if unsafe { IsWindow(Some(hwnd)) }.as_bool() && (pid.is_none() || pid_of_hwnd(hwnd) == pid) {
        return Some(hwnd);
    }
    pid.and_then(find_window_of_pid)
}

/// The first visible, titled top-level window owned by `pid`.
pub fn find_window_of_pid(pid: u32) -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;
    use windows::Win32::Foundation::LPARAM;

    let mut search = PidSearch { pid, found: None };
    let ptr: *mut PidSearch = &mut search;
    unsafe {
        let _ = EnumWindows(Some(enum_pid_window), LPARAM(ptr as isize));
    }
    search.found
}

struct PidSearch {
    pid: u32,
    found: Option<HWND>,
}

/// `EnumWindows` callback: stop at the first visible, titled window of the pid.
unsafe extern "system" fn enum_pid_window(
    hwnd: HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    use windows::Win32::Foundation::{FALSE, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, IsWindowVisible};

    let search = unsafe { &mut *(lparam.0 as *mut PidSearch) };
    if search.found.is_some() {
        return FALSE;
    }
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return TRUE;
    }
    if pid_of_hwnd(hwnd) != Some(search.pid) {
        return TRUE;
    }
    if unsafe { GetWindowTextLengthW(hwnd) } <= 0 {
        return TRUE;
    }
    search.found = Some(hwnd);
    FALSE
}

/// A bare ALT tap: harmless in practice, and it makes this process the
/// "last input" owner so the following `SetForegroundWindow` is allowed.
pub fn tap_alt() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP, SendInput, VIRTUAL_KEY, INPUT_KEYBOARD,
    };

    let mut inputs: [INPUT; 2] = unsafe { std::mem::zeroed() };
    for (input, up) in inputs.iter_mut().zip([false, true]) {
        input.r#type = INPUT_KEYBOARD;
        input.Anonymous.ki = KEYBDINPUT {
            wVk: VIRTUAL_KEY(vk::MENU),
            wScan: 0,
            dwFlags: if up {
                KEYEVENTF_KEYUP
            } else {
                KEYBD_EVENT_FLAGS(0)
            },
            time: 0,
            dwExtraInfo: 0,
        };
    }
    let _ = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

/// Best-effort foreground steal.
///
/// Windows refuses `SetForegroundWindow` from a background process unless it
/// looks like the "last input" owner, so two standard workarounds are applied:
/// an ALT tap (which makes this process the last-input one) and attaching our
/// input queue to the current foreground thread. This is best-effort by design
/// — an elevated foreground window (a UAC prompt) will still refuse, which is
/// reported to the caller.
pub fn force_foreground(hwnd: HWND) -> bool {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, SW_RESTORE, SetForegroundWindow, ShowWindow,
    };

    unsafe {
        if GetForegroundWindow() == hwnd {
            return true;
        }
        tap_alt();
        let foreground = GetForegroundWindow();
        let fg_thread = GetWindowThreadProcessId(foreground, None);
        let our_thread = GetCurrentThreadId();
        let attached = fg_thread != 0
            && fg_thread != our_thread
            && AttachThreadInput(our_thread, fg_thread, true).as_bool();
        if IsIconic(hwnd).as_bool() {
            let _ = ShowWindow(hwnd, SW_RESTORE);
        }
        let _ = SetForegroundWindow(hwnd);
        if attached {
            let _ = AttachThreadInput(our_thread, fg_thread, false);
        }
        // Let the shell settle, then report the truth rather than the call result.
        std::thread::sleep(std::time::Duration::from_millis(60));
        GetForegroundWindow() == hwnd
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_to_vk_covers_supported_set() {
        assert_eq!(key_to_vk(Code::KeyA), Some(0x41));
        assert_eq!(key_to_vk(Code::KeyZ), Some(0x5A));
        assert_eq!(key_to_vk(Code::Digit0), Some(0x30));
        assert_eq!(key_to_vk(Code::Digit9), Some(0x39));
        assert_eq!(key_to_vk(Code::F1), Some(0x70));
        assert_eq!(key_to_vk(Code::F12), Some(0x70 + 11));
        assert_eq!(key_to_vk(Code::Space), Some(0x20));
        assert_eq!(key_to_vk(Code::ArrowUp), Some(0x26));
        // Unsupported keys the settings pane must reject.
        assert_eq!(key_to_vk(Code::MediaPlayPause), None);
    }

    /// The extended-key set is the 0xE0-prefixed one — and notably does *not*
    /// include the generic (left-hand) Ctrl/Alt we synthesize as modifiers.
    #[test]
    fn extended_key_set_is_the_e0_prefix_set() {
        for k in [
            0xA3, // right Ctrl
            0xA5, // right Alt
            0x2D, // Insert
            0x2E, // Delete
            0x24, // Home
            0x23, // End
            0x21, // PageUp
            0x22, // PageDown
            0x25, // Left
            0x26, // Up
            0x27, // Right
            0x28, // Down
            0x90, // Num Lock
            0x6F, // numpad /
            0x2C, // Print Screen
        ] {
            assert!(is_extended_key(k), "{k:#x} should be extended");
        }
        for k in [0x11, 0x12, 0x10, 0x5B, 0x41, 0x30, 0x0D, 0x20, 0x70] {
            assert!(!is_extended_key(k), "{k:#x} should not be extended");
        }
    }

    /// A combo we cannot synthesize is reported, never silently dropped.
    #[test]
    fn send_combo_rejects_unusable_combos() {
        assert_eq!(send_combo("not a combo"), Err(ComboError::BadCombo));
        assert_eq!(
            send_combo("Ctrl+MediaPlayPause"),
            Err(ComboError::Unsupported)
        );
    }

    /// Resolving a nonsense pid must not panic.
    #[test]
    fn exe_of_pid_is_lenient() {
        assert_eq!(exe_of_pid(0), None);
        assert_eq!(is_process_elevated(0), None);
    }
}
