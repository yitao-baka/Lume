//! Plugin permission enforcement (Rust side) — the command-side whitelist.
//!
//! The frontend ledger (`src/plugins/permissions.ts`) is the informed-consent
//! layer: it names the missing capability and fails loudly. This module is
//! the **boundary**: every host-capability command re-checks the caller's
//! plugin id against the manifest's `permissions` here, on the Rust side of
//! the IPC — a page that escaped the sandboxed iframe into raw `invoke`
//! still has to name a plugin id that declared the capability.
//!
//! Scope, stated honestly: code running inside the launcher window (a
//! provider/service entry's logic) can invoke any command and name any id —
//! that residual risk is the standing "explicit placement = trust" decision
//! (docs/PLUGIN_API.md §9); closing it needs process isolation, not more
//! checks. What this layer buys: plugin-private data is scoped by id, and a
//! sandboxed/compromised page cannot exercise a capability no plugin
//! declared.
//!
//! Manifests are cached per id and refreshed by `get_plugins` (startup +
//! every settings-applied) and `reload_plugin`; a check for an unseen id
//! reads that plugin's manifest from disk once. Unknown ids fail closed.
//! Built-ins (clipboard/preview) are exempt — compiled into lume.exe.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::paths::base_dir;
use crate::plugins::{parse_manifest, valid_plugin_id, BUILTIN_PLUGINS};
use crate::settings::SettingsState;

#[derive(Default)]
struct CapsEntry {
    permissions: HashSet<String>,
}

/// Managed permission cache: plugin id → declared capabilities. Populated
/// lazily, invalidated by `refresh` (get_plugins) and `invalidate`
/// (reload_plugin).
#[derive(Default)]
pub struct PluginPermState {
    caps: Mutex<HashMap<String, CapsEntry>>,
}

/// Drop the whole cache (get_plugins re-scans disk anyway — piggyback on it).
pub fn refresh(state: &PluginPermState) {
    state.caps.lock().unwrap().clear();
}

/// Drop one id (settings-pane reload: the manifest may have changed).
pub fn invalidate(state: &PluginPermState, id: &str) {
    state.caps.lock().unwrap().remove(id);
}

/// The cached capability set for `id`, reading the manifest from disk on a
/// miss. `None` when no manifest matches — the caller fails closed.
fn entry_for(state: &PluginPermState, base: &Path, id: &str) -> Option<CapsEntry> {
    if let Some(e) = state.caps.lock().unwrap().get(id) {
        return Some(CapsEntry {
            permissions: e.permissions.clone(),
        });
    }
    let manifest = find_manifest(base, id)?;
    let permissions: HashSet<String> = manifest.permissions.into_iter().collect();
    state.caps.lock().unwrap().insert(
        id.to_string(),
        CapsEntry {
            permissions: permissions.clone(),
        },
    );
    Some(CapsEntry { permissions })
}

/// Locate + parse the manifest that declares `id` (or whose directory is
/// named `id` — the id defaults to the directory name). `None` when no
/// manifest matches.
fn find_manifest(base: &Path, id: &str) -> Option<crate::plugins::PluginManifest> {
    let plugins: PathBuf = base.join("plugins");
    // Direct hit: the directory named `id`.
    if let Ok(text) = std::fs::read_to_string(plugins.join(id).join("plugin.toml")) {
        if let Ok(m) = parse_manifest(&text) {
            let resolved = if m.id.is_empty() {
                id.to_string()
            } else {
                m.id.clone()
            };
            if resolved == id {
                return Some(m);
            }
        }
    }
    // Manifest id ≠ directory name: scan every directory once. One bad
    // directory must not end the search.
    for entry in std::fs::read_dir(&plugins).ok()?.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(path.join("plugin.toml")) else {
            continue;
        };
        let Ok(m) = parse_manifest(&text) else {
            continue;
        };
        let dir_name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let resolved = if m.id.is_empty() {
            dir_name
        } else {
            m.id.clone()
        };
        if resolved == id {
            return Some(m);
        }
    }
    None
}

/// The native-path rule for commands that also serve the launcher itself
/// (`file_search`, `trash_to_recycle`): a call **without** a plugin id is the
/// native pipeline and is only accepted from the main window; a call **with**
/// an id goes through the manifest check.
pub fn assert_native_or_capability(
    perms: &PluginPermState,
    settings: &SettingsState,
    window: &tauri::WebviewWindow,
    plugin_id: Option<&str>,
    cap: &str,
) -> Result<(), String> {
    match plugin_id {
        Some(id) => assert_capability(perms, &settings.current().plugins, &base_dir(), id, cap),
        None => {
            if window.label() == "main" {
                Ok(())
            } else {
                Err(format!(
                    "permission denied: \"{}\" requires a plugin id (the native path is main-window only)",
                    cap
                ))
            }
        }
    }
}

/// Fail-closed capability check: `id` must name a plugin whose manifest
/// declares `cap` (or a dev-mode trusted one). Built-ins are exempt.
pub fn assert_capability(
    perms: &PluginPermState,
    plugins: &crate::settings::Plugins,
    base: &Path,
    id: &str,
    cap: &str,
) -> Result<(), String> {
    if BUILTIN_PLUGINS.iter().any(|(bid, _, _)| *bid == id) {
        return Ok(());
    }
    if !valid_plugin_id(id) {
        return Err(format!("permission denied: invalid plugin id \"{}\"", id));
    }
    let Some(entry) = entry_for(perms, base, id) else {
        return Err(format!("permission denied: unknown plugin \"{}\"", id));
    };
    let trusted = plugins.dev_mode
        && (plugins.trust_all || plugins.trusted.iter().any(|t| t == id));
    if trusted || entry.permissions.contains(cap) {
        return Ok(());
    }
    let mut declared: Vec<&String> = entry.permissions.iter().collect();
    declared.sort();
    let declared = declared
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    eprintln!(
        "[plugins] permission denied: \"{}\" needs \"{}\" — declared: [{}]",
        id, cap, declared
    );
    Err(format!(
        "permission denied: plugin \"{}\" needs \"{}\" — declared: [{}]",
        id, cap, declared
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::Plugins;

    fn plugins() -> Plugins {
        Plugins::default()
    }

    fn plugins_with(dev_mode: bool, trust_all: bool, trusted: &[&str]) -> Plugins {
        Plugins {
            disabled: vec![],
            trusted: trusted.iter().map(|t| t.to_string()).collect(),
            dev_mode,
            trust_all,
            window_bounds: HashMap::new(),
        }
    }

    fn write_plugin(root: &Path, dir: &str, manifest: &str) {
        let p = root.join("plugins").join(dir);
        std::fs::create_dir_all(&p).unwrap();
        std::fs::write(p.join("plugin.toml"), manifest).unwrap();
    }

    #[test]
    fn declared_capability_passes_undeclared_fails() {
        let root = std::env::temp_dir().join(format!("lume-perm-{}", std::process::id()));
        write_plugin(&root, "demo", "id = \"demo\"\npermissions = [\"network\"]\n");
        let perms = PluginPermState::default();
        assert!(assert_capability(&perms, &plugins(), &root, "demo", "network").is_ok());
        let err = assert_capability(&perms, &plugins(), &root, "demo", "clipboard").unwrap_err();
        assert!(err.contains("clipboard") && err.contains("network"), "{err}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn unknown_id_and_bad_id_fail_closed() {
        let root = std::env::temp_dir().join(format!("lume-perm-unknown-{}", std::process::id()));
        let perms = PluginPermState::default();
        let err = assert_capability(&perms, &plugins(), &root, "ghost", "network").unwrap_err();
        assert!(err.contains("unknown plugin"), "{err}");
        assert!(assert_capability(&perms, &plugins(), &root, "..\\evil", "network").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn trust_all_requires_dev_mode() {
        let root = std::env::temp_dir().join(format!("lume-perm-trust-{}", std::process::id()));
        write_plugin(&root, "demo", "id = \"demo\"\n");
        let perms = PluginPermState::default();
        // trust_all without dev_mode grants nothing (mirrors get_plugins).
        assert!(
            assert_capability(&perms, &plugins_with(false, true, &[]), &root, "demo", "network")
                .is_err()
        );
        assert!(
            assert_capability(&perms, &plugins_with(true, true, &[]), &root, "demo", "network")
                .is_ok()
        );
        // Per-id trusted list, dev-mode gated too.
        assert!(
            assert_capability(
                &perms,
                &plugins_with(true, false, &["demo"]),
                &root,
                "demo",
                "clipboard"
            )
            .is_ok()
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn builtins_are_exempt() {
        let root = std::env::temp_dir().join(format!("lume-perm-builtin-{}", std::process::id()));
        let perms = PluginPermState::default();
        assert!(assert_capability(&perms, &plugins(), &root, "clipboard", "clipboard").is_ok());
        assert!(assert_capability(&perms, &plugins(), &root, "preview", "fs.read").is_ok());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn manifest_id_may_differ_from_directory_name() {
        let root = std::env::temp_dir().join(format!("lume-perm-rename-{}", std::process::id()));
        write_plugin(&root, "dir-name", "id = \"real-id\"\npermissions = [\"notify\"]\n");
        let perms = PluginPermState::default();
        assert!(assert_capability(&perms, &plugins(), &root, "real-id", "notify").is_ok());
        assert!(assert_capability(&perms, &plugins(), &root, "dir-name", "notify").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refresh_clears_the_cache() {
        let root = std::env::temp_dir().join(format!("lume-perm-refresh-{}", std::process::id()));
        write_plugin(&root, "demo", "id = \"demo\"\n");
        let perms = PluginPermState::default();
        assert!(assert_capability(&perms, &plugins(), &root, "demo", "network").is_err());
        // Manifest gains the permission; the cache must not serve the stale entry.
        write_plugin(&root, "demo", "id = \"demo\"\npermissions = [\"network\"]\n");
        assert!(assert_capability(&perms, &plugins(), &root, "demo", "network").is_err());
        refresh(&perms);
        assert!(assert_capability(&perms, &plugins(), &root, "demo", "network").is_ok());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn scan_survives_a_bad_sibling_directory() {
        let root = std::env::temp_dir().join(format!("lume-perm-scan-{}", std::process::id()));
        write_plugin(&root, "renamed", "id = \"real\"\npermissions = [\"screen\"]\n");
        let bad = root.join("plugins").join("broken");
        std::fs::create_dir_all(&bad).unwrap();
        std::fs::write(bad.join("plugin.toml"), "not = [valid").unwrap();
        let loose = root.join("plugins").join("stray.toml");
        std::fs::write(&loose, "id = \"x\"").unwrap();
        let perms = PluginPermState::default();
        // The direct lookup missed (dir ≠ id); the scan must skip broken dirs
        // and loose files without giving up.
        assert!(assert_capability(&perms, &plugins(), &root, "real", "screen").is_ok());
        std::fs::remove_dir_all(&root).ok();
    }
}
