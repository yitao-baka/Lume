//! Native boundary shared by every Lume WebView2 window.
//!
//! It suppresses WebView2/browser chrome that is not part of the product
//! (default context menus, browser accelerators, autofill, gesture navigation
//! and release-build DevTools), blocks Tao's Win32 system menu, and enforces the
//! navigation boundary for sandboxed plugin frames.
//!
//! CSP `navigate-to` is not enforced by current WebView2 builds. An iframe can
//! still navigate itself with `location.href`, an anchor click, a meta refresh
//! or `window.open`, turning a network-denied plugin into an outbound request.
//! This module rejects those navigations in the native WebView2 event path:
//! child frames may only remain on `about:blank` / `about:srcdoc` or load the
//! host-authored logic runtime document, and all new-window requests are
//! handled (i.e. suppressed).

use std::sync::OnceLock;
use tauri::WebviewWindow;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};

/// One subclass callback per HWND; the value itself is only an ownership tag.
const NATIVE_MENU_SUBCLASS_ID: usize = 0x4c55_4d45;

/// Native menus belong to the Win32/top-level window, not the page. Lume owns
/// all visible menus, so swallow the system entry paths before DefWindowProc can
/// open Tao's otherwise-unused `WS_SYSMENU` popup:
/// - Alt+Space / Alt alone (`WM_SYSCOMMAND` with `SC_KEYMENU`/`SC_MOUSEMENU`)
/// - Shift+F10 / Menu key (`WM_CONTEXTMENU`)
/// - non-client right-click (`WM_NCRBUTTONDOWN` / `WM_NCRBUTTONUP`)
///
/// The WebView2 context menu is disabled separately in `install`; this guard
/// cannot and must not block DOM `contextmenu` events handled by the page.
fn is_native_menu_message(msg: u32, wparam: WPARAM) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_SPACE;
    use windows::Win32::UI::WindowsAndMessaging::{
        SC_KEYMENU, SC_MOUSEMENU, WM_CONTEXTMENU, WM_NCRBUTTONDOWN, WM_NCRBUTTONUP,
        WM_SYSCHAR, WM_SYSCOMMAND, WM_SYSKEYDOWN, WM_SYSKEYUP,
    };

    if matches!(msg, WM_CONTEXTMENU | WM_NCRBUTTONDOWN | WM_NCRBUTTONUP) {
        return true;
    }
    if msg == WM_SYSCOMMAND {
        let command = (wparam.0 as u32) & 0xfff0;
        return command == SC_KEYMENU || command == SC_MOUSEMENU;
    }
    matches!(msg, WM_SYSKEYDOWN | WM_SYSKEYUP | WM_SYSCHAR)
        && wparam.0 == VK_SPACE.0 as usize
}

unsafe extern "system" fn native_menu_subclass_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    use windows::Win32::UI::Shell::DefSubclassProc;

    if is_native_menu_message(msg, wparam) {
        LRESULT(0)
    } else {
        unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
    }
}

/// Keep native system-menu affordances out of every Lume window. Tao always
/// gives frameless windows `WS_SYSMENU`, even when no caption is drawn, so a
/// style check alone is insufficient and also races its show/hide style refresh.
fn install_native_menu_guard(window: &WebviewWindow) {
    use windows::Win32::UI::Shell::SetWindowSubclass;

    let label = window.label().to_string();
    let Ok(hwnd) = window.hwnd() else {
        eprintln!("[webview-guard] {label}: native menu guard has no HWND");
        return;
    };
    if !unsafe {
        SetWindowSubclass(
            hwnd,
            Some(native_menu_subclass_proc),
            NATIVE_MENU_SUBCLASS_ID,
            0,
        )
    }
    .as_bool()
    {
        eprintln!("[webview-guard] {label}: native menu guard failed");
    }
}

/// Local sink for every WebView2 HTTP request. Navigation cancellation alone
/// cannot guarantee that a hostile frame has not already caused Chromium to
/// dispatch a request, so the shared WebView2 environment is pointed at this
/// deny-only proxy. Requests are accepted and dropped; they never reach the
/// destination. The app's real network path is Rust/WinHTTP and is unaffected.
fn deny_proxy_port() -> u16 {
    static PORT: OnceLock<u16> = OnceLock::new();
    *PORT.get_or_init(|| match std::net::TcpListener::bind(("127.0.0.1", 0)) {
        Ok(listener) => {
            let port = listener.local_addr().map(|addr| addr.port()).unwrap_or(1);
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    drop(stream);
                }
            });
            port
        }
        Err(error) => {
            eprintln!("[webview-guard] deny proxy bind failed: {error}");
            1
        }
    })
}

/// Append the deny proxy to WebView2's own environment flags without
/// replacing Wry/Tauri's required browser arguments. The CDP variable used by
/// the smoke-test launcher is preserved.
pub fn configure_browser_environment() {
    let port = deny_proxy_port();
    let mut args = format!(
        "--proxy-server=http://127.0.0.1:{port} --proxy-bypass-list=<-loopback>;tauri.localhost;*.tauri.localhost;asset.localhost;*.asset.localhost;ipc.localhost;*.ipc.localhost;localhost:1420;127.0.0.1:1420"
    );
    if let Ok(extra) = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") {
        if !extra.trim().is_empty() {
            args.push(' ');
            args.push_str(extra.trim());
        }
    }
    unsafe { std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args) };
}

fn take_pwstr(ptr: windows::core::PWSTR) -> String {
    if ptr.is_null() {
        return String::new();
    }
    let text = unsafe { ptr.to_string().unwrap_or_default() };
    unsafe {
        windows::Win32::System::Com::CoTaskMemFree(Some(ptr.as_ptr() as *const _));
    }
    text
}

fn app_origin(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    lower.starts_with("http://tauri.localhost/")
        || lower.starts_with("https://tauri.localhost/")
        || lower.starts_with("http://localhost:1420/")
        || lower.starts_with("http://127.0.0.1:1420/")
}

fn plugin_logic_bootstrap(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    (lower.starts_with("http://tauri.localhost/")
        || lower.starts_with("https://tauri.localhost/")
        || lower.starts_with("http://localhost:1420/")
        || lower.starts_with("http://127.0.0.1:1420/"))
        && lower
            .split_once('?')
            .map_or(lower.as_str(), |(path, _)| path)
            .ends_with("/pluginlogicframe.html")
}

fn frame_navigation_allowed(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    lower == "about:blank" || lower == "about:srcdoc" || plugin_logic_bootstrap(&lower)
}

fn top_navigation_allowed(uri: &str) -> bool {
    let lower = uri.to_ascii_lowercase();
    app_origin(&lower) || lower == "about:blank" || lower == "about:srcdoc"
}

/// Install the boundary on a host window. Failure to obtain the WebView2
/// controller is logged but does not abort startup: CSP remains the first line,
/// while this native guard is the authoritative second line on supported
/// runtimes.
pub fn install(window: &WebviewWindow) {
    install_native_menu_guard(window);
    let label = window.label().to_string();
    let _ = window.as_ref().with_webview(move |platform| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Frame2, ICoreWebView2Settings3, ICoreWebView2Settings4,
            ICoreWebView2Settings5, ICoreWebView2Settings6, ICoreWebView2_4,
        };
        use webview2_com::{
            FrameCreatedEventHandler, FrameNavigationStartingEventHandler,
            NavigationStartingEventHandler, NewWindowRequestedEventHandler,
        };
        use windows::core::{Interface, PWSTR};

        let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else {
            eprintln!("[webview-guard] {label}: CoreWebView2 unavailable");
            return;
        };

        // Native WebView2 chrome is not part of Lume's UI. Keep browser
        // accelerators from racing the page's key router, disable the default
        // context menu / autofill / gesture chrome, and hide DevTools in
        // release builds. CDP automation in debug builds is unaffected.
        if let Ok(settings) = unsafe { core.Settings() } {
            let _ = unsafe { settings.SetAreDefaultContextMenusEnabled(false) };
            let _ = unsafe { settings.SetIsZoomControlEnabled(false) };
            #[cfg(not(debug_assertions))]
            let _ = unsafe { settings.SetAreDevToolsEnabled(false) };
            if let Ok(settings3) = settings.cast::<ICoreWebView2Settings3>() {
                let _ = unsafe { settings3.SetAreBrowserAcceleratorKeysEnabled(false) };
            }
            if let Ok(settings4) = settings.cast::<ICoreWebView2Settings4>() {
                let _ = unsafe { settings4.SetIsGeneralAutofillEnabled(false) };
                let _ = unsafe { settings4.SetIsPasswordAutosaveEnabled(false) };
            }
            if let Ok(settings5) = settings.cast::<ICoreWebView2Settings5>() {
                let _ = unsafe { settings5.SetIsPinchZoomEnabled(false) };
            }
            if let Ok(settings6) = settings.cast::<ICoreWebView2Settings6>() {
                let _ = unsafe { settings6.SetIsSwipeNavigationEnabled(false) };
            }
        }
        let mut token = 0;
        let top = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            if unsafe { args.Uri(&mut uri) }.is_ok() {
                let uri = take_pwstr(uri);
                if !top_navigation_allowed(&uri) {
                    eprintln!("[webview-guard] blocked top-level navigation: {uri}");
                    let _ = unsafe { args.SetCancel(true) };
                }
            }
            Ok(())
        }));
        if unsafe { core.add_NavigationStarting(&top, &mut token) }.is_err() {
            eprintln!("[webview-guard] {label}: NavigationStarting hook failed");
        }

        let frame = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            if unsafe { args.Uri(&mut uri) }.is_ok() {
                let uri = take_pwstr(uri);
                if !frame_navigation_allowed(&uri) {
                    eprintln!("[webview-guard] blocked frame navigation: {uri}");
                    let _ = unsafe { args.SetCancel(true) };
                }
            }
            Ok(())
        }));
        if unsafe { core.add_FrameNavigationStarting(&frame, &mut token) }.is_err() {
            eprintln!("[webview-guard] {label}: FrameNavigationStarting hook failed");
        }

        // The aggregate event above is a fallback. Attach to each frame's own
        // Frame2.NavigationStarting event as soon as WebView2 creates it: that
        // fires early enough to stop the frame before its outbound request is
        // dispatched (the aggregate event can arrive after the first request).
        let frame_label = label.clone();
        let frame_created = FrameCreatedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let frame = unsafe { args.Frame() }?;
            let frame2 = frame.cast::<ICoreWebView2Frame2>()?;
            let starting = FrameNavigationStartingEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut uri = PWSTR::null();
                unsafe { args.Uri(&mut uri) }?;
                let uri = take_pwstr(uri);
                if !frame_navigation_allowed(&uri) {
                    eprintln!("[webview-guard] blocked frame-owned navigation: {uri}");
                    unsafe { args.SetCancel(true) }?;
                }
                Ok(())
            }));
            let mut frame_token = 0;
            if unsafe { frame2.add_NavigationStarting(&starting, &mut frame_token) }.is_err() {
                eprintln!("[webview-guard] {frame_label}: frame NavigationStarting hook failed");
            }
            Ok(())
        }));
        match core.cast::<ICoreWebView2_4>() {
            Ok(core4) => {
                if unsafe { core4.add_FrameCreated(&frame_created, &mut token) }.is_err() {
                    eprintln!("[webview-guard] {label}: FrameCreated hook failed");
                }
            }
            Err(error) => {
                eprintln!("[webview-guard] {label}: FrameCreated interface unavailable: {error}");
            }
        }

        let new_window = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
            if let Some(args) = args {
                let _ = unsafe { args.SetHandled(true) };
            }
            Ok(())
        }));
        if unsafe { core.add_NewWindowRequested(&new_window, &mut token) }.is_err() {
            eprintln!("[webview-guard] {label}: NewWindowRequested hook failed");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::UI::Input::KeyboardAndMouse::VK_SPACE;
    use windows::Win32::UI::WindowsAndMessaging::{
        SC_KEYMENU, SC_MAXIMIZE, WM_CONTEXTMENU, WM_NCRBUTTONUP, WM_SYSCOMMAND, WM_SYSKEYDOWN,
    };

    #[test]
    fn native_system_menu_messages_are_suppressed() {
        assert!(is_native_menu_message(WM_SYSCOMMAND, WPARAM(SC_KEYMENU as usize)));
        assert!(is_native_menu_message(WM_SYSKEYDOWN, WPARAM(VK_SPACE.0 as usize)));
        assert!(is_native_menu_message(WM_CONTEXTMENU, WPARAM(0)));
        assert!(is_native_menu_message(WM_NCRBUTTONUP, WPARAM(0)));
    }

    #[test]
    fn ordinary_window_messages_and_commands_pass_through() {
        assert!(!is_native_menu_message(
            WM_SYSCOMMAND,
            WPARAM(SC_MAXIMIZE as usize)
        ));
        assert!(!is_native_menu_message(WM_SYSKEYDOWN, WPARAM(0x41)));
    }
}
