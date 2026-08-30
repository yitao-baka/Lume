//! Plugin system (ROADMAP #7, v1) — discovery + registry.
//!
//! A plugin is a manifest (`plugin.toml`) plus one or more *contributions*.
//! v1 contributions live in the frontend registry (`src/plugins/`): a `mode`
//! contribution owns a full launcher page (query + view + key handling — the
//! clipboard is the first one), a `preview` service owns the satellite
//! preview window routing.
//!
//! Built-in plugins (clipboard, preview) are compiled into lume.exe but go
//! through the same registry/enabled-set path as on-disk plugins: every
//! subdirectory of `<base>/plugins/` holding a `plugin.toml` is discovered
//! and merged here. The manifest's `permissions` field is reserved (v1 does
//! not enforce it) so a future third-party loader has the surface ready.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::State;

use crate::paths::base_dir;
use crate::settings::{self, SettingsState};

/// A plugin manifest, parsed from `<base>/plugins/<id>/plugin.toml`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PluginManifest {
    /// Unique plugin id (defaults to the containing directory name).
    #[serde(default)]
    pub id: String,
    /// Display name (frontend falls back to the id when empty).
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    /// `mode` | `service` | `provider` (v1 enforces nothing — informational).
    #[serde(default = "default_kind")]
    pub kind: String,
    #[serde(default)]
    pub description: String,
    /// Reserved for the future permission model.
    #[serde(default)]
    pub permissions: Vec<String>,
    /// Entry JS file for disk provider plugins (relative to the plugin dir).
    #[serde(default)]
    pub entry: String,
}

fn default_kind() -> String {
    "mode".into()
}

/// A plugin as reported to the frontend: manifest merged with runtime state.
#[derive(Debug, Clone, Serialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub kind: String,
    pub description: String,
    pub permissions: Vec<String>,
    /// Built into lume.exe (vs discovered under `<base>/plugins/`).
    pub builtin: bool,
    /// True unless the id is in `settings.plugins.disabled`.
    pub enabled: bool,
    /// Entry JS file (disk provider plugins).
    pub entry: String,
    /// Absolute plugin directory (disk plugins; empty for built-ins).
    pub dir: String,
}

/// The compiled-in first-party plugins. Their UI/logic lives under
/// `src/plugins/<id>/` in the frontend; the ids are the stable contract.
pub const BUILTIN_PLUGINS: &[(&str, &str, &str)] = &[
    ("clipboard", "剪贴板历史", "mode"),
    ("preview", "卫星预览", "service"),
];

/// The plugins directory: `<base>/plugins/`.
fn plugins_dir(base: &Path) -> std::path::PathBuf {
    base.join("plugins")
}

/// Parse one `plugin.toml` (small standalone parse so tests don't need the
/// full settings machinery).
fn parse_manifest(text: &str) -> Result<PluginManifest, String> {
    toml::from_str(text).map_err(|e| format!("invalid plugin.toml: {e}"))
}

/// Discover on-disk plugin manifests under `<base>/plugins/*/plugin.toml`.
/// A directory whose manifest fails to parse is skipped (bad plugins must
/// never break the launcher); the id falls back to the directory name.
fn scan_disk_plugins(base: &Path) -> Vec<PluginManifest> {
    let dir = plugins_dir(base);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = path.join("plugin.toml");
        let Ok(text) = fs::read_to_string(&manifest) else {
            continue;
        };
        match parse_manifest(&text) {
            Ok(mut m) => {
                if m.id.is_empty() {
                    m.id = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                }
                out.push(m);
            }
            Err(err) => {
                eprintln!(
                    "[plugins] skipping {}: {err}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                );
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

/// Built-ins + on-disk plugins, annotated with the effective enabled state.
pub fn list_plugins(base: &Path, disabled: &[String]) -> Vec<PluginInfo> {
    let enabled = |id: &str| !disabled.iter().any(|d| d == id);
    let mut out: Vec<PluginInfo> = BUILTIN_PLUGINS
        .iter()
        .map(|(id, name, kind)| PluginInfo {
            id: id.to_string(),
            name: name.to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
            kind: kind.to_string(),
            description: String::new(),
            permissions: Vec::new(),
            builtin: true,
            enabled: enabled(id),
            entry: String::new(),
            dir: String::new(),
        })
        .collect();
    for m in scan_disk_plugins(base) {
        let dir = plugins_dir(base).join(&m.id);
        out.push(PluginInfo {
            id: m.id.clone(),
            name: m.name,
            version: m.version,
            kind: m.kind,
            description: m.description,
            permissions: m.permissions,
            builtin: false,
            enabled: enabled(&m.id),
            entry: m.entry,
            dir: dir.to_string_lossy().into_owned(),
        });
    }
    out
}

/// Frontend command: list built-in + discovered plugins with enabled state.
#[tauri::command]
pub fn get_plugins(state: State<SettingsState>) -> Result<Vec<PluginInfo>, String> {
    let snapshot = settings::snapshot(&state);
    Ok(list_plugins(&base_dir(), &snapshot.plugins.disabled))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_parses_minimal_and_full() {
        let m = parse_manifest("id = \"hello\"\n").unwrap();
        assert_eq!(m.id, "hello");
        assert_eq!(m.kind, "mode");
        assert!(m.permissions.is_empty());
        let m = parse_manifest(
            "id = \"demo\"\nname = \"Demo\"\nversion = \"0.1.0\"\nkind = \"provider\"\ndescription = \"d\"\npermissions = [\"fs-read\"]\n",
        )
        .unwrap();
        assert_eq!(m.kind, "provider");
        assert_eq!(m.permissions, vec!["fs-read".to_string()]);
        // A manifest without `id` is valid — the directory name fills in.
        assert_eq!(parse_manifest("name = \"no id\"").unwrap().id, "");
    }

    #[test]
    fn scan_skips_bad_and_binds_dir_name() {
        let root = std::env::temp_dir().join(format!("lume-plugins-test-{}", std::process::id()));
        let base = root.join("plugins");
        let good = base.join("demo");
        fs::create_dir_all(&good).unwrap();
        fs::write(good.join("plugin.toml"), "name = \"Demo\"\n").unwrap();
        let bad = base.join("broken");
        fs::create_dir_all(&bad).unwrap();
        fs::write(bad.join("plugin.toml"), "not = [valid").unwrap();
        let loose = base.join("loose-file.toml");
        fs::write(&loose, "id = \"x\"").unwrap();

        let found = scan_disk_plugins(&root);
        assert_eq!(found.len(), 1, "bad manifest skipped, files ignored");
        assert_eq!(found[0].id, "demo", "id falls back to the directory name");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn list_merges_builtins_and_disk_with_disabled_set() {
        let root = std::env::temp_dir().join(format!("lume-plugins-list-{}", std::process::id()));
        let base = root.join("plugins");
        let demo = base.join("demo");
        fs::create_dir_all(&demo).unwrap();
        fs::write(demo.join("plugin.toml"), "id = \"demo\"\nname = \"Demo\"\n").unwrap();
        let disabled = vec!["preview".to_string()];
        let all = list_plugins(&root, &disabled);
        let ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"clipboard") && ids.contains(&"preview") && ids.contains(&"demo"));
        let preview = all.iter().find(|p| p.id == "preview").unwrap();
        assert!(preview.builtin && !preview.enabled);
        let demo = all.iter().find(|p| p.id == "demo").unwrap();
        assert!(!demo.builtin && demo.enabled && demo.name == "Demo");
        fs::remove_dir_all(&root).ok();
    }
}
