//! Full-uninstall cleanup for the current Windows user.
//!
//! The installer invokes `lume-svc.exe --purge-user-data` only when the user
//! explicitly unchecks "keep my data". The helper owns the destructive policy
//! so the MicaSetup template never has to guess which paths belong to Lume:
//! fixed per-user data roots, Lume-authored temp files, plugin credentials,
//! autostart, and the service data-dir key. The installer continues to own the
//! installation directory because the helper process is still running from it.
//!
//! Locked files are scheduled through `MOVEFILE_DELAY_UNTIL_REBOOT`; callers
//! receive a distinct reboot-required exit code so the uninstaller can report
//! that cleanup is not complete until Windows restarts.

use std::path::{Path, PathBuf};
use std::time::Duration;

use windows::core::PCWSTR;
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS};
use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};
use windows::Win32::System::Registry::{RegDeleteTreeW, HKEY_LOCAL_MACHINE};

pub const EXIT_OK: i32 = 0;
pub const EXIT_FAILED: i32 = 1;
pub const EXIT_REBOOT_REQUIRED: i32 = 2;

const USER_DATA_DIR_NAMES: [&str; 2] = ["Lume", "com.lume.app"];
const REG_LUME_KEY: &str = r"Software\Lume";
const TEMP_AGENT_RESULT: &str = "lume-agent-install.result";
const TEMP_AGENT_TASK_PREFIX: &str = "lume-agent-task-";

#[derive(Debug, Default)]
pub struct PurgeReport {
    pub removed: Vec<PathBuf>,
    pub scheduled_for_reboot: Vec<PathBuf>,
    pub errors: Vec<String>,
}

impl PurgeReport {
    pub fn exit_code(&self) -> i32 {
        if !self.errors.is_empty() {
            EXIT_FAILED
        } else if !self.scheduled_for_reboot.is_empty() {
            EXIT_REBOOT_REQUIRED
        } else {
            EXIT_OK
        }
    }
}

/// CLI entry point used by `lume-svc.exe --purge-user-data`.
pub fn run_cli() -> i32 {
    let report = match purge_current_user() {
        Ok(report) => report,
        Err(error) => {
            eprintln!("[lume-svc] purge: {error}");
            return EXIT_FAILED;
        }
    };

    for path in &report.removed {
        println!("[purge] removed: {}", path.display());
    }
    for path in &report.scheduled_for_reboot {
        println!("[purge] scheduled for reboot: {}", path.display());
    }
    for error in &report.errors {
        eprintln!("[purge] error: {error}");
    }

    let code = report.exit_code();
    match code {
        EXIT_OK => println!("[purge] complete"),
        EXIT_REBOOT_REQUIRED => {
            println!("[purge] complete after the next Windows restart")
        }
        _ => eprintln!("[purge] incomplete; review the errors above"),
    }
    code
}

/// Delete all Lume-owned state for the account running the elevated uninstaller.
///
/// This is deliberately limited to the current user. Credential Manager vaults
/// and `HKCU` are per-user; silently loading every profile would be a different,
/// much more dangerous operation.
pub fn purge_current_user() -> Result<PurgeReport, String> {
    crate::svc::ensure_elevated()
        .map_err(|_| "full uninstall cleanup requires administrator elevation".to_string())?;

    let mut report = PurgeReport::default();

    if let Err(error) = crate::svc::autostart_set(false) {
        report
            .errors
            .push(format!("remove HKCU autostart: {error}"));
    }

    match crate::plugin_secret::purge_plugin_secrets() {
        Ok(0) => {}
        Ok(count) => println!("[purge] removed {count} plugin credential(s)"),
        Err(error) => report
            .errors
            .push(format!("remove plugin credentials: {error}")),
    }

    for path in current_user_data_roots() {
        remove_path_with_retries(&path, 20, &mut report);
    }

    remove_legacy_misplaced_installed_data(&mut report);

    for path in current_user_temp_paths() {
        remove_path_with_retries(&path, 3, &mut report);
    }

    if let Err(error) = delete_hklm_lume_key() {
        report
            .errors
            .push(format!(r"remove HKLM\{REG_LUME_KEY}: {error}"));
    }

    Ok(report)
}

fn remove_legacy_misplaced_installed_data(report: &mut PurgeReport) {
    let Some(root) = crate::paths::local_app_data_root() else {
        return;
    };
    remove_legacy_misplaced_installed_data_from(&root, report);
}

fn remove_legacy_misplaced_installed_data_from(root: &Path, report: &mut PurgeReport) {
    let data = root.join("data");
    if data.join("lume.db").is_file() || data.join("plugin_store.db").is_file() {
        for database in crate::paths::LEGACY_DATA_DATABASES {
            remove_path_with_retries(&data.join(database), 20, report);
            for suffix in ["-wal", "-shm"] {
                remove_path_with_retries(&data.join(format!("{database}{suffix}")), 20, report);
            }
        }
        for name in crate::paths::LEGACY_DATA_FILES {
            remove_path_with_retries(&data.join(name), 20, report);
        }
        for name in crate::paths::LEGACY_DATA_DIRS {
            remove_path_with_retries(&data.join(name), 20, report);
        }
        remove_dir_if_empty(&data, report);
    }

    let settings = root.join("settings");
    if settings.join("settings.toml").is_file() || settings.join("default.toml").is_file() {
        for name in crate::paths::LEGACY_SETTINGS_FILES {
            remove_path_with_retries(&settings.join(name), 20, report);
        }
        for name in crate::paths::LEGACY_SETTINGS_DIRS {
            remove_path_with_retries(&settings.join(name), 20, report);
        }
        remove_dir_if_empty(&settings, report);
    }

    let languages = root.join("languages");
    for name in crate::paths::LEGACY_LANGUAGE_FILES {
        remove_path_with_retries(&languages.join(name), 20, report);
    }
    remove_dir_if_empty(&languages, report);

    let plugins = root.join("plugins");
    if let Ok(entries) = std::fs::read_dir(&plugins) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && path.join("plugin.toml").is_file() {
                remove_path_with_retries(&path, 20, report);
            }
        }
    }
    remove_dir_if_empty(&plugins, report);
}

fn remove_dir_if_empty(path: &Path, report: &mut PurgeReport) {
    if path.is_dir()
        && std::fs::read_dir(path)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
    {
        remove_path_with_retries(path, 3, report);
    }
}

fn current_user_data_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    for variable in ["LOCALAPPDATA", "APPDATA"] {
        let Some(base) = std::env::var_os(variable).map(PathBuf::from) else {
            continue;
        };
        if !base.is_absolute() {
            continue;
        }
        for name in USER_DATA_DIR_NAMES {
            roots.push(base.join(name));
        }
    }
    roots.sort();
    roots.dedup();
    roots
}

fn current_user_temp_paths() -> Vec<PathBuf> {
    let temp = std::env::temp_dir();
    let mut paths = Vec::new();
    let direct = temp.join(TEMP_AGENT_RESULT);
    if direct.exists() {
        paths.push(direct);
    }
    if let Ok(entries) = std::fs::read_dir(&temp) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if is_agent_temp_name(&name.to_string_lossy()) {
                paths.push(entry.path());
            }
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

fn is_agent_temp_name(name: &str) -> bool {
    name == TEMP_AGENT_RESULT
        || (name.starts_with(TEMP_AGENT_TASK_PREFIX) && name.ends_with(".xml"))
}

fn remove_path_with_retries(path: &Path, attempts: u32, report: &mut PurgeReport) {
    match std::fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            report
                .errors
                .push(format!("inspect {}: {error}", path.display()));
            return;
        }
    }

    let mut last_error = None;
    for attempt in 0..attempts {
        match remove_owned_path(path) {
            Ok(()) => {
                report.removed.push(path.to_path_buf());
                return;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
            Err(error) => {
                last_error = Some(error);
                if attempt + 1 < attempts {
                    std::thread::sleep(Duration::from_millis(250));
                }
            }
        }
    }

    let reason = last_error
        .map(|error| error.to_string())
        .unwrap_or_else(|| "unknown filesystem error".into());
    let scheduled = schedule_tree_for_reboot(path, report);
    if !scheduled {
        report.errors.push(format!(
            "remove {}: {reason}; could not schedule the remaining files for reboot",
            path.display()
        ));
    }
}

fn remove_owned_path(path: &Path) -> std::io::Result<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        // A directory symlink/junction is removed as a link, never traversed.
        match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(_) => std::fs::remove_dir(path),
        }
    } else if metadata.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
}

/// Schedule the current remaining tree deepest-first. A non-empty directory
/// cannot be deleted by MoveFileEx, so files and nested empty directories are
/// registered individually before their parent.
fn schedule_tree_for_reboot(path: &Path, report: &mut PurgeReport) -> bool {
    let mut candidates = Vec::new();
    collect_tree_postorder(path, &mut candidates);
    candidates.sort_by_key(|candidate| std::cmp::Reverse(candidate.components().count()));

    let mut scheduled_any = false;
    for candidate in candidates {
        if std::fs::symlink_metadata(&candidate).is_err() {
            continue;
        }
        match schedule_delete_for_reboot(&candidate) {
            Ok(()) => {
                report.scheduled_for_reboot.push(candidate);
                scheduled_any = true;
            }
            Err(error)
                if error.code() == ERROR_FILE_NOT_FOUND.to_hresult()
                    || error.code() == ERROR_PATH_NOT_FOUND.to_hresult() => {}
            Err(error) => report.errors.push(format!(
                "schedule reboot deletion for {}: {error}",
                candidate.display()
            )),
        }
    }
    scheduled_any
}

fn collect_tree_postorder(path: &Path, output: &mut Vec<PathBuf>) {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return,
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                collect_tree_postorder(&entry.path(), output);
            }
        }
    }
    output.push(path.to_path_buf());
}

fn schedule_delete_for_reboot(path: &Path) -> windows::core::Result<()> {
    use std::os::windows::ffi::OsStrExt;

    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        MoveFileExW(
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            MOVEFILE_DELAY_UNTIL_REBOOT,
        )
    }
}

fn delete_hklm_lume_key() -> Result<(), String> {
    let subkey: Vec<u16> = REG_LUME_KEY
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let status = unsafe { RegDeleteTreeW(HKEY_LOCAL_MACHINE, PCWSTR(subkey.as_ptr())) };
    if status == ERROR_SUCCESS || status == ERROR_FILE_NOT_FOUND || status == ERROR_PATH_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("RegDeleteTreeW failed: {status:?}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    fn temp_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "lume-uninstall-cleanup-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[test]
    fn removes_a_known_tree_without_leaving_children() {
        let root = temp_root("tree");
        fs::create_dir_all(root.join("nested")).unwrap();
        let mut file = fs::File::create(root.join("nested").join("data.txt")).unwrap();
        file.write_all(b"data").unwrap();

        let mut report = PurgeReport::default();
        remove_path_with_retries(&root, 1, &mut report);

        assert!(!root.exists(), "{:?}", report.errors);
        assert_eq!(report.removed, vec![root]);
    }

    #[test]
    fn legacy_local_appdata_cleanup_removes_only_lume_entries() {
        let root = temp_root("legacy-localappdata");
        let data = root.join("data");
        let settings = root.join("settings");
        let languages = root.join("languages");
        let plugins = root.join("plugins");
        fs::create_dir_all(data.join("PictureCache")).unwrap();
        fs::create_dir_all(&settings).unwrap();
        fs::create_dir_all(&languages).unwrap();
        fs::create_dir_all(plugins.join("demo")).unwrap();
        fs::create_dir_all(plugins.join("other")).unwrap();
        for path in [
            data.join("lume.db"),
            data.join("lume.db-wal"),
            data.join("plugin_store.db"),
            data.join("onboarding.json"),
            data.join("PictureCache/1.png"),
            data.join("unrelated.bin"),
            settings.join("settings.toml"),
            settings.join("backup.toml"),
            settings.join("unrelated.toml"),
            languages.join("en.json"),
            languages.join("other.json"),
            plugins.join("demo/plugin.toml"),
            plugins.join("other/README.txt"),
        ] {
            fs::write(path, b"x").unwrap();
        }

        remove_legacy_misplaced_installed_data_from(&root, &mut PurgeReport::default());

        assert!(!data.join("lume.db").exists());
        assert!(!data.join("lume.db-wal").exists());
        assert!(!data.join("plugin_store.db").exists());
        assert!(!data.join("onboarding.json").exists());
        assert!(!data.join("PictureCache").exists());
        assert!(data.join("unrelated.bin").exists());
        assert!(!settings.join("settings.toml").exists());
        assert!(!settings.join("backup.toml").exists());
        assert!(settings.join("unrelated.toml").exists());
        assert!(!languages.join("en.json").exists());
        assert!(languages.join("other.json").exists());
        assert!(!plugins.join("demo").exists());
        assert!(plugins.join("other/README.txt").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn temp_cleanup_is_limited_to_agent_files() {
        assert!(is_agent_temp_name(TEMP_AGENT_RESULT));
        assert!(is_agent_temp_name("lume-agent-task-42.xml"));
        assert!(!is_agent_temp_name("lume-unrelated.txt"));
        assert!(!is_agent_temp_name("lume-agent-task-42.tmp"));
    }
}
