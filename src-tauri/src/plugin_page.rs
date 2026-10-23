//! Page Service → Host Runtime channel.
//!
//! The logic-host supervisor forwards only the service token here. Rust checks
//! the role, validates the runtime/schema/revision and the 1 MiB cap, then emits
//! the snapshot to the launcher. A Presenter never receives this token.

use serde_json::Value;
use tauri::{AppHandle, Emitter, State};

use crate::plugin_perm::{resolve_plugin_caller_role, PluginPermState};

pub const MAX_PAGE_MODEL_BYTES: usize = 1024 * 1024;

fn service_owner(token: &str, window: &tauri::WebviewWindow, perms: &PluginPermState) -> Result<String, String> {
    let (id, role) = resolve_plugin_caller_role(perms, window, None, Some(token))?;
    let id = id.ok_or_else(|| "page event requires a plugin owner".to_string())?;
    if role != "service" {
        return Err("permission denied: Page Model events are service-only".into());
    }
    Ok(id)
}

fn validate_model(model: &Value) -> Result<usize, String> {
    let obj = model.as_object().ok_or_else(|| "Page Model must be an object".to_string())?;
    if obj.get("runtime").and_then(Value::as_str) != Some("lume.page/v1") {
        return Err("Page Model runtime must be lume.page/v1".into());
    }
    let schema = obj.get("schema").and_then(Value::as_str).unwrap_or_default();
    if schema.is_empty() || schema.len() > 128 {
        return Err("Page Model schema is required (<=128 chars)".into());
    }
    let revision = obj.get("revision").and_then(Value::as_u64).unwrap_or(0);
    if revision == 0 {
        return Err("Page Model revision must be positive".into());
    }
    let status = obj.get("status").and_then(Value::as_str).unwrap_or_default();
    if !matches!(status, "loading" | "ready" | "empty" | "error") {
        return Err("Page Model status is invalid".into());
    }
    let bytes = serde_json::to_vec(model)
        .map_err(|e| format!("serialize Page Model: {e}"))?
        .len();
    if bytes > MAX_PAGE_MODEL_BYTES {
        return Err(format!("Page Model is {bytes} bytes; limit is {MAX_PAGE_MODEL_BYTES}"));
    }
    Ok(bytes)
}

#[tauri::command]
pub fn plugin_page_publish(
    token: String,
    model: Value,
    window: tauri::WebviewWindow,
    perms: State<'_, PluginPermState>,
    app: AppHandle,
) -> Result<(), String> {
    let id = service_owner(&token, &window, &perms)?;
    let bytes = validate_model(&model)?;
    app.emit_to(
        "main",
        "plugin-page-model",
        serde_json::json!({ "id": id, "model": model, "bytes": bytes }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_page_emit(
    token: String,
    event: Value,
    window: tauri::WebviewWindow,
    perms: State<'_, PluginPermState>,
    app: AppHandle,
) -> Result<(), String> {
    let id = service_owner(&token, &window, &perms)?;
    let bytes = serde_json::to_vec(&event)
        .map_err(|e| format!("serialize Page Event: {e}"))?
        .len();
    if bytes > 256 * 1024 {
        return Err("Page Event exceeds 256 KiB".into());
    }
    app.emit_to(
        "main",
        "plugin-page-event",
        serde_json::json!({ "id": id, "event": event }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_page_error(
    token: String,
    error: Value,
    window: tauri::WebviewWindow,
    perms: State<'_, PluginPermState>,
    app: AppHandle,
) -> Result<(), String> {
    let id = service_owner(&token, &window, &perms)?;
    let bytes = serde_json::to_vec(&error)
        .map_err(|e| format!("serialize Page error: {e}"))?
        .len();
    if bytes > 64 * 1024 {
        return Err("Page error exceeds 64 KiB".into());
    }
    app.emit_to(
        "main",
        "plugin-page-error",
        serde_json::json!({ "id": id, "error": error }),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_page_clear_error(
    token: String,
    window: tauri::WebviewWindow,
    perms: State<'_, PluginPermState>,
    app: AppHandle,
) -> Result<(), String> {
    let id = service_owner(&token, &window, &perms)?;
    app.emit_to("main", "plugin-page-clear-error", serde_json::json!({ "id": id }))
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn valid() -> Value {
        serde_json::json!({
            "runtime": "lume.page/v1",
            "schema": "demo/v1",
            "revision": 1,
            "status": "ready",
            "data": {}
        })
    }

    #[test]
    fn model_gate_checks_runtime_schema_revision_and_size() {
        assert!(validate_model(&valid()).is_ok());
        let mut wrong = valid();
        wrong["runtime"] = "lume.page/v0".into();
        assert!(validate_model(&wrong).unwrap_err().contains("runtime"));
        let mut zero = valid();
        zero["revision"] = 0.into();
        assert!(validate_model(&zero).unwrap_err().contains("revision"));
        let mut huge = valid();
        huge["data"] = serde_json::json!({ "text": "x".repeat(MAX_PAGE_MODEL_BYTES) });
        assert!(validate_model(&huge).unwrap_err().contains("limit"));
    }
}
