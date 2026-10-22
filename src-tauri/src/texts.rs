//! User-visible text that Rust renders without the webview.
//!
//! The tray menu, the hotkey-conflict notification, the services.msc and Task
//! Scheduler descriptions and the settings / preview window titles are drawn by
//! Rust, so they cannot call the frontend's `t()`. The shipped wording lives in
//! `languages/*.json` — the same files the frontend merges as runtime
//! overrides — and is read through [`crate::i18n::text`]; the table below is the
//! compiled fallback for a missing or unreadable file, and
//! `compiled_defaults_match_language_files` pins both copies together.

use crate::i18n::{self, UiLang};

/// (language-file key, compiled English fallback).
const FALLBACKS: &[(&str, &str)] = &[
    ("traySettings", "Settings"),
    ("trayRestart", "Restart"),
    ("trayExit", "Exit"),
    (
        "hotkeyConflictNotice",
        "The shortcut {combo} is already in use. Open Settings → Hotkeys from the tray, or free the combination.",
    ),
    (
        "svcDescription",
        "Lume background service (full-drive file index for instant file search)",
    ),
    (
        "taskDescription",
        "Lume elevation agent - injects a configured hotkey into higher-integrity windows (input only; no UI, no files).",
    ),
    ("windowTitleSettings", "Lume Settings"),
    ("windowTitlePreview", "Lume Preview"),
];

/// Compiled fallback for `key` — panics on a key this module does not declare.
fn fallback(key: &str) -> &'static str {
    FALLBACKS
        .iter()
        .find(|(k, _)| *k == key)
        .map(|(_, text)| *text)
        .unwrap_or_else(|| panic!("no compiled fallback for {key}"))
}

/// One localized string by key.
fn lookup(lang: UiLang, key: &str) -> String {
    i18n::text(lang, key, fallback(key))
}

/// Tray menu labels (Settings / Restart / Exit).
pub struct TrayText {
    pub settings: String,
    pub restart: String,
    pub exit: String,
}

pub fn tray(lang: UiLang) -> TrayText {
    TrayText {
        settings: lookup(lang, "traySettings"),
        restart: lookup(lang, "trayRestart"),
        exit: lookup(lang, "trayExit"),
    }
}

/// Body of the hotkey-conflict notification — a release build has no console,
/// so this is where the user learns the combo is taken.
pub fn hotkey_conflict(lang: UiLang, combo: &str) -> String {
    lookup(lang, "hotkeyConflictNotice").replace("{combo}", combo)
}

/// services.msc description of the LumeSVC service.
pub fn svc_description(lang: UiLang) -> String {
    lookup(lang, "svcDescription")
}

/// Task Scheduler description of the elevation-agent task.
pub fn task_description(lang: UiLang) -> String {
    lookup(lang, "taskDescription")
}

/// Taskbar / Alt+Tab title of the settings window.
pub fn window_title_settings(lang: UiLang) -> String {
    lookup(lang, "windowTitleSettings")
}

/// Taskbar / Alt+Tab title of the satellite preview window.
pub fn window_title_preview(lang: UiLang) -> String {
    lookup(lang, "windowTitlePreview")
}

/// Escape text that is interpolated into the task XML: a user-edited language
/// file (or a non-ASCII install path) is not trusted to be well-formed markup.
///
/// The result is **pure ASCII** — everything outside `0x20..=0x7E` becomes a
/// numeric character reference and code points XML 1.0 cannot represent become
/// `&#xFFFD;`. That is a contract, not cosmetics: `schtasks /Create /XML`
/// decodes the file with the *caller's console code page* instead of reading
/// the bytes as the UTF-8 they are, so a locally encoded description loses
/// markup bytes on a DBCS console (docs/ROADMAP_HISTORY.md #70: a CP936 console
/// paired the UTF-8 `。` with the following `<` and ate the `<` of
/// `</Description>`). ASCII bytes decode identically on every code page, and the
/// XML parser expands the references again, so the text still arrives intact.
pub fn xml_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\u{20}'..='\u{7E}' => out.push(c),
            c if is_xml_char(c) => out.push_str(&format!("&#x{:X};", c as u32)),
            _ => out.push_str("&#xFFFD;"),
        }
    }
    out
}

/// XML 1.0 `Char`, except for `U+FFFE` / `U+FFFF` (excluded by the `U+FFFD` end
/// of the range).
fn is_xml_char(c: char) -> bool {
    matches!(c, '\u{9}' | '\u{A}' | '\u{D}')
        || matches!(c, '\u{20}'..='\u{D7FF}')
        || matches!(c, '\u{E000}'..='\u{FFFD}')
        || c >= '\u{10000}'
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn languages_dir() -> std::path::PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../languages")
    }

    /// The runtime lookup reads the same file the frontend merges, so a user
    /// override reaches the tray / notification / window-title text too.
    #[test]
    fn runtime_lookup_reads_the_shipped_bundle() {
        let dir = languages_dir();
        assert_eq!(crate::i18n::text_in(&dir, UiLang::ZhTw, "trayExit", "?"), "關閉");
        assert_eq!(crate::i18n::text_in(&dir, UiLang::ZhCn, "trayExit", "?"), "关闭");
        assert_eq!(crate::i18n::text_in(&dir, UiLang::En, "trayExit", "?"), "Exit");
        // A missing key (or file) falls back to the compiled default.
        assert_eq!(crate::i18n::text_in(&dir, UiLang::En, "noSuchKey", "fallback"), "fallback");
        assert_eq!(
            crate::i18n::text_in(Path::new("no/such/dir"), UiLang::En, "trayExit", "Exit"),
            "Exit"
        );
    }

    fn language_file(lang: UiLang) -> serde_json::Value {
        let path = languages_dir().join(format!("{}.json", lang.tag()));
        let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        serde_json::from_str(&raw).expect("language file is json")
    }

    /// The JSON bundles are the source of truth: every compiled fallback must
    /// match the English file so a wording change cannot drift.
    #[test]
    fn compiled_defaults_match_language_files() {
        let en = language_file(UiLang::En);
        for (key, text) in FALLBACKS {
            assert_eq!(
                en.get(*key).and_then(|v| v.as_str()),
                Some(*text),
                "compiled fallback drifted from languages/en.json for {key}"
            );
        }
    }

    /// Every key exists in all three bundles, because they are merged per key.
    #[test]
    fn every_language_carries_every_key() {
        for lang in [UiLang::En, UiLang::ZhCn, UiLang::ZhTw] {
            let bundle = language_file(lang);
            for (key, _) in FALLBACKS {
                let value = bundle.get(*key).and_then(|v| v.as_str()).unwrap_or_default();
                assert!(!value.is_empty(), "{}: {key} missing", lang.tag());
            }
        }
    }

    #[test]
    fn hotkey_notice_substitutes_the_combo() {
        let notice = hotkey_conflict(UiLang::En, "Alt+Space");
        assert!(notice.contains("Alt+Space"), "{notice}");
        assert!(!notice.contains("{combo}"), "{notice}");
    }

    /// zh-TW keeps its own wording: the two Chinese variants used to share one
    /// simplified string, and 托盤 is the mainland term for the tray. (The
    /// runtime lookup needs a language file, so this reads the shipped one.)
    #[test]
    fn zh_tw_notice_uses_taiwan_terms() {
        let tw = language_file(UiLang::ZhTw);
        let notice = tw["hotkeyConflictNotice"].as_str().unwrap_or_default();
        assert!(notice.contains("系統匣"), "{notice}");
        assert!(!notice.contains("托盤") && !notice.contains("托盘"), "{notice}");
        let cn = language_file(UiLang::ZhCn);
        let notice = cn["hotkeyConflictNotice"].as_str().unwrap_or_default();
        assert!(notice.contains("系统托盘"), "{notice}");
    }

    #[test]
    fn xml_escape_covers_markup_characters() {
        assert_eq!(
            xml_escape(r#"a & b < c > d "e""#),
            "a &amp; b &lt; c &gt; d &quot;e&quot;"
        );
    }

    /// The task XML has to survive `schtasks` decoding it with the caller's
    /// console code page, so escaped text is ASCII-only: non-ASCII becomes a
    /// character reference, whitespace controls become references too (user
    /// text must not be able to inject a line break into the document), and
    /// code points XML cannot represent are replaced.
    #[test]
    fn xml_escape_emits_ascii_only() {
        assert_eq!(xml_escape("提权——"), "&#x63D0;&#x6743;&#x2014;&#x2014;");
        assert_eq!(xml_escape("a\nb\tc\rd"), "a&#xA;b&#x9;c&#xD;d");
        assert_eq!(xml_escape("a\u{1}b"), "a&#xFFFD;b");
        assert!(xml_escape("规范·字 mixed utf-8 — ok").is_ascii());
    }
}
