//! First-run onboarding state and the independent welcome window.
//!
//! The welcome window owns the first lesson (summoning Lume). Once the global
//! shortcut reveals the launcher, the remaining lessons live in the launcher
//! and settings windows. Durable progress deliberately lives in
//! `data/onboarding.json`, not `settings.toml`, so restoring/importing settings
//! cannot replay the tour accidentally.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{App, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::settings;

pub const WELCOME_WINDOW: &str = "welcome";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingStatus {
    InProgress,
    Completed,
    Skipped,
}

impl Default for OnboardingStatus {
    fn default() -> Self {
        Self::InProgress
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingState {
    #[serde(default = "schema_version")]
    pub schema: u32,
    #[serde(default)]
    pub status: OnboardingStatus,
    #[serde(default = "first_step")]
    pub step: u8,
    #[serde(default)]
    pub outcome: Option<String>,
}

impl Default for OnboardingState {
    fn default() -> Self {
        Self {
            schema: SCHEMA_VERSION,
            status: OnboardingStatus::InProgress,
            step: 1,
            outcome: None,
        }
    }
}

impl OnboardingState {
    fn valid(mut self) -> Option<Self> {
        if self.schema != SCHEMA_VERSION || !(1..=4).contains(&self.step) {
            return None;
        }
        if self.status != OnboardingStatus::InProgress {
            self.step = 4;
        }
        Some(self)
    }

    fn skipped(outcome: &str) -> Self {
        Self {
            status: OnboardingStatus::Skipped,
            step: 4,
            outcome: Some(outcome.into()),
            ..Self::default()
        }
    }
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

fn first_step() -> u8 {
    1
}

/// State sent to both webviews at first paint and after every transition.
#[derive(Debug, Clone, Serialize)]
pub struct OnboardingSnapshot {
    pub status: OnboardingStatus,
    pub step: u8,
    pub replay: bool,
}

struct Runtime {
    persisted: OnboardingState,
    active: OnboardingState,
    replay: bool,
}

/// Managed onboarding state. The persisted half is only written for the real
/// first run; replay is a memory-only session.
pub struct OnboardingStateStore(Mutex<Runtime>);

impl OnboardingStateStore {
    fn lock(&self) -> std::sync::MutexGuard<'_, Runtime> {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn snapshot(&self) -> OnboardingSnapshot {
        let runtime = self.lock();
        OnboardingSnapshot {
            status: runtime.active.status,
            step: runtime.active.step,
            replay: runtime.replay,
        }
    }
}

fn state_path(base: &Path) -> PathBuf {
    base.join("data").join("onboarding.json")
}

fn read_state(base: &Path) -> Option<OnboardingState> {
    let text = fs::read_to_string(state_path(base)).ok()?;
    serde_json::from_str::<OnboardingState>(&text).ok()?.valid()
}

fn write_state(base: &Path, state: &OnboardingState) -> Result<(), String> {
    let path = state_path(base);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(state).map_err(|error| error.to_string())?;
    fs::write(path, text).map_err(|error| error.to_string())
}

fn initial_state(
    existing_settings_before_start: bool,
    loaded: Option<OnboardingState>,
) -> OnboardingState {
    loaded.unwrap_or_else(|| {
        if existing_settings_before_start {
            OnboardingState::skipped("existing_install")
        } else {
            OnboardingState::default()
        }
    })
}

/// Initialize onboarding after settings have been loaded. `first_run` is true
/// only when this process created `settings.toml`; an existing installation
/// therefore never gets the tour automatically.
pub fn init(app: &App, first_run: bool) {
    let base = crate::paths::base_dir();
    let loaded = read_state(&base);
    let state = initial_state(!first_run, loaded);
    let _ = write_state(&base, &state);
    app.manage(OnboardingStateStore(Mutex::new(Runtime {
        persisted: state.clone(),
        active: state,
        replay: false,
    })));
}

fn emit_changed(app: &AppHandle, snapshot: &OnboardingSnapshot) {
    for label in ["main", "settings", WELCOME_WINDOW] {
        let _ = app.emit_to(label, "onboarding-changed", snapshot.clone());
    }
}

fn update_snapshot(
    app: &AppHandle,
    store: &OnboardingStateStore,
    mutate: impl FnOnce(&mut Runtime) -> Result<(), String>,
) -> Result<OnboardingSnapshot, String> {
    let snapshot = {
        let mut runtime = store.lock();
        mutate(&mut runtime)?;
        OnboardingSnapshot {
            status: runtime.active.status,
            step: runtime.active.step,
            replay: runtime.replay,
        }
    };
    emit_changed(app, &snapshot);
    Ok(snapshot)
}

fn persist_active(runtime: &Runtime) -> Result<(), String> {
    if runtime.replay {
        Ok(())
    } else {
        write_state(&crate::paths::base_dir(), &runtime.active)
    }
}

fn advance_to_inner(app: &AppHandle, target: u8) -> Result<OnboardingSnapshot, String> {
    let store = app.state::<OnboardingStateStore>();
    update_snapshot(app, &store, |runtime| {
        if runtime.active.status != OnboardingStatus::InProgress {
            return Ok(());
        }
        if !(2..=4).contains(&target) {
            return Err(format!("invalid onboarding step {target}"));
        }
        if target > runtime.active.step {
            runtime.active.step = target;
            runtime.active.outcome = None;
            persist_active(runtime)?;
        }
        Ok(())
    })
}

/// Hotkey/tray toggle path. While step one is pending, the shortcut reveals the
/// launcher and completes that lesson instead of toggling an already-visible
/// launcher. Every later summon keeps the normal toggle behavior.
pub async fn toggle_launcher(app: AppHandle) -> Result<(), String> {
    let step = app
        .try_state::<OnboardingStateStore>()
        .map(|store| store.snapshot().step)
        .unwrap_or(4);
    let main_visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if step == 1 && !main_visible {
        let _ = advance_to_inner(&app, 2)?;
        crate::window::show_launcher_from_onboarding(&app).await?;
        if let Some(window) = app.get_webview_window(WELCOME_WINDOW) {
            let _ = window.destroy();
        }
        Ok(())
    } else {
        crate::window::toggle_launcher(app).await
    }
}

/// External launch activation (second `lume.exe` / desktop shortcut) reveals
/// the resident launcher instead of toggling it. While the welcome lesson is
/// pending, the launch behaves like the hotkey handoff and opens the coach.
pub async fn activate_launcher(app: AppHandle) -> Result<(), String> {
    let snapshot = app
        .try_state::<OnboardingStateStore>()
        .map(|store| store.snapshot())
        .unwrap_or(OnboardingSnapshot {
            status: OnboardingStatus::Completed,
            step: 4,
            replay: false,
        });
    let main_visible = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if !main_visible && snapshot.status == OnboardingStatus::InProgress && snapshot.step == 1 {
        let _ = advance_to_inner(&app, 2)?;
        crate::window::show_launcher_from_onboarding(&app).await?;
        if let Some(window) = app.get_webview_window(WELCOME_WINDOW) {
            let _ = window.destroy();
        }
        return Ok(());
    }
    crate::window::activate_launcher(&app).await
}

/// Show the first-run welcome or resume the in-launcher portion after a crash
/// between lessons. Existing users have a completed/skipped marker and keep the
/// normal hidden-at-startup behavior.
pub fn show_startup(app: &AppHandle) {
    let Some(store) = app.try_state::<OnboardingStateStore>() else {
        return;
    };
    let snapshot = store.snapshot();
    if snapshot.status != OnboardingStatus::InProgress {
        return;
    }
    crate::window::remember_foreground(app);
    if snapshot.step == 1 {
        if let Err(error) = open_welcome(app) {
            eprintln!("[onboarding] welcome window failed: {error}");
        }
    } else {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = crate::window::show_launcher_from_onboarding(&app).await {
                eprintln!("[onboarding] resume launcher failed: {error}");
            }
        });
    }
}

fn open_welcome(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WELCOME_WINDOW) {
        crate::window::set_webview_resource_state(app, WELCOME_WINDOW, true, false);
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let current = app.state::<settings::SettingsState>().current();
    let config_json = serde_json::to_string(&current).unwrap_or_else(|_| "{}".into());
    let onboarding_json = serde_json::to_string(&app.state::<OnboardingStateStore>().snapshot())
        .unwrap_or_else(|_| "{}".into());
    let init_script = format!(
        "window.__LUME_CONFIG__ = {config_json};window.__LUME_ONBOARDING__ = {onboarding_json};{}",
        crate::window::debug_flag_script()
    );
    let (r, g, b) = crate::window::panel_surface_rgb_for(
        app,
        current.appearance.skin(),
        &current.appearance.color_mode,
    );
    let window =
        WebviewWindowBuilder::new(app, WELCOME_WINDOW, WebviewUrl::App("welcome.html".into()))
            .title("Lume")
            .inner_size(480.0, 330.0)
            .resizable(false)
            .decorations(false)
            .shadow(true)
            .center()
            .always_on_top(false)
            .skip_taskbar(true)
            .focused(false)
            .visible(false)
            .background_color(tauri::window::Color(r, g, b, 255))
            .initialization_script(&init_script)
            .build()
            .map_err(|error| error.to_string())?;

    crate::appicon::apply_bundle_window_icon(&window);
    crate::window::set_webview_default_background(&window, (r, g, b, 255))?;
    crate::webview_guard::install(&window);
    crate::window::clear_dwm_border(&window);
    // Alt+F4 on the frameless welcome must not strand the app with no visible
    // surface. Route native close through the same skip path as the visible
    // link, then reveal the launcher.
    let close_app = app.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let app = close_app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = onboarding_skip(app).await;
            });
        }
    });
    crate::window::set_webview_resource_state(app, WELCOME_WINDOW, true, false);
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn onboarding_get(app: AppHandle) -> OnboardingSnapshot {
    app.state::<OnboardingStateStore>().snapshot()
}

/// Advance the guided lessons in order. Later interactions may fast-forward
/// (for example opening Settings early jumps straight to the autostart step).
#[tauri::command]
pub fn onboarding_advance(app: AppHandle, target: u8) -> Result<OnboardingSnapshot, String> {
    advance_to_inner(&app, target)
}

/// Continue from the welcome window without requiring the shortcut. This is
/// the mouse/accessibility fallback and the recovery path after a hotkey
/// registration conflict.
#[tauri::command]
pub async fn onboarding_continue_from_welcome(
    app: AppHandle,
) -> Result<OnboardingSnapshot, String> {
    advance_to_inner(&app, 2)?;
    crate::window::show_launcher_from_onboarding(&app).await?;
    if let Some(window) = app.get_webview_window(WELCOME_WINDOW) {
        let _ = window.destroy();
    }
    Ok(app.state::<OnboardingStateStore>().snapshot())
}

/// Route directly to the settings lesson. Opening Settings before the Tab
/// lesson is allowed; the guide fast-forwards instead of trapping the user.
#[tauri::command]
pub async fn onboarding_open_settings(app: AppHandle) -> Result<OnboardingSnapshot, String> {
    let snapshot = advance_to_inner(&app, 4)?;
    crate::window::open_settings_with_route(
        app,
        crate::window::SettingsRoute {
            section: Some("system".into()),
            onboarding: true,
        },
    )
    .await?;
    Ok(snapshot)
}

#[tauri::command]
pub fn onboarding_finish(app: AppHandle, reason: String) -> Result<OnboardingSnapshot, String> {
    if !matches!(reason.as_str(), "autostart_enabled" | "autostart_declined") {
        return Err(format!("invalid onboarding completion reason: {reason}"));
    }
    let store = app.state::<OnboardingStateStore>();
    update_snapshot(&app, &store, |runtime| {
        if runtime.active.status != OnboardingStatus::InProgress {
            return Ok(());
        }
        if runtime.active.step != 4 {
            return Err("autostart lesson is not active".into());
        }
        if runtime.replay {
            runtime.active = runtime.persisted.clone();
            runtime.replay = false;
        } else {
            runtime.active.status = OnboardingStatus::Completed;
            runtime.active.step = 4;
            runtime.active.outcome = Some(reason);
            write_state(&crate::paths::base_dir(), &runtime.active)?;
            runtime.persisted = runtime.active.clone();
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn onboarding_skip(app: AppHandle) -> Result<OnboardingSnapshot, String> {
    let welcome_visible = app
        .get_webview_window(WELCOME_WINDOW)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    let store = app.state::<OnboardingStateStore>();
    let snapshot = update_snapshot(&app, &store, |runtime| {
        if runtime.replay {
            runtime.active = runtime.persisted.clone();
            runtime.replay = false;
        } else if runtime.active.status == OnboardingStatus::InProgress {
            runtime.active = OnboardingState::skipped("skipped");
            write_state(&crate::paths::base_dir(), &runtime.active)?;
            runtime.persisted = runtime.active.clone();
        }
        Ok(())
    })?;
    if welcome_visible {
        crate::window::show_launcher_from_onboarding(&app).await?;
        if let Some(window) = app.get_webview_window(WELCOME_WINDOW) {
            let _ = window.destroy();
        }
    }
    Ok(snapshot)
}

/// Start a memory-only replay from Settings → About. If the review is abandoned
/// before completion, the durable completed/skipped marker remains untouched.
#[tauri::command]
pub async fn onboarding_replay(app: AppHandle) -> Result<OnboardingSnapshot, String> {
    if let Some(main) = app.get_webview_window("main") {
        if main.is_visible().unwrap_or(false) {
            let _ = crate::window::hide_main(&app);
        }
    }
    let _ = crate::window::close_settings(app.clone());
    let store = app.state::<OnboardingStateStore>();
    let snapshot = update_snapshot(&app, &store, |runtime| {
        runtime.active = OnboardingState::default();
        runtime.replay = true;
        Ok(())
    })?;
    open_welcome(&app)?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("lume-onboarding-test-{tag}-{}", std::process::id()))
    }

    #[test]
    fn fresh_install_starts_at_the_welcome_lesson() {
        let state = initial_state(false, None);
        assert_eq!(state.status, OnboardingStatus::InProgress);
        assert_eq!(state.step, 1);
    }

    #[test]
    fn existing_install_is_skipped_without_a_prompt() {
        let state = initial_state(true, None);
        assert_eq!(state.status, OnboardingStatus::Skipped);
        assert_eq!(state.outcome.as_deref(), Some("existing_install"));
    }

    #[test]
    fn in_progress_state_resumes_at_saved_step() {
        let loaded = OnboardingState {
            step: 3,
            ..OnboardingState::default()
        };
        let state = initial_state(false, Some(loaded));
        assert_eq!(state.status, OnboardingStatus::InProgress);
        assert_eq!(state.step, 3);
    }

    #[test]
    fn completed_state_is_normalized_to_the_last_step() {
        let state = OnboardingState {
            status: OnboardingStatus::Completed,
            step: 1,
            outcome: Some("autostart_enabled".into()),
            ..OnboardingState::default()
        }
        .valid()
        .unwrap();
        assert_eq!(state.step, 4);
        assert_eq!(state.status, OnboardingStatus::Completed);
    }

    #[test]
    fn state_round_trips_through_data_directory() {
        let base = temp_base("roundtrip");
        let state = OnboardingState {
            step: 3,
            ..OnboardingState::default()
        };
        write_state(&base, &state).unwrap();
        assert_eq!(read_state(&base), Some(state));
        let _ = fs::remove_dir_all(base);
    }

    #[test]
    fn corrupt_state_is_ignored() {
        let base = temp_base("corrupt");
        let path = state_path(&base);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, "{not json").unwrap();
        assert_eq!(read_state(&base), None);
        let _ = fs::remove_dir_all(base);
    }
}
