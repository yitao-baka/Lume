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

use crate::cache::pinyin_for;
use crate::paths::base_dir;
use crate::settings::{self, SettingsState};

/// Per-keyword pinyin search aids, computed by the backend at scan time so
/// the frontend can match a typed query against Chinese keywords without a
/// pinyin library ("miao"/"ms" → 「秒搜」). Not part of the manifest —
/// `plugin.toml` never carries these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct KeywordPinyin {
    /// Lowercased full pinyin of the keyword.
    pub full: String,
    /// Lowercased pinyin initials.
    pub initials: String,
}

/// One declarative entry rule (uTools-style feature, ROADMAP #25): a query the
/// rule matches offers an 「<label>」 row in Navigate whose activation enters
/// the plugin with the query text as payload.
///
/// The `regex` pattern is matched by the **frontend** (JS `RegExp`, compiled
/// once per plugin/rule) — the backend only carries it. TOML spelling is
/// snake_case (`min_length`), the JSON the frontend sees is camelCase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PluginFeature {
    /// Unique code inside the plugin; delivered on enter (payload `code`).
    #[serde(default)]
    pub code: String,
    /// Row label. Empty → the plugin name is used.
    #[serde(default)]
    pub label: String,
    /// Regex matched against the query text (case-insensitive).
    #[serde(default)]
    pub regex: String,
    /// Match any non-empty text (used when `regex` is empty).
    #[serde(default)]
    pub over: bool,
    /// Optional query-length bounds (chars).
    #[serde(default, rename(serialize = "minLength", deserialize = "min_length"))]
    pub min_length: Option<usize>,
    #[serde(default, rename(serialize = "maxLength", deserialize = "max_length"))]
    pub max_length: Option<usize>,
    /// Optional row icon (relative to the plugin dir; resolved like `icon`).
    #[serde(default)]
    pub icon: String,
}

/// One `select` choice (P3.4). `label` falls back to `value`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SettingsOption {
    #[serde(default)]
    pub value: String,
    #[serde(default)]
    pub label: String,
}

/// One declarative plugin setting (`[[settings]]` in the manifest, P3.4): the
/// settings pane renders these automatically and the values live in the
/// plugin's `__settings` document. **The manifest is the schema** — a key that
/// is not declared here can never be written (`plugin_settings_put` refuses
/// it), so a renamed key cannot leave stale values behind forever.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct PluginSetting {
    /// The key the plugin reads (`ctx.settings.get(key)`).
    #[serde(default)]
    pub key: String,
    /// Pane label (author-localized; empty → the key is shown).
    #[serde(default)]
    pub label: String,
    /// Input kind: `"toggle"` | `"select"` | `"text"`. Anything else is
    /// treated as text by the pane.
    #[serde(default = "default_setting_type", rename = "type")]
    pub input: String,
    /// Value used until the user changes it (any TOML value that maps to JSON).
    #[serde(default)]
    pub default: Option<toml::Value>,
    /// `select` choices.
    #[serde(default)]
    pub options: Vec<SettingsOption>,
}

fn default_setting_type() -> String {
    "text".into()
}

/// One setting as the frontend receives it: `default` converted to JSON so
/// the pane (and the plugin) see a plain value.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PluginSettingInfo {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub input: String,
    #[serde(rename = "default")]
    pub default_value: serde_json::Value,
    pub options: Vec<SettingsOption>,
}

impl PluginSetting {
    /// Frontend shape (JSON `default`; a datetime default serializes as its
    /// string form, which is what a text input can show anyway).
    pub fn info(&self) -> PluginSettingInfo {
        PluginSettingInfo {
            key: self.key.clone(),
            label: if self.label.is_empty() {
                self.key.clone()
            } else {
                self.label.clone()
            },
            input: self.input.clone(),
            default_value: self
                .default
                .as_ref()
                .and_then(|v| serde_json::to_value(v).ok())
                .unwrap_or(serde_json::Value::Null),
            options: self.options.clone(),
        }
    }
}

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
    /// Declarative entry rules (any kind) — a matched query offers an
    /// 「<label>」 row that enters the plugin with the query as payload.
    #[serde(default)]
    pub features: Vec<PluginFeature>,
    /// Declarative settings (P3.4) — the settings pane renders these and the
    /// values live in the plugin's `__settings` document.
    #[serde(default)]
    pub settings: Vec<PluginSetting>,
    /// Development flag: the frontend registry reloads the plugin from disk
    /// on every refresh (settings-applied), so editing its code takes effect
    /// without a restart. Plugin authors opt in via the manifest.
    #[serde(default)]
    pub development: bool,
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
    /// `permissions` as declared by the manifest (P3.2 enforces it: the
    /// frontend refuses an RPC whose permission is missing here).
    pub permissions: Vec<String>,
    /// Built into lume.exe (vs discovered under `<base>/plugins/`).
    pub builtin: bool,
    /// `settings.plugins.trusted` holds this id → every declared-capability
    /// check passes even when `permissions` is incomplete (development
    /// escape hatch, surfaced as 「全部授权」 in the settings pane).
    pub trusted: bool,
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
    /// Development flag (manifest `development`): the frontend reloads this
    /// plugin on every refresh so code edits take effect without a restart.
    pub development: bool,
    /// Pinyin search aids for `keywords` (same order); empty when the plugin
    /// has no keywords. Backend-computed (the frontend has no pinyin table).
    #[serde(rename = "keywordsPinyin")]
    pub keywords_pinyin: Vec<KeywordPinyin>,
    /// Declarative entry rules (any plugin kind).
    pub features: Vec<PluginFeature>,
    /// Declarative settings (P3.4) with JSON defaults.
    pub settings: Vec<PluginSettingInfo>,
    /// Absolute plugin directory (disk plugins; empty for built-ins).
    pub dir: String,
}

/// The compiled-in first-party plugins. Their UI/logic lives under
/// `src/plugins/<id>/` in the frontend; the ids are the stable contract.
pub const BUILTIN_PLUGINS: &[(&str, &str, &str)] = &[
    ("clipboard", "剪贴板历史", "mode"),
    ("preview", "卫星预览", "service"),
];

/// Plugins directory: `<base>/plugins/`.
fn plugins_dir(base: &Path) -> std::path::PathBuf {
    base.join("plugins")
}

/// Plugin ids are directory names under `plugins/` (and the path component of
/// every store/doc key): keep them to a conservative character set so an id
/// can never escape its own directory.
pub(crate) fn valid_plugin_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// The id a plugin directory belongs to: the manifest's `id` when set, else
/// the directory name. This is the same key the plugin is registered under, so
/// store/migration code paths agree with the frontend.
pub(crate) fn manifest_id_of(dir: &Path) -> String {
    let name = dir
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    fs::read_to_string(dir.join("plugin.toml"))
        .ok()
        .and_then(|text| parse_manifest(&text).ok())
        .map(|m| if m.id.is_empty() { name.clone() } else { m.id })
        .unwrap_or(name)
}

/// One plugin's declared settings (empty when the manifest is unreadable or
/// declares none) — the schema `plugin_settings_*` validates against.
pub(crate) fn manifest_settings(base: &Path, id: &str) -> Vec<PluginSettingInfo> {
    scan_disk_plugins(base)
        .into_iter()
        .find(|m| m.id == id)
        .map(|m| m.settings.iter().map(|s| s.info()).collect())
        .unwrap_or_default()
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

/// Resolve a manifest `entry` to the file the frontend should import: when
/// the entry names a directory (a bundled multi-file build, e.g. an esbuild
/// product), the module root is `index.js` inside it.
fn resolve_entry(dir: &Path, entry: &str) -> String {
    if entry.is_empty() {
        return entry.into();
    }
    let p = dir.join(entry);
    if p.is_dir() {
        let trimmed = entry.trim_end_matches(['/', '\\']);
        return format!("{trimmed}/index.js");
    }
    entry.into()
}

/// Built-ins + on-disk plugins, annotated with the effective enabled state and
/// the `trusted` flag (`settings.plugins.trusted`).
pub fn list_plugins(base: &Path, disabled: &[String], trusted: &[String]) -> Vec<PluginInfo> {
    let enabled = |id: &str| !disabled.iter().any(|d| d == id);
    let is_trusted = |id: &str| trusted.iter().any(|t| t == id);
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
            trusted: false, // built-ins are compiled in, not granted anything
            enabled: enabled(id),
            entry: String::new(),
            view: String::new(),
            keywords: Vec::new(),
            height: None,
            icon: String::new(),
            development: false,
            keywords_pinyin: Vec::new(),
            features: Vec::new(),
            settings: Vec::new(),
            dir: String::new(),
        })
        .collect();
    let disk = scan_disk_plugins(base);
    for m in disk {
        let dir = plugins_dir(base).join(&m.id);
        let keywords_pinyin = m
            .keywords
            .iter()
            .map(|k| {
                let (full, initials) = pinyin_for(k);
                KeywordPinyin { full, initials }
            })
            .collect();
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
            trusted: is_trusted(&m.id),
            enabled: enabled(&m.id),
            entry: resolve_entry(&dir, &m.entry),
            view: m.view,
            keywords: m.keywords,
            height: m.height,
            icon: m.icon,
            development: m.development,
            keywords_pinyin,
            features: m.features,
            settings: m.settings.iter().map(|s| s.info()).collect(),
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
    Ok(list_plugins(
        &base_dir(),
        &snapshot.plugins.disabled,
        &snapshot.plugins.trusted,
    ))
}

/// Settings-pane 重载 button: ask the launcher webview to reload one disk
/// plugin (the registry unloads + re-imports it). Only an event — the actual
/// unload/reload lives in the frontend registry (`reloadDiskPlugin`).
#[tauri::command]
pub fn reload_plugin(id: String, app: tauri::AppHandle) -> Result<(), String> {
    use tauri::Emitter;
    app.emit("plugin-reload", id).map_err(|e| e.to_string())
}

// ── Plugin data (P3.1) ──
//
// The v1 `storage.json` KV map and the P3 document store both live in
// `plugin_store.rs` (`<base>/data/plugin_store.db`): the commands there are
// `plugin_storage_get/set` (the compatibility shim), `plugin_db_*` (the
// document API) and `plugin_settings_*` (declarative settings).

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
        let all = list_plugins(&root, &disabled, &[]);
        let ids: Vec<&str> = all.iter().map(|p| p.id.as_str()).collect();
        assert!(ids.contains(&"clipboard") && ids.contains(&"preview") && ids.contains(&"demo"));
        let preview = all.iter().find(|p| p.id == "preview").unwrap();
        assert!(preview.builtin && !preview.enabled);
        let demo = all.iter().find(|p| p.id == "demo").unwrap();
        assert!(!demo.builtin && demo.enabled && demo.name == "Demo");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn trusted_ids_are_reported_and_builtins_never_are() {
        let root = std::env::temp_dir().join(format!("lume-plugins-trust-{}", std::process::id()));
        let demo = root.join("plugins").join("demo");
        fs::create_dir_all(&demo).unwrap();
        fs::write(
            demo.join("plugin.toml"),
            "id = \"demo\"\npermissions = [\"network\"]\n",
        )
        .unwrap();
        let all = list_plugins(&root, &[], &["demo".to_string(), "preview".to_string()]);
        let demo = all.iter().find(|p| p.id == "demo").unwrap();
        assert!(demo.trusted);
        assert_eq!(demo.permissions, vec!["network".to_string()]);
        let other = all.iter().find(|p| p.id == "clipboard").unwrap();
        assert!(!other.trusted, "a built-in is never in the trusted list");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn settings_declare_json_defaults_and_options() {
        let m = parse_manifest(
            "id = \"demo\"\n\
             [[settings]]\n\
             key = \"greeting\"\n\
             label = \"Greeting\"\n\
             type = \"text\"\n\
             default = \"hello\"\n\
             \n\
             [[settings]]\n\
             key = \"limit\"\n\
             type = \"text\"\n\
             default = 5\n\
             \n\
             [[settings]]\n\
             key = \"engine\"\n\
             type = \"select\"\n\
             default = \"bing\"\n\
             \n\
             [[settings.options]]\n\
             value = \"bing\"\n\
             label = \"Bing\"\n\
             \n\
             [[settings.options]]\n\
             value = \"google\"\n\
             \n\
             [[settings]]\n\
             key = \"plain\"\n",
        )
        .unwrap();
        assert_eq!(m.settings.len(), 4);
        let s = &m.settings[0];
        assert_eq!(s.input, "text");
        assert_eq!(s.info().default_value, serde_json::json!("hello"));
        assert_eq!(m.settings[1].info().default_value, serde_json::json!(5));
        assert_eq!(m.settings[2].info().default_value, serde_json::json!("bing"));
        assert_eq!(m.settings[2].options.len(), 2);
        assert_eq!(m.settings[2].options[0].label, "Bing");
        // An option without a label falls back to its value in the pane.
        assert_eq!(m.settings[2].options[1].label, "");
        // No `default` → JSON null; no `type` → text; no `label` → the key.
        assert_eq!(m.settings[3].info().default_value, serde_json::Value::Null);
        assert_eq!(m.settings[3].input, "text");
        assert_eq!(m.settings[3].info().label, "plain");
        // A plugin without a [[settings]] block reports none.
        assert!(parse_manifest("id = \"x\"").unwrap().settings.is_empty());
    }

    #[test]
    fn manifest_settings_lookup_and_id_resolution() {
        let root = std::env::temp_dir().join(format!("lume-plugins-mset-{}", std::process::id()));
        let demo = root.join("plugins").join("demo");
        fs::create_dir_all(&demo).unwrap();
        fs::write(
            demo.join("plugin.toml"),
            "name = \"Demo\"\n[[settings]]\nkey = \"a\"\nlabel = \"A\"\n",
        )
        .unwrap();
        // `id` omitted → the directory name is the plugin id.
        assert_eq!(manifest_id_of(&demo), "demo");
        let declared = manifest_settings(&root, "demo");
        assert_eq!(declared.len(), 1);
        assert_eq!(declared[0].key, "a");
        assert!(manifest_settings(&root, "nope").is_empty());
        // An unreadable manifest falls back to the directory name too.
        assert_eq!(manifest_id_of(&root.join("plugins").join("ghost")), "ghost");
        assert!(valid_plugin_id("demo-1_2"));
        assert!(!valid_plugin_id("") && !valid_plugin_id("..\\evil") && !valid_plugin_id("a b"));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn keywords_get_pinyin_search_aids() {
        let root = std::env::temp_dir().join(format!("lume-plugins-py-{}", std::process::id()));
        let base = root.join("plugins");
        let demo = base.join("demo");
        fs::create_dir_all(&demo).unwrap();
        fs::write(
            demo.join("plugin.toml"),
            "id = \"demo\"\nkeywords = [\"秒搜\", \"Files\"]\n",
        )
        .unwrap();
        let all = list_plugins(&root, &[], &[]);
        let demo = all.iter().find(|p| p.id == "demo").unwrap();
        assert_eq!(demo.keywords_pinyin.len(), 2);
        assert_eq!(demo.keywords_pinyin[0].full, "miaosou");
        assert_eq!(demo.keywords_pinyin[0].initials, "ms");
        assert_eq!(demo.keywords_pinyin[1].full, "files");
        assert_eq!(demo.keywords_pinyin[1].initials, "files");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn entry_directory_resolves_to_index_js() {        let root = std::env::temp_dir().join(format!("lume-plugins-entry-{}", std::process::id()));
        let base = root.join("plugins");
        let dist = base.join("demo").join("dist");
        fs::create_dir_all(&dist).unwrap();
        fs::write(dist.join("index.js"), "export default {};\n").unwrap();
        fs::write(
            base.join("demo").join("plugin.toml"),
            "id = \"demo\"\nentry = \"dist\"\n",
        )
        .unwrap();
        let all = list_plugins(&root, &[], &[]);
        let demo = all.iter().find(|p| p.id == "demo").unwrap();
        assert!(demo.entry.ends_with("dist/index.js"), "entry: {}", demo.entry);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn features_parse_with_snake_case_and_serialize_camel_case() {
        let m = parse_manifest(
            "id = \"demo\"\n\
             [[features]]\n\
             code = \"open-url\"\n\
             label = \"在浏览器打开\"\n\
             regex = \"^https?://\"\n\
             min_length = 8\n\
             \n\
             [[features]]\n\
             code = \"upper\"\n\
             over = true\n\
             max_length = 40\n",
        )
        .unwrap();
        assert_eq!(m.features.len(), 2);
        assert_eq!(m.features[0].code, "open-url");
        assert_eq!(m.features[0].label, "在浏览器打开");
        assert_eq!(m.features[0].regex, "^https?://");
        assert_eq!(m.features[0].min_length, Some(8));
        assert_eq!(m.features[1].over, true);
        assert_eq!(m.features[1].max_length, Some(40));
        // The frontend sees camelCase (directional serde rename).
        let json = serde_json::to_string(&m.features[0]).unwrap();
        assert!(json.contains("\"minLength\":8"), "{json}");
        assert!(!json.contains("min_length"), "{json}");
    }

    #[test]
    fn features_are_reported_to_the_frontend() {
        let root = std::env::temp_dir().join(format!("lume-plugins-feat-{}", std::process::id()));
        let base = root.join("plugins");
        let demo = base.join("demo");
        fs::create_dir_all(&demo).unwrap();
        fs::write(
            demo.join("plugin.toml"),
            "id = \"demo\"\n[[features]]\ncode = \"hi\"\nover = true\n",
        )
        .unwrap();
        let all = list_plugins(&root, &[], &[]);
        let demo = all.iter().find(|p| p.id == "demo").unwrap();
        assert_eq!(demo.features.len(), 1);
        assert_eq!(demo.features[0].code, "hi");
        assert!(all.iter().find(|p| p.id == "clipboard").unwrap().features.is_empty());
        fs::remove_dir_all(&root).ok();
    }
}
