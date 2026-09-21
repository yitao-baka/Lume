//! Length-prefixed JSON request/reply over a named pipe (client side).
//!
//! Shared by the two pipe consumers — `\\.\pipe\LumeSVC` (file search,
//! `svc.rs`) and `\\.\pipe\LumeAgent` (elevated key injection, `agent.rs`).
//! The wire format is the one LumeSVC has always used: a `u32` little-endian
//! byte length followed by a UTF-8 JSON payload, one request per connection.
//!
//! Server side lives with each pipe's owner (`svc::pipe_server`,
//! `agent::serve`); this module only ever dials out.

use std::time::{Duration, Instant};

/// How long the connect phase may wait for a free pipe instance (busy waits,
/// instance recycle windows). Must stay well under the tightest caller
/// timeout — the agent's 500 ms ping — so the reply phase keeps room.
const CONNECT_BUDGET: Duration = Duration::from_millis(250);
/// How long a missing pipe may keep being retried. A single-instance server
/// between recycling one instance and listening on the next re-opens within
/// milliseconds; a pipe that is *really* absent must fail fast (the old
/// behavior, and what "is the service installed" probing relies on).
const NOT_FOUND_BUDGET: Duration = Duration::from_millis(80);

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
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::WriteFile;
    let name = wide(pipe_name);
    let handle = connect(pipe_name, &name)?;
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

/// Open a client handle to `pipe_name`, waiting out transient unavailability
/// within [`CONNECT_BUDGET`]. Two conditions are expected on a live server:
/// `ERROR_PIPE_BUSY` (every instance is currently connected to another
/// client — the canonical `WaitNamedPipeW` case) and `ERROR_FILE_NOT_FOUND`
/// (a single-instance server is between recycling one instance and listening
/// on the next). Both clear within milliseconds, so wait and retry; anything
/// else (no server at all, access denied) fails immediately.
fn connect(pipe_name: &str, name: &[u16]) -> Result<windows::Win32::Foundation::HANDLE, String> {
    use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, GENERIC_READ, GENERIC_WRITE};
    use windows::Win32::Storage::FileSystem::{CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_SHARE_MODE, OPEN_EXISTING};
    use windows::Win32::System::Pipes::WaitNamedPipeW;

    let deadline = Instant::now() + CONNECT_BUDGET;
    let not_found_deadline = Instant::now() + NOT_FOUND_BUDGET;
    loop {
        match unsafe {
            CreateFileW(
                windows::core::PCWSTR(name.as_ptr()),
                GENERIC_READ.0 | GENERIC_WRITE.0,
                FILE_SHARE_MODE(0),
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(0),
                None,
            )
        } {
            Ok(handle) => return Ok(handle),
            Err(e) if e.code() == ERROR_PIPE_BUSY.to_hresult() => {
                // Ask the server to wake us when an instance frees up (bounded
                // by the remaining budget), then race for it again — another
                // client may take the freed instance first.
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("connect pipe: busy".into());
                }
                let _ = unsafe {
                    WaitNamedPipeW(
                        windows::core::PCWSTR(name.as_ptr()),
                        remaining.as_millis().min(u32::MAX as u128) as u32,
                    )
                };
            }
            Err(e) if e.code() == ERROR_FILE_NOT_FOUND.to_hresult() => {
                if Instant::now() >= not_found_deadline {
                    return Err(format!("connect pipe: {pipe_name} not found"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("connect pipe failed: {e}")),
        }
    }
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

/// A pipe handle on its way to a connection thread. Windows handles are
/// process-wide objects, so `Send` is sound here (the `windows` crate cannot
/// know that and types `HANDLE` as a raw pointer). Shared by the two servers
/// (`svc::pipe_server`, `agent::serve`), which hand accepted connections to
/// per-connection worker threads.
pub(crate) struct SendHandle(pub windows::Win32::Foundation::HANDLE);
unsafe impl Send for SendHandle {}

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
