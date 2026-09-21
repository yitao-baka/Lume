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
///
/// FRNs carry the MFT **sequence number in the high 16 bits** — a parent
/// reference to the root arrives as 0x0005_0000_0000_0005, not 5. Every FRN
/// is masked to its low 48-bit record number at parse time (matching is
/// tree-internal, so the sequence is irrelevant); forgetting the mask makes
/// 100% of path resolutions fail while names still look fine.
const FRN_MASK: u64 = 0x0000_FFFF_FFFF_FFFF;
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
    /// Membership of `order` — the rename path (remove → upsert of the same
    /// FRN) and MFT record reuse would otherwise push duplicates.
    ordered: std::collections::HashSet<u64>,
    /// Append-only UTF-8 name arenas — original case for path building,
    /// lowercased for scanning. Renames append; the old bytes leak until the
    /// next full rebuild.
    names: Vec<u8>,
    lcase: Vec<u8>,
    files: u64,
    /// One-line scan telemetry (batches/records/skips/termination) surfaced
    /// through the pipe `debug` verb.
    scan_debug: String,
}

#[derive(Clone, Copy)]
struct Node {
    parent: u64,
    /// Original-name slice in the `names` arena (path building).
    name_off: u32,
    name_len: u16,
    /// Lowercased-name slice in the `lcase` arena (scanning). Offsets are
    /// tracked per arena because `to_lowercase` can change the byte length
    /// (e.g. U+0130 → "i" + U+0307) — sharing one offset pair silently
    /// desynchronizes the lowercase arena and kills matching for every node
    /// after the first length-changing name.
    lcase_off: u32,
    lcase_len: u16,
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

    /// Diagnostics for the pipe `debug` verb: per-volume counters + a few
    /// resolved sample paths (empty when nothing resolves).
    pub fn debug_samples(&self, count: usize) -> serde_json::Value {
        let inner = self.inner.lock().unwrap();
        let volumes = inner
            .volumes
            .iter()
            .map(|v| {
                let samples: Vec<String> = v
                    .order
                    .iter()
                    .filter_map(|frn| resolve_path(v, *frn))
                    .take(count)
                    .collect();
                serde_json::json!({
                    "root": v.root,
                    "files": v.files,
                    "map": v.map.len(),
                    "order": v.order.len(),
                    "names_bytes": v.names.len(),
                    "lcase_bytes": v.lcase.len(),
                    "scan": v.scan_debug,
                    "samples": samples,
                })
            })
            .collect::<Vec<serde_json::Value>>();
        serde_json::json!({ "volumes": volumes })
    }

    /// `(state, indexed files, failure reason)` for the pipe `status` verb —
    /// the reason travels to the caller because the service's own stderr is
    /// lost under the SCM.
    pub fn status(&self) -> (&'static str, u64, Option<String>) {
        let inner = self.inner.lock().unwrap();
        match &inner.state {
            State::Failed(e) => ("failed", 0, Some(e.clone())),
            s => (
                s.as_str(),
                inner.volumes.iter().map(|v| v.files).sum(),
                None,
            ),
        }
    }

    /// Search the current index (partial while building). Returns the state
    /// string alongside the hits so callers can surface "still building".
    ///
    /// Ranking is by `(prefix match first, shorter name first, frn, volume)` —
    /// a total order, so the same query always returns the same page no matter
    /// how the map iterates. The scan keeps only the best `max` candidates in
    /// a bounded heap: a single character matches hundreds of thousands of
    /// names, and collecting them all just to sort and truncate was the
    /// query's second-largest cost after the match itself.
    pub fn search(&self, query: &str, max: usize) -> (&'static str, Vec<FileHit>) {
        let query = query.trim();
        if query.is_empty() {
            return ("ready", Vec::new());
        }
        let needle: Vec<u8> = query.to_lowercase().into_bytes();
        let matcher = Matcher::new(&needle);
        let inner = self.inner.lock().unwrap();
        let status = inner.state.as_str();
        // (score, name_len, frn, vol) — a max-heap that never holds more than
        // `max` entries, so popping the largest leaves the best `max`.
        let mut best: std::collections::BinaryHeap<(u8, u16, u64, usize)> =
            std::collections::BinaryHeap::with_capacity(max + 1);
        for (vi, vol) in inner.volumes.iter().enumerate() {
            for (&frn, node) in &vol.map {
                let off = node.lcase_off as usize;
                let hay = &vol.lcase[off..off + node.lcase_len as usize];
                if !matcher.is_match(hay) {
                    continue;
                }
                let score: u8 = if hay.starts_with(&needle) { 0 } else { 1 };
                best.push((score, node.name_len, frn, vi));
                if best.len() > max {
                    best.pop();
                }
            }
        }
        let hits = best
            .into_sorted_vec()
            .into_iter()
            .filter_map(|(_, _, frn, vi)| {
                let vol = &inner.volumes[vi];
                let path = resolve_path(vol, frn)?;
                let node = vol.map.get(&frn)?;
                let name = String::from_utf8_lossy(
                    &vol.names[node.name_off as usize..node.name_off as usize + node.name_len as usize],
                )
                .into_owned();
                // USN records carry no reliable size/mtime — the caller stats
                // the result page if it needs metadata (filesearch.rs).
                Some(FileHit {
                    name,
                    path,
                    is_folder: node.dir,
                    mtime: None,
                    size: None,
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
    let lcase_bytes = name_str.to_lowercase();
    let name_off = vol.names.len() as u32;
    let lcase_off = vol.lcase.len() as u32;
    vol.names.extend_from_slice(name_bytes);
    vol.lcase.extend_from_slice(lcase_bytes.as_bytes());
    let name_len = name_bytes.len().min(u16::MAX as usize) as u16;
    let lcase_len = lcase_bytes.len().min(u16::MAX as usize) as u16;
    match vol.map.get_mut(&frn) {
        Some(node) => {
            node.parent = parent;
            node.name_off = name_off;
            node.name_len = name_len;
            node.lcase_off = lcase_off;
            node.lcase_len = lcase_len;
            node.dir = dir;
        }
        None => {
            vol.map.insert(
                frn,
                Node {
                    parent,
                    name_off,
                    name_len,
                    lcase_off,
                    lcase_len,
                    dir,
                },
            );
            if vol.ordered.insert(frn) {
                vol.order.push(frn);
            }
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
        vol.ordered = vol.order.iter().copied().collect();
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
/// One query's matcher: the Horspool skip table is built **once per query**
/// and reused across every name in the index. It used to be rebuilt inside
/// the per-file scan — a 256-byte table initialization for each of ~680k
/// names, which dominated the whole query (267 of its 270 ms in a debug
/// build). A one-byte needle (the "type one character" case) skips Horspool
/// entirely for `memchr`-backed `slice::contains`.
struct Matcher {
    needle: Vec<u8>,
    skip: [usize; 256],
}

impl Matcher {
    fn new(needle: &[u8]) -> Self {
        let n = needle.len();
        let mut skip = [n.max(1); 256];
        for (i, &b) in needle.iter().enumerate() {
            skip[b as usize] = (n - 1 - i).max(1);
        }
        Self {
            needle: needle.to_vec(),
            skip,
        }
    }

    fn is_match(&self, hay: &[u8]) -> bool {
        let needle = &self.needle[..];
        let n = needle.len();
        if n == 0 {
            return true;
        }
        if hay.len() < n {
            return false;
        }
        if n == 1 {
            return hay.contains(&needle[0]);
        }
        let mut i = 0;
        while i + n <= hay.len() {
            if &hay[i..i + n] == needle {
                return true;
            }
            i += self.skip[hay[i + n - 1] as usize];
        }
        false
    }
}

/// Convenience wrapper for tests and one-off checks (rebuilds the table).
#[cfg(test)]
fn contains_bytes(hay: &[u8], needle: &[u8]) -> bool {
    Matcher::new(needle).is_match(hay)
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
        ordered: std::collections::HashSet::new(),
        names: Vec::new(),
        lcase: Vec::new(),
        files: 0,
        scan_debug: String::new(),
    };
    // MFT_ENUM_DATA_V0 { StartFileReferenceNumber, LowUsn, HighUsn } — u64
    // backing for the DWORD alignment the FSCTLs expect (see `as_u8`).
    let mut input = [0u64; 3];
    // HighUsn filters records by their LAST USN — the pair must bracket the
    // whole journal: [0, NextUsn]. 0/0 returns only never-journaled records
    // (a small fraction that looked like an early EOF); MAX exceeds the
    // journal's valid range and returns nothing.
    input[2] = next_usn;
    let mut out = vec![0u64; ENUM_BUFFER / 8];
    let (mut batches, mut records, mut skips) = (0u32, 0u32, 0u32);
    let mut term = "eof".to_string();
    let mut written = 0usize;
    loop {
        batches += 1;
        written = match device_ioctl(handle, FSCTL_ENUM_USN_DATA, as_u8(&input), as_u8_mut(&mut out)) {
            Ok(w) => w,
            Err(e) if win32_code(&e) == ERROR_HANDLE_EOF => break, // enum complete
            Err(e) => return Err(format!("enum mft: {e}")),
        };
        if written < 8 {
            term = format!("short:{written}");
            break;
        }
        let bytes = as_u8(&out);
        let next_frn = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        input[0] = next_frn;
        let mut off = 8usize;
        while off + 60 <= written {
            let rec_len = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
            if rec_len < 60 || off + rec_len > written {
                break;
            }
            let frn =
                u64::from_le_bytes(bytes[off + 8..off + 16].try_into().unwrap()) & FRN_MASK;
            let parent =
                u64::from_le_bytes(bytes[off + 16..off + 24].try_into().unwrap()) & FRN_MASK;
            let attrs = u32::from_le_bytes(bytes[off + 52..off + 56].try_into().unwrap());
            let name_len =
                u16::from_le_bytes(bytes[off + 56..off + 58].try_into().unwrap()) as usize;
            let name_off =
                u16::from_le_bytes(bytes[off + 58..off + 60].try_into().unwrap()) as usize;
            if frn != ROOT_FRN && name_len > 0 && name_off + name_len <= rec_len {
                let units = name_len / 2;
                let slice = &bytes[off + name_off..off + name_off + units * 2];
                let name: Vec<u16> = slice
                    .chunks_exact(2)
                    .map(|p| u16::from_le_bytes([p[0], p[1]]))
                    .collect();
                records += 1;
                upsert(&mut vol, frn, parent, &name, attrs & FILE_ATTRIBUTE_DIRECTORY != 0);
            }
            off += rec_len;
        }
        if off + 60 <= written {
            skips += 1;
        }
    }
    vol.scan_debug = format!(
        "batches:{batches} records:{records} skips:{skips} term:{term} last_written:{written}"
    );
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
            // READ_USN_JOURNAL_DATA_V0 (40 bytes, MSDN layout):
            // { StartUsn, ReasonMask, ReturnOnlyOnClose, Timeout,
            //   BytesToWaitFor, UsnJournalID } — BytesToWaitFor = 1 with
            // Timeout = 0 blocks until the journal grows (zero idle CPU).
            // Buffers ride on u64 backing: this FSCTL is picky about buffer
            // validity (a short/misaligned one fails with
            // ERROR_INVALID_USER_BUFFER 0x6F8) — `u8` arrays/Vecs carry no
            // alignment guarantee.
            let mut input = [0u64; 5];
            let mut out = vec![0u64; ENUM_BUFFER / 8];
            loop {
                input[0] = next_usn; // StartUsn
                input[1] = 0xFFFF_FFFF; // ReasonMask | ReturnOnlyOnClose(0)
                input[2] = 0; // Timeout (seconds)
                input[3] = 1; // BytesToWaitFor
                input[4] = journal_id; // UsnJournalID
                let written = match device_ioctl(handle, FSCTL_READ_USN_JOURNAL, as_u8(&input), as_u8_mut(&mut out)) {
                    Ok(w) if w >= 8 => w,
                    Ok(_) => continue,
                    Err(e) => {
                        mark_volume_failed(&engine, &root, &format!("usn read: {e}"));
                        return;
                    }
                };
                let bytes = as_u8(&out);
                next_usn = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
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
                    let rec_len = u32::from_le_bytes(bytes[off..off + 4].try_into().unwrap()) as usize;
                    if rec_len < 60 || off + rec_len > written {
                        break;
                    }
                    let frn =
                        u64::from_le_bytes(bytes[off + 8..off + 16].try_into().unwrap()) & FRN_MASK;
                    let parent =
                        u64::from_le_bytes(bytes[off + 16..off + 24].try_into().unwrap()) & FRN_MASK;
                    let reason = u32::from_le_bytes(bytes[off + 40..off + 44].try_into().unwrap());
                    let attrs = u32::from_le_bytes(bytes[off + 52..off + 56].try_into().unwrap());
                    let name_len =
                        u16::from_le_bytes(bytes[off + 56..off + 58].try_into().unwrap()) as usize;
                    let name_off =
                        u16::from_le_bytes(bytes[off + 58..off + 60].try_into().unwrap()) as usize;
                    if frn != ROOT_FRN && name_len > 0 && name_off + name_len <= rec_len {
                        let units = name_len / 2;
                        let slice = &bytes[off + name_off..off + name_off + units * 2];
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

/// Byte views over `u64`-backed buffers: the USN FSCTLs require DWORD-
/// aligned buffers (`READ_USN_JOURNAL` fails with ERROR_INVALID_USER_BUFFER
/// on misaligned ones), and `u8` arrays/`Vec<u8>` carry no alignment
/// guarantee. A `u64` slice is always 8-aligned; these casts only reinterpret
/// the same memory.
fn as_u8(buf: &[u64]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(buf.as_ptr() as *const u8, buf.len() * 8) }
}

fn as_u8_mut(buf: &mut [u64]) -> &mut [u8] {
    unsafe { std::slice::from_raw_parts_mut(buf.as_mut_ptr() as *mut u8, buf.len() * 8) }
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
            ordered: std::collections::HashSet::new(),
            names: Vec::new(),
            lcase: Vec::new(),
            files: 0,
            scan_debug: String::new(),
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
    fn upsert_does_not_duplicate_order_across_rename_cycles() {
        let mut v = vol();
        upsert(&mut v, 10, 5, &name_u16("a.txt"), false);
        apply_usn_record(&mut v, 10, 5, USN_REASON_RENAME_OLD_NAME, 0, &name_u16("a.txt"));
        apply_usn_record(&mut v, 10, 5, USN_REASON_RENAME_NEW_NAME, 0, &name_u16("b.txt"));
        // MFT record reuse after delete + create of the same record number.
        apply_usn_record(&mut v, 10, 5, USN_REASON_FILE_DELETE, 0, &name_u16("b.txt"));
        upsert(&mut v, 10, 5, &name_u16("c.txt"), false);
        assert_eq!(v.order.iter().filter(|&&f| f == 10).count(), 1);
    }

    #[test]
    fn contains_bytes_basics() {        assert!(contains_bytes(b"hello world", b""));
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

    /// Query-latency budget at real index scale (~680k nodes): the service is
    /// asked per keystroke, so a search must stay in the low tens of
    /// milliseconds. Prints per-query timings; the assertion is deliberately
    /// loose (10× the release budget) so a debug build only trips it on a real
    /// algorithmic regression. Run with `--ignored --nocapture`.
    #[test]
    #[ignore]
    fn perf_search_at_real_scale() {
        use std::time::Instant;
        let mut v = vol();
        // ~680k nodes, names of realistic length (8-28 bytes), mixed case and
        // a few thousand CJK ones -- the shape the real index has.
        let mut parent = 5u64;
        for i in 0..680_000u64 {
            let frn = i + 100;
            if i % 500 == 0 {
                parent = 5; // keep a shallow tree so paths resolve in a few hops
            }
            let name = match i % 7 {
                0 => format!("document-{i}.pdf"),
                1 => format!("Report_{i}.docx"),
                2 => format!("image_{i}.png"),
                3 => format!("main{i}.rs"),
                4 => format!("设置指南{i}.pdf"),
                5 => format!("notes-{i}.txt"),
                _ => format!("cache{i}.tmp"),
            };
            upsert(&mut v, frn, parent, &name_u16(&name), i % 11 == 0);
            if i % 11 == 0 {
                parent = frn;
            }
        }
        eprintln!("index: {} nodes", v.map.len());
        let engine = Engine {
            inner: Mutex::new(Inner {
                state: State::Ready,
                volumes: vec![v],
                generation: 1,
            }),
        };
        for (q, max) in [("pptx", 50), ("a", 50), ("e", 50), ("doc", 50), ("main", 12)] {
            // One warm-up (page-in), then the measured run.
            let _ = engine.search(q, max);
            let t = Instant::now();
            let (_, hits) = engine.search(q, max);
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            eprintln!("search {q:>6} max={max}: {ms:.1}ms ({} hits)", hits.len());
            assert!(ms < 400.0, "search {q} took {ms:.1}ms");
        }
    }
}
