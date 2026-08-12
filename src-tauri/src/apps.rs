//! Search and launch.
//!
//! Search reads from the index caches in `cache.rs` (docs/SETTINGS.md): the
//! System32 preset DB plus the Desktop/user cache DB, both loaded into memory.
//! The caches are refreshed on startup and hourly (differential); this module
//! holds the in-memory copies and the search/filter logic.

use std::sync::Mutex;

use tauri::{Manager, State};

use crate::cache::{self, AppEntry};
use crate::settings::{Settings, SettingsState};

/// Maximum results returned for a typed query.
const MAX_RESULTS: usize = 8;
/// Cap for the empty-query browse.
const BROWSE_CAP: usize = 200;

/// Search caches (in-memory mirrors of `cache.rs` DBs), managed by Tauri.
pub struct AppIndex {
    /// System32 executable entries (loaded from `system32_cache.db`).
    sys32: Mutex<Option<Vec<AppEntry>>>,
    /// Desktop + user entries (loaded from `user_cache.db`).
    user: Mutex<Option<Vec<AppEntry>>>,
}

impl Default for AppIndex {
    fn default() -> Self {
        Self {
            sys32: Mutex::new(None),
            user: Mutex::new(None),
        }
    }
}

impl AppIndex {
    /// System32 entries, loaded from the preset DB on first access.
    fn sys32_entries(&self) -> Result<Vec<AppEntry>, String> {
        if let Some(cached) = self.sys32.lock().unwrap().as_ref() {
            return Ok(cached.clone());
        }
        let entries = cache::load_sys32_entries()?;
        *self.sys32.lock().unwrap() = Some(entries.clone());
        Ok(entries)
    }

    /// Desktop + user entries, loaded from the user-cache DB on first access.
    fn user_entries(&self) -> Result<Vec<AppEntry>, String> {
        if let Some(cached) = self.user.lock().unwrap().as_ref() {
            return Ok(cached.clone());
        }
        let entries = cache::load_user_entries()?;
        *self.user.lock().unwrap() = Some(entries.clone());
        Ok(entries)
    }

    /// Rebuild the System32 preset DB (once) and reload its entries. Called on
    /// a background thread at startup.
    pub fn refresh_sys32(&self) {
        let _ = cache::ensure_sys32_db();
        if let Ok(entries) = cache::load_sys32_entries() {
            *self.sys32.lock().unwrap() = Some(entries);
        }
    }

    /// Differentially refresh the user cache and reload its entries. Called at
    /// startup and on the hourly timer.
    pub fn refresh_user(&self, settings: &Settings) {
        if let Ok(entries) = cache::refresh_user_db(settings) {
            *self.user.lock().unwrap() = Some(entries);
        } else if self.user.lock().unwrap().is_none() {
            // Refresh failed on the very first load — at least read whatever
            // is on disk so search has something.
            if let Ok(entries) = cache::load_user_entries() {
                *self.user.lock().unwrap() = Some(entries);
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/// Score how well `query` matches `name` as a case-insensitive subsequence.
///
/// Returns `None` when the query is not a subsequence. Higher is better.
/// Rewards: prefix matches, word-boundary matches and consecutive runs;
/// a small penalty scales with unmatched name length so shorter names win
/// ties.
fn fuzzy_score(query: &str, name: &str) -> Option<f64> {
    let query = query.trim();
    if query.is_empty() {
        return None;
    }
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let n: Vec<char> = name.to_lowercase().chars().collect();
    if q.is_empty() || q.len() > n.len() {
        return None;
    }

    let mut score = 0.0;
    let mut search_from = 0;
    let mut prev_match: Option<usize> = None;
    for (qi, &qc) in q.iter().enumerate() {
        let Some(j) = (search_from..n.len()).find(|&j| n[j] == qc) else {
            return None; // not a subsequence
        };
        // Word-boundary bonus: name start, or after a separator.
        if j == 0 || matches!(n[j - 1], ' ' | '-' | '(' | '/' | '_' | '.') {
            score += 4.0;
        }
        if qi == 0 {
            score += 2.0; // prefix bonus
        }
        if j > 0 && prev_match == Some(j - 1) {
            score += 3.0; // consecutive-run bonus
        }
        prev_match = Some(j);
        search_from = j + 1;
    }
    Some(score - (n.len() - q.len()) as f64 * 0.2)
}

/// Best fuzzy score for an entry across its name and its pinyin forms.
/// Pinyin matches are weighted slightly lower so exact name matches rank first.
fn score_app(query: &str, app: &AppEntry) -> Option<f64> {
    [
        fuzzy_score(query, &app.name),
        fuzzy_score(query, &app.pinyin_full).map(|s| s * 0.9),
        fuzzy_score(query, &app.pinyin_initials).map(|s| s * 0.9),
    ]
    .into_iter()
    .flatten()
    .reduce(f64::max)
}

/// Filter files for a query. Empty query browses everything (name-sorted,
/// capped); otherwise the top `MAX_RESULTS` fuzzy matches.
fn filter_files(apps: &[AppEntry], query: &str) -> Vec<AppEntry> {
    let query = query.trim();
    if query.is_empty() {
        let mut all = apps.to_vec();
        all.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        all.truncate(BROWSE_CAP);
        return all;
    }
    let mut scored: Vec<(&AppEntry, f64)> = apps
        .iter()
        .filter_map(|app| score_app(query, app).map(|s| (app, s)))
        .collect();
    scored.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    scored
        .into_iter()
        .take(MAX_RESULTS)
        .map(|(app, _)| app.clone())
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Manually refresh the index immediately (Desktop + user dirs + Start Menu).
/// Runs on a background thread so the settings window never blocks.
#[tauri::command]
pub fn refresh_index(app: tauri::AppHandle) -> Result<(), String> {
    crate::dirwatch::rebuild(&app);
    std::thread::spawn(move || {
        let index = app.state::<AppIndex>();
        let settings = app.state::<SettingsState>().current();
        index.refresh_user(&settings);
    });
    Ok(())
}

/// Search the enabled index directories for files matching `query`.
#[tauri::command]
pub fn search_apps(
    query: String,
    index: State<AppIndex>,
    state: State<SettingsState>,
) -> Result<Vec<AppEntry>, String> {
    let settings = state.current();
    let mut entries: Vec<AppEntry> = Vec::new();
    if settings
        .index
        .system_dirs
        .iter()
        .any(|d| d.path == "System32" && d.enabled)
    {
        entries.extend(index.sys32_entries()?);
    }
    entries.extend(index.user_entries()?);
    Ok(filter_files(&entries, &query))
}

/// Best-effort display name for a path when the caller doesn't supply one:
/// the file name, with a trailing `.lnk` extension removed (matches the index).
fn display_name(path: &str) -> String {
    let file = path.rsplit(['\\', '/']).next().unwrap_or(path);
    let stem = file.strip_suffix(".lnk").unwrap_or(file);
    stem.to_string()
}

/// Open a file or `.lnk` with the Windows shell.
///
/// `std::process::Command` uses `CreateProcess`, which does not resolve
/// `.lnk` targets, so we go through `ShellExecuteW`. When `elevated` is set the
/// verb becomes `runas`, which pops the UAC confirmation and launches the
/// target with an elevated token. A successful open is recorded for the
/// main-menu 「最近使用」 bar (deduped by path, pruned to the configured count).
#[tauri::command]
pub fn launch_app(
    path: String,
    elevated: bool,
    name: Option<String>,
    recent: State<crate::recent::RecentState>,
    settings: State<SettingsState>,
) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = if elevated {
        "runas".encode_utf16().chain(std::iter::once(0)).collect()
    } else {
        Vec::new()
    };
    let verb_ptr = if verb.is_empty() {
        std::ptr::null() // lpOperation → "open"
    } else {
        verb.as_ptr()
    };
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut() as HWND, // hwnd
            verb_ptr,                     // lpOperation
            wide.as_ptr(),                // lpFile
            std::ptr::null(),             // lpParameters
            std::ptr::null(),             // lpDirectory
            SW_SHOWNORMAL,                // nShowCmd
        )
    };
    // ShellExecuteW returns a HINSTANCE; values <= 32 are error codes. When the
    // user dismisses the UAC prompt the result is ERROR_CANCELLED (1223).
    let code = result as isize;
    if code == ERROR_CANCELLED as isize {
        return Err("canceled".into());
    }
    if code <= 32 {
        return Err(format!("ShellExecuteW failed with code {code}"));
    }
    // Record the open — best-effort, never blocks the launch. Name comes from
    // the frontend (`AppEntry.name`) with a path-derived fallback.
    let display = name.unwrap_or_else(|| display_name(&path));
    let max = settings.current().appearance.recent_count.max(1) as usize;
    let conn = recent.lock();
    let _ = crate::recent::record_recent(&conn, &path, &display, max);
    Ok(())
}

/// Reveal a file in Explorer: open its containing folder and select it
/// (`explorer /select,"<path>"`). Works for `.lnk` and plain files alike.
#[tauri::command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let params = format!("/select,\"{path}\"");
    let exe: Vec<u16> = "explorer.exe"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let args: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut() as HWND,
            std::ptr::null(),
            exe.as_ptr(),
            args.as_ptr(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };
    let code = result as isize;
    if code <= 32 {
        return Err(format!("ShellExecuteW failed with code {code}"));
    }
    Ok(())
}

// Keep the Connection import used in cfg(test) builds below.
#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, pinyin_full: &str, pinyin_initials: &str) -> AppEntry {
        AppEntry {
            id: 0,
            name: name.into(),
            path: format!("C:/{name}"),
            pinyin_full: pinyin_full.into(),
            pinyin_initials: pinyin_initials.into(),
        }
    }

    #[test]
    fn prefix_matches_outrank_trailing_ones() {
        let prefix = fuzzy_score("code", "Code").expect("should match");
        let trailing = fuzzy_score("code", "Visual Studio Code").expect("should match");
        assert!(prefix > trailing, "prefix match should win");
    }

    #[test]
    fn word_start_beats_mid_word() {
        let boundary = fuzzy_score("st", "Studio").expect("should match");
        let middle = fuzzy_score("st", "Restart").expect("should match");
        assert!(boundary > middle, "word-start match should win");
    }

    #[test]
    fn non_subsequence_and_empty_return_none() {
        assert!(fuzzy_score("xyz", "Firefox").is_none());
        assert!(fuzzy_score("", "Firefox").is_none());
        assert!(fuzzy_score(" ", "Firefox").is_none());
        assert!(fuzzy_score("longquery", "Short").is_none());
    }

    #[test]
    fn pinyin_search_matches_chinese() {
        let apps = vec![entry("计算器", "jisuanqi", "jsq")];
        assert_eq!(filter_files(&apps, "jisuanqi").len(), 1, "full pinyin");
        assert_eq!(filter_files(&apps, "jsq").len(), 1, "initials");
        assert_eq!(filter_files(&apps, "计算").len(), 1, "direct Chinese");
        assert_eq!(filter_files(&apps, "zzznope").len(), 0);
    }

    #[test]
    fn empty_query_browses_all_capped_and_sorted() {
        let apps = vec![entry("b.txt", "b", "b"), entry("a.txt", "a", "a")];
        let all = filter_files(&apps, "");
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].name, "a.txt", "browse stays name-sorted");
    }
}
