//! Index-cache persistence (docs/SETTINGS.md 索引目录).
//!
//! Three SQLite DBs live under `data/`:
//! - `system32_cache.db` — System32's openable executables, built once (the
//!   folder is static) and loaded into memory.
//! - `user_cache.db` — Desktop + user-dir files, refreshed at startup and then
//!   hourly (differential: only changed paths are written).
//! - `icons.db` — deduplicated icon PNGs keyed by content hash, shared by both
//!   caches (many executables share the default icon, so it is stored once).
//!
//! Icons are extracted lazily on first display (icons.rs) and stored here.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{params, params_from_iter, Connection};
use serde::Serialize;

use crate::paths;
use crate::settings::Settings;

/// Openable executable extensions kept in the System32 preset DB.
const SYS32_EXTS: &[&str] = &["exe", "com", "cmd", "bat", "msc"];

/// A single search entry — a file found in an index directory.
#[derive(Debug, Clone, Serialize)]
pub struct AppEntry {
    pub id: u32,
    /// Display name (`.lnk` files drop the extension, like Explorer).
    pub name: String,
    /// Absolute path to the file.
    pub path: String,
    /// Lowercased pinyin of the name. Search aid only.
    #[serde(skip)]
    pub(crate) pinyin_full: String,
    /// Pinyin initials. Search aid only.
    #[serde(skip)]
    pub(crate) pinyin_initials: String,
}

// ---------------------------------------------------------------------------
// Paths & schema
// ---------------------------------------------------------------------------

pub fn sys32_db_path() -> PathBuf {
    paths::data_dir().join("system32_cache.db")
}

pub fn user_db_path() -> PathBuf {
    paths::data_dir().join("user_cache.db")
}

pub fn icons_db_path() -> PathBuf {
    paths::data_dir().join("icons.db")
}

fn ensure_dir_for(path: &Path) -> rusqlite::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(io_err)?;
    }
    Ok(())
}

fn init_files_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS files (
            path            TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            pinyin_full     TEXT NOT NULL,
            pinyin_initials TEXT NOT NULL,
            icon_hash       TEXT
        );
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )
}

// ---------------------------------------------------------------------------
// Index-building helpers (non-recursive, per docs/SETTINGS.md)
// ---------------------------------------------------------------------------

/// Compute `(full pinyin, initials)` for a name. Chinese characters map to
/// their pinyin; anything else is passed through lowercased.
fn pinyin_for(name: &str) -> (String, String) {
    use pinyin::ToPinyin;
    let chars: Vec<char> = name.chars().collect();
    let pinyins: Vec<_> = name.to_pinyin().collect();
    let mut full = String::new();
    let mut initials = String::new();
    for (i, &c) in chars.iter().enumerate() {
        match pinyins.get(i).and_then(|&p| p) {
            Some(p) => {
                full.push_str(p.plain());
                initials.push_str(p.first_letter());
            }
            None => {
                let lower = c.to_ascii_lowercase();
                full.push(lower);
                initials.push(lower);
            }
        }
    }
    (full, initials)
}

/// Resolve an index-directory spec to the real folder(s) it covers, empty if
/// unresolvable. `Desktop` covers **both** the user desktop and the public
/// (all-users) desktop, matching Explorer's combined view. `System32` is a
/// well-known location; user dirs are absolute paths.
pub(crate) fn resolve_index_dirs(spec: &str) -> Vec<PathBuf> {
    match spec {
        "Desktop" => desktop_dirs(),
        "System32" => std::env::var_os("SystemRoot")
            .map(|root| PathBuf::from(root).join("System32"))
            .filter(|p| p.is_dir())
            .into_iter()
            .collect(),
        other => {
            let p = PathBuf::from(other);
            p.is_dir().then_some(p).into_iter().collect()
        }
    }
}

/// Resolve a known folder via `SHGetKnownFolderPath` (handles OneDrive
/// redirection and localized paths).
fn known_folder(folder: &windows::core::GUID) -> Option<PathBuf> {
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::UI::Shell::{KNOWN_FOLDER_FLAG, SHGetKnownFolderPath};
    let out = unsafe { SHGetKnownFolderPath(folder, KNOWN_FOLDER_FLAG(0), None) }.ok()?;
    let path = unsafe { out.to_string() }.ok().map(PathBuf::from);
    unsafe { CoTaskMemFree(Some(out.as_ptr() as *const _)) };
    path
}

/// The user's real Desktop **and** the public Desktop (公用桌面).
fn desktop_dirs() -> Vec<PathBuf> {
    use windows::Win32::UI::Shell::{FOLDERID_Desktop, FOLDERID_PublicDesktop};
    let mut dirs = Vec::new();
    if let Some(d) = known_folder(&FOLDERID_Desktop) {
        dirs.push(d);
    }
    if let Some(d) = known_folder(&FOLDERID_PublicDesktop) {
        dirs.push(d);
    }
    dirs
}

/// List the top-level files of an index folder. Non-recursive. `.lnk` files
/// are reported by their stem (no extension), like Explorer.
fn list_files(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| {
            let path = e.path();
            if !path.is_file() {
                return None;
            }
            let name = if path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.eq_ignore_ascii_case("lnk"))
                .unwrap_or(false)
            {
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string()
            } else {
                path.file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string()
            };
            if name.is_empty() {
                return None;
            }
            Some((name, path))
        })
        .collect()
}

fn row_to_entry(id: u32, path: String, name: String, pf: String, pi: String) -> AppEntry {
    AppEntry {
        id,
        name,
        path,
        pinyin_full: pf,
        pinyin_initials: pi,
    }
}

/// Read every row from a `files` table into entries. A short busy timeout
/// keeps a read from failing when the service is mid-refresh on the same DB.
fn load_entries(db_path: &Path) -> rusqlite::Result<Vec<AppEntry>> {
    let conn = Connection::open(db_path)?;
    conn.busy_timeout(std::time::Duration::from_millis(500))?;
    load_entries_conn(&conn)
}

fn load_entries_conn(conn: &Connection) -> rusqlite::Result<Vec<AppEntry>> {
    let mut stmt = conn.prepare(
        "SELECT path, name, pinyin_full, pinyin_initials FROM files",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;
    rows.enumerate()
        .map(|(i, r)| {
            let (path, name, pf, pi) = r?;
            Ok(row_to_entry(i as u32, path, name, pf, pi))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// System32 preset DB
// ---------------------------------------------------------------------------

/// Ensure the System32 preset DB exists with the openable executables. Built
/// once on first use; the folder is static so no refresh is needed.
pub fn ensure_sys32_db() -> rusqlite::Result<()> {
    ensure_dir_for(&sys32_db_path())?;
    let conn = Connection::open(sys32_db_path())?;
    init_files_schema(&conn)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM files", [], |r| r.get(0))?;
    if count > 0 {
        return Ok(());
    }
    let Some(root) = std::env::var_os("SystemRoot") else {
        return Ok(());
    };
    let dir = PathBuf::from(root).join("System32");
    let mut stmt = conn.prepare(
        "INSERT OR REPLACE INTO files(path, name, pinyin_full, pinyin_initials, icon_hash)
         VALUES (?1, ?2, ?3, ?4, NULL)",
    )?;
    for (name, path) in list_files(&dir) {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !SYS32_EXTS.contains(&ext.as_str()) {
            continue;
        }
        let (pf, pi) = pinyin_for(&name);
        stmt.execute(params![path.to_string_lossy().into_owned(), name, pf, pi])?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('built_at', ?1)",
        params![now_millis().to_string()],
    )?;
    Ok(())
}

pub fn load_sys32_entries() -> Result<Vec<AppEntry>, String> {
    load_entries(&sys32_db_path()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// User cache DB (differential refresh)
// ---------------------------------------------------------------------------

/// The resolved, enabled live dirs (Desktop → user + public, plus user dirs).
/// System32 is excluded — it comes from the preset DB.
/// Resolved index dirs with a per-dir "index all files" flag. `true` = index
/// every file; `false` = only `.lnk`/`.exe` (the 索引目录中的文件 toggle off).
fn live_dirs(settings: &Settings) -> Vec<(PathBuf, bool)> {
    let mut dirs: Vec<(PathBuf, bool)> = Vec::new();
    if settings
        .index
        .system_dirs
        .iter()
        .any(|d| d.path == "Desktop" && d.enabled)
    {
        dirs.extend(resolve_index_dirs("Desktop").into_iter().map(|d| (d, true)));
    }
    for spec in &settings.index.user_dirs {
        let index_files = !settings.index.user_dirs_no_files.iter().any(|f| f == spec);
        dirs.extend(resolve_index_dirs(spec).into_iter().map(|d| (d, index_files)));
    }
    dirs
}

/// Whether a path is an "openable" file (`.lnk`/`.exe`/…) — the filter applied
/// when a directory's 索引目录中的文件 toggle is off.
fn is_openable(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    SYS32_EXTS.contains(&ext.as_str()) || ext == "lnk"
}

/// Whether the Start Menu system index is enabled.
fn start_menu_enabled(settings: &Settings) -> bool {
    settings
        .index
        .system_dirs
        .iter()
        .any(|d| d.path == "StartMenu" && d.enabled)
}

/// The Start Menu Programs roots (all-users + per-user) that exist.
pub(crate) fn start_menu_dirs() -> Vec<PathBuf> {
    let programs = Path::new("Microsoft").join("Windows").join("Start Menu").join("Programs");
    let mut dirs = Vec::new();
    for env in ["ProgramData", "APPDATA"] {
        if let Some(root) = std::env::var_os(env) {
            let p = PathBuf::from(root).join(&programs);
            if p.is_dir() {
                dirs.push(p);
            }
        }
    }
    dirs
}

/// Recursively collect `.lnk` shortcuts under `dir` (the Start Menu index).
fn walk_links(dir: &Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let path = e.path();
        if path.is_dir() {
            walk_links(&path, out);
        } else if path
            .extension()
            .and_then(|x| x.to_str())
            .map(|e| e.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false)
        {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default()
                .to_string();
            if !name.is_empty() {
                out.push((name, path));
            }
        }
    }
}

/// Diff the user-cache DB against the current index dirs: deletes rows whose
/// files are gone, inserts rows for new files (with pinyin; icons stay lazy).
/// Returns the fresh entry list. The GUI is the only refresher; the SYSTEM
/// service is a dormant bridge for future features and never scans.
pub fn refresh_user_db(settings: &Settings) -> Result<Vec<AppEntry>, String> {
    // Current on-disk files: (path, name), deduplicated across dirs.
    let mut seen: HashSet<String> = HashSet::new();
    let mut current: Vec<(String, String)> = Vec::new();
    for (dir, index_files) in live_dirs(settings) {
        for (name, path) in list_files(&dir) {
            if !index_files && !is_openable(&path) {
                continue; // 索引目录中的文件 off → only .lnk/.exe
            }
            let key = path.to_string_lossy().into_owned();
            if seen.insert(key.clone()) {
                current.push((key, name));
            }
        }
    }
    // Start Menu index (recursive .lnk), if enabled.
    if start_menu_enabled(settings) {
        for dir in start_menu_dirs() {
            let mut links = Vec::new();
            walk_links(&dir, &mut links);
            for (name, path) in links {
                let key = path.to_string_lossy().into_owned();
                if seen.insert(key.clone()) {
                    current.push((key, name));
                }
            }
        }
    }
    let current_set: HashSet<String> = current.iter().map(|(p, _)| p.clone()).collect();

    ensure_dir_for(&user_db_path()).map_err(|e| e.to_string())?;
    let conn = Connection::open(user_db_path()).map_err(|e| e.to_string())?;
    init_files_schema(&conn).map_err(|e| e.to_string())?;

    let existing: HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT path FROM files")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())?
    };

    // Remove files no longer present.
    for gone in existing.difference(&current_set) {
        conn.execute("DELETE FROM files WHERE path = ?1", params![gone])
            .map_err(|e| e.to_string())?;
    }
    // Insert newly-seen files.
    let mut stmt = conn
        .prepare(
            "INSERT OR IGNORE INTO files(path, name, pinyin_full, pinyin_initials, icon_hash)
             VALUES (?1, ?2, ?3, ?4, NULL)",
        )
        .map_err(|e| e.to_string())?;
    for (path, name) in &current {
        if existing.contains(path) {
            continue;
        }
        let (pf, pi) = pinyin_for(name);
        stmt.execute(params![path, name, pf, pi])
            .map_err(|e| e.to_string())?;
    }
    conn.execute(
        "INSERT OR REPLACE INTO meta(key, value) VALUES ('last_refresh', ?1)",
        params![now_millis().to_string()],
    )
    .map_err(|e| e.to_string())?;

    load_entries(&user_db_path()).map_err(|e| e.to_string())
}

pub fn load_user_entries() -> Result<Vec<AppEntry>, String> {
    ensure_dir_for(&user_db_path()).map_err(|e| e.to_string())?;
    let conn = Connection::open(user_db_path()).map_err(|e| e.to_string())?;
    init_files_schema(&conn).map_err(|e| e.to_string())?;
    load_entries(&user_db_path()).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Icon store (deduplicated, shared)
// ---------------------------------------------------------------------------

/// Resolve cached icon data URIs for many paths with a few batched queries.
/// Returns `path → Some(data URI)` when the icon is stored, else `None`.
pub fn icons_for(paths: &[String]) -> HashMap<String, Option<String>> {
    let mut out: HashMap<String, Option<String>> = HashMap::new();
    if paths.is_empty() {
        return out;
    }
    // path → icon_hash, from both cache DBs.
    let mut path_to_hash: HashMap<String, String> = HashMap::new();
    for db in [user_db_path(), sys32_db_path()] {
        let Ok(conn) = Connection::open(&db) else { continue };
        let sql = in_query(
            "SELECT path, icon_hash FROM files WHERE path IN",
            paths.len(),
        );
        let Ok(mut stmt) = conn.prepare(&sql) else { continue };
        let params: Vec<&str> = paths.iter().map(String::as_str).collect();
        let Ok(rows) = stmt.query_map(params_from_iter(params), |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
        }) else { continue };
        for row in rows.flatten() {
            if let (p, Some(h)) = row {
                path_to_hash.insert(p, h);
            }
        }
    }
    // icon_hash → data URI, from icons.db.
    let hashes: Vec<&str> = path_to_hash.values().map(String::as_str).collect();
    let mut hash_to_uri: HashMap<String, String> = HashMap::new();
    if !hashes.is_empty() {
        if let Ok(conn) = Connection::open(icons_db_path()) {
            let sql = in_query(
                "SELECT icon_hash, data FROM icons WHERE icon_hash IN",
                hashes.len(),
            );
            if let Ok(mut stmt) = conn.prepare(&sql) {
                if let Ok(rows) = stmt.query_map(params_from_iter(hashes), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?))
                }) {
                    for row in rows.flatten() {
                        let (h, data) = row;
                        hash_to_uri.insert(h, encode_png_uri(&data));
                    }
                }
            }
        }
    }
    for p in paths {
        out.insert(
            p.clone(),
            path_to_hash.get(p).and_then(|h| hash_to_uri.get(h)).cloned(),
        );
    }
    out
}

fn in_query(prefix: &str, n: usize) -> String {
    let placeholders = std::iter::repeat("?").take(n).collect::<Vec<_>>().join(",");
    format!("{prefix} ({placeholders})")
}

/// Encode PNG bytes as a base64 data URI for the frontend.
pub fn encode_png_uri(png: &[u8]) -> String {
    use base64::Engine;
    format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    )
}

/// Insert an icon (dedupe by hash) if missing.
pub fn store_icon(hash: &str, data: &[u8]) -> rusqlite::Result<()> {
    ensure_dir_for(&icons_db_path())?;
    let conn = Connection::open(icons_db_path())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS icons (
            icon_hash TEXT PRIMARY KEY,
            data      BLOB NOT NULL
        );",
    )?;
    conn.execute(
        "INSERT OR IGNORE INTO icons(icon_hash, data) VALUES (?1, ?2)",
        params![hash, data],
    )?;
    Ok(())
}

/// Record a file's icon hash in whichever cache DB holds it.
pub fn set_file_icon_hash(path: &str, hash: &str) -> rusqlite::Result<()> {
    for db in [user_db_path(), sys32_db_path()] {
        let conn = Connection::open(&db)?;
        let changed = conn.execute(
            "UPDATE files SET icon_hash = ?1 WHERE path = ?2",
            params![hash, path],
        )?;
        if changed > 0 {
            return Ok(());
        }
    }
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn io_err(e: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(e.to_string())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lnk_files_drop_extension_in_display_name() {
        let tmp = std::env::temp_dir().join(format!("lume-cache-test-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&tmp);
        let _ = std::fs::write(tmp.join("Notepad.lnk"), b"\x00");
        let _ = std::fs::write(tmp.join("notes.txt"), b"x");
        let files = list_files(&tmp);
        let names: Vec<&str> = files.iter().map(|(n, _)| n.as_str()).collect();
        assert!(names.contains(&"Notepad"), ".lnk name drops the extension");
        assert!(!names.contains(&"Notepad.lnk"));
        assert!(names.contains(&"notes.txt"), "non-lnk keeps its extension");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sys32_ext_filter_allows_only_openable() {
        assert!(SYS32_EXTS.contains(&"exe"));
        assert!(SYS32_EXTS.contains(&"msc"));
        assert!(!SYS32_EXTS.contains(&"dll"));
        assert!(!SYS32_EXTS.contains(&"sys"));
    }

    #[test]
    fn pinyin_conversion() {
        let (full, initials) = pinyin_for("计算器");
        assert_eq!(full, "jisuanqi");
        assert_eq!(initials, "jsq");
        let (full, initials) = pinyin_for("Firefox");
        assert_eq!(full, "firefox");
        assert_eq!(initials, "firefox");
    }
}
