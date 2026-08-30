//! NTFS USN-journal full-drive index — the LumeSVC self-hosted file-search
//! backend for machines without Everything running.
//!
//! One `Engine` holds a `VolumeIndex` per fixed NTFS drive: an FRN→node map
//! (parent FRN + name in an append-only UTF-8 arena, original and lowercased
//! copies) built by a full MFT enumeration (`FSCTL_ENUM_USN_DATA`) and kept
//! fresh by a blocking `FSCTL_READ_USN_JOURNAL` loop per volume — zero idle
//! CPU. Queries are a case-insensitive substring scan over the lowercased
//! arena with Horspool skipping, prefix matches ranked first, then paths are
//! resolved by walking the parent chain.
//!
//! Lifecycle lives with the service: while Everything is running the engine
//! stays `off` (no duplicate full-drive index on the machine); when Everything
//! disappears the dormancy watcher calls `ensure_running`, which rebuilds.
//! Windows-API call sites are thin and untested here; the tree/record/query
//! logic below is covered by unit tests against synthetic records.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use super::everything::FileHit;

/// NTFS root-directory file reference number ("." record). Parent chains stop
/// here; the volume prefix is prepended at path resolution.
const ROOT_FRN: u64 = 5;
/// Hard stop for parent-chain walks (corrupt map → bound the loop).
const MAX_DEPTH: usize = 128;
/// USN journal size requested when the volume has none (32 MiB + 8 MiB delta,
/// Everything's defaults are in the same ballpark).
const JOURNAL_MAX: u64 = 32 * 1024 * 1024;
const JOURNAL_DELTA: u64 = 8 * 1024 * 1024;
const ENUM_BUFFER: usize = 64 * 1024;

// USN reason bits we track (name-affecting changes only).
const USN_REASON_FILE_CREATE: u32 = 0x0000_0100;
const USN_REASON_FILE_DELETE: u32 = 0x0000_0200;
const USN_REASON_RENAME_OLD_NAME: u32 = 0x0000_1000;
const USN_REASON_RENAME_NEW_NAME: u32 = 0x0000_2000;
const FILE_ATTRIBUTE_DIRECTORY: u32 = 0x10;

pub struct Engine {
    inner: Mutex<Inner>,
}

struct Inner {
    state: State,
    volumes: Vec<VolumeIndex>,
    /// Bumped by `set_off`/`ensure_running`; a build thread whose generation
    /// went stale discards its result (Everything appeared mid-build).
    generation: u64,
}

enum State {
    /// Everything is running — the engine deliberately holds no index.
    Off,
    Building,
    Ready,
    Failed(String),
}

impl State {
    fn as_str(&self) -> &'static str {
        match self {
            State::Off => "off",
            State::Building => "building",
            State::Ready => "ready",
            State::Failed(_) => "failed",
        }
    }
}

struct VolumeIndex {
    root: String, // "C:\"
    journal_id: u64,
    /// Journal position captured *before* the MFT enum; incremental reads
    /// start here so files created during the scan are not lost.
    next_usn: u64,
    map: HashMap<u64, Node>,
    /// FRNs in insertion order (deterministic query iteration); may hold stale
    /// ids after deletions until compaction.
    order: Vec<u64>,
    /// Append-only UTF-8 name arenas — original case for path building,
    /// lowercased for scanning. Renames append; the old bytes leak until the
    /// next full rebuild.
    names: Vec<u8>,
    lcase: Vec<u8>,
    files: u64,
}

#[derive(Clone, Copy)]
struct Node {
    parent: u64,
    name_off: u32,
    name_len: u16,
    dir: bool,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner {
                state: State::Off,
                volumes: Vec::new(),
                generation: 0,
            }),
        }
    }

    /// Everything is running — drop the index (no duplicate full-drive index).
    pub fn set_off(&self) {
        let mut inner = self.inner.lock().unwrap();
        if !matches!(inner.state, State::Off) {
            inner.volumes = Vec::new();
            inner.state = State::Off;
            inner.generation += 1;
        }
    }

    /// Build the index if we don't have one (called by the dormancy watcher
    /// when Everything is absent; also rebuilds after a volume error).
    pub fn ensure_running(self: &Arc<Self>) {
        {
            let mut inner = self.inner.lock().unwrap();
            if !matches!(inner.state, State::Off | State::Failed(_)) {
                return;
            }
            inner.state = State::Building;
            inner.generation += 1;
            inner.volumes = Vec::new();
        }
        let engine = Arc::clone(self);
        let _ = std::thread::Builder::new()
            .name("usn-index-build".into())
            .spawn(move || build(engine));
    }

    /// `(state, indexed files)` for the pipe `status` verb.
    pub fn status(&self) -> (&'static str, u64) {
        let inner = self.inner.lock().unwrap();
        match &inner.state {
            State::Failed(e) => {
                eprintln!("[usnidx] failed: {e}");
                ("failed", 0)
            }
            s => (s.as_str(), inner.volumes.iter().map(|v| v.files).sum()),
        }
    }

    /// Search the current index (partial while building). Returns the state
    /// string alongside the hits so callers can surface "still building".
    pub fn search(&self, query: &str, max: usize) -> (&'static str, Vec<FileHit>) {
        let query = query.trim();
        if query.is_empty() {
            return ("ready", Vec::new());
        }
        let needle: Vec<u8> = query.to_lowercase().into_bytes();
        let inner = self.inner.lock().unwrap();
        let status = inner.state.as_str();
        let mut matches: Vec<(u8, u16, u64, usize)> = Vec::new(); // (score, name_len, frn, vol)
        for (vi, vol) in inner.volumes.iter().enumerate() {
            for &frn in &vol.order {
                let Some(node) = vol.map.get(&frn) else {
                    continue; // stale order entry
                };
                let hay = &vol.lcase[node.name_off as usize..node.name_off as usize + node.name_len as usize];
                if !contains_bytes(hay, &needle) {
                    continue;
                }
                let score: u8 = if hay.starts_with(&needle) { 0 } else { 1 };
                matches.push((score, node.name_len, frn, vi));
            }
        }
        matches.sort_unstable();
        matches.truncate(max);
        let hits = matches
            .iter()
            .filter_map(|&(_, _, frn, vi)| {
                let vol = &inner.volumes[vi];
                let path = resolve_path(vol, frn)?;
                let node = vol.map.get(&frn)?;
                let name = String::from_utf8_lossy(
                    &vol.names[node.name_off as usize..node.name_off as usize + node.name_len as usize],
                )
                .into_owned();
                Some(FileHit {
                    name,
                    path,
                    is_folder: node.dir,
                })
            })
            .collect();
        (status, hits)
    }
}

fn build(engine: Arc<Engine>) {
    let generation = engine.inner.lock().unwrap().generation;
    let roots = ntfs_fixed_roots();
    for root in roots {
        if engine.inner.lock().unwrap().generation != generation {
            return; // superseded (Everything appeared)
        }
        match scan_volume(&root) {
            Ok(vol) => {
                let files = vol.files;
                let mut inner = engine.inner.lock().unwrap();
                if inner.generation != generation {
                    return;
                }
                inner.volumes.push(vol);
                drop(inner);
                spawn_usn_worker(&engine, &root, generation);
                eprintln!("[usnidx] indexed {root} ({files} files)");
            }
            Err(e) => {
                eprintln!("[usnidx] {root} scan failed: {e}");
                let mut inner = engine.inner.lock().unwrap();
                if inner.generation == generation {
                    inner.state = State::Failed(format!("{root}: {e}"));
                }
                return;
            }
        }
    }
    let mut inner = engine.inner.lock().unwrap();
    if inner.generation == generation {
        inner.state = State::Ready;
    }
}

// ---------------------------------------------------------------------------
// Tree mutations (unit-tested against synthetic records)
// ---------------------------------------------------------------------------

fn upsert(vol: &mut VolumeIndex, frn: u64, parent: u64, name: &[u16], dir: bool) {
    if frn == ROOT_FRN || name.is_empty() {
        return;
    }
    let name_str = String::from_utf16_lossy(name);
    let name_bytes = name_str.as_bytes();
    let name_off = vol.names.len() as u32;
    vol.names.extend_from_slice(name_bytes);
    let name_len = name_bytes.len().min(u16::MAX as usize) as u16;
    vol.lcase
        .extend_from_slice(name_str.to_lowercase().as_bytes());
    match vol.map.get_mut(&frn) {
        Some(node) => {
            node.parent = parent;
            node.name_off = name_off;
            node.name_len = name_len;
            node.dir = dir;
        }
        None => {
            vol.map.insert(
                frn,
                Node {
                    parent,
                    name_off,
                    name_len,
                    dir,
                },
            );
            vol.order.push(frn);
            if !dir {
                vol.files += 1;
            }
        }
    }
}

fn remove_node(vol: &mut VolumeIndex, frn: u64) {
    if frn == ROOT_FRN {
        return;
    }
    if let Some(node) = vol.map.remove(&frn) {
        if !node.dir {
            vol.files -= 1;
        }
    }
    // Compaction: once stale order entries dominate, rebuild the list.
    if vol.order.len() >= vol.map.len() * 2 + 1024 {
        vol.order.retain(|f| vol.map.contains_key(f));
    }
}

/// Apply one USN record's name-affecting reasons to the tree.
fn apply_usn_record(vol: &mut VolumeIndex, frn: u64, parent: u64, reason: u32, attrs: u32, name: &[u16]) {
    if frn == ROOT_FRN {
        return;
    }
    let dir = attrs & FILE_ATTRIBUTE_DIRECTORY != 0;
    if reason & (USN_REASON_FILE_DELETE | USN_REASON_RENAME_OLD_NAME) != 0 {
        remove_node(vol, frn);
    }
    if reason & (USN_REASON_FILE_CREATE | USN_REASON_RENAME_NEW_NAME) != 0 {
        upsert(vol, frn, parent, name, dir);
    }
}

fn resolve_path(vol: &VolumeIndex, frn: u64) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    let mut cur = frn;
    for _ in 0..MAX_DEPTH {
        if cur == ROOT_FRN {
            break;
        }
        let node = vol.map.get(&cur)?;
        let name = std::str::from_utf8(
            &vol.names[node.name_off as usize..node.name_off as usize + node.name_len as usize],
        )
        .ok()?;
        parts.push(name);
        cur = node.parent;
    }
    if parts.is_empty() {
        return None;
    }
    parts.reverse();
    Some(format!("{}{}", vol.root, parts.join("\\")))
}

/// Case-insensitive substring search over pre-lowercased UTF-8 (byte-level
/// matching is safe: UTF-8 is self-synchronizing). Horspool bad-char shifts.
fn contains_bytes(hay: &[u8], needle: &[u8]) -> bool {
    let n = needle.len();
    if n == 0 {
        return true;
    }
    if hay.len() < n {
        return false;
    }
    let mut skip = [n; 256];
    for (i, &b) in needle.iter().enumerate() {
        skip[b as usize] = (n - 1 - i).max(1);
    }
    let mut i = 0;
    while i + n <= hay.len() {
        if &hay[i..i + n] == needle {
            return true;
        }
        i += skip[hay[i + n - 1] as usize];
    }
    false
}

// ---------------------------------------------------------------------------
// Windows API: volume discovery, MFT enum, USN journal
// ---------------------------------------------------------------------------

/// Fixed NTFS drive roots ("C:\", ...). Removable/network volumes are out of
/// scope for v1 (documented).
fn ntfs_fixed_roots() -> Vec<String> {
    use windows::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW};
    use windows::Win32::System::WindowsProgramming::DRIVE_FIXED;
    let mut roots = Vec::new();
    let mask = unsafe { GetLogicalDrives() };
    for bit in 0..26u32 {
        if mask & (1 << bit) == 0 {
            continue;
        }
        let root = format!("{}:\\", (b'A' + bit as u8) as char);
        let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();
        unsafe {
            if GetDriveTypeW(windows::core::PCWSTR(wide.as_ptr())) != DRIVE_FIXED {
                continue;
            }
            let mut fs = [0u16; 16];
            let ok = GetVolumeInformationW(
                windows::core::PCWSTR(wide.as_ptr()),
                None,
                None,
                None,
                Some(&mut 0u32),
                Some(&mut fs),
            );
            if ok.is_err() {
                continue;
            }
            let fs_name = String::from_utf16_lossy(&fs[..fs.iter().position(|&c| c == 0).unwrap_or(0)]);
            if !fs_name.eq_ignore_ascii_case("NTFS") {
                continue;
            }
        }
        roots.push(root);
    }
    roots
}

fn open_volume(root: &str) -> Result<windows::Win32::Foundation::HANDLE, String> {
    use windows::Win32::Foundation::GENERIC_READ;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
    };
    let path = format!(r"\\.\{}", root.trim_end_matches('\\'));
    let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        CreateFileW(
            windows::core::PCWSTR(wide.as_ptr()),
            GENERIC_READ.0,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            None,
            OPEN_EXISTING,
            windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES(0),
            None,
        )
        .map_err(|e| format!("open volume: {e}"))
    }
}

/// `(journal_id, next_usn)`, creating the journal when the volume has none.
fn query_journal(handle: windows::Win32::Foundation::HANDLE) -> Result<(u64, u64), String> {
    use windows::Win32::System::Ioctl::{FSCTL_CREATE_USN_JOURNAL, FSCTL_QUERY_USN_JOURNAL};
    let mut buf = [0u8; 64];
    let read = match device_ioctl(handle, FSCTL_QUERY_USN_JOURNAL, &[], &mut buf) {
        Ok(n) => n,
        Err(e) if win32_code(&e) == ERROR_JOURNAL_NOT_ACTIVE => {
            // ERROR_JOURNAL_NOT_ACTIVE — create one (Everything's default
            // sizing) and retry once.
            let mut create = [0u8; 16];
            create[0..8].copy_from_slice(&JOURNAL_MAX.to_le_bytes());
            create[8..16].copy_from_slice(&JOURNAL_DELTA.to_le_bytes());
            device_ioctl(handle, FSCTL_CREATE_USN_JOURNAL, &create, &mut [])
                .map_err(|e| format!("create usn journal: {e}"))?;
            device_ioctl(handle, FSCTL_QUERY_USN_JOURNAL, &[], &mut buf)
                .map_err(|e| format!("query usn journal (retry): {e}"))?
        }
        Err(e) => return Err(format!("query usn journal: {e}")),
    };
    parse_journal_data(&buf[..read])
}

/// USN_JOURNAL_DATA_V0 { UsnJournalID, FirstUsn, NextUsn, ... }
fn parse_journal_data(out: &[u8]) -> Result<(u64, u64), String> {
    if out.len() < 24 {
        return Err("short USN_JOURNAL_DATA".into());
    }
    Ok((
        u64::from_le_bytes(out[0..8].try_into().unwrap()),
        u64::from_le_bytes(out[16..24].try_into().unwrap()),
    ))
}

/// Full MFT enumeration for one volume. The journal position is captured
/// before the scan so the incremental worker can pick up mid-scan changes.
fn scan_volume(root: &str) -> Result<VolumeIndex, String> {
    use windows::Win32::System::Ioctl::FSCTL_ENUM_USN_DATA;
    let handle = open_volume(root)?;
    let (journal_id, next_usn) = query_journal(handle)?;
    let mut vol = VolumeIndex {
        root: root.to_string(),
        journal_id,
        next_usn,
        map: HashMap::new(),
        order: Vec::new(),
        names: Vec::new(),
        lcase: Vec::new(),
        files: 0,
    };
    // MFT_ENUM_DATA_V0 { StartFileReferenceNumber, LowUsn, HighUsn }
    let mut input = [0u8; 24];
    let mut out = vec![0u8; ENUM_BUFFER];
    loop {
        let written = match device_ioctl(handle, FSCTL_ENUM_USN_DATA, &input, &mut out) {
            Ok(w) => w,
            Err(e) if win32_code(&e) == ERROR_HANDLE_EOF => break, // enum complete
            Err(e) => return Err(format!("enum mft: {e}")),
        };
        if written < 8 {
            break;
        }
        let next_frn = u64::from_le_bytes(out[0..8].try_into().unwrap());
        input[0..8].copy_from_slice(&next_frn.to_le_bytes());
        let mut off = 8usize;
        while off + 60 <= written {
            let rec_len = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
            if rec_len < 60 || off + rec_len > written {
                break;
            }
            let frn = u64::from_le_bytes(out[off + 8..off + 16].try_into().unwrap());
            let parent = u64::from_le_bytes(out[off + 16..off + 24].try_into().unwrap());
            let attrs = u32::from_le_bytes(out[off + 52..off + 56].try_into().unwrap());
            let name_len =
                u16::from_le_bytes(out[off + 56..off + 58].try_into().unwrap()) as usize;
            let name_off =
                u16::from_le_bytes(out[off + 58..off + 60].try_into().unwrap()) as usize;
            if frn != ROOT_FRN && name_len > 0 && name_off + name_len <= rec_len {
                let units = name_len / 2;
                let slice = &out[off + name_off..off + name_off + units * 2];
                let name: Vec<u16> = slice
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect();
                upsert(&mut vol, frn, parent, &name, attrs & FILE_ATTRIBUTE_DIRECTORY != 0);
            }
            off += rec_len;
        }
    }
    Ok(vol)
}

/// One blocking USN-read worker per volume: applies rename/create/delete
/// records as the journal produces them (zero idle CPU — the read blocks
/// until at least one byte is written).
fn spawn_usn_worker(engine: &Arc<Engine>, root: &str, generation: u64) {
    use windows::Win32::System::Ioctl::FSCTL_READ_USN_JOURNAL;
    let engine = Arc::clone(engine);
    let root = root.to_string();
    let (journal_id, start_usn) = {
        let inner = engine.inner.lock().unwrap();
        match inner.volumes.iter().find(|v| v.root == root) {
            Some(v) => (v.journal_id, v.next_usn),
            None => return,
        }
    };
    let mut next_usn = start_usn;
    let _ = std::thread::Builder::new()
        .name(format!("usn-watch-{root}"))
        .spawn(move || {
            let Ok(handle) = open_volume(&root) else {
                mark_volume_failed(&engine, &root, "volume open failed");
                return;
            };
            // READ_USN_JOURNAL_DATA_V0 { StartUsn, ReasonMask, BytesToWaitFor,
            // UsnJournalID } — BytesToWaitFor = 1 makes the call block until
            // the journal grows.
            let mut input = [0u8; 24];
            input[8..12].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // reason mask
            input[12..16].copy_from_slice(&1u32.to_le_bytes()); // bytes to wait
            input[16..24].copy_from_slice(&journal_id.to_le_bytes());
            let mut out = vec![0u8; ENUM_BUFFER];
            loop {
                input[0..8].copy_from_slice(&next_usn.to_le_bytes());
                let written = match device_ioctl(handle, FSCTL_READ_USN_JOURNAL, &input, &mut out) {
                    Ok(w) if w >= 8 => w,
                    Ok(_) => continue,
                    Err(e) => {
                        mark_volume_failed(&engine, &root, &format!("usn read: {e}"));
                        return;
                    }
                };
                next_usn = u64::from_le_bytes(out[0..8].try_into().unwrap());
                let mut off = 8usize;
                let mut inner = engine.inner.lock().unwrap();
                if inner.generation != generation {
                    return; // index dropped/rebuilt; this worker is stale
                }
                let Some(vol) = inner.volumes.iter_mut().find(|v| v.root == root) else {
                    return;
                };
                vol.next_usn = next_usn;
                while off + 60 <= written {
                    let rec_len = u32::from_le_bytes(out[off..off + 4].try_into().unwrap()) as usize;
                    if rec_len < 60 || off + rec_len > written {
                        break;
                    }
                    let frn = u64::from_le_bytes(out[off + 8..off + 16].try_into().unwrap());
                    let parent = u64::from_le_bytes(out[off + 16..off + 24].try_into().unwrap());
                    let reason = u32::from_le_bytes(out[off + 40..off + 44].try_into().unwrap());
                    let attrs = u32::from_le_bytes(out[off + 52..off + 56].try_into().unwrap());
                    let name_len =
                        u16::from_le_bytes(out[off + 56..off + 58].try_into().unwrap()) as usize;
                    let name_off =
                        u16::from_le_bytes(out[off + 58..off + 60].try_into().unwrap()) as usize;
                    if frn != ROOT_FRN && name_len > 0 && name_off + name_len <= rec_len {
                        let units = name_len / 2;
                        let slice = &out[off + name_off..off + name_off + units * 2];
                        let name: Vec<u16> = slice
                            .chunks_exact(2)
                            .map(|p| u16::from_le_bytes([p[0], p[1]]))
                            .collect();
                        apply_usn_record(vol, frn, parent, reason, attrs, &name);
                    }
                    off += rec_len;
                }
            }
        });
}

fn mark_volume_failed(engine: &Engine, root: &str, why: &str) {
    let mut inner = engine.inner.lock().unwrap();
    if matches!(inner.state, State::Ready | State::Building) {
        inner.volumes.retain(|v| v.root != root);
        inner.state = State::Failed(format!("{root}: {why}"));
    }
    eprintln!("[usnidx] {root} watcher stopped: {why} (rebuild scheduled)");
}

/// Win32 error code of a windows-crate HRESULT (0x8007xxxx → xxxx).
fn win32_code(e: &windows::core::Error) -> u32 {
    (e.code().0 as u32) & 0xFFFF
}

const ERROR_HANDLE_EOF: u32 = 38; // enum complete
const ERROR_JOURNAL_NOT_ACTIVE: u32 = 0x181;

/// Thin `DeviceIoControl` wrapper: returns the number of bytes written to
/// `out`, or the raw win32 error for callers to interpret.
fn device_ioctl(
    handle: windows::Win32::Foundation::HANDLE,
    code: u32,
    input: &[u8],
    out: &mut [u8],
) -> Result<usize, windows::core::Error> {
    use windows::Win32::System::IO::DeviceIoControl;
    let mut returned = 0u32;
    unsafe {
        DeviceIoControl(
            handle,
            code,
            Some(input.as_ptr() as *const core::ffi::c_void),
            input.len() as u32,
            Some(out.as_mut_ptr() as *mut core::ffi::c_void),
            out.len() as u32,
            Some(&mut returned),
            None,
        )?;
    }
    Ok(returned as usize)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vol() -> VolumeIndex {
        VolumeIndex {
            root: "C:\\".into(),
            journal_id: 1,
            next_usn: 0,
            map: HashMap::new(),
            order: Vec::new(),
            names: Vec::new(),
            lcase: Vec::new(),
            files: 0,
        }
    }

    fn name_u16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn upsert_builds_tree_and_counts_files() {
        let mut v = vol();
        upsert(&mut v, 5, 5, &name_u16("."), true);
        assert!(v.map.is_empty()); // root record skipped
        upsert(&mut v, 100, 5, &name_u16("Users"), true);
        upsert(&mut v, 200, 100, &name_u16("me"), true);
        upsert(&mut v, 300, 200, &name_u16("readme.txt"), false);
        assert_eq!(v.files, 1);
        assert_eq!(resolve_path(&v, 300).as_deref(), Some("C:\\Users\\me\\readme.txt"));
        assert_eq!(resolve_path(&v, 100).as_deref(), Some("C:\\Users"));
    }

    #[test]
    fn rename_updates_name_in_place() {
        let mut v = vol();
        upsert(&mut v, 10, 5, &name_u16("old.txt"), false);
        // Rename arrives as OLD_NAME then NEW_NAME records for the same FRN.
        apply_usn_record(&mut v, 10, 5, USN_REASON_RENAME_OLD_NAME, 0, &name_u16("old.txt"));
        assert!(v.map.get(&10).is_none());
        apply_usn_record(&mut v, 10, 5, USN_REASON_RENAME_NEW_NAME, 0, &name_u16("new.txt"));
        assert_eq!(resolve_path(&v, 10).as_deref(), Some("C:\\new.txt"));
        assert_eq!(v.files, 1); // -1 +1 across the rename
    }

    #[test]
    fn delete_removes_and_directory_move_resolves() {
        let mut v = vol();
        upsert(&mut v, 100, 5, &name_u16("Projects"), true);
        upsert(&mut v, 200, 100, &name_u16("lume"), true);
        upsert(&mut v, 300, 200, &name_u16("main.rs"), false);
        // Moving a directory does NOT rewrite children's parent FRN — the dir
        // keeps its FRN, so the tree stays valid after re-parenting 100.
        apply_usn_record(&mut v, 100, 5, USN_REASON_RENAME_OLD_NAME, FILE_ATTRIBUTE_DIRECTORY, &name_u16("Projects"));
        apply_usn_record(&mut v, 100, 5, USN_REASON_RENAME_NEW_NAME, FILE_ATTRIBUTE_DIRECTORY, &name_u16("Dev"));
        assert_eq!(resolve_path(&v, 300).as_deref(), Some("C:\\Dev\\lume\\main.rs"));
        apply_usn_record(&mut v, 300, 200, USN_REASON_FILE_DELETE, 0, &name_u16("main.rs"));
        assert!(resolve_path(&v, 300).is_none());
        assert_eq!(v.files, 0);
    }

    #[test]
    fn search_ranks_prefix_and_matches_case_insensitively() {
        let mut v = vol();
        upsert(&mut v, 10, 5, &name_u16("Readme.txt"), false);
        upsert(&mut v, 11, 5, &name_u16("my-readme.txt"), false);
        upsert(&mut v, 12, 5, &name_u16("unrelated.log"), false);
        upsert(&mut v, 13, 5, &name_u16("设置指南.pdf"), false);
        let engine = Engine {
            inner: Mutex::new(Inner {
                state: State::Ready,
                volumes: vec![v],
                generation: 1,
            }),
        };
        let (status, hits) = engine.search("readme", 10);
        assert_eq!(status, "ready");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].name, "Readme.txt"); // prefix match first
        assert_eq!(hits[1].name, "my-readme.txt");
        let (_, hits) = engine.search("设置", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "C:\\设置指南.pdf");
        let (_, hits) = engine.search("xyz", 10);
        assert!(hits.is_empty());
    }

    #[test]
    fn order_compaction_drops_stale_frn_entries() {
        let mut v = vol();
        for frn in 1..=2000u64 {
            upsert(&mut v, frn, 5, &name_u16("f.txt"), false);
        }
        assert_eq!(v.order.len(), 1999); // frn 5 (root) is skipped
        for frn in 1..=1600u64 {
            remove_node(&mut v, frn);
        }
        // Compaction fires once the stale count crosses the threshold
        // (1999 stale ≥ 487 live * 2 + 1024), trimming to the then-live set;
        // removals after that point just accumulate again (bounded).
        assert_eq!(v.map.len(), 400);
        assert_eq!(v.order.len(), 487);
    }

    #[test]
    fn contains_bytes_basics() {
        assert!(contains_bytes(b"hello world", b""));
        assert!(contains_bytes(b"hello world", b"world"));
        assert!(contains_bytes(b"hello world", b"lo wo"));
        assert!(!contains_bytes(b"hello", b"hello world"));
        assert!(!contains_bytes(b"hello", b"llx"));
        assert!(contains_bytes("设置指南.pdf".as_bytes(), "指南".as_bytes()));
    }

    /// Full real-volume scan + query. Requires an elevated process (opening
    /// `\\.\C:` with GENERIC_READ needs admin): run cargo test as admin with
    /// `-- --ignored live_scan`.
    #[test]
    #[ignore]
    fn live_scan() {
        let vol = scan_volume("C:\\").expect("scan C:");
        eprintln!("indexed {} files on C:, {} nodes", vol.files, vol.map.len());
        let engine = Engine {
            inner: Mutex::new(Inner {
                state: State::Ready,
                volumes: vec![vol],
                generation: 1,
            }),
        };
        let (status, hits) = engine.search("windows", 10);
        eprintln!("search 'windows' ({status}): {:#?}", hits);
        assert_eq!(status, "ready");
        assert!(!hits.is_empty());
    }
}
