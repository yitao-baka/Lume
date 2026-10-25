//! WebView2 navigation boundary for windows that host sandboxed plugin frames.
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
    let label = window.label().to_string();
    let _ = window.as_ref().with_webview(move |platform| {
        use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Frame2, ICoreWebView2_4};
        use webview2_com::{
            FrameCreatedEventHandler, FrameNavigationStartingEventHandler,
            NavigationStartingEventHandler, NewWindowRequestedEventHandler,
        };
        use windows::core::{Interface, PWSTR};

        let Ok(core) = (unsafe { platform.controller().CoreWebView2() }) else {
            eprintln!("[webview-guard] {label}: CoreWebView2 unavailable");
            return;
        };
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
