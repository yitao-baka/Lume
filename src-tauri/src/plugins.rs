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
    /// View HTML file for disk mode plugins (relative to the plugin dir;
    /// rendered in a sandboxed iframe inside the launcher page).
    #[serde(default)]
    pub view: String,
    /// Global keywords (uTools-style): typing one in Navigate search offers
    /// an 「进入 <name>」 row that opens the mode.
    #[serde(default)]
    pub keywords: Vec<String>,
    /// Mode plugins: the mode page's preferred window height (logical px).
    /// Optional — the frontend clamps it to the work area; `None` falls back
    /// to the global 设置 → 窗口大小 → 高度.
    #[serde(default)]
    pub height: Option<u32>,
    /// Mode plugins: pill icon, relative to the plugin dir.
    #[serde(default)]
    pub icon: String,
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
    /// View HTML file (disk mode plugins).
    pub view: String,
    /// Global keywords (mode plugins).
    pub keywords: Vec<String>,
    /// Mode-declared preferred window height (logical px; None = global).
    pub height: Option<u32>,
    /// Mode plugins: pill icon (relative to the plugin dir).
    pub icon: String,
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
        return out; // no plugins dir yet — the quiet, normal case
    };
    eprintln!("[plugins] scanning {}", dir.display());
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            eprintln!(
                "[plugins] scan: skipping non-directory {}",
                path.display()
            );
            continue;
        }
        let manifest = path.join("plugin.toml");
        let Ok(text) = fs::read_to_string(&manifest) else {
            eprintln!(
                "[plugins] scan: skipping {} (no readable plugin.toml)",
                path.display()
            );
            continue;
        };
        match parse_manifest(&text) {
            Ok(mut m) => {
                if m.id.is_empty() {
                    m.id = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                }
                eprintln!(
                    "[plugins] scan: found \"{}\" (kind={}, version={}) at {}",
                    m.id,
                    m.kind,
                    if m.version.is_empty() { "-" } else { &m.version },
                    path.display()
                );
                out.push(m);
            }
            Err(err) => {
                eprintln!(
                    "[plugins] scan: skipping {} — invalid plugin.toml: {err}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                );
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    eprintln!("[plugins] scan: {} disk plugin(s) discovered", out.len());
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
            view: String::new(),
            keywords: Vec::new(),
            height: None,
            icon: String::new(),
            dir: String::new(),
        })
        .collect();
    let disk = scan_disk_plugins(base);
    for m in disk {
        let dir = plugins_dir(base).join(&m.id);
        eprintln!(
            "[plugins] \"{}\" enabled={} (disabled list: {:?})",
            m.id,
            enabled(&m.id),
            disabled
        );
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
            view: m.view,
            keywords: m.keywords,
            height: m.height,
            icon: m.icon,
            dir: dir.to_string_lossy().into_owned(),
        });
    }
    eprintln!(
        "[plugins] list: {} plugin(s) total ({} builtin + {} disk, {} disabled)",
        out.len(),
        BUILTIN_PLUGINS.len(),
        out.len() - BUILTIN_PLUGINS.len(),
        disabled.len()
    );
    out
}

/// Frontend command: list built-in + discovered plugins with enabled state.
#[tauri::command]
pub fn get_plugins(state: State<SettingsState>) -> Result<Vec<PluginInfo>, String> {
    let snapshot = settings::snapshot(&state);
    Ok(list_plugins(&base_dir(), &snapshot.plugins.disabled))
}

// ── Plugin-scoped key/value storage (uTools db 风格, ROADMAP #7) ──
//
// Each disk plugin gets `<base>/plugins/<id>/storage.json` — a flat
// string→JSON map only its own id can address. Values arrive as JSON text
// (the frontend JSON-stringifies); the backend never interprets them.

fn plugin_storage_path(base: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    // Path-traversal guard: storage lives INSIDE the plugin's own dir.
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("invalid plugin id".into());
    }
    Ok(plugins_dir(base).join(id).join("storage.json"))
}

fn read_storage(path: &Path) -> std::collections::BTreeMap<String, String> {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

/// Read one key (None = unset). `key` is the exact map key.
#[tauri::command]
pub fn plugin_storage_get(
    id: String,
    key: String,
    _state: State<SettingsState>,
) -> Result<Option<String>, String> {
    plugin_storage_get_for(&base_dir(), &id, key)
}

fn plugin_storage_get_for(
    base: &Path,
    id: &str,
    key: String,
) -> Result<Option<String>, String> {
    let path = plugin_storage_path(base, id)?;
    let value = read_storage(&path).get(&key).cloned();
    match &value {
        Some(v) => eprintln!(
            "[plugins] storage get ({id}) {key} → hit ({} bytes)",
            v.len()
        ),
        None => eprintln!("[plugins] storage get ({id}) {key} → miss"),
    }
    Ok(value)
}

/// Write one key (value = JSON text; null deletes). Atomic-ish: the whole
/// map is rewritten each time (plugin storage is small by design).
#[tauri::command]
pub fn plugin_storage_set(
    id: String,
    key: String,
    value: Option<String>,
    _state: State<SettingsState>,
) -> Result<(), String> {
    plugin_storage_set_for(&base_dir(), &id, key, value)
}

fn plugin_storage_set_for(
    base: &Path,
    id: &str,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    let path = plugin_storage_path(base, id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut map = read_storage(&path);
    match &value {
        // Writes log the payload size only — values may hold user data.
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
            map.insert(key, v);
        }
        None => {
            map.remove(&key);
        }
    }
    fs::write(&path, serde_json::to_string(&map).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
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
    fn storage_roundtrip_and_traversal_guard() {
        let root = std::env::temp_dir().join(format!("lume-plugins-store-{}", std::process::id()));
        let base = root.join("plugins");
        let demo = base.join("demo");
        fs::create_dir_all(&demo).unwrap();
        let path = plugin_storage_path(&root, "demo").unwrap();
        assert_eq!(path, demo.join("storage.json"));

        // set → get → overwrite → delete
        plugin_storage_set_for(&root, "demo", "counter".into(), Some("41".into())).unwrap();
        plugin_storage_set_for(&root, "demo", "greeting".into(), Some("\"hi\"".into())).unwrap();
        assert_eq!(
            plugin_storage_get_for(&root, "demo", "counter".into()).unwrap(),
            Some("41".into())
        );
        plugin_storage_set_for(&root, "demo", "counter".to_string(), Some("42".into())).unwrap();
        assert_eq!(
            plugin_storage_get_for(&root, "demo", "counter".into()).unwrap(),
            Some("42".into())
        );
        // other keys survive an overwrite
        assert_eq!(
            plugin_storage_get_for(&root, "demo", "greeting".into()).unwrap(),
            Some("\"hi\"".into())
        );
        plugin_storage_set_for(&root, "demo", "greeting".into(), None).unwrap();
        assert_eq!(plugin_storage_get_for(&root, "demo", "greeting".into()).unwrap(), None);

        // unset key → None; path traversal ids rejected
        assert_eq!(plugin_storage_get_for(&root, "demo", "nope".into()).unwrap(), None);
        assert!(plugin_storage_path(&base, "..\\evil").is_err());
        assert!(plugin_storage_path(&base, "").is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn manifest_carries_keywords_and_view() {
        let m = parse_manifest(
            "id = \"m\"
kind = \"mode\"
view = \"view.html\"
icon = \"icon.svg\"
keywords = [\"clip\", \"剪贴板\"]
height = 560
",
        )
        .unwrap();
        assert_eq!(m.view, "view.html");
        assert_eq!(m.icon, "icon.svg");
        assert_eq!(m.keywords, vec!["clip".to_string(), "剪贴板".to_string()]);
        assert_eq!(m.height, Some(560));
        // height is optional — omitted means "use the global setting".
        assert_eq!(parse_manifest("id = \"m\"").unwrap().height, None);
        // icon is optional — omitted means "no pill image" (empty string).
        assert_eq!(parse_manifest("id = \"m\"").unwrap().icon, "");
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
