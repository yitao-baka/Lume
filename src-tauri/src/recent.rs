//! Recent-opens for the Navigate main-menu bar.
//!
//! A distinct strip of recently-launched apps/files above the pinned bar. Opens
//! are recorded at the single chokepoint `apps::launch_app`; each record is
//! deduped by path (re-opening bumps the timestamp) and the list is pruned to
//! the configured `appearance.recent_count`. Persisted to the same SQLite
//! database (`lume.db`) in a separate WAL-mode connection, like `pins.rs`.

use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{Manager, State};

use crate::settings::SettingsState;

/// A recently-opened entry; the frontend reuses the `AppEntry` shape to render.
#[derive(Debug, Clone, Serialize)]
pub struct RecentApp {
    pub id: u32,
    pub name: String,
    pub path: String,
}

/// Recent-opens store: an independent connection to `lume.db`.
pub struct RecentState(Mutex<Connection>);

impl RecentState {
    /// Lock the inner connection (used by `apps::launch_app` to record opens).
    pub(crate) fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap()
    }
}

fn init_recent(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recent_apps (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            path       TEXT NOT NULL UNIQUE,
            name       TEXT NOT NULL,
            opened_at  INTEGER NOT NULL
        );",
    )
}

/// Recents newest-first.
fn list_recent(conn: &Connection) -> rusqlite::Result<Vec<RecentApp>> {
    let mut stmt =
        conn.prepare("SELECT id, name, path FROM recent_apps ORDER BY opened_at DESC, id DESC")?;
    let rows = stmt.query_map([], |row| {
        Ok(RecentApp {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
        })
    })?;
    rows.collect()
}

/// Record an open: upsert by path (bump the timestamp), then prune to `max`.
pub(crate) fn record_recent(
    conn: &Connection,
    path: &str,
    name: &str,
    max: usize,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO recent_apps(path, name, opened_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET name = excluded.name, opened_at = excluded.opened_at",
        params![path, name, now_millis()],
    )?;
    if max > 0 {
        conn.execute(
            "DELETE FROM recent_apps WHERE id NOT IN (
                SELECT id FROM recent_apps ORDER BY opened_at DESC, id DESC LIMIT ?1
            )",
            params![max as i64],
        )?;
    }
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open the persistent DB (falling back to in-memory on error), mirroring
/// `pins::init`.
pub fn init(app: &tauri::App) {
    let conn = match open_db() {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("[recent] failed to open DB, using in-memory store: {e}");
            let conn = Connection::open_in_memory().expect("in-memory sqlite");
            let _ = init_recent(&conn);
            conn
        }
    };
    app.manage(RecentState(Mutex::new(conn)));
}

fn open_db() -> rusqlite::Result<Connection> {
    let dir = crate::paths::data_dir();
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    let conn = Connection::open(crate::paths::db_path())?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    init_recent(&conn)?;
    Ok(conn)
}

fn io_err(e: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(e.to_string())))
}

/// List recent opens, capped at the configured count.
#[tauri::command]
pub fn get_recent_apps(
    state: State<RecentState>,
    settings: State<SettingsState>,
) -> Result<Vec<RecentApp>, String> {
    let max = settings.current().appearance.recent_count.max(1) as usize;
    let conn = state.0.lock().unwrap();
    let mut list = list_recent(&conn).map_err(|e| e.to_string())?;
    list.truncate(max);
    Ok(list)
}

/// Remove one recent-open record (soft delete — reopening the entry re-adds it).
/// The underlying file/app is untouched.
fn remove_recent(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM recent_apps WHERE path = ?1", params![path])?;
    Ok(())
}

/// Delete a recent-open entry by path (right-click menu / Del key).
#[tauri::command]
pub fn delete_recent(path: String, state: State<RecentState>) -> Result<(), String> {
    let conn = state.lock();
    remove_recent(&conn, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_recent(&conn).unwrap();
        conn
    }

    #[test]
    fn record_lists_newest_first() {
        let conn = memory_db();
        record_recent(&conn, "C:/a.lnk", "Alpha", 20).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        record_recent(&conn, "C:/b.lnk", "Beta", 20).unwrap();
        let list = list_recent(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "Beta", "newest first");
        assert_eq!(list[1].name, "Alpha");
    }

    #[test]
    fn reopen_bumps_to_top() {
        let conn = memory_db();
        record_recent(&conn, "C:/a.lnk", "Alpha", 20).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        record_recent(&conn, "C:/b.lnk", "Beta", 20).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        record_recent(&conn, "C:/a.lnk", "Alpha", 20).unwrap();
        let list = list_recent(&conn).unwrap();
        assert_eq!(list.len(), 2, "dedupe by path");
        assert_eq!(list[0].name, "Alpha", "re-opened bumps to top");
    }

    #[test]
    fn prunes_beyond_max() {
        let conn = memory_db();
        record_recent(&conn, "C:/a.lnk", "Alpha", 2).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        record_recent(&conn, "C:/b.lnk", "Beta", 2).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        record_recent(&conn, "C:/c.lnk", "Gamma", 2).unwrap();
        let list = list_recent(&conn).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].name, "Gamma");
        assert_eq!(list[1].name, "Beta");
        assert!(!list.iter().any(|r| r.name == "Alpha"), "oldest pruned");
    }

    #[test]
    fn remove_deletes_by_path_only() {
        let conn = memory_db();
        record_recent(&conn, "C:/a.lnk", "Alpha", 20).unwrap();
        record_recent(&conn, "C:/b.lnk", "Beta", 20).unwrap();
        remove_recent(&conn, "C:/a.lnk").unwrap();
        let list = list_recent(&conn).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Beta");
        // Removing a non-existent path is a no-op.
        remove_recent(&conn, "C:/zzz.lnk").unwrap();
        assert_eq!(list_recent(&conn).unwrap().len(), 1);
    }
}
