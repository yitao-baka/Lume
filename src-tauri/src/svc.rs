//! LumeSVC SYSTEM service (docs/ROADMAP service iteration).
//!
//! The companion `lume-svc.exe` binary registers/unregisters the service and
//! runs it as SYSTEM. It is a **dormant bridge for future features** — it holds
//! the SCM lifecycle and a named pipe, but does no work today: the launcher is
//! the sole refresher of the index-cache DBs.
//!
//! Data-dir handoff: the elevated `--install` writes
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

pub const SERVICE_NAME: &str = "LumeSVC";
const SERVICE_DISPLAY: &str = "Lume Service";
const PIPE_NAME: &str = r"\\.\pipe\LumeSVC";
const REG_KEY: &str = r"Software\Lume";
const REG_VALUE: &str = "DataDir";
const AUTOSTART_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE: &str = "Lume";

/// Set by the control handler on STOP so the worker threads can exit and
/// `service_main` reports STOPPED promptly (SCM gives ~30s).
static STOP_FLAG: AtomicBool = AtomicBool::new(false);
/// Current service status handle (single-service process), stored as an
/// integer so the static is `Send` (the raw pointer it wraps is not).
static STATUS_HANDLE: Mutex<Option<usize>> = Mutex::new(None);

/// State shared between the service's worker threads.
struct Shared {
    data_dir: Mutex<Option<PathBuf>>,
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
    let rc = unsafe {
        RegSetValueExW(key, PCWSTR(name.as_ptr()), None, REG_SZ, Some(data.as_bytes()))
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
/// the only interaction; cancel maps to a friendly "canceled" error.
fn launch_elevated(exe: &std::path::Path, arg: &str) -> Result<(), String> {
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
        let desc_text = wide("Lume background service (bridge for future SYSTEM features)");
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

/// Refuse to run install/uninstall unless the token is elevated.
fn ensure_elevated() -> Result<(), String> {
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
    });
    std::thread::spawn({
        let s = shared.clone();
        move || pipe_server(s)
    });
    eprintln!("[lume-svc] running in foreground (dormant); Ctrl+C to quit");
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
        });
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

/// Named-pipe server: accept a HELLO carrying the data dir and reply. The
/// protocol is the future bridge's IPC surface; today the service only records
/// the data dir. Blocking single-thread accept loop.
fn pipe_server(shared: Arc<Shared>) {
    use windows::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::Storage::FileSystem::{PIPE_ACCESS_DUPLEX, ReadFile, WriteFile};
    use windows::Win32::System::Pipes::{
        ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, NAMED_PIPE_MODE,
        PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE, PIPE_UNLIMITED_INSTANCES,
    };
    use windows::Win32::Foundation::LocalFree;

    const SDDL: &str = "D:(A;;GA;;;AU)(A;;GA;;;SY)"; // Authenticated Users + SYSTEM
    let sddl = wide(SDDL);

    loop {
        if STOP_FLAG.load(Ordering::Relaxed) {
            return;
        }
        let mut sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
        let has_sa = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(PCWSTR(sddl.as_ptr()), 1, &mut sd, None)
        }
        .is_ok();
        let sa = if has_sa {
            Some(SECURITY_ATTRIBUTES {
                nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: sd.0,
                bInheritHandle: false.into(),
            })
        } else {
            None
        };

        let name = wide(PIPE_NAME);
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(name.as_ptr()),
                PIPE_ACCESS_DUPLEX,
                NAMED_PIPE_MODE(PIPE_TYPE_MESSAGE.0 | PIPE_READMODE_MESSAGE.0),
                PIPE_UNLIMITED_INSTANCES,
                4096,
                4096,
                0,
                sa.as_ref().map(|p| p as *const SECURITY_ATTRIBUTES),
            )
        };
        if has_sa {
            // The descriptor was consumed by CreateNamedPipeW; free the copy.
            let _ =
                unsafe { LocalFree(Some(windows::Win32::Foundation::HLOCAL(sd.0))) };
        }
        if pipe == INVALID_HANDLE_VALUE {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }

        // Block until a client connects.
        let _ = unsafe { ConnectNamedPipe(pipe, None) };
        let mut buf = [0u8; 4096];
        let mut n: u32 = 0;
        let ok = unsafe { ReadFile(pipe, Some(&mut buf), Some(&mut n), None) };
        if ok.is_ok() && n >= 4 {
            let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
            if len + 4 <= n as usize {
                let payload = String::from_utf8_lossy(&buf[4..4 + len]).into_owned();
                handle_hello(&shared, &payload);
            }
        }
        let ack: &[u8] = br#"{"t":"hello_ack","ok":true}"#;
        let _ = unsafe { WriteFile(pipe, Some(ack), None, None) };
        let _ = unsafe { DisconnectNamedPipe(pipe) };
        let _ = unsafe { CloseHandle(pipe) };
    }
}

/// Parse a HELLO message and update the service's data dir. Future features can
/// extend this protocol; the service is dormant today.
fn handle_hello(shared: &Shared, payload: &str) {
    #[derive(serde::Deserialize)]
    struct Hello {
        #[serde(default)]
        data_dir: Option<String>,
    }
    let Ok(msg) = serde_json::from_str::<Hello>(payload) else {
        return;
    };
    if let Some(dir) = msg.data_dir {
        let p = PathBuf::from(&dir);
        crate::paths::set_base_dir(p.clone());
        *shared.data_dir.lock().unwrap() = Some(p);
    }
}
