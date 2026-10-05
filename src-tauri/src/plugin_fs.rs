//! Plugin private files (P3.3, ROADMAP #26) — `<base>/plugins/<id>/files/`.
//!
//! A plugin's own scratch space: attachments, exports, caches. It sits inside
//! the plugin folder the user placed, so writing here needs **no** permission
//! (the plugin owns it) and the data disappears with the plugin. Reading and
//! writing arbitrary absolute paths is the `fs.read` / `fs.write` capability,
//! which the frontend permission layer gates (`PLUGIN_API.md` §9).
//!
//! A private file is addressed by **name, never by path**: the name may not
//! contain a separator (`/`, `\`, `:`), may not be `.`/`..`, and may not be a
//! reserved device name (`NUL`, `CON`, …) — on Windows `<dir>\\NUL` is the
//! null device, not a file, so a naive join would silently discard the write.

use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::paths::base_dir;
use crate::plugins::valid_plugin_id;

/// Cap for one private file (both writing and reading).
pub const MAX_PRIVATE_BYTES: usize = 10 * 1024 * 1024;
/// Cap on one `list()` answer.
pub const MAX_PRIVATE_FILES: usize = 1000;

/// One file in the plugin's private directory.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PrivateFile {
    pub name: String,
    /// Bytes.
    pub size: u64,
    /// Last write time, milliseconds since the Unix epoch (0 when unknown).
    pub mtime: i64,
}

/// `<base>/plugins/<id>/files/`.
fn private_dir(base: &Path, id: &str) -> Result<PathBuf, String> {
    if !valid_plugin_id(id) {
        return Err("invalid plugin id".into());
    }
    Ok(base.join("plugins").join(id).join("files"))
}

/// Windows device names that must never be used as a file name.
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Validate a private file name (never a path).
fn safe_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("file name is required".into());
    }
    if name.chars().count() > 120 {
        return Err("file name is too long (cap 120 characters)".into());
    }
    if name.contains(['/', '\\', ':']) {
        return Err("file name must not contain a path separator".into());
    }
    if name == "." || name == ".." || name.ends_with([' ', '.']) {
        return Err(format!("\"{name}\" is not a usable file name"));
    }
    if name.chars().any(|c| (c as u32) < 0x20) {
        return Err("file name contains a control character".into());
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(format!("\"{name}\" is a reserved device name"));
    }
    Ok(())
}

/// Resolve a private file (validating the name and the plugin id).
fn private_file(base: &Path, id: &str, name: &str) -> Result<PathBuf, String> {
    safe_name(name)?;
    Ok(private_dir(base, id)?.join(name))
}

/// Write bytes into the plugin's private directory; returns the absolute path
/// (handy for `app.openPath`, `clipboard.paste` or an `<img src>`).
fn write_private(base: &Path, id: &str, name: &str, bytes: &[u8]) -> Result<String, String> {
    if bytes.len() > MAX_PRIVATE_BYTES {
        return Err(format!(
            "file too large: {} bytes (cap {MAX_PRIVATE_BYTES})",
            bytes.len()
        ));
    }
    let path = private_file(base, id, name)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("private dir: {e}"))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("private write: {e}"))?;
    eprintln!("[plugins] fs private write ({id}) {name} ({} bytes)", bytes.len());
    Ok(path.to_string_lossy().into_owned())
}

/// List the plugin's private files (name-ordered, capped).
fn list_private(base: &Path, id: &str) -> Result<Vec<PrivateFile>, String> {
    let dir = private_dir(base, id)?;
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(Vec::new()); // no files/ yet — the quiet, normal case
    };
    let mut out: Vec<PrivateFile> = entries
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let meta = e.metadata().ok()?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            Some(PrivateFile {
                name: e.file_name().to_string_lossy().into_owned(),
                size: meta.len(),
                mtime,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out.truncate(MAX_PRIVATE_FILES);
    eprintln!("[plugins] fs private list ({id}) → {} file(s)", out.len());
    Ok(out)
}

/// Write text into `plugins/<id>/files/<name>`; returns its absolute path.
/// No permission needed — the directory belongs to the plugin.
#[tauri::command]
pub fn plugin_fs_private_write(
    id: String,
    name: String,
    text: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<String, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: fs calls need a plugin id".to_string())?;

    if text.len() > MAX_PRIVATE_BYTES {
        return Err(format!(
            "file too large: {} bytes (cap {MAX_PRIVATE_BYTES})",
            text.len()
        ));
    }
    write_private(&base_dir(), &id, &name, text.as_bytes())
}

/// Write base64 bytes into the private directory (attachments, exports).
#[tauri::command]
pub fn plugin_fs_private_write_b64(
    id: String,
    name: String,
    data: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<String, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: fs calls need a plugin id".to_string())?;

    // Strip an optional data URI prefix so an image read from the clipboard or
    // a canvas can be handed over unchanged.
    let payload = data.split_once(',').map_or(data.as_str(), |(head, rest)| {
        if head.starts_with("data:") {
            rest
        } else {
            data.as_str()
        }
    });
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload.trim())
        .map_err(|e| format!("bad base64: {e}"))?;
    write_private(&base_dir(), &id, &name, &bytes)
}

/// Read one private file as text (lossy UTF-8; binary content is for
/// `privatePath`, not for this).
#[tauri::command]
pub fn plugin_fs_private_read(
    id: String,
    name: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<String, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: fs calls need a plugin id".to_string())?;

    let path = private_file(&base_dir(), &id, &name)?;
    let meta = std::fs::metadata(&path).map_err(|e| format!("private read: {e}"))?;
    if meta.len() as usize > MAX_PRIVATE_BYTES {
        return Err(format!(
            "file too large: {} bytes (cap {MAX_PRIVATE_BYTES})",
            meta.len()
        ));
    }
    let bytes = std::fs::read(&path).map_err(|e| format!("private read: {e}"))?;
    eprintln!(
        "[plugins] fs private read ({id}) {name} ({} bytes)",
        bytes.len()
    );
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// The plugin's private files (empty when it never wrote one).
#[tauri::command]
pub fn plugin_fs_private_list(
    id: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<Vec<PrivateFile>, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: fs calls need a plugin id".to_string())?;

    list_private(&base_dir(), &id)
}

/// The absolute path of a private file without reading it — for
/// `app.openPath`, `clipboard.paste`, `search.files` or an `<img src>`.
#[tauri::command]
pub fn plugin_fs_private_path(
    id: String,
    name: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<String, String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: fs calls need a plugin id".to_string())?;

    Ok(private_file(&base_dir(), &id, &name)?
        .to_string_lossy()
        .into_owned())
}

/// Delete one private file. Deleting is idempotent: a file that was never
/// there (or already gone) is not an error.
fn remove_private(base: &Path, id: &str, name: &str) -> Result<(), String> {
    let path = private_file(base, id, name)?;
    match std::fs::remove_file(&path) {
        Ok(()) => {
            eprintln!("[plugins] fs private remove ({id}) {name}");
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("private remove: {e}")),
    }
}

/// Delete one private file (no error when it never existed).
#[tauri::command]
pub fn plugin_fs_private_remove(
    id: String,
    name: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<(), String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: fs calls need a plugin id".to_string())?;

    remove_private(&base_dir(), &id, &name)
}

/// Write text to an **arbitrary** absolute path. This is the `fs.write`
/// capability: enforced Rust-side (plugin_perm.rs) — the frontend refusal is
/// the consent layer, this is the boundary. The parent directory must exist.
#[tauri::command]
pub fn plugin_fs_write_any(
    id: String,
    path: String,
    text: String,
    window: tauri::WebviewWindow,
    host_token: Option<String>,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
    settings: tauri::State<crate::settings::SettingsState>,
) -> Result<(), String> {
let id = crate::plugin_perm::resolve_plugin_caller(&perms, &window, Some(&id), host_token.as_deref())?
        .ok_or_else(|| "permission denied: fs calls need a plugin id".to_string())?;
    crate::plugin_perm::assert_capability(
        &perms,
        &settings.current().plugins,
        &base_dir(),
        &id,
        "fs.write",
    )?;
    if text.len() > MAX_PRIVATE_BYTES {
        return Err(format!(
            "file too large: {} bytes (cap {MAX_PRIVATE_BYTES})",
            text.len()
        ));
    }
    let p = Path::new(&path);
    if !p.is_absolute() {
        return Err("fs.writeFile needs an absolute path".into());
    }
    std::fs::write(p, text.as_bytes()).map_err(|e| format!("write failed: {e}"))?;
    eprintln!(
        "[plugins] fs write ({id}) {} ({} bytes)",
        p.display(),
        text.len()
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_base(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("lume-pfs-{name}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(root.join("plugins").join("demo")).unwrap();
        root
    }

    #[test]
    fn private_files_roundtrip_and_list() {
        let base = temp_base("roundtrip");
        let path = write_private(&base, "demo", "note.txt", b"hello").unwrap();
        assert!(path.ends_with("note.txt"));
        assert!(path.contains("files"));
        write_private(&base, "demo", "b.bin", &[0xff, 0x00, 0x01]).unwrap();
        let listed = list_private(&base, "demo").unwrap();
        let names: Vec<&str> = listed.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["b.bin", "note.txt"]);
        assert_eq!(listed[1].size, 5);
        assert!(listed[0].mtime > 0);
        // No files dir yet → an empty list, not an error.
        assert!(list_private(&base, "other").unwrap().is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn private_names_cannot_escape_the_directory() {
        let base = temp_base("escape");
        for bad in [
            "..\\evil.txt",
            "../evil.txt",
            "C:evil.txt",
            "",
            ".",
            "..",
            "nul",
            "NUL.txt",
            "com1.log",
            "trailing.",
            "trailing ",
            "a/b",
        ] {
            assert!(
                private_file(&base, "demo", bad).is_err(),
                "{bad:?} must be refused"
            );
        }
        assert!(private_file(&base, "demo", "ok.txt").is_ok());
        // A bad plugin id never resolves a path either.
        assert!(private_file(&base, "..", "ok.txt").is_err());
        // A long-but-legal name is refused by the length cap, not by luck.
        assert!(private_file(&base, "demo", &"a".repeat(121)).is_err());
        // Nothing outside the private dir was touched.
        assert!(!base.join("evil.txt").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn private_write_caps_the_payload_and_remove_is_idempotent() {
        let base = temp_base("cap");
        let big = vec![b'x'; MAX_PRIVATE_BYTES + 1];
        let err = write_private(&base, "demo", "big.bin", &big).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert!(!base.join("plugins").join("demo").join("files").join("big.bin").exists());
        // Removing a file that was never written is a no-op, and an actual
        // remove really deletes.
        remove_private(&base, "demo", "gone.txt").unwrap();
        write_private(&base, "demo", "here.txt", b"x").unwrap();
        remove_private(&base, "demo", "here.txt").unwrap();
        assert!(list_private(&base, "demo").unwrap().is_empty());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn base64_payload_accepts_data_uris_and_rejects_junk() {
        // The data-URI unwrapping is what `write_b64` does before decoding.
        let uri = "data:image/png;base64,aGVsbG8=";
        let payload = uri
            .split_once(',')
            .map_or(uri, |(head, rest)| if head.starts_with("data:") { rest } else { uri });
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(payload).unwrap(),
            b"hello"
        );
        assert!(base64::engine::general_purpose::STANDARD.decode("!!!").is_err());
    }
}
