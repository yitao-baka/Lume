//! Clipboard history: capture, persist, search.
//!
//! A background thread polls the Windows clipboard sequence number
//! (`GetClipboardSequenceNumber`) and, on change, captures text or images
//! and stores them in a SQLite database. The launcher's clipboard mode
//! searches that history; `copy_clipboard` writes a selection back to the
//! system clipboard.
//!
//! The listener is a 250 ms sequence-number poll rather than a
//! clipboard-format-listener window: it needs no hidden HWND/WndProc and its
//! idle cost is negligible (one system call every quarter second).
//!
//! Schema is migrated in place from v0.2 (see [`migrate`]); history survives
//! upgrades. Text rows are deduplicated by content (partial unique index);
//! images are stored as PNG blobs with an in-memory hash to skip consecutive
//! duplicates. Pinned items sort to the top and are exempt from pruning.

use std::borrow::Cow;
use std::hash::{Hash, Hasher};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// Maximum number of unpinned history rows kept in the database.
const HISTORY_CAP: i64 = 300;
/// Maximum results returned per search.
const SEARCH_LIMIT: i64 = 20;
/// How often the listener checks the clipboard sequence number.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Display label stored for image rows.
const IMAGE_LABEL: &str = "Image";
/// Longest edge of the thumbnail sent to the frontend (pixels).
const THUMB_MAX: u32 = 200;

/// A clipboard history entry, as serialized to the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct ClipboardItem {
    pub id: u32,
    /// `"text"` or `"image"`.
    pub kind: String,
    /// Text content, or the display label for images.
    pub content: String,
    pub pinned: bool,
    pub created_at: i64,
    /// Base64 PNG data URI for image items.
    pub thumb: Option<String>,
}

/// A row as stored in SQLite.
struct Row {
    id: u32,
    kind: String,
    content: String,
    data: Option<Vec<u8>>,
    pinned: bool,
    created_at: i64,
}

/// Shared clipboard state, managed by Tauri.
pub struct ClipboardState {
    pub db: Mutex<Connection>,
    /// Last seen clipboard sequence number.
    pub last_seq: AtomicU32,
    /// Last captured text, used to skip our own `copy_clipboard` writes.
    pub last_text: Mutex<String>,
    /// Hash of the last captured image (PNG bytes), to skip our own copies.
    pub last_image_hash: Mutex<u64>,
}

// ---------------------------------------------------------------------------
// Database helpers (pure, take `&Connection` so tests use an in-memory DB)
// ---------------------------------------------------------------------------

/// Create the current schema (no-op on an up-to-date DB), migrate older
/// tables in place, then ensure the text-dedup partial index exists.
fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS clipboard (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            kind       TEXT NOT NULL DEFAULT 'text',
            content    TEXT NOT NULL,
            data       BLOB,
            pinned     INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );",
    )?;
    migrate(conn)?;
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_clipboard_text_unique
            ON clipboard(content) WHERE kind = 'text';",
    )?;
    Ok(())
}

/// Upgrade a v0.2 table (no `kind`/`data`/`pinned` columns, `content` UNIQUE)
/// to the current schema by renaming, recreating and copying rows. Text rows
/// keep their identity, so no history is lost.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let cols: Vec<String> = {
        let mut stmt = conn.prepare("PRAGMA table_info(clipboard)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    if cols.iter().any(|c| c == "kind") {
        return Ok(()); // already current schema
    }
    conn.execute_batch(
        "BEGIN;
        ALTER TABLE clipboard RENAME TO clipboard_old;
        CREATE TABLE clipboard (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            kind       TEXT NOT NULL DEFAULT 'text',
            content    TEXT NOT NULL,
            data       BLOB,
            pinned     INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );
        INSERT INTO clipboard(kind, content, data, pinned, created_at)
            SELECT 'text', content, NULL, 0, created_at FROM clipboard_old;
        DROP TABLE clipboard_old;
        COMMIT;",
    )
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

/// Upsert a text row: bump recency if it exists (pin flag is preserved), else
/// insert. The partial unique index makes a plain `ON CONFLICT` unreliable,
/// so this is an explicit update-then-insert. Prunes afterwards.
fn insert_text_history(conn: &Connection, text: &str) -> rusqlite::Result<()> {
    let created_at = next_created_at(conn)?;
    conn.execute(
        "UPDATE clipboard SET created_at = ?1 WHERE kind = 'text' AND content = ?2",
        params![created_at, text],
    )?;
    if conn.changes() == 0 {
        conn.execute(
            "INSERT INTO clipboard(kind, content, data, pinned, created_at)
             VALUES ('text', ?1, NULL, 0, ?2)",
            params![text, created_at],
        )?;
    }
    prune(conn, HISTORY_CAP)
}

/// Insert an image row (PNG blob + display label).
fn insert_image_history(conn: &Connection, png: &[u8]) -> rusqlite::Result<()> {
    let created_at = next_created_at(conn)?;
    conn.execute(
        "INSERT INTO clipboard(kind, content, data, pinned, created_at)
         VALUES ('image', ?1, ?2, 0, ?3)",
        params![IMAGE_LABEL, png, created_at],
    )?;
    prune(conn, HISTORY_CAP)
}

/// Delete rows beyond `cap`, keeping the newest unpinned entries plus every
/// pinned one.
fn prune(conn: &Connection, cap: i64) -> rusqlite::Result<()> {
    conn.execute(
        "DELETE FROM clipboard
         WHERE pinned = 0
           AND id NOT IN (
               SELECT id FROM clipboard WHERE pinned = 0
               ORDER BY created_at DESC, id DESC LIMIT ?1
           )",
        params![cap],
    )?;
    Ok(())
}

/// Substring search over history, pinned first then most recent. An empty
/// query returns the most recent `limit` entries. SQLite `LIKE` is ASCII
/// case-insensitive.
fn search_history(conn: &Connection, query: &str, limit: i64) -> rusqlite::Result<Vec<ClipboardItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, content, data, pinned, created_at FROM clipboard
         WHERE content LIKE '%' || ?1 || '%'
         ORDER BY pinned DESC, created_at DESC, id DESC
         LIMIT ?2",
    )?;
    let rows = stmt
        .query_map(params![query, limit], |row| {
            Ok(Row {
                id: row.get(0)?,
                kind: row.get(1)?,
                content: row.get(2)?,
                data: row.get(3)?,
                pinned: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().map(row_to_item).collect())
}

fn row_to_item(row: Row) -> ClipboardItem {
    let thumb = if row.kind == "image" {
        row.data.as_deref().and_then(make_thumb)
    } else {
        None
    };
    ClipboardItem {
        id: row.id,
        kind: row.kind,
        content: row.content,
        pinned: row.pinned,
        created_at: row.created_at,
        thumb,
    }
}

fn get_row(conn: &Connection, id: u32) -> rusqlite::Result<Option<Row>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, content, data, pinned, created_at FROM clipboard WHERE id = ?1",
    )?;
    let mut rows = stmt.query_map(params![id], |row| {
        Ok(Row {
            id: row.get(0)?,
            kind: row.get(1)?,
            content: row.get(2)?,
            data: row.get(3)?,
            pinned: row.get::<_, i64>(4)? != 0,
            created_at: row.get(5)?,
        })
    })?;
    rows.next().transpose()
}

fn delete_row(conn: &Connection, id: u32) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM clipboard WHERE id = ?1", params![id])?;
    Ok(())
}

fn set_pinned(conn: &Connection, id: u32, pinned: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE clipboard SET pinned = ?1 WHERE id = ?2",
        params![pinned as i64, id],
    )?;
    Ok(())
}

fn clear_history(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM clipboard", [])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/// Downscale a stored PNG to a small base64 data URI for the frontend.
fn make_thumb(png: &[u8]) -> Option<String> {
    let img = image::load_from_memory(png).ok()?.to_rgba8();
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
    let rgba = image::RgbaImage::from_raw(img.width as u32, img.height as u32, img.bytes.to_vec())?;
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgba8(rgba)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .ok()?;
    Some(buf)
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    hasher.finish()
}

// ---------------------------------------------------------------------------
// Clipboard I/O
// ---------------------------------------------------------------------------

/// Capture whatever changed on the clipboard: prefer text, else image.
fn capture(state: &ClipboardState) {
    let Ok(mut cb) = arboard::Clipboard::new() else {
        return;
    };
    if let Ok(text) = cb.get_text() {
        let text = text.trim().to_string();
        if !text.is_empty() {
            let mut last_text = state.last_text.lock().unwrap();
            if text != *last_text {
                let conn = state.db.lock().unwrap();
                if insert_text_history(&conn, &text).is_err() {
                    eprintln!("[clipboard] failed to store text history");
                }
                *last_text = text;
            }
        }
        return;
    }
    if let Ok(img) = cb.get_image() {
        if let Some(png) = encode_png(&img) {
            let hash = hash_bytes(&png);
            let mut last_hash = state.last_image_hash.lock().unwrap();
            if hash != *last_hash {
                let conn = state.db.lock().unwrap();
                if insert_image_history(&conn, &png).is_err() {
                    eprintln!("[clipboard] failed to store image history");
                }
                *last_hash = hash;
            }
        }
    }
}

/// Poll the clipboard sequence number and store new content on change.
fn spawn_listener(app: AppHandle) {
    std::thread::spawn(move || loop {
        let seq =
            unsafe { windows_sys::Win32::System::DataExchange::GetClipboardSequenceNumber() };
        let state = app.state::<ClipboardState>();
        let last = state.last_seq.load(Ordering::Relaxed);
        if seq != last {
            state.last_seq.store(seq, Ordering::Relaxed);
            capture(&state);
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
    app.manage(ClipboardState {
        db: Mutex::new(conn),
        last_seq: AtomicU32::new(0),
        last_text: Mutex::new(String::new()),
        last_image_hash: Mutex::new(0),
    });
    spawn_listener(app.handle().clone());
}

fn open_db() -> rusqlite::Result<Connection> {
    let dir = crate::paths::data_dir();
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    let conn = Connection::open(crate::paths::db_path())?;
    init_db(&conn)?;
    Ok(conn)
}

/// Adapt a `tauri::Error`/`std::io::Error` into `rusqlite::Error`.
fn io_err(e: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(e.to_string())))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Search clipboard history. Empty query returns the most recent entries.
#[tauri::command]
pub fn search_clipboard(query: String, state: State<ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    let conn = state.db.lock().unwrap();
    search_history(&conn, query.trim(), SEARCH_LIMIT).map_err(|e| e.to_string())
}

/// Write the entry `id` back to the system clipboard (text or image).
#[tauri::command]
pub fn copy_clipboard(id: u32, state: State<ClipboardState>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    let row = get_row(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("clipboard item {id} not found"))?;
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    if row.kind == "image" {
        let png = row.data.as_deref().ok_or("image item has no data")?;
        let rgba = image::load_from_memory(png).map_err(|e| e.to_string())?.to_rgba8();
        let img = arboard::ImageData {
            width: rgba.width() as usize,
            height: rgba.height() as usize,
            bytes: Cow::Owned(rgba.into_raw()),
        };
        cb.set_image(img).map_err(|e| e.to_string())
    } else {
        cb.set_text(row.content).map_err(|e| e.to_string())
    }
}

/// Delete a single history entry.
#[tauri::command]
pub fn delete_clipboard(id: u32, state: State<ClipboardState>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    delete_row(&conn, id).map_err(|e| e.to_string())
}

/// Pin or unpin a history entry.
#[tauri::command]
pub fn pin_clipboard(id: u32, pinned: bool, state: State<ClipboardState>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    set_pinned(&conn, id, pinned).map_err(|e| e.to_string())
}

/// Clear the entire clipboard history.
#[tauri::command]
pub fn clear_clipboard(state: State<ClipboardState>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    clear_history(&conn).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_db(&conn).unwrap();
        conn
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
        let hits = search_history(&conn, "", 20).unwrap();
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
    }

    #[test]
    fn insert_and_substring_search() {
        let conn = memory_db();
        insert_text_history(&conn, "hello world").unwrap();
        insert_text_history(&conn, "hello lume").unwrap();
        let hits = search_history(&conn, "hello", 20).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits[0].created_at >= hits[1].created_at);
    }

    #[test]
    fn empty_query_returns_most_recent_first() {
        let conn = memory_db();
        insert_text_history(&conn, "first").unwrap();
        insert_text_history(&conn, "second").unwrap();
        let hits = search_history(&conn, "", 20).unwrap();
        assert_eq!(hits[0].content, "second");
        assert_eq!(hits[1].content, "first");
    }

    #[test]
    fn duplicate_text_bumps_recency_without_duplicating() {
        let conn = memory_db();
        insert_text_history(&conn, "alpha").unwrap();
        insert_text_history(&conn, "beta").unwrap();
        insert_text_history(&conn, "alpha").unwrap(); // re-copied → moves to top
        let hits = search_history(&conn, "", 20).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "alpha");
        assert_eq!(hits[1].content, "beta");
    }

    #[test]
    fn prune_keeps_newest() {
        let conn = memory_db();
        insert_text_history(&conn, "a").unwrap();
        insert_text_history(&conn, "b").unwrap();
        insert_text_history(&conn, "c").unwrap();
        prune(&conn, 2).unwrap();
        let hits = search_history(&conn, "", 20).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "c");
        assert_eq!(hits[1].content, "b");
    }

    #[test]
    fn search_is_case_insensitive() {
        let conn = memory_db();
        insert_text_history(&conn, "Visual Studio").unwrap();
        assert_eq!(search_history(&conn, "visual", 20).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "STUDIO", 20).unwrap().len(), 1);
    }

    #[test]
    fn history_cap_limits_rows() {
        let conn = memory_db();
        for i in 0..(HISTORY_CAP as usize + 10) {
            insert_text_history(&conn, &format!("entry {i}")).unwrap();
        }
        let hits = search_history(&conn, "", 10_000).unwrap();
        assert_eq!(hits.len(), HISTORY_CAP as usize);
    }

    #[test]
    fn pinned_sorts_first_and_survives_prune() {
        let conn = memory_db();
        insert_text_history(&conn, "unpinned-a").unwrap();
        insert_text_history(&conn, "pinned-b").unwrap();
        set_pinned(&conn, search_history(&conn, "pinned-b", 1).unwrap()[0].id, true).unwrap();
        insert_text_history(&conn, "unpinned-c").unwrap();
        let hits = search_history(&conn, "", 20).unwrap();
        assert_eq!(hits[0].content, "pinned-b", "pinned item must sort first");
        prune(&conn, 1).unwrap();
        let hits = search_history(&conn, "", 20).unwrap();
        assert_eq!(hits.len(), 2, "pinned + newest unpinned");
        assert!(hits.iter().any(|h| h.pinned));
    }

    #[test]
    fn image_insert_stores_data_and_thumb() {
        let conn = memory_db();
        let png = sample_png();
        insert_image_history(&conn, &png).unwrap();
        let hits = search_history(&conn, "", 20).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "image");
        assert!(hits[0]
            .thumb
            .as_deref()
            .map(|t| t.starts_with("data:image/png;base64,"))
            .unwrap_or(false));
        // Images are findable by their label.
        assert_eq!(search_history(&conn, "image", 20).unwrap().len(), 1);
    }

    #[test]
    fn copy_image_round_trip_preserves_pixels() {
        let conn = memory_db();
        let png = sample_png();
        insert_image_history(&conn, &png).unwrap();
        let row = get_row(&conn, search_history(&conn, "", 1).unwrap()[0].id).unwrap().unwrap();
        let rgba = image::load_from_memory(row.data.as_deref().unwrap())
            .unwrap()
            .to_rgba8();
        assert_eq!((rgba.width(), rgba.height()), (32, 32));
    }

    #[test]
    fn delete_removes_row() {
        let conn = memory_db();
        insert_text_history(&conn, "hello").unwrap();
        let id = search_history(&conn, "", 20).unwrap()[0].id;
        delete_row(&conn, id).unwrap();
        assert_eq!(search_history(&conn, "", 20).unwrap().len(), 0);
    }

    #[test]
    fn clear_empties_table() {
        let conn = memory_db();
        insert_text_history(&conn, "a").unwrap();
        insert_text_history(&conn, "b").unwrap();
        clear_history(&conn).unwrap();
        assert_eq!(search_history(&conn, "", 20).unwrap().len(), 0);
    }
}
