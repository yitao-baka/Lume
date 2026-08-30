//! Unified file-search facade ("file 秒搜"): one command, two backends.
//!
//! Backend selection per query:
//! 1. **Everything** — when the Everything taskbar-notification window exists
//!    (`everything::available`), query it over its WM_COPYDATA IPC. Zero
//!    configuration, millisecond-fast, always freshest (it owns the machine's
//!    live index).
//! 2. **LumeSVC** — otherwise ask the SYSTEM service over
//!    `\\.\pipe\LumeSVC` (`{"t":"search"}`); the service answers from its own
//!    USN index, or reports `building` while the first MFT scan runs.
//!
//! A failed backend (Everything hung, service absent) enters a cooldown so a
//! per-keystroke caller never pays repeated timeouts; the other backend takes
//! over transparently. With neither backend available the command returns
//! `unavailable` and the grid shows native results only.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::cache::AppEntry;
use crate::everything::{self, FileHit};

/// File hits appended to the Navigate grid (total grid cap is the frontend's;
/// native app results keep their slots).
const FILE_RESULTS_MAX: u32 = 12;
const EVERYTHING_TIMEOUT: Duration = Duration::from_millis(600);
const SVC_TIMEOUT: Duration = Duration::from_millis(800);
/// Skip a backend for this long after a failure (timeout/hang), so typing
/// never waits on a wedged Everything or service more than once.
const COOLDOWN: Duration = Duration::from_secs(10);

#[derive(Serialize)]
pub struct FileSearchOut {
    /// `"everything" | "svc" | "none"` — which backend answered.
    pub backend: String,
    /// `"ready" | "building" | "unavailable"`.
    pub status: String,
    pub entries: Vec<AppEntry>,
}

/// Async so the potential backend timeouts (≤1.4s) never block the UI thread
/// — sync Tauri commands run on the main thread.
#[tauri::command]
pub async fn file_search(query: String, max: Option<u32>) -> FileSearchOut {
    if query.trim().is_empty() {
        return FileSearchOut {
            backend: "none".into(),
            status: "unavailable".into(),
            entries: Vec::new(),
        };
    }
    let max = max.unwrap_or(FILE_RESULTS_MAX).clamp(1, 100);
    // Blocking waits are fine here: this runs on the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || run_search(&query, max))
        .await
        .unwrap_or_else(|e| {
            eprintln!("[filesearch] join failed: {e}");
            FileSearchOut {
                backend: "none".into(),
                status: "unavailable".into(),
                entries: Vec::new(),
            }
        })
}

fn run_search(query: &str, max: u32) -> FileSearchOut {
    if query.trim().is_empty() {
        return FileSearchOut {
            backend: "none".into(),
            status: "unavailable".into(),
            entries: Vec::new(),
        };
    }
    let now = Instant::now();
    // Everything first: its index is live and the IPC costs nothing when it
    // isn't running (FindWindow probe).
    if everything::available() && !cooled_down("everything", now) {
        match everything::search(query, max, EVERYTHING_TIMEOUT) {
            Ok(hits) => return to_out("everything", "ready", hits),
            Err(e) => {
                eprintln!("[filesearch] everything failed: {}", e.message());
                if !matches!(e, everything::Error::NotRunning) {
                    mark_cooldown("everything", now);
                }
            }
        }
    }
    if !cooled_down("svc", now) {
        match svc_search(query, max) {
            Ok((status, hits)) => return to_out("svc", &status, hits),
            Err(e) => {
                eprintln!("[filesearch] svc failed: {e}");
                mark_cooldown("svc", now);
            }
        }
    }
    FileSearchOut {
        backend: "none".into(),
        status: "unavailable".into(),
        entries: Vec::new(),
    }
}

/// Process-wide per-backend failure timestamps (the file_search caller fires
/// per keystroke; this is what keeps a wedged backend from stalling typing).
static COOLDOWNS: Mutex<Option<HashMap<&'static str, Instant>>> = Mutex::new(None);

fn cooled_down(backend: &str, now: Instant) -> bool {
    let map = COOLDOWNS.lock().unwrap();
    map.as_ref()
        .map(|m| cooldown_active(m, backend, now))
        .unwrap_or(false)
}

fn mark_cooldown(backend: &'static str, now: Instant) {
    let mut slot = COOLDOWNS.lock().unwrap();
    let map = slot.get_or_insert_with(HashMap::new);
    map.retain(|_, t| now.duration_since(*t) < COOLDOWN);
    map.insert(backend, now);
}

fn svc_search(query: &str, max: u32) -> Result<(String, Vec<FileHit>), String> {
    let request = format!(
        r#"{{"t":"search","q":{},"max":{max}}}"#,
        serde_json::to_string(query).map_err(|e| e.to_string())?
    );
    let reply = crate::svc::pipe_transact(&request, SVC_TIMEOUT)?;
    #[derive(serde::Deserialize)]
    struct SvcReply {
        t: String,
        #[serde(default)]
        status: String,
        #[serde(default)]
        items: Vec<FileHit>,
    }
    let reply: SvcReply = serde_json::from_str(&reply).map_err(|e| format!("svc reply: {e}"))?;
    if reply.t != "results" {
        return Err(format!("unexpected svc reply type {}", reply.t));
    }
    // "off"/"failed" mean no usable index (Everything is running on the
    // machine, or the engine errored) — surface that honestly.
    let status = match reply.status.as_str() {
        "building" => "building",
        "ready" => "ready",
        _ => "unavailable",
    };
    Ok((status.to_string(), reply.items))
}

fn to_out(backend: &str, status: &str, hits: Vec<FileHit>) -> FileSearchOut {
    FileSearchOut {
        backend: backend.into(),
        status: status.into(),
        entries: hits
            .into_iter()
            .map(|h| AppEntry {
                id: 0,
                name: h.name,
                path: h.path,
                pinyin_full: String::new(),
                pinyin_initials: String::new(),
            })
            .collect(),
    }
}

/// Cooldown predicate over the failure map — a backend that failed within
/// `COOLDOWN` is skipped. Pure for the unit test; the live map is
/// `COOLDOWNS` (process-wide).
fn cooldown_active(map: &HashMap<&'static str, Instant>, backend: &str, now: Instant) -> bool {
    map.get(backend)
        .map(|t| now.duration_since(*t) < COOLDOWN)
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_windows_failures() {
        let mut map: HashMap<&'static str, Instant> = HashMap::new();
        let now = Instant::now();
        assert!(!cooldown_active(&map, "everything", now));
        map.insert("everything", now - Duration::from_secs(5));
        assert!(cooldown_active(&map, "everything", now));
        map.insert("everything", now - Duration::from_secs(30));
        assert!(!cooldown_active(&map, "everything", now));
    }

    #[test]
    fn empty_query_short_circuits() {
        let out = run_search("   ", 12);
        assert_eq!(out.backend, "none");
        assert_eq!(out.status, "unavailable");
        assert!(out.entries.is_empty());
    }
}
