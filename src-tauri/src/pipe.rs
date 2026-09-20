//! Length-prefixed JSON request/reply over a named pipe (client side).
//!
//! Shared by the two pipe consumers — `\\.\pipe\LumeSVC` (file search,
//! `svc.rs`) and `\\.\pipe\LumeAgent` (elevated key injection, `agent.rs`).
//! The wire format is the one LumeSVC has always used: a `u32` little-endian
//! byte length followed by a UTF-8 JSON payload, one request per connection.
//!
//! Server side lives with each pipe's owner (`svc::pipe_server`,
//! `agent::serve`); this module only ever dials out.

use std::time::Duration;

/// One request/reply exchange with `pipe_name`, bounded by `timeout`.
///
/// A hung server must never stall a caller: the exchange runs on a short-lived
/// worker thread that is abandoned on timeout and dies with its next pipe op.
pub fn transact(pipe_name: &str, payload: &str, timeout: Duration) -> Result<String, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let owned_payload = payload.to_string();
    let owned_name = pipe_name.to_string();
    std::thread::Builder::new()
        .name("pipe-client".into())
        .spawn(move || {
            let _ = tx.send(transact_blocking(&owned_name, &owned_payload));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(timeout)
        .map_err(|_| "pipe timeout".to_string())?
}

/// The blocking half of [`transact`] — connect, write, read the framed reply.
fn transact_blocking(pipe_name: &str, payload: &str) -> Result<String, String> {
    use windows::Win32::Foundation::{CloseHandle, GetLastError, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{CreateFileW, WriteFile, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE, OPEN_EXISTING};
    let name = wide(pipe_name);
    let mut handle = None;
    for attempt in 0..3 {
        handle = unsafe {
            CreateFileW(
                windows::core::PCWSTR(name.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_MODE(0),
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            )
        }
        .ok();
        if handle.is_some() {
            break;
        }
        // The server holds its single instance until the previous client hangs
        // up, so a busy pipe is expected under contention — retry briefly.
        if unsafe { GetLastError() } != ERROR_PIPE_BUSY || attempt == 2 {
            return Err("connect pipe: busy/failed".into());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let handle = handle.ok_or("connect pipe failed")?;
    let result = (|| {
        let mut message = Vec::with_capacity(payload.len() + 4);
        message.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        message.extend_from_slice(payload.as_bytes());
        unsafe {
            WriteFile(handle, Some(&message), None, None).map_err(|e| format!("write pipe: {e}"))?;
        }
        // Length-prefixed reply; byte-mode reads accumulate the message.
        let mut head = [0u8; 4];
        read_exact(handle, &mut head)?;
        let len = u32::from_le_bytes(head) as usize;
        if len > 1024 * 1024 {
            return Err("pipe reply too large".into());
        }
        let mut body = vec![0u8; len];
        read_exact(handle, &mut body)?;
        String::from_utf8(body).map_err(|e| format!("pipe reply utf8: {e}"))
    })();
    let _ = unsafe { CloseHandle(handle) };
    result
}

fn read_exact(handle: windows::Win32::Foundation::HANDLE, buf: &mut [u8]) -> Result<(), String> {
    use windows::Win32::Storage::FileSystem::ReadFile;
    let mut done = 0usize;
    while done < buf.len() {
        let mut n: u32 = 0;
        let ok = unsafe { ReadFile(handle, Some(&mut buf[done..]), Some(&mut n), None) };
        if ok.is_err() || n == 0 {
            return Err("short pipe read".into());
        }
        done += n as usize;
    }
    Ok(())
}

pub(crate) fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// URL-like pipe paths must be NUL-terminated UTF-16 for `CreateFileW`.
    #[test]
    fn wide_is_nul_terminated() {
        let w = wide(r"\\.\pipe\LumeAgent");
        assert_eq!(w.last(), Some(&0));
        assert_eq!(w.len(), r"\\.\pipe\LumeAgent".len() + 1);
    }

    /// A missing server is reported, never panicked on.
    #[test]
    fn transact_reports_a_missing_pipe() {
        let err = transact(r"\\.\pipe\LumeNoSuchPipe", r#"{"t":"hello"}"#, Duration::from_millis(200))
            .expect_err("no server should be listening");
        assert!(err.contains("connect pipe"), "{err}");
    }
}
