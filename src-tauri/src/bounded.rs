//! Shared input boundaries for file and base64 payloads.
//!
//! Every caller checks an encoded/on-disk size before allocating the output.
//! The read path still streams through a hard cap so a file that grows after
//! metadata inspection cannot bypass the limit.

use base64::Engine;
use std::fs::File;
use std::io::Read;
use std::path::Path;

/// Conservative maximum length of standard (padded) base64 for `decoded`.
/// Four-byte blocks plus one block of slack for optional whitespace/padding.
pub fn max_base64_chars(decoded: usize) -> usize {
    decoded.saturating_add(2) / 3 * 4 + 4
}

/// Decode standard base64 after an encoded-size preflight and re-check the
/// decoded byte count.
pub fn decode_base64_bounded(encoded: &str, max_decoded: usize) -> Result<Vec<u8>, String> {
    let encoded = encoded.trim();
    if encoded.is_empty() {
        return Err("empty base64 payload".into());
    }
    if encoded.len() > max_base64_chars(max_decoded) {
        return Err(format!(
            "encoded payload too large: {} chars (cap {})",
            encoded.len(),
            max_base64_chars(max_decoded)
        ));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|e| format!("bad base64: {e}"))?;
    if bytes.len() > max_decoded {
        return Err(format!(
            "decoded payload too large: {} bytes (cap {max_decoded})",
            bytes.len()
        ));
    }
    Ok(bytes)
}

/// Read a file with a metadata preflight and a hard streaming cap.
pub fn read_file_bounded(path: &Path, max_bytes: usize) -> Result<Vec<u8>, String> {
    let file = File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|e| format!("metadata {}: {e}", path.display()))?
        .len();
    if len > max_bytes as u64 {
        return Err(format!(
            "file too large: {len} bytes (cap {max_bytes})"
        ));
    }
    let cap = (max_bytes as u64).saturating_add(1);
    let mut bytes = Vec::with_capacity(len.min(cap) as usize);
    file.take(cap)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    if bytes.len() > max_bytes {
        return Err(format!(
            "file too large: at least {} bytes (cap {max_bytes})",
            bytes.len()
        ));
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn base64_limit_is_checked_before_decode() {
        let oversized = "A".repeat(max_base64_chars(8) + 1);
        let err = decode_base64_bounded(&oversized, 8).unwrap_err();
        assert!(err.contains("encoded payload too large"), "{err}");
        assert_eq!(decode_base64_bounded("aGVsbG8=", 8).unwrap(), b"hello");
    }

    #[test]
    fn file_reader_checks_metadata_and_stream_cap() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "lume-bounded-{}-{nonce}.bin",
            std::process::id()
        ));
        let mut file = File::create(&path).unwrap();
        file.write_all(b"123456789").unwrap();
        drop(file);
        let err = read_file_bounded(&path, 8).unwrap_err();
        assert!(err.contains("too large"), "{err}");
        assert_eq!(read_file_bounded(&path, 9).unwrap(), b"123456789");
        let _ = std::fs::remove_file(path);
    }
}
