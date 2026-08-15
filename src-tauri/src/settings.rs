//! Settings — persisted in `settings/settings.toml` under the writable data
//! root (`paths::base_dir()`, docs/SETTINGS.md, docs/NORMS.md).
//!
//! `<base>/settings/` holds three files:
//! - `default.toml`  — factory defaults, written once on first run, never
//!   modified afterwards (the source for "restore defaults").
//! - `settings.toml` — the only file the app reads; created by copying
//!   `default.toml` when missing.
//! - `backup.toml`   — the previous `settings.toml`, written before every
//!   save / apply / import / restore-default.
//!
//! All functions take the base directory explicitly so unit tests can point
//! at a temp dir without touching the real portable layout.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Emitter, Manager, State};

use crate::paths;

/// The full settings surface, matching the schema in `docs/SETTINGS.md`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub meta: Meta,
    pub appearance: Appearance,
    pub hotkeys: Hotkeys,
    pub index: Index,
    pub clipboard: Clipboard,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
    pub version: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Appearance {
    /// `"system"` | `"en"` | `"zh-CN"` | `"zh-TW"`.
    pub language: String,
    /// `"system"` | `"dark"` | `"light"` — launcher + settings theme.
    #[serde(default = "default_color_mode")]
    pub color_mode: String,
    /// Entry-box edge length in px — the square box wrapping each main-menu
    /// entry (grid columns adapt to fit).
    #[serde(default = "default_entry_size")]
    pub entry_size: u32,
    /// Launcher horizontal length in px.
    pub window_width: u32,
    /// Launcher initial vertical length in px — the cap the content
    /// auto-sizing shrinks toward (the window never exceeds it).
    #[serde(default = "default_window_height")]
    pub window_height: u32,
    /// `"center"` | `"follow-mouse"` | `"top-left"` | `"top-right"` | `"bottom-left"` | `"bottom-right"`.
    pub window_position: String,
    /// Remember the manually-moved window position across shows.
    pub remember_position: bool,
    /// Show the 「最近使用」 bar on the main menu (display-only — recording
    /// always continues, so re-enabling shows the history).
    #[serde(default = "default_show_recent")]
    pub show_recent: bool,
    /// Start the launcher with the 「已固定」 bar expanded (default: collapsed).
    #[serde(default)]
    pub expand_pinned: bool,
    /// Shift+Enter launches the selected app with administrator privileges.
    #[serde(default = "default_shift_enter_admin")]
    pub shift_enter_admin: bool,
    /// Cap for the recent-opens list (stored and displayed).
    #[serde(default = "default_recent_count")]
    pub recent_count: u32,
    /// Custom search placeholder for the apps mode (empty = localized default).
    #[serde(default)]
    pub search_placeholder_apps: String,
    /// Custom search placeholder for the clipboard mode (empty = localized default).
    #[serde(default)]
    pub search_placeholder_clipboard: String,
}

/// Default entry-box edge (matches a ~110px box in the current 6-col grid).
fn default_entry_size() -> u32 {
    110
}

/// Default theme: follow the OS light/dark preference.
fn default_color_mode() -> String {
    "system".into()
}

/// Default max/initial window height (the old fixed 520px auto-size cap).
fn default_window_height() -> u32 {
    520
}

/// The 「最近使用」 bar shows by default.
fn default_show_recent() -> bool {
    true
}

fn default_shift_enter_admin() -> bool {
    true
}

/// Default recent-opens cap (20).
fn default_recent_count() -> u32 {
    20
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hotkeys {
    pub toggle: String,
    pub switch_mode: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Index {
    pub system_dirs: Vec<SystemDir>,
    pub user_dirs: Vec<String>,
    /// User dirs where only `.lnk`/`.exe` are indexed (other files filtered).
    /// Empty = every user dir indexes all files (the default).
    #[serde(default)]
    pub user_dirs_no_files: Vec<String>,
    /// Minutes between user-cache refreshes (startup always refreshes once).
    #[serde(default = "default_refresh_interval")]
    pub cache_refresh_interval_minutes: u32,
}

fn default_refresh_interval() -> u32 {
    60
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SystemDir {
    pub path: String,
    pub enabled: bool,
}

/// Clipboard-history behavior (docs/SETTINGS.md, 剪贴板 settings pane).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Clipboard {
    /// Max history rows kept (pinned items are exempt from pruning).
    #[serde(default = "default_history_cap")]
    pub history_cap: i64,
    /// Record image copies into history.
    #[serde(default = "default_true")]
    pub record_images: bool,
    /// Record file/folder copies (CF_HDROP) into history.
    #[serde(default = "default_true")]
    pub record_files: bool,
    /// Hide the launcher after a paste.
    #[serde(default = "default_true")]
    pub paste_close: bool,
    /// Show the source app name in each entry's second line.
    #[serde(default = "default_true")]
    pub show_source_app: bool,
    /// `"relative"` | `"absolute"` — how timestamps are displayed.
    #[serde(default = "default_time_display")]
    pub time_display: String,
    /// App names (the foreground process display name, e.g. "Chrome") whose
    /// copies are never recorded — password managers, private chats, etc.
    #[serde(default)]
    pub ignore_apps: Vec<String>,
    /// Merge consecutive text copies (within the merge window) into one entry.
    #[serde(default)]
    pub merge_copy: bool,
    /// Merge window in milliseconds (consecutive copies closer than this merge).
    #[serde(default = "default_merge_window")]
    pub merge_window_ms: u64,
    /// Mouse hover selects entries (default off — when off, only a click
    /// selects).
    #[serde(default)]
    pub hover_select: bool,
    /// Sort favorited (pinned) entries to the top of the list.
    #[serde(default)]
    pub favorites_top: bool,
    /// Show the satellite preview window for text / files / images / audio /
    /// video / PDF rows (设置/剪贴板 → 开启预览). Off = the satellite never
    /// appears; inline row thumbnails stay.
    #[serde(default = "default_true")]
    pub preview: bool,
}

/// Default clipboard history cap (200 entries).
fn default_history_cap() -> i64 {
    200
}

/// Default auto-merge window: 1.5 seconds.
fn default_merge_window() -> u64 {
    1500
}

fn default_true() -> bool {
    true
}

/// Default time display: relative ("3 分钟前").
fn default_time_display() -> String {
    "relative".into()
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            meta: Meta { version: 1 },
            appearance: Appearance {
                language: "system".into(),
                color_mode: "system".into(),
                entry_size: 110,
                window_width: 720,
                window_height: 520,
                window_position: "center".into(),
                remember_position: false,
                show_recent: true,
                expand_pinned: false,
                shift_enter_admin: true,
                recent_count: 20,
                search_placeholder_apps: String::new(),
                search_placeholder_clipboard: String::new(),
            },
            hotkeys: Hotkeys {
                toggle: "Alt+Space".into(),
                switch_mode: "Tab".into(),
            },
            index: Index {
                system_dirs: vec![
                    SystemDir {
                        path: "Desktop".into(),
                        enabled: true,
                    },
                    SystemDir {
                        path: "System32".into(),
                        enabled: true,
                    },
                    SystemDir {
                        path: "StartMenu".into(),
                        enabled: false,
                    },
                ],
                user_dirs: Vec::new(),
                user_dirs_no_files: Vec::new(),
                cache_refresh_interval_minutes: 60,
            },
            clipboard: Clipboard {
                history_cap: 200,
                record_images: true,
                record_files: true,
                paste_close: true,
                show_source_app: true,
                time_display: "relative".into(),
                ignore_apps: Vec::new(),
                merge_copy: false,
                merge_window_ms: 1500,
                hover_select: false,
                favorites_top: false,
                preview: true,
            },
        }
    }
}

/// Shared settings state, managed by Tauri.
pub struct SettingsState(Mutex<Settings>);

impl SettingsState {
    /// Clone of the current effective settings.
    pub fn current(&self) -> Settings {
        self.0.lock().unwrap().clone()
    }
}

// ---------------------------------------------------------------------------
// File layout (explicit `base` dir so tests use a temp dir)
// ---------------------------------------------------------------------------

fn settings_dir(base: &Path) -> PathBuf {
    base.join("settings")
}

fn settings_path(base: &Path) -> PathBuf {
    settings_dir(base).join("settings.toml")
}

fn default_path(base: &Path) -> PathBuf {
    settings_dir(base).join("default.toml")
}

fn backup_path(base: &Path) -> PathBuf {
    settings_dir(base).join("backup.toml")
}

/// Prepare `<base>/settings/`: create the dir, write `default.toml` on first
/// run, and materialize `settings.toml` from `default.toml` when missing.
fn ensure_settings_files(base: &Path) -> Result<(), String> {
    let dir = settings_dir(base);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if !default_path(base).exists() {
        let text = toml::to_string_pretty(&Settings::default()).map_err(|e| e.to_string())?;
        fs::write(default_path(base), text).map_err(|e| e.to_string())?;
    }
    if !settings_path(base).exists() {
        let text = fs::read_to_string(default_path(base)).map_err(|e| e.to_string())?;
        fs::write(settings_path(base), text).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Read the effective settings: `settings.toml`, falling back to defaults on
/// any error (missing or corrupt file).
fn read_settings(base: &Path) -> Settings {
    fs::read_to_string(settings_path(base))
        .ok()
        .and_then(|text| toml::from_str(&text).ok())
        .unwrap_or_default()
}

/// Back up the current `settings.toml` to `backup.toml` (falling back to the
/// in-memory settings when the file is absent), then write `s` to
/// `settings.toml`. The single write path for save / apply / import /
/// restore-default.
fn write_settings(base: &Path, s: &Settings, fallback: &Settings) -> Result<(), String> {
    let dir = settings_dir(base);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let previous = match fs::read_to_string(settings_path(base)) {
        Ok(text) => text,
        Err(_) => toml::to_string_pretty(fallback).map_err(|e| e.to_string())?,
    };
    fs::write(backup_path(base), previous).map_err(|e| e.to_string())?;
    let text = toml::to_string_pretty(s).map_err(|e| e.to_string())?;
    fs::write(settings_path(base), text).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

/// Ensure the settings files exist and manage the effective settings state.
pub fn init(app: &App) {
    let base = paths::base_dir();
    let _ = ensure_settings_files(&base);
    let mut settings = read_settings(&base);
    ensure_known_system_dirs(&mut settings);
    app.manage(SettingsState(Mutex::new(settings)));
}

/// The well-known system index dirs. New ones are appended (with defaults) so
/// they appear for settings files written before the option existed.
fn ensure_known_system_dirs(settings: &mut Settings) {
    const KNOWN: [(&str, bool); 3] = [
        ("Desktop", true),
        ("System32", true),
        ("StartMenu", false),
    ];
    for (path, enabled) in KNOWN {
        if !settings.index.system_dirs.iter().any(|d| d.path == path) {
            settings.index.system_dirs.push(SystemDir {
                path: path.to_string(),
                enabled,
            });
        }
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Current effective settings.
#[tauri::command]
pub fn get_settings(state: State<SettingsState>) -> Settings {
    state.0.lock().unwrap().clone()
}

/// Save/apply: back up the current file, write `new`, then apply the window
/// geometry and tell the launcher to re-read the live settings. Used by both
/// the "Save" and "Apply" buttons (the frontend decides whether to close the
/// window).
#[tauri::command]
pub fn save_settings(new: Settings, app: AppHandle, state: State<SettingsState>) -> Result<(), String> {
    let mut guard = state.0.lock().unwrap();
    let old_toggle = guard.hotkeys.toggle.clone();
    let old_index = guard.index.clone();
    write_settings(&paths::base_dir(), &new, &guard)?;
    *guard = new.clone();
    drop(guard);
    // Apply the launcher width now; position is applied on its next show.
    crate::window::apply_settings(&app, &new)?;
    // Re-register the toggle hotkey when the user changed it.
    if new.hotkeys.toggle != old_toggle {
        let _ = crate::hotkey::apply(&app, &new.hotkeys.toggle);
    }
    // Index config changed → refresh the user cache immediately, so enabling
    // a new index takes effect now rather than on the next hourly refresh.
    if new.index != old_index {
        let app2 = app.clone();
        let settings = new.clone();
        std::thread::spawn(move || {
            app2.state::<crate::apps::AppIndex>().refresh_user(&settings);
        });
        // Also rebuild the directory watcher to follow the new index dirs.
        crate::dirwatch::rebuild(&app);
    }
    // Notify the launcher webview (language + entry-box size it renders).
    app.emit("settings-applied", ()).map_err(|e| e.to_string())?;
    Ok(())
}

/// Export: write the current settings to an external path (Save-As).
#[tauri::command]
pub fn export_settings(target_path: String, state: State<SettingsState>) -> Result<(), String> {
    let guard = state.0.lock().unwrap();
    let text = toml::to_string_pretty(&*guard).map_err(|e| e.to_string())?;
    fs::write(&target_path, text).map_err(|e| e.to_string())
}

/// Import: validate an external toml, back up the current file, then replace
/// the effective settings with the imported ones.
#[tauri::command]
pub fn import_settings(source_path: String, state: State<SettingsState>) -> Result<(), String> {
    let text = fs::read_to_string(&source_path).map_err(|e| e.to_string())?;
    let imported: Settings = toml::from_str(&text).map_err(|e| e.to_string())?;
    let mut guard = state.0.lock().unwrap();
    write_settings(&paths::base_dir(), &imported, &guard)?;
    *guard = imported;
    Ok(())
}

/// Restore defaults: back up the current file, then copy `default.toml` over
/// `settings.toml` and reload.
#[tauri::command]
pub fn restore_default(state: State<SettingsState>) -> Result<(), String> {
    let base = paths::base_dir();
    let text = fs::read_to_string(default_path(&base)).map_err(|e| e.to_string())?;
    let defaults: Settings = toml::from_str(&text).map_err(|e| e.to_string())?;
    let mut guard = state.0.lock().unwrap();
    write_settings(&base, &defaults, &guard)?;
    *guard = defaults;
    Ok(())
}

/// Restore backup: read `backup.toml` straight into `settings.toml` (the
/// backup itself is the source, so it is not overwritten).
#[tauri::command]
pub fn restore_backup(state: State<SettingsState>) -> Result<(), String> {
    let base = paths::base_dir();
    let text = fs::read_to_string(backup_path(&base)).map_err(|e| e.to_string())?;
    let restored: Settings = toml::from_str(&text).map_err(|e| e.to_string())?;
    fs::write(settings_path(&base), text).map_err(|e| e.to_string())?;
    let mut guard = state.0.lock().unwrap();
    *guard = restored;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "lume-settings-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn first_run_creates_default_and_settings() {
        let base = temp_base("first-run");
        ensure_settings_files(&base).unwrap();
        assert!(default_path(&base).exists());
        assert!(settings_path(&base).exists());
        assert!(!backup_path(&base).exists(), "no backup until a write");
        let s = read_settings(&base);
        assert_eq!(s.appearance.language, "system");
        assert_eq!(s.appearance.entry_size, 110);
        assert_eq!(s.appearance.window_height, 520);
        assert_eq!(s.hotkeys.toggle, "Alt+Space");
        assert!(s
            .index
            .system_dirs
            .iter()
            .any(|d| d.path == "Desktop" && d.enabled));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn settings_toml_is_a_copy_of_default() {
        let base = temp_base("copy");
        ensure_settings_files(&base).unwrap();
        let d = fs::read_to_string(default_path(&base)).unwrap();
        let s = fs::read_to_string(settings_path(&base)).unwrap();
        assert_eq!(d, s, "settings.toml must be a verbatim copy of default.toml");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn save_backs_up_previous_file() {
        let base = temp_base("save");
        ensure_settings_files(&base).unwrap();
        let fallback = Settings::default();
        let mut s = read_settings(&base);
        s.appearance.language = "en".into();
        write_settings(&base, &s, &fallback).unwrap();
        assert_eq!(read_settings(&base).appearance.language, "en");
        let backup: Settings =
            toml::from_str(&fs::read_to_string(backup_path(&base)).unwrap()).unwrap();
        assert_eq!(backup.appearance.language, "system", "backup keeps pre-save state");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn corrupt_settings_falls_back_to_defaults() {
        let base = temp_base("corrupt");
        ensure_settings_files(&base).unwrap();
        fs::write(settings_path(&base), "not valid toml").unwrap();
        let s = read_settings(&base);
        assert_eq!(s.appearance.window_width, 720);
        assert_eq!(s.hotkeys.switch_mode, "Tab");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn import_round_trip_via_files() {
        let base = temp_base("import");
        ensure_settings_files(&base).unwrap();
        // Simulate importing an external file: set a value, save, then read.
        let fallback = Settings::default();
        let mut s = read_settings(&base);
        s.index.user_dirs.push("D:/Projects".into());
        write_settings(&base, &s, &fallback).unwrap();
        let on_disk = fs::read_to_string(settings_path(&base)).unwrap();
        let re_imported: Settings = toml::from_str(&on_disk).unwrap();
        assert_eq!(re_imported.index.user_dirs, vec!["D:/Projects"]);
        fs::remove_dir_all(&base).ok();
    }
}
