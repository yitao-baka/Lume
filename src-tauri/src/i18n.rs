//! i18n language-file loading.
//!
//! The frontend bundles the default language JSON at build time. This module
//! additionally exposes `languages/*.json` found under the writable data root
//! (`paths::languages_dir()`) as runtime overrides, so users can tweak strings
//! without a rebuild (docs/NORMS.md).

use serde::Serialize;

use crate::paths;

/// A single language file read from `<exe_dir>/languages/*.json`.
#[derive(Serialize)]
pub struct LanguageFile {
    pub lang: String,
    pub json: String,
}

/// Read every `*.json` file from `<base>/languages/`.
#[tauri::command]
pub fn load_language_files() -> Vec<LanguageFile> {
    let dir = paths::languages_dir();
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let lang = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or_default();
            if lang.is_empty() {
                continue;
            }
            if let Ok(json) = std::fs::read_to_string(&path) {
                out.push(LanguageFile {
                    lang: lang.to_string(),
                    json,
                });
            }
        }
    }
    out
}
