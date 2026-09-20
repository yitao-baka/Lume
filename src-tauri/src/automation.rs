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
use tauri_plugin_global_shortcut::Shortcut;
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, GetMessageW, RegisterClassExW, RegisterShellHookWindow,
    RegisterWindowMessageW, HSHELL_WINDOWACTIVATED, HSHELL_WINDOWCREATED, HSHELL_WINDOWDESTROYED,
    HWND_MESSAGE, WINDOW_STYLE, WINDOW_EX_STYLE, WNDCLASS_STYLES, WNDCLASSEXW, HCURSOR, HICON, MSG,
};

use crate::agent::{self, reason};
use crate::input;

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
    /// Send through the elevated agent when it is available (settings 自动化 →
    /// 使用提权代理). Snapshot at trigger time, like the rest of the rule.
    use_agent: bool,
    /// Keep the agent alive past its idle timeout (settings 自动化 →
     /// 登录后常驻代理).
    agent_resident: bool,
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
            let Some((exe_path, exe_name)) = input::exe_of_hwnd(hwnd) else { return };
            let Some(rule) = rules_for(app, &exe_path, &exe_name) else { return };
            eprintln!(
                "[automation] rule \"{}\": armed for window {raw_hwnd:#x} ({}), delay {} ms{}{}",
                rule.label(),
                describe_process(input::pid_of_hwnd(hwnd)),
                rule.delay_ms,
                if rule.force_focus { ", force-focus on" } else { "" },
                if rule.use_agent { ", agent on" } else { "" }
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
            let pid = input::pid_of_hwnd(hwnd);
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
    let use_agent = settings.automation.use_agent;
    let agent_resident = settings.automation.agent_resident;
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
            use_agent,
            agent_resident,
        })
}

/// Inject the rule's combo after its 延迟触发, on a short-lived thread so the
/// message pump's shell notifications are never blocked while waiting.
///
/// Two paths, in order of preference:
/// 1. **The elevated agent** (`agent.rs`) when the user has it switched on and
///    registered — the only path that can reach a higher-integrity target,
///    because `SendInput` is subject to UIPI. It applies the delay itself and
///    re-checks the foreground at the moment of sending.
/// 2. **In-process `SendInput`** (the original behaviour) when the agent is
///    off or unavailable. This path is now honest about failure: a blocked
///    `SendInput` reports zero events, and a target that runs elevated while
///    we do not is logged as `needs_agent` instead of a bare "sent".
///
/// Every outcome is logged with the rule's identity.
fn send_later(rule: PendingAction, owner_pid: Option<u32>, raw_hwnd: isize) {
    let _ = std::thread::Builder::new()
        .name("auto-send".into())
        .spawn(move || {
            let label = rule.label();
            let target = describe_process(owner_pid);
            let Some(pid) = owner_pid else {
                eprintln!("[automation] rule \"{label}\": the target process is gone; skipped");
                return;
            };

            // `ensure` pings first, so an already-running agent is used even if
            // the task is not registered (e.g. one started by hand for testing).
            if rule.use_agent && agent::ensure(agent::STARTUP_WAIT) {
                if rule.agent_resident {
                    // 常驻 mode: keep the helper alive past its idle timeout.
                    agent::stay();
                }
                match agent::inject(&rule.combo, pid, raw_hwnd, rule.delay_ms, rule.force_focus) {
                    Ok(sent) => eprintln!(
                        "[automation] rule \"{label}\": sent after {} ms to {target} via the agent ({sent} events)",
                        rule.delay_ms
                    ),
                    Err(key) => eprintln!(
                        "[automation] rule \"{label}\": not sent after {} ms to {target} via the agent — {key}",
                        rule.delay_ms
                    ),
                }
                return;
            }
            if rule.use_agent {
                eprintln!(
                    "[automation] rule \"{label}\": no elevation agent available — falling back to an in-process send \
                     (register it in 设置/系统 to reach elevated programs)"
                );
            }

            if rule.delay_ms > 0 {
                std::thread::sleep(Duration::from_millis(rule.delay_ms));
            }

            let same = match (Some(pid), input::foreground_pid()) {
                (Some(expected), Some(current)) => expected == current,
                // If either side can't be resolved, don't block the send.
                _ => true,
            };
            if !same {
                let current = describe_process(input::foreground_pid());
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
                let Some(window) = input::target_window(raw_hwnd, Some(pid)) else {
                    eprintln!(
                        "[automation] rule \"{label}\": no usable {target} window is left; skipped"
                    );
                    return;
                };
                if !input::force_foreground(window) {
                    eprintln!(
                        "[automation] rule \"{label}\": Windows refused the foreground change; skipped"
                    );
                    return;
                }
                eprintln!("[automation] rule \"{label}\": foreground restored, sending");
            }

            match input::send_combo(&rule.combo) {
                Ok(0) => {
                    // `SendInput` inserts nothing when the input is blocked —
                    // UIPI against a higher-integrity foreground window is the
                    // usual cause and cannot be told apart from other blocks.
                    if input::is_process_elevated(pid).unwrap_or(false) {
                        eprintln!(
                            "[automation] rule \"{label}\": {target} runs elevated and this process does not, \
                             so Windows dropped the input ({}) — register the elevation agent in 设置/系统",
                            reason::NEEDS_AGENT
                        );
                    } else {
                        eprintln!(
                            "[automation] rule \"{label}\": Windows blocked the input ({})",
                            reason::BLOCKED
                        );
                    }
                }
                Ok(sent) => eprintln!(
                    "[automation] rule \"{label}\": sent after {} ms to {target} ({sent} events)",
                    rule.delay_ms
                ),
                Err(input::ComboError::BadCombo) => {
                    eprintln!("[automation] rule \"{label}\": not sent ({})", reason::BAD_COMBO)
                }
                Err(input::ComboError::Unsupported) => eprintln!(
                    "[automation] rule \"{label}\": not sent ({})",
                    reason::UNSUPPORTED
                ),
            }
        });
}

/// "name.exe (pid 1234)" for logs — falls back to the bare pid.
fn describe_process(pid: Option<u32>) -> String {
    let Some(pid) = pid else { return "an unknown process".into() };
    match input::exe_of_pid(pid) {
        Some((_, name)) => format!("{name} (pid {pid})"),
        None => format!("pid {pid}"),
    }
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
    if input::key_to_vk(sc.key).is_none() {
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
    /// Machine key when `!ok`: `not_running` | `focus_failed` | `invalid_combo`,
    /// plus every `agent::reason` key the send path can report (notably
    /// `needs_agent` when the target runs elevated and the agent is absent).
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
///
/// The agent is tried first when it is switched on: the settings window is
/// **not** elevated, so an in-process fallback can never verify a rule whose
/// target runs elevated.
#[tauri::command]
pub async fn test_automation_rule(
    app: AppHandle,
    process: String,
    combo: String,
) -> TestRuleResult {
    let use_agent = app
        .state::<crate::settings::SettingsState>()
        .current()
        .automation
        .use_agent;
    tauri::async_runtime::spawn_blocking(move || test_rule_blocking(process, combo, use_agent))
        .await
        .unwrap_or_else(|_| TestRuleResult {
            ok: false,
            reason: Some("internal".into()),
            detail: String::new(),
        })
}

fn test_rule_blocking(process: String, combo: String, use_agent: bool) -> TestRuleResult {
    // A combo we cannot synthesize can never be tested.
    let sendable = match Shortcut::from_str(&combo) {
        Ok(sc) => !sc.mods.is_empty() && input::key_to_vk(sc.key).is_some(),
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

    // The agent focuses the target itself, so `force_focus` is always true
    // here — a test must not depend on the user having focused the window.
    if use_agent && agent::ensure(agent::STARTUP_WAIT) {
        return match agent::inject(&combo, pid, hwnd.0 as isize, 0, true) {
            Ok(_) => TestRuleResult { ok: true, reason: None, detail: target },
            Err(key) => TestRuleResult {
                ok: false,
                reason: Some(key),
                detail: target,
            },
        };
    }

    // No agent: the original in-process path, now reporting a block honestly.
    let elevated_target = input::is_process_elevated(pid).unwrap_or(false);
    if elevated_target && use_agent {
        // The agent is wanted but could not be started — say so rather than
        // reporting a failure the user cannot act on.
        return TestRuleResult {
            ok: false,
            reason: Some(reason::UNAVAILABLE.into()),
            detail: target,
        };
    }
    if elevated_target {
        return TestRuleResult {
            ok: false,
            reason: Some(reason::NEEDS_AGENT.into()),
            detail: target,
        };
    }

    if !input::force_foreground(hwnd) {
        return TestRuleResult {
            ok: false,
            reason: Some("focus_failed".into()),
            detail: target,
        };
    }
    match input::send_combo(&combo) {
        Ok(0) => TestRuleResult {
            ok: false,
            reason: Some(reason::BLOCKED.into()),
            detail: target,
        },
        Ok(_) => TestRuleResult { ok: true, reason: None, detail: target },
        Err(_) => TestRuleResult {
            ok: false,
            reason: Some("invalid_combo".into()),
            detail: target,
        },
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
    let Some(pid) = input::pid_of_hwnd(hwnd) else {
        return TRUE;
    };
    let Some((path, name)) = input::exe_of_pid(pid) else {
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
    let Some((path, name)) = input::exe_of_hwnd(hwnd) else {
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

    /// The key table itself now lives with the injection primitives
    /// (`input.rs`), which owns its own coverage test.
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