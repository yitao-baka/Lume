//! Paths — portable (exe-adjacent) or installed (Program Files) layouts.
//!
//! Portable: all config/data/resources live next to the executable so Lume can
//! be carried around as a folder: `<exe_dir>/settings`, `<exe_dir>/data`,
//! `<exe_dir>/languages`, `<exe_dir>/res` (docs/ARCHITECTURE.md, Data management).
//!
//! Installed: when the exe lives under `Program Files` (read-only for normal
//! users) the writable data moves to `%LOCALAPPDATA%\Lume\`. The SYSTEM service
//! (`lume-svc.exe`) resolves the same dir from `HKLM\Software\Lume\DataDir`
//! because its own `%LOCALAPPDATA%` is the system profile, which is wrong.

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

/// Process-level base-dir override, used by the service binary
/// (`lume-svc.exe`) once it learns the real data dir (registry / pipe HELLO).
static BASE_OVERRIDE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub(crate) const LEGACY_DATA_DATABASES: &[&str] = &[
    "lume.db",
    "plugin_store.db",
    "system32_cache.db",
    "user_cache.db",
    "icons.db",
];
pub(crate) const LEGACY_DATA_FILES: &[&str] = &["onboarding.json"];
pub(crate) const LEGACY_DATA_DIRS: &[&str] = &["PictureCache"];
pub(crate) const LEGACY_SETTINGS_FILES: &[&str] =
    &["settings.toml", "default.toml", "backup.toml"];
pub(crate) const LEGACY_SETTINGS_DIRS: &[&str] = &["trust-keys"];
pub(crate) const LEGACY_LANGUAGE_FILES: &[&str] = &["en.json", "zh-CN.json", "zh-TW.json"];

/// Directory of the running executable.
pub fn exe_dir() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default()
}

/// Whether the executable lives under a `Program Files` tree — the *installed*
/// layout (read-only exe dir, writable data in `%LOCALAPPDATA%`).
/// Case-insensitive so `Program Files (x86)` matches too.
pub fn install_detected() -> bool {
    in_program_files(&exe_dir())
}

/// Case-insensitive `Program Files` check (matches `Program Files (x86)` too).
fn in_program_files(dir: &std::path::Path) -> bool {
    dir.to_string_lossy()
        .to_ascii_lowercase()
        .contains("program files")
}

/// The writable data root: portable → `<exe_dir>`; installed →
/// `HKLM\Software\Lume\DataDir` when set (service process), else
/// `%LOCALAPPDATA%\Lume`. `set_base_dir` overrides everything (service only).
pub fn base_dir() -> PathBuf {
    if let Some(dir) = BASE_OVERRIDE.lock().unwrap().clone() {
        return dir;
    }
    if !install_detected() {
        return exe_dir();
    }
    registry_data_dir()
        .or_else(local_app_data_dir)
        .unwrap_or_else(exe_dir)
}

/// Pin the base dir for this process (only the service binary calls this).
pub fn set_base_dir(dir: PathBuf) {
    *BASE_OVERRIDE.lock().unwrap() = Some(dir);
}

/// `<base>/data` — every database lives here.
pub fn data_dir() -> PathBuf {
    base_dir().join("data")
}

/// `<base>/settings` — `settings.toml` / `default.toml` / `backup.toml`.
pub fn settings_base() -> PathBuf {
    base_dir().join("settings")
}

/// `<base>/languages` — runtime language-file overrides.
pub fn languages_dir() -> PathBuf {
    base_dir().join("languages")
}

/// Path of the shared SQLite database (`lume.db`, clipboard + pins).
pub fn db_path() -> PathBuf {
    data_dir().join("lume.db")
}

/// `%LOCALAPPDATA%` root for the current token. NOTE: under the SYSTEM account
/// this resolves to the system profile — callers running as SYSTEM must use
/// `registry_data_dir()` / `set_base_dir()` instead.
pub(crate) fn local_app_data_root() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

fn installed_app_dir(local_app_data: &std::path::Path) -> PathBuf {
    local_app_data.join("Lume")
}

fn local_app_data_dir() -> Option<PathBuf> {
    local_app_data_root().map(|root| installed_app_dir(&root))
}

/// `HKLM\Software\Lume\DataDir` — written by the elevated `lume-svc --install`
/// (same user, elevated token), read by the SYSTEM service to find the real
/// user data dir.
fn registry_data_dir() -> Option<PathBuf> {
    use windows::Win32::Foundation::WIN32_ERROR;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        REG_SZ, REG_VALUE_TYPE,
    };
    use windows::core::PCWSTR;

    const SUBKEY: &str = "Software\\Lume";
    const VALUE: &str = "DataDir";
    let sub: Vec<u16> = SUBKEY.encode_utf16().chain(std::iter::once(0)).collect();
    let name: Vec<u16> = VALUE.encode_utf16().chain(std::iter::once(0)).collect();

    let mut key = HKEY(std::ptr::null_mut());
    let rc = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            PCWSTR(sub.as_ptr()),
            None,
            KEY_READ,
            &mut key,
        )
    };
    if rc != WIN32_ERROR(0) {
        return None;
    }
    let mut buf = vec![0u16; 1024];
    let mut len = (buf.len() * 2) as u32;
    let mut ty = REG_VALUE_TYPE(0);
    let rc = unsafe {
        RegQueryValueExW(
            key,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut ty),
            Some(buf.as_mut_ptr() as *mut u8),
            Some(&mut len),
        )
    };
    let _ = unsafe { RegCloseKey(key) };
    if rc != WIN32_ERROR(0) || ty.0 != REG_SZ.0 {
        return None;
    }
    let n = (len as usize / 2).saturating_sub(1); // strip trailing NUL
    let s = String::from_utf16(&buf[..n]).ok()?;
    (!s.is_empty()).then_some(PathBuf::from(s))
}

/// First run in the installed layout: copy any `data/`, `settings/` and
/// `languages/` folders that sit next to the exe (e.g. a portable copy dropped
/// into Program Files) into the writable base dir. Only copies files that
/// don't exist yet; never deletes (Program Files stays untouched).
pub fn migrate_installed() {
    if !install_detected() {
        return;
    }
    let target = base_dir();
    if target == exe_dir() {
        return;
    }
    migrate_misplaced_local_app_data(&target);
    for sub in ["data", "settings", "languages"] {
        let src = exe_dir().join(sub);
        let dst = target.join(sub);
        if !src.is_dir() || dst.is_dir() {
            continue;
        }
        if std::fs::create_dir_all(&dst).is_err() {
            continue;
        }
        if let Ok(entries) = std::fs::read_dir(&src) {
            for entry in entries.flatten() {
                let from = entry.path();
                if from.is_file() {
                    let _ = std::fs::copy(&from, dst.join(entry.file_name()));
                }
            }
        }
    }
}

/// Earlier installed builds accidentally used `%LOCALAPPDATA%` itself as the
/// writable base. Copy only unmistakable Lume-owned files into the corrected
/// `%LOCALAPPDATA%\Lume` root without moving or deleting mixed sibling data.
fn migrate_misplaced_local_app_data(target: &std::path::Path) {
    let Some(root) = local_app_data_root() else {
        return;
    };
    migrate_misplaced_local_app_data_from(&root, target);
}

fn migrate_misplaced_local_app_data_from(root: &std::path::Path, target: &std::path::Path) {
    if root == target {
        return;
    }

    let legacy_data = root.join("data");
    if legacy_data.join("lume.db").is_file() || legacy_data.join("plugin_store.db").is_file() {
        if let Some(dst) = ensure_dir(&target.join("data")) {
            copy_legacy_database_set(&legacy_data, &dst, LEGACY_DATA_DATABASES);
            for name in LEGACY_DATA_FILES {
                copy_missing_file(&legacy_data.join(name), &dst.join(name));
            }
            for name in LEGACY_DATA_DIRS {
                copy_missing_tree(&legacy_data.join(name), &dst.join(name));
            }
        }
    }

    let legacy_settings = root.join("settings");
    if legacy_settings.join("settings.toml").is_file()
        || legacy_settings.join("default.toml").is_file()
    {
        if let Some(dst) = ensure_dir(&target.join("settings")) {
            for name in LEGACY_SETTINGS_FILES {
                copy_missing_file(&legacy_settings.join(name), &dst.join(name));
            }
            for name in LEGACY_SETTINGS_DIRS {
                copy_missing_tree(&legacy_settings.join(name), &dst.join(name));
            }
        }
    }

    let legacy_languages = root.join("languages");
    if legacy_languages.is_dir() {
        if let Some(dst) = ensure_dir(&target.join("languages")) {
            for name in LEGACY_LANGUAGE_FILES {
                copy_missing_file(&legacy_languages.join(name), &dst.join(name));
            }
        }
    }

    let legacy_plugins = root.join("plugins");
    if let Ok(entries) = std::fs::read_dir(&legacy_plugins) {
        let dst_root = ensure_dir(&target.join("plugins"));
        for entry in entries.flatten() {
            let src = entry.path();
            if !src.is_dir() || !src.join("plugin.toml").is_file() {
                continue;
            }
            if let Some(dst) = dst_root.as_ref() {
                copy_missing_tree(&src, &dst.join(entry.file_name()));
            }
        }
    }
}

fn copy_legacy_database_set(
    src: &std::path::Path,
    dst: &std::path::Path,
    databases: &[&str],
) {
    for database in databases {
        copy_missing_file(&src.join(database), &dst.join(database));
        for suffix in ["-wal", "-shm"] {
            let name = format!("{database}{suffix}");
            copy_missing_file(&src.join(&name), &dst.join(&name));
        }
    }
}

fn ensure_dir(path: &std::path::Path) -> Option<PathBuf> {
    std::fs::create_dir_all(path).ok()?;
    Some(path.to_path_buf())
}

fn copy_missing_file(src: &std::path::Path, dst: &std::path::Path) {
    if src.is_file() && !dst.exists() {
        let _ = std::fs::copy(src, dst);
    }
}

fn copy_missing_tree(src: &std::path::Path, dst: &std::path::Path) {
    let Some(dst) = ensure_dir(dst) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(src) else {
        return;
    };
    for entry in entries.flatten() {
        let from = entry.path();
        let to = dst.join(entry.file_name());
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => copy_missing_tree(&from, &to),
            Ok(kind) if kind.is_file() => copy_missing_file(&from, &to),
            _ => {}
        }
    }
}

/// Copy the legacy `app_data_dir()/lume.db` into `data/` the first time the
/// portable layout is used, so clipboard history and pins survive the move.
/// WAL/SHM companions are copied too if present (only relevant if the last
/// run exited uncleanly).
pub fn migrate_db(app: &tauri::App) {
    let new = db_path();
    if new.exists() {
        return;
    }
    let Ok(old_dir) = app.path().app_data_dir() else {
        return;
    };
    let old = old_dir.join("lume.db");
    if !old.exists() {
        return;
    }
    if let Some(parent) = new.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    for ext in ["", "-wal", "-shm"] {
        let name = format!("lume.db{ext}");
        let src = old_dir.join(&name);
        let dst = new.with_file_name(&name);
        if src.exists() {
            let _ = std::fs::copy(&src, &dst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn misplaced_installed_data_copies_only_known_entries() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "lume-misplaced-{}-{stamp}",
            std::process::id()
        ));
        let data = root.join("data");
        let settings = root.join("settings");
        let languages = root.join("languages");
        let plugins = root.join("plugins");
        std::fs::create_dir_all(data.join("PictureCache")).unwrap();
        std::fs::create_dir_all(&settings).unwrap();
        std::fs::create_dir_all(&languages).unwrap();
        std::fs::create_dir_all(plugins.join("demo")).unwrap();
        std::fs::write(data.join("lume.db"), b"db").unwrap();
        std::fs::write(data.join("unrelated.bin"), b"no").unwrap();
        std::fs::write(data.join("PictureCache/1.png"), b"png").unwrap();
        std::fs::write(settings.join("settings.toml"), b"settings").unwrap();
        std::fs::write(settings.join("unrelated.toml"), b"no").unwrap();
        std::fs::write(languages.join("en.json"), b"{}").unwrap();
        std::fs::write(languages.join("other.json"), b"{}").unwrap();
        std::fs::write(plugins.join("demo/plugin.toml"), b"id='demo'").unwrap();
        std::fs::write(plugins.join("demo/main.js"), b"main").unwrap();
        std::fs::create_dir_all(plugins.join("other")).unwrap();
        std::fs::write(plugins.join("other/README.txt"), b"no").unwrap();

        let target = root.join("Lume");
        migrate_misplaced_local_app_data_from(&root, &target);

        assert!(target.join("data/lume.db").is_file());
        assert!(target.join("data/PictureCache/1.png").is_file());
        assert!(!target.join("data/unrelated.bin").exists());
        assert!(target.join("settings/settings.toml").is_file());
        assert!(!target.join("settings/unrelated.toml").exists());
        assert!(target.join("languages/en.json").is_file());
        assert!(!target.join("languages/other.json").exists());
        assert!(target.join("plugins/demo/main.js").is_file());
        assert!(!target.join("plugins/other").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn installed_local_app_data_appends_lume() {
        assert_eq!(
            installed_app_dir(&PathBuf::from(r"C:\Users\me\AppData\Local")),
            PathBuf::from(r"C:\Users\me\AppData\Local\Lume")
        );
    }

    #[test]
    fn program_files_is_detected_case_insensitively() {
        assert!(in_program_files(&PathBuf::from(r"C:\Program Files\Lume")));
        assert!(in_program_files(&PathBuf::from(
            r"C:\Program Files (x86)\Lume"
        )));
        assert!(!in_program_files(&PathBuf::from(r"D:\Tools\Lume")));
        assert!(!in_program_files(&PathBuf::from(r"C:\Users\me\Apps\Lume")));
    }
}
