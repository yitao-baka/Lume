//! i18n language-file loading.
//!
//! The frontend bundles the default language JSON at build time. This module
//! additionally exposes `languages/*.json` found under the writable data root
//! (`paths::languages_dir()`) as runtime overrides, so users can tweak strings
//! without a rebuild (docs/ARCHITECTURE.md).
//!
//! It also resolves the language and reads single keys for the text Rust has
//! to render itself (tray menu, notifications, services.msc / Task Scheduler
//! descriptions, window titles) — see `crate::texts`.

use serde::Serialize;

use crate::paths;

/// A single language file read from `<exe_dir>/languages/*.json`.
#[derive(Serialize)]
pub struct LanguageFile {
    pub lang: String,
    pub json: String,
}

/// The three UI languages Rust can render text in.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum UiLang {
    En,
    ZhCn,
    ZhTw,
}

impl UiLang {
    /// The language-file stem (also the BCP-47 tag the frontend uses).
    pub fn tag(self) -> &'static str {
        match self {
            UiLang::En => "en",
            UiLang::ZhCn => "zh-CN",
            UiLang::ZhTw => "zh-TW",
        }
    }

    /// `appearance.language` (`"system"` | `"en"` | `"zh-CN"` | `"zh-TW"`)
    /// resolved to a concrete language.
    pub fn from_setting(raw: &str) -> Self {
        match raw {
            "en" => UiLang::En,
            "zh-CN" => UiLang::ZhCn,
            "zh-TW" => UiLang::ZhTw,
            _ => UiLang::from_system(),
        }
    }

    /// The Windows UI language, including the Traditional Chinese sublanguage
    /// (a two-way zh / non-zh split cannot tell the variants apart).
    pub fn from_system() -> Self {
        use windows::Win32::Globalization::GetUserDefaultUILanguage;
        let lang = unsafe { GetUserDefaultUILanguage() };
        let primary = lang & 0x3FF;
        let sub = (lang >> 10) & 0x3F;
        if primary == 0x04 {
            // SUBLANG_CHINESE_TRADITIONAL / HONGKONG / MACAU.
            if matches!(sub, 0x01 | 0x03 | 0x05) {
                UiLang::ZhTw
            } else {
                UiLang::ZhCn
            }
        } else {
            UiLang::En
        }
    }
}

/// Look up one key in the runtime language file `<base>/languages/<tag>.json`
/// — the same files the frontend merges as overrides — falling back to
/// `default` when the file is missing, unreadable or lacks the key. The
/// fallbacks live next to their callers in `crate::texts`.
pub fn text(lang: UiLang, key: &str, default: &str) -> String {
    text_in(&paths::languages_dir(), lang, key, default)
}

/// The same lookup against an explicit directory — the unit test points it at
/// the repository's `languages/` to cover the read path.
pub(crate) fn text_in(dir: &std::path::Path, lang: UiLang, key: &str, default: &str) -> String {
    let path = dir.join(format!("{}.json", lang.tag()));
    if let Ok(raw) = std::fs::read_to_string(path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(value) = json.get(key).and_then(|v| v.as_str()) {
                return value.to_string();
            }
        }
    }
    default.to_string()
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
