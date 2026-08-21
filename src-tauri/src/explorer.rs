//! Foreground-window context: when the launcher is summoned while an Explorer
//! window has focus, resolve the folder that window is showing and expose it so
//! the frontend can offer folder actions (open a terminal here, copy the path).
//!
//! The path is resolved via the shell COM `IShellWindows` interface (the same
//! mechanism ZTools' native module uses). Windows 11's tabbed Explorer nests
//! each tab's shell window inside the `CabinetWClass` tab host and renders the
//! address bar with DirectUI (no `ComboBoxEx32`/`Edit`), so `FindWindowSW` on
//! the top-level HWND does not match and the address-bar shortcut does not work.
//! Instead we find the active tab (the topmost `ShellTabWindowClass` child of
//! the captured foreground HWND — inactive tabs are stacked behind it but still
//! report visible), match it to an `IShellWindows` entry via
//! `IShellBrowser(IOleWindow::GetWindow)`, then resolve its folder via
//! `QueryActiveShellView` → `IFolderView` → `IPersistFolder2::GetCurFolder`
//! PIDL → `SHGetPathFromIDListW`. Only the foreground HWND (already captured by
//! `window::FocusState` at show time) is needed.
//!
//! Threading: the main thread is an STA COM apartment and the project moves all
//! shell-COM work off it (see `icons.rs`). `get_foreground_context` therefore
//! runs the COM on a dedicated STA thread (mirroring
//! `icons::extract_video_thumb_png`), so the hotkey show path stays clean and we
//! never collide with a pool thread's existing apartment.

use serde::Serialize;

use tauri::{AppHandle, Manager};

/// What the frontend learns about the window that had focus before the launcher
/// appeared. `path` is the local absolute folder path when the foreground window
/// was an Explorer window (and a resolvable filesystem folder); otherwise `None`.
#[derive(Serialize)]
pub struct ForegroundContext {
    pub hwnd: i32,
    pub pid: u32,
    #[serde(rename = "className")]
    pub class_name: String,
    pub title: String,
    /// Local absolute folder path, `None` when not an Explorer filesystem view.
    pub path: Option<String>,
    /// `true` when `path` resolved (the foreground window was an Explorer folder).
    pub is_explorer: bool,
}

/// Read the window that had focus before the launcher was shown and resolve the
/// folder it is displaying. The HWND is read from `FocusState` (captured in
/// `toggle_launcher`); it is copied, not taken, so clipboard auto-paste still
/// has it. COM runs on a dedicated STA thread.
#[tauri::command]
pub async fn get_foreground_context(app: AppHandle) -> Result<ForegroundContext, String> {
    use crate::window::FocusState;
    let hwnd = app
        .try_state::<FocusState>()
        .and_then(|f| *f.last_hwnd.lock().unwrap());
    let Some(hwnd) = hwnd else {
        return Ok(empty_context());
    };
    tauri::async_runtime::spawn_blocking(move || resolve_context(hwnd))
        .await
        .map_err(|e| e.to_string())
}

/// Open a terminal whose working directory is the given folder. `shell` is
/// `"cmd"` or `"powershell"`; `elevated` uses the `runas` verb (UAC prompt).
/// Goes through `ShellExecuteW`. `lpDirectory` sets the cwd, but an **elevated**
/// process starts in `C:\Windows\System32` (the `runas` broker ignores
/// `lpDirectory`), so we ALSO pass a `cd` command in `lpParameters` — the
/// terminal always ends up in the target folder regardless of elevation.
#[tauri::command]
pub fn open_terminal_in_folder(path: String, shell: String, elevated: bool) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{ERROR_CANCELLED, HWND};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let exe = if shell == "powershell" {
        format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    } else {
        format!("{root}\\System32\\cmd.exe")
    };
    let exe_wide: Vec<u16> = exe.encode_utf16().chain(std::iter::once(0)).collect();
    let dir_wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    // `cd` into the folder so an elevated process (which ignores lpDirectory)
    // still lands there. Single-quote the PS path; cmd uses a double-quoted path.
    let params: Vec<u16> = if shell == "powershell" {
        format!("-NoExit -Command \"Set-Location -LiteralPath '{path}'\"")
    } else {
        format!("/K cd /d \"{path}\"")
    }
    .encode_utf16()
    .chain(std::iter::once(0))
    .collect();
    let verb: Vec<u16> = if elevated {
        "runas".encode_utf16().chain(std::iter::once(0)).collect()
    } else {
        Vec::new()
    };
    let verb_ptr = if verb.is_empty() {
        std::ptr::null() // lpOperation → "open"
    } else {
        verb.as_ptr()
    };
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut() as HWND,
            verb_ptr,
            exe_wide.as_ptr(),
            params.as_ptr(),  // lpParameters → cd into the folder
            dir_wide.as_ptr(), // lpDirectory → the terminal's cwd (non-elevated)
            SW_SHOWNORMAL,
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

/// Copy a folder path to the system clipboard (plain text).
#[tauri::command]
pub fn copy_path(path: String) -> Result<(), String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(&path).map_err(|e| e.to_string())
}

fn empty_context() -> ForegroundContext {
    ForegroundContext {
        hwnd: 0,
        pid: 0,
        class_name: String::new(),
        title: String::new(),
        path: None,
        is_explorer: false,
    }
}

/// Classify the HWND and resolve its Explorer path. Runs on the async blocking
/// pool; the COM part itself is moved onto a dedicated STA thread.
fn resolve_context(hwnd: isize) -> ForegroundContext {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindowTextW, GetWindowThreadProcessId,
    };

    let handle = HWND(hwnd as *mut core::ffi::c_void);

    let mut pid: u32 = 0;
    unsafe {
        GetWindowThreadProcessId(handle, Some(&mut pid));
    }

    let mut class_buf = [0u16; 256];
    let class_len = unsafe { GetClassNameW(handle, &mut class_buf) };
    let class_name = if class_len > 0 {
        String::from_utf16_lossy(&class_buf[..class_len as usize])
    } else {
        String::new()
    };

    let mut title_buf = [0u16; 512];
    let title_len = unsafe { GetWindowTextW(handle, &mut title_buf) };
    let title = if title_len > 0 {
        String::from_utf16_lossy(&title_buf[..title_len as usize])
    } else {
        String::new()
    };

    let path = resolve_explorer_path(hwnd);
    let is_explorer = path.is_some();
    ForegroundContext {
        hwnd: hwnd as i32,
        pid,
        class_name,
        title,
        path,
        is_explorer,
    }
}

/// Resolve the folder path of an Explorer window. `None` when the window is not
/// an Explorer filesystem view (or the folder is virtual / unresolvable).
///
/// Uses the shell COM `IShellWindows` enumeration on a dedicated STA thread.
/// Each shell window is matched against the foreground HWND — it must be the
/// foreground window itself or a descendant (Windows 11's tabbed Explorer nests
/// the active tab's shell window inside the `CabinetWClass` tab host) and
/// visible (the active tab) — then its folder is resolved via `IFolderView` →
/// `IPersistFolder2` → `GetCurFolder`.
fn resolve_explorer_path(hwnd: isize) -> Option<String> {
    let result = std::thread::spawn(move || com_resolve_path(hwnd))
        .join()
        .ok()
        .flatten();
    if result.is_none() {
        eprintln!("[explorer] no folder path for hwnd {hwnd:#x}");
    }
    result
}

/// The COM `IShellWindows` query on a dedicated STA thread. COM is initialized
/// and uninitialized here so a fresh apartment is used every call.
fn com_resolve_path(fg_hwnd: isize) -> Option<String> {
    use windows::core::{Interface, GUID};
    use windows::Win32::Foundation::HWND;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_LOCAL_SERVER,
        COINIT_APARTMENTTHREADED, IServiceProvider,
    };
    use windows::Win32::System::Ole::IOleWindow;
    use windows::Win32::System::Variant::{VARIANT, VT_I4};
    use windows::Win32::UI::Shell::{
        IFolderView, IPersistFolder2, IShellBrowser, IShellWindows, SHGetPathFromIDListW,
        SID_STopLevelBrowser,
    };

    // `CLSID_ShellWindows` isn't exported by the windows crate; the well-known
    // GUID is {9BA05972-F6A8-11CF-A442-00A0C90A8F39}.
    const CLSID_SHELL_WINDOWS: GUID = GUID::from_u128(0x9BA05972_F6A8_11CF_A442_00A0C90A8F39);

    unsafe {
        if CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_err() {
            return None;
        }
        let fg = HWND(fg_hwnd as *mut core::ffi::c_void);
        let result = (|| {
            // The target shell window: the foreground window's ACTIVE tab (the
            // topmost `ShellTabWindowClass`), or the foreground window itself
            // for non-tabbed Explorer.
            let target = find_active_tab(fg).unwrap_or(fg);
            let shell: IShellWindows =
                CoCreateInstance(&CLSID_SHELL_WINDOWS, None, CLSCTX_LOCAL_SERVER).ok()?;
            let count = shell.Count().ok()?;
            for i in 0..count {
                // `Item` takes the index as a VT_I4 VARIANT.
                let mut idx = VARIANT::default();
                (*idx.Anonymous.Anonymous).vt = VT_I4;
                (*idx.Anonymous.Anonymous).Anonymous.lVal = i;
                let Ok(disp) = shell.Item(&idx) else {
                    continue;
                };
                let Ok(provider) = disp.cast::<IServiceProvider>() else {
                    continue;
                };
                let Ok(browser) = provider.QueryService::<IShellBrowser>(&SID_STopLevelBrowser)
                else {
                    continue;
                };
                let Ok(ole) = browser.cast::<IOleWindow>() else {
                    continue;
                };
                let Ok(shell_hwnd) = ole.GetWindow() else {
                    continue;
                };
                if shell_hwnd != target {
                    continue;
                }
                let Ok(view) = browser.QueryActiveShellView() else {
                    continue;
                };
                let Ok(folder) = view.cast::<IFolderView>() else {
                    continue;
                };
                let Ok(persist) = folder.GetFolder::<IPersistFolder2>() else {
                    continue;
                };
                let Ok(pidl) = persist.GetCurFolder() else {
                    continue;
                };
                let mut buf = [0u16; 260];
                let ok = SHGetPathFromIDListW(pidl, &mut buf).as_bool();
                CoTaskMemFree(Some(pidl as *const _ as *const core::ffi::c_void));
                if !ok {
                    continue;
                }
                let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
                let path = String::from_utf16_lossy(&buf[..len]);
                if !path.is_empty() {
                    return Some(path);
                }
            }
            None
        })();
        CoUninitialize();
        result
    }
}

/// Return the topmost `ShellTabWindowClass` child of `fg` — the active tab of a
/// Windows 11 tabbed Explorer window (inactive tabs are stacked behind it but
/// still report visible). `None` for a non-tabbed Explorer.
fn find_active_tab(fg: windows::Win32::Foundation::HWND) -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetTopWindow, GetWindow, GW_HWNDNEXT,
    };
    unsafe {
        let mut child = GetTopWindow(Some(fg)).ok();
        while let Some(h) = child {
            let mut buf = [0u16; 64];
            let n = GetClassNameW(h, &mut buf);
            if n > 0 && String::from_utf16_lossy(&buf[..n as usize]) == "ShellTabWindowClass" {
                return Some(h);
            }
            child = GetWindow(h, GW_HWNDNEXT).ok();
        }
        None
    }
}

/// Base64 data URIs for the terminal executables' own icons, shown in the
/// 「Windows 资源管理器」 bar tiles.
#[derive(serde::Serialize)]
pub struct TerminalIcons {
    pub cmd: Option<String>,
    pub powershell: Option<String>,
}

/// Extract the cmd.exe and powershell.exe icons (resolving their paths via
/// SystemRoot). The shell-COM extraction runs on the blocking pool, like
/// `icons::get_app_icons`.
#[tauri::command]
pub async fn get_terminal_icons() -> Result<TerminalIcons, String> {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let cmd = format!("{root}\\System32\\cmd.exe");
    let ps = format!("{root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    tauri::async_runtime::spawn_blocking(move || {
        let cmd_icon = crate::icons::extract_icon_png(&cmd).map(|p| crate::cache::encode_png_uri(&p));
        let ps_icon = crate::icons::extract_icon_png(&ps).map(|p| crate::cache::encode_png_uri(&p));
        TerminalIcons {
            cmd: cmd_icon,
            powershell: ps_icon,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

