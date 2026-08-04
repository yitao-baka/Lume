//! Pinned apps for the Navigate main-menu bar.
//!
//! A distinct strip of frequently-used apps at the top of the grid. Pins are
//! persisted to the same SQLite database (`lume.db`) — in a separate
//! WAL-mode connection — so they survive restarts.

use std::sync::Mutex;

use rusqlite::{params, Connection};
use serde::Serialize;
use tauri::{Manager, State};

/// A pinned app; the frontend reuses the `AppEntry` shape to render/launch.
#[derive(Debug, Clone, Serialize)]
pub struct PinnedApp {
    pub id: u32,
    pub name: String,
    pub path: String,
}

/// Pinned-app store: an independent connection to `lume.db`.
pub struct PinsState(Mutex<Connection>);

fn init_pins(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pinned_apps (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            path       TEXT NOT NULL UNIQUE,
            name       TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )
}

/// Pins in the order they were added (oldest first).
fn list_pins(conn: &Connection) -> rusqlite::Result<Vec<PinnedApp>> {
    let mut stmt =
        conn.prepare("SELECT id, name, path FROM pinned_apps ORDER BY created_at ASC, id ASC")?;
    let rows = stmt.query_map([], |row| {
        Ok(PinnedApp {
            id: row.get(0)?,
            name: row.get(1)?,
            path: row.get(2)?,
        })
    })?;
    rows.collect()
}

/// Insert a pin; duplicates (same path) are ignored.
fn add_pin(conn: &Connection, path: &str, name: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR IGNORE INTO pinned_apps(path, name, created_at) VALUES (?1, ?2, ?3)",
        params![path, name, now_millis()],
    )?;
    Ok(())
}

fn remove_pin(conn: &Connection, path: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM pinned_apps WHERE path = ?1", params![path])?;
    Ok(())
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Open the persistent DB (falling back to in-memory on error) and manage the
/// state, mirroring `clipboard::init`.
pub fn init(app: &tauri::App) {
    let conn = match open_db() {
        Ok(conn) => conn,
        Err(e) => {
            eprintln!("[pins] failed to open DB, using in-memory store: {e}");
            let conn = Connection::open_in_memory().expect("in-memory sqlite");
            let _ = init_pins(&conn);
            conn
        }
    };
    app.manage(PinsState(Mutex::new(conn)));
}

fn open_db() -> rusqlite::Result<Connection> {
    let dir = crate::paths::data_dir();
    std::fs::create_dir_all(&dir).map_err(io_err)?;
    let conn = Connection::open(crate::paths::db_path())?;
    // WAL lets the clipboard connection and this one share the file safely.
    conn.execute_batch("PRAGMA journal_mode=WAL;")?;
    init_pins(&conn)?;
    Ok(conn)
}

fn io_err(e: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(e.to_string())))
}

/// List pinned apps in fixed order.
#[tauri::command]
pub fn get_pinned_apps(state: State<PinsState>) -> Result<Vec<PinnedApp>, String> {
    let conn = state.0.lock().unwrap();
    list_pins(&conn).map_err(|e| e.to_string())
}

/// Pin an app (by `.lnk` path + display name). Idempotent.
#[tauri::command]
pub fn pin_app(path: String, name: String, state: State<PinsState>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    add_pin(&conn, &path, &name).map_err(|e| e.to_string())
}

/// Unpin an app.
#[tauri::command]
pub fn unpin_app(path: String, state: State<PinsState>) -> Result<(), String> {
    let conn = state.0.lock().unwrap();
    remove_pin(&conn, &path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init_pins(&conn).unwrap();
        conn
    }

    #[test]
    fn add_list_remove() {
        let conn = memory_db();
        add_pin(&conn, "C:/a.lnk", "Alpha").unwrap();
        add_pin(&conn, "C:/b.lnk", "Beta").unwrap();
        let pins = list_pins(&conn).unwrap();
        assert_eq!(pins.len(), 2);
        assert_eq!(pins[0].name, "Alpha", "pins keep insertion order");
        assert_eq!(pins[1].name, "Beta");

        remove_pin(&conn, "C:/a.lnk").unwrap();
        let pins = list_pins(&conn).unwrap();
        assert_eq!(pins.len(), 1);
        assert_eq!(pins[0].name, "Beta");
    }

    #[test]
    fn duplicate_add_is_ignored() {
        let conn = memory_db();
        add_pin(&conn, "C:/a.lnk", "Alpha").unwrap();
        add_pin(&conn, "C:/a.lnk", "Alpha 2").unwrap();
        let pins = list_pins(&conn).unwrap();
        assert_eq!(pins.len(), 1, "same path must not duplicate");
        assert_eq!(pins[0].name, "Alpha");
    }
}
