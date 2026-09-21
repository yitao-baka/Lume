//! Unified file-search facade ("file 秒搜"): one command, two backends.
//!
//! Backend selection per query:
//! 1. **Everything** — when the Everything taskbar-notification window exists
//!    (`everything::available`), query it over its WM_COPYDATA IPC (QUERY2W
//!    when supported: total count / size / mtime / sort; legacy QUERYW
//!    fallback for 1.3-era builds). Zero configuration, millisecond-fast,
//!    always freshest (it owns the machine's live index).
//! 2. **LumeSVC** — otherwise ask the SYSTEM service over
//!    `\\.\pipe\LumeSVC` (`{"t":"search"}`); the service answers from its own
//!    USN index, or reports `building` while the first MFT scan runs. The
//!    engine has no offset/total: the page beyond `offset` is fetched and
//!    trimmed here, and metadata comes from an on-demand per-page stat.
//!
//! A failed backend (Everything hung, service absent) enters a cooldown so a
//! per-keystroke caller never pays repeated timeouts; the other backend takes
//! over transparently. With neither backend available the command returns
//! `unavailable` and the grid shows native results only.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::everything::{self, FileHit};

/// File hits appended to the Navigate grid (total grid cap is the frontend's;
/// native app results keep their slots).
const FILE_RESULTS_MAX: u32 = 12;
const EVERYTHING_TIMEOUT: Duration = Duration::from_millis(600);
/// Generous on purpose: the service answers queued queries in order, so a
/// typing burst can put a query a few hundred ms behind its predecessors
/// (~20-30 ms each in a release build, ~50-180 ms in debug). Treating that
/// queue as a failure cooled the backend down for 10 s — the "search works,
/// then goes unavailable" symptom. A genuinely wedged service still exits
/// through the timeout; nothing here waits on it interactively (the call is
/// async and the frontend discards superseded results).
const SVC_TIMEOUT: Duration = Duration::from_millis(1500);
/// Skip a backend for this long after a failure (timeout/hang), so typing
/// never waits on a wedged Everything or service more than once.
const COOLDOWN: Duration = Duration::from_secs(10);

/// Sort names accepted by `file_search` (Everything sorts; the svc backend
/// sorts the returned page in memory). Anything else → engine default order.
const SORTS: &[&str] = &[
    "name", "path", "size", "mtime", "name_desc", "path_desc", "size_desc", "mtime_desc",
];

#[derive(Serialize)]
pub struct FileSearchOut {
    /// `"everything" | "svc" | "none"` — which backend answered.
    pub backend: String,
    /// `"ready" | "building" | "unavailable"`.
    pub status: String,
    /// Engine-reported total hit count; omitted when the backend can't know
    /// (the svc engine truncates mid-scan, legacy Everything replies lack it).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    /// The effective sort, echoed back; omitted when unsorted / the requested
    /// sort was ignored (engine default order).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort: Option<String>,
    pub entries: Vec<FileEntry>,
}

/// One file-search hit. `mtime`/`size` are omitted when unknown (the plugin
/// UI adapts by hiding the column).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub id: u32,
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
}

/// Async so the potential backend timeouts (≤1.4s) never block the UI thread
/// — sync Tauri commands run on the main thread. All options are optional and
/// invalid values fall back to defaults (max clamped 1..=100; offset passes
/// through to the engine, which truncates). An empty query is legitimate: it
/// means "recent files" (see `run_search`).
#[tauri::command]
pub async fn file_search(
    query: String,
    max: Option<u32>,
    offset: Option<u32>,
    sort: Option<String>,
) -> FileSearchOut {
    let max = max.unwrap_or(FILE_RESULTS_MAX).clamp(1, 100);
    let offset = offset.unwrap_or(0);
    // 'static: only the known sort names survive (invalid → engine default),
    // borrowed straight from the SORTS table so the closure can own it.
    let sort = sort
        .as_deref()
        .and_then(|s| SORTS.iter().copied().find(|k| *k == s));
    // Blocking waits are fine here: this runs on the async runtime's workers.
    tauri::async_runtime::spawn_blocking(move || run_search(&query, max, offset, sort))
        .await
        .unwrap_or_else(|e| {
            eprintln!("[filesearch] join failed: {e}");
            unavailable()
        })
}

/// The effective sort for a query. An empty query = "recent files": default
/// to `mtime_desc` (and echo it) so the plugin page really shows 最近修改 —
/// without it the engines return their index-default order, which is not what
/// an empty query promises. An explicit sort always wins. Pure for the unit
/// test; `run_search` applies it.
fn effective_sort<'a>(query: &str, sort: Option<&'a str>) -> Option<&'a str> {
    sort.or_else(|| query.trim().is_empty().then_some("mtime_desc"))
}

fn run_search(query: &str, max: u32, offset: u32, sort: Option<&str>) -> FileSearchOut {
    let now = Instant::now();
    let sort = effective_sort(query, sort);
    // Everything first: its index is live and the IPC costs nothing when it
    // isn't running (FindWindow probe).
    if everything::available() && !cooled_down("everything", now) {
        match everything::search(query, max, offset, sort, EVERYTHING_TIMEOUT) {
            Ok(outcome) => {
                return to_out("everything", "ready", outcome.hits, outcome.total, outcome.sort);
            }
            Err(e) => {
                eprintln!("[filesearch] everything failed: {}", e.message());
                if !matches!(e, everything::Error::NotRunning) {
                    mark_cooldown("everything", now);
                }
            }
        }
    }
    if !cooled_down("svc", now) {
        // The svc engine knows neither offset nor total — fetch the page plus
        // the skipped prefix and trim here, so offset pages don't overlap.
        match svc_search(query, max.saturating_add(offset)) {
            Ok((status, hits)) => {
                let mut hits = hits;
                hits.drain(..(offset as usize).min(hits.len()));
                stat_page(&mut hits);
                // No global sort — order the page in memory and echo it
                // honestly (the plugin disables its sort menu for svc anyway).
                let sort = sort.map(|s| {
                    sort_page(&mut hits, s);
                    s.to_string()
                });
                return to_out("svc", &status, hits, None, sort);
            }
            Err(e) => {
                eprintln!("[filesearch] svc failed: {e}");
                mark_cooldown("svc", now);
            }
        }
    }
    unavailable()
}

fn unavailable() -> FileSearchOut {    FileSearchOut {
        backend: "none".into(),
        status: "unavailable".into(),
        total: None,
        sort: None,
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

/// Fill in mtime/size for one result page with a cheap per-hit stat (≤100
/// calls, <5ms) — the USN index only knows names. A vanished file keeps its
/// entry with null metadata.
fn stat_page(hits: &mut [FileHit]) {
    for h in hits.iter_mut() {
        match std::fs::metadata(&h.path) {
            Ok(md) => {
                h.size = Some(md.len());
                h.mtime = md.modified().ok().and_then(systemtime_ms);
            }
            Err(_) => {
                h.size = None;
                h.mtime = None;
            }
        }
    }
}

/// In-memory page sort for the svc backend (`s` is a validated sort name;
/// missing metadata sorts as zero).
fn sort_page(hits: &mut [FileHit], s: &str) {
    let desc = s.ends_with("_desc");
    match s.trim_end_matches("_desc") {
        "name" => hits.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
        "path" => hits.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase())),
        "size" => hits.sort_by_key(|h| h.size.unwrap_or(0)),
        "mtime" => hits.sort_by_key(|h| h.mtime.unwrap_or(0)),
        _ => return,
    }
    if desc {
        hits.reverse();
    }
}

fn systemtime_ms(t: SystemTime) -> Option<u64> {
    t.duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as u64)
}

fn to_out(
    backend: &str,
    status: &str,
    hits: Vec<FileHit>,
    total: Option<u64>,
    sort: Option<String>,
) -> FileSearchOut {
    FileSearchOut {
        backend: backend.into(),
        status: status.into(),
        total,
        sort,
        entries: hits
            .into_iter()
            .map(|h| FileEntry {
                id: 0,
                name: h.name,
                path: h.path,
                is_folder: h.is_folder,
                mtime: h.mtime,
                size: h.size,
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
    fn empty_query_defaults_to_mtime_desc() {
        // Empty query = "recent files": the effective sort defaults to
        // mtime_desc and is echoed through to the backend; an explicit sort
        // always wins, and non-empty queries keep the engine default order.
        assert_eq!(effective_sort("", None), Some("mtime_desc"));
        assert_eq!(effective_sort("   ", None), Some("mtime_desc"));
        assert_eq!(effective_sort("abc", None), None);
        assert_eq!(effective_sort("", Some("size")), Some("size"));
    }

    #[test]
    fn invalid_sort_falls_back_to_default() {
        // The command normalizes: only the known sort names survive.
        let sort: Option<&str> = Some("bogus").filter(|s| SORTS.contains(s));
        assert!(sort.is_none());
        let sort: Option<&str> = Some("size_desc").filter(|s| SORTS.contains(s));
        assert_eq!(sort, Some("size_desc"));
    }

    #[test]
    fn sort_page_orders_and_reverses() {
        let hit = |name: &str, size: Option<u64>| FileHit {
            name: name.into(),
            path: format!("C:\\{name}"),
            is_folder: false,
            mtime: None,
            size,
        };
        let mut hits = vec![hit("b.txt", Some(30)), hit("A.txt", Some(10)), hit("c.txt", None)];
        sort_page(&mut hits, "name");
        assert_eq!(hits.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(), [
            "A.txt", "b.txt", "c.txt"
        ]);
        sort_page(&mut hits, "size");
        assert_eq!(hits.iter().map(|h| h.size).collect::<Vec<_>>(), [
            None, // missing metadata sorts as zero
            Some(10),
            Some(30)
        ]);
        sort_page(&mut hits, "size_desc");
        assert_eq!(hits.iter().map(|h| h.size).collect::<Vec<_>>(), [
            Some(30),
            Some(10),
            None
        ]);
    }

    #[test]
    fn stat_page_nulls_missing_files() {
        let mut hits = vec![FileHit {
            name: "definitely-missing-9f3a.bin".into(),
            path: "C:\\definitely\\missing\\9f3a.bin".into(),
            is_folder: false,
            mtime: None,
            size: None,
        }];
        stat_page(&mut hits);
        assert!(hits[0].size.is_none());
        assert!(hits[0].mtime.is_none());
    }
}
