//! Everything (voidtools) IPC client — pure Rust over the documented
//! WM_COPYDATA protocol, no SDK DLL dependency.
//!
//! Everything 1.4 owns a taskbar-notification window (`EVERYTHING_TASKBAR_
//! NOTIFICATION`, present whenever the process runs, even with the tray icon
//! hidden). A query is a WM_COPYDATA carrying a packed
//! `EVERYTHING_IPC_QUERYW` (5 DWORDs + the NUL-terminated wide search string);
//! Everything answers with a WM_COPYDATA to our reply window carrying an
//! `EVERYTHING_IPC_LISTW` (7-DWORD header + 12-byte items whose filename/path
//! fields are byte offsets from the list start). Protocol constants mirror the
//! official SDK's `Everything_IPC.h` (SDK zip, `ipc/`).
//!
//! One dedicated worker thread owns a message-only reply window and
//! serializes every query (Everything cancels a pending query when a second
//! one arrives on the same window). A reply can land either reentrantly
//! inside the blocking `SendMessageTimeoutW` or shortly after it returns, so
//! the wait loop pumps sent messages until the slot fills or the deadline
//! passes.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::core::PCWSTR;

/// A single search hit from Everything (or the LumeSVC engine).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileHit {
    pub name: String,
    pub path: String,
    pub is_folder: bool,
}

// Window class of the Everything taskbar-notification window (always exists
// while Everything runs).
const WNDCLASS: &str = "EVERYTHING_TASKBAR_NOTIFICATION";
// Reply window class of this process (message-only, never shown).
const REPLY_CLASS: &str = "LumeEverythingIpcReply";
const WM_COPYDATA: u32 = 0x004A;
// WM_COPYDATA message id for a Unicode query (EVERYTHING_IPC_COPYDATAQUERYW).
const COPYDATA_QUERY_W: usize = 2;
// Fixed size of EVERYTHING_IPC_QUERYW before the search string (5 packed DWORDs).
const QUERY_HEADER: usize = 20;
// Fixed size of the EVERYTHING_IPC_LISTW header (7 packed DWORDs).
const LIST_HEADER: usize = 28;
const ITEM_SIZE: usize = 12;

#[derive(Debug)]
pub enum Error {
    /// No Everything window — treat the backend as absent.
    NotRunning,
    /// The query was accepted but no reply landed before the deadline.
    Timeout,
    /// Everything refused the query (SendMessage returned FALSE).
    SendFailed,
    /// The reply buffer did not decode as an `EVERYTHING_IPC_LISTW`.
    BadReply(&'static str),
}

impl Error {
    pub fn message(&self) -> String {
        match self {
            Error::NotRunning => "Everything is not running".into(),
            Error::Timeout => "Everything query timed out".into(),
            Error::SendFailed => "Everything rejected the query".into(),
            Error::BadReply(why) => format!("bad Everything reply: {why}"),
        }
    }
}

/// Reply slot filled by the window proc. The u32 key is the per-query
/// `reply_copydata_message` echoed by Everything, so a late reply from a
/// timed-out query is distinguishable from the live one.
type Reply = (u32, Result<Vec<FileHit>, Error>);

static REPLY_SLOT: Mutex<Option<Reply>> = Mutex::new(None);
static JOB_TX: OnceLock<Sender<Job>> = OnceLock::new();

struct Job {
    query: String,
    max_results: u32,
    timeout: Duration,
    out: Sender<Result<Vec<FileHit>, Error>>,
}

/// Whether the Everything IPC window exists (cheap probe, no query sent).
pub fn available() -> bool {
    find_everything_hwnd().is_some()
}

/// Run a query against Everything and collect up to `max_results` hits.
///
/// `timeout` bounds the round trip; Everything's own search is
/// millisecond-fast, so this only trips when the process is hung.
pub fn search(query: &str, max_results: u32, timeout: Duration) -> Result<Vec<FileHit>, Error> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let tx = JOB_TX.get_or_init(spawn_worker);
    let (out, rx) = channel();
    let job = Job {
        query: query.to_string(),
        max_results,
        timeout,
        out,
    };
    if tx.send(job).is_err() {
        return Err(Error::SendFailed); // worker thread died
    }
    rx.recv_timeout(timeout + Duration::from_millis(200))
        .unwrap_or(Err(Error::Timeout))
}

fn find_everything_hwnd() -> Option<windows::Win32::Foundation::HWND> {
    use windows::Win32::UI::WindowsAndMessaging::FindWindowW;
    let class: Vec<u16> = WNDCLASS.encode_utf16().chain(std::iter::once(0)).collect();
    let hwnd = unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR::null()) }.ok()?;
    (!hwnd.0.is_null()).then_some(hwnd)
}

/// The worker thread: owns the reply window, answers jobs one by one.
fn spawn_worker() -> Sender<Job> {
    let (tx, rx): (Sender<Job>, Receiver<Job>) = channel();
    let _ = std::thread::Builder::new()
        .name("everything-ipc".into())
        .spawn(move || worker_loop(rx));
    tx
}

fn worker_loop(rx: Receiver<Job>) {
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DispatchMessageW, GetMessageW, RegisterClassExW, TranslateMessage,
        HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WINDOW_STYLE, WNDCLASSEXW, WNDCLASS_STYLES,
    };
    unsafe {
        let hinst = GetModuleHandleW(PCWSTR::null()).unwrap_or_default();
        let class: Vec<u16> = REPLY_CLASS
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: WNDCLASS_STYLES(0),
            lpfnWndProc: Some(reply_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst.into(),
            hIcon: Default::default(),
            hCursor: Default::default(),
            hbrBackground: Default::default(),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: PCWSTR(class.as_ptr()),
            hIconSm: Default::default(),
        };
        if RegisterClassExW(&wc) == 0 {
            eprintln!("[everything] RegisterClassExW failed");
            return;
        }
        let hwnd = match CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class.as_ptr()),
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinst.into()),
            None,
        ) {
            Ok(h) if !h.0.is_null() => h,
            _ => {
                eprintln!("[everything] CreateWindowExW failed");
                return;
            }
        };

        while let Ok(job) = rx.recv() {
            let result = run_query(hwnd, &job);
            let _ = job.out.send(result);
        }
        // All senders dropped (process teardown) — park in the message pump.
        let mut msg = std::mem::zeroed::<MSG>();
        while GetMessageW(&mut msg, Some(hwnd), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

/// Send one query and wait for its reply, pumping sent messages so a reply
/// delivered outside the blocking send is not lost.
fn run_query(hwnd: windows::Win32::Foundation::HWND, job: &Job) -> Result<Vec<FileHit>, Error> {
    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW, SendMessageTimeoutW,
        MSG_WAIT_FOR_MULTIPLE_OBJECTS_EX_FLAGS, PM_QS_SENDMESSAGE, PM_REMOVE, QS_SENDMESSAGE,
        SEND_MESSAGE_TIMEOUT_FLAGS, SMTO_ABORTIFHUNG,
    };
    let everything = find_everything_hwnd().ok_or(Error::NotRunning)?;
    unsafe {
        let request_id = next_request_id();
        let payload = build_query(job, request_id, hwnd);
        let mut cds = COPYDATASTRUCT {
            dwData: COPYDATA_QUERY_W,
            cbData: payload.len() as u32,
            lpData: payload.as_ptr() as *mut core::ffi::c_void,
        };
        let mut send_result = 0usize;
        let sent = SendMessageTimeoutW(
            everything,
            WM_COPYDATA,
            windows::Win32::Foundation::WPARAM(hwnd.0 as usize),
            windows::Win32::Foundation::LPARAM(&mut cds as *mut _ as isize),
            SEND_MESSAGE_TIMEOUT_FLAGS(SMTO_ABORTIFHUNG.0),
            job.timeout.as_millis().min(u32::MAX as u128) as u32,
            Some(&mut send_result),
        );
        if sent.0 == 0 {
            return match GetLastError() {
                windows::Win32::Foundation::ERROR_TIMEOUT => Err(Error::Timeout),
                _ => Err(Error::SendFailed),
            };
        }

        // Wait for the reply. The common case: Everything answered
        // synchronously inside the send (reentrant dispatch) and the slot is
        // already filled. Otherwise pump sent messages until the deadline.
        // Order matters: pump → check slot → wait. Checking after the pump is
        // what keeps a reply processed by PeekMessage from being slept over.
        let deadline = Instant::now() + job.timeout;
        loop {
            let mut msg = std::mem::zeroed::<windows::Win32::UI::WindowsAndMessaging::MSG>();
            while PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE | PM_QS_SENDMESSAGE).as_bool() {
                // Sent messages are processed by the retrieval itself; this
                // just re-dispatches WM_COPYDATA copies into the slot.
                if msg.message == WM_COPYDATA {
                    DispatchMessageW(&msg);
                }
            }
            if let Some((id, reply)) = REPLY_SLOT.lock().unwrap().take() {
                if id == request_id {
                    return reply;
                }
                continue; // stale reply from a previously timed-out query
            }
            let now = Instant::now();
            if now >= deadline {
                return Err(Error::Timeout);
            }
            let left = (deadline - now).as_millis().min(u32::MAX as u128) as u32;
            let _ = MsgWaitForMultipleObjectsEx(
                None,
                left,
                QS_SENDMESSAGE,
                MSG_WAIT_FOR_MULTIPLE_OBJECTS_EX_FLAGS(0),
            );
        }
    }
}

fn next_request_id() -> u32 {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/// Build the packed EVERYTHING_IPC_QUERYW buffer: 5 DWORDs + the wide search
/// string with its NUL terminator.
fn build_query(job: &Job, request_id: u32, reply_hwnd: windows::Win32::Foundation::HWND) -> Vec<u8> {
    let mut buf = Vec::with_capacity(QUERY_HEADER + (job.query.chars().count() + 1) * 2);
    // reply_hwnd: only 32 bits are meaningful for window handles, even on x64.
    buf.extend_from_slice(&(reply_hwnd.0 as usize as u32).to_le_bytes());
    buf.extend_from_slice(&request_id.to_le_bytes()); // reply_copydata_message
    buf.extend_from_slice(&0u32.to_le_bytes()); // search_flags = default matching
    buf.extend_from_slice(&0u32.to_le_bytes()); // offset
    buf.extend_from_slice(&job.max_results.to_le_bytes());
    for unit in job.query.encode_utf16() {
        buf.extend_from_slice(&unit.to_le_bytes());
    }
    buf.extend_from_slice(&0u16.to_le_bytes());
    buf
}

unsafe extern "system" fn reply_wnd_proc(
    hwnd: windows::Win32::Foundation::HWND,
    msg: u32,
    wparam: windows::Win32::Foundation::WPARAM,
    lparam: windows::Win32::Foundation::LPARAM,
) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::DefWindowProcW;
    unsafe {
        if msg == WM_COPYDATA {
            // Copy the data out before returning — the sender's buffer is only
            // valid for the duration of the send.
            let cds = lparam.0 as *const COPYDATASTRUCT;
            let reply = if cds.is_null() || (*cds).lpData.is_null() {
                Err(Error::BadReply("null COPYDATASTRUCT"))
            } else {
                let bytes =
                    std::slice::from_raw_parts((*cds).lpData as *const u8, (*cds).cbData as usize);
                parse_list(bytes).map_err(Error::BadReply)
            };
            let id = if cds.is_null() { 0 } else { (*cds).dwData as u32 };
            *REPLY_SLOT.lock().unwrap() = Some((id, reply));
            return windows::Win32::Foundation::LRESULT(1); // processed
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

/// Decode an `EVERYTHING_IPC_LISTW` buffer (7-DWORD header, then 12-byte
/// items; filename/path are byte offsets from the list start). Everything's
/// `path` field is the *parent directory* — joined with the filename here so
/// `FileHit.path` is the full openable path (the same shape the LumeSVC
/// engine reports), which also keeps the frontend's path-dedup honest.
fn parse_list(buf: &[u8]) -> Result<Vec<FileHit>, &'static str> {
    if buf.len() < LIST_HEADER {
        return Err("truncated list header");
    }
    let rd32 = |off: usize| -> u32 {
        u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
    };
    let numitems = rd32(20) as usize; // numitems follows totfolders..numfiles
    let mut hits = Vec::with_capacity(numitems.min(1024));
    for i in 0..numitems {
        let base = LIST_HEADER + i * ITEM_SIZE;
        if base + ITEM_SIZE > buf.len() {
            return Err("truncated item");
        }
        let flags = rd32(base);
        let name_off = rd32(base + 4) as usize;
        let path_off = rd32(base + 8) as usize;
        let name = read_wide_at(buf, name_off).ok_or("bad filename offset")?;
        let dir = read_wide_at(buf, path_off).ok_or("bad path offset")?;
        if name.is_empty() {
            continue;
        }
        let full = if dir.ends_with('\\') {
            format!("{dir}{name}")
        } else {
            format!("{dir}\\{name}")
        };
        hits.push(FileHit {
            name,
            path: full,
            is_folder: flags & 0x1 != 0, // EVERYTHING_IPC_FOLDER
        });
    }
    Ok(hits)
}

/// Read a NUL-terminated UTF-16 string at a byte offset inside the list buffer.
fn read_wide_at(buf: &[u8], off: usize) -> Option<String> {
    if off >= buf.len() || off % 2 != 0 {
        return None;
    }
    let mut chars = Vec::with_capacity((buf.len() - off) / 2);
    for pair in buf[off..].chunks_exact(2) {
        let unit = u16::from_le_bytes([pair[0], pair[1]]);
        if unit == 0 {
            return String::from_utf16(&chars).ok();
        }
        chars.push(unit);
    }
    None // ran off the end without a terminator
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assemble a minimal LISTW buffer the way Everything lays it out: header,
    /// items, then the wide strings, with item offsets pointing back into the
    /// buffer.
    fn make_list(items: &[(u32, &str, &str)]) -> Vec<u8> {
        let mut buf = vec![0u8; LIST_HEADER + items.len() * ITEM_SIZE];
        let mut tail: Vec<u8> = Vec::new();
        for (i, (flags, name, path)) in items.iter().enumerate() {
            let base = LIST_HEADER + i * ITEM_SIZE;
            let name_off = LIST_HEADER + items.len() * ITEM_SIZE + tail.len();
            let name_w: Vec<u8> = name
                .encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(|u| u.to_le_bytes())
                .collect();
            let path_off = name_off + name_w.len();
            let path_w: Vec<u8> = path
                .encode_utf16()
                .chain(std::iter::once(0))
                .flat_map(|u| u.to_le_bytes())
                .collect();
            tail.extend_from_slice(&name_w);
            tail.extend_from_slice(&path_w);
            let put = |buf: &mut Vec<u8>, off: usize, v: u32| {
                buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
            };
            put(&mut buf, base, *flags);
            put(&mut buf, base + 4, name_off as u32);
            put(&mut buf, base + 8, path_off as u32);
        }
        buf.extend_from_slice(&tail);
        // numitems lives at offset 20 in the LISTW header.
        buf[20..24].copy_from_slice(&(items.len() as u32).to_le_bytes());
        buf
    }

    #[test]
    fn parse_list_two_items() {
        let buf = make_list(&[
            (0, "readme.txt", "C:\\Users\\me\\Documents"),
            (1, "Documents", "C:\\Users\\me"),
        ]);
        let hits = parse_list(&buf).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].name, "readme.txt");
        // Everything's path field is the parent dir — joined with the name.
        assert_eq!(hits[0].path, "C:\\Users\\me\\Documents\\readme.txt");
        assert!(!hits[0].is_folder);
        assert!(hits[1].is_folder);
        assert_eq!(hits[1].path, "C:\\Users\\me\\Documents");
    }

    #[test]
    fn parse_list_root_join() {
        // Drive-root items have a trailing backslash — no double separator.
        let buf = make_list(&[(0, "readme.txt", "C:\\")]);
        let hits = parse_list(&buf).unwrap();
        assert_eq!(hits[0].path, "C:\\readme.txt");
    }

    #[test]
    fn parse_list_utf16_name() {
        let buf = make_list(&[(0, "设置指南.pdf", "D:\\资料")]);
        let hits = parse_list(&buf).unwrap();
        assert_eq!(hits[0].name, "设置指南.pdf");
        assert_eq!(hits[0].path, "D:\\资料\\设置指南.pdf");
    }

    #[test]
    fn parse_list_rejects_short_buffer() {
        assert!(parse_list(&[0u8; 10]).is_err());
    }

    #[test]
    fn parse_list_skips_empty_names() {
        let buf = make_list(&[(0, "", "C:\\x")]);
        assert!(parse_list(&buf).unwrap().is_empty());
    }

    #[test]
    fn build_query_layout() {
        let job = Job {
            query: "abc".into(),
            max_results: 12,
            timeout: Duration::from_secs(1),
            out: channel().0,
        };
        let buf = build_query(&job, 7, windows::Win32::Foundation::HWND(0x1234usize as *mut _));
        assert_eq!(&buf[0..4], &0x1234u32.to_le_bytes()); // reply_hwnd
        assert_eq!(&buf[4..8], &7u32.to_le_bytes()); // reply_copydata_message
        assert_eq!(&buf[8..12], &0u32.to_le_bytes()); // search_flags
        assert_eq!(&buf[12..16], &0u32.to_le_bytes()); // offset
        assert_eq!(&buf[16..20], &12u32.to_le_bytes()); // max_results
        assert_eq!(
            &buf[20..],
            "abc\0"
                .encode_utf16()
                .flat_map(|u| u.to_le_bytes())
                .collect::<Vec<u8>>()
        );
    }

    /// Live round trip against a running Everything — exercises FindWindow,
    /// the reply window, the WM_COPYDATA exchange and the list parser.
    #[test]
    #[ignore] // requires Everything installed and running
    fn live_query() {
        for i in 0..4 {
            let start = std::time::Instant::now();
            let hits = search("readme", 5, Duration::from_secs(3)).expect("everything query");
            eprintln!("query {} → {} hits in {:?}", i, hits.len(), start.elapsed());
            assert!(!hits.is_empty());
            assert!(hits.iter().all(|h| !h.path.is_empty()));
            std::thread::sleep(Duration::from_millis(300));
        }
    }
}
