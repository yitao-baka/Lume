//! 自动动作 — send a configured hotkey when a configured program takes the
//! foreground with a freshly created top-level window.
//!
//! A zero-polling, event-driven watcher built on the shell hook, mirroring the
//! `envwatch` message-only-window pattern:
//!
//! - A hidden message-only window calls `RegisterShellHookWindow`, so the
//!   system delivers `HSHELL_*` window-creation / activation / destruction
//!   notifications straight to its message queue.
//! - `HSHELL_WINDOWCREATED` for a window whose process matches an enabled rule
//!   is parked in a pending table.
//! - `HSHELL_WINDOWACTIVATED` for a pending window = the rule's program is now
//!   in the foreground, so we inject the configured hotkey **once** (the window
//!   is removed from pending, so Alt+Tabbing back into it later does not
//!   re-fire).
//!
//! Triggering is therefore "new window appears and gets focus" — the same
//! focus-based model the clipboard auto-paste already uses. Background/minimized
//! launches are not covered (nobody can send a keystroke to a non-focused
//! window without forcing the foreground, which Windows makes unreliable).

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Input::KeyboardAndMouse::INPUT;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetMessageW, GetWindowThreadProcessId, RegisterClassExW,
    RegisterShellHookWindow, RegisterWindowMessageW, HSHELL_WINDOWACTIVATED, HSHELL_WINDOWCREATED,
    HSHELL_WINDOWDESTROYED, HWND_MESSAGE, WINDOW_STYLE, WINDOW_EX_STYLE, WNDCLASS_STYLES,
    WNDCLASSEXW, HCURSOR, HICON, MSG,
};

/// Windows virtual-key codes used by `send_combo` (the `VK_*` names are not all
/// exported, so the numeric values are spelled out here next to their meaning).
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

/// Pending "created but not yet activated" windows that matched a rule. Keyed
/// by the raw HWND; the value is the hotkey to fire when it activates.
pub struct AutomationState {
    pub pending: Mutex<HashMap<isize, PendingAction>>,
}

/// A window that matched a rule and is waiting to take the foreground.
#[derive(Clone)]
pub struct PendingAction {
    /// The rule's configured program (its identity in logs).
    process: String,
    combo: String,
    delay_ms: u64,
    /// 延迟到点若前台已移开：尽力抢回焦点再发送（全局策略，见 settings 自动化）。
    force_focus: bool,
}

impl PendingAction {
    /// How this rule is named in logs — "program → combo" is unique per rule.
    fn label(&self) -> String {
        format!("{} → {}", self.process, self.combo)
    }
}

impl Default for AutomationState {
    fn default() -> Self {
        Self {
            pending: Mutex::new(HashMap::new()),
        }
    }
}

/// Result of validating a 自动动作 hotkey in the settings page.
#[derive(serde::Serialize)]
pub struct AutoComboCheck {
    pub ok: bool,
    /// Machine key for a localized message: `need_modifier` | `unsupported` |
    /// `invalid` (matches the frontend i18n strings).
    pub reason: Option<String>,
}

/// Start the background watcher. One thread parked in `GetMessageW` — no
/// polling. Runs for the process lifetime.
pub fn init(app: &tauri::App) {
    let handle = app.handle().clone();
    let _ = std::thread::Builder::new()
        .name("automation".into())
        .spawn(move || watch_thread(handle));
}

/// Trivial window procedure for the message-only hook window: the SHELLHOOK
/// messages are read directly in the `GetMessageW` loop, everything else just
/// gets the default handling.
unsafe extern "system" fn wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

/// The watcher thread: a hidden message-only window subscribed to the shell
/// hook, pumping `HSHELL_*` notifications as they arrive.
fn watch_thread(app: AppHandle) {
    unsafe {
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::Graphics::Gdi::HBRUSH;

        let class = w!("LumeAutomationWindow");
        let hinst = match GetModuleHandleW(None) {
            Ok(hm) => windows::Win32::Foundation::HINSTANCE(hm.0),
            Err(_) => {
                eprintln!("[automation] GetModuleHandleW failed");
                return;
            }
        };
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: WNDCLASS_STYLES(0),
            // A class must carry a real window procedure ("None" makes
            // CreateWindowExW dereference a null proc on WM_NCCREATE → SEH
            // crash). The SHELLHOOK messages are consumed in the GetMessageW
            // loop below, so this proc only forwards the window's own messages.
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
            eprintln!("[automation] RegisterClassExW failed");
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
                eprintln!("[automation] CreateWindowExW failed: {e}");
                return;
            }
        };
        let msg = RegisterWindowMessageW(w!("SHELLHOOK"));
        if !RegisterShellHookWindow(hwnd).as_bool() {
            eprintln!("[automation] RegisterShellHookWindow failed");
            return;
        }
        eprintln!("[automation] watching for program-start hotkeys (shell hook {msg:#x})");

        let mut message = std::mem::zeroed::<MSG>();
        loop {
            let r = GetMessageW(&mut message, None, 0, 0).0;
            if r == 0 {
                break; // WM_QUIT
            }
            if r == -1 {
                eprintln!("[automation] GetMessageW error");
                break;
            }
            if message.message == msg {
                handle_shell(&app, message.wParam.0 as u32, message.lParam.0 as isize);
            }
        }
    }
}

/// Resolve a window's owning executable to its full image path and file name.
/// Returns `(full_path, file_name)` or `None` when the process can't be opened.
unsafe fn exe_of_hwnd(hwnd: HWND) -> Option<(String, String)> {
    unsafe { exe_of_pid(pid_of_hwnd(hwnd)?) }
}

/// Resolve a process id to its executable's full image path and file name.
/// Returns `(full_path, file_name)` or `None` when the process can't be opened.
unsafe fn exe_of_pid(pid: u32) -> Option<(String, String)> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    if pid == 0 {
        return None;
    }
    let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
        return None;
    };
    let mut buf = vec![0u16; 4096];
    let mut len = buf.len() as u32;
    let ok = QueryFullProcessImageNameW(
        handle,
        PROCESS_NAME_WIN32,
        windows::core::PWSTR(buf.as_mut_ptr()),
        &mut len,
    );
    let _ = CloseHandle(handle);
    if ok.is_err() {
        return None;
    }
    let full = String::from_utf16_lossy(&buf[..len as usize]);
    let name = std::path::Path::new(&full)
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| full.clone());
    Some((full, name))
}

/// Distribute one `HSHELL_*` notification to the pending/fire bookkeeping.
unsafe fn handle_shell(app: &AppHandle, accessor: u32, raw_hwnd: isize) {
    let hwnd = HWND(raw_hwnd as *mut _);
    let state = app.state::<AutomationState>();
    match accessor {
        HSHELL_WINDOWCREATED => {
            // Only queue windows whose process matches an enabled rule. The
            // activation handler re-reads the master switch, so disabling the
            // watcher between create and activate still cancels the send.
            if settings_off(app) {
                return;
            }
            let Some((exe_path, exe_name)) = exe_of_hwnd(hwnd) else { return };
            let Some(rule) = rules_for(app, &exe_path, &exe_name) else { return };
            eprintln!(
                "[automation] rule \"{}\": armed for window {raw_hwnd:#x} ({}), delay {} ms{}",
                rule.label(),
                describe_process(pid_of_hwnd(hwnd)),
                rule.delay_ms,
                if rule.force_focus { ", force-focus on" } else { "" }
            );
            state.pending.lock().unwrap().insert(raw_hwnd, rule);
        }
        HSHELL_WINDOWACTIVATED => {
            if settings_off(app) {
                return;
            }
            // `.entry` so a stray repeat activation is a no-op (already fired).
            let rule = match state.pending.lock().unwrap().remove(&raw_hwnd) {
                Some(r) => r,
                None => return,
            };
            // Remember which process owns the window: with a user-set delay the
            // foreground may have moved on by the time we inject, and a hotkey
            // must never land in an unrelated application.
            let pid = pid_of_hwnd(hwnd);
            send_later(rule, pid, raw_hwnd);
        }
        HSHELL_WINDOWDESTROYED => {
            state.pending.lock().unwrap().remove(&raw_hwnd);
        }
        _ => {}
    }
}

/// Master switch off (settings 自动化 → enabled)?
fn settings_off(app: &AppHandle) -> bool {
    !app.state::<crate::settings::SettingsState>().current().automation.enabled
}

/// The first enabled rule whose program matches the resolved executable, or
/// `None` when nothing applies.
fn rules_for(app: &AppHandle, exe_path: &str, exe_name: &str) -> Option<PendingAction> {
    let settings = app.state::<crate::settings::SettingsState>().current();
    let force_focus = settings.automation.force_focus;
    settings
        .automation
        .actions
        .iter()
        .filter(|a| a.enabled)
        .find(|a| matches_rule(&a.process, exe_path, exe_name))
        .map(|a| PendingAction {
            process: a.process.clone(),
            combo: a.combo.clone(),
            delay_ms: a.effective_delay_ms(),
            force_focus,
        })
}

/// Inject the rule's combo after its 延迟触发, on a short-lived thread so the
/// message pump's shell notifications are never blocked while waiting.
///
/// At the end of the delay the foreground is re-checked against the process that
/// triggered the rule:
/// - still the same (or undeterminable) → send;
/// - moved on → skip, or (when 抢回焦点 is on) best-effort pull the target back
///   and send. Every outcome is logged with the rule's identity.
fn send_later(rule: PendingAction, owner_pid: Option<u32>, raw_hwnd: isize) {
    let _ = std::thread::Builder::new()
        .name("auto-send".into())
        .spawn(move || {
            let label = rule.label();
            if rule.delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(rule.delay_ms));
            }

            let target = describe_process(owner_pid);
            let same = match (owner_pid, foreground_pid()) {
                (Some(expected), Some(current)) => expected == current,
                // If either side can't be resolved, don't block the send.
                _ => true,
            };
            if !same {
                let current = describe_process(foreground_pid());
                if !rule.force_focus {
                    eprintln!(
                        "[automation] rule \"{label}\": skipped after {} ms — foreground is {current}, expected {target} \
                         (enable 抢回焦点 to force it back)",
                        rule.delay_ms
                    );
                    return;
                }
                eprintln!(
                    "[automation] rule \"{label}\": foreground is {current}, expected {target} — forcing it back"
                );
                let Some(window) = target_window(raw_hwnd, owner_pid) else {
                    eprintln!(
                        "[automation] rule \"{label}\": no usable {target} window is left; skipped"
                    );
                    return;
                };
                if !force_foreground(window) {
                    eprintln!(
                        "[automation] rule \"{label}\": Windows refused the foreground change; skipped"
                    );
                    return;
                }
                eprintln!("[automation] rule \"{label}\": foreground restored, sending");
            }

            if unsafe { send_combo(&rule.combo) } {
                eprintln!(
                    "[automation] rule \"{label}\": sent after {} ms to {target}",
                    rule.delay_ms
                );
            } else {
                eprintln!("[automation] rule \"{label}\": not sent (unusable shortcut)");
            }
        });
}

/// "name.exe (pid 1234)" for logs — falls back to the bare pid.
fn describe_process(pid: Option<u32>) -> String {
    let Some(pid) = pid else { return "an unknown process".into() };
    match unsafe { exe_of_pid(pid) } {
        Some((_, name)) => format!("{name} (pid {pid})"),
        None => format!("pid {pid}"),
    }
}

/// The window to pull back: the recorded one while it is still alive and owned
/// by `pid`, otherwise any visible titled window of that process.
fn target_window(raw_hwnd: isize, pid: Option<u32>) -> Option<HWND> {
    use windows::Win32::UI::WindowsAndMessaging::IsWindow;

    let hwnd = HWND(raw_hwnd as *mut _);
    if unsafe { IsWindow(Some(hwnd)) }.as_bool() && (pid.is_none() || pid_of_hwnd(hwnd) == pid) {
        return Some(hwnd);
    }
    pid.and_then(find_window_of_pid)
}

/// The first visible, titled top-level window owned by `pid`.
fn find_window_of_pid(pid: u32) -> Option<HWND> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    let mut search = PidSearch { pid, found: None };
    let ptr: *mut PidSearch = &mut search;
    unsafe {
        let _ = EnumWindows(Some(enum_pid_window), LPARAM(ptr as isize));
    }
    search.found
}

/// State passed through `EnumWindows` while looking for a pid's window.
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

/// Best-effort foreground steal.
///
/// Windows refuses `SetForegroundWindow` from a background process unless it
/// looks like the "last input" owner, so two standard workarounds are applied:
/// an ALT tap (which makes this process the last-input one) and attaching our
/// input queue to the current foreground thread. This is best-effort by design
/// — an elevated foreground window (a UAC prompt) will still refuse, which is
/// reported to the caller.
fn force_foreground(hwnd: HWND) -> bool {
    use windows::Win32::System::Threading::{AttachThreadInput, GetCurrentThreadId};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
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
        std::thread::sleep(Duration::from_millis(60));
        GetForegroundWindow() == hwnd
    }
}

/// A bare ALT tap: harmless in practice, and it makes this process the
/// "last input" owner so the following `SetForegroundWindow` is allowed.
fn tap_alt() {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };

    let mut inputs: [INPUT; 2] = unsafe { std::mem::zeroed() };
    for (i, up) in [(0usize, false), (1usize, true)] {
        inputs[i].r#type = INPUT_KEYBOARD;
        inputs[i].Anonymous.ki = KEYBDINPUT {
            wVk: VIRTUAL_KEY(vk::MENU),
            wScan: 0,
            dwFlags: if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) },
            time: 0,
            dwExtraInfo: 0,
        };
    }
    let _ = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
}

/// The pid owning a window, or `None` when it can't be resolved.
fn pid_of_hwnd(hwnd: HWND) -> Option<u32> {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    (pid != 0).then_some(pid)
}

/// The pid owning the current foreground window.
fn foreground_pid() -> Option<u32> {
    use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0.is_null() {
        return None;
    }
    pid_of_hwnd(hwnd)
}

/// Match a configured `process` (full path or bare file name) against an app's
/// resolved executable. Case-insensitive; a bare name matches the file name
/// (with or without its extension), a path-like value must equal the full path.
fn matches_rule(process: &str, exe_path: &str, exe_name: &str) -> bool {
    if process.is_empty() {
        return false;
    }
    let cfg = process.to_ascii_lowercase();
    if cfg == exe_path.to_ascii_lowercase() || cfg == exe_name.to_ascii_lowercase() {
        return true;
    }
    // Also accept the bare stem ("notepad" ↔ "notepad.exe").
    if let Some(dot) = exe_name.rfind('.') {
        if cfg == exe_name[..dot].to_ascii_lowercase() {
            return true;
        }
    }
    false
}

/// Map a parsed hotkey `Code` to a Windows `VIRTUAL_KEY`, for the key set the
/// settings pane accepts. `None` = a key we can't synthesize (mark it
/// unsupported at validation time so we never accept a combo we can't send).
fn key_to_vk(code: Code) -> Option<u16> {
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

/// Inject an arbitrary hotkey combo (parsed like the global-toggle shortcut)
/// into the current foreground window via `SendInput`. Down/up ordering mirrors
/// `clipboard::send_ctrl_v`: modifiers down, main key down/up, modifiers up.
unsafe fn send_combo(combo: &str) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::SendInput;

    let Ok(sc) = Shortcut::from_str(combo) else { return false };
    let Some(main_vk) = key_to_vk(sc.key) else {
        return false;
    };
    let modifiers = [Modifiers::CONTROL, Modifiers::ALT, Modifiers::SHIFT, Modifiers::SUPER];

    let mut inputs: Vec<INPUT> = Vec::with_capacity(modifiers.len() * 2 + 2);
    let keydown = |inputs: &mut Vec<INPUT>, vkk: u16| push_key(inputs, vkk, false);
    let keyup = |inputs: &mut Vec<INPUT>, vkk: u16| push_key(inputs, vkk, true);

    for m in modifiers {
        if sc.mods.contains(m) {
            keydown(&mut inputs, mod_vk(m));
        }
    }
    keydown(&mut inputs, main_vk);
    keyup(&mut inputs, main_vk);
    for m in modifiers.iter().rev() {
        if sc.mods.contains(*m) {
            keyup(&mut inputs, mod_vk(*m));
        }
    }

    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    true
}

unsafe fn push_key(inputs: &mut Vec<INPUT>, vkk: u16, up: bool) {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, VIRTUAL_KEY,
    };
    let mut input: INPUT = std::mem::zeroed();
    input.r#type = INPUT_KEYBOARD;
    input.Anonymous.ki = KEYBDINPUT {
        wVk: VIRTUAL_KEY(vkk),
        wScan: 0,
        dwFlags: if up {
            KEYEVENTF_KEYUP
        } else {
            KEYBD_EVENT_FLAGS(0)
        },
        time: 0,
        dwExtraInfo: 0,
    };
    inputs.push(input);
}

/// Validate a 自动动作 hotkey in the settings page: parse it, require at least
/// one modifier, and reject keys we cannot synthesize. No OS probe, not a
/// global-hotkey registration.
#[tauri::command]
pub fn validate_auto_combo(combo: String) -> AutoComboCheck {
    let sc = match Shortcut::from_str(&combo) {
        Ok(sc) => sc,
        Err(_) => return AutoComboCheck { ok: false, reason: Some("invalid".into()) },
    };
    if sc.mods.is_empty() {
        return AutoComboCheck { ok: false, reason: Some("need_modifier".into()) };
    }
    if key_to_vk(sc.key).is_none() {
        return AutoComboCheck { ok: false, reason: Some("unsupported".into()) };
    }
    AutoComboCheck { ok: true, reason: None }
}

// ---------------------------------------------------------------------------
// 自动化 → 「测试」: fire one rule on demand, ignoring the window-trigger rules
// ---------------------------------------------------------------------------

/// Outcome of 自动化 → 「测试」.
#[derive(serde::Serialize)]
pub struct TestRuleResult {
    pub ok: bool,
    /// Machine key when `!ok`: `not_running` | `focus_failed` | `invalid_combo`.
    pub reason: Option<String>,
    /// What the test resolved to — the matched window (`name (pid N)`) on
    /// success, otherwise the configured program.
    pub detail: String,
}

/// 自动化 → 「测试」: press this rule's hotkey right now.
///
/// Deliberately ignores the normal trigger conditions — the rule does not have
/// to be a freshly-created window, the master switch is not consulted, and the
/// rule's 延迟触发 is skipped — so a rule can be checked against an app that is
/// already running. The target window is brought to the foreground first: a
/// keystroke only reaches the focused window, and a test must never type into
/// whatever happens to be in front.
#[tauri::command]
pub async fn test_automation_rule(process: String, combo: String) -> TestRuleResult {
    tauri::async_runtime::spawn_blocking(move || test_rule_blocking(process, combo))
        .await
        .unwrap_or_else(|_| TestRuleResult {
            ok: false,
            reason: Some("internal".into()),
            detail: String::new(),
        })
}

fn test_rule_blocking(process: String, combo: String) -> TestRuleResult {
    // A combo we cannot synthesize can never be tested.
    let sendable = match Shortcut::from_str(&combo) {
        Ok(sc) => !sc.mods.is_empty() && key_to_vk(sc.key).is_some(),
        Err(_) => false,
    };
    if !sendable {
        return TestRuleResult {
            ok: false,
            reason: Some("invalid_combo".into()),
            detail: combo,
        };
    }

    let Some((hwnd, name, pid)) = find_window_for_rule(&process) else {
        return TestRuleResult {
            ok: false,
            reason: Some("not_running".into()),
            detail: process,
        };
    };
    let target = format!("{name} (pid {pid})");

    if !force_foreground(hwnd) {
        return TestRuleResult {
            ok: false,
            reason: Some("focus_failed".into()),
            detail: target,
        };
    }
    if unsafe { send_combo(&combo) } {
        TestRuleResult { ok: true, reason: None, detail: target }
    } else {
        TestRuleResult {
            ok: false,
            reason: Some("invalid_combo".into()),
            detail: target,
        }
    }
}

/// The first visible, titled window whose executable matches a rule's program.
fn find_window_for_rule(process: &str) -> Option<(HWND, String, u32)> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    let mut search = MatchSearch { process, found: None };
    let ptr: *mut MatchSearch = &mut search;
    unsafe {
        let _ = EnumWindows(Some(enum_match_window), LPARAM(ptr as isize));
    }
    search.found
}

/// State passed through `EnumWindows` while hunting for a rule's window.
struct MatchSearch<'a> {
    process: &'a str,
    found: Option<(HWND, String, u32)>,
}

/// `EnumWindows` callback: stop at the first visible, titled window whose
/// executable matches the rule's program.
unsafe extern "system" fn enum_match_window(
    hwnd: HWND,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::core::BOOL {
    use windows::Win32::Foundation::{FALSE, TRUE};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowTextLengthW, IsWindowVisible};

    let search = unsafe { &mut *(lparam.0 as *mut MatchSearch) };
    if search.found.is_some() {
        return FALSE;
    }
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return TRUE;
    }
    if unsafe { GetWindowTextLengthW(hwnd) } <= 0 {
        return TRUE;
    }
    let Some(pid) = pid_of_hwnd(hwnd) else {
        return TRUE;
    };
    let Some((path, name)) = (unsafe { exe_of_pid(pid) }) else {
        return TRUE;
    };
    if matches_rule(search.process, &path, &name) {
        search.found = Some((hwnd, name, pid));
        return FALSE;
    }
    TRUE
}

// ---------------------------------------------------------------------------
// 自动化 → 「选择」: pick from the programs that currently have windows
// ---------------------------------------------------------------------------

/// A program that currently owns at least one visible top-level window.
#[derive(serde::Serialize)]
pub struct WindowProgram {
    /// Full image path of the executable.
    pub path: String,
    /// Executable file name — what a rule usually stores.
    pub name: String,
    /// A representative window title, shown as context in the picker.
    pub title: String,
    /// How many top-level windows this executable owns.
    pub windows: u32,
}

/// One window found during enumeration, before aggregation.
struct RawWindow {
    path: String,
    name: String,
    title: String,
}

/// The programs that currently have visible top-level windows, so the settings
/// pane can offer a picker instead of making the user type an executable name.
///
/// Mirrors the Alt+Tab rule set — visible, titled, non-tool windows — and drops
/// Lume's own windows. Async + `spawn_blocking`: the enumeration touches other
/// processes' windows, so it must never run on the main thread.
#[tauri::command]
pub async fn list_window_programs() -> Vec<WindowProgram> {
    tauri::async_runtime::spawn_blocking(collect_window_programs)
        .await
        .unwrap_or_default()
}

fn collect_window_programs() -> Vec<WindowProgram> {
    use windows::Win32::Foundation::LPARAM;
    use windows::Win32::UI::WindowsAndMessaging::EnumWindows;

    let mut found: Vec<RawWindow> = Vec::new();
    let ptr: *mut Vec<RawWindow> = &mut found;
    unsafe {
        let _ = EnumWindows(Some(enum_window), LPARAM(ptr as isize));
    }
    let own = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    aggregate_window_programs(found, own.as_deref())
}

/// Aggregate raw windows into one entry per executable, dropping the
/// launcher's own process and sorting by file name. Pure — unit-tested.
fn aggregate_window_programs(found: Vec<RawWindow>, own_exe: Option<&str>) -> Vec<WindowProgram> {
    let own = own_exe.map(|p| p.to_ascii_lowercase());
    let mut by_path: HashMap<String, WindowProgram> = HashMap::new();
    for w in found {
        let key = w.path.to_ascii_lowercase();
        if Some(&key) == own.as_ref() {
            continue;
        }
        by_path
            .entry(key)
            .and_modify(|e| e.windows += 1)
            .or_insert(WindowProgram {
                path: w.path,
                name: w.name,
                title: w.title,
                windows: 1,
            });
    }
    let mut out: Vec<WindowProgram> = by_path.into_values().collect();
    out.sort_by_key(|p| p.name.to_ascii_lowercase());
    out
}

/// `EnumWindows` callback: keep visible, titled, non-tool windows and record
/// their owning executable.
unsafe extern "system" fn enum_window(hwnd: HWND, lparam: windows::Win32::Foundation::LPARAM) -> windows::core::BOOL {
    use windows::Win32::Foundation::TRUE;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible, GWL_EXSTYLE,
        WS_EX_TOOLWINDOW,
    };

    let found = unsafe { &mut *(lparam.0 as *mut Vec<RawWindow>) };
    if !unsafe { IsWindowVisible(hwnd) }.as_bool() {
        return TRUE;
    }
    // Tool windows are tray helpers / invisible owners — Alt+Tab hides them too.
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) } as u32;
    if ex_style & WS_EX_TOOLWINDOW.0 != 0 {
        return TRUE;
    }
    let len = unsafe { GetWindowTextLengthW(hwnd) };
    if len <= 0 {
        return TRUE;
    }
    // GetWindowTextW reads the cached caption for other processes' windows, so
    // a hung target cannot block this call.
    let mut buf = vec![0u16; len as usize + 1];
    let written = unsafe { GetWindowTextW(hwnd, &mut buf) }.max(0) as usize;
    if written == 0 {
        return TRUE;
    }
    let title = String::from_utf16_lossy(&buf[..written]);
    let Some((path, name)) = (unsafe { exe_of_hwnd(hwnd) }) else {
        return TRUE;
    };
    found.push(RawWindow { path, name, title });
    TRUE
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::AutoAction;

    #[test]
    fn matches_bare_name_case_insensitively() {
        assert!(matches_rule("notepad.exe", r"C:\Windows\System32\notepad.exe", "notepad.exe"));
        assert!(matches_rule("NOTEPAD.EXE", r"C:\Windows\System32\notepad.exe", "notepad.exe"));
        assert!(matches_rule("Notepad", r"C:\Windows\System32\notepad.exe", "notepad.exe"));
        assert_eq!(matches_rule("powerpnt.exe", r"C:\Windows\System32\notepad.exe", "notepad.exe"), false);
    }

    #[test]
    fn matches_full_path() {
        assert!(matches_rule(
            r"C:\Games\MyApp.exe",
            r"C:\Games\MyApp.exe",
            "MyApp.exe"
        ));
        assert!(matches_rule(
            r"c:\games\myapp.exe",
            r"C:\Games\MyApp.exe",
            "MyApp.exe"
        ));
        assert_eq!(matches_rule(
            r"C:\Other\MyApp.exe",
            r"C:\Games\MyApp.exe",
            "MyApp.exe"
        ), false);
    }

    #[test]
    fn empty_rule_never_matches() {
        assert_eq!(matches_rule("", r"C:\a.exe", "a.exe"), false);
    }

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

    #[test]
    fn validate_requires_modifier() {
        let r = validate_auto_combo("V".into());
        assert!(!r.ok);
        assert_eq!(r.reason.as_deref(), Some("need_modifier"));
    }

    #[test]
    fn validate_accepts_supported_combo_and_rejects_bad_keys() {
        assert!(validate_auto_combo("Ctrl+Alt+S".into()).ok);
        assert!(validate_auto_combo("Shift+F5".into()).ok);
        let unsupported = validate_auto_combo("Ctrl+MediaPlayPause".into());
        assert!(!unsupported.ok);
        assert_eq!(unsupported.reason.as_deref(), Some("unsupported"));
        let invalid = validate_auto_combo("not a combo".into());
        assert!(!invalid.ok);
        assert_eq!(invalid.reason.as_deref(), Some("invalid"));
    }

    /// AutoAction is deliberately used here to assert the settings type stays
    /// constructible from the automation module (kept out of dead-code paths).
    #[test]
    fn rule_type_is_constructible() {
        let a = AutoAction {
            process: "x.exe".into(),
            combo: "Ctrl+S".into(),
            enabled: true,
            delay_ms: 120,
        };
        assert!(a.enabled);
    }

    fn raw(path: &str, name: &str, title: &str) -> RawWindow {
        RawWindow { path: path.into(), name: name.into(), title: title.into() }
    }

    /// One entry per executable, window counts summed, Lume itself dropped, and
    /// results sorted by file name.
    #[test]
    fn window_programs_aggregate_dedupe_and_skip_own_process() {
        let found = vec![
            raw(r"C:\Apps\Zed.exe", "Zed.exe", "zed"),
            raw(r"C:\Windows\notepad.exe", "notepad.exe", "a.txt - Notepad"),
            raw(r"C:\Windows\notepad.exe", "notepad.exe", "b.txt - Notepad"),
            raw(r"c:\windows\NOTEPAD.exe", "NOTEPAD.exe", "case-insensitive same app"),
            raw(r"C:\Lume\lume.exe", "lume.exe", "Lume"),
        ];
        let out = aggregate_window_programs(found, Some(r"C:\Lume\lume.exe"));
        assert_eq!(out.len(), 2, "lume dropped, case variants merged");
        assert_eq!(out[0].name, "notepad.exe", "sorted by name");
        assert_eq!(out[0].windows, 3);
        assert_eq!(out[1].name, "Zed.exe");
        assert_eq!(out[1].windows, 1);
        // No own-process entry survives even when the path case differs.
        let other = aggregate_window_programs(
            vec![raw(r"C:\Lume\LUME.EXE", "LUME.EXE", "Lume")],
            Some(r"C:\Lume\lume.exe"),
        );
        assert!(other.is_empty());
    }

    /// Without an own-exe hint nothing is filtered.
    #[test]
    fn window_programs_keep_everything_without_own_hint() {
        let out = aggregate_window_programs(vec![raw(r"C:\a.exe", "a.exe", "A")], None);
        assert_eq!(out.len(), 1);
    }
}