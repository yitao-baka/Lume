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
        }
    }
}

/// Return the active toggle shortcut string, e.g. "Alt+Space" ("" if none).
#[tauri::command]
pub fn get_hotkey(state: State<ActiveHotkey>) -> String {
    state.0.lock().unwrap().clone().unwrap_or_default()
}

/// Result of validating a custom hotkey in the settings page.
#[derive(Serialize)]
pub struct HotkeyCheck {
    pub ok: bool,
    /// Machine key for a localized message: `need_modifier` | `conflict_lume`
    /// | `taken` | `invalid`.
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
            false
        }
    }
}
