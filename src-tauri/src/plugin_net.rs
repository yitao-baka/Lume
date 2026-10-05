//! Plugin host capability: HTTP requests (P1.1 of docs/PLUGIN_GAP_ANALYSIS.md).
//!
//! Plugin pages run in the launcher webview, where `fetch` is subject to CORS —
//! which kills the single largest class of launcher plugins (translators,
//! lookups). This module gives plugins a host-side request path instead of
//! widening the webview: WinHTTP (Schannel TLS, automatic system proxy, no new
//! crate) driven from a blocking worker thread.
//!
//! Capability surface: one request at a time, http/https only, 10s default
//! timeout (≤60s), response truncated at 4 MiB with an explicit flag. The
//! reply carries the body base64-encoded; `ctx.http.request` in the frontend
//! decodes it and offers `text()` / `json()` conveniences.
//!
//! Permission: `network` (declared in the manifest; enforcement layer is P3.2
//! — until then this is the documented ledger entry).

use base64::Engine;
use std::ffi::c_void;
use tauri::async_runtime::spawn_blocking;
use windows::core::{PCWSTR, HSTRING};
use windows::Win32::Networking::WinHttp::{
    WinHttpCloseHandle, WinHttpConnect, WinHttpOpen, WinHttpOpenRequest, WinHttpQueryHeaders,
    WinHttpReadData, WinHttpReceiveResponse, WinHttpSendRequest, WinHttpSetOption,
    WinHttpSetTimeouts, WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_DECOMPRESSION_FLAG_DEFLATE,
    WINHTTP_DECOMPRESSION_FLAG_GZIP, WINHTTP_FLAG_SECURE, WINHTTP_OPTION_DECOMPRESSION,
    WINHTTP_OPTION_REDIRECT_POLICY, WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS,
    WINHTTP_QUERY_FLAG_NUMBER, WINHTTP_QUERY_RAW_HEADERS_CRLF, WINHTTP_QUERY_STATUS_CODE,
};

/// Response body cap. Over it the reply is truncated and `truncated` is true.
const MAX_BODY: usize = 4 * 1024 * 1024;
/// Default / maximum request timeout (ms).
const DEFAULT_TIMEOUT_MS: u64 = 10_000;
const MAX_TIMEOUT_MS: u64 = 60_000;

/// One request as the frontend sends it.
#[derive(Debug, serde::Deserialize)]
pub struct HttpRequest {
    pub url: String,
    pub method: Option<String>,
    /// Request headers (a `k: v` list; the host adds none of its own except
    /// `Accept-Encoding` handling, which WinHTTP's decompression covers).
    pub headers: Option<std::collections::HashMap<String, String>>,
    /// Plain-text body (UTF-8).
    pub body: Option<String>,
    /// Base64 body (binary; wins over `body` when both are set).
    pub body_base64: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// The reply: status, a lowercased header map, the base64 body and whether the
/// cap cut it short.
#[derive(Debug, serde::Serialize)]
pub struct HttpResponse {
    pub status: u16,
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    pub truncated: bool,
}

/// Owns a WinHTTP handle; closes it on drop so every early return is safe.
struct Handle(*mut c_void);
impl Drop for Handle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe { let _ = WinHttpCloseHandle(self.0); }
        }
    }
}

/// Parse the raw response header block ("HTTP/1.1 200 OK\r\nK: V\r\n\r\n") into
/// a lowercased map. Multi-valued headers keep their first occurrence.
fn parse_headers(raw: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    // Skip the status line.
    for line in raw.split("\r\n").skip(1) {
        let Some((k, v)) = line.split_once(':') else { continue };
        let key = k.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        out.entry(key).or_insert_with(|| v.trim().to_string());
    }
    out
}

/// The blocking WinHTTP exchange. Split out so tests can drive it directly.
fn fetch_blocking(req: HttpRequest) -> Result<HttpResponse, String> {
    let url = tauri::Url::parse(&req.url).map_err(|e| format!("bad url: {e}"))?;
    let scheme = url.scheme().to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(format!("unsupported scheme: {scheme}"));
    }
    let host = url.host_str().ok_or("url has no host")?.to_string();
    let port = url.port_or_known_default().unwrap_or(if scheme == "https" { 443 } else { 80 });
    let mut path = url.path().to_string();
    if path.is_empty() {
        path.push('/');
    }
    if let Some(q) = url.query() {
        path.push('?');
        path.push_str(q);
    }
    let method = req.method.unwrap_or_else(|| "GET".into()).to_uppercase();
    if method.is_empty() || !method.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(format!("bad method: {method}"));
    }
    let timeout = req
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS) as i32;

    let agent = HSTRING::from("Lume/2.0 (plugin host)");
    let session = unsafe {
        WinHttpOpen(
            PCWSTR(agent.as_ptr()),
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            PCWSTR::null(),
            PCWSTR::null(),
            0,
        )
    };
    if session.is_null() {
        return Err("WinHttpOpen failed".into());
    }
    let session = Handle(session);

    // Whole-operation budget, split across the WinHTTP phases.
    unsafe {
        let _ = WinHttpSetTimeouts(session.0, timeout, timeout, timeout, timeout);
    }

    let host_w = HSTRING::from(host.as_str());
    let connect = unsafe { WinHttpConnect(session.0, PCWSTR(host_w.as_ptr()), port as u16, 0) };
    if connect.is_null() {
        return Err("WinHttpConnect failed".into());
    }
    let connect = Handle(connect);

    let method_w = HSTRING::from(method.as_str());
    let path_w = HSTRING::from(path.as_str());
    let flags = if scheme == "https" { WINHTTP_FLAG_SECURE } else { Default::default() };
    let request = unsafe {
        WinHttpOpenRequest(
            connect.0,
            PCWSTR(method_w.as_ptr()),
            PCWSTR(path_w.as_ptr()),
            PCWSTR::null(),
            PCWSTR::null(),
            std::ptr::null(),
            flags,
        )
    };
    if request.is_null() {
        return Err("WinHttpOpenRequest failed".into());
    }
    let request = Handle(request);

    // Deterministic behaviour: follow redirects, and let WinHTTP decompress
    // gzip/deflate so plugins never see compressed bytes as "the body".
    unsafe {
        let policy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS.to_le_bytes();
        let _ = WinHttpSetOption(
            Some(request.0 as *const c_void),
            WINHTTP_OPTION_REDIRECT_POLICY,
            Some(&policy),
        );
        let decomp = (WINHTTP_DECOMPRESSION_FLAG_GZIP | WINHTTP_DECOMPRESSION_FLAG_DEFLATE)
            .to_le_bytes();
        let _ = WinHttpSetOption(
            Some(request.0 as *const c_void),
            WINHTTP_OPTION_DECOMPRESSION,
            Some(&decomp),
        );
    }

    // Headers: one "K: V\r\n" block, UTF-16 without a terminator (the wrapper
    // passes the length explicitly).
    let header_block = req
        .headers
        .unwrap_or_default()
        .iter()
        .map(|(k, v)| format!("{k}: {v}\r\n"))
        .collect::<String>();
    let header_wide: Option<Vec<u16>> = (!header_block.is_empty())
        .then(|| header_block.encode_utf16().collect());

    let body_bytes: Vec<u8> = match (req.body_base64.as_deref(), req.body.as_deref()) {
        (Some(b64), _) => base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("bad body_base64: {e}"))?,
        (None, Some(text)) => text.as_bytes().to_vec(),
        (None, None) => Vec::new(),
    };

    unsafe {
        WinHttpSendRequest(
            request.0,
            header_wide.as_deref(),
            (!body_bytes.is_empty()).then_some(body_bytes.as_ptr() as *const c_void),
            body_bytes.len() as u32,
            body_bytes.len() as u32,
            0,
        )
    }
    .map_err(|e| format!("WinHttpSendRequest: {e}"))?;

    unsafe { WinHttpReceiveResponse(request.0, std::ptr::null_mut()) }
        .map_err(|e| format!("WinHttpReceiveResponse: {e}"))?;

    // Status code.
    let mut status: u32 = 0;
    let mut len = std::mem::size_of::<u32>() as u32;
    unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            PCWSTR::null(),
            Some(&mut status as *mut u32 as *mut c_void),
            &mut len,
            std::ptr::null_mut(),
        )
    }
    .map_err(|e| format!("query status: {e}"))?;

    // Raw headers (CRLF block) → map. A missing header block is not fatal.
    let mut headers = std::collections::HashMap::new();
    let mut raw: Vec<u16> = vec![0; 8192];
    let mut raw_len = (raw.len() * 2) as u32;
    if unsafe {
        WinHttpQueryHeaders(
            request.0,
            WINHTTP_QUERY_RAW_HEADERS_CRLF,
            PCWSTR::null(),
            Some(raw.as_mut_ptr() as *mut c_void),
            &mut raw_len,
            std::ptr::null_mut(),
        )
    }
    .is_ok()
    {
        let units = (raw_len as usize / 2).saturating_sub(1);
        if let Ok(text) = String::from_utf16(&raw[..units.min(raw.len())]) {
            headers = parse_headers(&text);
        }
    }

    // Body: read until the peer stops or the cap is hit.
    let mut body: Vec<u8> = Vec::new();
    let mut truncated = false;
    loop {
        let mut chunk = [0u8; 16 * 1024];
        let mut read: u32 = 0;
        unsafe {
            WinHttpReadData(
                request.0,
                chunk.as_mut_ptr() as *mut c_void,
                chunk.len() as u32,
                &mut read,
            )
        }
        .map_err(|e| format!("WinHttpReadData: {e}"))?;
        if read == 0 {
            break;
        }
        let take = (read as usize).min(MAX_BODY - body.len());
        body.extend_from_slice(&chunk[..take]);
        if take < read as usize || body.len() >= MAX_BODY {
            truncated = true;
            break;
        }
    }

    Ok(HttpResponse {
        status: status as u16,
        headers,
        body: base64::engine::general_purpose::STANDARD.encode(&body),
        truncated,
    })
}

/// One HTTP request from a plugin. Blocks on a worker thread — the webview
/// never waits on the main thread. `url` must be absolute http/https.
/// Permission: `network` — enforced Rust-side (plugin_perm.rs).
#[tauri::command]
pub async fn plugin_http_fetch(
    req: HttpRequest,
    plugin_id: Option<String>,
    host_token: Option<String>,
    window: tauri::WebviewWindow,
    perms: tauri::State<'_, crate::plugin_perm::PluginPermState>,
    settings: tauri::State<'_, crate::settings::SettingsState>,
) -> Result<HttpResponse, String> {
    crate::plugin_perm::assert_native_or_capability(
        &perms,
        &settings,
        &window,
        plugin_id.as_deref(),
        host_token.as_deref(),
        "network",
    )?;
    let url = req.url.clone();
    let started = std::time::Instant::now();
    let out = spawn_blocking(move || fetch_blocking(req))
        .await
        .map_err(|e| format!("http worker panicked: {e}"))?;
    match &out {
        Ok(r) => eprintln!(
            "[plugins] http {} → {} ({} bytes, {}ms){}",
            url,
            r.status,
            r.body.len() / 4 * 3,
            started.elapsed().as_millis(),
            if r.truncated { ", truncated" } else { "" }
        ),
        Err(err) => eprintln!("[plugins] http {url} failed: {err}"),
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serve exactly one HTTP/1.1 response on an ephemeral local port; returns
    /// (base url, join handle + captured request).
    fn one_shot_server(
        status_line: &'static str,
        extra_headers: &'static str,
        body: &'static str,
    ) -> (String, std::thread::JoinHandle<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut raw: Vec<u8> = Vec::new();
            let mut buf = [0u8; 4096];
            // Headers first, then exactly Content-Length body bytes (WinHTTP may
            // send them in separate packets).
            let body_len = loop {
                let n = sock.read(&mut buf).unwrap();
                if n == 0 {
                    break 0;
                }
                raw.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&raw).to_string();
                if let Some(idx) = text.find("\r\n\r\n") {
                    let len = text
                        .lines()
                        .find_map(|l| {
                            let (k, v) = l.split_once(':')?;
                            k.eq_ignore_ascii_case("content-length")
                                .then(|| v.trim().parse::<usize>().ok())?
                        })
                        .unwrap_or(0);
                    let have = raw.len() - (idx + 4);
                    if have >= len {
                        break len;
                    }
                }
            };
            let _ = body_len;
            let request = String::from_utf8_lossy(&raw).to_string();
            let response = format!(
                "{status_line}\r\n{extra_headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(response.as_bytes());
            let _ = sock.flush();
            request
        });
        (format!("http://127.0.0.1:{port}"), handle)
    }

    #[test]
    fn http_get_returns_status_headers_and_body() {
        let (base, server) = one_shot_server(
            "HTTP/1.1 200 OK",
            "Content-Type: text/plain\r\nX-Demo: yes\r\n",
            "hello from the test server",
        );
        let out = fetch_blocking(HttpRequest {
            url: format!("{base}/echo?q=1"),
            method: None,
            headers: None,
            body: None,
            body_base64: None,
            timeout_ms: Some(5000),
        })
        .expect("fetch should succeed");
        assert_eq!(out.status, 200);
        assert_eq!(out.headers.get("content-type").map(String::as_str), Some("text/plain"));
        assert_eq!(out.headers.get("x-demo").map(String::as_str), Some("yes"));
        let body = base64::engine::general_purpose::STANDARD.decode(&out.body).unwrap();
        assert_eq!(String::from_utf8_lossy(&body), "hello from the test server");
        assert!(!out.truncated);
        // The request line should carry the path + query, and a User-Agent
        // header (WinHTTP always sends one).
        let request = server.join().unwrap();
        assert!(request.starts_with("GET /echo?q=1 HTTP/1.1"), "request: {request}");
        assert!(request.to_ascii_lowercase().contains("user-agent:"));
    }

    #[test]
    fn http_post_sends_body_and_headers() {
        let (base, server) = one_shot_server("HTTP/1.1 201 Created", "", "ok");
        let mut headers = std::collections::HashMap::new();
        headers.insert("Content-Type".to_string(), "application/json".to_string());
        let out = fetch_blocking(HttpRequest {
            url: format!("{base}/submit"),
            method: Some("post".into()),
            headers: Some(headers),
            body: Some("{\"a\":1}".into()),
            body_base64: None,
            timeout_ms: Some(5000),
        })
        .unwrap();
        assert_eq!(out.status, 201);
        let request = server.join().unwrap();
        assert!(request.starts_with("POST /submit HTTP/1.1"), "request: {request}");
        assert!(request.to_ascii_lowercase().contains("content-type: application/json"));
        assert!(request.ends_with("{\"a\":1}"), "request: {request}");
    }

    #[test]
    fn rejects_non_http_schemes_and_bad_urls() {
        let err = fetch_blocking(HttpRequest {
            url: "file:///C:/Windows/win.ini".into(),
            method: None,
            headers: None,
            body: None,
            body_base64: None,
            timeout_ms: None,
        })
        .unwrap_err();
        assert!(err.contains("unsupported scheme"), "{err}");
        assert!(fetch_blocking(HttpRequest {
            url: "not a url".into(),
            method: None,
            headers: None,
            body: None,
            body_base64: None,
            timeout_ms: None,
        })
        .is_err());
    }

    #[test]
    fn truncates_over_the_cap() {
        // 5 MiB body with a 4 MiB cap: the reply must be flagged, not partial-silent.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let chunk = vec![b'x'; 64 * 1024];
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n");
            for _ in 0..(5 * 1024 * 1024 / chunk.len()) {
                if sock.write_all(&chunk).is_err() {
                    return; // peer stopped reading at the cap
                }
            }
        });
        let out = fetch_blocking(HttpRequest {
            url: format!("http://127.0.0.1:{port}/big"),
            method: None,
            headers: None,
            body: None,
            body_base64: None,
            timeout_ms: Some(10_000),
        })
        .unwrap();
        assert!(out.truncated, "5MiB body must be flagged truncated");
        let decoded = base64::engine::general_purpose::STANDARD.decode(&out.body).unwrap();
        assert_eq!(decoded.len(), MAX_BODY);
    }
}
