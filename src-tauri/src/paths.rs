//! Paths — portable (exe-adjacent) or installed (Program Files) layouts.
//!
//! Portable: all config/data/resources live next to the executable so Lume can
//! be carried around as a folder: `<exe_dir>/settings`, `<exe_dir>/data`,
//! `<exe_dir>/languages`, `<exe_dir>/res` (docs/NORMS.md).
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

/// `%LOCALAPPDATA%` for the current token. NOTE: under the SYSTEM account this
/// resolves to the system profile — callers running as SYSTEM must use
/// `registry_data_dir()` / `set_base_dir()` instead.
fn local_app_data_dir() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
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
    fn program_files_is_detected_case_insensitively() {
        assert!(in_program_files(&PathBuf::from(r"C:\Program Files\Lume")));
        assert!(in_program_files(&PathBuf::from(
            r"C:\Program Files (x86)\Lume"
        )));
        assert!(!in_program_files(&PathBuf::from(r"D:\Tools\Lume")));
        assert!(!in_program_files(&PathBuf::from(r"C:\Users\me\Apps\Lume")));
    }
}
