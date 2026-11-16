//! Service-only plugin secrets backed by Windows Credential Manager.
//! Values never enter settings.toml, plugin_store.db, Page Models, events,
//! snapshots or logs. The settings window may write/clear a declared slot;
//! only a Page Service role token may read it.

use std::path::Path;

use serde::Serialize;
use tauri::State;

use crate::paths::base_dir;
use crate::plugin_perm::PluginPermState;
use crate::plugins::{manifest_for_id, valid_plugin_id};

#[derive(Debug, Clone, Serialize)]
pub struct SecretStatus {
    pub set: bool,
}

fn validate_key(key: &str) -> Result<(), String> {
    if !valid_plugin_id(key) || key.len() > 64 {
        return Err(format!("invalid secret key \"{key}\""));
    }
    Ok(())
}

fn target_name(id: &str, key: &str) -> Result<String, String> {
    if !valid_plugin_id(id) {
        return Err(format!("invalid plugin id \"{id}\""));
    }
    validate_key(key)?;
    Ok(format!("Lume.Plugin.{id}.{key}"))
}

fn is_lume_secret_target(target: &str) -> bool {
    target.starts_with("Lume.Plugin.")
}

fn declared_secret(base: &Path, id: &str, key: &str) -> Result<(), String> {
    validate_key(key)?;
    let manifest = manifest_for_id(base, id)
        .ok_or_else(|| format!("unknown plugin \"{id}\""))?;
    crate::plugins::validate_manifest(&manifest)
        .map_err(|e| format!("plugin \"{id}\" rejected: {e}"))?;
    if !manifest.permissions.iter().any(|p| p == "secrets") {
        return Err("manifest does not declare the secrets permission".into());
    }
    if !manifest.secrets.iter().any(|s| s.key == key) {
        return Err(format!("secret \"{key}\" is not declared by plugin \"{id}\""));
    }
    Ok(())
}

fn settings_only(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "settings" {
        return Err("plugin secrets can only be changed from the settings window".into());
    }
    Ok(())
}


fn service_caller(
    token: &str,
    window: &tauri::WebviewWindow,
    perms: &PluginPermState,
) -> Result<String, String> {
    let (id, role) = crate::plugin_perm::resolve_plugin_caller_role(
        perms,
        window,
        None,
        Some(token),
    )?;
    let id = id.ok_or_else(|| "secret read requires a plugin owner".to_string())?;
    if role != "service" {
        return Err("permission denied: secrets are service-only".into());
    }
    Ok(id)
}

#[tauri::command]
pub fn plugin_secret_status(
    id: String,
    key: String,
    window: tauri::WebviewWindow,
) -> Result<SecretStatus, String> {
    settings_only(&window)?;
    declared_secret(&base_dir(), &id, &key)?;
    Ok(SecretStatus {
        set: read_secret(&target_name(&id, &key)?)?.is_some(),
    })
}

#[tauri::command]
pub fn plugin_secret_set(
    id: String,
    key: String,
    value: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    settings_only(&window)?;
    if value.is_empty() || value.len() > 4096 {
        return Err("secret value must be 1..=4096 bytes".into());
    }
    declared_secret(&base_dir(), &id, &key)?;
    write_secret(&target_name(&id, &key)?, &key, &value)
}

#[tauri::command]
pub fn plugin_secret_clear(
    id: String,
    key: String,
    window: tauri::WebviewWindow,
) -> Result<(), String> {
    settings_only(&window)?;
    declared_secret(&base_dir(), &id, &key)?;
    delete_secret(&target_name(&id, &key)?)
}

#[tauri::command]
pub fn plugin_secret_service_has(
    token: String,
    key: String,
    window: tauri::WebviewWindow,
    perms: State<'_, PluginPermState>,
) -> Result<bool, String> {
    let id = service_caller(&token, &window, &perms)?;
    declared_secret(&base_dir(), &id, &key)?;
    Ok(read_secret(&target_name(&id, &key)?)?.is_some())
}

#[tauri::command]
pub fn plugin_secret_service_get(
    token: String,
    key: String,
    window: tauri::WebviewWindow,
    perms: State<'_, PluginPermState>,
) -> Result<Option<String>, String> {
    let id = service_caller(&token, &window, &perms)?;
    declared_secret(&base_dir(), &id, &key)?;
    read_secret(&target_name(&id, &key)?)
}

#[cfg(windows)]
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn read_secret(target: &str) -> Result<Option<String>, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{CredFree, CredReadW, CRED_TYPE_GENERIC};

    let target = wide(target);
    let mut ptr = std::ptr::null_mut();
    let ok = unsafe { CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, Some(0), &mut ptr) };
    if let Err(error) = ok {
        if error.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(None);
        }
        return Err(format!("credential read failed: {error}"));
    }
    if ptr.is_null() {
        return Err("credential read returned no data".into());
    }
    let blob = unsafe {
        let credential = &*ptr;
        let bytes = std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        )
        .to_vec();
        CredFree(ptr as *const core::ffi::c_void);
        bytes
    };
    String::from_utf8(blob)
        .map(Some)
        .map_err(|_| "stored secret is not UTF-8".to_string())
}

#[cfg(windows)]
fn write_secret(target: &str, account: &str, value: &str) -> Result<(), String> {
    use windows::core::PWSTR;
    use windows::Win32::Security::Credentials::{
        CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    let mut target = wide(target);
    let mut account = wide(account);
    let mut blob = value.as_bytes().to_vec();
    let credential = CREDENTIALW {
        Flags: Default::default(),
        Type: CRED_TYPE_GENERIC,
        TargetName: PWSTR(target.as_mut_ptr()),
        Comment: PWSTR::null(),
        LastWritten: Default::default(),
        CredentialBlobSize: blob.len() as u32,
        CredentialBlob: blob.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: PWSTR::null(),
        UserName: PWSTR(account.as_mut_ptr()),
    };
    unsafe { CredWriteW(&credential, 0) }.map_err(|e| format!("credential write failed: {e}"))
}

#[cfg(windows)]
fn delete_secret(target: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{CredDeleteW, CRED_TYPE_GENERIC};

    let target = wide(target);
    let result = unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, Some(0)) };
    if let Err(error) = result {
        if error.code() != ERROR_NOT_FOUND.to_hresult() {
            return Err(format!("credential delete failed: {error}"));
        }
    }
    Ok(())
}

/// Remove every Lume plugin credential in the current user's vault.
///
/// The elevated uninstaller runs under the same Windows identity (a split UAC
/// token), so this only touches that user's Credential Manager entries. All
/// matching targets are attempted; failures are returned together.
#[cfg(windows)]
pub(crate) fn purge_plugin_secrets() -> Result<usize, String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_NOT_FOUND;
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredEnumerateW, CredFree, CREDENTIALW,
    };

    const FILTER: &str = "Lume.Plugin.*";

    let filter = wide(FILTER);
    let mut count = 0u32;
    let mut credentials: *mut *mut CREDENTIALW = std::ptr::null_mut();
    let listed = unsafe {
        CredEnumerateW(
            PCWSTR(filter.as_ptr()),
            None,
            &mut count,
            &mut credentials,
        )
    };
    if let Err(error) = listed {
        if error.code() == ERROR_NOT_FOUND.to_hresult() {
            return Ok(0);
        }
        return Err(format!("credential enumeration failed: {error}"));
    }

    if count == 0 || credentials.is_null() {
        if !credentials.is_null() {
            unsafe { CredFree(credentials as *const std::ffi::c_void) };
        }
        return Ok(0);
    }

    let entries = unsafe { std::slice::from_raw_parts(credentials, count as usize) };
    let mut targets = Vec::new();
    let mut errors = Vec::new();
    for credential in entries {
        let credential = unsafe { &**credential };
        if credential.TargetName.is_null() {
            continue;
        }
        match unsafe { credential.TargetName.to_string() } {
            Ok(target) if is_lume_secret_target(&target) => targets.push((target, credential.Type)),
            Ok(_) => {}
            Err(error) => errors.push(format!("credential target decode failed: {error}")),
        }
    }
    unsafe { CredFree(credentials as *const std::ffi::c_void) };

    let mut deleted = 0usize;
    for (target, credential_type) in targets {
        let target_wide = wide(&target);
        match unsafe { CredDeleteW(PCWSTR(target_wide.as_ptr()), credential_type, Some(0)) } {
            Ok(()) => deleted += 1,
            Err(error) => errors.push(format!("{target}: {error}")),
        }
    }
    if errors.is_empty() {
        Ok(deleted)
    } else {
        Err(errors.join("; "))
    }
}

#[cfg(not(windows))]
pub(crate) fn purge_plugin_secrets() -> Result<usize, String> {
    Err("plugin credentials require Windows Credential Manager".into())
}

#[cfg(not(windows))]
fn read_secret(_target: &str) -> Result<Option<String>, String> {
    Err("plugin secrets require Windows Credential Manager".into())
}

#[cfg(not(windows))]
fn write_secret(_target: &str, _account: &str, _value: &str) -> Result<(), String> {
    Err("plugin secrets require Windows Credential Manager".into())
}

#[cfg(not(windows))]
fn delete_secret(_target: &str) -> Result<(), String> {
    Err("plugin secrets require Windows Credential Manager".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_and_targets_are_strict() {
        assert_eq!(
            target_name("translation-demo", "api_key").unwrap(),
            "Lume.Plugin.translation-demo.api_key"
        );
        assert!(is_lume_secret_target("Lume.Plugin.translation-demo.api_key"));
        assert!(!is_lume_secret_target("Other.Lume.Plugin.key"));
        assert!(target_name("translation-demo", "../key").is_err());
        assert!(target_name("../plugin", "api_key").is_err());
    }
}
