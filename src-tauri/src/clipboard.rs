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
//! Storage (ROADMAP #12): the DB stores only *references*, never the copied
//! data's original form. Text rows keep the text inline; image rows keep a
//! PNG file in `data/PictureCache/<id>.png` and store the relative path;
//! file rows (copied from Explorer, CF_HDROP) keep the newline-joined path
//! list verbatim. Schema is migrated in place from v0.2 (see [`migrate`]);
//! legacy image BLOBs are extracted to files by [`migrate_blobs_to_files`].
//! Text rows are deduplicated by content (partial unique index). Pinned items
//! sort to the top and are exempt from pruning.

use std::borrow::Cow;
use std::collections::HashSet;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use base64::Engine;
use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use windows::core::BOOL;
use windows::Win32::Foundation::{GlobalFree, HANDLE, HWND, POINT};
use windows::Win32::System::DataExchange::{
    CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::UI::Shell::{DragQueryFileW, DROPFILES, HDROP};
use windows::Win32::UI::WindowsAndMessaging::IsWindow;

/// Clipboard drop format (files/folders copied from Explorer).
const CF_HDROP: u32 = 15;

/// Maximum number of unpinned history rows kept in the database.
const HISTORY_CAP: i64 = 300;
/// Maximum results returned per search.
const SEARCH_LIMIT: i64 = 20;
/// How often the listener checks the clipboard sequence number.
const POLL_INTERVAL: Duration = Duration::from_millis(250);
/// Display label stored for image rows.
const IMAGE_LABEL: &str = "Image";
/// Subfolder under the data dir holding image PNGs.
const PICTURE_CACHE: &str = "PictureCache";
/// Longest edge of the thumbnail sent to the frontend (pixels).
const THUMB_MAX: u32 = 200;

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
}

/// A row as stored in SQLite.
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
}

/// Shared clipboard state, managed by Tauri.
pub struct ClipboardState {
    pub db: Mutex<Connection>,
    /// Last seen clipboard sequence number.
    pub last_seq: AtomicU32,
    /// Last captured text, used to skip our own `copy_clipboard` writes.
    pub last_text: Mutex<String>,
    /// Last captured file-list (newline-joined), to skip our own copies.
    pub last_files: Mutex<String>,
    /// Hash of the last captured image (PNG bytes), to skip our own copies.
    pub last_image_hash: Mutex<u64>,
}

/// Absolute picture-cache dir for the app (`<data_dir>/PictureCache`).
fn picture_dir() -> PathBuf {
    crate::paths::data_dir().join(PICTURE_CACHE)
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
            path       TEXT,
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

/// Column names of the `clipboard` table.
fn table_cols(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("PRAGMA table_info(clipboard)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    rows.collect()
}

/// Upgrade an old table to the current schema by renaming, recreating and
/// copying rows. Text rows keep their identity, so no history is lost. A v0.2
/// table (no `kind`/`data`/`pinned`) is rebuilt once; any table lacking the
/// `path` column (introduced in ROADMAP #12) gets it via `ALTER TABLE`.
fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let cols = table_cols(conn)?;
    if !cols.iter().any(|c| c == "kind") {
        conn.execute_batch(
            "BEGIN;
            ALTER TABLE clipboard RENAME TO clipboard_old;
            CREATE TABLE clipboard (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                kind       TEXT NOT NULL DEFAULT 'text',
                content    TEXT NOT NULL,
                data       BLOB,
                path       TEXT,
                pinned     INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            INSERT INTO clipboard(kind, content, data, path, pinned, created_at)
                SELECT 'text', content, NULL, NULL, 0, created_at FROM clipboard_old;
            DROP TABLE clipboard_old;
            COMMIT;",
        )?;
    }
    let cols = table_cols(conn)?;
    if !cols.iter().any(|c| c == "path") {
        conn.execute("ALTER TABLE clipboard ADD COLUMN path TEXT", [])?;
    }
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

/// Upsert a text row: bump recency if it exists (pin flag is preserved), else
/// insert. The partial unique index makes a plain `ON CONFLICT` unreliable,
/// so this is an explicit update-then-insert. Prunes afterwards.
fn insert_text_history(conn: &Connection, text: &str, base: &Path) -> rusqlite::Result<()> {
    let created_at = next_created_at(conn)?;
    conn.execute(
        "UPDATE clipboard SET created_at = ?1 WHERE kind = 'text' AND content = ?2",
        params![created_at, text],
    )?;
    if conn.changes() == 0 {
        conn.execute(
            "INSERT INTO clipboard(kind, content, data, path, pinned, created_at)
             VALUES ('text', ?1, NULL, NULL, 0, ?2)",
            params![text, created_at],
        )?;
    }
    prune(conn, HISTORY_CAP, base)
}

/// Insert an image row: write the PNG into `<base>/PictureCache/<id>.png` and
/// store the relative path. The DB never holds the image bytes themselves.
fn insert_image_history(conn: &Connection, png: &[u8], base: &Path) -> rusqlite::Result<()> {
    let created_at = next_created_at(conn)?;
    conn.execute(
        "INSERT INTO clipboard(kind, content, data, path, pinned, created_at)
         VALUES ('image', ?1, NULL, NULL, 0, ?2)",
        params![IMAGE_LABEL, created_at],
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
    prune(conn, HISTORY_CAP, base)
}

/// Record a file/folder copy (a CF_HDROP path list) as one history row. The
/// whole list is stored verbatim, newline-joined (Windows names can't contain
/// `\n`); the files themselves are never read or copied.
fn insert_file_history(conn: &Connection, paths: &[String], base: &Path) -> rusqlite::Result<()> {
    let content = paths.join("\n");
    let created_at = next_created_at(conn)?;
    conn.execute(
        "UPDATE clipboard SET created_at = ?1 WHERE kind = 'file' AND content = ?2",
        params![created_at, content],
    )?;
    if conn.changes() == 0 {
        conn.execute(
            "INSERT INTO clipboard(kind, content, data, path, pinned, created_at)
             VALUES ('file', ?1, NULL, NULL, 0, ?2)",
            params![content, created_at],
        )?;
    }
    prune(conn, HISTORY_CAP, base)
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

/// Substring search over history, pinned first then most recent. An empty
/// query returns the most recent `limit` entries. SQLite `LIKE` is ASCII
/// case-insensitive.
fn search_history(
    conn: &Connection,
    query: &str,
    limit: i64,
    base: &Path,
) -> rusqlite::Result<Vec<ClipboardItem>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, content, data, path, pinned, created_at FROM clipboard
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
                path: row.get(4)?,
                pinned: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().map(|r| row_to_item(r, base)).collect())
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
        "SELECT id, kind, content, data, path, pinned, created_at FROM clipboard WHERE id = ?1",
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
        })
    })?;
    rows.next().transpose()
}

/// Delete a row and, for image entries, its picture-cache file.
fn delete_row(conn: &Connection, id: u32, base: &Path) -> rusqlite::Result<()> {
    if let Ok(Some(row)) = get_row(conn, id) {
        if row.kind == "image" {
            if let Some(p) = row.path {
                let _ = fs::remove_file(base.join(p));
            }
        }
    }
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

/// Delete every history row and empty the picture cache.
fn clear_history(conn: &Connection, base: &Path) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM clipboard", [])?;
    let dir = base.join(PICTURE_CACHE);
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let _ = fs::remove_file(entry.path());
        }
    }
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

/// Capture whatever changed on the clipboard. Precedence: text, then a
/// file/folder list (CF_HDROP), then a bitmap image. The arboard handle is
/// scoped per operation so it never holds the clipboard open while the
/// CF_HDROP check opens it itself.
fn capture(state: &ClipboardState) {
    // 1. Text.
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if let Ok(text) = cb.get_text() {
            let text = text.trim().to_string();
            if !text.is_empty() {
                let mut last_text = state.last_text.lock().unwrap();
                if text != *last_text {
                    let conn = state.db.lock().unwrap();
                    if insert_text_history(&conn, &text, &crate::paths::data_dir()).is_err() {
                        eprintln!("[clipboard] failed to store text history");
                    }
                    *last_text = text;
                }
            }
            return;
        }
        // cb drops here, releasing the clipboard before the file check.
    }
    // 2. File/folder list (copied from Explorer) — stored verbatim, never
    // read or copied. A copied *image file* lands here, not in the bitmap
    // branch, which matches the intended text|file|image split.
    if let Some(paths) = read_file_list() {
        let joined = paths.join("\n");
        let mut last_files = state.last_files.lock().unwrap();
        if joined != *last_files {
            let base = crate::paths::data_dir();
            let conn = state.db.lock().unwrap();
            if insert_file_history(&conn, &paths, &base).is_err() {
                eprintln!("[clipboard] failed to store file history");
            }
            *last_files = joined;
        }
        return;
    }
    // 3. Bitmap image (screenshot / copied from a web page).
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if let Ok(img) = cb.get_image() {
            if let Some(png) = encode_png(&img) {
                let hash = hash_bytes(&png);
                let mut last_hash = state.last_image_hash.lock().unwrap();
                if hash != *last_hash {
                    let base = crate::paths::data_dir();
                    let conn = state.db.lock().unwrap();
                    if insert_image_history(&conn, &png, &base).is_err() {
                        eprintln!("[clipboard] failed to store image history");
                    }
                    *last_hash = hash;
                }
            }
        }
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
        let paths = read_hdrop();
        let _ = CloseClipboard();
        paths
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
        last_files: Mutex::new(String::new()),
        last_image_hash: Mutex::new(0),
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

/// Search clipboard history. Empty query returns the most recent entries.
#[tauri::command]
pub fn search_clipboard(query: String, state: State<ClipboardState>) -> Result<Vec<ClipboardItem>, String> {
    let conn = state.db.lock().unwrap();
    search_history(&conn, query.trim(), SEARCH_LIMIT, &crate::paths::data_dir()).map_err(|e| e.to_string())
}

/// Write the entry `id` back to the system clipboard (text or image).
#[tauri::command]
pub fn copy_clipboard(id: u32, state: State<ClipboardState>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    let row = get_row(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("clipboard item {id} not found"))?;
    set_clipboard_from_row(&row)
}

/// Write the entry `id` to the clipboard and paste it (Ctrl+V via SendInput)
/// into the window that had focus before the launcher appeared. If no target
/// window is recorded or the window is gone, falls back to a plain clipboard
/// copy. The original clipboard content is saved and restored after the paste
/// so the user's clipboard is never polluted.
#[tauri::command]
pub fn paste_clipboard(
    id: u32,
    state: State<ClipboardState>,
    focus: State<crate::window::FocusState>,
    app: AppHandle,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    let row = get_row(&conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("clipboard item {id} not found"))?;
    drop(conn);

    // Take ownership of the stored HWND (one-shot).
    let maybe_hwnd = focus.last_hwnd.lock().unwrap().take();

    let Some(hwnd_raw) = maybe_hwnd else {
        // No target window recorded — fall back to a plain copy.
        return set_clipboard_from_row(&row);
    };

    if !unsafe { IsWindow(Some(HWND(hwnd_raw as *mut std::ffi::c_void))) }.as_bool() {
        // Window is gone — fall back to a plain copy.
        return set_clipboard_from_row(&row);
    }

    // Save the current clipboard so we can restore it after the paste.
    let saved = save_current_clipboard();

    // Place the entry on the system clipboard.
    set_clipboard_from_row(&row)?;

    // Hide the launcher so focus can return to the target window.
    let _ = crate::window::hide_launcher(app);
    // Allow time for Windows to restore focus to the previous foreground window.
    std::thread::sleep(Duration::from_millis(60));

    // Send Ctrl+V to whatever window now has focus.
    unsafe { send_ctrl_v() };

    // Give the target application time to process the paste.
    std::thread::sleep(Duration::from_millis(100));

    // Restore whatever was on the clipboard before our paste.
    restore_saved_clipboard(saved);

    Ok(())
}

/// Save whatever is currently on the system clipboard (text, file list or
/// image) so it can be restored after an auto-paste.
enum SavedClipboard {
    Empty,
    Text(String),
    Files(Vec<String>),
    Image(arboard::ImageData<'static>),
}

fn save_current_clipboard() -> SavedClipboard {
    // Text wins; then a file list; then an image. Each arboard handle is
    // scoped so the clipboard is released before the CF_HDROP check.
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if let Ok(text) = cb.get_text() {
            return SavedClipboard::Text(text);
        }
    }
    if let Some(files) = read_file_list() {
        return SavedClipboard::Files(files);
    }
    if let Ok(mut cb) = arboard::Clipboard::new() {
        if let Ok(img) = cb.get_image() {
            // Convert to owned data.
            let owned = arboard::ImageData {
                width: img.width,
                height: img.height,
                bytes: Cow::Owned(img.bytes.to_vec()),
            };
            return SavedClipboard::Image(owned);
        }
    }
    SavedClipboard::Empty
}

fn restore_saved_clipboard(saved: SavedClipboard) {
    match saved {
        SavedClipboard::Empty => {}
        SavedClipboard::Text(s) => {
            if let Ok(mut cb) = arboard::Clipboard::new() {
                let _ = cb.set_text(s);
            }
        }
        SavedClipboard::Files(files) => {
            let _ = set_files_to_clipboard(&files);
        }
        SavedClipboard::Image(img) => {
            if let Ok(mut cb) = arboard::Clipboard::new() {
                let _ = cb.set_image(img);
            }
        }
    }
}

/// Place a history row onto the system clipboard: text inline, image read
/// back from its picture-cache file, file rows re-assembled as a CF_HDROP
/// path list.
fn set_clipboard_from_row(row: &Row) -> Result<(), String> {
    match row.kind.as_str() {
        "image" => {
            let Some(rel) = row.path.as_deref() else {
                return Err("image item has no file".into());
            };
            let png = fs::read(picture_dir().join(rel)).map_err(|e| e.to_string())?;
            let rgba = image::load_from_memory(&png)
                .map_err(|e| e.to_string())?
                .to_rgba8();
            let img = arboard::ImageData {
                width: rgba.width() as usize,
                height: rgba.height() as usize,
                bytes: Cow::Owned(rgba.into_raw()),
            };
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            cb.set_image(img).map_err(|e| e.to_string())
        }
        "file" => {
            let paths: Vec<String> = row.content.lines().map(str::to_owned).collect();
            set_files_to_clipboard(&paths)
        }
        _ => {
            let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
            cb.set_text(&row.content).map_err(|e| e.to_string())
        }
    }
}

/// Build the byte layout of a CF_HDROP clipboard block: a `DROPFILES` header
/// followed by the UTF-16 paths (each NUL-terminated, the whole list double
/// NUL-terminated). Pure — shared by [`set_files_to_clipboard`] and tests.
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

/// Put a file path list back on the system clipboard as CF_HDROP.
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
/// foreground application receives a paste command.
unsafe fn send_ctrl_v() {
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

    let _ = SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
}

/// Delete a single history entry.
#[tauri::command]
pub fn delete_clipboard(id: u32, state: State<ClipboardState>) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    delete_row(&conn, id, &crate::paths::data_dir()).map_err(|e| e.to_string())
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
    clear_history(&conn, &crate::paths::data_dir()).map_err(|e| e.to_string())
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
        let hits = search_history(&conn, "", 20, &base).unwrap();
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
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn insert_and_substring_search() {
        let conn = memory_db();
        let base = temp_base("sub");
        insert_text_history(&conn, "hello world", &base).unwrap();
        insert_text_history(&conn, "hello lume", &base).unwrap();
        let hits = search_history(&conn, "hello", 20, &base).unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits[0].created_at >= hits[1].created_at);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn empty_query_returns_most_recent_first() {
        let conn = memory_db();
        let base = temp_base("empty");
        insert_text_history(&conn, "first", &base).unwrap();
        insert_text_history(&conn, "second", &base).unwrap();
        let hits = search_history(&conn, "", 20, &base).unwrap();
        assert_eq!(hits[0].content, "second");
        assert_eq!(hits[1].content, "first");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn duplicate_text_bumps_recency_without_duplicating() {
        let conn = memory_db();
        let base = temp_base("dedup");
        insert_text_history(&conn, "alpha", &base).unwrap();
        insert_text_history(&conn, "beta", &base).unwrap();
        insert_text_history(&conn, "alpha", &base).unwrap(); // re-copied → moves to top
        let hits = search_history(&conn, "", 20, &base).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "alpha");
        assert_eq!(hits[1].content, "beta");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn prune_keeps_newest() {
        let conn = memory_db();
        let base = temp_base("prune");
        insert_text_history(&conn, "a", &base).unwrap();
        insert_text_history(&conn, "b", &base).unwrap();
        insert_text_history(&conn, "c", &base).unwrap();
        prune(&conn, 2, &base).unwrap();
        let hits = search_history(&conn, "", 20, &base).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].content, "c");
        assert_eq!(hits[1].content, "b");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn search_is_case_insensitive() {
        let conn = memory_db();
        let base = temp_base("case");
        insert_text_history(&conn, "Visual Studio", &base).unwrap();
        assert_eq!(search_history(&conn, "visual", 20, &base).unwrap().len(), 1);
        assert_eq!(search_history(&conn, "STUDIO", 20, &base).unwrap().len(), 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn history_cap_limits_rows() {
        let conn = memory_db();
        let base = temp_base("cap");
        for i in 0..(HISTORY_CAP as usize + 10) {
            insert_text_history(&conn, &format!("entry {i}"), &base).unwrap();
        }
        let hits = search_history(&conn, "", 10_000, &base).unwrap();
        assert_eq!(hits.len(), HISTORY_CAP as usize);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn pinned_sorts_first_and_survives_prune() {
        let conn = memory_db();
        let base = temp_base("pinned");
        insert_text_history(&conn, "unpinned-a", &base).unwrap();
        insert_text_history(&conn, "pinned-b", &base).unwrap();
        set_pinned(&conn, search_history(&conn, "pinned-b", 1, &base).unwrap()[0].id, true).unwrap();
        insert_text_history(&conn, "unpinned-c", &base).unwrap();
        let hits = search_history(&conn, "", 20, &base).unwrap();
        assert_eq!(hits[0].content, "pinned-b", "pinned item must sort first");
        prune(&conn, 1, &base).unwrap();
        let hits = search_history(&conn, "", 20, &base).unwrap();
        assert_eq!(hits.len(), 2, "pinned + newest unpinned");
        assert!(hits.iter().any(|h| h.pinned));
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn image_writes_file_and_stores_path() {
        let conn = memory_db();
        let base = temp_base("img");
        let png = sample_png();
        insert_image_history(&conn, &png, &base).unwrap();
        let hits = search_history(&conn, "", 20, &base).unwrap();
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
        assert_eq!(search_history(&conn, "image", 20, &base).unwrap().len(), 1);
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn copy_image_round_trip_reads_file() {
        let conn = memory_db();
        let base = temp_base("roundtrip");
        let png = sample_png();
        insert_image_history(&conn, &png, &base).unwrap();
        let row = get_row(&conn, search_history(&conn, "", 1, &base).unwrap()[0].id)
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
        insert_file_history(&conn, &["C:/a.txt".into(), "C:/b.txt".into()], &base).unwrap();
        // Re-copying the same list bumps recency instead of duplicating.
        insert_file_history(&conn, &["C:/a.txt".into(), "C:/b.txt".into()], &base).unwrap();
        insert_file_history(&conn, &["C:/c.txt".into()], &base).unwrap();
        let hits = search_history(&conn, "", 20, &base).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].kind, "file");
        assert_eq!(hits[0].content, "C:/c.txt");
        // Searchable by a contained path fragment.
        assert_eq!(search_history(&conn, "a.txt", 20, &base).unwrap().len(), 1);
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
    fn delete_removes_row_and_its_image_file() {
        let conn = memory_db();
        let base = temp_base("del");
        insert_image_history(&conn, &sample_png(), &base).unwrap();
        let id = search_history(&conn, "", 20, &base).unwrap()[0].id;
        let file = base.join(format!("PictureCache/{id}.png"));
        assert!(file.exists());
        delete_row(&conn, id, &base).unwrap();
        assert_eq!(search_history(&conn, "", 20, &base).unwrap().len(), 0);
        assert!(!file.exists(), "picture file must be deleted with the row");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn clear_empties_table_and_picture_cache() {
        let conn = memory_db();
        let base = temp_base("clear");
        insert_text_history(&conn, "a", &base).unwrap();
        insert_image_history(&conn, &sample_png(), &base).unwrap();
        clear_history(&conn, &base).unwrap();
        assert_eq!(search_history(&conn, "", 20, &base).unwrap().len(), 0);
        assert_eq!(fs::read_dir(base.join("PictureCache")).unwrap().count(), 0);
        fs::remove_dir_all(&base).ok();
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
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect()
    }
}
