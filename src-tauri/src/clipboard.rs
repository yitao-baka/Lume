//! Clipboard history: capture, persist, search.
//!
//! A background thread polls the Windows clipboard sequence number
//! (`GetClipboardSequenceNumber`) and, on change, captures text, file lists
//! or images and records them in a SQLite database. The launcher's clipboard
//! mode searches that history; `copy_clipboard` writes a selection back to
//! the system clipboard.
//!
//! The listener is a 250 ms sequence-number poll rather than a
//! clipboard-format-listener window: it needs no hidden HWND/WndProc and its
//! idle cost is negligible (one system call every quarter second).
//!
//! Storage (docs/ROADMAP_HISTORY.md #12): the DB stores only *references*, never the copied
//! data's original form. Text rows keep the text inline; image rows keep a
//! PNG file in `data/PictureCache/<id>.png` and store the relative path;
//! file rows (copied from Explorer, CF_HDROP) keep the newline-joined path
//! list verbatim. Schema is migrated in place from v0.2 (see [`migrate`]);
//! legacy image BLOBs are extracted to files by [`migrate_blobs_to_files`].
//! Text rows are deduplicated by content (partial unique index). Pinned items
//! sort to the top and are exempt from pruning.

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Cursor;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use windows::core::BOOL;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND, POINT};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
    GetClipboardFormatNameW, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Shell::{DragQueryFileW, DROPFILES, HDROP};
use windows::Win32::UI::WindowsAndMessaging::IsWindow;

/// Clipboard drop format (files/folders copied from Explorer).
const CF_HDROP: u32 = 15;

/// RAII guard for an open clipboard: closes it on drop. Every early return
/// (and a panic) between `OpenClipboard` and the end of the scope still
/// releases the system clipboard — a leaked open clipboard makes every other
/// process's copy/paste fail until Lume exits.
struct OpenClipboardGuard;

impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseClipboard();
        }
    }
}

/// How often the listener checks the clipboard sequence number.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Display label stored for image rows.
const IMAGE_LABEL: &str = "Image";
/// Subfolder under the data dir holding image PNGs.
const PICTURE_CACHE: &str = "PictureCache";
/// Longest edge of the thumbnail sent to the frontend (pixels).
const THUMB_MAX: u32 = 200;
/// Upper bound on stored HTML per row (keeps the DB lean).
const HTML_CAP: usize = 64 * 1024;
/// Compressed clipboard-image formats are copied out only within this bound.
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 64 * 1024 * 1024;
/// Decoded image bounds shared by clipboard capture, plugin payloads and
/// file thumbnails. 16 MP is ~64 MiB as RGBA.
const MAX_IMAGE_EDGE: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 16_000_000;
const MAX_IMAGE_ALLOC_BYTES: u64 = 128 * 1024 * 1024;

/// Auto-merge rules read from the live settings at capture time.
struct MergeConfig {
    pub enabled: bool,
    pub window_ms: u64,
    /// Time of the last paste (a paste closes the current merge window).
    pub last_paste_at: Option<i64>,
}

/// A clipboard history entry, as serialized to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ClipboardItem {
    pub id: u32,
    /// `"text"` | `"image"` | `"file"`.
    pub kind: String,
    /// Text content, the image label, or the newline-joined file path list.
    pub content: String,
    pub pinned: bool,
    pub created_at: i64,
    /// Base64 PNG data URI for image items.
    pub thumb: Option<String>,
    /// Display name of the app that owned the foreground window at capture
    /// time (empty when unknown / unavailable).
    pub source_app: String,
    /// Whether the row carries rich-text HTML (never the HTML itself — the
    /// frontend only needs the flag to offer 「复制为纯文本」).
    pub has_html: bool,
    /// Number of copy pieces merged into this row (1 = a normal single copy;
    /// ≥2 = a merged 「合并复制 N 条」 entry).
    pub merged_count: i64,
    /// False when the entry's content is gone (image PNG missing, or every
    /// file of a file row missing) — drives the strikethrough+gray row state
    /// and blocks copy/paste (docs/ROADMAP_HISTORY.md #17).
    pub valid: bool,
    /// Indices (into the newline-joined `content`) of the files the user has
    /// checked in the multi-file preview; `None` = no override (default: every
    /// existing file is checked). Persisted via the `checked` column.
    pub checked: Option<Vec<u32>>,
}

/// Counts for every clipboard category, computed from the same filtered row
/// set as the returned items. Each count independently applies the history cap
/// to unpinned rows; pinned rows never consume that cap.
#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
pub struct ClipboardCategoryCounts {
    pub all: u32,
    pub text: u32,
    pub textfile: u32,
    pub image: u32,
    pub music: u32,
    pub video: u32,
    pub favorites: u32,
}

/// One clipboard query result: the selected category's rows, the active
/// category total, and stable per-category counts for the same query.
#[derive(Debug, Serialize)]
pub struct ClipboardSearchResult {
    pub items: Vec<ClipboardItem>,
    pub total: u32,
    pub categories: ClipboardCategoryCounts,
}

/// A row as stored in SQLite.
#[derive(Clone)]
struct Row {
    id: u32,
    kind: String,
    content: String,
    /// Legacy image bytes — always NULL after the #12 migration; kept so the
    /// migration can clear it and tests can assert it's empty.
    #[allow(dead_code)]
    data: Option<Vec<u8>>,
    path: Option<String>,
    pinned: bool,
    created_at: i64,
    source_app: String,
    /// Rich-text HTML captured with a text copy (text rows only).
    html: Option<String>,
    /// Number of merged copy pieces (1 = single copy).
    merged_count: i64,
    /// Raw JSON array of checked-file indices (file rows); `None` = no override.
    checked: Option<String>,
}

/// Shared clipboard state, managed by Tauri.
pub struct ClipboardState {
    pub db: Mutex<Connection>,
    /// Last seen clipboard sequence number.
    pub last_seq: AtomicU32,
    /// Sequence produced by Lume's own most recent write. The listener skips
    /// exactly this sequence, never a content value.
    pub self_write_seq: AtomicU32,
    /// True while a clipboard write is between SetClipboardData and the
    /// follow-up sequence read; the listener must not race that gap.
    pub self_write_pending: AtomicBool,
    /// Pause recording (runtime-only — not persisted; the status-bar toggle).
    pub paused: AtomicBool,
    /// Wall-clock time of the last paste — a paste closes the current merge.
    pub last_paste_at: Mutex<Option<i64>>,
}

/// Sequence returned by Windows after the last clipboard mutation.
fn clipboard_sequence() -> u32 {
    unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() }
}

/// Wrap one Lume-initiated clipboard write. `pending` closes the race where
/// the listener polls after SetClipboardData but before the new sequence is
/// recorded; the exact sequence then suppresses the settled write.
fn write_clipboard_payload(
    state: &ClipboardState,
    set: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    state.self_write_pending.store(true, Ordering::SeqCst);
    match set() {
        Ok(()) => {
            state
                .self_write_seq
                .store(clipboard_sequence(), Ordering::SeqCst);
            state.self_write_pending.store(false, Ordering::SeqCst);
            Ok(())
        }
        Err(error) => {
            state.self_write_pending.store(false, Ordering::SeqCst);
            Err(error)
        }
    }
}

/// Whether a changed clipboard sequence belongs to Lume's own write.
fn should_skip_sequence(
    sequence: u32,
    self_sequence: u32,
    self_pending: bool,
) -> bool {
    self_pending || (sequence != 0 && sequence == self_sequence)
}

/// Keep copied text byte-for-byte; trim only decides whether it is empty.
fn retained_clipboard_text(text: String) -> Option<String> {
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

/// Truncate a UTF-8 string without ever splitting a code point.
fn truncate_utf8_boundary(text: &mut String, max_bytes: usize) {
    if text.len() <= max_bytes {
        return;
    }
    let mut cut = max_bytes.min(text.len());
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    text.truncate(cut);
}

// ---------------------------------------------------------------------------
// Database helpers (pure, take `&Connection` so tests use an in-memory DB)
// ---------------------------------------------------------------------------

/// Create the current schema (no-op on an up-to-date DB), migrate older
/// tables in place, then ensure the text-dedup partial index exists.
fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS clipboard (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            kind         TEXT NOT NULL DEFAULT 'text',
            content      TEXT NOT NULL,
            data         BLOB,
            path         TEXT,
            pinned       INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            source_app   TEXT,
            html         TEXT,
            merged_count INTEGER NOT NULL DEFAULT 0,
            checked      TEXT
        );",
    )?;
    migrate(conn)?;
    // The unique index is applied from the persisted dedup setting by
    // set_dedup_index(); creating it here would fail on histories accumulated
    // while dedup was disabled, before the setting is available.
    Ok(())
}

/// Drop or recreate the text-dedup partial unique index. 内容去重 on → the index
/// enforces "one row per identical text" at the DB level; off → it must be
/// dropped, or a re-copy of an existing text would hit a constraint violation
/// when 去重 off tries to insert a fresh row.
fn set_dedup_index(conn: &Connection, enabled: bool) -> rusqlite::Result<()> {
    if enabled {
        let tx = conn.unchecked_transaction()?;
        // Histories created with dedup off may contain duplicate text rows.
        // Preserve the newest row per content and carry over any pin before
        // recreating the partial unique index.
        tx.execute_batch(
            "UPDATE clipboard
                 SET pinned = 1
               WHERE kind = 'text'
                 AND EXISTS (
                     SELECT 1 FROM clipboard p
                      WHERE p.kind = 'text'
                        AND p.content = clipboard.content
                        AND p.pinned = 1
                 );
             DELETE FROM clipboard
              WHERE kind = 'text'
                AND id NOT IN (
                    SELECT keep.id
                      FROM clipboard keep
                     WHERE keep.kind = 'text'
                       AND NOT EXISTS (
                           SELECT 1 FROM clipboard newer
                            WHERE newer.kind = 'text'
                              AND newer.content = keep.content
                              AND (newer.created_at > keep.created_at
                                   OR (newer.created_at = keep.created_at AND newer.id > keep.id))
                       )
                );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_clipboard_text_unique
                 ON clipboard(content) WHERE kind = 'text';",
        )?;
        tx.commit()
    } else {
        conn.execute_batch("DROP INDEX IF EXISTS idx_clipboard_text_unique;")
    }
}

/// Apply the 内容去重 setting to the shared DB connection (startup + setting
/// toggle). Safe to call when the clipboard state is not yet managed.
pub fn set_dedup_enabled(app: &tauri::AppHandle, enabled: bool) {
    if let Some(state) = app.try_state::<ClipboardState>() {
        if let Ok(conn) = state.db.lock() {
            if let Err(e) = set_dedup_index(&conn, enabled) {
                eprintln!("[clipboard] failed to sync dedup index: {e}");
            }
        }
    }
}

/// Column names of the `clipboard` table.
fn table_cols(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA table_info(clipboard)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

/// Upgrade an old table to the current schema by renaming, recreating and
/// copying rows. Text rows keep their identity, so no history is lost. A v0.2
/// table (no `kind`/`data`/`pinned`) is rebuilt once; any table lacking a
/// newer column (`path` #12, `source_app` #13, `html`/`merged_count` #13
/// phase 2) gets it via `ALTER TABLE`.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let cols = table_cols(conn)?;
    if !cols.iter().any(|c| c == "kind") {
        conn.execute_batch(
            "BEGIN;
            ALTER TABLE clipboard RENAME TO clipboard_old;
            CREATE TABLE clipboard (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                kind         TEXT NOT NULL DEFAULT 'text',
                content      TEXT NOT NULL,
                data         BLOB,
                path         TEXT,
                pinned       INTEGER NOT NULL DEFAULT 0,
                created_at   INTEGER NOT NULL,
                source_app   TEXT,
                html         TEXT,
                merged_count INTEGER NOT NULL DEFAULT 0,
                checked      TEXT
            );
            INSERT INTO clipboard(kind, content, data, path, pinned, created_at)
                SELECT 'text', content, NULL, NULL, 0, created_at FROM clipboard_old;
            DROP TABLE clipboard_old;
            COMMIT;",
        )?;
    }
    for (col, sql) in [
        ("path", "ALTER TABLE clipboard ADD COLUMN path TEXT"),
        ("source_app", "ALTER TABLE clipboard ADD COLUMN source_app TEXT"),
        ("html", "ALTER TABLE clipboard ADD COLUMN html TEXT"),
        (
            "merged_count",
            "ALTER TABLE clipboard ADD COLUMN merged_count INTEGER NOT NULL DEFAULT 0",
        ),
        ("checked", "ALTER TABLE clipboard ADD COLUMN checked TEXT"),
    ] {
        let cols = table_cols(conn)?;
        if !cols.iter().any(|c| c == col) {
            conn.execute(sql, [])?;
        }
    }
    // Legacy rows are single copies — normalize the column default (0) to 1.
    conn.execute("UPDATE clipboard SET merged_count = 1 WHERE merged_count = 0", [])?;
    // Older builds kept the first piece HTML on merged rows. That snapshot no
    // longer represents `content`, so apply the plain-text downgrade once.
    conn.execute(
        "UPDATE clipboard SET html = NULL
         WHERE kind = 'text' AND merged_count > 1 AND html IS NOT NULL",
        [],
    )?;
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// A strictly-increasing recency stamp for the next insert, so ordering never
/// ties on wall-clock time.
fn next_created_at(conn: &Connection) -> rusqlite::Result<i64> {
    let max: i64 = conn.query_row(
        "SELECT COALESCE(MAX(created_at), 0) FROM clipboard",
        [],
        |row| row.get(0),
    )?;
    Ok(now_millis().max(max + 1))
}

/// Upsert a text row. Precedence:
/// 1. Whole-content dedup (identical copy, 内容去重 on) → bump recency, refresh
///    html/source.
/// 2. Auto-merge (合并复制 on + within window + no paste since) → append to the
///    most recent text row (newline-joined, `merged_count` + 1).
/// 3. Otherwise insert a fresh row (`merged_count = 1`).
///    Prunes afterwards.
#[allow(clippy::too_many_arguments)]
fn insert_text_history(
    conn: &Connection,
    text: &str,
    source_app: &str,
    html: Option<String>,
    cap: i64,
    base: &Path,
    merge: &MergeConfig,
    dedup: bool,
) -> rusqlite::Result<()> {
    let created_at = next_created_at(conn)?;
    // 1. Whole-content dedup (only when 内容去重 on). Off = an identical copy
    // falls through to a fresh insert (the unique index is dropped by then).
    if dedup {
        conn.execute(
            "UPDATE clipboard SET created_at = ?1, source_app = ?2, html = ?3
             WHERE kind = 'text' AND content = ?4",
            params![created_at, source_app, html, text],
        )?;
        if conn.changes() > 0 {
            return prune(conn, cap, base);
        }
    }
    // 2. Auto-merge: the most recent text row is a merge candidate when it is
    // within the window and no paste happened after it. A re-copy of that
    // row's last piece bumps recency instead of appending or duplicating.
    if merge.enabled {
        let last: Option<(i64, i64, String)> = conn
            .query_row(
                "SELECT id, created_at, content FROM clipboard
                 WHERE kind = 'text' ORDER BY created_at DESC, id DESC LIMIT 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .ok();
        if let Some((last_id, last_at, last_content)) = last {
            let within = now_millis().saturating_sub(last_at) as u64 <= merge.window_ms;
            let no_paste = !merge.last_paste_at.is_some_and(|p| p >= last_at);
            if within && no_paste {
                if last_content.lines().last() == Some(text) {
                    // Re-copy of the last piece → bump recency, no append.
                    conn.execute(
                        "UPDATE clipboard SET created_at = ?1 WHERE id = ?2",
                        params![created_at, last_id],
                    )?;
                    return prune(conn, cap, base);
                }
                conn.execute(
                    "UPDATE clipboard SET content = content || char(10) || ?1,
                                          merged_count = merged_count + 1,
                                          created_at = ?2,
                                          html = NULL
                     WHERE id = ?3",
                    params![text, created_at, last_id],
                )?;
                return prune(conn, cap, base);
            }
        }
    }
    // 3. Fresh insert.
    conn.execute(
        "INSERT INTO clipboard(kind, content, data, path, pinned, created_at, source_app, html, merged_count)
         VALUES ('text', ?1, NULL, NULL, 0, ?2, ?3, ?4, 1)",
        params![text, created_at, source_app, html],
    )?;
    prune(conn, cap, base)
}

/// Insert an image row: write the PNG into `<base>/PictureCache/<id>.png` and
/// store the relative path. The DB never holds the image bytes themselves.
fn insert_image_history(
    conn: &Connection,
    png: &[u8],
    source_app: &str,
    cap: i64,
    base: &Path,
) -> rusqlite::Result<()> {
    let created_at = next_created_at(conn)?;
    conn.execute(
        "INSERT INTO clipboard(kind, content, data, path, pinned, created_at, source_app, html, merged_count)
         VALUES ('image', ?1, NULL, NULL, 0, ?2, ?3, NULL, 0)",
        params![IMAGE_LABEL, created_at, source_app],
    )?;
    let id = conn.last_insert_rowid();
    let dir = base.join(PICTURE_CACHE);
    fs::create_dir_all(&dir).map_err(io_err)?;
    let rel = format!("{PICTURE_CACHE}/{id}.png");
    if let Err(e) = fs::write(dir.join(format!("{id}.png")), png) {
        // Roll the dangling row back so history stays consistent.
        let _ = conn.execute("DELETE FROM clipboard WHERE id = ?1", params![id]);
        return Err(io_err(e));
    }
    conn.execute(
        "UPDATE clipboard SET path = ?1 WHERE id = ?2",
        params![rel, id],
    )?;
    prune(conn, cap, base)
}

/// Record a file/folder copy (a CF_HDROP path list) as one history row. The
/// whole list is stored verbatim, newline-joined (Windows names can't contain
/// `\n`); the files themselves are never read or copied.
fn insert_file_history(
    conn: &Connection,
    paths: &[String],
    source_app: &str,
    cap: i64,
    base: &Path,
    dedup: bool,
) -> rusqlite::Result<()> {
    let content = paths.join("\n");
    let created_at = next_created_at(conn)?;
    // 内容去重: an identical list bumps recency instead of duplicating. Off →
    // every copy inserts a fresh row (even the same list).
    let dup = if dedup {
        conn.execute(
            "UPDATE clipboard SET created_at = ?1 WHERE kind = 'file' AND content = ?2",
            params![created_at, content],
        )?;
        conn.changes() > 0
    } else {
        false
    };
    if !dup {
        conn.execute(
            "INSERT INTO clipboard(kind, content, data, path, pinned, created_at, source_app, html, merged_count)
             VALUES ('file', ?1, NULL, NULL, 0, ?2, ?3, NULL, 0)",
            params![content, created_at, source_app],
        )?;
    }
    prune(conn, cap, base)
}

/// Delete rows beyond `cap`, keeping the newest unpinned entries plus every
/// pinned one, then sweep picture-cache files orphaned by the prune.
fn prune(conn: &Connection, cap: i64, base: &Path) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM clipboard
         WHERE pinned = 0
           AND id NOT IN (
               SELECT id FROM clipboard WHERE pinned = 0
               ORDER BY created_at DESC, id DESC LIMIT ?1
           )",
        params![cap],
    )?;
    gc_picture_cache(conn, base);
    Ok(())
}

/// Delete picture-cache files no longer referenced by any image row
/// (prune / delete / clear would otherwise leave orphans behind).
fn gc_picture_cache(conn: &Connection, base: &Path) {
    let dir = base.join(PICTURE_CACHE);
    let Ok(entries) = fs::read_dir(&dir) else {
        return; // no cache dir yet — nothing to clean
    };
    let referenced: HashSet<String> = {
        let Ok(mut stmt) = conn.prepare(
            "SELECT path FROM clipboard WHERE kind = 'image' AND path IS NOT NULL",
        ) else {
            return;
        };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .and_then(|rows| rows.collect())
            .unwrap_or_default()
    };
    for entry in entries.flatten() {
        let file = entry.path();
        let Some(name) = file.file_name().and_then(|n| n.to_str()).map(str::to_owned) else {
            continue;
        };
        let rel = format!("{PICTURE_CACHE}/{name}");
        if !referenced.contains(&rel) {
            let _ = fs::remove_file(&file);
        }
    }
}

/// Extract legacy image BLOBs (pre-#12 rows) into the picture cache and point
/// the row at the file, then clear the bytes. Runs once at startup after the
/// schema migration so the DB ends up byte-free.
fn migrate_blobs_to_files(conn: &Connection, base: &Path) -> rusqlite::Result<()> {
    let dir = base.join(PICTURE_CACHE);
    fs::create_dir_all(&dir).map_err(io_err)?;
    let rows: Vec<(u32, Vec<u8>)> = {
        let mut stmt = conn.prepare(
            "SELECT id, data FROM clipboard WHERE kind = 'image' AND data IS NOT NULL",
        )?;
        let iter = stmt.query_map([], |r| Ok((r.get(0)?, r.get::<_, Option<Vec<u8>>>(1)?)))?;
        iter.collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|(id, bytes)| bytes.map(|b| (id, b)))
            .collect()
    };
    for (id, png) in rows {
        let rel = format!("{PICTURE_CACHE}/{id}.png");
        fs::write(dir.join(format!("{id}.png")), &png).map_err(io_err)?;
        conn.execute(
            "UPDATE clipboard SET path = ?1, data = NULL WHERE id = ?2",
            params![rel, id],
        )?;
    }
    Ok(())
}

/// Content category of a stored row. File rows use their first path so the
/// text-file / image / music / video categories share the same predicate as
/// the preview classification. This is the single source of truth for both
/// filtering and category counts.
fn content_category(row: &Row) -> &'static str {
    match row.kind.as_str() {
        "text" => "text",
        "image" => "image",
        "file" => first_path(row).map(file_content_kind).unwrap_or("other"),
        _ => "other",
    }
}

fn category_matches(category: &str, content_category: &str) -> bool {
    match category {
        "text" => content_category == "text",
        "textfile" => content_category == "text",
        "music" => content_category == "audio",
        "video" => content_category == "video",
        "image" => content_category == "image",
        _ => true,
    }
}

/// Rows matching a search query and category, newest first. Category filtering
/// happens before the cap: file content types are resolved from the path in
/// Rust, and only then does the caller clamp the number of unpinned rows.
fn matching_rows(conn: &Connection, query: &str, category: &str) -> rusqlite::Result<Vec<Row>> {
    let mut sql = String::from(
        "SELECT id, kind, content, data, path, pinned, created_at, source_app, html, merged_count, checked FROM clipboard
         WHERE (instr(lower(content), lower(?1)) > 0
            OR instr(lower(source_app), lower(?1)) > 0)",
    );
    if category == "favorites" {
        sql.push_str(" AND pinned = 1");
    } else if category == "text" {
        sql.push_str(" AND kind = 'text'");
    } else if matches!(category, "textfile" | "music" | "video" | "image") {
        sql.push_str(" AND kind IN ('image', 'file')");
    }
    sql.push_str(" ORDER BY created_at DESC, id DESC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt
        .query_map(params![query], |row| {
            Ok(Row {
                id: row.get(0)?,
                kind: row.get(1)?,
                content: row.get(2)?,
                data: row.get(3)?,
                path: row.get(4)?,
                pinned: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                source_app: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
                html: row.get(8)?,
                merged_count: row.get::<_, i64>(9)?,
                checked: row.get(10)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter(|row| {
            category == "all"
                || (category == "favorites" && row.pinned)
                || (category != "favorites" && category_matches(category, content_category(row)))
        })
        .collect())
}

/// Apply the history cap to unpinned rows only. Pinned rows are exempt from
/// pruning and must therefore remain visible outside the cap.
fn capped_rows(rows: impl IntoIterator<Item = Row>, limit: u32) -> Vec<Row> {
    let limit = limit.max(1) as usize;
    let mut out = Vec::new();
    let mut unpinned = 0usize;
    for row in rows {
        if row.pinned {
            out.push(row);
        } else if unpinned < limit {
            out.push(row);
            unpinned += 1;
        }
    }
    out
}

fn category_counts(rows: &[Row], limit: u32) -> ClipboardCategoryCounts {
    let capped = |predicate: &dyn Fn(&Row) -> bool| -> u32 {
        capped_rows(rows.iter().filter(|row| predicate(row)).cloned(), limit).len() as u32
    };
    ClipboardCategoryCounts {
        all: capped(&|_| true),
        text: capped(&|row| row.kind == "text"),
        textfile: capped(&|row| row.kind == "file" && content_category(row) == "text"),
        image: capped(&|row| content_category(row) == "image"),
        music: capped(&|row| content_category(row) == "audio"),
        video: capped(&|row| content_category(row) == "video"),
        favorites: rows.iter().filter(|row| row.pinned).count() as u32,
    }
}

/// Shared search implementation. All categories are evaluated over the same
/// query-filtered rows, then each category independently applies the unpinned
/// history cap. `favorites_top` only changes display order.
fn search_history_result(
    conn: &Connection,
    query: &str,
    kind: &str,
    limit: u32,
    base: &Path,
    favorites_top: bool,
) -> rusqlite::Result<ClipboardSearchResult> {
    let rows = matching_rows(conn, query, kind)?;
    let categories = category_counts(&matching_rows(conn, query, "all")?, limit);
    let mut selected = capped_rows(rows, limit);
    if favorites_top {
        selected.sort_by(|a, b| {
            b.pinned
                .cmp(&a.pinned)
                .then_with(|| b.created_at.cmp(&a.created_at))
                .then_with(|| b.id.cmp(&a.id))
        });
    }
    let total = selected.len() as u32;
    Ok(ClipboardSearchResult {
        items: selected.into_iter().map(|r| row_to_item(r, base)).collect(),
        total,
        categories,
    })
}

/// Backwards-compatible item-only helper used by unit tests and internal
/// callers. The Tauri command returns the richer result with category counts.
#[cfg(test)]
fn search_history(
    conn: &Connection,
    query: &str,
    kind: &str,
    limit: i64,
    base: &Path,
    favorites_top: bool,
) -> rusqlite::Result<Vec<ClipboardItem>> {
    Ok(search_history_result(conn, query, kind, limit.max(1) as u32, base, favorites_top)?.items)
}

/// First path of a file row (the whole content is a newline-joined list).
fn first_path(r: &Row) -> Option<&str> {
    (r.kind == "file").then(|| r.content.lines().next()).flatten()
}

/// Read the image file and downscale it to a base64 data URI for the frontend.
/// Missing files fall back to `None` (the frontend shows the unknown icon).
fn thumb_for_file(base: &Path, rel: &str) -> Option<String> {
    let bytes = fs::read(base.join(rel)).ok()?;
    make_thumb(&bytes)
}

fn row_to_item(row: Row, base: &Path) -> ClipboardItem {
    let thumb = if row.kind == "image" {
        row.path.as_deref().and_then(|p| thumb_for_file(base, p))
    } else {
        None
    };
    // A row is valid when its content is still usable: text always is; an image
    // needs its PNG; a file row needs at least one surviving path.
    let valid = match row.kind.as_str() {
        "text" => true,
        "image" => row.path.as_deref().is_some_and(|p| base.join(p).exists()),
        "file" => row
            .content
            .lines()
            .filter(|l| !l.trim().is_empty())
            .any(|p| Path::new(p).exists()),
        _ => true,
    };
    ClipboardItem {
        id: row.id,
        kind: row.kind,
        content: row.content,
        pinned: row.pinned,
        created_at: row.created_at,
        thumb,
        source_app: row.source_app,
        has_html: row.html.is_some(),
        merged_count: row.merged_count,
        valid,
        checked: row.checked.as_deref().and_then(parse_checked_json),
    }
}

/// Parse a stored `checked` JSON array of indices (the DB column). Unparseable
/// or legacy values are treated as "no override".
fn parse_checked_json(s: &str) -> Option<Vec<u32>> {
    serde_json::from_str(s).ok()
}

/// Whether a row's content is gone and copy/paste must be blocked: a text row
/// never is; an image row is when its stored PNG is missing; a file row is when
/// EVERY recorded path is missing (partial loss keeps the row usable).
fn row_invalid(row: &Row, base: &Path) -> bool {
    match row.kind.as_str() {
        "text" => false,
        "image" => row.path.as_deref().is_none_or(|p| !base.join(p).exists()),
        "file" => {
            let mut any = false;
            for p in row.content.lines().filter(|l| !l.trim().is_empty()) {
                if Path::new(p).exists() {
                    any = true;
                    break;
                }
            }
            !any
        }
        _ => false,
    }
}

/// The file paths a row actually copies/pastes. Multi-file rows use the stored
/// checked subset ∩ existing files (when 记住勾选 is on and an override exists),
/// otherwise every existing file; single-file rows use their one path. Only
/// existing files are ever included (missing ones are excluded by the checked /
/// default semantics). Text/image rows return empty.
fn effective_file_paths(row: &Row, remember_checks: bool) -> Vec<String> {
    if row.kind != "file" {
        return Vec::new();
    }
    let all: Vec<String> = row.content.lines().map(str::to_owned).collect();
    if all.is_empty() {
        return Vec::new();
    }
    let chosen: Vec<String> = if all.len() >= 2 && remember_checks {
        match row.checked.as_deref().and_then(parse_checked_json) {
            Some(indices) => indices
                .iter()
                .filter_map(|&i| all.get(i as usize).cloned())
                .collect(),
            None => all.clone(),
        }
    } else {
        all.clone()
    };
    chosen
        .into_iter()
        .filter(|p| Path::new(p).exists())
        .collect()
}

/// The paths to actually place on the clipboard for a row, rejecting rows whose
/// content is gone and multi-file rows where nothing is checked (both sentinel
/// errors the frontend maps to a toast).
fn usable_paths(row: &Row, remember_checks: bool, base: &Path) -> Result<Vec<String>, String> {
    if row_invalid(row, base) {
        return Err("CLIP_INVALID".into());
    }
    let paths = effective_file_paths(row, remember_checks);
    if row.kind == "file" && paths.is_empty() {
        return Err("CLIP_NO_FILES".into());
    }
    Ok(paths)
}

fn get_row(conn: &Connection, id: u32) -> rusqlite::Result<Option<Row>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, content, data, path, pinned, created_at, source_app, html, merged_count, checked FROM clipboard WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Row {
            id: row.get(0)?,
            kind: row.get(1)?,
            content: row.get(2)?,
            data: row.get(3)?,
            path: row.get(4)?,
            pinned: row.get::<_, i64>(5)? != 0,
            created_at: row.get(6)?,
            source_app: row.get::<_, Option<String>>(7)?.unwrap_or_default(),
            html: row.get(8)?,
            merged_count: row.get::<_, i64>(9)?,
            checked: row.get(10)?,
        })
    })?;
    rows.next().transpose()
}

/// Delete a row. Image picture-cache files are *kept* so an undo can restore
/// them; the next prune's [`gc_picture_cache`] sweep removes files orphaned by
/// the delete once the undo window has passed.
fn delete_row(conn: &Connection, id: u32, _base: &Path) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM clipboard WHERE id = ?1", params![id])?;
    Ok(())
}

/// A deleted history entry, returned to the frontend so it can be restored
/// from the undo buffer.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeletedClip {
    pub kind: String,
    pub content: String,
    /// Relative picture-cache path for image rows.
    pub path: Option<String>,
    pub pinned: bool,
    pub created_at: i64,
    pub source_app: String,
    /// Rich-text HTML captured with a text row.
    pub html: Option<String>,
    /// Number of merged copy pieces (1 = single copy).
    pub merged_count: i64,
    /// Raw JSON of checked-file indices (preserved so undo restores the
    /// multi-file checkbox state too).
    pub checked: Option<String>,
}

impl From<&Row> for DeletedClip {
    fn from(row: &Row) -> Self {
        Self {
            kind: row.kind.clone(),
            content: row.content.clone(),
            path: row.path.clone(),
            pinned: row.pinned,
            created_at: row.created_at,
            source_app: row.source_app.clone(),
            html: row.html.clone(),
            merged_count: row.merged_count,
            checked: row.checked.clone(),
        }
    }
}

/// Re-insert a previously-deleted entry. Text/file rows are deduped by
/// (kind, content) when 内容去重 is on: restoring one after the same text was
/// re-copied bumps its recency instead of duplicating. Image rows (never
/// deduped) are re-inserted pointing back at their still-present PNG.
fn restore_row(
    conn: &Connection,
    d: &DeletedClip,
    base: &Path,
    dedup: bool,
) -> rusqlite::Result<()> {
    if dedup && (d.kind == "text" || d.kind == "file") {
        let updated = conn.execute(
            "UPDATE clipboard SET created_at = ?1, pinned = ?2, source_app = ?3
             WHERE kind = ?4 AND content = ?5",
            params![d.created_at, d.pinned as i64, d.source_app, d.kind, d.content],
        )?;
        if updated > 0 {
            return Ok(());
        }
    }
    conn.execute(
        "INSERT INTO clipboard(kind, content, data, path, pinned, created_at, source_app, html, merged_count, checked)
         VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            d.kind,
            d.content,
            d.path,
            d.pinned as i64,
            d.created_at,
            d.source_app,
            d.html,
            d.merged_count,
            d.checked
        ],
    )?;
    // Restore never prunes (it restores exactly what was deleted); just sweep
    // picture-cache orphans.
    gc_picture_cache(conn, base);
    Ok(())
}

fn set_pinned(conn: &Connection, id: u32, pinned: bool) -> rusqlite::Result<()> {
    let changed = conn.execute(
        "UPDATE clipboard SET pinned = ?1 WHERE id = ?2",
        params![pinned as i64, id],
    )?;
    if changed == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    Ok(())
}

/// Delete every history row. With `keep_pinned`, pinned rows (and their
/// picture-cache files) survive; otherwise the table is emptied and the
/// picture cache is swept of all files.
fn clear_history(conn: &Connection, base: &Path, keep_pinned: bool) -> rusqlite::Result<usize> {
    if keep_pinned {
        let deleted = conn.execute("DELETE FROM clipboard WHERE pinned = 0", [])?;
        gc_picture_cache(conn, base);
        return Ok(deleted);
    }
    let deleted = conn.execute("DELETE FROM clipboard", [])?;
    let dir = base.join(PICTURE_CACHE);
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
    gc_picture_cache(conn, base);
    Ok(deleted)
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

fn image_limits() -> image::Limits {
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_EDGE);
    limits.max_image_height = Some(MAX_IMAGE_EDGE);
    limits.max_alloc = Some(MAX_IMAGE_ALLOC_BYTES);
    limits
}

fn image_dimensions_within_limit(width: u32, height: u32) -> bool {
    width > 0
        && height > 0
        && width <= MAX_IMAGE_EDGE
        && height <= MAX_IMAGE_EDGE
        && u64::from(width) * u64::from(height) <= MAX_IMAGE_PIXELS
}

/// Parse dimensions before allocating the RGBA buffer.
fn checked_image_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("read image header: {e}"))?;
    reader.limits(image_limits());
    let (width, height) = reader
        .into_dimensions()
        .map_err(|e| format!("decode image dimensions: {e}"))?;
    if !image_dimensions_within_limit(width, height) {
        return Err(format!(
            "image dimensions too large: {width}x{height} (cap {MAX_IMAGE_EDGE}px edge, {MAX_IMAGE_PIXELS} pixels)"
        ));
    }
    Ok((width, height))
}

fn decode_image_bounded(bytes: &[u8]) -> Result<image::DynamicImage, String> {
    checked_image_dimensions(bytes)?;
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| format!("read image header: {e}"))?;
    reader.limits(image_limits());
    reader.decode().map_err(|e| format!("decode image: {e}"))
}

/// Downscale a stored PNG to a small base64 data URI for the frontend.
fn make_thumb(png: &[u8]) -> Option<String> {
    let img = decode_image_bounded(png).ok()?.to_rgba8();
    let (w, h) = (img.width(), img.height());
    let max = THUMB_MAX;
    let (nw, nh) = if w > h {
        (max, (h * max / w).max(1))
    } else {
        ((w * max / h).max(1), max)
    };
    let thumb = image::imageops::resize(&img, nw, nh, image::imageops::FilterType::Triangle);
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgba8(thumb)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(buf)
    ))
}

/// Encode an RGBA `ImageData` from the clipboard as PNG bytes.
fn encode_png(img: &arboard::ImageData) -> Option<Vec<u8>> {
    if !image_dimensions_within_limit(img.width as u32, img.height as u32) {
        return None;
    }
    let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.to_vec())?;
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .ok()?;
    Some(buf)
}

// ---------------------------------------------------------------------------
// Clipboard I/O
// ---------------------------------------------------------------------------

/// Display name of the process owning the foreground window at capture time
/// ("" when none — e.g. no foreground window, access denied, or a stub app).
fn foreground_process_name() -> String {
    let full = unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
            PROCESS_QUERY_LIMITED_INFORMATION,
        };
        use windows::Win32::UI::WindowsAndMessaging::{
            GetForegroundWindow, GetWindowThreadProcessId,
        };
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return String::new();
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if pid == 0 {
            return String::new();
        }
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = vec![0u16; 4096];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if ok.is_err() {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..size as usize])
    };
    process_display_name(&full)
}

/// Reduce a full process image path to a display name: strip the directory and
/// the extension, capitalizing the first letter ("chrome.exe" → "Chrome").
/// Pure — unit-tested.
fn process_display_name(full_path: &str) -> String {
    let file = full_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(full_path);
    let stem = file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file);
    let mut chars = stem.chars();
    match chars.next() {
        Some(c) => c.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Whether the source app is on the ignore list (case-insensitive exact match
/// against the display name). Pure — unit-tested.
fn is_ignored(ignore: &[String], source: &str) -> bool {
    if ignore.is_empty() || source.is_empty() {
        return false;
    }
    ignore.iter().any(|a| a.eq_ignore_ascii_case(source))
}

/// Content kind of a file path by extension: `"text"` | `"audio"` | `"video"`
/// | `"image"` | `"pdf"` | `"other"` (drives the 文本文件 / 图片 / 音乐 / 视频
/// categories and mirrors `src/App.tsx` `fileContent`). Pure — unit-tested.
fn file_content_kind(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if matches!(
        ext.as_str(),
        // Markup / data
        "txt" | "md" | "log" | "json" | "toml" | "ini" | "cfg" | "yaml" | "yml" | "csv"
            | "html" | "css" | "xml" | "sh" | "bat" | "ps1" | "sql" | "tex"
            // Source code (common programming languages)
            | "rs" | "py" | "js" | "ts" | "jsx" | "tsx" | "mjs" | "cjs" | "c" | "cpp" | "h"
            | "java" | "go" | "lua" | "kt" | "swift" | "php" | "rb" | "dart" | "scala"
            | "cs" | "fs" | "fsx" | "r" | "pl" | "hs" | "zig" | "nim" | "ex" | "exs"
            | "erl" | "clj" | "vue" | "svelte" | "groovy" | "gradle" | "proto" | "gql"
            // Lyrics & subtitles
            | "lrc" | "srt" | "vtt" | "ass"
    ) {
        "text"
    } else if matches!(
        ext.as_str(),
        "mp3" | "wav" | "flac" | "ogg" | "m4a" | "aac" | "wma" | "opus" | "mid" | "midi"
    ) {
        "audio"
    } else if matches!(
        ext.as_str(),
        "mp4" | "mkv" | "webm" | "mov" | "avi" | "wmv" | "flv" | "m4v" | "mpg" | "mpeg"
    ) {
        "video"
    } else if matches!(
        ext.as_str(),
        "png" | "jpg" | "jpeg" | "gif" | "bmp" | "webp" | "ico" | "svg" | "tif" | "tiff"
    ) {
        "image"
    } else if ext == "pdf" {
        "pdf"
    } else {
        "other"
    }
}

/// Capture whatever changed on the clipboard. Precedence: text, then a
/// file/folder list (CF_HDROP), then a bitmap image. The arboard handle is
/// scoped per operation so it never holds the clipboard open while the
/// CF_HDROP check opens it itself. `record_files` / `record_images`, the
/// history cap, the ignore list and the auto-merge rules come from the live
/// settings; a paused state (status-bar toggle) skips everything.
fn capture(state: &ClipboardState, clip: &crate::settings::Clipboard) {
    // Pause recording (状态栏 toggle) — skip everything.
    if state.paused.load(Ordering::Relaxed) {
        return;
    }
    let base = crate::paths::data_dir();
    let source = foreground_process_name();
    // Ignored app (密码管理器/隐私聊天): skip WITHOUT touching last_*, so the
    // same content copied later from a non-ignored app is still recorded.
    if is_ignored(&clip.ignore_apps, &source) {
        return;
    }
    let merge = MergeConfig {
        enabled: clip.merge_copy,
        window_ms: clip.merge_window_ms,
        last_paste_at: *state.last_paste_at.lock().unwrap(),
    };
    // 1. Text, with optional rich-text HTML (CF_HTML) capped to keep the DB lean.
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if let Ok(text) = cb.get_text() {
            if let Some(text) = retained_clipboard_text(text) {
                let html = cb
                    .get()
                    .html()
                    .ok()
                    .map(|mut h| {
                        truncate_utf8_boundary(&mut h, HTML_CAP);
                        h
                    });
                let conn = state.db.lock().unwrap();
                if insert_text_history(
                    &conn, &text, &source, html, clip.history_cap, &base, &merge, clip.dedup,
                )
                .is_err()
                {
                    eprintln!("[clipboard] failed to store text history");
                }
            }
            return;
        }
        // cb drops here, releasing the clipboard before the file check.
    }
    // 2. File/folder list (copied from Explorer) — stored verbatim, never
    // read or copied. A copied *image file* lands here, not in the bitmap
    // branch, which matches the intended text|file|image split. When file
    // recording is off, a file copy is skipped outright (an image *file*
    // should not fall through to the bitmap branch).
    if let Some(paths) = read_file_list() {
        if clip.record_files {
            let conn = state.db.lock().unwrap();
            if insert_file_history(&conn, &paths, &source, clip.history_cap, &base, clip.dedup)
                .is_err()
            {
                eprintln!("[clipboard] failed to store file history");
            }
        }
        return;
    }
    // 3. Bitmap image (screenshot / copied from a web page). The standard path
    // is `arboard::get_image()` reading CF_DIB; screenshot tools (PixPin,
    // WeChat, …) sometimes put only a custom PNG format on the clipboard, so we
    // fall back to reading that directly.
    if clip.record_images {
        let png = if let Ok(mut cb) = arboard::Clipboard::new() {
            cb.get_image().ok().and_then(|img| encode_png(&img))
        } else {
            None
        }
        .or_else(read_custom_png_image)
        .or_else(read_cf_bitmap_image);
        if let Some(png) = png {
            let conn = state.db.lock().unwrap();
            if insert_image_history(&conn, &png, &source, clip.history_cap, &base).is_err() {
                eprintln!("[clipboard] failed to store image history");
            }
        }
    }
}

/// Read a CF_BITMAP (device-dependent bitmap, format 2) off the clipboard.
/// `arboard::get_image()` reads only CF_DIB/CF_DIBV5, but many screenshot tools
/// (PixPin, WeChat, Snipaste…) put a plain CF_BITMAP on their "copy" button —
/// the same format Chromium's `clipboard.readImage()` accepts. The HBITMAP is
/// converted to PNG via the shared `bitmap_to_png`.
fn read_cf_bitmap_image() -> Option<Vec<u8>> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let _guard = OpenClipboardGuard;
        let handle = GetClipboardData(2 /* CF_BITMAP */).ok()?;
        let hbitmap = windows::Win32::Graphics::Gdi::HBITMAP(handle.0);
        crate::icons::bitmap_to_png(hbitmap)
    }
}

/// Try to read an image from a non-CF_DIB clipboard format. Screenshot tools
/// (PixPin, WeChat, …) often put a custom-registered PNG format on the
/// clipboard without the standard `CF_DIB` that `arboard::get_image()` reads,
/// so the bitmap branch would miss them. Enumerates the open clipboard's
/// formats, reads the first whose registered name looks like a PNG image
/// format, and returns its bytes (used as-is if already PNG, else re-encoded).
fn read_custom_png_image() -> Option<Vec<u8>> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let _guard = OpenClipboardGuard;
        let mut found: Option<Vec<u8>> = None;
        let mut fmt: u32 = 0;
        loop {
            fmt = EnumClipboardFormats(fmt);
            if fmt == 0 {
                break;
            }
            if fmt == CF_HDROP {
                continue; // handled by the file branch
            }
            let mut name = [0u16; 80];
            let n = GetClipboardFormatNameW(fmt, &mut name);
            if n <= 0 {
                continue; // system format without a name — not a custom image
            }
            let nm = String::from_utf16_lossy(&name[..n as usize]).to_lowercase();
            if !(nm.contains("png") || nm.contains("image/png")) {
                continue;
            }
            if let Ok(handle) = GetClipboardData(fmt) {
                let ptr = GlobalLock(HGLOBAL(handle.0));
                if !ptr.is_null() {
                    let size = GlobalSize(HGLOBAL(handle.0));
                    if size > 0 && size <= MAX_CLIPBOARD_IMAGE_BYTES {
                        let bytes = std::slice::from_raw_parts(ptr as *const u8, size).to_vec();
                        if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                            found = Some(bytes);
                        } else if let Ok(img) = decode_image_bounded(&bytes) {
                            let mut buf = Vec::new();
                            if img
                                .write_to(
                                    &mut std::io::Cursor::new(&mut buf),
                                    image::ImageFormat::Png,
                                )
                                .is_ok()
                            {
                                found = Some(buf);
                            }
                        }
                    }
                    let _ = GlobalUnlock(HGLOBAL(handle.0));
                }
                if found.is_some() {
                    break;
                }
            }
        }
        found
    }
}

/// Read a CF_HDROP file list from the clipboard (files/folders copied from
/// Explorer). Returns the raw paths; the files themselves are never read.
fn read_file_list() -> Option<Vec<String>> {
    unsafe {
        if IsClipboardFormatAvailable(CF_HDROP).is_err() {
            return None;
        }
        if OpenClipboard(None).is_err() {
            return None;
        }
        let _guard = OpenClipboardGuard;
        read_hdrop()
    }
}

/// Enumerate the paths of an already-open CF_HDROP clipboard.
unsafe fn read_hdrop() -> Option<Vec<String>> {
    let handle = GetClipboardData(CF_HDROP).ok()?;
    let hdrop = HDROP(handle.0);
    if hdrop.0.is_null() {
        return None;
    }
    let count = DragQueryFileW(hdrop, 0xFFFF_FFFF, None);
    let mut paths = Vec::with_capacity(count as usize);
    for i in 0..count {
        let needed = DragQueryFileW(hdrop, i, None);
        let mut buf = vec![0u16; needed as usize + 1];
        DragQueryFileW(hdrop, i, Some(&mut buf));
        paths.push(String::from_utf16_lossy(&buf[..needed as usize]));
    }
    (!paths.is_empty()).then_some(paths)
}

/// Poll the clipboard sequence number and store new content on change. Reads
/// the live clipboard settings on each change so toggles take effect without
/// a restart.
fn spawn_listener(app: AppHandle) {
    std::thread::spawn(move || loop {
        let seq =
            unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
        let state = app.state::<ClipboardState>();
        let last = state.last_seq.load(Ordering::Relaxed);
        if seq != last {
            state.last_seq.store(seq, Ordering::Relaxed);
            if !should_skip_sequence(
                seq,
                state.self_write_seq.load(Ordering::SeqCst),
                state.self_write_pending.load(Ordering::SeqCst),
            ) {
                let clip = app
                    .state::<crate::settings::SettingsState>()
                    .current()
                    .clipboard;
                capture(&state, &clip);
            }
        }
        std::thread::sleep(POLL_INTERVAL);
    });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/// Open the persistent database (falling back to in-memory on error), manage
/// the shared state, and start the listener. Always manages the state so the
/// search command can never panic on missing state.
pub fn init(app: &tauri::App) {
    let conn = match open_db() {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("[clipboard] failed to open DB, using in-memory store: {e}");
            let conn = Connection::open_in_memory().expect("in-memory sqlite");
            let _ = init_db(&conn);
            conn
        }
    };
    // 内容去重 off → the text-dedup unique index must not exist (it would
    // reject the duplicate inserts the off state records).
    let dedup = app
        .state::<crate::settings::SettingsState>()
        .current()
        .clipboard
        .dedup;
    if let Err(e) = set_dedup_index(&conn, dedup) {
        eprintln!("[clipboard] failed to apply dedup index: {e}");
    }
    app.manage(ClipboardState {
        db: Mutex::new(conn),
        last_seq: AtomicU32::new(0),
        self_write_seq: AtomicU32::new(0),
        self_write_pending: AtomicBool::new(false),
        paused: AtomicBool::new(false),
        last_paste_at: Mutex::new(None),
    });
    spawn_listener(app.handle().clone());
}

fn open_db() -> rusqlite::Result<Connection> {
    let dir = crate::paths::data_dir();
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    let conn = Connection::open(crate::paths::db_path())?;
    init_db(&conn)?;
    // One-time extraction of legacy image BLOBs into the picture cache.
    migrate_blobs_to_files(&conn, &crate::paths::data_dir())?;
    Ok(conn)
}

/// Adapt a `tauri::Error`/`std::io::Error` into `rusqlite::Error`.
fn io_err(e: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(e.to_string())))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Read the current system clipboard TEXT (None = non-text or empty).
#[tauri::command]
pub async fn get_clipboard_text(
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<Option<String>, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "clipboard",
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        match cb.get().text() {
            Ok(text) => Ok(if text.is_empty() { None } else { Some(text) }),
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write plain text to the system clipboard (plugin `clipboard.writeText`).
/// Uses the shared self-write guard so plugin content never enters history.
#[tauri::command]
pub async fn set_clipboard_text(
    text: String,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<(), String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "clipboard",
    )?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        write_clipboard_payload(&state, || {
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            cb.set_text(text).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Normalize a manually entered or picked ignore-list value to the same
/// display name the capture path stores (`chrome.exe` / a full path →
/// `Chrome`). The settings pane keeps this logic out of the webview so the
/// comparison in `is_ignored` cannot drift from the picker.
#[tauri::command]
pub fn normalize_clipboard_ignore_app(app_name: String) -> Result<String, String> {
    let name = process_display_name(app_name.trim());
    if name.is_empty() {
        Err("invalid app name".into())
    } else {
        Ok(name)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct IgnoredAppIcon {
    pub name: String,
    pub icon: Option<String>,
}

fn find_running_app_path(
    app: &str,
    programs: &[crate::automation::WindowProgram],
) -> Option<String> {
    let app = process_display_name(app);
    programs
        .iter()
        .find(|program| process_display_name(&program.name).eq_ignore_ascii_case(&app))
        .map(|program| program.path.clone())
}

fn expand_environment(value: &str) -> String {
    use windows::core::PCWSTR;
    use windows::Win32::System::Environment::ExpandEnvironmentStringsW;

    let source: Vec<u16> = value.encode_utf16().chain(std::iter::once(0)).collect();
    let needed = unsafe { ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), None) };
    if needed == 0 || needed > 32_768 {
        return value.to_string();
    }
    let mut expanded = vec![0u16; needed as usize];
    let written = unsafe {
        ExpandEnvironmentStringsW(PCWSTR(source.as_ptr()), Some(&mut expanded))
    };
    if written == 0 || written > expanded.len() as u32 {
        return value.to_string();
    }
    String::from_utf16_lossy(&expanded[..written.saturating_sub(1) as usize])
}

fn executable_from_registry_value(value: &str) -> Option<String> {
    let expanded = expand_environment(value);
    let value = expanded.trim();
    let path = value
        .strip_prefix('"')
        .and_then(|rest| rest.split_once('"').map(|(path, _)| path))
        .unwrap_or(value)
        .trim();
    Path::new(path).is_file().then(|| path.to_string())
}

fn registry_app_path(app: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE,
        KEY_READ, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE,
    };

    fn read_default(root: HKEY, subkey: &str) -> Option<String> {
        use windows::Win32::Foundation::WIN32_ERROR;
        let wide: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
        let mut key = HKEY(std::ptr::null_mut());
        let rc = unsafe {
            RegOpenKeyExW(root, PCWSTR(wide.as_ptr()), None, KEY_READ, &mut key)
        };
        if rc != WIN32_ERROR(0) {
            return None;
        }
        let mut buf = vec![0u16; 4096];
        let mut len = (buf.len() * 2) as u32;
        let mut ty = REG_VALUE_TYPE(0);
        let rc = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR::null(),
                None,
                Some(&mut ty),
                Some(buf.as_mut_ptr() as *mut u8),
                Some(&mut len),
            )
        };
        let _ = unsafe { RegCloseKey(key) };
        if rc != WIN32_ERROR(0) || (ty.0 != REG_SZ.0 && ty.0 != REG_EXPAND_SZ.0) {
            return None;
        }
        let n = (len as usize / 2).saturating_sub(1);
        String::from_utf16(&buf[..n]).ok()
    }

    let file_name = if app.to_ascii_lowercase().ends_with(".exe") {
        app.to_string()
    } else {
        format!("{app}.exe")
    };
    let subkey = format!(
        r"Software\Microsoft\Windows\CurrentVersion\App Paths\{file_name}"
    );
    [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE]
        .into_iter()
        .find_map(|root| read_default(root, &subkey).and_then(|v| executable_from_registry_value(&v)))
}

fn start_menu_app_path(app: &str) -> Option<String> {
    let needle = app.to_ascii_lowercase();
    if needle.is_empty() {
        return None;
    }
    let mut partial: Option<(usize, String)> = None;
    for root in crate::cache::start_menu_dirs() {
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                if path
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_none_or(|ext| !ext.eq_ignore_ascii_case("lnk"))
                {
                    continue;
                }
                let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
                    continue;
                };
                if stem.eq_ignore_ascii_case(app) {
                    return Some(path.to_string_lossy().into_owned());
                }
                if stem.to_ascii_lowercase().contains(&needle)
                    && partial
                        .as_ref()
                        .is_none_or(|(best_len, _)| stem.len() < *best_len)
                {
                    partial = Some((stem.len(), path.to_string_lossy().into_owned()));
                }
            }
        }
    }
    partial.map(|(_, path)| path)
}

fn path_search_app(app: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::SearchPathW;

    let file_name = if app.to_ascii_lowercase().ends_with(".exe") {
        app.to_string()
    } else {
        format!("{app}.exe")
    };
    let wide: Vec<u16> = file_name.encode_utf16().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 32768];
    let len = unsafe {
        SearchPathW(
            PCWSTR::null(),
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            Some(&mut buf),
            None,
        )
    };
    if len == 0 || len as usize >= buf.len() {
        return None;
    }
    String::from_utf16(&buf[..len as usize]).ok()
}

fn resolve_ignored_app_path(
    app: &str,
    programs: &[crate::automation::WindowProgram],
) -> Option<String> {
    let name = process_display_name(app);
    if name.is_empty() {
        return None;
    }
    find_running_app_path(&name, programs)
        .or_else(|| registry_app_path(&name))
        .or_else(|| start_menu_app_path(&name))
        .or_else(|| path_search_app(&name))
}

/// Resolve icons for the ignored-app list. Path resolution and shell
/// extraction are expensive, so the whole batch runs off the IPC thread and
/// reuses the shared icon cache. Unresolved entries return `None`; the
/// settings pane presents the standard unknown-app glyph for those.
#[tauri::command]
pub async fn clipboard_ignore_app_icons(apps: Vec<String>) -> Vec<IgnoredAppIcon> {
    let mut names: Vec<String> = Vec::new();
    for app in apps {
        let name = process_display_name(app.trim());
        if !name.is_empty() && !names.iter().any(|existing| existing.eq_ignore_ascii_case(&name)) {
            names.push(name);
        }
    }
    if names.is_empty() {
        return Vec::new();
    }
    let requested = names.clone();
    let resolved = tauri::async_runtime::spawn_blocking(move || {
        let programs = crate::automation::collect_window_programs();
        requested
            .into_iter()
            .filter_map(|name| {
                resolve_ignored_app_path(&name, &programs).map(|path| (name, path))
            })
            .collect::<HashMap<String, String>>()
    })
    .await
    .unwrap_or_default();

    let paths: Vec<String> = resolved.values().cloned().collect();
    let icons = crate::icons::get_app_icons_inner(paths).await.unwrap_or_default();
    let icon_by_path: HashMap<String, String> = icons
        .into_iter()
        .filter_map(|entry| entry.icon.map(|icon| (entry.path, icon)))
        .collect();
    names
        .into_iter()
        .map(|name| IgnoredAppIcon {
            icon: resolved
                .get(&name)
                .and_then(|path| icon_by_path.get(path))
                .cloned(),
            name,
        })
        .collect()
}

// ── Plugin host clipboard surface (docs/PLUGIN_API.md §8.1) ──
//
// Plugins could already read/write text; these add the other two payload kinds
// (PNG images, CF_HDROP file lists) plus the paste-into-the-previous-window
// action, reusing the exact internals the clipboard mode uses (the same
// auto_paste flow, the same HDROP writer) so behaviour cannot drift.

/// Reject an implausible image payload before decoding (the IPC layer carries
/// whatever a plugin sends; the decode is the expensive part).
const MAX_PLUGIN_IMAGE_BYTES: usize = 32 * 1024 * 1024;

/// Decode a base64 payload that may be a `data:image/png;base64,…` URI.
fn decode_image_payload(data: &str) -> Result<Vec<u8>, String> {
    let b64 = match data.split_once(',') {
        Some((head, rest)) if head.starts_with("data:") => rest,
        _ => data,
    };
    crate::bounded::decode_base64_bounded(b64, MAX_PLUGIN_IMAGE_BYTES)
}

/// Put a PNG (base64 or data URI) on the clipboard as an image.
/// Permission: `clipboard` — enforced Rust-side (plugin_perm.rs).
#[tauri::command]
pub async fn plugin_clipboard_write_image(
    data: String,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<(), String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "clipboard",
    )?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        write_clipboard_payload(&state, || {
            let png = decode_image_payload(&data)?;
            let rgba = decode_image_bounded(&png)?.to_rgba8();
            let (w, h) = (rgba.width(), rgba.height());
            let img = arboard::ImageData {
                width: w as usize,
                height: h as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            };
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            cb.set_image(img).map_err(|e| e.to_string())?;
            eprintln!("[plugins] clipboard.writeImage: {w}x{h}");
            Ok(())
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Put a file/folder list on the clipboard as CF_HDROP (Explorer-style copy).
#[tauri::command]
pub async fn plugin_clipboard_write_files(
    paths: Vec<String>,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<(), String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "clipboard",
    )?;
    if paths.is_empty() {
        return Err("no paths given".into());
    }
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        eprintln!("[plugins] clipboard.writeFiles: {} path(s)", paths.len());
        write_clipboard_payload(&state, || set_files_to_clipboard(&paths))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The clipboard's current file list (empty when it holds something else).
#[tauri::command]
pub async fn plugin_clipboard_read_files(
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<Vec<String>, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "clipboard",
    )?;
    tauri::async_runtime::spawn_blocking(|| Ok(read_file_list().unwrap_or_default()))
        .await
        .map_err(|e| e.to_string())?
}

/// Whether the clipboard currently holds an image in any format the reader
/// below can decode. A CF_HDROP file list is NOT an image.
#[tauri::command]
pub async fn plugin_clipboard_has_image() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(|| unsafe {
        if OpenClipboard(None).is_err() {
            return false;
        }
        let _guard = OpenClipboardGuard;
        if IsClipboardFormatAvailable(8).is_ok() || IsClipboardFormatAvailable(2).is_ok() {
            return true;
        }
        if IsClipboardFormatAvailable(CF_HDROP).is_ok() {
            return false;
        }
        let mut fmt: u32 = 0;
        loop {
            fmt = EnumClipboardFormats(fmt);
            if fmt == 0 {
                break;
            }
            if fmt == CF_HDROP {
                continue;
            }
            let mut name = [0u16; 80];
            let n = GetClipboardFormatNameW(fmt, &mut name);
            if n <= 0 {
                continue;
            }
            let nm = String::from_utf16_lossy(&name[..n as usize]).to_lowercase();
            if nm.contains("png") || nm.contains("image/png") {
                return true;
            }
        }
        false
    })
    .await
    .map_err(|e| e.to_string())
}

/// Read the clipboard's image as a `data:image/png;base64,…` URI.
#[tauri::command]
pub async fn plugin_clipboard_read_image(
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<Option<String>, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "clipboard",
    )?;
    tauri::async_runtime::spawn_blocking(|| {
        let png = if let Ok(mut cb) = arboard::Clipboard::new() {
            cb.get_image().ok().and_then(|img| encode_png(&img))
        } else {
            None
        }
        .or_else(read_custom_png_image)
        .or_else(read_cf_bitmap_image);
        Ok(png.map(|bytes| {
            format!(
                "data:image/png;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(bytes)
            )
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write one payload to the clipboard and paste it into the window that had
/// focus before the launcher appeared (the clipboard mode's auto_paste flow:
/// hide the launcher, restore focus, Ctrl+V). Exactly one payload is expected.
/// Like a normal copy, the payload STAYS on the clipboard afterwards.
/// Permission: `clipboard` — enforced Rust-side (plugin_perm.rs).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn plugin_clipboard_paste(
    text: Option<String>,
    image: Option<String>,
    files: Option<Vec<String>>,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
    focus: State<'_, crate::window::FocusState>,
    app: AppHandle,
) -> Result<(), String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "clipboard",
    )?;
    let given = [text.is_some(), image.is_some(), files.is_some()]
        .iter()
        .filter(|x| **x)
        .count();
    if given == 0 {
        return Err("paste needs one of text / image / files".into());
    }
    if given > 1 {
        return Err("paste takes exactly one of text / image / files".into());
    }
    eprintln!(
        "[plugins] clipboard.paste: {}",
        if text.is_some() {
            "text"
        } else if image.is_some() {
            "image"
        } else {
            "files"
        }
    );
    auto_paste(&app, &focus, || {
        if let Some(t) = text {
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            return cb.set_text(t).map_err(|e| e.to_string());
        }
        if let Some(img) = image {
            let png = decode_image_payload(&img)?;
            let rgba = decode_image_bounded(&png)?.to_rgba8();
            let data = arboard::ImageData {
                width: rgba.width() as usize,
                height: rgba.height() as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            };
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            return cb.set_image(data).map_err(|e| e.to_string());
        }
        let files = files.unwrap_or_default();
        if files.is_empty() {
            return Err("no paths given".into());
        }
        set_files_to_clipboard(&files)
    })
    .map(|_| ())
}

/// Async on purpose: **sync commands run on the main (UI) thread**, and a full
/// history is not a quick query (a debug build measured ~4s for the first
/// 172-row load). While it ran there, every other IPC — including the
/// frontend's loading-gate `set_size` — queued behind it, so a page that was
/// still loading could not collapse the window behind its spinner. Async runs
/// the query on the runtime; the DB mutex is only held here, off-thread.
#[tauri::command]
pub async fn search_clipboard(
    query: String,
    kind: Option<String>,
    state: State<'_, ClipboardState>,
    settings: State<'_, crate::settings::SettingsState>,
) -> Result<ClipboardSearchResult, String> {
    let kind = kind.unwrap_or_else(|| "all".into());
    let clip = settings.current().clipboard;
    let limit = clip.history_cap.max(1) as u32;
    let conn = state.db.lock().unwrap();
    search_history_result(
        &conn,
        query.trim(),
        &kind,
        limit,
        &crate::paths::data_dir(),
        clip.favorites_top,
    )
    .map_err(|e| e.to_string())
}

/// Write the entry `id` back to the system clipboard (text or image). `plain`
/// forces plain text for rows that carry rich-text HTML. A file row copies the
/// checked ∩ existing subset (多文件勾选); an invalid row is rejected with a
/// sentinel the frontend maps to a toast.
#[tauri::command]
pub async fn copy_clipboard(
    id: u32,
    plain: Option<bool>,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        let conn = state.db.lock().unwrap();
        let row = get_row(&conn, id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("clipboard item {id} not found"))?;
        drop(conn);
        let remember = app
            .state::<crate::settings::SettingsState>()
            .current()
            .clipboard
            .remember_checks;
        let base = crate::paths::data_dir();
        let paths = usable_paths(&row, remember, &base)?;
        write_clipboard_payload(&state, || {
            set_clipboard_from_row_paths(&row, &paths, plain.unwrap_or(false))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Pause / resume clipboard recording (runtime-only — not persisted). Returns
/// the new paused state.
#[tauri::command]
pub fn set_clipboard_paused(paused: bool, state: State<ClipboardState>) -> Result<bool, String> {
    state.paused.store(paused, Ordering::Relaxed);
    Ok(paused)
}

/// Read a text file's content for the preview pane (capped at 512 KB; binary
/// content is lossy-decoded as UTF-8 so a stray .txt with a weird encoding
/// still previews).
#[tauri::command]
pub async fn get_file_text(
    path: String,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<String, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "fs.read",
    )?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::bounded::read_file_bounded(Path::new(&path), 512 * 1024)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read a file's raw bytes (base64) for preview renderers that must decode
/// binary content in JS (pdf.js, SheetJS). The sandbox made plugin pages
/// opaque origins, so `fetch(asset://…)` is CORS-refused there — this bridge
/// call restores the byte channel the asset protocol used to provide
/// (fs.read permission, frontend ledger). Cap mirrors the thumbnail path.
#[tauri::command]
pub async fn get_file_bytes(
    path: String,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<String, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "fs.read",
    )?;
    // Off the main thread: a 32 MB read + ~43 MB base64 string is hundreds of
    // milliseconds of blocking work that would otherwise freeze every IPC.
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::bounded::read_file_bounded(Path::new(&path), 32 * 1024 * 1024)?;
        Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Downscale an image file to a small base64 thumbnail for the preview pane.
/// The webview decodes only a ≤`THUMB_MAX`-px PNG here — never the full-size
/// image — so a large screenshot doesn't leave a huge decoded bitmap sitting
/// in the renderer's image cache after the preview closes (same pipeline the
/// clipboard image rows use for their `thumb`).
#[tauri::command]
pub async fn get_file_thumb(
    path: String,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<String, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "fs.read",
    )?;
    // Off the main thread (`get_video_thumb` has the same rationale): sync
    // commands run on the main (UI) thread, and decoding a multi-megabyte image
    // there would stall every other IPC for the duration.
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::bounded::read_file_bounded(Path::new(&path), 50 * 1024 * 1024)?;
        make_thumb(&bytes).ok_or_else(|| "not a readable image".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Extract a video thumbnail (a frame) via the Windows shell, for the preview
/// player's `<video poster>` — shown until the user presses play (the player is
/// `preload="none"`, so without this the video area is just black). Returns a
/// base64 PNG data URI, or an error when the shell has no thumbnail provider
/// for the file (the frontend then shows a placeholder).
#[tauri::command]
pub async fn get_video_thumb(
    path: String,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<String, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "fs.read",
    )?;
    // Run the shell extraction off the main thread: sync commands run on the
    // main (STA) thread where `CoInitializeEx(COINIT_MULTITHREADED)` fails with
    // RPC_E_CHANGED_MODE; the blocking pool is a fresh COM context, and the
    // extraction can also take a moment for large files.
    tauri::async_runtime::spawn_blocking(move || {
        crate::icons::extract_video_thumb_png(&path)
            .map(|png| {
                format!(
                    "data:image/png;base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(&png)
                )
            })
            .ok_or_else(|| "no shell thumbnail for video".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Absolute path of an image row's stored PNG, for the preview pane and the
/// enlarge overlay. The frontend renders it via `convertFileSrc` (asset://), so
/// WebView2 decodes the full-size image straight from disk — no base64 string
/// round-tripped through IPC and re-decoded in JS (a real memory/CPU spike for
/// large screenshots).
#[tauri::command]
pub fn get_clipboard_image(id: u32, state: State<ClipboardState>) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    let row = get_row(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("clipboard item {id} not found"))?;
    if row.kind != "image" {
        return Err("clipboard item is not an image".into());
    }
    let Some(rel) = row.path.as_deref() else {
        return Err("image item has no file".into());
    };
    // `rel` already includes the `PictureCache/` prefix — resolve it against the
    // data dir (NOT picture_dir(), which would double the prefix).
    Ok(crate::paths::data_dir().join(rel).to_string_lossy().into_owned())
}

/// Result of a paste attempt. `copied` means no target window was available,
/// so the entry landed on the clipboard only — the launcher stays open and
/// the frontend reports that instead of pretending it pasted.
#[derive(Serialize)]
pub struct PasteOutcome {
    pub outcome: &'static str,
    pub reason: Option<&'static str>,
}

/// Paste flow shared by single- and multi-item paste: take ownership of the
/// stored target HWND, let `set` put the entry onto the clipboard, hide the
/// launcher, send Ctrl+V — and LEAVE the entry on the clipboard (the pasted
/// content is what the user just used, so it stays; checking the system
/// clipboard afterwards shows the pasted item, not the previous one). If no
/// target window is recorded or the window is gone, falls back to a plain
/// clipboard copy (`set` alone) — the launcher stays open and the outcome is
/// reported as `copied`.
fn auto_paste(
    app: &AppHandle,
    focus: &crate::window::FocusState,
    set: impl FnOnce() -> Result<(), String>,
) -> Result<PasteOutcome, String> {
    // Read the target first; it stays one-shot until both the clipboard write
    // and the paste hand-off succeed.
    let maybe_hwnd = *focus.last_hwnd.lock().unwrap();
    let state = app.state::<ClipboardState>();
    let mut payload = Some(set);

    let Some(hwnd_raw) = maybe_hwnd else {
        // No target window recorded — fall back to a plain copy.
        eprintln!("[clipboard] paste: no target window recorded — copied without pasting");
        write_clipboard_payload(&state, || {
            payload.take().expect("clipboard payload consumed")()
        })?;
        return Ok(PasteOutcome {
            outcome: "copied",
            reason: Some("no_target"),
        });
    };

    if !unsafe { IsWindow(Some(HWND(hwnd_raw as *mut std::ffi::c_void))) }.as_bool() {
        // Window is gone — fall back to a plain copy.
        eprintln!("[clipboard] paste: target window is gone — copied without pasting");
        *focus.last_hwnd.lock().unwrap() = None;
        write_clipboard_payload(&state, || {
            payload.take().expect("clipboard payload consumed")()
        })?;
        return Ok(PasteOutcome {
            outcome: "copied",
            reason: Some("target_gone"),
        });
    }

    // Place the entry on the system clipboard (it stays there after the paste).
    write_clipboard_payload(&state, || {
        payload.take().expect("clipboard payload consumed")()
    })?;

    // 粘贴后关闭: hide the launcher so focus can return to the target window.
    // When disabled, keep the launcher up but still explicitly hand focus to
    // the recorded target; suppressing auto-hide alone would send Ctrl+V back
    // into the launcher search box.
    let paste_close = app
        .state::<crate::settings::SettingsState>()
        .current()
        .clipboard
        .paste_close;
    if paste_close {
        let _ = crate::window::hide_launcher(app.clone());
    } else {
        crate::window::suppress_hide(focus, 1500);
    }

    let target = HWND(hwnd_raw as *mut std::ffi::c_void);
    if !crate::input::force_foreground(target) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
        }
        return Err("could not focus the paste target window".into());
    }

    // Send Ctrl+V to the window we just verified as foreground. If injection
    // failed, bring the launcher back so the frontend error toast is visible.
    let sent = unsafe { send_ctrl_v() };
    if !sent {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.set_focus();
        }
        return Err("SendInput failed to send Ctrl+V".into());
    }

    // The paste actually reached the target. Consume the one-shot target and
    // leave the payload on the clipboard as the most recently used content.
    focus.last_hwnd.lock().unwrap().take();
    std::thread::sleep(Duration::from_millis(100));

    Ok(PasteOutcome {
        outcome: "pasted",
        reason: None,
    })
}

/// Write the entry `id` to the clipboard and paste it (Ctrl+V via SendInput)
/// into the window that had focus before the launcher appeared. Falls back to
/// a plain clipboard copy when no target window is recorded. The entry stays
/// on the system clipboard after the paste (it is what was just used).
#[tauri::command]
pub async fn paste_clipboard(id: u32, app: AppHandle) -> Result<PasteOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        let focus = app.state::<crate::window::FocusState>();
        let conn = state.db.lock().unwrap();
        let row = get_row(&conn, id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("clipboard item {id} not found"))?;
        drop(conn);
        let remember = app
            .state::<crate::settings::SettingsState>()
            .current()
            .clipboard
            .remember_checks;
        let base = crate::paths::data_dir();
        let res = auto_paste(&app, &focus, || {
            let paths = usable_paths(&row, remember, &base)?;
            set_clipboard_from_row_paths(&row, &paths, false)
        });
        // A paste closes the current auto-merge window (deliberate use of an entry).
        *state.last_paste_at.lock().unwrap() = Some(now_millis());
        res
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Paste several entries at once as one merged text: every selected *text*
/// row's content is joined with newlines. A selection with no text rows falls
/// back to a single-item paste of the first selected entry. Falls back to a
/// plain copy when no target window is recorded.
#[tauri::command]
pub async fn paste_clipboard_multi(
    ids: Vec<u32>,
    app: AppHandle,
) -> Result<PasteOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        let focus = app.state::<crate::window::FocusState>();
        let conn = state.db.lock().unwrap();
        let mut texts: Vec<String> = Vec::new();
        let mut first: Option<Row> = None;
        for id in ids {
            if let Some(row) = get_row(&conn, id).map_err(|e| e.to_string())? {
                if first.is_none() {
                    first = Some(row.clone());
                }
                if row.kind == "text" {
                    texts.push(row.content);
                }
            }
        }
        drop(conn);

        let res = if !texts.is_empty() {
            let joined = texts.join("\n");
            auto_paste(&app, &focus, || {
                let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                cb.set_text(&joined).map_err(|e| e.to_string())
            })
        } else {
            let remember = app
                .state::<crate::settings::SettingsState>()
                .current()
                .clipboard
                .remember_checks;
            let base = crate::paths::data_dir();
            match first {
                Some(row) => auto_paste(&app, &focus, || {
                    let paths = usable_paths(&row, remember, &base)?;
                    set_clipboard_from_row_paths(&row, &paths, false)
                }),
                None => Err("no clipboard items found".into()),
            }
        };
        // A paste closes the current auto-merge window.
        *state.last_paste_at.lock().unwrap() = Some(now_millis());
        res
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Place a history row onto the system clipboard: text inline, image read
/// back from its picture-cache file, file rows re-assembled as a CF_HDROP path
/// list. `paths` is the pre-filtered subset for file rows (checked ∩ existing);
/// empty means "use the row's own list verbatim" (callers that don't filter).
fn set_clipboard_from_row_paths(row: &Row, paths: &[String], plain: bool) -> Result<(), String> {
    if plain && row.kind == "text" && row.html.is_some() {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        return cb.set_text(&row.content).map_err(|e| e.to_string());
    }
    match row.kind.as_str() {
        "image" => {
            let Some(rel) = row.path.as_deref() else {
                return Err("image item has no file".into());
            };
            // `rel` already carries the `PictureCache/` prefix — resolve against
            // the data dir, not picture_dir() (which would double the prefix).
            let png = crate::bounded::read_file_bounded(
                &crate::paths::data_dir().join(rel),
                MAX_CLIPBOARD_IMAGE_BYTES,
            )?;
            let rgba = decode_image_bounded(&png)?.to_rgba8();
            let img = arboard::ImageData {
                width: rgba.width() as usize,
                height: rgba.height() as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            };
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            cb.set_image(img).map_err(|e| e.to_string())
        }
        "file" => {
            if paths.is_empty() {
                let all: Vec<String> = row.content.lines().map(str::to_owned).collect();
                set_files_to_clipboard(&all)
            } else {
                set_files_to_clipboard(paths)
            }
        }
        _ => {
            // Rich text: when the row captured HTML, put HTML + plain text back
            // so pasting keeps formatting; otherwise plain text only.
            if let Some(html) = row.html.as_deref() {
                let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                cb.set_html(html, Some(&row.content)).map_err(|e| e.to_string())
            } else {
                let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
                cb.set_text(&row.content).map_err(|e| e.to_string())
            }
        }
    }
}

/// Build the byte layout of a CF_HDROP block: a `DROPFILES` header followed by
/// the UTF-16 paths (each NUL-terminated, the whole list double NUL-terminated).
/// Pure — shared by [`set_files_to_clipboard`] and tests.
fn build_hdrop_buffer(paths: &[String]) -> Vec<u8> {
    let header = DROPFILES {
        pFiles: std::mem::size_of::<DROPFILES>() as u32,
        pt: POINT { x: 0, y: 0 },
        fNC: BOOL(0),
        fWide: BOOL(1),
    };
    let bytes = unsafe {
        std::slice::from_raw_parts(
            &header as *const DROPFILES as *const u8,
            std::mem::size_of::<DROPFILES>(),
        )
    };
    let mut buf =
        Vec::with_capacity(bytes.len() + paths.iter().map(|p| (p.encode_utf16().count() + 1) * 2).sum::<usize>() + 2);
    buf.extend_from_slice(bytes);
    for p in paths {
        for unit in p.encode_utf16().chain(std::iter::once(0)) {
            buf.extend_from_slice(&unit.to_le_bytes());
        }
    }
    buf.extend_from_slice(&0u16.to_le_bytes()); // trailing NUL → double-NUL end
    buf
}

/// Put a file path list back on the system clipboard as CF_HDROP. The clipboard
/// is EMPTIED first (like ZTools' native addon and arboard's set_text): without
/// `EmptyClipboard`, Explorer's leftover `CF_UNICODETEXT` (the previously copied
/// file's path) survives, so a text-based clipboard read/paste shows that stale
/// "newest" path instead of this file list — the root cause of "copying an old
/// file entry always yields the newest file".
fn set_files_to_clipboard(paths: &[String]) -> Result<(), String> {
    let buf = build_hdrop_buffer(paths);
    let hglobal = unsafe { GlobalAlloc(GMEM_MOVEABLE, buf.len()) }.map_err(|e| e.to_string())?;
    let ptr = unsafe { GlobalLock(hglobal) };
    if ptr.is_null() {
        unsafe { GlobalFree(Some(hglobal)) }.ok();
        return Err("GlobalLock failed".into());
    }
    unsafe {
        std::ptr::copy_nonoverlapping(buf.as_ptr(), ptr as *mut u8, buf.len());
        let _ = GlobalUnlock(hglobal);
    }
    if unsafe { OpenClipboard(None) }.is_err() {
        unsafe { GlobalFree(Some(hglobal)) }.ok();
        return Err("OpenClipboard failed".into());
    }
    // Clear every stale format so the clipboard holds ONLY this HDROP.
    unsafe { EmptyClipboard().ok() };
    // SetClipboardData takes ownership of the block on success.
    let res = unsafe { SetClipboardData(CF_HDROP, Some(HANDLE(hglobal.0))) };
    let _ = unsafe { CloseClipboard() };
    match res {
        Ok(_) => Ok(()),
        Err(e) => {
            unsafe { GlobalFree(Some(hglobal)) }.ok();
            Err(e.to_string())
        }
    }
}

/// Send Ctrl+V (key-down / key-down / key-up / key-up) via `SendInput` so the
/// foreground application receives a paste command. Returns true only when
/// all four events were inserted.
unsafe fn send_ctrl_v() -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
        VIRTUAL_KEY, VK_CONTROL,
    };

    let mut inputs: [INPUT; 4] = std::mem::zeroed();

    // Ctrl down
    inputs[0].r#type = INPUT_KEYBOARD;
    inputs[0].Anonymous.ki = KEYBDINPUT {
        wVk: VK_CONTROL,
        wScan: 0,
        dwFlags: KEYBD_EVENT_FLAGS(0),
        time: 0,
        dwExtraInfo: 0,
    };

    // V down
    inputs[1].r#type = INPUT_KEYBOARD;
    inputs[1].Anonymous.ki = KEYBDINPUT {
        wVk: VIRTUAL_KEY(0x56),
        wScan: 0,
        dwFlags: KEYBD_EVENT_FLAGS(0),
        time: 0,
        dwExtraInfo: 0,
    };

    // V up
    inputs[2].r#type = INPUT_KEYBOARD;
    inputs[2].Anonymous.ki = KEYBDINPUT {
        wVk: VIRTUAL_KEY(0x56),
        wScan: 0,
        dwFlags: KEYEVENTF_KEYUP,
        time: 0,
        dwExtraInfo: 0,
    };

    // Ctrl up
    inputs[3].r#type = INPUT_KEYBOARD;
    inputs[3].Anonymous.ki = KEYBDINPUT {
        wVk: VK_CONTROL,
        wScan: 0,
        dwFlags: KEYEVENTF_KEYUP,
        time: 0,
        dwExtraInfo: 0,
    };

    SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) == inputs.len() as u32
}

/// Delete a single history entry. Returns the deleted row so the frontend can
/// restore it from its undo buffer (the picture file is retained until the
/// next sweep).
#[tauri::command]
pub async fn delete_clipboard(id: u32, app: AppHandle) -> Result<DeletedClip, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        let conn = state.db.lock().unwrap();
        let row = get_row(&conn, id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("clipboard item {id} not found"))?;
        let deleted = DeletedClip::from(&row);
        delete_row(&conn, id, &crate::paths::data_dir()).map_err(|e| e.to_string())?;
        Ok(deleted)
    })
    .await
    .map_err(|e| e.to_string())?
}
/// Restore a previously-deleted entry (the undo button's backend).
#[tauri::command]
pub fn restore_clipboard(
    item: DeletedClip,
    state: State<ClipboardState>,
    settings: State<crate::settings::SettingsState>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    restore_row(
        &conn,
        &item,
        &crate::paths::data_dir(),
        settings.current().clipboard.dedup,
    )
    .map_err(|e| e.to_string())
}

/// Per-path existence check for the multi-file list preview (missing files are
/// struck through and their checkbox disabled).
const MAX_EXISTENCE_PATHS: usize = 1024;
const MAX_EXISTENCE_PATH_CHARS: usize = 32_768;

#[tauri::command]
pub async fn check_file_exists(paths: Vec<String>) -> Result<Vec<bool>, String> {
    if paths.len() > MAX_EXISTENCE_PATHS {
        return Err(format!(
            "too many paths for existence check: {} (max {MAX_EXISTENCE_PATHS})",
            paths.len()
        ));
    }
    if let Some(index) = paths.iter().position(|path| {
        path.len() > MAX_EXISTENCE_PATH_CHARS || path.contains('\0')
    }) {
        return Err(format!("invalid path at index {index}"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| Path::new(path).exists())
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}
/// Persist a multi-file entry's checked-file indices (`None` clears the
/// override → the entry falls back to "every existing file checked").
#[tauri::command]
pub async fn set_clipboard_checked(
    id: u32,
    checked: Option<Vec<u32>>,
    state: State<'_, ClipboardState>,
) -> Result<(), String> {
    let json = checked.map(|v| serde_json::to_string(&v).unwrap_or_default());
    let conn = state.db.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE clipboard SET checked = ?1 WHERE id = ?2",
            params![json, id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("clipboard item {id} not found"));
    }
    Ok(())
}

/// Pin or unpin a history entry.
#[tauri::command]
pub async fn pin_clipboard(
    id: u32,
    pinned: bool,
    state: State<'_, ClipboardState>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    set_pinned(&conn, id, pinned).map_err(|e| e.to_string())
}

/// Clear the clipboard history. With `keep_pinned`, pinned entries (and their
/// picture files) survive. Returns the number of rows deleted.
#[tauri::command]
pub async fn clear_clipboard(keep_pinned: bool, app: AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<ClipboardState>();
        let conn = state.db.lock().unwrap();
        clear_history(&conn, &crate::paths::data_dir(), keep_pinned)
            .map(|deleted| deleted as u32)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Cap passed to insert/prune in tests (independent of the live settings).
    const TEST_CAP: i64 = 200;
    /// Source app label used by the insert helpers in tests.
    const TEST_SRC: &str = "TestApp";

    /// Serializes the tests that write to the shared Windows clipboard (they
    /// would race each other under `cargo test`'s parallel runner).
    static CLIPBOARD_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// The custom-format fallback reads a PNG placed under ONLY a registered
    /// "PNG" format (no CF_DIB) — the PixPin-style in-app copy case.
    /// The CF_BITMAP fallback reads a device-dependent bitmap off the clipboard
    /// (the GDI format screenshot tools' "copy" buttons use).
    #[test]
    fn read_cf_bitmap_returns_png() {
        let _guard = CLIPBOARD_LOCK.lock().unwrap();
        use windows::Win32::Graphics::Gdi::{
            CreateDIBSection, GetDC, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, DIB_RGB_COLORS,
        };
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, SetClipboardData,
        };
        let hdc = unsafe { GetDC(None) };
        assert!(!hdc.is_invalid());
        let mut bi = BITMAPINFO::default();
        bi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bi.bmiHeader.biWidth = 64;
        bi.bmiHeader.biHeight = -64; // top-down
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = windows::Win32::Graphics::Gdi::BI_RGB.0;
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let hbmp = unsafe { CreateDIBSection(Some(hdc), &bi, DIB_RGB_COLORS, &mut bits, None, 0) }
            .expect("CreateDIBSection");
        let _ = unsafe { ReleaseDC(None, hdc) };
        assert!(!hbmp.0.is_null());
        // Fill with an opaque red so the PNG is a real image.
        unsafe {
            let px = std::slice::from_raw_parts_mut(bits as *mut u8, 64 * 64 * 4);
            for p in px.as_chunks_mut::<4>().0 {
                p[0] = 0;
                p[1] = 0;
                p[2] = 255; // BGRA → red
                p[3] = 255;
            }
        }
        unsafe {
            assert!(OpenClipboard(None).is_ok());
            assert!(EmptyClipboard().is_ok());
            let res = SetClipboardData(2 /* CF_BITMAP */, Some(HANDLE(hbmp.0)));
            assert!(res.is_ok(), "SetClipboardData CF_BITMAP: {res:?}");
            let _ = CloseClipboard();
        }
        let got = read_cf_bitmap_image();
        assert!(got.is_some(), "CF_BITMAP fallback should return PNG bytes");
        assert!(got.unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
    }

    #[test]
    fn read_custom_png_finds_png_format() {
        let _guard = CLIPBOARD_LOCK.lock().unwrap();
        use windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, RegisterClipboardFormatW, SetClipboardData,
        };
        use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
        unsafe {
            let data = sample_png();
            let fmt = RegisterClipboardFormatW(windows::core::w!("PNG"));
            assert!(fmt != 0, "register PNG format");
            if OpenClipboard(None).is_err() {
                eprintln!("clipboard busy — skipping");
                return;
            }
            assert!(EmptyClipboard().is_ok());
            let h = GlobalAlloc(GMEM_MOVEABLE, data.len()).unwrap();
            let ptr = GlobalLock(h);
            assert!(!ptr.is_null());
            std::ptr::copy_nonoverlapping(data.as_ptr(), ptr as *mut u8, data.len());
            let _ = GlobalUnlock(h);
            let res = SetClipboardData(fmt, Some(HANDLE(h.0 as _)));
            assert!(res.is_ok(), "SetClipboardData: {res:?}");
            let _ = CloseClipboard();
            if res.is_err() {
                let _ = GlobalFree(Some(h));
            }
        }
        let got = read_custom_png_image();
        assert!(got.is_some(), "fallback should read the custom PNG format");
        assert!(got.unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
    }

    /// A disabled merge config — most tests don't exercise auto-merge.
    fn no_merge() -> MergeConfig {
        MergeConfig {
            enabled: false,
            window_ms: 1500,
            last_paste_at: None,
        }
    }

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        set_dedup_index(&conn, true).unwrap();
        conn
    }

    /// A scratch data dir for file-backed tests (image cache). Unique per tag
    /// within the test process; removed at the end of each test.
    fn temp_base(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lume-clip-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_png() -> Vec<u8> {
        let img = image::RgbaImage::from_pixel(32, 32, image::Rgba([0, 128, 255, 255]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    }

    #[test]
    fn migration_preserves_old_data() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                content TEXT NOT NULL UNIQUE,
                created_at INTEGER NOT NULL
            );
            INSERT INTO clipboard(content, created_at) VALUES ('legacy one', 1000);
            INSERT INTO clipboard(content, created_at) VALUES ('legacy two', 2000);",
        )
        .unwrap();
        init_db(&conn).unwrap();
        let base = temp_base("migrate");
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2, "legacy rows must survive migration");
        assert_eq!(hits[0].content, "legacy two");
        let cols: Vec<String> = conn
            .prepare("PRAGMA table_info(clipboard)")
            .unwrap()
            .query_map([], |r| r.get(1))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(cols.contains(&"kind".to_string()));
        assert!(cols.contains(&"pinned".to_string()));
        assert!(cols.contains(&"path".to_string()));
        assert!(cols.contains(&"source_app".to_string()));
        assert!(cols.contains(&"html".to_string()));
        assert!(cols.contains(&"merged_count".to_string()));
        // Legacy rows keep their identity and get an empty source app.
        assert_eq!(hits[0].source_app, "");
        assert_eq!(hits[1].source_app, "");
        assert_eq!(hits[0].merged_count, 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn migration_plaintext_downgrades_existing_merged_html() {
        let conn = memory_db();
        let base = temp_base("merge-migrate");
        let merge = MergeConfig {
            enabled: true,
            window_ms: 60_000,
            last_paste_at: None,
        };
        insert_text_history(&conn, "one", TEST_SRC, Some("<b>one</b>".into()), TEST_CAP, &base, &merge, true).unwrap();
        insert_text_history(&conn, "two", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        conn.execute("UPDATE clipboard SET html = '<b>one</b>' WHERE merged_count > 1", []).unwrap();
        init_db(&conn).unwrap();
        let row = conn
            .query_row("SELECT html FROM clipboard WHERE merged_count > 1", [], |r| r.get::<_, Option<String>>(0))
            .unwrap();
        assert_eq!(row, None, "legacy merged HTML is downgraded on startup");
        fs::remove_dir_all(&base).ok();
    }
    #[test]
    fn insert_and_substring_search() {
        let conn = memory_db();
        let base = temp_base("sub");
        insert_text_history(&conn, "hello world", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "hello lume", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        let hits = search_history(&conn, "hello", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits[0].created_at >= hits[1].created_at);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn source_app_is_persisted() {
        let conn = memory_db();
        let base = temp_base("srcapp");
        insert_text_history(&conn, "hello world", "Chrome", None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_file_history(&conn, &["C:/a.txt".into()], "Explorer", TEST_CAP, &base, true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits[0].kind, "file");
        assert_eq!(hits[0].source_app, "Explorer");
        assert_eq!(hits[1].kind, "text");
        assert_eq!(hits[1].source_app, "Chrome");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn empty_query_returns_most_recent_first() {
        let conn = memory_db();
        let base = temp_base("empty");
        insert_text_history(&conn, "first", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "second", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits[0].content, "second");
        assert_eq!(hits[1].content, "first");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn duplicate_text_bumps_recency_without_duplicating() {
        let conn = memory_db();
        let base = temp_base("dedup");
        insert_text_history(&conn, "alpha", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "beta", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "alpha", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap(); // re-copied → moves to top
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "alpha");
        assert_eq!(hits[1].content, "beta");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn prune_keeps_newest() {
        let conn = memory_db();
        let base = temp_base("prune");
        insert_text_history(&conn, "a", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "b", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "c", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        prune(&conn, 2, &base).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "c");
        assert_eq!(hits[1].content, "b");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn search_is_case_insensitive() {
        let conn = memory_db();
        let base = temp_base("case");
        insert_text_history(&conn, "Visual Studio", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        assert_eq!(search_history(&conn, "visual", "all", 20, &base, false).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "STUDIO", "all", 20, &base, false).unwrap().len(), 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn search_treats_like_wildcards_literally() {
        let conn = memory_db();
        let base = temp_base("like-literal");
        insert_text_history(&conn, "100% complete", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "snake_case", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "back\\slash", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "MiXeD 中文", "App_100%", None, TEST_CAP, &base, &no_merge(), true).unwrap();

        assert_eq!(search_history(&conn, "%", "all", 20, &base, false).unwrap().len(), 2);
        assert_eq!(search_history(&conn, "_", "all", 20, &base, false).unwrap().len(), 2);
        assert_eq!(search_history(&conn, "\\", "all", 20, &base, false).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "mixed", "all", 20, &base, false).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "100%", "all", 20, &base, false).unwrap().len(), 2);
        assert_eq!(search_history(&conn, "no_such_wildcard%", "all", 20, &base, false).unwrap().len(), 0);
        fs::remove_dir_all(&base).ok();
    }
    #[test]
    fn history_cap_applies_after_content_category_filtering() {
        let conn = memory_db();
        let base = temp_base("category-cap");
        insert_file_history(&conn, &["C:/audit/old.txt".into()], TEST_SRC, 1_000, &base, true).unwrap();
        for i in 0..8 {
            insert_file_history(&conn, &[format!("C:/audit/new-{i}.mkv")], TEST_SRC, 1_000, &base, false).unwrap();
        }
        let text = search_history(&conn, "", "textfile", 2, &base, false).unwrap();
        assert_eq!(text.len(), 1);
        assert_eq!(text[0].content, "C:/audit/old.txt");
        let video = search_history(&conn, "", "video", 2, &base, false).unwrap();
        assert_eq!(video.len(), 2, "the category's own cap is still applied");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn pinned_rows_are_visible_beyond_the_history_cap() {
        let conn = memory_db();
        let base = temp_base("pinned-cap");
        insert_text_history(&conn, "old-pin", TEST_SRC, None, 1_000, &base, &no_merge(), true).unwrap();
        let pin = search_history(&conn, "old-pin", "all", 20, &base, false).unwrap()[0].id;
        set_pinned(&conn, pin, true).unwrap();
        for i in 0..5 {
            insert_text_history(&conn, &format!("fresh-{i}"), TEST_SRC, None, 1_000, &base, &no_merge(), true).unwrap();
        }
        let rows = search_history(&conn, "", "all", 2, &base, false).unwrap();
        assert_eq!(rows.len(), 3, "two unpinned rows + the cap-exempt pin");
        assert!(rows.iter().any(|row| row.content == "old-pin"));
        let favorites = search_history(&conn, "", "favorites", 2, &base, false).unwrap();
        assert_eq!(favorites.len(), 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn category_counts_use_content_kind_and_ignore_active_filter() {
        let conn = memory_db();
        let base = temp_base("category-counts");
        insert_text_history(&conn, "plain", TEST_SRC, None, 1_000, &base, &no_merge(), true).unwrap();
        insert_file_history(&conn, &["C:/a.txt".into()], TEST_SRC, 1_000, &base, true).unwrap();
        insert_file_history(&conn, &["C:/b.mp3".into()], TEST_SRC, 1_000, &base, true).unwrap();
        insert_file_history(&conn, &["C:/c.mkv".into()], TEST_SRC, 1_000, &base, true).unwrap();
        insert_file_history(&conn, &["C:/d.png".into()], TEST_SRC, 1_000, &base, true).unwrap();
        insert_image_history(&conn, &sample_png(), TEST_SRC, 1_000, &base).unwrap();
        let result = search_history_result(&conn, "", "textfile", 20, &base, false).unwrap();
        assert_eq!(result.items.len(), 1);
        assert_eq!(result.total, 1);
        assert_eq!(result.categories, ClipboardCategoryCounts {
            all: 6,
            text: 1,
            textfile: 1,
            image: 2,
            music: 1,
            video: 1,
            favorites: 0,
        });
        let all = search_history_result(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(all.categories, result.categories);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn mutation_helpers_reject_missing_ids_and_report_actual_deletes() {
        let conn = memory_db();
        let base = temp_base("mutation-semantics");
        assert!(set_pinned(&conn, 9_999, true).is_err());
        insert_text_history(&conn, "keep", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        let keep = search_history(&conn, "keep", "all", 20, &base, false).unwrap()[0].id;
        set_pinned(&conn, keep, true).unwrap();
        insert_text_history(&conn, "drop-a", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "drop-b", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        let deleted = clear_history(&conn, &base, true).unwrap();
        assert_eq!(deleted, 2, "kept pins are not counted as deletions");
        let rows = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].content, "keep");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn pinned_sorts_first_when_favorites_top_and_survives_prune() {
        let conn = memory_db();
        let base = temp_base("pinned");
        insert_text_history(&conn, "unpinned-a", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "pinned-b", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        set_pinned(&conn, search_history(&conn, "pinned-b", "all", 1, &base, false).unwrap()[0].id, true).unwrap();
        insert_text_history(&conn, "unpinned-c", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, true).unwrap();
        assert_eq!(hits[0].content, "pinned-b", "with favorites_top, pinned must sort first");
        prune(&conn, 1, &base).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, true).unwrap();
        assert_eq!(hits.len(), 2, "pinned + newest unpinned");
        assert!(hits.iter().any(|h| h.pinned));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn favorites_top_off_keeps_pure_recency() {
        let conn = memory_db();
        let base = temp_base("pin-off");
        insert_text_history(&conn, "first", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "second", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "third", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        // Favorite the oldest row; with favorites_top=false it must NOT jump first.
        let id = search_history(&conn, "first", "all", 1, &base, false).unwrap()[0].id;
        set_pinned(&conn, id, true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits[0].content, "third", "recency order preserved (favorites not on top)");
        assert_eq!(hits[2].content, "first", "the favorited row keeps its recency slot");
        assert!(hits[2].pinned);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn image_writes_file_and_stores_path() {
        let conn = memory_db();
        let base = temp_base("img");
        let png = sample_png();
        insert_image_history(&conn, &png, TEST_SRC, TEST_CAP, &base).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "image");
        // A PNG file exists under PictureCache and the row points at it.
        let row = get_row(&conn, hits[0].id).unwrap().unwrap();
        let rel = row.path.as_deref().expect("image row must have a path");
        assert_eq!(rel, "PictureCache/1.png");
        assert!(base.join(rel).exists(), "PNG file must exist on disk");
        assert_eq!(row.data, None, "DB must not hold image bytes");
        // The thumbnail is derived from the file.
        assert!(hits[0]
            .thumb
            .as_deref()
            .map(|t| t.starts_with("data:image/png;base64,"))
            .unwrap_or(false));
        // Images are findable by their label.
        assert_eq!(search_history(&conn, "image", "all", 20, &base, false).unwrap().len(), 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_image_round_trip_reads_file() {
        let conn = memory_db();
        let base = temp_base("roundtrip");
        let png = sample_png();
        insert_image_history(&conn, &png, TEST_SRC, TEST_CAP, &base).unwrap();
        let row = get_row(&conn, search_history(&conn, "", "all", 1, &base, false).unwrap()[0].id)
            .unwrap()
            .unwrap();
        let file = base.join(row.path.as_deref().unwrap());
        let rgba = image::load_from_memory(&fs::read(&file).unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!((rgba.width(), rgba.height()), (32, 32));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn file_list_is_one_row_deduped_by_content() {
        let conn = memory_db();
        let base = temp_base("files");
        insert_file_history(&conn, &["C:/a.txt".into(), "C:/b.txt".into()], TEST_SRC, TEST_CAP, &base, true).unwrap();
        // Re-copying the same list bumps recency instead of duplicating.
        insert_file_history(&conn, &["C:/a.txt".into(), "C:/b.txt".into()], TEST_SRC, TEST_CAP, &base, true).unwrap();
        insert_file_history(&conn, &["C:/c.txt".into()], TEST_SRC, TEST_CAP, &base, true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].kind, "file");
        assert_eq!(hits[0].content, "C:/c.txt");
        // Searchable by a contained path fragment.
        assert_eq!(search_history(&conn, "a.txt", "all", 20, &base, false).unwrap().len(), 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn migrate_blobs_extracts_files() {
        let conn = memory_db();
        let base = temp_base("migrate-blob");
        // Simulate a pre-#12 row whose image bytes are still in the BLOB.
        conn.execute(
            "INSERT INTO clipboard(kind, content, data, path, pinned, created_at)
             VALUES ('image', 'Image', ?1, NULL, 0, 1)",
            params![sample_png()],
        )
        .unwrap();
        migrate_blobs_to_files(&conn, &base).unwrap();
        let row = get_row(&conn, 1).unwrap().unwrap();
        let rel = row.path.as_deref().expect("migrated row must point at a file");
        assert_eq!(rel, "PictureCache/1.png");
        assert!(base.join(rel).exists());
        assert_eq!(row.data, None, "BLOB must be cleared after extraction");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn delete_keeps_picture_for_undo_then_sweeps() {
        let conn = memory_db();
        let base = temp_base("del");
        insert_image_history(&conn, &sample_png(), TEST_SRC, TEST_CAP, &base).unwrap();
        let id = search_history(&conn, "", "all", 20, &base, false).unwrap()[0].id;
        let file = base.join(format!("PictureCache/{id}.png"));
        assert!(file.exists());
        delete_row(&conn, id, &base).unwrap();
        assert_eq!(search_history(&conn, "", "all", 20, &base, false).unwrap().len(), 0);
        // The PNG is kept so an undo can restore it.
        assert!(file.exists(), "picture file survives the delete for undo");
        // A later sweep removes the orphan.
        gc_picture_cache(&conn, &base);
        assert!(!file.exists(), "orphan picture file swept after the undo window");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn restore_reinserts_a_deleted_row() {
        let conn = memory_db();
        let base = temp_base("restore");
        insert_text_history(&conn, "alpha", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_image_history(&conn, &sample_png(), TEST_SRC, TEST_CAP, &base).unwrap();
        // Delete the image row and capture what was removed.
        let image_id = search_history(&conn, "Image", "all", 20, &base, false).unwrap()[0].id;
        let row = get_row(&conn, image_id).unwrap().unwrap();
        let deleted = DeletedClip::from(&row);
        delete_row(&conn, image_id, &base).unwrap();
        assert_eq!(search_history(&conn, "", "all", 20, &base, false).unwrap().len(), 1);
        // Restore it — the row and its picture file come back.
        restore_row(&conn, &deleted, &base, true).unwrap();
        let hits = search_history(&conn, "Image", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "image");
        assert_eq!(hits[0].source_app, TEST_SRC, "restored row keeps its source app");
        assert!(hits[0].thumb.is_some(), "restored image thumb is readable from its file");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn text_row_stores_and_reports_html() {
        let conn = memory_db();
        let base = temp_base("html");
        insert_text_history(
            &conn,
            "rich",
            TEST_SRC,
            Some("<b>rich</b>".into()),
            TEST_CAP,
            &base,
            &no_merge(),
            true,
        )
        .unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].has_html, "row must report it carries HTML");
        let row = get_row(&conn, hits[0].id).unwrap().unwrap();
        assert_eq!(row.html.as_deref(), Some("<b>rich</b>"));
        // A plain copy (no HTML) reports has_html = false.
        insert_text_history(
            &conn,
            "plain",
            TEST_SRC,
            None,
            TEST_CAP,
            &base,
            &no_merge(),
            true,
        )
        .unwrap();
        let hits = search_history(&conn, "plain", "all", 20, &base, false).unwrap();
        assert!(!hits[0].has_html);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn is_ignored_matches_case_insensitively() {
        assert!(is_ignored(&["Chrome".into(), "WeChat".into()], "chrome"));
        assert!(is_ignored(&["chrome".into()], "CHROME"));
        assert!(!is_ignored(&["Chrome".into()], "chrome.exe"));
        assert!(!is_ignored(&["Chrome".into()], "Edge"));
        assert!(!is_ignored(&[], "Chrome"), "empty list never ignores");
        assert!(!is_ignored(&["Chrome".into()], ""), "empty source never ignored");
    }

    #[test]
    fn merge_appends_within_window_and_counts_pieces() {
        let conn = memory_db();
        let base = temp_base("merge-in");
        let merge = MergeConfig {
            enabled: true,
            window_ms: 60_000,
            last_paste_at: None,
        };
        insert_text_history(&conn, "alpha", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        insert_text_history(&conn, "beta", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1, "two copies within the window merge into one row");
        assert_eq!(hits[0].content, "alpha\nbeta");
        assert_eq!(hits[0].merged_count, 2);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn rich_text_merge_degrades_to_plain_text() {
        let conn = memory_db();
        let base = temp_base("merge-html");
        let merge = MergeConfig {
            enabled: true,
            window_ms: 60_000,
            last_paste_at: None,
        };
        insert_text_history(
            &conn,
            "one",
            TEST_SRC,
            Some("<b>one</b>".into()),
            TEST_CAP,
            &base,
            &merge,
            true,
        )
        .unwrap();
        insert_text_history(
            &conn,
            "two",
            TEST_SRC,
            Some("<i>two</i>".into()),
            TEST_CAP,
            &base,
            &merge,
            true,
        )
        .unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "one\ntwo");
        assert!(!hits[0].has_html, "merged rich text must not advertise stale HTML");
        let row = get_row(&conn, hits[0].id).unwrap().unwrap();
        assert!(row.html.is_none(), "merged row is copied back as plain text");
        fs::remove_dir_all(&base).ok();
    }
    #[test]
    fn merge_opens_new_row_outside_window() {
        let conn = memory_db();
        let base = temp_base("merge-out");
        let merge = MergeConfig {
            enabled: true,
            window_ms: 1500,
            last_paste_at: None,
        };
        insert_text_history(&conn, "alpha", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        // Force the last row's timestamp far enough back that the window lapses.
        conn.execute(
            "UPDATE clipboard SET created_at = created_at - 100000 WHERE kind = 'text'",
            [],
        )
        .unwrap();
        insert_text_history(&conn, "beta", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2, "a copy beyond the window starts a new row");
        assert_eq!(hits[0].content, "beta");
        assert_eq!(hits[0].merged_count, 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn merge_skips_duplicate_last_piece() {
        let conn = memory_db();
        let base = temp_base("merge-dup");
        let merge = MergeConfig {
            enabled: true,
            window_ms: 60_000,
            last_paste_at: None,
        };
        insert_text_history(&conn, "alpha", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        insert_text_history(&conn, "beta", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        // Re-copying the last piece is a duplicate — it must not append a third.
        insert_text_history(&conn, "beta", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "alpha\nbeta", "no third line appended");
        assert_eq!(hits[0].merged_count, 2);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn merge_closed_by_a_paste() {
        let conn = memory_db();
        let base = temp_base("merge-paste");
        let merge = MergeConfig {
            enabled: true,
            window_ms: 1500,
            last_paste_at: Some(now_millis() + 1_000_000),
        };
        insert_text_history(&conn, "alpha", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        insert_text_history(&conn, "beta", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2, "a paste after the row closes the merge window");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn merge_disabled_inserts_separate_rows() {
        let conn = memory_db();
        let base = temp_base("merge-off");
        insert_text_history(&conn, "alpha", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_text_history(&conn, "beta", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].merged_count, 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn restore_keeps_merged_count_after_plaintext_downgrade() {
        let conn = memory_db();
        let base = temp_base("restore-p2");
        let merge = MergeConfig {
            enabled: true,
            window_ms: 1500,
            last_paste_at: None,
        };
        insert_text_history(&conn, "alpha", TEST_SRC, Some("<b>alpha</b>".into()), TEST_CAP, &base, &merge, true).unwrap();
        insert_text_history(&conn, "beta", TEST_SRC, None, TEST_CAP, &base, &merge, true).unwrap();
        let id = search_history(&conn, "", "all", 20, &base, false).unwrap()[0].id;
        let row = get_row(&conn, id).unwrap().unwrap();
        let deleted = DeletedClip::from(&row);
        delete_row(&conn, id, &base).unwrap();
        restore_row(&conn, &deleted, &base, true).unwrap();
        let hits = search_history(&conn, "alpha", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].content, "alpha\nbeta");
        assert_eq!(hits[0].merged_count, 2, "merged count survives restore");
        assert!(!hits[0].has_html, "merged rich text stays downgraded after restore");
        let row = get_row(&conn, hits[0].id).unwrap().unwrap();
        assert_eq!(row.html, None);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn clear_empties_table_and_picture_cache() {
        let conn = memory_db();
        let base = temp_base("clear");
        insert_text_history(&conn, "a", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_image_history(&conn, &sample_png(), TEST_SRC, TEST_CAP, &base).unwrap();
        clear_history(&conn, &base, false).unwrap();
        assert_eq!(search_history(&conn, "", "all", 20, &base, false).unwrap().len(), 0);
        assert_eq!(fs::read_dir(base.join("PictureCache")).unwrap().count(), 0);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn clear_keep_pinned_retains_pinned_rows_and_their_images() {
        let conn = memory_db();
        let base = temp_base("clear-pinned");
        insert_text_history(&conn, "unpinned-a", TEST_SRC, None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_image_history(&conn, &sample_png(), TEST_SRC, TEST_CAP, &base).unwrap();
        let pinned_id = search_history(&conn, "Image", "all", 20, &base, false).unwrap()[0].id;
        set_pinned(&conn, pinned_id, true).unwrap();
        clear_history(&conn, &base, true).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1, "only the pinned row survives");
        assert!(hits[0].pinned);
        let file = base.join(format!("PictureCache/{pinned_id}.png"));
        assert!(file.exists(), "pinned image file survives the clear");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn search_filters_by_kind_and_source_app() {
        let conn = memory_db();
        let base = temp_base("kind");
        insert_text_history(&conn, "hello world", "Chrome", None, TEST_CAP, &base, &no_merge(), true).unwrap();
        insert_file_history(&conn, &["C:/a.txt".into()], "Explorer", TEST_CAP, &base, true).unwrap();
        insert_file_history(&conn, &["C:/b.mkv".into()], "Explorer", TEST_CAP, &base, true).unwrap();
        insert_file_history(&conn, &["C:/c.png".into()], "Explorer", TEST_CAP, &base, true).unwrap();
        insert_file_history(&conn, &["C:/d.mp3".into()], "Explorer", TEST_CAP, &base, true).unwrap();
        insert_image_history(&conn, &sample_png(), "Snipping", TEST_CAP, &base).unwrap();
        assert_eq!(search_history(&conn, "", "text", 20, &base, false).unwrap().len(), 1);
        // Content-kind categories: 文本文件 / 音乐 / 图片 / 视频 filter file
        // rows by extension (图片 also includes image rows).
        assert_eq!(search_history(&conn, "", "textfile", 20, &base, false).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "", "textfile", 20, &base, false).unwrap()[0].content, "C:/a.txt");
        assert_eq!(search_history(&conn, "", "music", 20, &base, false).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "", "music", 20, &base, false).unwrap()[0].content, "C:/d.mp3");
        assert_eq!(search_history(&conn, "", "video", 20, &base, false).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "", "video", 20, &base, false).unwrap()[0].content, "C:/b.mkv");
        assert_eq!(search_history(&conn, "", "image", 20, &base, false).unwrap().len(), 2, "image rows + image-content file rows");
        // Source app names are searchable.
        assert_eq!(search_history(&conn, "chrome", "all", 20, &base, false).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "SNIPPING", "all", 20, &base, false).unwrap().len(), 1);
        // Favorites = pinned rows only.
        assert_eq!(search_history(&conn, "", "favorites", 20, &base, false).unwrap().len(), 0);
        let image_id = search_history(&conn, "", "image", 20, &base, false).unwrap()[0].id;
        set_pinned(&conn, image_id, true).unwrap();
        let favs = search_history(&conn, "", "favorites", 20, &base, false).unwrap();
        assert_eq!(favs.len(), 1);
        assert_eq!(favs[0].kind, "image");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn file_content_kind_extends_source_lyrics_and_pdf() {
        // Existing text extensions stay text.
        assert_eq!(file_content_kind("C:/x.rs"), "text");
        assert_eq!(file_content_kind("C:/x.ts"), "text");
        // Newly added source-code languages.
        for ext in [
            "kt", "swift", "php", "rb", "dart", "scala", "cs", "fs", "fsx", "r", "pl", "hs",
            "zig", "nim", "ex", "exs", "erl", "clj", "vue", "svelte", "jsx", "tsx", "mjs",
            "cjs", "groovy", "gradle", "proto", "gql", "tex",
        ] {
            assert_eq!(file_content_kind(&format!("C:/song.{ext}")), "text", "{ext}");
        }
        // Lyrics and subtitles are text.
        assert_eq!(file_content_kind("C:/lyrics.lrc"), "text");
        assert_eq!(file_content_kind("C:/sub.srt"), "text");
        assert_eq!(file_content_kind("C:/sub.vtt"), "text");
        assert_eq!(file_content_kind("C:/sub.ass"), "text");
        // PDF is its own kind (drives the satellite PDF preview).
        assert_eq!(file_content_kind("C:/doc.pdf"), "pdf");
        assert_eq!(file_content_kind("C:/doc.PDF"), "pdf", "case-insensitive");
        // Audio / video / image unchanged.
        assert_eq!(file_content_kind("C:/song.mp3"), "audio");
        assert_eq!(file_content_kind("C:/movie.mkv"), "video");
        assert_eq!(file_content_kind("C:/pic.png"), "image");
        assert_eq!(file_content_kind("C:/arch.zip"), "other");
        assert_eq!(file_content_kind("C:/noext"), "other");
    }

    #[test]
    fn build_hdrop_buffer_has_header_and_wide_paths() {
        let buf = build_hdrop_buffer(&["C:\\a.txt".into(), "C:\\b.txt".into()]);
        // Header is a DROPFILES with fWide=TRUE (paths are UTF-16).
        let header = DROPFILES {
            pFiles: std::mem::size_of::<DROPFILES>() as u32,
            pt: POINT { x: 0, y: 0 },
            fNC: BOOL(0),
            fWide: BOOL(1),
        };
        let hdr = unsafe {
            std::slice::from_raw_parts(
                &header as *const DROPFILES as *const u8,
                std::mem::size_of::<DROPFILES>(),
            )
        };
        assert_eq!(&buf[..hdr.len()], hdr, "header must be a DROPFILES with fWide=TRUE");
        // Wide paths follow, each NUL-terminated; the list ends double-NUL.
        let text = String::from_utf16_lossy(&decode_wide(&buf[hdr.len()..]));
        assert!(text.starts_with("C:\\a.txt\0C:\\b.txt\0"), "paths verbatim, wide, NUL-terminated");
        assert!(text.ends_with('\0') && text.len() >= 2 && text.ends_with("\0\0"), "double-NUL list end");
    }

    fn decode_wide(bytes: &[u8]) -> Vec<u16> {
        bytes
            .as_chunks::<2>().0
            .iter()
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    }

    #[test]
    fn decoded_image_dimensions_are_bounded() {
        assert!(image_dimensions_within_limit(4000, 4000));
        assert!(!image_dimensions_within_limit(4000, 4001));
        assert!(!image_dimensions_within_limit(MAX_IMAGE_EDGE + 1, 1));
        assert!(!image_dimensions_within_limit(0, 1));
    }

    #[test]
    fn unicode_html_truncation_never_splits_a_code_point() {
        let mut html = "a".repeat(HTML_CAP - 1);
        html.push('中');
        html.push_str("tail");
        truncate_utf8_boundary(&mut html, HTML_CAP);
        assert!(html.len() <= HTML_CAP);
        assert!(html.is_char_boundary(html.len()));
        assert!(html.chars().all(|c| c != '�'));
    }

    #[test]
    fn captured_text_preserves_leading_and_trailing_whitespace() {
        let original = "  AUDIT-WS  ".to_string();
        assert_eq!(retained_clipboard_text(original.clone()).as_deref(), Some(original.as_str()));
        assert!(retained_clipboard_text(" \t\r\n ".into()).is_none());
    }

    #[test]
    fn self_write_sequence_skips_only_the_matching_sequence() {
        assert!(should_skip_sequence(41, 41, false));
        assert!(should_skip_sequence(42, 41, true));
        assert!(!should_skip_sequence(42, 41, false));
        assert!(!should_skip_sequence(0, 0, false));
    }

    #[test]
    fn process_display_name_strips_dir_and_extension() {
        assert_eq!(process_display_name(r"C:\Program Files\Google\Chrome\Application\chrome.exe"), "Chrome");
        assert_eq!(process_display_name(r"C:\Windows\explorer.exe"), "Explorer");
        assert_eq!(process_display_name(r"C:\Program Files\7-Zip\7zFM.exe"), "7zFM");
        assert_eq!(process_display_name(""), "");
        assert_eq!(normalize_clipboard_ignore_app("chrome.exe".into()).unwrap(), "Chrome");
        assert!(normalize_clipboard_ignore_app("   ".into()).is_err());
    }

    #[test]
    fn ignored_app_matches_running_program_by_display_name() {
        let programs = vec![crate::automation::WindowProgram {
            path: r"C:\Program Files\Google\Chrome\Application\chrome.exe".into(),
            name: "chrome.exe".into(),
            title: "Chrome".into(),
            windows: 1,
        }];
        assert_eq!(
            find_running_app_path("Chrome", &programs).as_deref(),
            Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        );
        assert_eq!(find_running_app_path("chrome.exe", &programs), find_running_app_path("Chrome", &programs));
        assert_eq!(find_running_app_path("Firefox", &programs), None);
    }

    #[test]
    fn migrate_adds_source_app_to_path_era_table() {
        // A pre-index table (docs/ROADMAP_HISTORY.md): has kind/path but no source_app. init_db
        // must add the column via ALTER and keep the rows.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE clipboard (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                kind       TEXT NOT NULL DEFAULT 'text',
                content    TEXT NOT NULL,
                data       BLOB,
                path       TEXT,
                pinned     INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            INSERT INTO clipboard(kind, content, data, path, pinned, created_at)
                VALUES ('image', 'Image', NULL, 'PictureCache/1.png', 0, 1000);",
        )
        .unwrap();
        init_db(&conn).unwrap();
        let base = temp_base("migrate-src");
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "image");
        assert_eq!(hits[0].source_app, "", "legacy rows default to an empty source app");
        fs::remove_dir_all(&base).ok();
    }

    // ── 失效判定 / 勾选子集 / 去重开关 (docs/ROADMAP_HISTORY.md): 失效判定 / 勾选子集 / 去重开关 ─────────────────────────

    #[test]
    fn file_row_valid_reflects_surviving_paths() {
        let conn = memory_db();
        let base = temp_base("valid");
        let f1 = base.join("a.txt");
        let f2 = base.join("b.txt");
        std::fs::write(&f1, "a").unwrap();
        std::fs::write(&f2, "b").unwrap();
        let p1 = f1.to_string_lossy().into_owned();
        let p2 = f2.to_string_lossy().into_owned();
        let missing = base.join("gone.txt").to_string_lossy().into_owned();
        insert_file_history(&conn, &[p1.clone(), p2.clone()], TEST_SRC, TEST_CAP, &base, true).unwrap();
        assert!(search_history(&conn, "", "all", 20, &base, false).unwrap()[0].valid, "all paths present → valid");
        insert_file_history(&conn, &[p1.clone(), missing.clone()], TEST_SRC, TEST_CAP, &base, true).unwrap();
        let rows = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert!(rows[0].valid, "a surviving path keeps the row usable");
        insert_file_history(&conn, std::slice::from_ref(&missing), TEST_SRC, TEST_CAP, &base, true).unwrap();
        assert!(!search_history(&conn, "", "all", 20, &base, false).unwrap()[0].valid, "no surviving path → row invalid");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn image_row_invalid_when_png_missing() {
        let conn = memory_db();
        let base = temp_base("img-valid");
        insert_image_history(&conn, &sample_png(), TEST_SRC, TEST_CAP, &base).unwrap();
        let id = search_history(&conn, "", "all", 20, &base, false).unwrap()[0].id;
        let row = get_row(&conn, id).unwrap().unwrap();
        assert!(!row_invalid(&row, &base), "present PNG → valid");
        std::fs::remove_file(base.join("PictureCache").join(format!("{id}.png"))).unwrap();
        assert!(row_invalid(&get_row(&conn, id).unwrap().unwrap(), &base), "missing PNG → invalid");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn effective_paths_respects_checked_and_existing() {
        let conn = memory_db();
        let base = temp_base("paths");
        let f1 = base.join("a.txt");
        let f2 = base.join("b.txt");
        std::fs::write(&f1, "a").unwrap();
        std::fs::write(&f2, "b").unwrap();
        let p1 = f1.to_string_lossy().into_owned();
        let p2 = f2.to_string_lossy().into_owned();
        let missing = base.join("gone.txt").to_string_lossy().into_owned();
        insert_file_history(&conn, &[p1.clone(), p2.clone(), missing.clone()], TEST_SRC, TEST_CAP, &base, true).unwrap();
        let id = search_history(&conn, "", "all", 20, &base, false).unwrap()[0].id;
        let row = get_row(&conn, id).unwrap().unwrap();
        // No override → every EXISTING file (missing excluded).
        assert_eq!(effective_file_paths(&row, true), vec![p1.clone(), p2.clone()]);
        // With an override (only the first file checked) → that subset.
        conn.execute(
            "UPDATE clipboard SET checked = ?1 WHERE id = ?2",
            params![Some("[0]".to_string()), id],
        )
        .unwrap();
        let row = get_row(&conn, id).unwrap().unwrap();
        assert_eq!(effective_file_paths(&row, true), vec![p1.clone()]);
        // 记住勾选 off → the override is ignored, all existing again.
        assert_eq!(effective_file_paths(&row, false), vec![p1.clone(), p2.clone()]);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn usable_paths_rejects_invalid_and_empty_checks() {
        let conn = memory_db();
        let base = temp_base("usable");
        // All-missing row → invalid.
        let missing = base.join("gone.txt").to_string_lossy().into_owned();
        insert_file_history(&conn, &[missing], TEST_SRC, TEST_CAP, &base, true).unwrap();
        let id = search_history(&conn, "", "all", 20, &base, false).unwrap()[0].id;
        assert_eq!(usable_paths(&get_row(&conn, id).unwrap().unwrap(), true, &base), Err("CLIP_INVALID".into()));
        // Two existing files, empty override (user unchecked everything) → nothing usable.
        let f1 = base.join("a.txt");
        let f2 = base.join("b.txt");
        std::fs::write(&f1, "a").unwrap();
        std::fs::write(&f2, "b").unwrap();
        insert_file_history(
            &conn,
            &[f1.to_string_lossy().into_owned(), f2.to_string_lossy().into_owned()],
            TEST_SRC,
            TEST_CAP,
            &base,
            true,
        )
        .unwrap();
        let id = search_history(&conn, "", "all", 20, &base, false).unwrap()[0].id;
        conn.execute(
            "UPDATE clipboard SET checked = ?1 WHERE id = ?2",
            params![Some("[]".to_string()), id],
        )
        .unwrap();
        assert_eq!(usable_paths(&get_row(&conn, id).unwrap().unwrap(), true, &base), Err("CLIP_NO_FILES".into()));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn dedup_off_records_duplicate_text_rows() {
        let conn = memory_db();
        // The 内容去重 off state drops the unique index (see set_dedup_index).
        conn.execute_batch("DROP INDEX IF EXISTS idx_clipboard_text_unique;").unwrap();
        let base = temp_base("dedup-off");
        insert_text_history(&conn, "same", TEST_SRC, None, TEST_CAP, &base, &no_merge(), false).unwrap();
        insert_text_history(&conn, "same", TEST_SRC, None, TEST_CAP, &base, &no_merge(), false).unwrap();
        let hits = search_history(&conn, "", "all", 20, &base, false).unwrap();
        assert_eq!(hits.len(), 2, "dedup off records an identical copy as a fresh row");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn enabling_dedup_collapses_existing_duplicates_and_keeps_pins() {
        let conn = memory_db();
        conn.execute_batch("DROP INDEX IF EXISTS idx_clipboard_text_unique;").unwrap();
        conn.execute_batch(
            "INSERT INTO clipboard(kind,content,data,path,pinned,created_at,source_app,html,merged_count)
             VALUES ('text','same',NULL,NULL,1,1,'',NULL,1),
                    ('text','same',NULL,NULL,0,2,'',NULL,1);",
        )
        .unwrap();
        set_dedup_index(&conn, true).unwrap();
        let rows = search_history(&conn, "same", "all", 20, Path::new("."), false).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].pinned);
        assert_eq!(rows[0].created_at, 2, "newest duplicate is retained");
    }

    #[test]
    fn dedup_toggle_gates_file_list_dedup() {
        let conn = memory_db();
        let base = temp_base("dedup-file");
        let paths = ["C:/a.txt".into(), "C:/b.txt".into()];
        insert_file_history(&conn, &paths, TEST_SRC, TEST_CAP, &base, true).unwrap();
        insert_file_history(&conn, &paths, TEST_SRC, TEST_CAP, &base, true).unwrap();
        assert_eq!(search_history(&conn, "", "all", 20, &base, false).unwrap().len(), 1, "dedup on collapses the identical list");
        insert_file_history(&conn, &paths, TEST_SRC, TEST_CAP, &base, false).unwrap();
        assert_eq!(search_history(&conn, "", "all", 20, &base, false).unwrap().len(), 2, "dedup off records the same list again");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn checked_state_survives_delete_and_undo() {
        let conn = memory_db();
        let base = temp_base("checked");
        let paths = ["C:/a.txt".into(), "C:/b.txt".into()];
        insert_file_history(&conn, &paths, TEST_SRC, TEST_CAP, &base, true).unwrap();
        let id = search_history(&conn, "", "all", 20, &base, false).unwrap()[0].id;
        conn.execute(
            "UPDATE clipboard SET checked = ?1 WHERE id = ?2",
            params![Some("[1]".to_string()), id],
        )
        .unwrap();
        let deleted = DeletedClip::from(&get_row(&conn, id).unwrap().unwrap());
        assert_eq!(deleted.checked.as_deref(), Some("[1]"), "DeletedClip carries checked");
        delete_row(&conn, id, &base).unwrap();
        restore_row(&conn, &deleted, &base, true).unwrap();
        let restored = get_row(&conn, search_history(&conn, "", "all", 20, &base, false).unwrap()[0].id)
            .unwrap()
            .unwrap();
        assert_eq!(restored.checked.as_deref(), Some("[1]"), "checked survives delete + undo");
        fs::remove_dir_all(&base).ok();
    }
}
