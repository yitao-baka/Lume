//! `.lupx` 签名与验签（#32.2，ROADMAP）—— ed25519，零在线依赖。
//!
//! 包内可选条目 `LUME.SIGN`（JSON 文本）：
//!
//! ```json
//! { "v": 1, "algo": "ed25519", "key": "<b64 公钥>", "sig": "<b64 签名>",
//!   "files": ["<相对路径>:<hex sha256>", …按名排序] }
//! ```
//!
//! 被签内容 = 确定性拼接：`u64 LE 清单字节数 ‖ 清单字节 ‖ 逐文件 "名\0哈希\0"`。
//! 验签时重新计算全部条目哈希并与 `files` 清单精确比对——任何一处改动
//! （含清单）都会导致验签失败。
//!
//! 信任根：`RELEASE_PUBKEY_B64`（发行时填入；为空表示尚未配置发行密钥）+
//! `<base>/settings/trust-keys/*.pub`（每文件一个 b64 公钥，用户放文件即
//! 导入，无 UI）。签名无效的包**硬拒**（inspect 报错、install 不可达）；
//! 未签名的包维持现有确认流，确认卡展示整体 SHA256。
//!
//! CLI（`lume.exe --gen-key` / `--sign-lupx <path> --key <file>`，main.rs
//! 分发，不建窗口）：签名工具与宿主同源，避免再维护一套打包脚本。

use base64::Engine;
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use zip::ZipArchive;

/// The signature entry name inside a `.lupx` archive.
pub const SIGN_ENTRY: &str = "LUME.SIGN";

/// Release signing key (base64 ed25519 public key). Filled in at release
/// packaging time; empty = only `<base>/settings/trust-keys/` grants validity.
pub const RELEASE_PUBKEY_B64: &str = "";

/// One file in the signed list: relative normalized path + content hash.
pub type FileHash = (String, [u8; 32]);

/// The canonical byte string the signature covers.
pub fn signed_payload(manifest_bytes: &[u8], files: &[FileHash]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&(manifest_bytes.len() as u64).to_le_bytes());
    out.extend_from_slice(manifest_bytes);
    for (name, hash) in files {
        out.extend_from_slice(name.as_bytes());
        out.push(0);
        out.extend_from_slice(&hash[..]);
        out.push(0);
    }
    out
}

#[derive(serde::Deserialize)]
struct SignBlob {
    v: u32,
    algo: String,
    key: String,
    sig: String,
    files: Vec<String>,
}

/// Build the `LUME.SIGN` text for an archive (used by the signing CLI).
pub fn build_sign_blob(manifest_bytes: &[u8], files: &[FileHash], key: &SigningKey) -> String {
    let payload = signed_payload(manifest_bytes, files);
    let sig = key.sign(&payload).to_bytes();
    let mut files_json: Vec<String> = files
        .iter()
        .map(|(name, hash)| format!("\"{}:{}\"", name, hex(hash)))
        .collect();
    files_json.sort();
    format!(
        "{{\"v\":1,\"algo\":\"ed25519\",\"key\":\"{}\",\"sig\":\"{}\",\"files\":[{}]}}",
        base64::engine::general_purpose::STANDARD.encode(key.verifying_key().to_bytes()),
        base64::engine::general_purpose::STANDARD.encode(sig),
        files_json.join(",")
    )
}

/// Verify a `LUME.SIGN` blob against the archive's manifest bytes + computed
/// file hashes. `trust` = the accepted public keys. Every mismatch is an
/// error with a reason (the caller hard-fails the whole inspect/install).
pub fn verify_sign_blob(
    blob_text: &str,
    manifest_bytes: &[u8],
    files: &[FileHash],
    trust: &[VerifyingKey],
) -> Result<(), String> {
    let blob: SignBlob = serde_json::from_str(blob_text)
        .map_err(|e| format!("LUME.SIGN is not a valid signature blob: {e}"))?;
    if blob.v != 1 {
        return Err(format!("unsupported LUME.SIGN version {}", blob.v));
    }
    if blob.algo != "ed25519" {
        return Err(format!("unsupported signature algorithm \"{}\"", blob.algo));
    }
    let key = parse_pubkey_b64(&blob.key)?;
    if !trust.iter().any(|k| k == &key) {
        return Err("signature key is not trusted (not the release key, not in settings/trust-keys/)".into());
    }
    // The signed file list must match the archive exactly: same set, same
    // hashes. Names here are the signer's normalized relative paths.
    if blob.files.len() != files.len() {
        return Err(format!(
            "signature lists {} file(s) but the archive holds {}",
            blob.files.len(),
            files.len()
        ));
    }
    let mut declared = blob.files.clone();
    declared.sort();
    for (name, hash) in files {
        let expected = format!("{name}:{}", hex(hash));
        if !declared.contains(&expected) {
            return Err(format!("file \"{name}\" does not match the signed list"));
        }
    }
    let sig_bytes = base64::engine::general_purpose::STANDARD
        .decode(blob.sig.trim())
        .map_err(|e| format!("bad signature encoding: {e}"))?;
    let sig = Signature::from_slice(&sig_bytes)
        .map_err(|e| format!("bad signature: {e}"))?;
    key.verify(&signed_payload(manifest_bytes, files), &sig)
        .map_err(|_| "ed25519 signature verification failed (archive is modified or corrupt)".into())
}

/// Decode one base64 ed25519 public key (32 raw bytes).
pub fn parse_pubkey_b64(b64: &str) -> Result<VerifyingKey, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|e| format!("bad public key encoding: {e}"))?;
    let n = raw.len();
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| format!("public key must be 32 bytes, got {n}"))?;
    VerifyingKey::from_bytes(&bytes).map_err(|e| format!("bad public key: {e}"))
}

/// Decode one base64 ed25519 secret seed (32 raw bytes) from a key file.
pub fn parse_seed_b64(text: &str) -> Result<SigningKey, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(text.trim())
        .map_err(|e| format!("bad key encoding: {e}"))?;
    let n = raw.len();
    let bytes: [u8; 32] = raw
        .try_into()
        .map_err(|_| format!("signing key must be 32 bytes, got {n}"))?;
    Ok(SigningKey::from_bytes(&bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of a stream (used for whole-archive hash on the confirm card).
pub fn sha256_reader(mut r: impl std::io::Read) -> std::io::Result<[u8; 32]> {
    let mut h = Sha256::new();
    std::io::copy(&mut r, &mut h)?;
    Ok(h.finalize().into())
}

// ── CLI ──

/// `lume --gen-key [out-dir]` / `lume --sign-lupx <path> --key <file>`.
/// `Some(code)` = the args were CLI commands (caller exits); `None` = normal
/// app launch. Private keys never leave the operator's machine.
pub fn run_cli(args: &[String]) -> Option<i32> {
    match args.first().map(String::as_str) {
        Some("--gen-key") => Some(gen_key(args.get(1).map(String::as_str))),
        Some("--sign-lupx") => Some(sign_lupx_cli(args)),
        _ => None,
    }
}

fn gen_key(out_dir: Option<&str>) -> i32 {
    let dir = std::path::PathBuf::from(out_dir.unwrap_or("."));
    let mut seed = [0u8; 32];
    if getrandom::getrandom(&mut seed).is_err() {
        eprintln!("error: no OS entropy available");
        return 1;
    }
    let key = SigningKey::from_bytes(&seed);
    let key_path = dir.join("lume-signing.key");
    let pub_path = dir.join("lume-signing.key.pub");
    let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
    if let Err(e) = std::fs::write(&key_path, b64(&seed)) {
        eprintln!("error: cannot write {}: {e}", key_path.display());
        return 1;
    }
    if let Err(e) = std::fs::write(&pub_path, b64(&key.verifying_key().to_bytes())) {
        eprintln!("error: cannot write {}: {e}", pub_path.display());
        return 1;
    }
    println!("signing key:    {}", key_path.display());
    println!("public key:     {}", pub_path.display());
    println!("public key b64: {}", b64(&key.verifying_key().to_bytes()));
    println!();
    println!("Distribute the .pub file; keep the .key file PRIVATE.");
    println!("Users install your key by copying it to <base>/settings/trust-keys/ (any name).");
    println!("Sign a package:  lume --sign-lupx <path.lupx> --key lume-signing.key");
    0
}

fn sign_lupx_cli(args: &[String]) -> i32 {
    let mut path: Option<&String> = None;
    let mut key_path: Option<&String> = None;
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--key" if i + 1 < args.len() => {
                key_path = Some(&args[i + 1]);
                i += 2;
            }
            other => {
                path = Some(&args[i]);
                i += 1;
                let _ = other;
            }
        }
    }
    let (Some(path), Some(key_path)) = (path, key_path) else {
        eprintln!("usage: lume --sign-lupx <path.lupx> --key <lume-signing.key>");
        return 2;
    };
    let Ok(key_text) = std::fs::read_to_string(key_path) else {
        eprintln!("error: cannot read key file {key_path}");
        return 1;
    };
    let key = match parse_seed_b64(&key_text) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    match sign_archive(std::path::Path::new(path), &key) {
        Ok((files, blob)) => {
            println!("signed {path}: {} file(s)", files);
            println!("LUME.SIGN: {blob}");
            0
        }
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

/// (Re)write `<archive>` in place with a fresh `LUME.SIGN` entry. The archive
/// is rebuilt entry-by-entry into a sibling temp file, then renamed over the
/// original — a failed sign leaves the original untouched.
pub fn sign_archive(path: &std::path::Path, key: &SigningKey) -> Result<(usize, String), String> {
    use std::io::Read;
    let file = std::fs::File::open(path).map_err(|e| format!("cannot open archive: {e}"))?;
    let mut zip = ZipArchive::new(file).map_err(|e| format!("not a readable zip archive: {e}"))?;

    // Collect entry bytes + hashes; locate the manifest like read_lupx does.
    struct Item {
        raw: String,
        normalized: String,
        bytes: Vec<u8>,
        #[allow(dead_code)]
        size: u64,
    }
    let mut items: Vec<Item> = Vec::with_capacity(zip.len());
    let mut manifest_raw: Option<String> = None;
    let mut file_count = 0usize;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i).map_err(|e| format!("archive entry {i}: {e}"))?;
        let raw = entry.name().to_string();
        let normalized = crate::plugin_install::normalize_entry(&raw)?;
        if normalized.is_empty() || entry.is_dir() {
            continue;
        }
        if normalized.eq_ignore_ascii_case(SIGN_ENTRY) {
            continue; // replaced on every sign
        }
        let mut bytes = Vec::new();
        entry
            .read_to_end(&mut bytes)
            .map_err(|e| format!("read \"{raw}\": {e}"))?;
        let is_manifest = normalized == "plugin.toml"
            || normalized.ends_with("/plugin.toml");
        if is_manifest && manifest_raw.is_none() {
            manifest_raw = Some(raw.clone());
        }
        file_count += 1;
        items.push(Item {
            raw,
            normalized,
            size: bytes.len() as u64,
            bytes,
        });
    }
    let Some(manifest_raw) = manifest_raw else {
        return Err("no plugin.toml in the archive — not a .lupx".into());
    };
    let manifest_item = items
        .iter()
        .find(|it| it.raw == manifest_raw)
        .ok_or("manifest vanished")?;
    let prefix = if manifest_item.normalized == "plugin.toml" {
        String::new()
    } else {
        let n = &manifest_item.normalized;
        format!("{}/", &n[..n.len() - "/plugin.toml".len()])
    };
    // Signed names = normalized paths relative to the manifest's prefix
    // (everything except the manifest itself; LUME.SIGN was already skipped
    // and is rebuilt here). Sorted deterministically.
    let mut files: Vec<FileHash> = items
        .iter()
        .filter(|it| it.normalized != manifest_item.normalized)
        .filter(|it| prefix.is_empty() || it.normalized.starts_with(&prefix))
        .map(|it| {
            let rel = if prefix.is_empty() {
                it.normalized.clone()
            } else {
                it.normalized[prefix.len()..].to_string()
            };
            let mut h = Sha256::new();
            h.update(&it.bytes);
            (rel, h.finalize().into())
        })
        .collect();
    let manifest_bytes = manifest_item.bytes.clone();
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let blob = build_sign_blob(&manifest_bytes, &files, key);

    // Rebuild into a temp file, then swap.
    let tmp = path.with_extension("lupx-signing-tmp");
    let out_file =
        std::fs::File::create(&tmp).map_err(|e| format!("create temp archive: {e}"))?;
    let mut out = zip::ZipWriter::new(out_file);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for it in &items {
        out.start_file(it.raw.as_str(), options)
            .map_err(|e| format!("zip start_file \"{}\": {e}", it.raw))?;
        std::io::Write::write_all(&mut out, &it.bytes)
            .map_err(|e| format!("zip write \"{}\": {e}", it.raw))?;
    }
    out.start_file(SIGN_ENTRY, options)
        .map_err(|e| format!("zip start_file {SIGN_ENTRY}: {e}"))?;
    std::io::Write::write_all(&mut out, blob.as_bytes())
        .map_err(|e| format!("zip write {SIGN_ENTRY}: {e}"))?;
    out.finish().map_err(|e| format!("zip finish: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("replace archive: {e}"))?;
    Ok((file_count, blob))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_key() -> SigningKey {
        parse_seed_b64(&base64::engine::general_purpose::STANDARD.encode([7u8; 32])).unwrap()
    }

    #[test]
    fn sign_verify_round_trip() {
        let key = test_key();
        let manifest = b"id = \"demo\"\n";
        let files = vec![
            ("main.js".to_string(), {
                let mut h = Sha256::new();
                h.update(b"console.log(1)");
                h.finalize().into()
            }),
        ];
        let blob = build_sign_blob(manifest, &files, &key);
        let trust = vec![key.verifying_key()];
        verify_sign_blob(&blob, manifest, &files, &trust).expect("valid signature must pass");
    }

    #[test]
    fn tampered_payload_is_refused() {
        let key = test_key();
        let manifest = b"id = \"demo\"\n";
        let files = vec![("main.js".to_string(), [0u8; 32])];
        let blob = build_sign_blob(manifest, &files, &key);
        let trust = vec![key.verifying_key()];
        // One flipped hash byte = modified archive.
        let files2 = vec![("main.js".to_string(), [1u8; 32])];
        assert!(verify_sign_blob(&blob, manifest, &files2, &trust).is_err());
        // Modified manifest.
        assert!(verify_sign_blob(&blob, b"id = \"demo2\"\n", &files, &trust).is_err());
        // Untrusted key (different signer).
        let other = parse_seed_b64(&base64::engine::general_purpose::STANDARD.encode([9u8; 32]))
            .unwrap();
        assert!(verify_sign_blob(&blob, manifest, &files, &[other.verifying_key()]).is_err());
        // File list mismatch.
        assert!(verify_sign_blob(&blob, manifest, &[], &trust).is_err());
    }
}
