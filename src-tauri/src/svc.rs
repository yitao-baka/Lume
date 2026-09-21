//! LumeSVC SYSTEM service (docs/ROADMAP service iteration).
//!
//! The companion `lume-svc.exe` binary registers/unregisters the service and
//! runs it as SYSTEM. Beyond the SCM lifecycle and the `\\.\pipe\LumeSVC`
//! bridge, it owns the **self-hosted full-drive file index** (`usnidx.rs`) —
//! the backend that answers file searches on machines where Everything is not
//! running. While Everything runs, the engine stays dormant (no duplicate
//! full-drive index on the machine); when Everything disappears, the watcher
//! builds the index lazily. Data-dir handoff: the elevated `--install` writes
//! `HKLM\Software\Lume\DataDir` (same user's elevated token, so its
//! `%LOCALAPPDATA%` is the right one); the SYSTEM service reads that value at
//! start (its own `%LOCALAPPDATA%` is the system profile).

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::System::Registry::HKEY;

use crate::usnidx;

pub const SERVICE_NAME: &str = "LumeSVC";
const SERVICE_DISPLAY: &str = "Lume Service";
const PIPE_NAME: &str = r"\\.\pipe\LumeSVC";
const REG_KEY: &str = r"Software\Lume";
const REG_VALUE: &str = "DataDir";
const AUTOSTART_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE: &str = "Lume";
/// How often the dormancy watcher re-checks whether Everything is running.
const ENGINE_WATCH_INTERVAL: Duration = Duration::from_secs(60);
/// Deepest page start the pipe accepts. The engine's candidate heap is
/// bounded by skip + max, so this doubles as the cost cap for one query.
const MAX_SKIP: u64 = 2000;

/// Set by the control handler on STOP so the worker threads can exit and
/// `service_main` reports STOPPED promptly (SCM gives ~30s).
static STOP_FLAG: AtomicBool = AtomicBool::new(false);
/// Current service status handle (single-service process), stored as an
/// integer so the static is `Send` (the raw pointer it wraps is not).
static STATUS_HANDLE: Mutex<Option<usize>> = Mutex::new(None);

/// State shared between the service's worker threads.
struct Shared {
    data_dir: Mutex<Option<PathBuf>>,
    engine: Arc<usnidx::Engine>,
}

/// Service status reported to the settings UI.
#[derive(Serialize)]
pub struct SvcStatus {
    pub installed: bool,
    pub running: bool,
    pub bin_path: Option<String>,
}

/// `SERVICE_DELETE` access right (not exposed as a constant by the windows
/// crate, so defined here).
const SERVICE_DELETE_ACCESS: u32 = 0x0001_0000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn win_err(e: windows::core::Error) -> String {
    e.to_string()
}

const ZERO: windows::Win32::Foundation::WIN32_ERROR =
    windows::Win32::Foundation::WIN32_ERROR(0);

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

fn reg_read_string(hkey: HKEY, subkey: &str, value: &str) -> Option<String> {
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, KEY_READ, REG_SZ, REG_VALUE_TYPE,
    };
    let sub = wide(subkey);
    let name = wide(value);
    let mut key = HKEY(std::ptr::null_mut());
    let rc = unsafe {
        RegOpenKeyExW(hkey, PCWSTR(sub.as_ptr()), None, KEY_READ, &mut key)
    };
    if rc != ZERO {
        return None;
    }
    let mut buf = vec![0u16; 2048];
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
    if rc != ZERO || ty.0 != REG_SZ.0 {
        return None;
    }
    let n = (len as usize / 2).saturating_sub(1); // strip trailing NUL
    let s = String::from_utf16(&buf[..n]).ok()?;
    (!s.is_empty()).then_some(s)
}

fn reg_write_string(hkey: HKEY, subkey: &str, value: &str, data: &str) -> Result<(), String> {
    use windows::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, KEY_WRITE, REG_CREATE_KEY_DISPOSITION,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    let sub = wide(subkey);
    let name = wide(value);
    let mut key = HKEY(std::ptr::null_mut());
    let mut disposition = REG_CREATE_KEY_DISPOSITION(0);
    let rc = unsafe {
        RegCreateKeyExW(
            hkey,
            PCWSTR(sub.as_ptr()),
            None,
            PCWSTR(std::ptr::null()),
            REG_OPTION_NON_VOLATILE,
            KEY_WRITE,
            None,
            &mut key,
            Some(&mut disposition),
        )
    };
    if rc != ZERO {
        return Err(format!("RegCreateKeyExW failed: {rc:?}"));
    }
    // REG_SZ stores a NUL-terminated UTF-16LE string; RegSetValueExW does not
    // transcode its byte buffer, so build the wide bytes ourselves (the wrapper
    // passes cbData = slice.len(), which already includes the terminator).
    let wide = wide(data);
    let mut bytes = Vec::with_capacity(wide.len() * 2);
    for unit in wide {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    let rc = unsafe {
        RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&bytes))
    };
    let _ = unsafe { RegCloseKey(key) };
    if rc != ZERO {
        return Err(format!("RegSetValueExW failed: {rc:?}"));
    }
    Ok(())
}

fn reg_delete_value(hkey: HKEY, subkey: &str, value: &str) -> Result<(), String> {
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegDeleteValueW, RegOpenKeyExW, HKEY, KEY_SET_VALUE,
    };
    let sub = wide(subkey);
    let name = wide(value);
    let mut key = HKEY(std::ptr::null_mut());
    let rc = unsafe { RegOpenKeyExW(hkey, PCWSTR(sub.as_ptr()), None, KEY_SET_VALUE, &mut key) };
    if rc != ZERO {
        return Ok(()); // key missing → nothing to delete
    }
    let rc = unsafe { RegDeleteValueW(key, PCWSTR(name.as_ptr())) };
    let _ = unsafe { RegCloseKey(key) };
    if rc != ZERO && rc != ERROR_FILE_NOT_FOUND {
        return Err(format!("RegDeleteValueW failed: {rc:?}"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// GUI-side Tauri commands
// ---------------------------------------------------------------------------

/// Whether the service is installed and running (`QueryServiceStatus`, which a
/// normal user may read).
#[tauri::command]
pub fn svc_status() -> Result<SvcStatus, String> {
    use windows::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceStatus, SERVICE_QUERY_CONFIG,
        SERVICE_QUERY_STATUS, SERVICE_RUNNING, SERVICE_STATUS,
    };
    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), 1 /* SC_MANAGER_CONNECT */)
            .map_err(win_err)?;
        let name = wide(SERVICE_NAME);
        let svc = OpenServiceW(
            scm,
            PCWSTR(name.as_ptr()),
            SERVICE_QUERY_STATUS | SERVICE_QUERY_CONFIG,
        );
        let (installed, running, bin_path) = match svc {
            Ok(svc) => {
                let mut st = SERVICE_STATUS::default();
                let running = QueryServiceStatus(svc, &mut st).is_ok()
                    && st.dwCurrentState == SERVICE_RUNNING;
                let bin = query_bin_path(svc);
                let _ = CloseServiceHandle(svc);
                (true, running, bin)
            }
            Err(_) => (false, false, None),
        };
        let _ = CloseServiceHandle(scm);
        Ok(SvcStatus {
            installed,
            running,
            bin_path,
        })
    }
}

/// The service binary's configured image path (two-call `QueryServiceConfigW`).
fn query_bin_path(hservice: windows::Win32::System::Services::SC_HANDLE) -> Option<String> {
    use windows::Win32::System::Services::{QueryServiceConfigW, QUERY_SERVICE_CONFIGW};
    unsafe {
        let mut needed = 0u32;
        // First call reports ERROR_INSUFFICIENT_BUFFER and fills `needed`.
        let first = QueryServiceConfigW(hservice, None, 0, &mut needed);
        if first.is_err() && needed > 0 {
            let mut buf = vec![0u8; needed as usize];
            let ok = QueryServiceConfigW(
                hservice,
                Some(buf.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW),
                buf.len() as u32,
                &mut needed,
            );
            if ok.is_ok() {
                let cfg = &*(buf.as_ptr() as *const QUERY_SERVICE_CONFIGW);
                if !cfg.lpBinaryPathName.is_null() {
                    return cfg.lpBinaryPathName.to_string().ok();
                }
            }
        }
    }
    None
}

/// Ask Windows to run `lume-svc.exe --install` elevated (`runas` → UAC). The
/// elevated process does the actual `CreateServiceW` work and exits.
#[tauri::command]
pub fn svc_install() -> Result<(), String> {
    let svc_exe = crate::paths::exe_dir().join("lume-svc.exe");
    if !svc_exe.exists() {
        return Err("lume-svc.exe not found next to the launcher".into());
    }
    launch_elevated(&svc_exe, "--install")
}

/// Ask Windows to run `lume-svc.exe --uninstall` elevated.
#[tauri::command]
pub fn svc_uninstall() -> Result<(), String> {
    let svc_exe = crate::paths::exe_dir().join("lume-svc.exe");
    if !svc_exe.exists() {
        return Err("lume-svc.exe not found next to the launcher".into());
    }
    launch_elevated(&svc_exe, "--uninstall")
}

/// Launch a program elevated via `ShellExecuteW("runas")`. The UAC prompt is
/// the only interaction; cancel maps to a friendly "canceled" error. Shared
/// with the injection agent's install/uninstall verbs (`agent.rs`).
pub(crate) fn launch_elevated(exe: &std::path::Path, arg: &str) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;
    let file: Vec<u16> = exe.to_string_lossy().encode_utf16().chain(std::iter::once(0)).collect();
    let params: Vec<u16> = arg.encode_utf16().chain(std::iter::once(0)).collect();
    let verb: Vec<u16> = "runas".encode_utf16().chain(std::iter::once(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut() as HWND,
            verb.as_ptr(),
            file.as_ptr(),
            params.as_ptr(),
            std::ptr::null(),
            SW_HIDE,
        )
    };
    let code = result as isize;
    if code == ERROR_CANCELLED as isize {
        return Err("canceled".into());
    }
    if code <= 32 {
        return Err(format!("ShellExecuteW failed with code {code}"));
    }
    Ok(())
}

/// Whether Lume is registered to auto-start at login (HKCU Run key).
#[tauri::command]
pub fn autostart_get() -> Result<bool, String> {
    use windows::Win32::System::Registry::HKEY_CURRENT_USER;
    Ok(reg_read_string(HKEY_CURRENT_USER, AUTOSTART_KEY, AUTOSTART_VALUE).is_some())
}

/// Register/remove the login auto-start (HKCU Run, no admin needed). The value
/// is the quoted exe path so a path with spaces still launches.
#[tauri::command]
pub fn autostart_set(enabled: bool) -> Result<(), String> {
    use windows::Win32::System::Registry::HKEY_CURRENT_USER;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        reg_write_string(
            HKEY_CURRENT_USER,
            AUTOSTART_KEY,
            AUTOSTART_VALUE,
            &format!("\"{}\"", exe.to_string_lossy()),
        )
    } else {
        reg_delete_value(HKEY_CURRENT_USER, AUTOSTART_KEY, AUTOSTART_VALUE)
    }
}

// ---------------------------------------------------------------------------
// Service install / uninstall (elevated `lume-svc.exe --install/--uninstall`)
// ---------------------------------------------------------------------------

/// Create the LumeSVC service (LocalSystem, AUTO start) and start it. Must run
/// with an elevated token — the GUI reaches this via `runas`.
pub fn install() -> Result<(), String> {
    ensure_elevated()?;

    // The writable data root for the user this elevated process belongs to.
    let base = std::env::var_os("LOCALAPPDATA")
        .map(|p| PathBuf::from(p).join("Lume"))
        .unwrap_or_else(crate::paths::base_dir);
    use windows::Win32::System::Registry::HKEY_LOCAL_MACHINE;
    crate::paths::set_base_dir(base.clone());
    reg_write_string(HKEY_LOCAL_MACHINE, REG_KEY, REG_VALUE, &base.to_string_lossy())
        .map_err(|e| format!("writing DataDir: {e}"))?;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    use windows::Win32::System::Services::{
        ChangeServiceConfig2W, CloseServiceHandle, CreateServiceW, OpenSCManagerW,
        SERVICE_ALL_ACCESS, SERVICE_AUTO_START, SERVICE_CONFIG_DESCRIPTION, SERVICE_DESCRIPTIONW,
        SERVICE_ERROR_IGNORE, SERVICE_WIN32_OWN_PROCESS, StartServiceW,
    };
    unsafe {
        let scm = OpenSCManagerW(
            PCWSTR::null(),
            PCWSTR::null(),
            2 | 1, // SC_MANAGER_CREATE_SERVICE | SC_MANAGER_CONNECT
        )
        .map_err(win_err)?;
        let name = wide(SERVICE_NAME);
        let display = wide(SERVICE_DISPLAY);
        let path = wide(&exe.to_string_lossy());
        let svc = CreateServiceW(
            scm,
            PCWSTR(name.as_ptr()),
            PCWSTR(display.as_ptr()),
            SERVICE_ALL_ACCESS,
            SERVICE_WIN32_OWN_PROCESS,
            SERVICE_AUTO_START,
            SERVICE_ERROR_IGNORE,
            PCWSTR(path.as_ptr()),
            PCWSTR::null(), // load-order group
            None,           // tag id
            PCWSTR::null(), // dependencies
            PCWSTR::null(), // start name → LocalSystem
            PCWSTR::null(), // password
        );
        let svc = match svc {
            Ok(h) => h,
            Err(e) => {
                let _ = CloseServiceHandle(scm);
                return Err(format!("CreateServiceW failed: {e}"));
            }
        };
        // Friendly description shown in services.msc.
        let desc_text = wide("Lume background service (full-drive file index for instant file search)");
        let desc = SERVICE_DESCRIPTIONW {
            lpDescription: PWSTR(desc_text.as_ptr() as *mut u16),
        };
        let _ = ChangeServiceConfig2W(
            svc,
            SERVICE_CONFIG_DESCRIPTION,
            Some(&desc as *const SERVICE_DESCRIPTIONW as *const core::ffi::c_void),
        );
        let _ = StartServiceW(svc, None);
        let _ = CloseServiceHandle(svc);
        let _ = CloseServiceHandle(scm);
    }
    Ok(())
}

/// Stop (if running), delete the service and remove the DataDir value. Tolerant
/// of "not installed" so it is idempotent.
pub fn uninstall() -> Result<(), String> {
    ensure_elevated()?;
    use windows::Win32::System::Registry::HKEY_LOCAL_MACHINE;
    use windows::Win32::System::Services::{
        CloseServiceHandle, ControlService, DeleteService, OpenSCManagerW, OpenServiceW,
        QueryServiceStatus, SERVICE_CONTROL_STOP, SERVICE_QUERY_STATUS, SERVICE_STOP,
        SERVICE_STATUS, SERVICE_STOPPED,
    };
    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), 1 /* SC_MANAGER_CONNECT */)
            .map_err(win_err)?;
        let name = wide(SERVICE_NAME);
        let svc = OpenServiceW(
            scm,
            PCWSTR(name.as_ptr()),
            SERVICE_STOP | SERVICE_QUERY_STATUS | SERVICE_DELETE_ACCESS,
        );
        let svc = match svc {
            Ok(h) => h,
            Err(_) => {
                // Not installed → nothing to do (also fires when stopping).
                let _ = CloseServiceHandle(scm);
                let _ = reg_delete_value(HKEY_LOCAL_MACHINE, REG_KEY, REG_VALUE);
                return Ok(());
            }
        };
        // Stop if running, waiting up to ~30s for STOPPED.
        let mut st = SERVICE_STATUS::default();
        let running = QueryServiceStatus(svc, &mut st).is_ok()
            && st.dwCurrentState != SERVICE_STOPPED;
        if running {
            let _ = ControlService(svc, SERVICE_CONTROL_STOP, &mut st);
            for _ in 0..150 {
                let _ = QueryServiceStatus(svc, &mut st);
                if st.dwCurrentState == SERVICE_STOPPED {
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        DeleteService(svc).map_err(win_err)?;
        let _ = CloseServiceHandle(svc);
        let _ = CloseServiceHandle(scm);
    }
    let _ = reg_delete_value(HKEY_LOCAL_MACHINE, REG_KEY, REG_VALUE);
    Ok(())
}

/// Refuse to run install/uninstall unless the token is elevated. Shared with
/// `agent.rs` (its `--install-task` / `--uninstall-task` verbs).
pub(crate) fn ensure_elevated() -> Result<(), String> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION};
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let process = GetCurrentProcess();
        let mut token = HANDLE(std::ptr::null_mut());
        OpenProcessToken(process, windows::Win32::Security::TOKEN_QUERY, &mut token)
            .map_err(win_err)?;
        let mut elev = TOKEN_ELEVATION { TokenIsElevated: 0 };
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elev as *mut TOKEN_ELEVATION as *mut core::ffi::c_void),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut len,
        );
        let _ = CloseHandle(token);
        ok.map_err(win_err)?;
        if elev.TokenIsElevated == 0 {
            return Err("elevation required (launch via the settings button)".into());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Service runtime (SCM dispatcher / foreground)
// ---------------------------------------------------------------------------

/// Run as a Windows service: register with the SCM and block until STOP.
pub fn run_service() -> Result<(), String> {
    use windows::Win32::System::Services::{StartServiceCtrlDispatcherW, SERVICE_TABLE_ENTRYW};
    unsafe {
        let name = wide(SERVICE_NAME);
        let table = [
            SERVICE_TABLE_ENTRYW {
                lpServiceName: PWSTR(name.as_ptr() as *mut u16),
                lpServiceProc: Some(service_main),
            },
            SERVICE_TABLE_ENTRYW::default(),
        ];
        StartServiceCtrlDispatcherW(table.as_ptr()).map_err(|e| {
            // HRESULT_FROM_WIN32(ERROR_FAILED_SERVICE_CONTROLLER_CONNECT = 1063).
            if (e.code().0 as u32) == 0x8007_0427 {
                "not started by the service control manager".into()
            } else {
                e.to_string()
            }
        })?;
    }
    Ok(())
}

/// Foreground mode for development/testing: no SCM, runs the pipe server until
/// Ctrl+C.
pub fn run_foreground(data_dir_override: Option<PathBuf>) -> Result<(), String> {
    if let Some(dir) = data_dir_override {
        crate::paths::set_base_dir(dir);
    } else if crate::paths::install_detected() {
        crate::paths::set_base_dir(crate::paths::base_dir());
    }
    let shared = Arc::new(Shared {
        data_dir: Mutex::new(Some(crate::paths::base_dir())),
        engine: Arc::new(usnidx::Engine::new()),
    });
    spawn_engine_watcher(Arc::clone(&shared.engine));
    std::thread::spawn({
        let s = shared.clone();
        move || pipe_server(s)
    });
    eprintln!("[lume-svc] running in foreground; Ctrl+C to quit");
    loop {
        std::thread::sleep(Duration::from_secs(1));
    }
}

unsafe extern "system" fn service_main(_argc: u32, _argv: *mut PWSTR) {
    use windows::Win32::System::Services::{
        RegisterServiceCtrlHandlerExW, SERVICE_ACCEPT_STOP, SERVICE_RUNNING, SERVICE_START_PENDING,
        SERVICE_STOPPED,
    };
    unsafe {
        let name = wide(SERVICE_NAME);
        let Ok(handle) =
            RegisterServiceCtrlHandlerExW(PCWSTR(name.as_ptr()), Some(control_handler), None)
        else {
            return;
        };
        *STATUS_HANDLE.lock().unwrap() = Some(handle.0 as usize);
        report_status(&handle, SERVICE_START_PENDING, 0, 1, 3000);

        // Resolve the real user data dir (registry DataDir), then pin it.
        let data_dir = crate::paths::base_dir();
        crate::paths::set_base_dir(data_dir.clone());

        report_status(&handle, SERVICE_RUNNING, SERVICE_ACCEPT_STOP, 0, 0);

        let shared = Arc::new(Shared {
            data_dir: Mutex::new(Some(data_dir)),
            engine: Arc::new(usnidx::Engine::new()),
        });
        spawn_engine_watcher(Arc::clone(&shared.engine));
        std::thread::spawn({
            let s = shared.clone();
            move || pipe_server(s)
        });

        // Block until the control handler raises STOP.
        while !STOP_FLAG.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(200));
        }
        report_status(&handle, SERVICE_STOPPED, 0, 0, 0);
    }
}

unsafe extern "system" fn control_handler(
    ctrl: u32,
    _event: u32,
    _data: *mut core::ffi::c_void,
    _ctx: *mut core::ffi::c_void,
) -> u32 {
    use windows::Win32::System::Services::{
        SERVICE_ACCEPT_STOP, SERVICE_CONTROL_INTERROGATE, SERVICE_CONTROL_STOP, SERVICE_RUNNING,
        SERVICE_STOP_PENDING,
    };
    use windows::Win32::System::Services::SERVICE_STATUS_HANDLE;
    let handle = STATUS_HANDLE
        .lock()
        .unwrap()
        .clone()
        .map(|h| SERVICE_STATUS_HANDLE(h as *mut core::ffi::c_void));
    match ctrl {
        SERVICE_CONTROL_STOP => {
            STOP_FLAG.store(true, Ordering::Relaxed);
            if let Some(h) = handle {
                report_status(&h, SERVICE_STOP_PENDING, 0, 1, 5000);
            }
            0 // NO_ERROR
        }
        SERVICE_CONTROL_INTERROGATE => {
            if let Some(h) = handle {
                report_status(&h, SERVICE_RUNNING, SERVICE_ACCEPT_STOP, 0, 0);
            }
            0
        }
        _ => 120, // ERROR_CALL_NOT_IMPLEMENTED
    }
}

fn report_status(
    handle: &windows::Win32::System::Services::SERVICE_STATUS_HANDLE,
    state: windows::Win32::System::Services::SERVICE_STATUS_CURRENT_STATE,
    controls_accepted: u32,
    checkpoint: u32,
    wait_hint: u32,
) {
    use windows::Win32::System::Services::{SetServiceStatus, SERVICE_STATUS, SERVICE_WIN32_OWN_PROCESS};
    let status = SERVICE_STATUS {
        dwServiceType: SERVICE_WIN32_OWN_PROCESS,
        dwCurrentState: state,
        dwControlsAccepted: controls_accepted,
        dwWin32ExitCode: 0,
        dwServiceSpecificExitCode: 0,
        dwCheckPoint: checkpoint,
        dwWaitHint: wait_hint,
    };
    let _ = unsafe { SetServiceStatus(*handle, &status) };
}

/// Engine dormancy watcher: while Everything is running the self-hosted index
/// stays off (no duplicate full-drive index on the machine); when Everything
/// disappears the engine builds lazily and keeps itself fresh.
fn spawn_engine_watcher(engine: Arc<usnidx::Engine>) {
    std::thread::spawn(move || loop {
        if everything_running() {
            engine.set_off();
        } else {
            engine.ensure_running();
        }
        std::thread::sleep(ENGINE_WATCH_INTERVAL);
    });
}

/// Whether an Everything process that owns an interactive session exists
/// (name match via the toolhelp snapshot). Window-message IPC is session-
/// scoped, so a SYSTEM service can't probe Everything's UI window — process
/// existence is the right signal, **but only in an interactive session**:
/// Everything installs its own headless Windows *service* instance
/// (session 0) that answers no IPC queries at all. Counting that one would
/// keep the engine dormant forever on machines where the Everything UI is
/// closed — exactly the case the self-hosted index exists for.
fn everything_running() -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    use windows::Win32::System::RemoteDesktop::ProcessIdToSessionId;
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut found = false;
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                let len = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if name.eq_ignore_ascii_case("Everything.exe") {
                    let mut session = 0u32;
                    let session = ProcessIdToSessionId(entry.th32ProcessID, &mut session)
                        .ok()
                        .map(|_| session);
                    if everything_counts(session) {
                        found = true;
                        break;
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        found
    }
}

/// Pure decision core of `everything_running`: does an Everything process
/// with this session id imply "Everything is in use"? Only interactive-
/// session instances own the UI window the launcher's IPC talks to. A failed
/// session lookup (`None`) counts as not-running — fail toward indexing.
fn everything_counts(session: Option<u32>) -> bool {
    matches!(session, Some(s) if s != 0)
}

/// Named-pipe server: length-prefixed JSON requests in, length-prefixed JSON
/// replies out. Verbs: `hello` (data-dir handoff), `search` (file search via
/// the usnidx engine), `status` (engine state). The accept loop keeps one
/// instance listening at all times and hands each accepted connection to its
/// own thread, so the next client can connect while the previous one is still
/// being served — a strictly serial accept loop (one instance total) made the
/// second of two back-to-back queries fail with `ERROR_PIPE_BUSY` whenever the
/// first took longer than the client's retry budget (per-keystroke searches
/// are ~100ms apart, an engine scan is not). Requests are one message each.
fn pipe_server(shared: Arc<Shared>) {
    use windows::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::System::Pipes::{
        CreateNamedPipeW, NAMED_PIPE_MODE, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE,
        PIPE_UNLIMITED_INSTANCES,
    };

    const SDDL: &str = "D:(A;;GA;;;AU)(A;;GA;;;SY)"; // Authenticated Users + SYSTEM
    let sddl = wide(SDDL);
    let name = wide(PIPE_NAME);

    let mut sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let sddl_ok = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), 1, &mut sd, None)
    }
    .is_ok();
    let sa = sddl_ok.then(|| SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: false.into(),
    });
    // `sa.lpSecurityDescriptor` still points at `sd`, which every accept-loop
    // iteration hands to CreateNamedPipeW (it copies per instance). The
    // descriptor is therefore kept alive for the server's lifetime instead of
    // being freed here — one small allocation, freed at process exit.

    loop {
        if STOP_FLAG.load(Ordering::Relaxed) {
            return;
        }
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX,
                NAMED_PIPE_MODE(PIPE_TYPE_MESSAGE.0 | PIPE_READMODE_MESSAGE.0),
                PIPE_UNLIMITED_INSTANCES,
                65536, // out: search replies carry up to ~100 paths
                4096,
                0,
                sa.as_ref().map(|p| p as *const SECURITY_ATTRIBUTES),
            )
        };
        if pipe == INVALID_HANDLE_VALUE {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }

        // Block until a client connects, then let a worker finish the
        // exchange while this loop immediately offers the next instance.
        if !crate::pipe::accept_client(pipe) {
            // The instance is unusable (the client vanished, the handle broke).
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(pipe) };
            continue;
        }
        let shared = Arc::clone(&shared);
        // The handle has to cross a thread boundary; it is a process-wide
        // kernel handle, so moving it is sound.
        let pipe = crate::pipe::SendHandle(pipe);
        let _ = std::thread::Builder::new()
            .name("svc-conn".into())
            .spawn(move || serve_connection(shared, pipe));
    }
}

/// Serve one accepted connection: read the request, dispatch, reply, then
/// linger until the client hangs up before recycling the instance.
fn serve_connection(shared: Arc<Shared>, wrapper: crate::pipe::SendHandle) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows::Win32::System::Pipes::DisconnectNamedPipe;
    let pipe = wrapper.0;

    let mut buf = [0u8; 4096];
    let mut n: u32 = 0;
    let ok = unsafe { ReadFile(pipe, Some(&mut buf), Some(&mut n), None) };
    if ok.is_ok() && n >= 4 {
        let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
        if len + 4 <= n as usize {
            let payload = String::from_utf8_lossy(&buf[4..4 + len]).into_owned();
            let reply = handle_message(&shared, &payload);
            let mut out = Vec::with_capacity(reply.len() + 4);
            out.extend_from_slice(&(reply.len() as u32).to_le_bytes());
            out.extend_from_slice(reply.as_bytes());
            let _ = unsafe { WriteFile(pipe, Some(&out), None, None) };
            // Wait for the client to hang up before recycling the pipe
            // instance: DisconnectNamedPipe discards data the client has
            // not read yet, so an immediate disconnect would race the
            // reply out of the buffer (classic lost-reply bug).
            let mut drain = [0u8; 64];
            let mut dn: u32 = 0;
            let _ = unsafe { ReadFile(pipe, Some(&mut drain), Some(&mut dn), None) };
        }
    }
    let _ = unsafe { DisconnectNamedPipe(pipe) };
    let _ = unsafe { CloseHandle(pipe) };
}

/// Dispatch one request. Every verb replies with a length-prefixed JSON
/// message (see `pipe_transact` on the GUI side).
fn handle_message(shared: &Shared, payload: &str) -> String {
    let Ok(msg) = serde_json::from_str::<serde_json::Value>(payload) else {
        return r#"{"t":"error","message":"bad json"}"#.into();
    };
    match msg.get("t").and_then(|v| v.as_str()) {
        Some("hello") => {
            if let Some(dir) = msg.get("data_dir").and_then(|v| v.as_str()) {
                let p = PathBuf::from(dir);
                crate::paths::set_base_dir(p.clone());
                *shared.data_dir.lock().unwrap() = Some(p);
            }
            r#"{"t":"hello_ack","ok":true}"#.into()
        }
        Some("search") => {
            let query = msg.get("q").and_then(|v| v.as_str()).unwrap_or("");
            let max = msg
                .get("max")
                .and_then(|v| v.as_u64())
                .unwrap_or(50)
                .clamp(1, 100) as usize;
            // Paging and the name filter are evaluated inside the scan: the
            // caller cannot ask for `offset + max` hits and trim (its own
            // request cap is 100, which truncated every page past the third),
            // and a category filter has to be tested per candidate because the
            // name ranking buries matches thousands of hits deep.
            let skip = msg
                .get("skip")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                .min(MAX_SKIP) as usize;
            let filter = crate::usnidx::NameFilter::from_json(&msg);
            let (status, hits) = shared.engine.search(query, max, skip, &filter);
            let items = serde_json::to_string(&hits).unwrap_or_else(|_| "[]".into());
            // Echo what was actually applied. Callers older than this build
            // ignore `skip`/`exts`/`folder` entirely and send no echo — that
            // absence is how the launcher tells "this service understood" and
            // falls back to its own trimming/filtering instead of showing
            // unfiltered hits as if they were filtered.
            let filter_json = match filter.to_syntax() {
                Some(s) => serde_json::to_string(&s).unwrap_or_else(|_| "null".into()),
                None => "null".into(),
            };
            format!(
                r#"{{"t":"results","status":"{status}","skip":{skip},"filter":{filter_json},"items":{items}}}"#
            )
        }
        Some("debug") => {
            let n = msg.get("n").and_then(|v| v.as_u64()).unwrap_or(5) as usize;
            let payload = shared.engine.debug_samples(n.min(20));
            format!(r#"{{"t":"debug","payload":{payload}}}"#)
        }
        Some("status") => {
            let (state, files, error) = shared.engine.status();
            match error {
                Some(e) => {
                    let err = serde_json::to_string(&e).unwrap_or_else(|_| "\"?\"".into());
                    format!(r#"{{"t":"status","state":"{state}","files":{files},"error":{err}}}"#)
                }
                None => format!(r#"{{"t":"status","state":"{state}","files":{files}}}"#),
            }
        }
        _ => r#"{"t":"error","message":"unknown verb"}"#.into(),
    }
}

// ---------------------------------------------------------------------------
// Pipe client (GUI side)
// ---------------------------------------------------------------------------

/// One request/reply exchange with the service over `\\.\pipe\LumeSVC`,
/// bounded by `timeout` (a hung service must never stall the search path —
/// the worker thread is abandoned on timeout and dies with its next pipe op).
pub fn pipe_transact(payload: &str, timeout: Duration) -> Result<String, String> {
    crate::pipe::transact(PIPE_NAME, payload, timeout)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Everything **service** instance (session 0) must not count as
    /// "in use" — it answers no IPC queries, so Lume must index for itself
    /// when the Everything UI is closed (the headless-instance bug).
    #[test]
    fn dormancy_only_counts_interactive_everything() {
        assert!(!everything_counts(Some(0))); // headless service instance
        assert!(everything_counts(Some(1))); // UI in a user session
        assert!(everything_counts(Some(42)));
        assert!(!everything_counts(None)); // session lookup failed → index
    }

    /// Live round trip against a running service (foreground or SCM):
    /// `lume-svc.exe --foreground`, then run this test.
    #[test]
    #[ignore] // requires the service (or --foreground) to be running
    fn live_pipe_status() {
        let reply = pipe_transact(r#"{"t":"debug","n":4}"#, Duration::from_secs(2)).expect("debug");
        eprintln!("debug reply: {reply}");
        let reply = pipe_transact(r#"{"t":"status"}"#, Duration::from_secs(2)).expect("status");
        eprintln!("status reply: {reply}");
        assert!(reply.contains(r#""t":"status""#));
        let reply = pipe_transact(r#"{"t":"search","q":"readme","max":3}"#, Duration::from_secs(2))
            .expect("search");
        eprintln!("search reply: {reply}");
        assert!(reply.contains(r#""t":"results""#));

        // Paging and the name filter are applied inside the scan and echoed
        // back — that echo is what tells the launcher the service really
        // understood them (a pre-2026-09-21 service ignores both fields and
        // echoes neither, and the launcher must not claim otherwise).
        let reply = pipe_transact(
            r#"{"t":"search","q":"log","max":5,"skip":0,"exts":["png"],"folder":false}"#,
            Duration::from_secs(2),
        )
        .expect("filtered search");
        eprintln!("filtered reply: {reply}");
        assert!(reply.contains(r#""filter":"ext:png""#), "filter echo: {reply}");
        assert!(reply.contains(r#""skip":0"#), "skip echo: {reply}");
        let reply = pipe_transact(
            r#"{"t":"search","q":"","max":5,"skip":0,"exts":["png"],"folder":false}"#,
            Duration::from_secs(2),
        )
        .expect("filter-only search");
        eprintln!("filter-only reply: {reply}");
        assert!(reply.contains(r#""t":"results""#), "a filter alone scans: {reply}");
    }

    /// Regression: the serial single-instance accept loop made the second of
    /// two back-to-back queries fail with `connect pipe: busy/failed` whenever
    /// the first was still being served (its instance was occupied and the
    /// client gave up after ~100 ms of retries — an engine scan takes
    /// ~100-150 ms). With per-connection threads every query must connect.
    /// Uses `search`, not the instant `status`, so each request actually
    /// occupies the server for a while. `lume-svc.exe --foreground` (or the
    /// service) with a built index, then run this test.
    #[test]
    #[ignore] // requires the service (or --foreground) to be running
    fn live_pipe_rapid_back_to_back_queries() {
        for i in 0..10 {
            let reply = pipe_transact(r#"{"t":"search","q":"e","max":50}"#, Duration::from_secs(2))
                .unwrap_or_else(|e| panic!("query {i} failed: {e}"));
            assert!(reply.contains(r#""t":"results""#), "query {i}: {reply}");
        }
    }
}
