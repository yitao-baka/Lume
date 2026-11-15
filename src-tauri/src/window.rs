//! Launcher window management.
//!
//! The launcher surface is a single frameless webview window with a
//! configurable CSS surface and opacity (label: `"main"`). This module owns showing and
//! hiding it; `window_geometry` owns the size/position transaction.
//!
//! The commands below are the window API for the rest of the core: the
//! Global hotkey module (v0.1) and the frontend Esc key both call them.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalRect, PhysicalSize, State,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use windows::Win32::Foundation::{COLORREF, HWND};
use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_BORDER_COLOR};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

/// Label of the launcher window defined in `tauri.conf.json`.
const MAIN_WINDOW: &str = "main";
/// Label of the settings window defined in `tauri.conf.json`.
const SETTINGS_WINDOW: &str = "settings";
/// Label of the satellite preview window (created on the first preview).
const PREVIEW_WINDOW: &str = "preview";
/// Fixed logical width of the satellite preview window (the old `PREVIEW_W`).
const PREVIEW_W_LOGICAL: f64 = 320.0;
/// Logical px of breathing room between the launcher and the satellite preview
/// (applied to the client areas on BOTH sides — a left dock keeps the same gap).
const PREVIEW_GAP_LOGICAL: f64 = 8.0;
/// Seconds the launcher must stay hidden before its renderer's idle memory is
/// swapped out (`MemoryUsageTargetLevel = Low`). Frequent show/hide toggles
/// never cross this threshold, so the hotkey show path stays instant; a
/// long-hidden launcher releases its memory for reuse elsewhere.
const MAIN_IDLE_TRIM_SECS: u64 = 10;
/// A hidden settings page is retained briefly for instant reopen, then its
/// renderer is destroyed. The next `open_settings` rebuilds it from current
/// settings; the activity epoch cancels a stale timer after a reopen.
const SETTINGS_IDLE_DESTROY_SECS: u64 = 5 * 60;
/// A hidden preview keeps its page warm for selection bursts, then the whole
/// webview is destroyed. The next request creates it again and restores the
/// current `PreviewRequest` through the normal ready handshake.
const PREVIEW_IDLE_DESTROY_SECS: u64 = 10 * 60;
static SETTINGS_ACTIVITY: AtomicU64 = AtomicU64::new(0);
static SETTINGS_CREATE_LOCK: Mutex<()> = Mutex::new(());
static SETTINGS_RENDERER_EPOCH: AtomicU64 = AtomicU64::new(0);
static SETTINGS_READY_EPOCH: AtomicU64 = AtomicU64::new(0);
static PREVIEW_ACTIVITY: AtomicU64 = AtomicU64::new(0);
static PREVIEW_CREATE_LOCK: Mutex<()> = Mutex::new(());

/// The harness can shorten a lifecycle timeout without changing the shipped
/// default. Release builds ignore the variable entirely.
fn debug_timeout_secs(name: &str, default: u64) -> u64 {
    #[cfg(debug_assertions)]
    if let Ok(value) = std::env::var(name) {
        if let Ok(seconds) = value.parse::<u64>() {
            if seconds > 0 {
                return seconds;
            }
        }
    }
    let _ = name;
    default
}

/// Last foreground window HWND captured before the launcher is shown — used by
/// the clipboard auto-paste feature to send content back to the right window.
pub struct FocusState {
    pub last_hwnd: Mutex<Option<isize>>,
    /// When 粘贴后关闭 is off, a paste must not let the follow-up blur hide the
    /// launcher. Holds the Instant until which the blur-hide is suppressed.
    pub suppress_hide_until: Mutex<Option<std::time::Instant>>,
}

impl Default for FocusState {
    fn default() -> Self {
        Self {
            last_hwnd: Mutex::new(None),
            suppress_hide_until: Mutex::new(None),
        }
    }
}

/// Session-scoped placement bookkeeping for the launcher (docs/ROADMAP_HISTORY.md #41).
///
/// The 窗口位置 setting is an *initial* position only: it applies when the
/// window first appears in a run (or when the setting itself changes); later
/// shows inherit the spot the launcher was last closed at. `follow-mouse` is
/// the exception and re-positions on every show. `anchor` records the last
/// position we applied programmatically — a read-back mismatch means the user
/// dragged the window by hand, which is sticky for the session so the
/// automatic anchor (content-height changes) never fights the chosen spot.
#[derive(Default)]
pub struct PlacementState {
    inner: Mutex<PlacementInner>,
}

#[derive(Default)]
struct PlacementInner {
    /// The window has appeared at least once since this process started.
    shown_once: bool,
    /// The user moved the window by hand (sticky for the session).
    user_placed: bool,
    /// Physical top-left of the last position we applied programmatically.
    anchor: Option<(i32, i32)>,
    /// `(window_position, remember_position)` the placement policy last ran
    /// with — a change re-applies the initial position (Save / Apply / import).
    cfg: Option<(String, bool)>,
}

impl PlacementState {
    /// Note that the launcher has appeared; true only for the run's first show.
    fn mark_shown(&self) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let first = !inner.shown_once;
        inner.shown_once = true;
        first
    }

    /// Record the effective 窗口位置 config; true when it differs from the
    /// config the placement policy last ran with (first call included), so the
    /// initial position should be applied.
    fn record_cfg(&self, appearance: &crate::settings::Appearance) -> bool {
        let mut inner = self.inner.lock().unwrap();
        let cfg = (
            appearance.window_position.clone(),
            appearance.remember_position,
        );
        let changed = inner.cfg.as_ref() != Some(&cfg);
        inner.cfg = Some(cfg);
        changed
    }

    /// Drop the manual-placement memory — an explicit position-setting change
    /// / first appearance re-arms the preset anchor.
    fn clear_user_placed(&self) {
        self.inner.lock().unwrap().user_placed = false;
    }
}

/// Arm the blur-hide suppression for `for_ms` (keeps the launcher visible
/// after a paste when 粘贴后关闭 is disabled).
pub fn suppress_hide(focus: &FocusState, for_ms: u64) {
    *focus.suppress_hide_until.lock().unwrap() =
        Some(std::time::Instant::now() + std::time::Duration::from_millis(for_ms));
}

/// End a blur-hide suppression early (a UAC prompt returned). The next real
/// focus loss hides the launcher normally.
pub fn clear_hide_suppression(focus: &FocusState) {
    *focus.suppress_hide_until.lock().unwrap() = None;
}

/// True while a blur-hide suppression is active (and not yet expired).
pub fn is_hide_suppressed(focus: &FocusState) -> bool {
    let mut guard = focus.suppress_hide_until.lock().unwrap();
    match *guard {
        Some(until) if std::time::Instant::now() < until => true,
        _ => {
            *guard = None; // expired — clear so the next blur hides normally
            false
        }
    }
}

// ── WebView2 visibility and idle memory ──────────────────────────────────────
// The launcher remains resident; settings, preview and the plugin logic host
// are created on demand. Hidden pages explicitly set the WebView2 controller
// invisible so browser timers/RAF see the correct page lifecycle.
// `MemoryUsageTargetLevel = Low` additionally swaps idle working sets out;
// `Normal` is restored manually before activation. Tauri does not expose either
// controller call on the builder, so this module reaches the same COM
// controller Wry owns.

/// Set one webview's memory usage target level. Any failure (missing webview,
/// too-old runtime for `ICoreWebView2_19`) degrades silently to "no trimming".
/// The COM controller is reached through `Webview::with_webview`, which runs
/// the callback on the main thread via the dispatcher — safe from any caller
/// (background trim threads included). The callback is queued, not synchronous;
/// fine for memory trimming, which is never latency-critical.
pub fn set_memory_target(app: &AppHandle, label: &str, low: bool) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = window.as_ref().with_webview(move |pw| {
        set_controller_memory_level(&pw, low);
    });
}

/// Set both halves of the resource state that a top-level HWND hide/show does
/// not cover: `ICoreWebView2Controller::SetIsVisible` (page visibility, timer /
/// RAF behavior) and `MemoryUsageTargetLevel` (working-set residency).
///
/// Wry sets the controller visibility only when the webview is first created;
/// Tauri's later `Window::show()/hide()` operates on the parent HWND alone.
/// Without this bridge `document.visibilityState` stays `visible` while the
/// launcher is hidden. Calls are dispatched to the main thread and are safe
/// from async command/background paths.
pub fn set_webview_resource_state(app: &AppHandle, label: &str, visible: bool, low: bool) {
    let Some(window) = app.get_webview_window(label) else {
        return;
    };
    let _ = window.as_ref().with_webview(move |pw| {
        let controller = pw.controller();
        let _ = unsafe { controller.SetIsVisible(visible) };
        set_controller_memory_level(&pw, low);
    });
}

/// Set WebView2's default canvas independently from the native HWND background.
/// Wry does not expose this per-window setting, yet it is the surface WebView2
/// paints before the document supplies its own background. The launcher uses
/// fully transparent RGBA so a first frame can never flash an opaque white (or
/// wrong-skin) rectangle; opaque auxiliary windows pass their resolved surface.
pub fn set_webview_default_background(
    window: &WebviewWindow,
    rgba: (u8, u8, u8, u8),
) -> Result<(), String> {
    window
        .as_ref()
        .with_webview(move |pw| set_controller_background(&pw, rgba))
        .map_err(|error| error.to_string())
}

fn set_controller_background(
    pw: &tauri::webview::PlatformWebview,
    (r, g, b, a): (u8, u8, u8, u8),
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2Controller2, COREWEBVIEW2_COLOR,
    };
    use windows::core::Interface;

    let Ok(controller2) = pw.controller().cast::<ICoreWebView2Controller2>() else {
        return;
    };
    let color = COREWEBVIEW2_COLOR {
        A: a,
        R: r,
        G: g,
        B: b,
    };
    let _ = unsafe { controller2.SetDefaultBackgroundColor(color) };
}

/// Let queued Tauri window messages (show / set-focus / event delivery) reach
/// the native event loop before checking the real foreground HWND. A timeout is
/// diagnostic only: the window is already visible and must never lose its
/// `launcher-shown` focus re-arm because the main loop was briefly busy.
fn wait_for_native_queue(app: &AppHandle) {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    if let Err(error) = app.run_on_main_thread(move || {
        let _ = tx.send(());
    }) {
        eprintln!("[window] native queue barrier failed: {error}");
        return;
    }
    if let Err(error) = rx.recv_timeout(std::time::Duration::from_millis(500)) {
        eprintln!("[window] native queue barrier timed out: {error}");
    }
}

/// Initialization-script suffix shared by every webview. Production builds set
/// the flag to false so large CDP rings and test-only globals stay disabled;
/// debug builds keep the existing probe surface for the UI harness.
pub fn debug_flag_script() -> String {
    let debug = cfg!(debug_assertions);
    if !debug {
        return "window.__LUME_DEBUG__ = false;".into();
    }
    let timings = serde_json::json!({
        "hostInactiveReclaimMs": debug_timeout_secs("LUME_HOST_RECLAIM_SECS", 120) * 1000,
        "hostActiveReclaimMs": debug_timeout_secs("LUME_ACTIVE_HOST_RECLAIM_SECS", 15 * 60) * 1000,
        "logicIdleUnloadMs": debug_timeout_secs("LUME_LOGIC_IDLE_UNLOAD_SECS", 5 * 60) * 1000,
        "logicIdleSweepMs": debug_timeout_secs("LUME_LOGIC_IDLE_SWEEP_SECS", 30) * 1000,
    });
    format!(
        "window.__LUME_DEBUG__ = true; window.__LUME_DEBUG_TIMINGS__ = {timings};"
    )
}

/// Reveal a non-activating webview window. Controller visibility, Normal
/// residency and `SW_SHOWNOACTIVATE` happen in one main-thread callback, so the
/// native window can never become visible with its WebView still hidden.
pub fn show_webview_no_activate(app: &AppHandle, label: &str) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};

    let window = app
        .get_webview_window(label)
        .ok_or_else(|| format!("{label} window not found"))?;
    let raw_hwnd = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
    window
        .as_ref()
        .with_webview(move |pw| {
            let controller = pw.controller();
            let _ = unsafe { controller.SetIsVisible(true) };
            set_controller_memory_level(&pw, false);
            let _ = unsafe { ShowWindow(HWND(raw_hwnd as _), SW_SHOWNOACTIVATE) };
        })
        .map_err(|error| error.to_string())
}

fn set_controller_memory_level(pw: &tauri::webview::PlatformWebview, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL, ICoreWebView2_19,
    };
    use windows::core::Interface;
    let Ok(core) = (unsafe { pw.controller().CoreWebView2() }) else {
        return;
    };
    let Ok(core19) = core.cast::<ICoreWebView2_19>() else {
        return;
    };
    let level = if low {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
    } else {
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
    };
    let _ = unsafe { core19.SetMemoryUsageTargetLevel(level) };
}

/// Synchronize auxiliary controller visibility/residency with the native HWND:
/// hidden → invisible + `Low`, visible → visible + `Normal`. Missing settings
/// windows are skipped (they are created lazily). The main launcher is handled
/// separately (`restore_main` / `trim_main_when_idle`) so its hotkey path never
/// pays a swap-back.
pub fn sync_aux_memory_targets(app: &AppHandle) {
    // plugin-logic-host never shows: controller-invisible and low from creation.
    set_webview_resource_state(app, "plugin-logic-host", false, true);
    for label in [SETTINGS_WINDOW, PREVIEW_WINDOW] {
        let visible = app
            .get_webview_window(label)
            .and_then(|w| w.is_visible().ok())
            .unwrap_or(false);
        set_webview_resource_state(app, label, visible, !visible);
    }
}

/// Set the main launcher to `Low` immediately. Used at startup — the launcher
/// starts hidden and stays so until the first hotkey, which restores `Normal`.
pub fn trim_main_now(app: &AppHandle) {
    set_webview_resource_state(app, MAIN_WINDOW, false, true);
}

/// Restore the main launcher to `Normal` **before** showing it, so the
/// browser can swap the page's memory back while the window is still hidden —
/// the hotkey show doesn't stall on the first frame.
pub fn restore_main(app: &AppHandle) {
    set_webview_resource_state(app, MAIN_WINDOW, true, false);
}

/// Swap the main launcher's idle memory out only once it has stayed hidden for
/// `MAIN_IDLE_TRIM_SECS` seconds. Each hide arms one checker thread; an extra
/// late wake is harmless (`Low` is idempotent, and a re-show already set
/// `Normal`). Keeps frequent toggles at `Normal` so hotkey calls stay instant.
pub fn trim_main_when_idle(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(MAIN_IDLE_TRIM_SECS));
        let hidden = app
            .get_webview_window(MAIN_WINDOW)
            .map(|w| w.is_visible().unwrap_or(false))
            .map(|visible| !visible)
            .unwrap_or(true);
        if hidden {
            set_memory_target(&app, MAIN_WINDOW, true);
        }
    });
}

/// Apply the configured width and the window's placement policy on every show.
///
/// The 窗口位置 setting is an initial position: it applies on the window's
/// first appearance in a run (or when the setting itself changed); later shows
/// inherit the spot the launcher was last closed at, so a manual move is never
/// reset. `follow-mouse` is the exception and re-positions on every show.
fn apply_geometry(window: &WebviewWindow) -> tauri::Result<()> {
    let appearance = window
        .app_handle()
        .state::<crate::settings::SettingsState>()
        .current()
        .appearance;
    crate::window_geometry::apply_show_geometry(window, &appearance)
        .map_err(|error| tauri::Error::Anyhow(std::io::Error::other(error).into()))
}

/// Whether the launcher is currently being dragged with the mouse — the left
/// button is held and the cursor sits over the window. The hide-on-focus-loss
/// rule skips the dismiss in this state: moving a frameless window via
/// `WM_NCLBUTTONDOWN`/HTCAPTION briefly deactivates it (a `Focused(false)`
/// fires) even though the user is only repositioning it.
pub fn is_mid_drag(window: &WebviewWindow) -> bool {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON};
    let left_down = (unsafe { GetAsyncKeyState(VK_LBUTTON as i32) } as i32) & 0x8000 != 0;
    left_down && cursor_is_over(window)
}

/// Whether the mouse cursor currently sits within the window's outer bounds.
fn cursor_is_over(window: &WebviewWindow) -> bool {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut pt = POINT { x: 0, y: 0 };
    if unsafe { GetCursorPos(&mut pt) } == 0 {
        return false;
    }
    let Ok(pos) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };
    let x = pt.x;
    let y = pt.y;
    x >= pos.x && x < pos.x + size.width as i32 && y >= pos.y && y < pos.y + size.height as i32
}

/// Read back the window's outer top-left (physical px) — the same coordinate
/// space as `set_position` / `outer_position`.
fn outer_pos(window: &WebviewWindow) -> Option<(i32, i32)> {
    window.outer_position().ok().map(|p| (p.x, p.y))
}

/// Remember the position we just applied, read back from the OS so a later
/// mismatch is a reliable "the user moved it by hand" signal.
pub(crate) fn record_geometry_anchor(window: &WebviewWindow) {
    if let Some(pos) = outer_pos(window) {
        window
            .app_handle()
            .state::<PlacementState>()
            .inner
            .lock()
            .unwrap()
            .anchor = Some(pos);
    }
}

/// True when the launcher must keep its current spot instead of the preset
/// anchor: either the user moved it earlier this session, or it no longer sits
/// at the last position we applied — a sticky manual placement (docs/ROADMAP_HISTORY.md #41).
pub(crate) fn preserve_manual_spot(
    window: &WebviewWindow,
    appearance: &crate::settings::Appearance,
) -> bool {
    if appearance.remember_position {
        return true;
    }
    // 跟随鼠标 is the one policy that always re-anchors on summon, even after
    // a drag. A fresh static preset also clears stale manual-drag memory in
    // its caller before this decision.
    if appearance.window_position == "follow-mouse" {
        return false;
    }
    user_moved(window, &window.app_handle().state::<PlacementState>())
}

fn user_moved(window: &WebviewWindow, state: &PlacementState) -> bool {
    let mut inner = state.inner.lock().unwrap();
    if inner.user_placed {
        return true;
    }
    if let (Some(anchor), Some(pos)) = (inner.anchor, outer_pos(window)) {
        if anchor != pos {
            inner.user_placed = true;
            return true;
        }
    }
    false
}

/// Show and focus the launcher, applying its geometry per settings (width +
/// the first-appearance position policy, see `docs/SETTINGS.md`).
async fn show(window: &WebviewWindow) -> tauri::Result<()> {
    restore_main(window.app_handle());
    let app = window.app_handle();
    let appearance = app
        .state::<crate::settings::SettingsState>()
        .current()
        .appearance;
    let placement = app.state::<PlacementState>();
    // Preserve a manual spot across ordinary shows. A first show is already
    // represented by the absence of an anchor, while `follow-mouse` is relaunched
    // by `apply_settings` when its policy changes.
    let _first_show = placement.mark_shown();
    let cfg_changed = placement.record_cfg(&appearance);
    if cfg_changed {
        placement.clear_user_placed();
    }
    crate::window_geometry::prepare_show(window).await?;
    apply_geometry(window)?;
    window.show()?;
    window.set_focus()?;
    // `show()`/`set_focus()` are queued Tauri messages. Drain that queue, then
    // verify the real Win32 foreground HWND. This matters when the summon came
    // from Settings or a detached plugin window: Windows may still keep the
    // sibling foreground while the new launcher is already visible.
    wait_for_native_queue(app);
    if let Ok(hwnd) = window.hwnd() {
        if !crate::input::force_foreground(hwnd) {
            // One final queued focus request gives Tauri a chance to replay its
            // normal activation path after the foreground check.
            let _ = window.set_focus();
        }
    }
    let _ = window.emit("launcher-shown", ());
    Ok(())
}

/// Toggle the launcher window.
///
/// Hidden → shown (geometry applied + focused); shown → hidden.
/// When about to show, records the current foreground window for
/// clipboard auto-paste.
#[tauri::command]
pub async fn toggle_launcher(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    if window.is_visible().map_err(|e| e.to_string())? {
        hide_main(&app)?;
    } else {
        // Record which window had focus before the launcher appeared.
        if let Some(focus) = app.try_state::<FocusState>() {
            let fg = unsafe { GetForegroundWindow() };
            *focus.last_hwnd.lock().unwrap() = Some(fg.0 as isize);
        }
        show(&window).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Hide the main window and signal the frontend. EVERY launcher-hide path
/// (blur-to-hide, hotkey toggle, Esc / the `hide_launcher` command) funnels
/// through here, so `launcher-hidden` is the single idle-reset anchor
/// (docs/ROADMAP_HISTORY.md #46): the frontend measures "time since the user last left the
/// launcher" — never a background timer, which the memory-trimmed hidden
/// webview cannot be trusted to run on time.
pub fn hide_main(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    window.hide().map_err(|e| e.to_string())?;
    // Tauri hides only the parent HWND. Tell WebView2 too, otherwise page
    // timers/RAF continue under `document.visibilityState === "visible"`.
    set_webview_resource_state(app, MAIN_WINDOW, false, false);
    let _ = window.emit("launcher-hidden", ());
    // The satellite preview lives and dies with the launcher.
    teardown_preview(app);
    // Main renderer goes Low only after MAIN_IDLE_TRIM_SECS hidden.
    trim_main_when_idle(app);
    Ok(())
}

/// Hide the launcher window.
#[tauri::command]
pub fn hide_launcher(app: AppHandle) -> Result<(), String> {
    hide_main(&app)
}

/// Create the settings webview on first use. The page is deliberately absent
/// from startup so an unused settings surface costs no renderer/DOM/JS memory.
fn ensure_settings_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let _guard = SETTINGS_CREATE_LOCK
        .lock()
        .map_err(|_| "settings window creation lock poisoned".to_string())?;
    if let Some(window) = app.get_webview_window(SETTINGS_WINDOW) {
        return Ok(window);
    }

    let settings = crate::settings::snapshot(&app.state::<crate::settings::SettingsState>());
    let generation = SETTINGS_RENDERER_EPOCH.fetch_add(1, Ordering::SeqCst) + 1;
    SETTINGS_READY_EPOCH.store(0, Ordering::SeqCst);
    let config_json = serde_json::to_string(&settings).unwrap_or_else(|_| "{}".into());
    let init_script = format!(
        "window.__LUME_SETTINGS_EPOCH__ = {generation};window.__LUME_CONFIG__ = {config_json};{}",
        debug_flag_script()
    );
    let lang = crate::i18n::UiLang::from_setting(&settings.appearance.language);
    let background = panel_surface_rgb_for(
        app,
        settings.appearance.settings_skin(),
        &settings.appearance.color_mode,
    );
    let window = WebviewWindowBuilder::new(
        app,
        SETTINGS_WINDOW,
        WebviewUrl::App("settings.html".into()),
    )
    .title(crate::texts::window_title_settings(lang))
    .inner_size(1040.0, 720.0)
    .min_inner_size(560.0, 420.0)
    .center()
    .resizable(true)
    .decorations(false)
    .shadow(true)
    .focused(false)
    .visible(false)
    .background_color(tauri::window::Color(background.0, background.1, background.2, 255))
    .initialization_script(&init_script)
    .build()
    .map_err(|error| error.to_string())?;

    // The settings taskbar button mirrors the executable icon rather than the
    // transparent brand mark used inside the title bar.
    crate::appicon::apply_bundle_window_icon(&window);
    set_webview_default_background(
        &window,
        (background.0, background.1, background.2, 255),
    )?;
    crate::webview_guard::install(&window);
    clear_dwm_border(&window);
    // Keep the settings dialog on small work areas while the normal 1040x720
    // canvas stays unchanged.
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale = monitor.scale_factor();
        let area = monitor.work_area();
        let width = (area.size.width as f64 / scale - 64.0).clamp(560.0, 1040.0);
        let height = (area.size.height as f64 / scale - 64.0).clamp(420.0, 720.0);
        let _ = window.set_size(LogicalSize::new(width, height));
        let _ = window.center();
    }

    // The title-bar close path asks the frontend first. Unsaved/save-error
    // drafts remain in the live window; `close_settings` is only called after
    // the page confirms there is nothing left to lose.
    let handler = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = handler.emit("settings-close-requested", ());
        }
    });

    // The builder hides only the native HWND; keep the controller hidden and the
    // new renderer at Low until `open_settings` prepares it for display.
    set_webview_resource_state(app, SETTINGS_WINDOW, false, true);
    Ok(window)
}

/// Wait until the settings document has mounted its first usable page. The
/// native HWND and controller stay hidden during this period, so lazy CSS /
/// locale / pane imports cannot flash a white WebView background.
async fn wait_for_settings_renderer(app: &AppHandle, generation: u64) -> Result<(), String> {
    for _ in 0..400 {
        if SETTINGS_READY_EPOCH.load(Ordering::SeqCst) == generation {
            return Ok(());
        }
        if app.get_webview_window(SETTINGS_WINDOW).is_none() {
            return Err("settings window closed before its renderer became ready".into());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Err("settings renderer did not become ready".into())
}

/// The settings renderer calls this after the initial settings load and the
/// current lazy pane have painted. A stale document generation is ignored.
#[tauri::command]
pub fn settings_renderer_ready(generation: u64, window: WebviewWindow) -> Result<(), String> {
    if window.label() != SETTINGS_WINDOW {
        return Err("settings_renderer_ready: settings window required".into());
    }
    if generation != SETTINGS_RENDERER_EPOCH.load(Ordering::SeqCst) {
        return Ok(());
    }
    SETTINGS_READY_EPOCH.store(generation, Ordering::SeqCst);
    Ok(())
}

/// Destroy a settings page that has stayed hidden for long enough. The activity
/// epoch changes whenever the window is opened or closed again, so a stale
/// timer can never destroy a freshly reopened instance.
fn schedule_settings_destroy_if_idle(app: &AppHandle) {
    let epoch = SETTINGS_ACTIVITY.fetch_add(1, Ordering::SeqCst) + 1;
    let timeout = debug_timeout_secs(
        "LUME_SETTINGS_IDLE_DESTROY_SECS",
        SETTINGS_IDLE_DESTROY_SECS,
    );
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("settings-idle-destroy".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(timeout));
            // Serialize the final epoch check + destroy with first-open creation.
            // Either the timer destroys first and open rebuilds, or the open's
            // activity bump wins and the stale timer leaves the window alone.
            let Ok(_guard) = SETTINGS_CREATE_LOCK.lock() else {
                return;
            };
            if SETTINGS_ACTIVITY.load(Ordering::SeqCst) != epoch {
                return;
            }
            let Some(window) = app.get_webview_window(SETTINGS_WINDOW) else {
                return;
            };
            if window.is_visible().unwrap_or(true) {
                return;
            }
            let _ = window.destroy();
            SETTINGS_READY_EPOCH.store(0, Ordering::SeqCst);
            drop(window);
            // Wait for the queued native destruction to be observable before an
            // opening caller can acquire the same creation lock.
            for _ in 0..50 {
                if app.get_webview_window(SETTINGS_WINDOW).is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
}

/// Open (show + focus) the settings window, creating its webview on first use.
#[tauri::command]
pub async fn open_settings(app: AppHandle) -> Result<(), String> {
    // Bump before touching the window so a concurrently waking idle-destroy
    // timer observes the new activity epoch and backs off.
    SETTINGS_ACTIVITY.fetch_add(1, Ordering::SeqCst);
    let window = ensure_settings_window(&app)?;
    let generation = SETTINGS_RENDERER_EPOCH.load(Ordering::SeqCst);
    wait_for_settings_renderer(&app, generation).await?;
    set_webview_resource_state(&app, SETTINGS_WINDOW, true, false);
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    let _ = window.emit("settings-shown", ());
    sync_aux_memory_targets(&app);
    Ok(())
}

/// Hide the settings window. Its page stays warm for a short, bounded idle
/// window (preserving navigation state), then the webview is destroyed and the
/// next open rebuilds it from current settings.
#[tauri::command]
pub fn close_settings(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(SETTINGS_WINDOW) else {
        return Ok(());
    };
    window.hide().map_err(|e| e.to_string())?;
    set_webview_resource_state(&app, SETTINGS_WINDOW, false, true);
    schedule_settings_destroy_if_idle(&app);
    Ok(())
}

/// ── Self-chrome window controls ──
/// The frameless settings/plugin windows draw their own titlebar
/// (src/components/TitleBar.tsx); these commands are its backend. Tauri
/// injects the `window` parameter as the CALLING window, so a page can only
/// ever control itself — no label validation needed, and the opaque plugin
/// iframe (which cannot invoke commands) has no path here. Custom commands
/// are ungated by ACL by design (see capabilities/plugin-windows.json).
///
/// Minimize the calling window (titlebar ─ button).
#[tauri::command]
pub fn window_minimize(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Toggle maximize/restore on the calling window (titlebar □/❐ button; the
/// chrome's double-click is Tauri's built-in `internal_toggle_maximize`).
/// Returns the new maximized state so the titlebar can swap its glyph.
#[tauri::command]
pub fn window_toggle_maximize(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_maximized().map_err(|e| e.to_string())?;
    if next {
        window.maximize().map_err(|e| e.to_string())?;
    } else {
        window.unmaximize().map_err(|e| e.to_string())?;
    }
    Ok(next)
}

/// Toggle always-on-top ("pin", titlebar 📌 button) on the calling window.
/// Returns the new state; session-scoped only — windows are created unpinned
/// and the pin never persists into settings.
#[tauri::command]
pub fn window_toggle_pin(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_always_on_top().map_err(|e| e.to_string())?;
    window.set_always_on_top(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Apply the window-geometry settings to the launcher immediately (used by
/// Save / Apply). Width applies now. An explicit 窗口位置 change re-applies the
/// preset now (instant feedback; it also forgets a manual spot), while an
/// unrelated save never pulls a dragged window back (docs/ROADMAP_HISTORY.md #41) — it only
/// keeps a never-moved window anchored while its width changes.
pub fn apply_settings(app: &AppHandle, settings: &crate::settings::Settings) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(());
    };
    let placement = app.state::<PlacementState>();
    let cfg_changed = placement.record_cfg(&settings.appearance);
    if cfg_changed {
        placement.clear_user_placed();
        // Re-arm the preset identity before the geometry commit. Without this,
        // the next preserve check would still interpret the prior drag offset
        // against an anchor that belongs to the old policy.
        placement.inner.lock().unwrap().anchor =
            window.outer_position().ok().map(|p| (p.x, p.y));
    }
    // Only a dragged window without an explicit policy change keeps its spot.
    // A preset switch (cfg_changed) always re-arms the anchor immediately.
    let preserve = !cfg_changed && preserve_manual_spot(&window, &settings.appearance);
    apply_launcher_chrome(&window, &settings.appearance);
    crate::window_geometry::apply_settings(&window, &settings.appearance, preserve)?;
    crate::appicon::apply(app, &settings.appearance.color_mode);
    Ok(())
}

/// Re-apply the launcher's position after the frontend resized its height —
/// kept anchored to the center / chosen corner while the window still sits
/// exactly where we put it. No-op for 记住位置 and follow-mouse, or once the
/// user moved the window by hand: from then on its spot is theirs (docs/ROADMAP_HISTORY.md
/// #41).
#[tauri::command]
pub fn apply_position(app: AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(());
    };
    let appearance = app
        .state::<crate::settings::SettingsState>()
        .current()
        .appearance;
    crate::window_geometry::apply_stored_geometry(&window, &appearance)
}

/// Logical height (CSS px) of the current monitor's work area — the screen
/// minus the taskbar. Used as the "expand everything" window-height cap so an
/// expanded bar can fill the screen but never run off it. Returns `0.0` when
/// no monitor is resolved; the frontend then falls back to `window_height`.
#[tauri::command]
pub fn get_work_area(app: AppHandle) -> Result<f64, String> {
    let window = app
        .get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| "main window not found".to_string())?;
    let Some(monitor) = window.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(0.0);
    };
    let wa = monitor.work_area();
    Ok(wa.size.height as f64 / monitor.scale_factor())
}

// ── Satellite preview window (docs/ROADMAP_HISTORY.md #15) ───────────────────────────────────
// All clipboard previews (text / text files / images / audio / video) render in
// this separate, non-activating window docked flush to the main window's right
// edge. It is created on the first request, navigates to `about:blank` on close
// so decoded resources leave the page, stays warm briefly for selection bursts,
// then the webview itself is destroyed. See `docs/ROADMAP_HISTORY.md` #15.

/// The frontend's last pushed preview request. The page reads it on mount
/// (`get_preview_request`) — which also self-corrects a `preview-update` event
/// that raced a page load — and it is cleared on close.
#[derive(Default)]
pub struct PreviewState {
    request: Mutex<Option<PreviewRequest>>,
    /// Set by `preview_renderer_ready` after preview.html mounts. Cleared
    /// before every teardown/navigation so URL races cannot masquerade as a
    /// resident page.
    page_ready: AtomicBool,
}

/// What the satellite preview window renders.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct PreviewRequest {
    /// `"text" | "textfile" | "image" | "audio" | "video" | "pdf" | "filelist"`.
    pub kind: String,
    /// Plain text shown directly (`kind == "text"`).
    #[serde(default)]
    pub content: Option<String>,
    /// A file path (`textfile` / `audio` / `video` / `pdf`, and image-*file* rows).
    #[serde(default)]
    pub path: Option<String>,
    /// A clipboard row id (image-*kind* rows: resolved via `get_clipboard_image`;
    /// `filelist` rows: the target for `set_clipboard_checked`).
    #[serde(default)]
    pub id: Option<u32>,
    /// Multi-file rows (`kind == "filelist"`): every recorded path.
    #[serde(default)]
    pub paths: Option<Vec<String>>,
    /// Stored checked-file indices for the multi-file list (`None` = no override
    /// → every existing file is checked by default).
    #[serde(default)]
    pub checked: Option<Vec<u32>>,
    /// 记住勾选 at request time — the satellite shows the toggle state.
    #[serde(default)]
    pub remember_checks: Option<bool>,
}

/// Show or update the satellite preview. The request is stored first, then the
/// page is either poked with a `preview-update` event (when already resident —
/// selection changes don't reload, no flicker) or navigated back to
/// `preview.html` (when the page was torn down to `about:blank` on a previous
/// close). Re-docks on every call and shows without focusing (the window is
/// `WS_EX_NOACTIVATE` — it must never steal focus from the launcher, whose
/// blur-to-hide rule would otherwise fire).
/// The satellite preview is a core host capability shared by first-party
/// pages and external plugins. Commands accept the trusted main window (the
/// in-process PreviewHost) and plugin callers; a plugin must declare the
/// `preview` capability and may only use an explicitly renderable content kind.
const PREVIEW_CAPABILITY: &str = "preview";

fn assert_preview_caller(
    perms: &crate::plugin_perm::PluginPermState,
    settings: &crate::settings::SettingsState,
    window: &WebviewWindow,
    plugin_id: Option<&str>,
    host_token: Option<&str>,
) -> Result<Option<String>, String> {
    // The satellite renderer is first-party core UI (the in-window × uses
    // close_preview). External plugin callers never have this window label.
    if window.label() == PREVIEW_WINDOW {
        return Ok(None);
    }
    crate::plugin_perm::assert_native_or_capability_resolved(
        perms,
        settings,
        window,
        plugin_id,
        host_token,
        PREVIEW_CAPABILITY,
    )
}

fn validate_preview_request(req: &PreviewRequest) -> Result<(), String> {
    if !matches!(
        req.kind.as_str(),
        "text" | "textfile" | "image" | "audio" | "video" | "pdf" | "filelist"
    ) {
        return Err(format!(
            "unsupported preview kind \"{}\" (expected text, textfile, image, audio, video, pdf or filelist)",
            req.kind
        ));
    }
    const MAX_TEXT_CHARS: usize = 512 * 1024;
    const MAX_PATH_CHARS: usize = 32 * 1024;
    const MAX_FILELIST_PATHS: usize = 1024;
    if req.content.as_ref().is_some_and(|value| value.len() > MAX_TEXT_CHARS) {
        return Err(format!("preview text exceeds {MAX_TEXT_CHARS} chars"));
    }
    if req.path.as_ref().is_some_and(|value| value.len() > MAX_PATH_CHARS || value.contains('\0')) {
        return Err("preview path is invalid or too long".into());
    }
    if let Some(paths) = &req.paths {
        if paths.len() > MAX_FILELIST_PATHS {
            return Err(format!("preview file list exceeds {MAX_FILELIST_PATHS} paths"));
        }
        if paths.iter().any(|value| value.len() > MAX_PATH_CHARS || value.contains('\0')) {
            return Err("preview file list contains an invalid path".into());
        }
    }
    if req.checked.as_ref().is_some_and(|checked| checked.len() > MAX_FILELIST_PATHS) {
        return Err(format!("preview checked list exceeds {MAX_FILELIST_PATHS} indices"));
    }
    match req.kind.as_str() {
        "text" if req.content.is_none() => Err("text preview requires content".into()),
        "textfile" | "audio" | "video" | "pdf" if req.path.is_none() => {
            Err(format!("{} preview requires path", req.kind))
        }
        "image" if req.path.is_none() && req.id.is_none() => {
            Err("image preview requires path or clipboard id".into())
        }
        "filelist" if req.paths.as_ref().is_none_or(Vec::is_empty) => {
            Err("filelist preview requires paths".into())
        }
        _ => Ok(()),
    }
}

fn preview_follow_allowed(caller: Option<&str>, clipboard_setting: bool) -> bool {
    // First-party follow obeys the clipboard setting; explicit plugin calls are
    // governed by the preview manifest capability instead.
    caller.is_some() || clipboard_setting
}

/// Create the satellite preview on first use. Creation is serialized separately
/// from the idle-destroy activity epoch: concurrent `show_preview` calls share
/// one webview, while an old destroy timer cannot remove a newer instance.
fn ensure_preview_window(app: &AppHandle) -> Result<(WebviewWindow, bool), String> {
    let _guard = PREVIEW_CREATE_LOCK
        .lock()
        .map_err(|_| "preview window creation lock poisoned".to_string())?;
    if let Some(window) = app.get_webview_window(PREVIEW_WINDOW) {
        return Ok((window, false));
    }

    let settings = crate::settings::snapshot(&app.state::<crate::settings::SettingsState>());
    let lang = crate::i18n::UiLang::from_setting(&settings.appearance.language);
    let window = WebviewWindowBuilder::new(
        app,
        PREVIEW_WINDOW,
        WebviewUrl::App("preview.html".into()),
    )
    .title(crate::texts::window_title_preview(lang))
    .inner_size(PREVIEW_W_LOGICAL, 480.0) // real size set on every dock
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .visible(false)
    .background_color(tauri::window::Color(30, 30, 32, 255))
    .disable_drag_drop_handler()
    .initialization_script(debug_flag_script())
    .build()
    .map_err(|error| error.to_string())?;

    set_webview_default_background(&window, (30, 30, 32, 255))?;
    crate::webview_guard::install(&window);
    clear_dwm_border(&window);
    set_webview_resource_state(app, PREVIEW_WINDOW, false, true);
    Ok((window, true))
}

/// Wait for preview.html to install its listener and read the pending request.
/// The navigation itself is asynchronous; revealing before this handshake can
/// show the blank bootstrap document.
async fn wait_for_preview_ready(app: &AppHandle) -> Result<(), String> {
    for _ in 0..240 {
        let ready = app
            .try_state::<PreviewState>()
            .map(|state| state.page_ready.load(Ordering::SeqCst))
            .unwrap_or(false);
        if ready {
            return Ok(());
        }
        std::thread::sleep(std::time::Duration::from_millis(25));
    }
    Err("preview renderer did not become ready".into())
}

#[tauri::command]
pub async fn show_preview(
    app: AppHandle,
    req: PreviewRequest,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: WebviewWindow,
    perms: State<'_, crate::plugin_perm::PluginPermState>,
    settings: State<'_, crate::settings::SettingsState>,
) -> Result<(), String> {
    let caller = assert_preview_caller(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
    )?;
    validate_preview_request(&req)?;
    // The clipboard-specific setting only gates the internal selection
    // follow source. An explicit plugin preview is its own host capability and
    // must not disappear because clipboard previews were disabled.
    let clipboard_preview = app
        .state::<crate::settings::SettingsState>()
        .current()
        .clipboard
        .preview;
    if !preview_follow_allowed(caller.as_deref(), clipboard_preview) {
        teardown_preview(&app);
        return Ok(());
    }
    // The satellite lives and dies with the launcher: never reveal a preview
    // while the launcher itself is hidden. This matters when 开启预览 is toggled
    // back on in settings — the settings window steals focus and hides the
    // launcher, so the frontend's preview sync fires `show_preview` while the
    // launcher is gone; without this gate a lone satellite window would pop up.
    // It also guards the same latent case of new clipboard rows arriving while
    // hidden.
    let launcher_visible = app
        .get_webview_window(MAIN_WINDOW)
        .map(|w| w.is_visible().unwrap_or(false))
        .unwrap_or(false);
    if !launcher_visible {
        teardown_preview(&app);
        return Ok(());
    }
    // A live request invalidates every pending idle-destroy timer before the
    // window is created or reused.
    PREVIEW_ACTIVITY.fetch_add(1, Ordering::SeqCst);
    if let Some(state) = app.try_state::<PreviewState>() {
        *state.request.lock().unwrap() = Some(req.clone());
    }
    let (preview, created) = ensure_preview_window(&app)?;
    // Track page readiness explicitly. `navigate(about:blank)` is asynchronous,
    // so `window.url()` can still report preview.html while the teardown is in
    // flight; trusting it leaves the next preview on a blank page.
    let page_ready = app
        .try_state::<PreviewState>()
        .map(|state| state.page_ready.load(Ordering::SeqCst))
        .unwrap_or(false);
    if page_ready {
        let _ = preview.emit("preview-update", &req);
    } else {
        if let Some(state) = app.try_state::<PreviewState>() {
            state.page_ready.store(false, Ordering::SeqCst);
        }
        if !created {
            preview
                .navigate(preview_page_url(&app))
                .map_err(|e| e.to_string())?;
        }
        wait_for_preview_ready(&app).await?;
    }
    // Dock + size before reveal; works while hidden too.
    if !redock(&app).map_err(|e| e.to_string())? {
        // No room on either side. Tear the hidden page down and start its idle
        // lifetime instead of leaving a detached renderer resident forever.
        teardown_preview(&app);
        return Ok(());
    }
    if !preview.is_visible().map_err(|e| e.to_string())? {
        // Restore controller visibility/normal residency and reveal the parent
        // in one main-thread callback. A direct `ShowWindow` here used to race
        // the queued controller update, briefly showing a controller-hidden page.
        show_webview_no_activate(&app, PREVIEW_WINDOW)?;
    }
    // Arm the launcher's Esc-priority state for every preview caller.
    // The preview renderer reads the full request from its own window.
    let _ = app.emit_to(MAIN_WINDOW, "preview-opened", ());
    // Preview visible → Normal; the hidden settings stays Low.
    sync_aux_memory_targets(&app);
    Ok(())
}

/// Hide the satellite preview and tear its page down to `about:blank` — this
/// releases decoded bitmaps / media buffers (the renderer process stays
/// resident ~15MB for reuse).
#[tauri::command]
pub fn close_preview(
    app: AppHandle,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: WebviewWindow,
    perms: State<'_, crate::plugin_perm::PluginPermState>,
    settings: State<'_, crate::settings::SettingsState>,
) -> Result<(), String> {
    assert_preview_caller(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
    )?;
    teardown_preview(&app);
    Ok(())
}

/// Read the pending preview request — the page calls this once on mount.
/// Returns `None` when there is nothing to show.
#[tauri::command]
pub fn get_preview_request(
    state: State<'_, PreviewState>,
    window: WebviewWindow,
) -> Result<Option<PreviewRequest>, String> {
    let label = window.label();
    if label != MAIN_WINDOW && label != PREVIEW_WINDOW {
        return Err("get_preview_request: trusted launcher window required".into());
    }
    Ok(state.request.lock().unwrap().clone())
}

/// The preview renderer has installed its live-update listener and consumed
/// the pending request. `show_preview` waits for this before revealing the
/// native HWND, preventing a blank controller/page from flashing.
#[tauri::command]
pub fn preview_renderer_ready(
    state: State<'_, PreviewState>,
    window: WebviewWindow,
) -> Result<(), String> {
    if window.label() != PREVIEW_WINDOW {
        return Err("preview_renderer_ready: preview window required".into());
    }
    // A teardown can navigate to `about:blank` while preview.html is still
    // starting. A late ready call must not mark that blank document resident.
    if state.request.lock().unwrap().is_none() {
        return Ok(());
    }
    state.page_ready.store(true, Ordering::SeqCst);
    Ok(())
}

async fn grant_asset_file(path: String, app: AppHandle) -> Result<(), String> {
    let canonical = tauri::async_runtime::spawn_blocking(move || std::fs::canonicalize(path))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| format!("asset path is unavailable: {error}"))?;
    if !canonical.is_file() {
        return Err("asset path is not a file".into());
    }
    app.asset_protocol_scope()
        .allow_file(&canonical)
        .map_err(|error| error.to_string())
}

/// Grant the asset protocol access to one user-selected preview file. The
/// static scope covers Lume's own data/resource trees; arbitrary pictures,
/// videos and PDFs are allowed only after the trusted main/preview renderer
/// asks for that exact canonical path.
#[tauri::command]
pub async fn allow_asset_path(
    path: String,
    window: WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    if window.label() != MAIN_WINDOW && window.label() != PREVIEW_WINDOW {
        return Err("allow_asset_path: trusted preview caller required".into());
    }
    grant_asset_file(path, app).await
}

/// Plugin-facing asset grant. Unlike the trusted renderer command above, this
/// path re-checks the caller's manifest and requires the `fs.read` capability,
/// then whitelists exactly the requested file. The service converts the path
/// with `convertFileSrc` only after this succeeds.
#[tauri::command]
pub async fn plugin_allow_asset_path(
    path: String,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: WebviewWindow,
    perms: State<'_, crate::plugin_perm::PluginPermState>,
    settings: State<'_, crate::settings::SettingsState>,
    app: AppHandle,
) -> Result<(), String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "fs.read",
    )?;
    grant_asset_file(path, app).await
}

/// Destroy a hidden preview after its idle window. The activity epoch changes
/// on every show and teardown, so a stale timer cannot remove a page that has
/// become active again.
fn schedule_preview_destroy_if_idle(app: &AppHandle) {
    let epoch = PREVIEW_ACTIVITY.fetch_add(1, Ordering::SeqCst) + 1;
    let timeout =
        debug_timeout_secs("LUME_PREVIEW_IDLE_DESTROY_SECS", PREVIEW_IDLE_DESTROY_SECS);
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("preview-idle-destroy".into())
        .spawn(move || {
            std::thread::sleep(std::time::Duration::from_secs(timeout));
            let Ok(_guard) = PREVIEW_CREATE_LOCK.lock() else {
                return;
            };
            if PREVIEW_ACTIVITY.load(Ordering::SeqCst) != epoch {
                return;
            }
            let Some(window) = app.get_webview_window(PREVIEW_WINDOW) else {
                return;
            };
            if window.is_visible().unwrap_or(true) {
                return;
            }
            let _ = window.destroy();
            drop(window);
            for _ in 0..50 {
                if app.get_webview_window(PREVIEW_WINDOW).is_none() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });
}

/// Hide the preview, release its current media/page resources, and arm the
/// bounded idle destroy. Used by `close_preview` and every launcher-hide path
/// (blur-to-hide, hotkey toggle, Esc). Idempotent.
pub fn teardown_preview(app: &AppHandle) {
    PREVIEW_ACTIVITY.fetch_add(1, Ordering::SeqCst);
    // Invalidate the readiness handshake before the asynchronous navigation so
    // a concurrent show cannot reuse a page that is already leaving.
    if let Some(state) = app.try_state::<PreviewState>() {
        *state.request.lock().unwrap() = None;
        state.page_ready.store(false, Ordering::SeqCst);
    }
    let had_window = if let Some(preview) = app.get_webview_window(PREVIEW_WINDOW) {
        // Tear the page down first, then hide synchronously via Win32. Tauri's
        // `hide()` is queued on the thread executor and can race navigation —
        // the page unload can re-show the window, leaving it visible after
        // teardown.
        let _ = preview.navigate(tauri::Url::parse("about:blank").unwrap());
        if let Ok(hwnd) = preview.hwnd() {
            use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
            unsafe {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
        set_webview_resource_state(app, PREVIEW_WINDOW, false, true);
        true
    } else {
        false
    };
    // Preview hidden → Low (settings too, per its own visibility).
    sync_aux_memory_targets(app);
    if had_window {
        // Every teardown path clears the launcher's Esc-priority mirror.
        let _ = app.emit_to(MAIN_WINDOW, "preview-closed", ());
        schedule_preview_destroy_if_idle(app);
    }
}

/// True when the mouse cursor sits over the *visible* satellite preview — used
/// by the launcher's blur-to-hide rule to stay up when the user clicks the
/// preview (WS_EX_NOACTIVATE stops the preview activating, but the launcher can
/// still blur; a cursor over the preview means the click was meant for it).
pub fn preview_has_cursor(app: &AppHandle) -> bool {
    let Some(preview) = app.get_webview_window(PREVIEW_WINDOW) else {
        return false;
    };
    preview.is_visible().unwrap_or(false) && cursor_is_over(&preview)
}

/// Size (320 logical wide, the main window's current logical height) and dock
/// the preview flush to the main window. Re-run on every `show_preview` and on
/// the main window's Moved/Resized. No-op when either window is missing.
/// Returns `true` when the preview was placed, `false` when no side has room
/// (the window is hidden instead of overlapping the main window).
pub fn redock(app: &AppHandle) -> tauri::Result<bool> {
    let Some(main) = app.get_webview_window(MAIN_WINDOW) else {
        return Ok(false);
    };
    let Some(preview) = app.get_webview_window(PREVIEW_WINDOW) else {
        return Ok(false);
    };
    let sf = main.scale_factor()?;
    // Dock to the main window's on-screen CLIENT area — the visible launcher
    // surface. `outer_*` includes the frameless window's non-client margins and
    // `inner_position()` is not the client origin on screen; both leave a gap
    // (22×13 physical px at 150% DPI). GetClientRect + ClientToScreen give the
    // authoritative client rect on screen, flush at any DPI.
    let hwnd = main.hwnd()?;
    use windows::Win32::Foundation::{POINT, RECT};
    use windows::Win32::Graphics::Gdi::ClientToScreen;
    use windows::Win32::UI::WindowsAndMessaging::GetClientRect;
    let mut rect = RECT::default();
    let mut origin = POINT::default();
    unsafe {
        let _ = GetClientRect(hwnd, &mut rect);
        let _ = ClientToScreen(hwnd, &mut origin);
    }
    let main_pos = PhysicalPosition::new(origin.x, origin.y);
    let main_size = PhysicalSize::new(rect.right as u32, rect.bottom as u32);
    // Height follows the main client height. Compute the physical size from the
    // intended logical size — reading a size right after `set_size()` is async
    // on Windows and can round-trip.
    let main_h_logical = main_size.to_logical::<f64>(sf).height;
    let logical = LogicalSize::new(PREVIEW_W_LOGICAL, main_h_logical);
    preview.set_size(logical)?;
    let preview_phys = logical.to_physical::<u32>(sf);
    let Some(monitor) = main.current_monitor()? else {
        return Ok(false);
    };
    // `dock_position` returns the desired preview CLIENT origin. But the preview
    // window keeps a small non-client frame even though it is `decorations(false)`
    // (a ~11px left / ~2px top border at 150% DPI, measured via the same
    // GetClientRect + ClientToScreen probe used for the main window), and
    // `set_position` places the OUTER origin. Docking on the client origin
    // directly would overlap the main window by that left margin on a LEFT dock
    // (and leave a matching hidden gap on a RIGHT dock). Offset the outer target
    // back by the measured client→outer inset so both sides are truly flush.
    let gap = (PREVIEW_GAP_LOGICAL * sf).round() as i32;
    let client_target = match dock_position(main_pos, main_size, preview_phys, gap, monitor.work_area()) {
            Some(pos) => pos,
            // Neither side fits flush (see `dock_position`) — the preview cannot be
            // docked without overlapping the main window, so hide it. The page stays
            // loaded so a later re-dock (window moved back, next selection change)
            // shows instantly.
            None => {
                if let Ok(hwnd) = preview.hwnd() {
                    use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_HIDE};
                    unsafe {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                }
                return Ok(false);
            }
        };
    let pv_hwnd = preview.hwnd()?;
    let mut pv_rect = RECT::default();
    let mut pv_origin = POINT::default();
    unsafe {
        let _ = GetClientRect(pv_hwnd, &mut pv_rect);
        let _ = ClientToScreen(pv_hwnd, &mut pv_origin);
    }
    let pv_outer = preview.outer_position()?;
    let inset_x = pv_origin.x - pv_outer.x;
    let inset_y = pv_origin.y - pv_outer.y;
    preview.set_position(PhysicalPosition::new(
        client_target.x - inset_x,
        client_target.y - inset_y,
    ))?;
    Ok(true)
}

/// Pure dock math (unit-testable): the desired preview **CLIENT** origin — the
/// main window's client right edge plus `gap`, top-aligned, or (when that
/// overflows the work area) the main window's client LEFT edge minus `gap` —
/// the same `gap` on both sides. When the main window sits so close to the work
/// area's left edge that a left dock (gap included) would run off-screen
/// (overlapping the main window), there is no room on either side — return
/// `None` so the caller hides the preview.
fn dock_position(
    main_pos: PhysicalPosition<i32>,
    main_size: PhysicalSize<u32>,
    preview_size: PhysicalSize<u32>,
    gap: i32,
    work_area: &PhysicalRect<i32, u32>,
) -> Option<PhysicalPosition<i32>> {
    let right = main_pos.x + main_size.width as i32;
    let work_right = work_area.position.x + work_area.size.width as i32;
    let fits_right = right + gap + preview_size.width as i32 <= work_right;
    if fits_right {
        Some(PhysicalPosition::new(right + gap, main_pos.y))
    } else {
        let left = main_pos.x - gap - preview_size.width as i32;
        (left >= work_area.position.x).then(|| PhysicalPosition::new(left, main_pos.y))
    }
}

/// The URL of the satellite page: the vite dev server in dev, the bundled app
/// protocol in production. Kept in one place — verify against the running
/// app's `window.location.origin` once (docs/ROADMAP_HISTORY.md #15).
fn preview_page_url(app: &AppHandle) -> tauri::Url {
    let base = if cfg!(dev) {
        app.config()
            .build
            .dev_url
            .clone()
            .unwrap_or_else(|| tauri::Url::parse("http://localhost:1420").unwrap())
    } else {
        tauri::Url::parse("http://tauri.localhost").unwrap()
    };
    base.join("preview.html").unwrap_or(base)
}

/// Remove the 1px system border DWM draws around frameless windows that keep
/// their native shadow (`decorations(false)` + `shadow(true)`, opaque
/// resizable ones — the detached plugin, settings and preview windows).
/// The user sees it as a bright stroke around the window on Win11. Only the
/// border line goes: the DWM drop shadow and the Win11 rounded corners stay.
/// Pre-Win11 DWM rejects the attribute — ignore the result.
pub fn clear_dwm_border(win: &WebviewWindow) {
    set_dwm_border(win, None)
}

/// Apply the launcher-specific surface chrome. The native window stays
/// transparent so CSS can render the configured opacity over the desktop;
/// only the DWM strip needs host painting. At full opacity the strip uses the
/// same color as the panel; a translucent window cannot be represented by a
/// DWM color without alpha, so the strip is cleared below 100%.
pub fn apply_launcher_chrome(
    win: &WebviewWindow,
    appearance: &crate::settings::Appearance,
) {
    let rgb = parse_hex_rgb(&appearance.window_color)
        .unwrap_or_else(|| panel_surface_rgb(win, appearance.skin(), &appearance.color_mode));
    if appearance.window_opacity >= crate::settings::WINDOW_OPACITY_MAX {
        set_dwm_border(win, Some(rgb));
    } else {
        set_dwm_border(win, None);
    }
}

/// Fallback values if the generated registry is unreadable. Keep these equal
/// to the Quiet entries in `src/skins/skins.json`; the registry remains the
/// authority whenever parsing succeeds.
pub(crate) const PANEL_SURFACE_DARK: (u8, u8, u8) = (30, 30, 32);
pub(crate) const PANEL_SURFACE_LIGHT: (u8, u8, u8) = (247, 243, 232);

#[derive(Debug, Deserialize)]
struct SkinDefinition {
    surfaces: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct SkinRegistryFile {
    default: String,
    skins: HashMap<String, SkinDefinition>,
}

static SKIN_REGISTRY: OnceLock<Option<SkinRegistryFile>> = OnceLock::new();

fn skin_registry() -> Option<&'static SkinRegistryFile> {
    SKIN_REGISTRY
        .get_or_init(|| serde_json::from_str(include_str!("../../src/skins/skins.json")).ok())
        .as_ref()
}

fn parse_hex_rgb(value: &str) -> Option<(u8, u8, u8)> {
    let raw = value.trim().strip_prefix('#')?;
    if raw.len() != 6 || !raw.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return None;
    }
    Some((
        u8::from_str_radix(&raw[0..2], 16).ok()?,
        u8::from_str_radix(&raw[2..4], 16).ok()?,
        u8::from_str_radix(&raw[4..6], 16).ok()?,
    ))
}

/// Shared surface lookup for one already-resolved light/dark mode. Unknown
/// skins fall back to the registry default, then to the Quiet fallback values.
fn skin_surface_rgb(skin: &str, dark: bool) -> (u8, u8, u8) {
    let fallback = if dark {
        PANEL_SURFACE_DARK
    } else {
        PANEL_SURFACE_LIGHT
    };
    let Some(registry) = skin_registry() else {
        return fallback;
    };
    let key = if registry.skins.contains_key(skin) && !skin.is_empty() {
        skin
    } else {
        registry.default.as_str()
    };
    registry
        .skins
        .get(key)
        .and_then(|definition| {
            definition
                .surfaces
                .get(if dark { "dark" } else { "light" })
        })
        .and_then(|value| parse_hex_rgb(value))
        .unwrap_or(fallback)
}

/// The skin's solid panel surface for a color-mode setting — the one value
/// shared by the launcher panel, the DWM frame strip, the default
/// plugin-page canvas and `skins.json` consumers. `"system"` follows the OS
/// app theme (the same source the frontend's `prefers-color-scheme` resolves
/// against).
///
/// `pub(crate)`: a detached plugin window paints the same value as its own
/// opaque canvas, in the PLUGIN's effective mode (plugin_window.rs).
pub(crate) fn panel_surface_rgb(
    win: &WebviewWindow,
    skin: &str,
    color_mode: &str,
) -> (u8, u8, u8) {
    let dark = match color_mode {
        "light" => false,
        "dark" => true,
        _ => win.theme().map(|t| t == tauri::Theme::Dark).unwrap_or(true),
    };
    skin_surface_rgb(skin, dark)
}

/// `panel_surface_rgb` for a window that does not exist yet (the detached
/// plugin window's builder call): `"system"` resolves through the main
/// window's OS app theme, exactly as it does for a live window. A missing main
/// window can only mean the launcher is between windows — dark is the same
/// fallback `panel_surface_rgb` uses.
pub(crate) fn panel_surface_rgb_for(
    app: &AppHandle,
    skin: &str,
    color_mode: &str,
) -> (u8, u8, u8) {
    match app.get_webview_window("main") {
        Some(win) => panel_surface_rgb(&win, skin, color_mode),
        None => skin_surface_rgb(skin, color_mode != "light"),
    }
}

fn set_dwm_border(win: &WebviewWindow, rgb: Option<(u8, u8, u8)>) {
    let Ok(hwnd) = win.hwnd() else { return };
    // DWMWA_COLOR_NONE ("draw no border") or a 0x00BBGGRR COLORREF.
    let color = match rgb {
        None => COLORREF(0xFFFF_FFFE),
        Some((r, g, b)) => COLORREF(r as u32 | (g as u32) << 8 | (b as u32) << 16),
    };
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR,
            std::ptr::from_ref(&color).cast(),
            std::mem::size_of::<COLORREF>() as u32,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hide_suppression_can_be_cleared_after_a_uac_prompt() {
        let focus = FocusState::default();
        suppress_hide(&focus, 60_000);
        assert!(is_hide_suppressed(&focus));
        clear_hide_suppression(&focus);
        assert!(!is_hide_suppressed(&focus));
    }

    #[test]
    fn preview_request_gate_accepts_supported_shapes() {
        for value in [
            serde_json::json!({"kind":"text","content":"hello"}),
            serde_json::json!({"kind":"textfile","path":"C:\\a.txt"}),
            serde_json::json!({"kind":"image","path":"C:\\a.png"}),
            serde_json::json!({"kind":"image","id":7}),
            serde_json::json!({"kind":"audio","path":"C:\\a.mp3"}),
            serde_json::json!({"kind":"video","path":"C:\\a.mp4"}),
            serde_json::json!({"kind":"pdf","path":"C:\\a.pdf"}),
            serde_json::json!({"kind":"filelist","paths":["C:\\a.txt","C:\\b.txt"]}),
        ] {
            let req: PreviewRequest = serde_json::from_value(value).unwrap();
            assert!(validate_preview_request(&req).is_ok(), "rejected {req:?}");
        }
    }

    #[test]
    fn preview_request_gate_rejects_missing_payload_and_unknown_kind() {
        let no_text: PreviewRequest = serde_json::from_value(serde_json::json!({"kind":"text"})).unwrap();
        assert!(validate_preview_request(&no_text).is_err());
        let no_path: PreviewRequest = serde_json::from_value(serde_json::json!({"kind":"pdf"})).unwrap();
        assert!(validate_preview_request(&no_path).is_err());
        let no_image: PreviewRequest = serde_json::from_value(serde_json::json!({"kind":"image"})).unwrap();
        assert!(validate_preview_request(&no_image).is_err());
        let unknown: PreviewRequest = serde_json::from_value(serde_json::json!({"kind":"html","content":"x"})).unwrap();
        assert!(validate_preview_request(&unknown).is_err());
    }

    #[test]
    fn preview_setting_only_gates_internal_follow() {
        assert!(preview_follow_allowed(None, true));
        assert!(!preview_follow_allowed(None, false));
        assert!(preview_follow_allowed(Some("plugin"), false));
        assert!(preview_follow_allowed(Some("plugin"), true));
    }

    #[test]
    fn preview_clone_preserves_payload() {
        let req = PreviewRequest {
            kind: "filelist".into(),
            content: None,
            path: None,
            id: Some(7),
            paths: Some(vec!["C:\\a.txt".into()]),
            checked: Some(vec![0]),
            remember_checks: Some(true),
        };
        let clone = req.clone();
        assert_eq!(clone.id, Some(7));
        assert_eq!(clone.checked, Some(vec![0]));
        assert_eq!(clone.remember_checks, Some(true));
    }

    #[test]
    fn preview_request_defaults_optional_fields() {
        let req: PreviewRequest = serde_json::from_value(serde_json::json!({
            "kind": "text",
            "content": "hello"
        }))
        .expect("plugin preview requests need only kind + content/path");
        assert_eq!(req.kind, "text");
        assert_eq!(req.content.as_deref(), Some("hello"));
        assert_eq!(req.id, None);
        assert_eq!(req.paths, None);
    }

    #[test]
    fn preview_request_rejects_unknown_kind_only_at_the_boundary() {
        // Unknown kinds are shaped like any other request; the renderer fails
        // closed with its generic load error rather than exposing raw HTML.
        let req: PreviewRequest = serde_json::from_value(serde_json::json!({
            "kind": "html",
            "content": "<script>alert(1)</script>"
        }))
        .unwrap();
        assert_eq!(req.kind, "html");
    }

    fn wa() -> PhysicalRect<i32, u32> {
        PhysicalRect {
            position: PhysicalPosition::new(0, 0),
            size: PhysicalSize::new(1920, 1080),
        }
    }

    #[test]
    fn dock_flush_right_when_room() {
        let pos = dock_position(
            PhysicalPosition::new(100, 50),
            PhysicalSize::new(720, 480),
            PhysicalSize::new(320, 480),
            0,
            &wa(),
        );
        assert_eq!(pos, Some(PhysicalPosition::new(820, 50)));
    }

    #[test]
    fn dock_right_at_exact_boundary() {
        let pos = dock_position(
            PhysicalPosition::new(100, 50),
            PhysicalSize::new(300, 480),
            PhysicalSize::new(320, 480),
            0,
            &wa(), // 400 + 320 == 1920? no — work area right = 1920, so 720 fits
        );
        assert_eq!(pos, Some(PhysicalPosition::new(400, 50)));
    }

    #[test]
    fn dock_left_when_right_overflows() {
        let pos = dock_position(
            PhysicalPosition::new(1400, 50),
            PhysicalSize::new(720, 480),
            PhysicalSize::new(320, 480),
            0,
            &wa(), // 1400 + 720 + 320 = 2440 > 1920 → left at 1080
        );
        assert_eq!(pos, Some(PhysicalPosition::new(1080, 50)));
    }

    #[test]
    fn dock_left_flush_matches_right_gap() {
        // The left dock carries the same gap as the right side: the preview's
        // right edge sits `gap` px to the left of the main window's left edge.
        let pos = dock_position(
            PhysicalPosition::new(900, 50),
            PhysicalSize::new(1000, 480), // right = 1900 + 320 > 1920 → left
            PhysicalSize::new(320, 480),
            0,
            &wa(), // left = 900 - 320 = 580, within the work area
        );
        assert_eq!(pos, Some(PhysicalPosition::new(580, 50)));
    }

    #[test]
    fn dock_applies_gap_on_both_sides() {
        // A nonzero gap moves the preview away from the main on EACH side.
        let right = dock_position(
            PhysicalPosition::new(100, 50),
            PhysicalSize::new(720, 480),
            PhysicalSize::new(320, 480),
            6,
            &wa(),
        );
        assert_eq!(right, Some(PhysicalPosition::new(826, 50)));
        let left = dock_position(
            PhysicalPosition::new(1400, 50),
            PhysicalSize::new(720, 480),
            PhysicalSize::new(320, 480),
            6,
            &wa(), // right = 1400+720+6+320 > 1920 → left = 1400-6-320 = 1074
        );
        assert_eq!(left, Some(PhysicalPosition::new(1074, 50)));
    }

    #[test]
    fn dock_gap_takes_the_last_slot() {
        // The gap counts toward the work-area budget: with main at x=426 a
        // 6px gap just fits on the left (426-6-320 = 100 = work left), while a
        // 7px gap leaves no room on either side → None (preview hidden).
        let wa = PhysicalRect {
            position: PhysicalPosition::new(100, 0),
            size: PhysicalSize::new(800, 600), // right = 900
        };
        let fits = dock_position(
            PhysicalPosition::new(426, 50),
            PhysicalSize::new(400, 480), // right = 426+400+6+320 = 1152 > 900
            PhysicalSize::new(320, 480),
            6,
            &wa, // left = 426-6-320 = 100 ≥ 100
        );
        assert_eq!(fits, Some(PhysicalPosition::new(100, 50)));
        let none = dock_position(
            PhysicalPosition::new(426, 50),
            PhysicalSize::new(400, 480),
            PhysicalSize::new(320, 480),
            7,
            &wa, // left = 426-7-320 = 99 < 100 → no room
        );
        assert_eq!(none, None);
    }

    #[test]
    fn dock_left_hidden_when_no_room_on_either_side() {
        // Main window close to the left edge AND the right side overflowing
        // (high DPI / narrow work area): a left dock would run off the work
        // area and overlap the main window — return None so the caller hides
        // the preview instead.
        let wa = PhysicalRect {
            position: PhysicalPosition::new(100, 0),
            size: PhysicalSize::new(800, 600),
        };
        let pos = dock_position(
            PhysicalPosition::new(200, 50),
            PhysicalSize::new(400, 480), // right = 200+400+320 = 920 > 900
            PhysicalSize::new(320, 480),
            0,
            &wa, // left = 200-320 = -120 < work_area.x = 100 → no room
        );
        assert_eq!(pos, None);
    }

    #[test]
    fn shared_skin_registry_drives_surfaces_and_unknown_falls_back() {
        assert_eq!(skin_surface_rgb("quiet", true), (30, 30, 32));
        assert_eq!(skin_surface_rgb("quiet", false), (247, 243, 232));
        assert_eq!(skin_surface_rgb("chromatic", true), (30, 30, 32));
        assert_eq!(skin_surface_rgb("chromatic", false), (243, 239, 230));
        assert_eq!(
            skin_surface_rgb("neon-from-the-future", false),
            (247, 243, 232)
        );
    }

    #[test]
    fn shared_skin_json_is_machine_readable() {
        let registry = skin_registry().expect("skins.json parses");
        assert_eq!(registry.default, "quiet");
        assert!(registry.skins.contains_key("quiet"));
        assert!(registry.skins.contains_key("chromatic"));
        for id in ["quiet", "chromatic"] {
            for mode in ["dark", "light"] {
                let value = &registry.skins[id].surfaces[mode];
                assert!(parse_hex_rgb(value).is_some(), "{id}/{mode}: {value}");
            }
        }
    }
}
