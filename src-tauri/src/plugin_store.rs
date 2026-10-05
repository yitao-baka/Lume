//! Plugin document store (P3.1, ROADMAP #26) — `<base>/data/plugin_store.db`.
//!
//! Its own SQLite file, deliberately NOT `lume.db`: plugin data is deletable
//! wholesale (uninstall = drop one file) and a plugin-corrupted store can never
//! damage clipboard history or pins.
//!
//! One table, uTools/CouchDB-shaped documents:
//!
//! ```sql
//! docs(plugin_id TEXT, id TEXT, rev INTEGER, json TEXT, PRIMARY KEY(plugin_id, id))
//! ```
//!
//! `_rev` is an optimistic lock: a writer passes the rev it read and loses
//! loudly (`conflict: …`) when someone else got there first, so a plugin can
//! re-read and decide. Deleting drops the row (no tombstone) — a later put
//! without `_rev` then starts a fresh document at rev 1.
//!
//! Doc ids starting with `__` are host-owned (`__settings` — the plugin's
//! settings values, `__storage` — the v1 KV shim) and invisible to `db.*`.
//!
//! Migration: v1 kept plugin KV in `<plugin>/storage.json`. The first store
//! access in a process moves those files into each plugin's `__storage` doc;
//! the file is renamed `storage.json.migrated`, never deleted.

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::Emitter;

use crate::paths::base_dir;
use crate::plugins::{manifest_id_of, valid_plugin_id};

/// Cap for one document's JSON text (the whole doc is read/written at once).
pub const MAX_DOC_BYTES: usize = 512 * 1024;
/// Cap on documents per plugin — also `all_docs`' hard limit, so a full
/// listing is always possible.
pub const MAX_DOCS: i64 = 2000;
/// Cap on one `bulk_docs` call.
pub const MAX_BULK: usize = 1000;
/// Host-owned doc ids live under this prefix (`db.*` refuses them).
pub const INTERNAL_PREFIX: &str = "__";
/// The plugin's settings values (manifest defaults ⊕ user changes).
pub const SETTINGS_DOC: &str = "__settings";
/// The v1 `storage.*` KV shim's backing document.
pub const STORAGE_DOC: &str = "__storage";

/// One stored document as the frontend receives it: the JSON text plus the
/// store's bookkeeping (`_id`/`_rev` are attached on the JS side, like the
/// rest of the host API keeps Rust dumb about payload shape).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DbDoc {
    pub id: String,
    pub rev: i64,
    pub json: String,
}

/// One `bulk_docs` entry.
#[derive(Debug, Clone, Deserialize)]
pub struct BulkDocIn {
    #[serde(rename = "docId")]
    pub doc_id: String,
    pub json: String,
    #[serde(default)]
    pub rev: Option<i64>,
}

/// One `bulk_docs` outcome: the new rev, or the reason this entry was skipped
/// (a conflict never aborts the rest of the batch).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct BulkResult {
    pub id: String,
    pub rev: Option<i64>,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------------
// Connection + schema
// ---------------------------------------------------------------------------

/// `<base>/data/plugin_store.db`.
pub fn store_path(base: &Path) -> PathBuf {
    base.join("data").join("plugin_store.db")
}

fn init_schema(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS docs (
            plugin_id TEXT NOT NULL,
            id        TEXT NOT NULL,
            rev       INTEGER NOT NULL,
            json      TEXT NOT NULL,
            PRIMARY KEY (plugin_id, id)
        );",
    )
}

/// Open the store, creating `<base>/data` and the schema as needed. WAL lets
/// the settings window and the launcher share the file (they both write
/// settings values), like `pins.rs` does for `lume.db`.
fn open(base: &Path) -> Result<Connection, String> {
    let path = store_path(base);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("plugin store dir: {e}"))?;
    }
    let conn = Connection::open(&path).map_err(|e| format!("plugin store: {e}"))?;
    conn.execute_batch("PRAGMA journal_mode=WAL;")
        .map_err(|e| format!("plugin store wal: {e}"))?;
    conn.busy_timeout(std::time::Duration::from_millis(3000))
        .map_err(|e| format!("plugin store busy_timeout: {e}"))?;
    init_schema(&conn).map_err(|e| format!("plugin store schema: {e}"))?;
    Ok(conn)
}

/// The legacy-storage migration runs once per process (the base dir is fixed
/// for the lifetime of a process; tests call `migrate_legacy_storage_with`
/// directly so they stay independent).
static MIGRATED: std::sync::Once = std::sync::Once::new();

/// The connection every command uses: open + (once per process) migrate.
fn open_migrated(base: &Path) -> Result<Connection, String> {
    let conn = open(base)?;
    MIGRATED.call_once(|| {
        let moved = migrate_legacy_storage_with(&conn, base);
        if moved > 0 {
            eprintln!("[plugins] storage: migrated {moved} plugin storage.json file(s) into the store");
        }
    });
    Ok(conn)
}

// ---------------------------------------------------------------------------
// Document primitives (pure — take `&Connection` so tests use a temp dir)
// ---------------------------------------------------------------------------

/// `db.*` may only touch a plugin's own, non-internal documents.
fn assert_public_doc_id(plugin_id: &str, doc_id: &str) -> Result<(), String> {
    if !valid_plugin_id(plugin_id) {
        return Err("invalid plugin id".into());
    }
    if doc_id.is_empty() {
        return Err("doc id is required".into());
    }
    if doc_id.starts_with(INTERNAL_PREFIX) {
        return Err(format!(
            "doc id \"{doc_id}\" is reserved (\"{INTERNAL_PREFIX}\" prefix is host-owned)"
        ));
    }
    Ok(())
}

/// A document body must be a JSON object (`_id`/`_rev` are attached to it on
/// the JS side) and fit the size cap.
fn assert_doc_body(json: &str) -> Result<(), String> {
    if json.len() > MAX_DOC_BYTES {
        return Err(format!(
            "doc too large: {} bytes (cap {MAX_DOC_BYTES})",
            json.len()
        ));
    }
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(v) if v.is_object() => Ok(()),
        Ok(_) => Err("doc body must be a JSON object".into()),
        Err(e) => Err(format!("doc body is not valid JSON: {e}")),
    }
}

fn read_doc(conn: &Connection, plugin_id: &str, doc_id: &str) -> rusqlite::Result<Option<DbDoc>> {
    conn.query_row(
        "SELECT id, rev, json FROM docs WHERE plugin_id = ?1 AND id = ?2",
        params![plugin_id, doc_id],
        |row| {
            Ok(DbDoc {
                id: row.get(0)?,
                rev: row.get(1)?,
                json: row.get(2)?,
            })
        },
    )
    .optional()
}

fn count_docs(conn: &Connection, plugin_id: &str) -> rusqlite::Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM docs WHERE plugin_id = ?1",
        params![plugin_id],
        |row| row.get(0),
    )
}

/// Insert or replace one document, enforcing the `_rev` contract.
///
/// `rev = None` means "this is a new document": an existing row is a conflict
/// (the writer never read it). `rev = Some(r)` must match the stored rev — a
/// vanished document is a conflict too (someone deleted it). Returns the new
/// rev.
fn put_doc(
    conn: &Connection,
    plugin_id: &str,
    doc_id: &str,
    json: &str,
    rev: Option<i64>,
) -> Result<i64, String> {
    assert_public_doc_id(plugin_id, doc_id)?;
    assert_doc_body(json)?;
    let current = read_doc(conn, plugin_id, doc_id).map_err(|e| e.to_string())?;
    let next = match (current.as_ref(), rev) {
        // Fresh document.
        (None, None) => {
            let count = count_docs(conn, plugin_id).map_err(|e| e.to_string())?;
            if count >= MAX_DOCS {
                return Err(format!(
                    "doc limit reached: {count} documents (cap {MAX_DOCS})"
                ));
            }
            1
        }
        // The writer never read the document it is overwriting.
        (Some(cur), None) => {
            return Err(format!(
                "conflict: doc \"{doc_id}\" already exists at rev {} — read it and pass _rev",
                cur.rev
            ))
        }
        // Creation after someone else deleted the document.
        (None, Some(r)) => {
            return Err(format!(
                "conflict: doc \"{doc_id}\" does not exist (wrote with _rev {r})"
            ))
        }
        (Some(cur), Some(r)) if cur.rev == r => cur.rev + 1,
        (Some(cur), Some(r)) => {
            return Err(format!(
                "conflict: doc \"{doc_id}\" is at rev {}, not {r} — re-read it",
                cur.rev
            ))
        }
    };
    conn.execute(
        "INSERT INTO docs (plugin_id, id, rev, json) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(plugin_id, id) DO UPDATE SET rev = excluded.rev, json = excluded.json",
        params![plugin_id, doc_id, next, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(next)
}

/// Delete one document; `rev` must match (a plugin always deletes what it
/// read). The row is gone afterwards — no tombstones.
fn remove_doc(conn: &Connection, plugin_id: &str, doc_id: &str, rev: i64) -> Result<(), String> {
    assert_public_doc_id(plugin_id, doc_id)?;
    let current = read_doc(conn, plugin_id, doc_id).map_err(|e| e.to_string())?;
    match current {
        Some(cur) if cur.rev == rev => {
            conn.execute(
                "DELETE FROM docs WHERE plugin_id = ?1 AND id = ?2",
                params![plugin_id, doc_id],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        }
        Some(cur) => Err(format!(
            "conflict: doc \"{doc_id}\" is at rev {}, not {rev} — re-read it",
            cur.rev
        )),
        None => Err(format!("conflict: doc \"{doc_id}\" does not exist")),
    }
}

/// The plugin's documents, ordered by id, internal (`__`) docs excluded.
/// `prefix` filters by id prefix (exact `substr` comparison — no LIKE, so a
/// prefix containing `%`/`_` means itself).
fn list_docs(
    conn: &Connection,
    plugin_id: &str,
    prefix: &str,
    limit: i64,
) -> Result<Vec<DbDoc>, String> {
    if !valid_plugin_id(plugin_id) {
        return Err("invalid plugin id".into());
    }
    let page = limit.clamp(1, MAX_DOCS);
    let mut stmt = conn
        .prepare(
            "SELECT id, rev, json FROM docs
             WHERE plugin_id = ?1
               AND substr(id, 1, 2) <> ?2
               AND (?3 = '' OR substr(id, 1, length(?3)) = ?3)
             ORDER BY id LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![plugin_id, INTERNAL_PREFIX, prefix, page], |row| {
            Ok(DbDoc {
                id: row.get(0)?,
                rev: row.get(1)?,
                json: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Host-internal documents (settings + the v1 storage shim)
// ---------------------------------------------------------------------------

/// Read one host-owned document (no public-id guard).
fn read_internal(conn: &Connection, plugin_id: &str, doc_id: &str) -> Option<String> {
    read_doc(conn, plugin_id, doc_id)
        .ok()
        .flatten()
        .map(|d| d.json)
}

/// Write one host-owned document unconditionally (rev-tracked, so a later
/// `db.*` view of it — there is none — would still be consistent).
fn write_internal(conn: &Connection, plugin_id: &str, doc_id: &str, json: &str) -> Result<i64, String> {
    let rev = read_doc(conn, plugin_id, doc_id)
        .map_err(|e| e.to_string())?
        .map(|d| d.rev);
    let next = rev.unwrap_or(0) + 1;
    conn.execute(
        "INSERT INTO docs (plugin_id, id, rev, json) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(plugin_id, id) DO UPDATE SET rev = excluded.rev, json = excluded.json",
        params![plugin_id, doc_id, next, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(next)
}

/// The `__storage` map (v1 KV shim): `{key: json-text}`.
fn storage_map(conn: &Connection, plugin_id: &str) -> BTreeMap<String, String> {
    read_internal(conn, plugin_id, STORAGE_DOC)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default()
}

/// Read one legacy KV key (None = unset).
pub fn storage_get(base: &Path, id: &str, key: &str) -> Result<Option<String>, String> {
    if !valid_plugin_id(id) {
        return Err("invalid plugin id".into());
    }
    let conn = open_migrated(base)?;
    let value = storage_map(&conn, id).get(key).cloned();
    match &value {
        Some(v) => eprintln!("[plugins] storage get ({id}) {key} → hit ({} bytes)", v.len()),
        None => eprintln!("[plugins] storage get ({id}) {key} → miss"),
    }
    Ok(value)
}

/// Write one legacy KV key (value = JSON text; `None` deletes). The whole
/// read-modify-write runs in one IMMEDIATE transaction: two concurrent calls
/// (e.g. a page and its logic hook) must not lose each other's keys.
pub fn storage_set(
    base: &Path,
    id: &str,
    key: &str,
    value: Option<String>,
) -> Result<(), String> {
    if !valid_plugin_id(id) {
        return Err("invalid plugin id".into());
    }
    let mut conn = open_migrated(base)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut map = storage_map(&tx, id);
    match &value {
        Some(v) => eprintln!(
            "[plugins] storage set ({id}) {key} = <{} bytes> ({} key(s) before write)",
            v.len(),
            map.len()
        ),
        None => eprintln!(
            "[plugins] storage remove ({id}) {key} ({} key(s) before write)",
            map.len()
        ),
    }
    match value {
        Some(v) => {
            map.insert(key.to_string(), v);
        }
        None => {
            map.remove(key);
        }
    }
    let json = serde_json::to_string(&map).map_err(|e| e.to_string())?;
    write_internal(&tx, id, STORAGE_DOC, &json)?;
    tx.commit().map_err(|e| e.to_string())
}

/// The plugin's effective settings: manifest defaults with the user's stored
/// values on top. Unknown stored keys (a setting the author removed) are kept
/// out — the manifest is the schema.
pub fn settings_values(base: &Path, id: &str) -> Result<serde_json::Map<String, serde_json::Value>, String> {
    let conn = open_migrated(base)?;
    Ok(settings_values_with(&conn, base, id))
}

fn settings_values_with(
    conn: &Connection,
    base: &Path,
    id: &str,
) -> serde_json::Map<String, serde_json::Value> {
    let declared = crate::plugins::manifest_settings(base, id);
    let stored: serde_json::Map<String, serde_json::Value> = read_internal(conn, id, SETTINGS_DOC)
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let mut out = serde_json::Map::new();
    for s in declared {
        let value = stored.get(&s.key).cloned().unwrap_or(s.default_value.clone());
        out.insert(s.key, value);
    }
    out
}

/// Store one declared setting. The manifest is the schema: an undeclared key
/// is refused (a typo'd key would otherwise be silently accepted forever).
pub fn settings_put(base: &Path, id: &str, key: &str, value: serde_json::Value) -> Result<(), String> {
    let declared = crate::plugins::manifest_settings(base, id);
    if !declared.iter().any(|s| s.key == key) {
        return Err(format!(
            "unknown setting \"{key}\" for plugin \"{id}\" (declare it as [[settings]] in plugin.toml)"
        ));
    }
    let mut conn = open_migrated(base)?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut stored: serde_json::Map<String, serde_json::Value> =
        read_internal(&tx, id, SETTINGS_DOC)
            .and_then(|json| serde_json::from_str(&json).ok())
            .unwrap_or_default();
    let size = serde_json::to_string(&value).map(|s| s.len()).unwrap_or(0);
    eprintln!("[plugins] settings set ({id}) {key} = <{size} bytes>");
    stored.insert(key.to_string(), value);
    write_internal(
        &tx,
        id,
        SETTINGS_DOC,
        &serde_json::to_string(&stored).map_err(|e| e.to_string())?,
    )?;
    tx.commit().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Legacy storage.json migration
// ---------------------------------------------------------------------------

/// Migrate every `<base>/plugins/<id>/storage.json` into that plugin's
/// `__storage` doc. Idempotent: a plugin that already has the doc keeps the
/// db's copy (the db is authoritative once it exists). The legacy file is
/// renamed `storage.json.migrated` — kept, never deleted, so nothing is lost
/// if a plugin turns out to depend on reading it directly.
pub fn migrate_legacy_storage_with(conn: &Connection, base: &Path) -> usize {
    let dir = base.join("plugins");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return 0;
    };
    let mut moved = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let file = path.join("storage.json");
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        let id = manifest_id_of(&path);
        if !valid_plugin_id(&id) {
            eprintln!(
                "[plugins] storage migrate: skipping {} (unusable plugin id \"{id}\")",
                file.display()
            );
            continue;
        }
        let map: BTreeMap<String, String> = match serde_json::from_str(&text) {
            Ok(m) => m,
            Err(err) => {
                eprintln!(
                    "[plugins] storage migrate: skipping {} (unreadable map: {err})",
                    file.display()
                );
                continue;
            }
        };
        let has_doc = read_internal(conn, &id, STORAGE_DOC).is_some();
        if has_doc {
            eprintln!("[plugins] storage migrate: {id} already in the store, file retires");
        } else if !map.is_empty() {
            let json = match serde_json::to_string(&map) {
                Ok(j) => j,
                Err(err) => {
                    eprintln!("[plugins] storage migrate: {id} skipped ({err})");
                    continue;
                }
            };
            if write_internal(conn, &id, STORAGE_DOC, &json).is_err() {
                eprintln!("[plugins] storage migrate: {id} write failed");
                continue;
            }
            eprintln!(
                "[plugins] storage migrate: {id} → doc {STORAGE_DOC} ({} key(s))",
                map.len()
            );
        }
        let retired = file.with_extension("json.migrated");
        if std::fs::rename(&file, &retired).is_err() {
            eprintln!("[plugins] storage migrate: {id} could not retire {}", file.display());
            continue;
        }
        moved += 1;
    }
    moved
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// `db.get(id)` — the document, or None when it doesn't exist.
#[tauri::command]
pub fn plugin_db_get(
    id: String,
    doc_id: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<Option<DbDoc>, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    let conn = open_migrated(&base_dir())?;
    assert_public_doc_id(&id, &doc_id)?;
    read_doc(&conn, &id, &doc_id).map_err(|e| e.to_string())
}

/// `db.put(doc)` — create (no `_rev`) or replace (matching `_rev`). Returns
/// the new rev; conflicts reject with a `conflict: …` message.
#[tauri::command]
pub fn plugin_db_put(
    id: String,
    doc_id: String,
    json: String,
    rev: Option<i64>,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<i64, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    let conn = open_migrated(&base_dir())?;
    let new_rev = put_doc(&conn, &id, &doc_id, &json, rev)?;
    eprintln!(
        "[plugins] db put ({id}) {doc_id} → rev {new_rev} ({} bytes)",
        json.len()
    );
    Ok(new_rev)
}

/// `db.remove(doc)` — delete with the rev the caller read.
#[tauri::command]
pub fn plugin_db_remove(
    id: String,
    doc_id: String,
    rev: i64,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<(), String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    let conn = open_migrated(&base_dir())?;
    remove_doc(&conn, &id, &doc_id, rev)?;
    eprintln!("[plugins] db remove ({id}) {doc_id} (rev {rev})");
    Ok(())
}

/// `db.allDocs()` — this plugin's documents, id-ordered, `__`-docs excluded.
#[tauri::command]
pub fn plugin_db_all_docs(
    id: String,
    prefix: Option<String>,
    limit: Option<i64>,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<Vec<DbDoc>, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    let conn = open_migrated(&base_dir())?;
    let docs = list_docs(
        &conn,
        &id,
        prefix.as_deref().unwrap_or(""),
        limit.unwrap_or(MAX_DOCS),
    )?;
    eprintln!("[plugins] db allDocs ({id}) → {} doc(s)", docs.len());
    Ok(docs)
}

/// `db.bulkDocs(docs)` — one transaction, per-document outcomes (a conflict
/// is reported for that entry, the rest still land).
#[tauri::command]
pub fn plugin_db_bulk_docs(
    id: String,
    docs: Vec<BulkDocIn>,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<Vec<BulkResult>, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    if docs.len() > MAX_BULK {
        return Err(format!("too many docs: {} (cap {MAX_BULK})", docs.len()));
    }
    let mut conn = open_migrated(&base_dir())?;
    let tx: Transaction = conn.transaction().map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(docs.len());
    for d in &docs {
        match put_doc(&tx, &id, &d.doc_id, &d.json, d.rev) {
            Ok(rev) => out.push(BulkResult {
                id: d.doc_id.clone(),
                rev: Some(rev),
                error: None,
            }),
            Err(err) => out.push(BulkResult {
                id: d.doc_id.clone(),
                rev: None,
                error: Some(err),
            }),
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    let ok = out.iter().filter(|r| r.error.is_none()).count();
    eprintln!(
        "[plugins] db bulkDocs ({id}) → {ok}/{} applied",
        out.len()
    );
    Ok(out)
}

/// Legacy KV read (v1 `storage.*`) — kept as a shim over the `__storage` doc.
#[tauri::command]
pub fn plugin_storage_get(
    id: String,
    key: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<Option<String>, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    storage_get(&base_dir(), &id, &key)
}

/// Legacy KV write (value = JSON text; null deletes).
#[tauri::command]
pub fn plugin_storage_set(
    id: String,
    key: String,
    value: Option<String>,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<(), String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    storage_set(&base_dir(), &id, &key, value)
}

/// The plugin's effective settings (manifest defaults ⊕ stored values).
#[tauri::command]
pub fn plugin_settings_get(
    id: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<serde_json::Map<String, serde_json::Value>, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    settings_values(&base_dir(), &id)
}

/// Store one declared setting and tell the launcher to hand the new values to
/// the plugin (the settings window and the plugin live in different windows).
#[tauri::command]
pub fn plugin_settings_put(
    id: String,
    key: String,
    value: serde_json::Value,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
    app: tauri::AppHandle,
) -> Result<(), String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: this call needs a plugin id".to_string())?;
    settings_put(&base_dir(), &id, &key, value)?;
    app.emit("plugin-settings", id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh store in a test-named temp dir (the pid keeps parallel test
    /// binaries apart; the name keeps tests in one binary apart).
    fn temp_store(name: &str) -> (PathBuf, Connection) {
        let root = std::env::temp_dir().join(format!("lume-pstore-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        let conn = open(&root).unwrap();
        (root, conn)
    }

    #[test]
    fn doc_roundtrip_bumps_rev_and_keeps_other_docs() {
        let (root, conn) = temp_store("roundtrip");
        assert_eq!(put_doc(&conn, "demo", "a", r#"{"n":1}"#, None).unwrap(), 1);
        assert_eq!(put_doc(&conn, "demo", "b", r#"{"n":2}"#, None).unwrap(), 1);
        // A replace with the rev we read succeeds and bumps.
        assert_eq!(put_doc(&conn, "demo", "a", r#"{"n":3}"#, Some(1)).unwrap(), 2);
        assert_eq!(put_doc(&conn, "demo", "a", r#"{"n":4}"#, Some(2)).unwrap(), 3);
        let a = read_doc(&conn, "demo", "a").unwrap().unwrap();
        assert_eq!(a.json, r#"{"n":4}"#);
        assert_eq!(a.rev, 3);
        // The sibling is untouched.
        assert_eq!(read_doc(&conn, "demo", "b").unwrap().unwrap().rev, 1);
        // Docs are scoped per plugin.
        assert!(read_doc(&conn, "other", "a").unwrap().is_none());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn put_without_rev_on_existing_doc_conflicts() {
        let (root, conn) = temp_store("stale");
        put_doc(&conn, "demo", "a", r#"{"n":1}"#, None).unwrap();
        let err = put_doc(&conn, "demo", "a", r#"{"n":2}"#, None).unwrap_err();
        assert!(err.starts_with("conflict:"), "{err}");
        assert!(err.contains("rev 1"), "{err}");
        // A stale rev conflicts too — and the stored body survives.
        let err = put_doc(&conn, "demo", "a", r#"{"n":3}"#, Some(7)).unwrap_err();
        assert!(err.starts_with("conflict:"), "{err}");
        assert_eq!(read_doc(&conn, "demo", "a").unwrap().unwrap().json, r#"{"n":1}"#);
        // Writing a rev for a document that never existed is a conflict.
        let err = put_doc(&conn, "demo", "ghost", r#"{}"#, Some(1)).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn remove_requires_the_rev_that_was_read() {
        let (root, conn) = temp_store("remove");
        put_doc(&conn, "demo", "a", r#"{"n":1}"#, None).unwrap();
        let err = remove_doc(&conn, "demo", "a", 4).unwrap_err();
        assert!(err.contains("rev 1"), "{err}");
        remove_doc(&conn, "demo", "a", 1).unwrap();
        assert!(read_doc(&conn, "demo", "a").unwrap().is_none());
        // Gone means gone: no tombstone, and a re-create starts at rev 1.
        assert_eq!(put_doc(&conn, "demo", "a", r#"{"n":2}"#, None).unwrap(), 1);
        let err = remove_doc(&conn, "demo", "missing", 1).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn doc_body_must_be_a_json_object_within_the_size_cap() {
        let (root, conn) = temp_store("body");
        assert!(put_doc(&conn, "demo", "a", "[1,2]", None).is_err());
        assert!(put_doc(&conn, "demo", "a", "not json", None).is_err());
        assert!(put_doc(&conn, "demo", "a", "", None).is_err());
        let big = format!("{{\"x\":\"{}\"}}", "a".repeat(MAX_DOC_BYTES));
        let err = put_doc(&conn, "demo", "a", &big, None).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn internal_doc_ids_and_bad_plugin_ids_are_refused() {
        let (root, conn) = temp_store("internal");
        for bad in ["__settings", "__storage", "__anything"] {
            let err = put_doc(&conn, "demo", bad, "{}", None).unwrap_err();
            assert!(err.contains("reserved"), "{bad}: {err}");
            assert!(remove_doc(&conn, "demo", bad, 1).is_err());
        }
        assert!(put_doc(&conn, "..\\evil", "a", "{}", None).is_err());
        assert!(put_doc(&conn, "", "a", "{}", None).is_err());
        assert!(put_doc(&conn, "demo", "", "{}", None).is_err());
        // The host itself may use them (the settings/storage docs).
        write_internal(&conn, "demo", SETTINGS_DOC, "{}").unwrap();
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn doc_limit_caps_new_documents_but_allows_updates() {
        let (root, conn) = temp_store("cap");
        for i in 0..MAX_DOCS {
            put_doc(&conn, "demo", &format!("d{i}"), "{}", None).unwrap();
        }
        let err = put_doc(&conn, "demo", "overflow", "{}", None).unwrap_err();
        assert!(err.contains("doc limit"), "{err}");
        // Updating an existing doc is still fine at the cap.
        put_doc(&conn, "demo", "d0", r#"{"n":1}"#, Some(1)).unwrap();
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn all_docs_is_id_ordered_filters_prefixes_and_hides_internal() {
        let (root, conn) = temp_store("alldocs");
        put_doc(&conn, "demo", "note:2", r#"{"n":2}"#, None).unwrap();
        put_doc(&conn, "demo", "note:10", r#"{"n":10}"#, None).unwrap();
        put_doc(&conn, "demo", "photo:1", r#"{"n":1}"#, None).unwrap();
        put_doc(&conn, "other", "note:1", "{}", None).unwrap();
        write_internal(&conn, "demo", SETTINGS_DOC, "{}").unwrap();

        let all = list_docs(&conn, "demo", "", MAX_DOCS).unwrap();
        let ids: Vec<&str> = all.iter().map(|d| d.id.as_str()).collect();
        assert_eq!(ids, ["note:10", "note:2", "photo:1"], "internal doc hidden");
        let notes = list_docs(&conn, "demo", "note:", MAX_DOCS).unwrap();
        assert_eq!(notes.len(), 2, "{:?}", notes);
        // `_`/`%` in a prefix are literal (substr comparison, not LIKE).
        assert!(list_docs(&conn, "demo", "no_e", MAX_DOCS).unwrap().is_empty());
        assert!(list_docs(&conn, "demo", "photo", MAX_DOCS).unwrap().len() == 1);
        assert_eq!(list_docs(&conn, "demo", "", 1).unwrap().len(), 1);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn bulk_docs_reports_conflicts_per_entry() {
        let (root, conn) = temp_store("bulk");
        put_doc(&conn, "demo", "a", r#"{"n":1}"#, None).unwrap();
        let batch = vec![
            BulkDocIn { doc_id: "a".into(), json: r#"{"n":9}"#.into(), rev: Some(1) },
            BulkDocIn { doc_id: "b".into(), json: r#"{"n":2}"#.into(), rev: None },
            // Stale: the first entry of this same batch already moved "a" to rev 2.
            BulkDocIn { doc_id: "a".into(), json: r#"{"n":8}"#.into(), rev: Some(1) },
            BulkDocIn { doc_id: "__settings".into(), json: "{}".into(), rev: None },
        ];
        let mut out = Vec::new();
        for d in &batch {
            match put_doc(&conn, "demo", &d.doc_id, &d.json, d.rev) {
                Ok(rev) => out.push(BulkResult { id: d.doc_id.clone(), rev: Some(rev), error: None }),
                Err(err) => out.push(BulkResult { id: d.doc_id.clone(), rev: None, error: Some(err) }),
            }
        }
        assert_eq!(out[0].rev, Some(2));
        assert_eq!(out[1].rev, Some(1));
        assert!(out[2].error.as_deref().unwrap().contains("rev 2"));
        assert!(out[3].error.as_deref().unwrap().contains("reserved"));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn legacy_storage_json_migrates_once_and_is_idempotent() {
        let root = std::env::temp_dir().join(format!("lume-pstore-mig-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let demo = root.join("plugins").join("demo");
        std::fs::create_dir_all(&demo).unwrap();
        std::fs::write(demo.join("plugin.toml"), "name = \"Demo\"\n").unwrap();
        std::fs::write(
            demo.join("storage.json"),
            r#"{"counter":"42","greeting":"\"hi\""}"#,
        )
        .unwrap();
        // A dir whose manifest id differs from the directory name.
        let odd = root.join("plugins").join("odd-dir");
        std::fs::create_dir_all(&odd).unwrap();
        std::fs::write(odd.join("plugin.toml"), "id = \"odd\"\n").unwrap();
        std::fs::write(odd.join("storage.json"), r#"{"k":"1"}"#).unwrap();
        // A junk file must not stop the run.
        let bad = root.join("plugins").join("bad");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("storage.json"), "not json").unwrap();

        let conn = open(&root).unwrap();
        assert_eq!(migrate_legacy_storage_with(&conn, &root), 2);
        assert_eq!(storage_get(&root, "demo", "counter").unwrap(), Some("42".into()));
        assert_eq!(storage_get(&root, "demo", "greeting").unwrap(), Some("\"hi\"".into()));
        // The manifest id wins over the directory name, like the old writer.
        assert_eq!(storage_get(&root, "odd", "k").unwrap(), Some("1".into()));
        assert!(demo.join("storage.json").exists() == false);
        assert!(demo.join("storage.json.migrated").exists());
        assert!(bad.join("storage.json").exists(), "unreadable file left alone");

        // Idempotent: the retired files are gone, so nothing moves again, and
        // a second call cannot resurrect the old values.
        storage_set(&root, "demo", "counter", Some("43".into())).unwrap();
        assert_eq!(migrate_legacy_storage_with(&conn, &root), 0);
        assert_eq!(storage_get(&root, "demo", "counter").unwrap(), Some("43".into()));
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn storage_shim_roundtrips_and_survives_reopen() {
        let (root, conn) = temp_store("shim");
        assert_eq!(storage_get(&root, "demo", "k").unwrap(), None);
        storage_set(&root, "demo", "k", Some("1".into())).unwrap();
        storage_set(&root, "demo", "j", Some(r#"{"a":1}"#.into())).unwrap();
        assert_eq!(storage_get(&root, "demo", "k").unwrap(), Some("1".into()));
        storage_set(&root, "demo", "k", Some("2".into())).unwrap();
        assert_eq!(storage_get(&root, "demo", "k").unwrap(), Some("2".into()));
        assert_eq!(storage_get(&root, "demo", "j").unwrap(), Some(r#"{"a":1}"#.into()));
        storage_set(&root, "demo", "j", None).unwrap();
        assert_eq!(storage_get(&root, "demo", "j").unwrap(), None);
        // The shim is one host-owned doc — invisible to db.allDocs.
        assert!(list_docs(&conn, "demo", "", MAX_DOCS).unwrap().is_empty());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn settings_defaults_merge_with_stored_values() {
        let root = std::env::temp_dir().join(format!("lume-pstore-set-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        let demo = root.join("plugins").join("demo");
        std::fs::create_dir_all(&demo).unwrap();
        std::fs::write(
            demo.join("plugin.toml"),
            "name = \"Demo\"\n\
             [[settings]]\n\
             key = \"greeting\"\n\
             label = \"Greeting\"\n\
             type = \"text\"\n\
             default = \"hello\"\n\
             \n\
             [[settings]]\n\
             key = \"count\"\n\
             label = \"Count\"\n\
             type = \"text\"\n\
             default = 3\n",
        )
        .unwrap();
        let conn = open(&root).unwrap();
        // No stored values yet → pure defaults.
        let v = settings_values_with(&conn, &root, "demo");
        assert_eq!(v.get("greeting").unwrap(), &serde_json::json!("hello"));
        assert_eq!(v.get("count").unwrap(), &serde_json::json!(3));

        settings_put(&root, "demo", "greeting", serde_json::json!("hi")).unwrap();
        let v = settings_values_with(&conn, &root, "demo");
        assert_eq!(v.get("greeting").unwrap(), &serde_json::json!("hi"));
        // An untouched key keeps its default.
        assert_eq!(v.get("count").unwrap(), &serde_json::json!(3));
        // The manifest is the schema: undeclared keys are refused.
        let err = settings_put(&root, "demo", "nope", serde_json::json!(1)).unwrap_err();
        assert!(err.contains("unknown setting"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }
}
