//! `.lupx` plugin packages (P4, ROADMAP #28) — inspect, install, uninstall.
//!
//! A `.lupx` is a zip archive holding `plugin.toml` at its root (or inside a
//! single top-level directory, so "compress this folder" produces an
//! installable archive too) plus the plugin's assets. Installation is a
//! two-step UI flow: `plugin_lupx_inspect` validates the archive and reports
//! the manifest — permissions included, which makes the confirmation card the
//! informed-consent moment the permission layer always assumed — then
//! `plugin_lupx_install` extracts it into `<base>/plugins/<id>/`.
//!
//! The extraction is defensive by default: every entry name is normalized
//! (`\` → `/`, so PowerShell `Compress-Archive` archives pass) and validated
//! segment by segment (the `plugin_fs.rs` `safe_name` philosophy — no
//! absolute paths, no `..`, no reserved device names), sizes and counts are
//! capped, and the payload lands in a staging directory under `<base>/data/`
//! (never under `plugins/`, where a half-extracted manifest would be
//! discovered by the scan) before a rename swap puts it in place — the
//! previous installation is renamed aside first and restored if the swap
//! fails, so a failed upgrade never leaves the user with no plugin at all.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use zip::ZipArchive;

use crate::paths::base_dir;
use crate::plugin_sign::{verify_sign_blob, SIGN_ENTRY};
use crate::plugins::{parse_manifest, valid_plugin_id, PluginManifest};

/// Cap on one extracted file. A plugin is view HTML + a JS bundle + icons;
/// anything beyond this is not a plugin, it is a data dump.
const MAX_ENTRY_BYTES: u64 = 64 * 1024 * 1024;
/// Cap on the total uncompressed payload (decompression-bomb guard).
const MAX_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
/// Cap on archive entries (zip-file-count guard).
const MAX_ENTRIES: usize = 4096;

/// What the confirmation card shows before anything is written to disk.
#[derive(Debug, Clone, Serialize)]
pub struct LupxInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub description: String,
    pub permissions: Vec<String>,
    /// File entries in the archive (directory entries excluded).
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    /// Uncompressed payload size in bytes.
    #[serde(rename = "totalBytes")]
    pub total_bytes: u64,
    /// Version of the installed plugin with the same id, when one exists —
    /// the card shows an overwrite warning instead of a fresh install.
    #[serde(rename = "existingVersion")]
    pub existing_version: Option<String>,
    /// `LUME.SIGN` status (#32.2): `"valid"` (ed25519 signature verified) or
    /// `"unsigned"` (no signature block — the card shows the archive hash).
    /// Invalid signatures never get here: `read_lupx` refuses them outright.
    pub signature: &'static str,
    /// SHA-256 of the whole archive file (integrity display / comparing
    /// distributions).
    pub sha256: String,
}

/// One archive pass: manifest, its prefix inside the zip, payload facts.
#[derive(Debug)]
struct LupxArchive {
    manifest: PluginManifest,
    /// `""` when `plugin.toml` sits at the archive root, else the single
    /// top-level directory holding it — only entries under the prefix are
    /// extracted.
    prefix: String,
    file_count: usize,
    total_bytes: u64,
    /// A `LUME.SIGN` block was present AND verified (invalid ones error out).
    signed: bool,
    /// SHA-256 of the whole archive file (confirmation card display).
    archive_sha256: String,
}

/// One file entry of the archive: raw + normalized name, header size and the
/// content hash (feeds the LUME.SIGN verification, #32.2). Only file entries
/// are kept (dirs carry no payload).
struct Entry {
    raw: String,
    normalized: String,
    size: u64,
    hash: [u8; 32],
}

/// Windows device names that must never appear as a path segment (on Windows
/// `<dir>\NUL` is the null device, not a file).
const RESERVED_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// One archive path segment: the same guards a private-file name gets.
fn segment_ok(seg: &str) -> Result<(), String> {
    if seg.chars().count() > 120 {
        return Err("archive entry name is too long (cap 120 characters per segment)".into());
    }
    if seg.chars().any(|c| (c as u32) < 0x20) {
        return Err("archive entry name contains a control character".into());
    }
    if seg.ends_with([' ', '.']) {
        return Err(format!("\"{seg}\" is not a usable name (trailing space or dot)"));
    }
    let stem = seg.split('.').next().unwrap_or(seg).to_ascii_uppercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        return Err(format!("\"{seg}\" is a reserved device name"));
    }
    Ok(())
}

/// Normalize + validate an archive entry name into a relative `/`-separated
/// path inside the extraction root. Tolerates the quirks real-world archives
/// have (backslash separators, `./` segments, trailing slash for directories)
/// and refuses anything that could escape the root.
/// Normalize + validate one archive entry name: `\` → `/` (PowerShell
/// `Compress-Archive` archives pass), reject absolute/relative escapes,
/// reserved device names and control characters. Empty result = skip (the
/// bare root entry). Shared with the signing CLI (`plugin_sign.rs`).
pub(crate) fn normalize_entry(raw: &str) -> Result<String, String> {
    let unified = raw.replace('\\', "/");
    if unified.contains(':') {
        return Err(format!("archive entry \"{raw}\" must not be an absolute path"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for seg in unified.split('/') {
        if seg.is_empty() || seg == "." {
            continue; // double slashes, "./" noise, trailing-slash dir markers
        }
        if seg == ".." {
            return Err(format!("archive entry \"{raw}\" escapes the archive root"));
        }
        segment_ok(seg)?;
        parts.push(seg);
    }
    Ok(parts.join("/"))
}

/// Read + validate a `.lupx` archive without writing anything: locate the
/// manifest, enforce the caps, collect the payload facts (counted over the
/// entries that will actually be extracted — under the manifest's prefix —
/// so the confirmation card shows the real footprint). Trust roots come from
/// the release key const + `<base>/settings/trust-keys/`.
fn read_lupx(path: &str) -> Result<LupxArchive, String> {
    read_lupx_verified(path, &load_trust_keys(&base_dir()))
}

/// Same, with explicit trust roots (tests pass keys in memory).
fn read_lupx_verified(
    path: &str,
    trust: &[ed25519_dalek::VerifyingKey],
) -> Result<LupxArchive, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open archive: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("not a readable zip archive: {e}"))?;
    if zip.len() > MAX_ENTRIES {
        return Err(format!("archive has {} entries (cap {MAX_ENTRIES})", zip.len()));
    }
    // Pass 1: validate every name, remember where each entry lives.
    let mut entries: Vec<Entry> = Vec::with_capacity(zip.len());
    // The signature block (#32.2) travels alongside the payload — captured
    // here, excluded from the payload facts, verified after the manifest.
    let mut sign_blob: Option<String> = None;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("archive entry {i}: {e}"))?;
        let raw = entry.name().to_string();
        let normalized = normalize_entry(&raw)?;
        if normalized.is_empty() {
            continue; // the bare root entry some writers add
        }
        if normalized.eq_ignore_ascii_case(SIGN_ENTRY) {
            let mut text = String::new();
            entry
                .read_to_string(&mut text)
                .map_err(|e| format!("read {SIGN_ENTRY}: {e}"))?;
            sign_blob = Some(text);
            continue;
        }
        let is_dir = entry.is_dir();
        let size = entry.size();
        if !is_dir {
            if size > MAX_ENTRY_BYTES {
                return Err(format!(
                    "archive entry \"{raw}\" is {size} bytes (cap {MAX_ENTRY_BYTES})"
                ));
            }
            // Content hash for the signature check (streamed; the entry is
            // the reader, nothing is buffered).
            use sha2::Digest;
            let mut hasher = sha2::Sha256::new();
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = entry.read(&mut buf).map_err(|e| format!("read \"{raw}\": {e}"))?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
            }
            let hash: [u8; 32] = hasher.finalize().into();
            entries.push(Entry {
                raw,
                normalized,
                size,
                hash,
            });
        }
    }
    // Locate the manifest: archive root first, then a single top-level dir.
    let (raw_manifest, prefix) =
        if let Some(e) = entries.iter().find(|e| e.normalized == "plugin.toml") {
            (e.raw.clone(), String::new())
        } else {
            let mut in_dirs: Vec<&Entry> = entries
                .iter()
                .filter(|e| e.normalized.ends_with("/plugin.toml"))
                .collect();
            match in_dirs.len() {
                1 => {
                    let e = in_dirs.pop().unwrap();
                    let prefix = e.normalized[..e.normalized.len() - "/plugin.toml".len()]
                        .to_string();
                    (e.raw.clone(), prefix)
                }
                0 => {
                    return Err("no plugin.toml in the archive (expected at the root or in one top-level directory)".into())
                }
                _ => {
                    return Err("ambiguous archive: several top-level directories hold a plugin.toml".into())
                }
            }
        };
    let prefix_root = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    for e in &entries {
        if !prefix_root.is_empty() && !e.normalized.starts_with(&prefix_root) {
            continue; // outside the plugin's directory — never extracted
        }
        file_count += 1;
        total_bytes += e.size;
    }
    if total_bytes > MAX_TOTAL_BYTES {
        return Err(format!(
            "archive payload is {total_bytes} bytes (cap {MAX_TOTAL_BYTES})"
        ));
    }
    // Pass 2: the manifest itself.
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open archive: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("not a readable zip archive: {e}"))?;
    let mut manifest_entry = zip
        .by_name(&raw_manifest)
        .map_err(|e| format!("archive entry \"{raw_manifest}\": {e}"))?;
    let mut text = String::new();
    manifest_entry
        .read_to_string(&mut text)
        .map_err(|e| format!("read plugin.toml: {e}"))?;
    let manifest = parse_manifest(&text)?;
    if manifest.id.is_empty() {
        // An unpacked plugin can fall back to its directory name; a packaged
        // one has no directory name until we make one from the id — so the
        // manifest must carry it.
        return Err("plugin.toml must declare an id".into());
    }
    if !valid_plugin_id(&manifest.id) {
        return Err(format!(
            "plugin id \"{}\" is not usable (ASCII letters, digits, '-', '_')",
            manifest.id
        ));
    }
    // #32.2: a `LUME.SIGN` block must verify against the manifest bytes and
    // the exact file set just hashed — any mismatch hard-fails the inspect/
    // install. Unsigned archives keep the plain confirmation-card flow.
    let signed = sign_blob.is_some();
    if let Some(blob) = sign_blob {
        verify_sign_blob(&blob, text.as_bytes(), &signed_file_list(&prefix, &entries), trust)?;
    }
    // Whole-archive hash for the confirmation card (integrity display /
    // comparing distributions).
    let archive_sha256 = {
        use sha2::Digest;
        let mut file = std::fs::File::open(path).map_err(|e| format!("cannot open archive: {e}"))?;
        let mut hasher = sha2::Sha256::new();
        std::io::copy(&mut file, &mut hasher).map_err(|e| format!("hash archive: {e}"))?;
        let digest: [u8; 32] = hasher.finalize().into();
        digest.iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    Ok(LupxArchive {
        manifest,
        prefix,
        file_count,
        total_bytes,
        signed,
        archive_sha256,
    })
}

/// The accepted signing keys: the compiled-in release key (when configured)
/// plus every `*.pub` file the user dropped into `<base>/settings/trust-keys/`
/// (one base64 ed25519 public key per file — the "import a publisher's key"
/// flow needs no UI).
fn load_trust_keys(base: &Path) -> Vec<ed25519_dalek::VerifyingKey> {
    let mut out = Vec::new();
    if !crate::plugin_sign::RELEASE_PUBKEY_B64.is_empty() {
        match crate::plugin_sign::parse_pubkey_b64(crate::plugin_sign::RELEASE_PUBKEY_B64) {
            Ok(k) => out.push(k),
            Err(e) => eprintln!("[plugins] built-in release key unusable: {e}"),
        }
    }
    let dir = base.join("settings").join("trust-keys");
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().is_some_and(|x| !x.eq_ignore_ascii_case("pub")) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&p) else {
                continue;
            };
            match crate::plugin_sign::parse_pubkey_b64(&text) {
                Ok(k) => out.push(k),
                Err(err) => eprintln!("[plugins] ignoring trust key {}: {err}", p.display()),
            }
        }
    }
    out
}

/// The signed file list for one archive: normalized paths relative to the
/// manifest's prefix, name+hash pairs (must match what `plugin_sign` signs —
/// the manifest itself is covered separately as raw bytes, not listed here).
fn signed_file_list(prefix: &str, entries: &[Entry]) -> Vec<(String, [u8; 32])> {
    let prefix_root = if prefix.is_empty() {
        String::new()
    } else {
        format!("{prefix}/")
    };
    let manifest_normalized = format!("{prefix_root}plugin.toml");
    let mut files: Vec<(String, [u8; 32])> = entries
        .iter()
        .filter(|e| e.normalized != manifest_normalized)
        .filter(|e| prefix_root.is_empty() || e.normalized.starts_with(&prefix_root))
        .map(|e| {
            let rel = if prefix_root.is_empty() {
                e.normalized.clone()
            } else {
                e.normalized[prefix_root.len()..].to_string()
            };
            (rel, e.hash)
        })
        .collect();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

/// `<base>/data/install-staging/` — extraction happens here, out of the
/// scanner's sight (`plugins/` is scanned for `plugin.toml` directories, and
/// a half-extracted archive would be discovered as a broken plugin).
fn staging_root(base: &Path) -> PathBuf {
    base.join("data").join("install-staging")
}

/// Remove stale staging/backup directories (called at startup — a crash or
/// killed process mid-install must not leave junk under `data/`).
pub fn cleanup_staging(base: &Path) {
    let root = staging_root(base);
    if root.exists() {
        if let Err(e) = std::fs::remove_dir_all(&root) {
            eprintln!("[plugins] install staging cleanup failed: {e}");
        }
    }
}

/// Extract the archive's in-prefix entries under `staging`. Returns the
/// extracted file count and byte total (the archive's real payload, which the
/// confirmation card should show).
fn extract_to(source_path: &str, prefix: &str, staging: &Path) -> Result<(usize, u64), String> {
    let file = std::fs::File::open(source_path).map_err(|e| format!("cannot open archive: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("not a readable zip archive: {e}"))?;
    let mut files = 0usize;
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("archive entry {i}: {e}"))?;
        let raw = entry.name().to_string();
        let normalized = normalize_entry(&raw)?;
        if normalized.is_empty() || entry.is_dir() {
            continue;
        }
        let relative = if prefix.is_empty() {
            normalized
        } else {
            match normalized.strip_prefix(&format!("{prefix}/")) {
                Some(rest) => rest.to_string(),
                None => continue, // outside this plugin's directory — ignored
            }
        };
        let target = staging.join(&relative);
        if let Some(dir) = target.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("create dir: {e}"))?;
        }
        let mut out = std::fs::File::create(&target).map_err(|e| format!("create file: {e}"))?;
        std::io::copy(&mut entry, &mut out).map_err(|e| format!("extract \"{relative}\": {e}"))?;
        files += 1;
        total += entry.size();
    }
    Ok((files, total))
}

/// Swap a fully-extracted `staging` directory into `<base>/plugins/<id>/`,
/// replacing an existing installation. The old installation is renamed aside
/// first; if the final rename fails it is renamed back — a failed upgrade
/// must not leave the user with no plugin at all.
fn swap_installed(base: &Path, staging: &Path, id: &str) -> Result<(), String> {
    let target = base.join("plugins").join(id);
    let backup = staging
        .parent()
        .ok_or("staging has no parent directory")?
        .join(format!("{id}-old-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&backup);
    if target.exists() {
        if let Err(e) = std::fs::rename(&target, &backup) {
            return Err(format!(
                "cannot move the installed plugin aside (is Lume holding it open?): {e}"
            ));
        }
    }
    if let Err(e) = std::fs::rename(staging, &target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        return Err(format!("install failed: {e}"));
    }
    let _ = std::fs::remove_dir_all(&backup);
    Ok(())
}

/// The version of the already-installed plugin with this id (direct lookup —
/// an install always names the directory after the id), used by the
/// confirmation card to tell an overwrite from a fresh install.
fn existing_version(base: &Path, id: &str) -> Option<String> {
    let text = std::fs::read_to_string(base.join("plugins").join(id).join("plugin.toml")).ok()?;
    let m = parse_manifest(&text).ok()?;
    let resolved = if m.id.is_empty() { id.to_string() } else { m.id };
    if resolved == id {
        Some(m.version)
    } else {
        None
    }
}

/// Inspect a `.lupx` archive: validate + report the manifest and payload
/// facts for the confirmation card. Nothing is written.
#[tauri::command]
pub fn plugin_lupx_inspect(source_path: String) -> Result<LupxInfo, String> {
    let base = base_dir();
    let arch = read_lupx(&source_path)?;
    Ok(LupxInfo {
        id: arch.manifest.id.clone(),
        name: arch.manifest.name.clone(),
        version: arch.manifest.version.clone(),
        kind: arch.manifest.kind.clone(),
        description: arch.manifest.description.clone(),
        permissions: arch.manifest.permissions.clone(),
        file_count: arch.file_count,
        total_bytes: arch.total_bytes,
        existing_version: existing_version(&base, &arch.manifest.id),
        signature: if arch.signed { "valid" } else { "unsigned" },
        sha256: arch.archive_sha256,
    })
}

/// Validate + extract + swap a `.lupx` into `<base>/plugins/<id>/`, replacing
/// an existing installation. Returns the installed id and the real payload
/// facts. (Split from the command so tests can drive it without an app.)
fn install_into(base: &Path, source_path: &str) -> Result<(String, usize, u64), String> {
    // Trust roots come from `base` — the caller's data dir, not whatever the
    // process-wide `base_dir()` happens to be (tests drive other bases).
    let arch = read_lupx_verified(source_path, &load_trust_keys(base))?;
    let id = arch.manifest.id.clone();
    let plugins = base.join("plugins");
    std::fs::create_dir_all(&plugins).map_err(|e| format!("create plugins dir: {e}"))?;
    let staging_root = staging_root(base);
    std::fs::create_dir_all(&staging_root).map_err(|e| format!("create staging dir: {e}"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let staging = staging_root.join(format!("{id}-{stamp}"));
    let (files, total) = extract_to(source_path, &arch.prefix, &staging)?;
    if files == 0 {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("archive holds no files for this plugin".into());
    }
    if let Err(e) = swap_installed(base, &staging, &id) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(e);
    }
    eprintln!(
        "[plugins] installed \"{id}\" ({} file(s), {total} bytes) from {source_path}",
        files
    );
    Ok((id, files, total))
}

/// Install a `.lupx` archive. The frontend confirmation happens between
/// `plugin_lupx_inspect` and this call. After the swap the launcher is told
/// twice: `settings-applied` refreshes the manifest list, `plugin-reload`
/// makes an already-loaded module re-import from the new files (an upgrade
/// takes effect without a restart).
#[tauri::command]
pub fn plugin_lupx_install(
    source_path: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<LupxInfo, String> {
    crate::plugin_perm::deny_from_plugin_windows(&window)?;
    use tauri::Emitter;
    let base = base_dir();
    let (id, file_count, total_bytes) = install_into(&base, &source_path)?;
    crate::plugin_perm::invalidate(&perms, &id);
    let info = read_lupx(&source_path)?;
    app.emit("settings-applied", ()).map_err(|e| e.to_string())?;
    app.emit("plugin-reload", id.clone()).map_err(|e| e.to_string())?;
    Ok(LupxInfo {
        id: info.manifest.id,
        name: info.manifest.name,
        version: info.manifest.version,
        kind: info.manifest.kind,
        description: info.manifest.description,
        permissions: info.manifest.permissions,
        file_count,
        total_bytes,
        existing_version: None, // installed by now; the card is gone
        signature: if info.signed { "valid" } else { "unsigned" },
        sha256: info.archive_sha256,
    })
}

/// Remove one installed plugin's directory (the pure part of uninstall —
/// split out so tests can drive it without an app). A missing directory is
/// not an error — deleting twice is a no-op.
fn uninstall_dir(base: &Path, id: &str) -> Result<(), String> {
    if !valid_plugin_id(id) {
        return Err("invalid plugin id".into());
    }
    let target = base.join("plugins").join(id);
    match std::fs::remove_dir_all(&target) {
        Ok(()) => eprintln!("[plugins] uninstalled \"{id}\""),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("uninstall failed: {e}")),
    }
    Ok(())
}

/// Uninstall a disk plugin: remove `<base>/plugins/<id>/` (its private
/// `files/` goes with it — it lives inside the plugin directory by design;
/// the document store in `data/plugin_store.db` is kept).
#[tauri::command]
pub fn plugin_uninstall(
    id: String,
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    perms: tauri::State<crate::plugin_perm::PluginPermState>,
) -> Result<(), String> {
    crate::plugin_perm::deny_from_plugin_windows(&window)?;
    use tauri::Emitter;
    uninstall_dir(&base_dir(), &id)?;
    crate::plugin_perm::invalidate(&perms, &id);
    app.emit("settings-applied", ()).map_err(|e| e.to_string())?;
    app.emit("plugin-reload", id).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Build a zip in a temp dir; entries as (name, bytes). Returns its path.
    /// Tests run in parallel — the name gets a process-wide counter so two
    /// make_zip calls never share a file.
    fn make_zip(name: &str, entries: &[(&str, &[u8])]) -> String {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let path = std::env::temp_dir().join(format!(
            "lume-lupx-{name}-{}-{}.zip",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let file = std::fs::File::create(&path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts: zip::write::SimpleFileOptions = Default::default();
        for (entry_name, bytes) in entries {
            zip.start_file(*entry_name, opts).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
        path.to_string_lossy().into_owned()
    }

    const MANIFEST: &[u8] = b"id = \"demo\"\nname = \"Demo\"\nversion = \"1.0.0\"\nkind = \"provider\"\npermissions = [\"network\"]\n";

    fn temp_base(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("lume-lupx-{tag}-{}", std::process::id()));
        std::fs::remove_dir_all(&root).ok();
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn entry_names_cannot_escape_or_spoof() {
        assert_eq!(normalize_entry("a/b.txt").unwrap(), "a/b.txt");
        assert_eq!(normalize_entry("a\\b.txt").unwrap(), "a/b.txt");
        assert_eq!(normalize_entry("./x/./y.txt").unwrap(), "x/y.txt");
        // A leading slash stays inside the extraction root — normalized away,
        // not treated as absolute.
        assert_eq!(normalize_entry("/abs.txt").unwrap(), "abs.txt");
        assert_eq!(normalize_entry("dir/").unwrap(), "dir");
        for bad in [
            "C:/evil.txt",
            "../evil.txt",
            "a/../../evil.txt",
            "a/..\\evil.txt",
            "nul.txt",
            "CON",
            "trailing.",
            "trailing ",
        ] {
            assert!(normalize_entry(bad).is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn inspect_reports_manifest_and_facts_from_root_and_subdir_archives() {
        // plugin.toml at the archive root.
        let zip = make_zip(
            "root",
            &[
                ("plugin.toml", MANIFEST),
                ("main.js", b"export default {};".as_slice()),
                ("icons/icon.svg", b"<svg/>".as_slice()),
            ],
        );
        let info = plugin_lupx_inspect(zip).unwrap();
        assert_eq!(info.id, "demo");
        assert_eq!(info.version, "1.0.0");
        assert_eq!(info.kind, "provider");
        assert_eq!(info.permissions, vec!["network".to_string()]);
        assert_eq!(info.file_count, 3);
        assert!(info.existing_version.is_none());
        // plugin.toml inside a single top-level directory (right-click
        // "compress folder" shape) — same result.
        let zip = make_zip(
            "subdir",
            &[
                ("demo/plugin.toml", MANIFEST),
                ("demo/main.js", b"export default {};".as_slice()),
            ],
        );
        let info = plugin_lupx_inspect(zip).unwrap();
        assert_eq!(info.id, "demo");
        assert_eq!(info.file_count, 2);
    }

    #[test]
    fn inspect_rejects_broken_and_hostile_archives() {
        let no_manifest = make_zip("nomanifest", &[("main.js", b"x".as_slice())]);
        assert!(plugin_lupx_inspect(no_manifest).unwrap_err().contains("no plugin.toml"));
        let no_id = make_zip("noid", &[("plugin.toml", b"name = \"no id\"\n".as_slice())]);
        assert!(plugin_lupx_inspect(no_id).unwrap_err().contains("must declare an id"));
        let bad_id = make_zip(
            "badid",
            &[("plugin.toml", b"id = \"..\\\\evil\"\n".as_slice())],
        );
        assert!(plugin_lupx_inspect(bad_id).unwrap_err().contains("not usable"));
        let bad_manifest = make_zip("badtoml", &[("plugin.toml", b"not = [valid".as_slice())]);
        assert!(plugin_lupx_inspect(bad_manifest).unwrap_err().contains("invalid plugin.toml"));
        let ambiguous = make_zip(
            "ambiguous",
            &[("a/plugin.toml", MANIFEST), ("b/plugin.toml", MANIFEST)],
        );
        assert!(plugin_lupx_inspect(ambiguous).unwrap_err().contains("ambiguous"));
        assert!(plugin_lupx_inspect("Z:/definitely/not/there.lupx".to_string())
            .unwrap_err()
            .contains("cannot open"));
    }

    #[test]
    fn install_swaps_into_place_and_upgrades() {
        let base = temp_base("swap");
        let v1 = make_zip(
            "v1",
            &[
                ("plugin.toml", MANIFEST),
                ("main.js", b"export default {}; version=1;".as_slice()),
            ],
        );
        let (id, files, _) = install_into(&base, &v1).unwrap();
        assert_eq!(id, "demo");
        assert_eq!(files, 2);
        assert!(base.join("plugins").join("demo").join("main.js").exists());
        assert_eq!(existing_version(&base, "demo").as_deref(), Some("1.0.0"));
        // Upgrade: v2 replaces v1, and no staging junk is left behind.
        let v2 = make_zip(
            "v2",
            &[
                ("plugin.toml", b"id = \"demo\"\nversion = \"2.0.0\"\n".as_slice()),
                ("main.js", b"export default {}; version=2;".as_slice()),
            ],
        );
        install_into(&base, &v2).unwrap();
        let text =
            std::fs::read_to_string(base.join("plugins").join("demo").join("plugin.toml")).unwrap();
        assert!(text.contains("2.0.0"), "{text}");
        assert_eq!(
            std::fs::read_dir(staging_root(&base)).unwrap().count(),
            0,
            "staging must be empty after a successful swap"
        );
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_file(v1).ok();
        std::fs::remove_file(v2).ok();
    }

    #[test]
    fn failed_swap_restores_the_previous_installation() {
        let base = temp_base("restore");
        let v1 = make_zip("v1", &[("plugin.toml", MANIFEST), ("main.js", b"v1".as_slice())]);
        install_into(&base, &v1).unwrap();
        // Force the final rename to fail deterministically: the staging
        // directory does not exist. The v1 installation must come back.
        let missing = staging_root(&base).join("demo-missing-staging");
        let err = swap_installed(&base, &missing, "demo").unwrap_err();
        assert!(err.contains("install failed"), "{err}");
        let text =
            std::fs::read_to_string(base.join("plugins").join("demo").join("plugin.toml")).unwrap();
        assert!(text.contains("1.0.0"), "previous install restored: {text}");
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_file(v1).ok();
    }

    #[test]
    fn subdir_archive_extracts_only_its_own_directory() {
        let base = temp_base("prefix");
        // A stray file OUTSIDE the plugin's top-level dir must not land.
        let zip = make_zip(
            "stray",
            &[
                ("demo/plugin.toml", MANIFEST),
                ("demo/main.js", b"export default {};".as_slice()),
                ("README.txt", b"not part of the plugin".as_slice()),
            ],
        );
        let (id, files, _) = install_into(&base, &zip).unwrap();
        assert_eq!(id, "demo");
        assert_eq!(files, 2, "README.txt must be ignored");
        assert!(!base.join("plugins").join("README.txt").exists());
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_file(zip).ok();
    }

    #[test]
    fn uninstall_removes_the_directory_and_is_idempotent() {
        let base = temp_base("uninstall");
        let zip = make_zip("v1", &[("plugin.toml", MANIFEST), ("main.js", b"v1".as_slice())]);
        install_into(&base, &zip).unwrap();
        assert!(base.join("plugins").join("demo").exists());
        uninstall_dir(&base, "demo").unwrap();
        assert!(!base.join("plugins").join("demo").exists());
        uninstall_dir(&base, "demo").unwrap(); // gone twice is fine
        assert!(uninstall_dir(&base, "..\\evil").is_err());
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_file(zip).ok();
    }

    // ── #32.2 LUME.SIGN 签名 ──

    fn test_signing_key(seed_byte: u8) -> ed25519_dalek::SigningKey {
        use base64::Engine;
        crate::plugin_sign::parse_seed_b64(&base64::engine::general_purpose::STANDARD.encode(
            [seed_byte; 32],
        ))
        .unwrap()
    }

    /// Rewrite one entry of a zip (simulating post-signature tampering).
    fn rebuild_zip_with(path: &str, entry_name: &str, bytes: &[u8]) -> String {
        let f = std::fs::File::open(path).unwrap();
        let mut z = ZipArchive::new(f).unwrap();
        let out_path = std::env::temp_dir().join(format!(
            "lume-lupx-tampered-{}-{}.zip",
            std::process::id(),
            path.chars().filter(|c| c.is_ascii_digit()).take(6).collect::<String>()
        ));
        let out_f = std::fs::File::create(&out_path).unwrap();
        let mut out = zip::ZipWriter::new(out_f);
        let opts: zip::write::SimpleFileOptions = Default::default();
        for i in 0..z.len() {
            let mut e = z.by_index(i).unwrap();
            let n = e.name().to_string();
            out.start_file(n.as_str(), opts).unwrap();
            if n == entry_name {
                std::io::Write::write_all(&mut out, bytes).unwrap();
            } else {
                std::io::copy(&mut e, &mut out).unwrap();
            }
        }
        out.finish().unwrap();
        out_path.to_string_lossy().into_owned()
    }

    #[test]
    fn lupx_signature_round_trip_and_prefix_paths() {
        // Top-level dir layout exercises the prefix-relative signed names.
        let zip = make_zip(
            "sig",
            &[
                ("demo/plugin.toml", MANIFEST),
                ("demo/main.js", b"export default { search: () => [] }".as_slice()),
                ("demo/res/icon.svg", b"<svg/>".as_slice()),
            ],
        );
        let key = test_signing_key(7);
        crate::plugin_sign::sign_archive(Path::new(&zip), &key).unwrap();
        let trust = vec![key.verifying_key()];
        let arch = read_lupx_verified(&zip, &trust).unwrap();
        assert!(arch.signed);
        assert_eq!(arch.file_count, 3); // plugin.toml + main.js + icon; LUME.SIGN not payload
        assert_eq!(arch.archive_sha256.len(), 64);
        std::fs::remove_file(zip).ok();
    }

    #[test]
    fn lupx_tampered_payload_or_untrusted_key_is_refused() {
        let zip = make_zip(
            "tamper",
            &[("plugin.toml", MANIFEST), ("main.js", b"v1".as_slice())],
        );
        let key = test_signing_key(8);
        crate::plugin_sign::sign_archive(Path::new(&zip), &key).unwrap();
        let trust = vec![key.verifying_key()];

        // A flipped payload byte after signing → refused.
        let tampered = rebuild_zip_with(&zip, "main.js", b"v2");
        let err = read_lupx_verified(&tampered, &trust).unwrap_err();
        assert!(err.contains("does not match the signed list"), "{err}");

        // A different signer's key is not trusted → refused even unmodified.
        let zip2 = make_zip(
            "untrusted",
            &[("plugin.toml", MANIFEST), ("main.js", b"v1".as_slice())],
        );
        let other = test_signing_key(9);
        crate::plugin_sign::sign_archive(Path::new(&zip2), &other).unwrap();
        let err = read_lupx_verified(&zip2, &trust).unwrap_err();
        assert!(err.contains("not trusted"), "{err}");

        // The untampered archive with the right key still passes.
        assert!(read_lupx_verified(&zip, &trust).unwrap().signed);
        for f in [zip, tampered, zip2] {
            std::fs::remove_file(f).ok();
        }
    }

    #[test]
    fn lupx_unsigned_still_installs_with_hash_shown() {
        let base = temp_base("unsigned");
        let zip = make_zip("unsigned2", &[("plugin.toml", MANIFEST), ("main.js", b"v1".as_slice())]);
        let arch = read_lupx(&zip).unwrap();
        assert!(!arch.signed);
        assert_eq!(arch.archive_sha256.len(), 64);
        install_into(&base, &zip).unwrap();
        assert!(base.join("plugins").join("demo").exists());
        std::fs::remove_dir_all(&base).ok();
        std::fs::remove_file(zip).ok();
    }

    #[test]
    fn trust_keys_directory_grants_verification() {
        // The end-to-end shape: `lume --sign-lupx` (sign_archive) writes the
        // blob; the user drops the .pub into settings/trust-keys/; read_lupx
        // (via load_trust_keys) verifies and the install flows through.
        use base64::Engine;
        let base = temp_base("trustkeys");
        let key = test_signing_key(11);
        let key_dir = base.join("settings").join("trust-keys");
        std::fs::create_dir_all(&key_dir).unwrap();
        std::fs::write(
            key_dir.join("publisher.pub"),
            base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes()),
        )
        .unwrap();

        let zip = make_zip(
            "trusted",
            &[("plugin.toml", MANIFEST), ("main.js", b"v1".as_slice())],
        );
        crate::plugin_sign::sign_archive(Path::new(&zip), &key).unwrap();

        // Without the key directory the same archive is untrusted.
        let zip2 = make_zip(
            "trusted2",
            &[("plugin.toml", MANIFEST), ("main.js", b"v1".as_slice())],
        );
        crate::plugin_sign::sign_archive(Path::new(&zip2), &key).unwrap();
        let empty = temp_base("trustkeys-empty");
        assert!(read_lupx_verified(&zip2, &load_trust_keys(&empty)).is_err());
        std::fs::remove_dir_all(&empty).ok();

        let trust = load_trust_keys(&base);
        assert_eq!(trust.len(), 1);
        let arch = read_lupx_verified(&zip, &trust).unwrap();
        assert!(arch.signed);
        install_into(&base, &zip).unwrap();
        assert!(base.join("plugins").join("demo").join("main.js").exists());
        std::fs::remove_dir_all(&base).ok();
        for f in [zip, zip2] {
            std::fs::remove_file(f).ok();
        }
    }
}
