//! Everything (voidtools) IPC client — pure Rust over the documented
//! WM_COPYDATA protocol, no SDK DLL dependency.
//!
//! Everything 1.4 owns a taskbar-notification window (`EVERYTHING_TASKBAR_
//! NOTIFICATION`, present whenever the process runs, even with the tray icon
//! hidden). A query is a WM_COPYDATA carrying a packed query struct — the
//! legacy `EVERYTHING_IPC_QUERYW` (5 DWORDs) or the 1.4.1
//! `EVERYTHING_IPC_QUERY2` (7 DWORDs, adds offset/sort/request_flags) — plus
//! the NUL-terminated wide search string; Everything answers with a
//! WM_COPYDATA to our reply window carrying an `EVERYTHING_IPC_LISTW`
//! (7-DWORD header + 12-byte items) or an `EVERYTHING_IPC_LIST2` (5-DWORD
//! header + 8-byte items + a variable data area), whose string fields are
//! byte offsets from the list start. Protocol constants mirror the official
//! SDK's `everything_ipc.h` (SDK zip, `ipc/` — copied to `everything_ipc.h`
//! beside this file).
//!
//! Queries prefer QUERY2 (it carries total/size/mtime/sort); Everything 1.3
//! and IPC-less builds refuse it (`SendFailed`) or send an unparsable reply,
//! in which case the same query is retried once over the legacy QUERYW path
//! without metadata — a capability gap, not a fault.
//!
//! One dedicated worker thread owns a message-only reply window and
//! serializes every query (Everything cancels a pending query when a second
//! one arrives on the same window). A reply can land either reentrantly
//! inside the blocking `SendMessageTimeoutW` or shortly after it returns, so
//! the wait loop pumps sent messages until the slot fills or the deadline
//! passes. The pending-format flag tells the window proc which list layout to
//! parse; a stale reply from a timed-out query carries an outdated request id
//! and is skipped by the slot consumer.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::core::PCWSTR;

/// A single search hit from Everything (or the LumeSVC engine). Metadata is
/// `None` when the source can't provide it (legacy Everything replies, the
/// USN name-only index).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FileHit {
    pub name: String,
    pub path: String,
    pub is_folder: bool,
    /// Last-modified time, Unix epoch ms.
    #[serde(default)]
    pub mtime: Option<u64>,
    /// Size in bytes.
    #[serde(default)]
    pub size: Option<u64>,
}

/// The outcome of one Everything query: the hits plus, when the QUERY2 path
/// answered, the engine-reported total hit count and the effective sort.
#[derive(Debug, Default)]
pub struct QueryOutcome {
    pub hits: Vec<FileHit>,
    pub total: Option<u64>,
    pub sort: Option<String>,
}

// Window class of the Everything taskbar-notification window (always exists
// while Everything runs).
const WNDCLASS: &str = "EVERYTHING_TASKBAR_NOTIFICATION";
// Reply window class of this process (message-only, never shown).
const REPLY_CLASS: &str = "LumeEverythingIpcReply";
const WM_COPYDATA: u32 = 0x004A;
// WM_COPYDATA message id for a Unicode query (EVERYTHING_IPC_COPYDATAQUERYW).
const COPYDATA_QUERY_W: usize = 2;
// WM_COPYDATA message id for the 1.4.1 QUERY2 query (EVERYTHING_IPC_COPYDATA_QUERY2W).
const COPYDATA_QUERY2_W: usize = 18;
// Fixed size of EVERYTHING_IPC_QUERYW before the search string (5 packed DWORDs).
const QUERY_HEADER: usize = 20;
// Fixed size of EVERYTHING_IPC_QUERY2 before the search string (7 packed DWORDs).
const QUERY2_HEADER: usize = 28;
// Fixed size of the EVERYTHING_IPC_LISTW header (7 packed DWORDs).
const LIST_HEADER: usize = 28;
const ITEM_SIZE: usize = 12;
// Fixed size of the EVERYTHING_IPC_LIST2 header (5 packed DWORDs) and its items
// (EVERYTHING_IPC_ITEM2: flags + data offset).
const LIST2_HEADER: usize = 20;
const ITEM2_SIZE: usize = 8;
// QUERY2 request_flags: name | path | size | date modified. The folder bit
// always comes back in the item flags without being requested.
const REQUEST2_FLAGS: u32 = 0x01 | 0x02 | 0x10 | 0x40;

/// `file_search` sort names → `EVERYTHING_IPC_SORT_*` codes, exactly as
/// defined in the official `everything_ipc.h` (descending = ascending + 1).
fn sort_code(name: &str) -> Option<u32> {
    match name {
        "name" => Some(1), // EVERYTHING_IPC_SORT_NAME_ASCENDING
        "name_desc" => Some(2),
        "path" => Some(3), // EVERYTHING_IPC_SORT_PATH_ASCENDING
        "path_desc" => Some(4),
        "size" => Some(5), // EVERYTHING_IPC_SORT_SIZE_ASCENDING
        "size_desc" => Some(6),
        "mtime" => Some(13), // EVERYTHING_IPC_SORT_DATE_MODIFIED_ASCENDING
        "mtime_desc" => Some(14),
        _ => None,
    }
}

/// Inverse of `sort_code` — names the engine's effective sort (`None` = the
/// engine default order, or a sort type we don't surface).
fn sort_name(code: u32) -> Option<&'static str> {
    match code {
        1 => Some("name"),
        2 => Some("name_desc"),
        3 => Some("path"),
        4 => Some("path_desc"),
        5 => Some("size"),
        6 => Some("size_desc"),
        13 => Some("mtime"),
        14 => Some("mtime_desc"),
        _ => None,
    }
}

#[derive(Debug)]
pub enum Error {
    /// No Everything window — treat the backend as absent.
    NotRunning,
    /// The query was accepted but no reply landed before the deadline.
    Timeout,
    /// Everything refused the query (SendMessage returned FALSE).
    SendFailed,
    /// The reply buffer did not decode as the expected list struct.
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
type Reply = (u32, Result<QueryOutcome, Error>);

static REPLY_SLOT: Mutex<Option<Reply>> = Mutex::new(None);
/// Which list layout the reply window should parse for the query currently in
/// flight. The worker thread owns every query serially (and the reply window),
/// so the flag matches whenever a reply is dispatched; a late reply from a
/// timed-out query may hit the wrong parser, but its request id is stale and
/// the slot consumer discards it.
static PENDING_QUERY2: AtomicBool = AtomicBool::new(false);
static JOB_TX: OnceLock<Sender<Job>> = OnceLock::new();

struct Job {
    query: String,
    max_results: u32,
    offset: u32,
    sort: Option<u32>,
    timeout: Duration,
    out: Sender<Result<QueryOutcome, Error>>,
}

/// Whether the Everything IPC window exists (cheap probe, no query sent).
pub fn available() -> bool {
    find_everything_hwnd().is_some()
}

/// Run a query against Everything and collect up to `max_results` hits,
/// starting at `offset` and ordered by `sort` (a `file_search` sort name;
/// `None` = engine default order).
///
/// `timeout` bounds the round trip; Everything's own search is
/// millisecond-fast, so this only trips when the process is hung.
pub fn search(
    query: &str,
    max_results: u32,
    offset: u32,
    sort: Option<&str>,
    timeout: Duration,
) -> Result<QueryOutcome, Error> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(QueryOutcome::default());
    }
    let tx = JOB_TX.get_or_init(spawn_worker);
    let (out, rx) = channel();
    let job = Job {
        query: query.to_string(),
        max_results,
        offset,
        sort: sort.and_then(sort_code),
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

/// QUERY2 first (Everything 1.4.1+: carries total/size/mtime/sort); on a
/// refusal or an unparsable reply, retry the same query once over the legacy
/// QUERYW path (no metadata).
fn run_query(hwnd: windows::Win32::Foundation::HWND, job: &Job) -> Result<QueryOutcome, Error> {
    match send_and_wait(hwnd, job, true) {
        Err(Error::SendFailed) | Err(Error::BadReply(_)) => send_and_wait(hwnd, job, false),
        other => other,
    }
}

/// Send one query (QUERY2 or legacy QUERYW) and wait for its reply, pumping
/// sent messages so a reply delivered outside the blocking send is not lost.
fn send_and_wait(
    hwnd: windows::Win32::Foundation::HWND,
    job: &Job,
    query2: bool,
) -> Result<QueryOutcome, Error> {
    use windows::Win32::Foundation::GetLastError;
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::UI::WindowsAndMessaging::{
        DispatchMessageW, MsgWaitForMultipleObjectsEx, PeekMessageW, SendMessageTimeoutW,
        MSG_WAIT_FOR_MULTIPLE_OBJECTS_EX_FLAGS, PM_QS_SENDMESSAGE, PM_REMOVE, QS_SENDMESSAGE,
        SEND_MESSAGE_TIMEOUT_FLAGS, SMTO_ABORTIFHUNG,
    };
    let everything = find_everything_hwnd().ok_or(Error::NotRunning)?;
    PENDING_QUERY2.store(query2, Ordering::Relaxed);
    let result = unsafe {
        let request_id = next_request_id();
        let payload = if query2 {
            build_query2(job, request_id, hwnd)
        } else {
            build_query(job, request_id, hwnd)
        };
        let mut cds = COPYDATASTRUCT {
            dwData: if query2 { COPYDATA_QUERY2_W } else { COPYDATA_QUERY_W },
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
            match GetLastError() {
                windows::Win32::Foundation::ERROR_TIMEOUT => Err(Error::Timeout),
                _ => Err(Error::SendFailed),
            }
        } else {
            // Wait for the reply. The common case: Everything answered
            // synchronously inside the send (reentrant dispatch) and the slot
            // is already filled. Otherwise pump sent messages until the
            // deadline. Order matters: pump → check slot → wait. Checking
            // after the pump is what keeps a reply processed by PeekMessage
            // from being slept over.
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
                        break reply;
                    }
                    continue; // stale reply from a previously timed-out query
                }
                let now = Instant::now();
                if now >= deadline {
                    break Err(Error::Timeout);
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
    };
    PENDING_QUERY2.store(false, Ordering::Relaxed);
    result
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
    buf.extend_from_slice(&job.offset.to_le_bytes());
    buf.extend_from_slice(&job.max_results.to_le_bytes());
    push_search_string(&mut buf, &job.query);
    buf
}

/// Build the packed EVERYTHING_IPC_QUERY2 buffer (Everything 1.4.1+): 7 DWORDs
/// + the wide search string. `sort = None` keeps the engine's default order.
fn build_query2(
    job: &Job,
    request_id: u32,
    reply_hwnd: windows::Win32::Foundation::HWND,
) -> Vec<u8> {
    let mut buf = Vec::with_capacity(QUERY2_HEADER + (job.query.chars().count() + 1) * 2);
    // reply_hwnd: only 32 bits are meaningful for window handles, even on x64.
    buf.extend_from_slice(&(reply_hwnd.0 as usize as u32).to_le_bytes());
    buf.extend_from_slice(&request_id.to_le_bytes()); // reply_copydata_message
    buf.extend_from_slice(&0u32.to_le_bytes()); // search_flags = default matching
    buf.extend_from_slice(&job.offset.to_le_bytes());
    buf.extend_from_slice(&job.max_results.to_le_bytes());
    buf.extend_from_slice(&REQUEST2_FLAGS.to_le_bytes()); // request_flags
    buf.extend_from_slice(&job.sort.unwrap_or(0).to_le_bytes()); // sort_type
    push_search_string(&mut buf, &job.query);
    buf
}

/// Append the NUL-terminated UTF-16 search string.
fn push_search_string(buf: &mut Vec<u8>, query: &str) {
    for unit in query.encode_utf16() {
        buf.extend_from_slice(&unit.to_le_bytes());
    }
    buf.extend_from_slice(&0u16.to_le_bytes());
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
            // valid for the duration of the send. The layout depends on which
            // query flavor is in flight.
            let cds = lparam.0 as *const COPYDATASTRUCT;
            let reply = if cds.is_null() || (*cds).lpData.is_null() {
                Err(Error::BadReply("null COPYDATASTRUCT"))
            } else {
                let bytes =
                    std::slice::from_raw_parts((*cds).lpData as *const u8, (*cds).cbData as usize);
                if PENDING_QUERY2.load(Ordering::Relaxed) {
                    parse_list2(bytes).map(|(total, sort, hits)| QueryOutcome {
                        hits,
                        total: Some(total),
                        sort: sort.map(str::to_string),
                    })
                } else {
                    parse_list(bytes).map(|hits| QueryOutcome {
                        hits,
                        total: None,
                        sort: None,
                    })
                }
                .map_err(Error::BadReply)
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
        let path = join_dir_name(&dir, &name);
        hits.push(FileHit {
            name,
            path,
            is_folder: flags & 0x1 != 0, // EVERYTHING_IPC_FOLDER
            mtime: None,
            size: None,
        });
    }
    Ok(hits)
}

/// Decode an `EVERYTHING_IPC_LIST2` buffer (5-DWORD header, 8-byte items, then
/// a variable data area addressed by each item's `data_offset`). Returns
/// `(total hits, effective sort type, hits)`. The data area holds one field
/// per set bit of the header's `request_flags`, in bit order: name text,
/// path text, size (LARGE_INTEGER), date modified (FILETIME).
fn parse_list2(buf: &[u8]) -> Result<(u64, Option<&'static str>, Vec<FileHit>), &'static str> {
    if buf.len() < LIST2_HEADER {
        return Err("truncated list2 header");
    }
    let rd32 = |off: usize| -> u32 {
        u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
    };
    let total = rd32(0) as u64; // totitems — the engine-reported total
    let numitems = rd32(4) as usize;
    let request_flags = rd32(12); // the fields actually present in the data area
    let sort_type = rd32(16);
    if request_flags & !REQUEST2_FLAGS != 0 {
        return Err("unexpected data fields"); // never requested — layout unknown
    }
    if request_flags & (0x01 | 0x02) != (0x01 | 0x02) {
        return Err("name/path missing"); // always requested
    }
    let mut hits = Vec::with_capacity(numitems.min(1024));
    for i in 0..numitems {
        let base = LIST2_HEADER + i * ITEM2_SIZE;
        if base + ITEM2_SIZE > buf.len() {
            return Err("truncated item");
        }
        let flags = rd32(base);
        let data_off = rd32(base + 4) as usize;
        let (name, p) = read_len_wide(buf, data_off)?;
        let (dir, mut p) = read_len_wide(buf, p)?;
        let (mut size, mut mtime) = (None, None);
        if request_flags & 0x10 != 0 {
            // EVERYTHING_IPC_QUERY2_REQUEST_SIZE — LARGE_INTEGER
            if p + 8 > buf.len() {
                return Err("truncated size");
            }
            size = Some(u64::from_le_bytes(buf[p..p + 8].try_into().unwrap()));
            p += 8;
        }
        if request_flags & 0x40 != 0 {
            // EVERYTHING_IPC_QUERY2_REQUEST_DATE_MODIFIED — FILETIME (always
            // the last field we request; nothing reads `p` after this)
            if p + 8 > buf.len() {
                return Err("truncated date");
            }
            mtime = filetime_ms(u64::from_le_bytes(buf[p..p + 8].try_into().unwrap()));
        }
        if name.is_empty() {
            continue;
        }
        let path = join_dir_name(&dir, &name);
        hits.push(FileHit {
            name,
            path,
            is_folder: flags & 0x1 != 0, // EVERYTHING_IPC_FOLDER
            mtime,
            size,
        });
    }
    Ok((total, sort_name(sort_type), hits))
}

/// Join Everything's parent-directory field with the filename into the full
/// openable path (drive-root dirs already end in a backslash).
fn join_dir_name(dir: &str, name: &str) -> String {
    if dir.ends_with('\\') {
        format!("{dir}{name}")
    } else {
        format!("{dir}\\{name}")
    }
}

/// Read a length-prefixed UTF-16 string (`DWORD` char count excluding the NUL,
/// then the text, then the NUL terminator) at `off`. Returns the string and
/// the offset just past the terminator.
fn read_len_wide(buf: &[u8], off: usize) -> Result<(String, usize), &'static str> {
    if off + 4 > buf.len() {
        return Err("truncated string length");
    }
    let len = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
    let chars_at = off + 4;
    if chars_at + len * 2 + 2 > buf.len() {
        return Err("truncated string");
    }
    let units: Vec<u16> = buf[chars_at..chars_at + len * 2]
        .chunks_exact(2)
        .map(|p| u16::from_le_bytes([p[0], p[1]]))
        .collect();
    Ok((String::from_utf16_lossy(&units), chars_at + len * 2 + 2))
}

/// FILETIME (100ns units since 1601) → Unix epoch milliseconds. Zero (never
/// set) or a pre-1970 timestamp → `None`.
fn filetime_ms(ft: u64) -> Option<u64> {
    if ft == 0 {
        return None;
    }
    let unix_ms = (ft / 10_000) as i64 - 11_644_473_600_000;
    u64::try_from(unix_ms).ok()
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

    /// Assemble a minimal LIST2 buffer: 5-DWORD header, 8-byte items, then the
    /// data area (length-prefixed name, length-prefixed path, size, FILETIME).
    fn make_list2(items: &[(u32, &str, &str, u64, u64)]) -> Vec<u8> {
        let mut buf = vec![0u8; LIST2_HEADER + items.len() * ITEM2_SIZE];
        let mut data: Vec<u8> = Vec::new();
        for (i, (flags, name, path, size, mtime)) in items.iter().enumerate() {
            let base = LIST2_HEADER + i * ITEM2_SIZE;
            let data_off = LIST2_HEADER + items.len() * ITEM2_SIZE + data.len();
            let put = |buf: &mut Vec<u8>, off: usize, v: u32| {
                buf[off..off + 4].copy_from_slice(&v.to_le_bytes());
            };
            put(&mut buf, base, *flags);
            put(&mut buf, base + 4, data_off as u32);
            let text = |s: &str, data: &mut Vec<u8>| {
                data.extend_from_slice(&(s.chars().count() as u32).to_le_bytes());
                data.extend(
                    s.encode_utf16()
                        .chain(std::iter::once(0))
                        .flat_map(|u| u.to_le_bytes()),
                );
            };
            text(name, &mut data);
            text(path, &mut data);
            data.extend_from_slice(&size.to_le_bytes());
            data.extend_from_slice(&mtime.to_le_bytes());
        }
        buf.extend_from_slice(&data);
        buf[0..4].copy_from_slice(&(items.len() as u32).to_le_bytes()); // totitems
        buf[4..8].copy_from_slice(&(items.len() as u32).to_le_bytes()); // numitems
        buf[12..16].copy_from_slice(&REQUEST2_FLAGS.to_le_bytes()); // request_flags
        buf[16..20].copy_from_slice(&6u32.to_le_bytes()); // sort_type (size_desc)
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
        assert!(hits[0].mtime.is_none() && hits[0].size.is_none());
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
    fn parse_list2_items_with_meta() {
        // 2020-01-01 UTC in FILETIME 100ns units.
        let ft: u64 = (1_577_836_800_000 + 11_644_473_600_000) * 10_000;
        let buf = make_list2(&[
            (0, "readme.txt", "C:\\Users\\me\\Documents", 4096, ft),
            (1, "Documents", "C:\\Users\\me", 0, 0), // zero mtime → null
        ]);
        let (total, sort, hits) = parse_list2(&buf).unwrap();
        assert_eq!(total, 2);
        assert_eq!(sort, Some("size_desc"));
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "C:\\Users\\me\\Documents\\readme.txt");
        assert_eq!(hits[0].size, Some(4096));
        assert_eq!(hits[0].mtime, Some(1_577_836_800_000));
        assert!(hits[1].is_folder);
        assert_eq!(hits[1].mtime, None); // FILETIME 0 → null
    }

    #[test]
    fn parse_list2_rejects_unrequested_fields() {
        let mut buf = make_list2(&[(0, "a.txt", "C:\\", 1, 2)]);
        // Claim a data field we never request — layout can't be trusted.
        buf[12..16].copy_from_slice(&0x73u32.to_le_bytes());
        assert!(parse_list2(&buf).is_err());
    }

    #[test]
    fn parse_list2_rejects_missing_name() {
        let mut buf = make_list2(&[(0, "a.txt", "C:\\", 1, 2)]);
        buf[12..16].copy_from_slice(&0x10u32.to_le_bytes()); // size only
        assert!(parse_list2(&buf).is_err());
    }

    #[test]
    fn filetime_to_unix_ms() {
        assert_eq!(filetime_ms(0), None);
        // 1970-01-01 UTC
        assert_eq!(filetime_ms(11_644_473_600_000 * 10_000), Some(0));
        // Pre-epoch (1601..1970) → null
        assert_eq!(filetime_ms(10_000), None);
    }

    #[test]
    fn sort_codes_match_official_header() {
        for (name, code) in [
            ("name", 1),
            ("name_desc", 2),
            ("path", 3),
            ("path_desc", 4),
            ("size", 5),
            ("size_desc", 6),
            ("mtime", 13),
            ("mtime_desc", 14),
        ] {
            assert_eq!(sort_code(name), Some(code));
            assert_eq!(sort_name(code), Some(name));
        }
        assert_eq!(sort_code("bogus"), None);
        assert_eq!(sort_name(0), None);
    }

    #[test]
    fn build_query_layout() {
        let job = Job {
            query: "abc".into(),
            max_results: 12,
            offset: 0,
            sort: None,
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

    #[test]
    fn build_query2_layout() {
        let job = Job {
            query: "abc".into(),
            max_results: 12,
            offset: 30,
            sort: sort_code("size_desc"),
            timeout: Duration::from_secs(1),
            out: channel().0,
        };
        let buf = build_query2(&job, 7, windows::Win32::Foundation::HWND(0x1234usize as *mut _));
        assert_eq!(&buf[0..4], &0x1234u32.to_le_bytes()); // reply_hwnd
        assert_eq!(&buf[4..8], &7u32.to_le_bytes()); // reply_copydata_message
        assert_eq!(&buf[8..12], &0u32.to_le_bytes()); // search_flags
        assert_eq!(&buf[12..16], &30u32.to_le_bytes()); // offset
        assert_eq!(&buf[16..20], &12u32.to_le_bytes()); // max_results
        assert_eq!(&buf[20..24], &REQUEST2_FLAGS.to_le_bytes()); // request_flags
        assert_eq!(&buf[24..28], &6u32.to_le_bytes()); // sort_type (size_desc)
        assert_eq!(buf.len(), QUERY2_HEADER + 8);
        assert_eq!(
            &buf[QUERY2_HEADER..],
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
            let out = search("readme", 5, 0, None, Duration::from_secs(3)).expect("everything query");
            eprintln!(
                "query {} → {} hits in {:?} (total {:?})",
                i,
                out.hits.len(),
                start.elapsed(),
                out.total
            );
            assert!(!out.hits.is_empty());
            assert!(out.hits.iter().all(|h| !h.path.is_empty()));
            std::thread::sleep(Duration::from_millis(300));
        }
    }

    /// Live QUERY2 round trip: total/meta/sort come back when Everything 1.4.1
    /// is running; a legacy install falls back to the QUERYW path (no meta).
    #[test]
    #[ignore] // requires Everything installed and running
    fn live_query2_meta() {
        let out = search("ext:pdf", 30, 30, Some("size_desc"), Duration::from_secs(3))
            .expect("everything query");
        eprintln!(
            "total={:?} sort={:?} hits={}",
            out.total,
            out.sort,
            out.hits.len()
        );
        for h in &out.hits {
            eprintln!("  {} {:?} {:?}", h.path, h.size, h.mtime);
        }
    }
}
