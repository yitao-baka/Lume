//! Global hotkey: toggles the launcher window.
//!
//! Exactly one shortcut is registered — the configured toggle combo from
//! settings (`hotkeys.toggle`, default `Alt+Space`). A combo another process
//! already owns (uTools, PowerToys Run, …) is reported as a conflict, never
//! silently swapped for a different one: the user frees the combo or records
//! a new one in 设置 → 快捷键, where `validate_hotkey` checks it live.
//!
//! The active shortcut is stored in [`ActiveHotkey`] and exposed to the
//! frontend via the `get_hotkey` command so the UI can show what to press.

use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{Shortcut, ShortcutState};

/// State holding the shortcut currently registered, if any.
pub struct ActiveHotkey(Mutex<Option<String>>);

impl Default for ActiveHotkey {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// A release build has no console, so a registration conflict must reach the
/// user through the shell. Keep the wording to the system's primary language
/// (the tray uses the same simple split).
fn notify_unavailable(combo: &str) {
    use windows::Win32::Globalization::GetUserDefaultUILanguage;
    let zh = unsafe { (GetUserDefaultUILanguage() & 0x3FF) == 0x04 };
    let body = if zh {
        format!(
            "呼出快捷键 {combo} 被其他程序占用。请从托盘打开设置 → 快捷键，或先释放该组合键。"
        )
    } else {
        format!(
            "The shortcut {combo} is already in use. Open Settings → Hotkeys from the tray, or free the combo."
        )
    };
    let _ = crate::notify::notify("Lume", &body);
}

/// True when `shortcut` is the one we successfully registered.
fn is_active(app: &AppHandle, shortcut: &Shortcut) -> bool {
    let active = app.state::<ActiveHotkey>().0.lock().unwrap().clone();
    match active {
        Some(s) => Shortcut::from_str(&s).map(|hk| *shortcut == hk).unwrap_or(false),
        None => false,
    }
}

/// Build the global-shortcut plugin with the launcher toggle handler.
pub fn build() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, shortcut, event| {
            if event.state() == ShortcutState::Pressed && is_active(app, shortcut) {
                let _ = crate::window::toggle_launcher(app.clone());
            }
        })
        .build()
}

/// Register the configured toggle shortcut — a single attempt, no fallback.
/// If the OS rejects it (another process owns the combo) nothing is
/// registered and the failure is logged; the user resolves the conflict in
/// 设置 → 快捷键 (the tray keeps that page reachable).
pub fn register(app: &tauri::App, combo: &str) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let hotkey_state = app.state::<ActiveHotkey>();
    let mut active = hotkey_state.0.lock().unwrap();
    match app.global_shortcut().register(combo) {
        Ok(_) => {
            *active = Some(combo.to_string());
            eprintln!("[hotkey] registered {combo}");
        }
        Err(e) => {
            eprintln!("[hotkey] {combo} unavailable: {e}");
            eprintln!("[hotkey] no toggle shortcut — free the combo or change it in Settings");
            notify_unavailable(combo);
        }
    }
}

/// Return the active toggle shortcut string, e.g. "Alt+Space" ("" if none).
#[tauri::command]
pub fn get_hotkey(state: State<ActiveHotkey>) -> String {
    state.0.lock().unwrap().clone().unwrap_or_default()
}

/// Result of validating a custom hotkey in the settings page.
#[derive(Debug, Serialize)]
pub struct HotkeyCheck {
    pub ok: bool,
/// Machine key for a localized message: `need_modifier` | `conflict_lume`
/// | `taken` | `reserved` | `invalid`.
    pub reason: Option<String>,
}

/// Validate a custom hotkey for the settings page: it must parse, contain at
/// least one modifier (Ctrl/Alt/Shift/Win), not clash with Lume's other slot,
/// and be free on the system — checked by attempting registration then
/// unregistering. Shortcuts Lume already owns are never disturbed.
#[tauri::command]
pub fn validate_hotkey(combo: String, other: String, app: AppHandle) -> HotkeyCheck {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let sc = match Shortcut::from_str(&combo) {
        Ok(sc) => sc,
        Err(_) => return HotkeyCheck { ok: false, reason: Some("invalid".into()) },
    };
    if sc.mods.is_empty() {
        return HotkeyCheck { ok: false, reason: Some("need_modifier".into()) };
    }
    if combo.eq_ignore_ascii_case(&other) {
        return HotkeyCheck { ok: false, reason: Some("conflict_lume".into()) };
    }
    if app.global_shortcut().is_registered(combo.as_str()) {
        // Already ours — free system-wise; conflict is only against `other`.
        return HotkeyCheck { ok: true, reason: None };
    }
    match app.global_shortcut().register(combo.as_str()) {
        Ok(()) => {
            let _ = app.global_shortcut().unregister(combo.as_str());
            HotkeyCheck { ok: true, reason: None }
        }
        Err(_) => HotkeyCheck { ok: false, reason: Some("taken".into()) },
    }
}

/// Validate the in-launcher mode-switch shortcut. Unlike the global toggle,
/// this one may be a bare key (the default is Tab) and never touches the
/// system-wide RegisterHotKey namespace. It only needs to parse, stay free of
/// the other Lume slot, and avoid keys the launcher already reserves.
#[tauri::command]
pub fn validate_mode_hotkey(combo: String, other: String) -> HotkeyCheck {
    if Shortcut::from_str(&combo).is_err() {
        return HotkeyCheck { ok: false, reason: Some("invalid".into()) };
    }
    if combo.eq_ignore_ascii_case(&other) {
        return HotkeyCheck { ok: false, reason: Some("conflict_lume".into()) };
    }
    let bare = combo.trim().to_ascii_lowercase();
    if matches!(
        bare.as_str(),
        "escape"
            | "enter"
            | "f6"
            | "arrowup"
            | "arrowdown"
            | "arrowleft"
            | "arrowright"
            | "home"
            | "end"
            | "pageup"
            | "pagedown"
            | "backspace"
            | "delete"
    ) {
        return HotkeyCheck { ok: false, reason: Some("reserved".into()) };
    }
    HotkeyCheck { ok: true, reason: None }
}

/// Apply a new toggle hotkey (used on settings save). Unregisters the current
/// one and registers `combo`; on failure it reverts to the previous shortcut.
pub fn apply(app: &AppHandle, combo: &str) -> bool {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let state = app.state::<ActiveHotkey>();
    let mut active = state.0.lock().unwrap();
    if active.as_deref() == Some(combo) {
        return true; // already active
    }
    if let Some(cur) = active.as_deref() {
        let _ = app.global_shortcut().unregister(cur);
    }
    match app.global_shortcut().register(combo) {
        Ok(()) => {
            *active = Some(combo.to_string());
            true
        }
        Err(_) => {
            if let Some(cur) = active.as_deref() {
                let _ = app.global_shortcut().register(cur);
            }
            notify_unavailable(combo);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_hotkey_accepts_a_bare_key() {
        let check = validate_mode_hotkey("K".into(), "Alt+Space".into());
        assert!(check.ok, "single-key mode switch must be valid: {check:?}");
    }

    #[test]
    fn mode_hotkey_rejects_reserved_and_duplicate_keys() {
        assert_eq!(
            validate_mode_hotkey("Escape".into(), "Alt+Space".into()).reason.as_deref(),
            Some("reserved"),
        );
        assert_eq!(
            validate_mode_hotkey("Alt+Space".into(), "Alt+Space".into()).reason.as_deref(),
            Some("conflict_lume"),
        );
    }
}
