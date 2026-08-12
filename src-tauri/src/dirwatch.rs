//! Directory-change watcher — event-driven index refresh.
//!
//! Watches the enabled index directories (Desktop, user dirs, Start Menu) for
//! file changes using `FindFirstChangeNotificationW` — a kernel wait, zero CPU
//! while idle (same idea as `envwatch.rs`). When a change arrives, a short
//! debounce collapses a burst of changes into one `AppIndex::refresh_user`.
//!
//! The watch list follows the settings: `rebuild` re-reads the enabled dirs
//! and bumps a generation counter the watcher thread notices on its next
//! (timeout) iteration, then recreates its notification handles.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{
    FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
    FILE_NOTIFY_CHANGE, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
};
use windows::Win32::System::Threading::WaitForMultipleObjects;

/// How long to wait for more changes before refreshing (debounce window).
const DEBOUNCE: Duration = Duration::from_secs(2);
/// How often the watcher re-checks the generation counter when idle (ms).
const POLL: u32 = 2000;

/// Which change kinds trigger a refresh (add/remove/rename + write + size).
const NOTIFY_FILTER: FILE_NOTIFY_CHANGE = FILE_NOTIFY_CHANGE(
    FILE_NOTIFY_CHANGE_FILE_NAME.0
        | FILE_NOTIFY_CHANGE_DIR_NAME.0
        | FILE_NOTIFY_CHANGE_LAST_WRITE.0
        | FILE_NOTIFY_CHANGE_SIZE.0,
);

/// Shared watch state: the resolved dirs (with recursive flag) plus a
/// generation counter bumped whenever the list changes.
pub struct DirWatchState {
    pub dirs: Mutex<Vec<(PathBuf, bool)>>,
    pub generation: AtomicU32,
}

impl Default for DirWatchState {
    fn default() -> Self {
        Self {
            dirs: Mutex::new(Vec::new()),
            generation: AtomicU32::new(0),
        }
    }
}

/// Start the background watcher and build the initial watch list.
pub fn start(app: &AppHandle) {
    rebuild(app);
    let app = app.clone();
    std::thread::Builder::new()
        .name("dirwatch".into())
        .spawn(move || watch_thread(app))
        .ok();
}

/// Rebuild the watch list from the current settings. Called at startup and on
/// every settings save / manual index refresh.
pub fn rebuild(app: &AppHandle) {
    let Some(state) = app.try_state::<DirWatchState>() else {
        return;
    };
    let settings = app.state::<crate::settings::SettingsState>().current();
    let dirs = watch_dirs(&settings);
    *state.dirs.lock().unwrap() = dirs;
    state.generation.fetch_add(1, Ordering::Relaxed);
}

/// Compute the directories to watch (with recursive flag) from settings.
/// Start Menu is watched recursively (its .lnk live in subfolders); Desktop
/// and user dirs are non-recursive (matching the top-level index).
fn watch_dirs(settings: &crate::settings::Settings) -> Vec<(PathBuf, bool)> {
    let mut dirs: Vec<(PathBuf, bool)> = Vec::new();
    if settings
        .index
        .system_dirs
        .iter()
        .any(|d| d.path == "Desktop" && d.enabled)
    {
        dirs.extend(
            crate::cache::resolve_index_dirs("Desktop")
                .into_iter()
                .map(|p| (p, false)),
        );
    }
    for spec in &settings.index.user_dirs {
        dirs.extend(
            crate::cache::resolve_index_dirs(spec)
                .into_iter()
                .map(|p| (p, false)),
        );
    }
    if settings
        .index
        .system_dirs
        .iter()
        .any(|d| d.path == "StartMenu" && d.enabled)
    {
        dirs.extend(
            crate::cache::start_menu_dirs()
                .into_iter()
                .map(|p| (p, true)),
        );
    }
    dirs
}

/// Create a change-notification handle for one directory. Returns None when
/// the directory doesn't exist or the API fails.
unsafe fn make_handle(dir: &PathBuf, recursive: bool) -> Option<HANDLE> {
    let path = dir.to_string_lossy();
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    FindFirstChangeNotificationW(PCWSTR(wide.as_ptr()), recursive, NOTIFY_FILTER).ok()
}

fn watch_thread(app: AppHandle) {
    let mut last_gen = 0u32;
    let mut handles: Vec<HANDLE> = Vec::new();
    let mut dirty_since: Option<Instant> = None;

    loop {
        let state = app.state::<DirWatchState>();
        let gen = state.generation.load(Ordering::Relaxed);

        if gen != last_gen {
            // Rebuild the handle list for the new directory set.
            for h in handles.drain(..) {
                unsafe { let _ = FindCloseChangeNotification(h); }
            }
            let dirs = state.dirs.lock().unwrap().clone();
            handles = dirs
                .iter()
                .filter_map(|(p, rec)| unsafe { make_handle(p, *rec) })
                .collect();
            last_gen = gen;
            dirty_since = None;
        }

        if handles.is_empty() {
            std::thread::sleep(Duration::from_millis(POLL as u64));
            continue;
        }

        let result = unsafe { WaitForMultipleObjects(&handles, false, POLL) };
        let first = WAIT_OBJECT_0.0;
        if result.0 >= first && result.0 < first + handles.len() as u32 {
            let idx = (result.0 - first) as usize;
            unsafe { let _ = FindNextChangeNotification(handles[idx]); }
            if dirty_since.is_none() {
                dirty_since = Some(Instant::now());
            }
        }

        // After a quiet window, apply one refresh.
        if let Some(since) = dirty_since {
            if since.elapsed() >= DEBOUNCE {
                let index = app.state::<crate::apps::AppIndex>();
                let settings = app.state::<crate::settings::SettingsState>().current();
                index.refresh_user(&settings);
                dirty_since = None;
            }
        }
    }
}
