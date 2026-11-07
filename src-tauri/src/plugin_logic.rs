//! 共享插件逻辑宿主窗口（进程隔离）。
//!
//! 一个隐藏窗口（label `plugin-logic-host`，页面 `pluginLogic.html`）承载
//! **所有**声明 `entry` 的磁盘插件的逻辑：每个插件一个 opaque-origin 沙箱
//! iframe（WebView2 站点隔离 → 各自独立 renderer 进程），supervisor 页负责
//! 建帧、发令牌、转发 hook 调用与 ctx RPC。插件代码从此不进入任何含
//! `__TAURI_INTERNALS__` 的可信 realm（iframe 里虽然也有注入脚本，但每一次
//! 调用都受 `plugin_perm::resolve_plugin_caller` 的 label+令牌归属强制）。
//!
//! 通信拓扑：
//! - 启动器 → 宿主：`plugin_logic_push`（label 门控 main）→ emit
//!   `plugin-logic-event`（kind = load / unload / event / hook）；
//! - 宿主 → 启动器：`plugin_logic_action`（ctx 的 app.* 动作 + 生命周期
//!   通告）与 `plugin_logic_result`（hook 调用回执）——两者都带
//!   `host_token`，Rust 按令牌→id 强制归属后 emit 到 main；
//! - iframe ↔ supervisor：窗口内 postMessage（`__lumeRpc` /
//!   `__lumeCall` / `__lumeEvent`，与视图桥同族协议）。
//!
//! 窗口崩了（WebView2 renderer 崩溃等）→ `Destroyed` → 通知 main，注册表
//! 负责整窗重建并重载全部逻辑。

use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::paths::base_dir;
use crate::plugin_perm::{resolve_plugin_caller, resolve_plugin_caller_role, LOGIC_HOST_LABEL};
use crate::settings::{self, SettingsState};

const MAX_PLUGIN_SOURCE_BYTES: u64 = 8 * 1024 * 1024;

/// Create (or report the existing) shared logic host window. Hidden 1×1,
/// skip-taskbar — never shown. **Async command**: window creation must leave
/// the main thread free (same deadlock note as `plugin_window_open`).
#[tauri::command]
pub async fn plugin_logic_host_ensure(
    app: AppHandle,
    state: State<'_, SettingsState>,
    window: tauri::WebviewWindow,
) -> Result<String, String> {
    if window.label() != "main" {
        return Err("plugin_logic_host_ensure: launcher window only".into());
    }
    if let Some(_win) = app.get_webview_window(LOGIC_HOST_LABEL) {
        return Ok("exists".into());
    }
    let snapshot = settings::snapshot(&state);
    let config_json = serde_json::to_string(&snapshot).unwrap_or_else(|_| "{}".into());
    let builder = WebviewWindowBuilder::new(
        &app,
        LOGIC_HOST_LABEL,
        WebviewUrl::App("pluginLogic.html".into()),
    )
    .title("Lume plugin logic host")
    .inner_size(1.0, 1.0)
    .resizable(false)
    .decorations(false)
    .skip_taskbar(true)
    .focused(false)
    .visible(false)
    .initialization_script(format!("window.__LUME_CONFIG__ = {config_json};"));
    let win = builder.build().map_err(|e| e.to_string())?;
    crate::webview_guard::install(&win);
    // The hidden 1x1 host must be controller-invisible as well as HWND-hidden;
    // otherwise its supervisor page keeps the browser treating it as visible.
    crate::window::set_webview_resource_state(&app, LOGIC_HOST_LABEL, false, true);
    let app2 = app.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let _ = app2.emit_to("main", "plugin-logic-host-closed", ());
        }
    });
    Ok("opened".into())
}

/// Destroy the shared logic host window (teardown / tests; normal unload
/// removes per-plugin iframes inside the window instead).
#[tauri::command]
pub fn plugin_logic_host_close(app: AppHandle, window: tauri::WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("plugin_logic_host_close: launcher window only".into());
    }
    if let Some(win) = app.get_webview_window(LOGIC_HOST_LABEL) {
        let _ = win.close();
    }
    Ok(())
}

/// The manifest fields one plugin's logic needs (dir + entry + display name).
/// Served to the shared host window only.
#[tauri::command]
pub fn plugin_logic_meta(
    id: String,
    window: tauri::WebviewWindow,
) -> Result<serde_json::Value, String> {
    if window.label() != LOGIC_HOST_LABEL {
        return Err("plugin_logic_meta: wrong window".into());
    }
    let manifests = crate::plugins::list_plugins(&base_dir(), &[], &[], false);
    let m = manifests
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown plugin \"{id}\""))?;
    if let Some(reason) = &m.api_error {
        return Err(format!("plugin \"{id}\" was rejected: {reason}"));
    }
    // `service` is reserved for an api-2 Page Service mode. Provider/service
    // plugins and legacy modes keep the general logic role; Rust page/secrets
    // commands reject them even if the frame crafts the RPC directly.
    let role = if m.kind == "mode" && m.page_runtime && !m.presenters.is_empty() {
        "service"
    } else {
        "logic"
    };
    Ok(serde_json::json!({
        "dir": m.dir,
        "entry": m.entry,
        "name": m.name,
        "api": m.api,
        "role": role,
    }))
}

/// Read one plugin source/module file for the shared logic supervisor. The
/// caller's host token fixes the plugin identity; both the plugin root and the
/// requested file are canonicalized so `..` segments and symlink/junction
/// escapes cannot read another plugin or arbitrary disk content.
#[tauri::command]
pub async fn plugin_logic_read_file(
    id: String,
    token: String,
    path: String,
    window: tauri::WebviewWindow,
    perms: State<'_, crate::plugin_perm::PluginPermState>,
) -> Result<String, String> {
    if window.label() != LOGIC_HOST_LABEL {
        return Err("plugin_logic_read_file: logic host window only".into());
    }
    let (resolved, _) = resolve_plugin_caller_role(&perms, &window, Some(&id), Some(&token))?;
    if resolved.as_deref() != Some(id.as_str()) {
        return Err("plugin_logic_read_file: token does not belong to this plugin".into());
    }
    tauri::async_runtime::spawn_blocking(move || read_plugin_source(&id, &path))
        .await
        .map_err(|error| error.to_string())?
}

fn read_plugin_source(id: &str, path: &str) -> Result<String, String> {
    let base = base_dir();
    let manifests = crate::plugins::list_plugins(&base, &[], &[], false);
    let manifest = manifests
        .iter()
        .find(|manifest| manifest.id == id)
        .ok_or_else(|| format!("unknown plugin \"{id}\""))?;
    if let Some(reason) = &manifest.api_error {
        return Err(format!("plugin \"{id}\" was rejected: {reason}"));
    }
    let root = std::fs::canonicalize(&manifest.dir)
        .map_err(|error| format!("plugin directory unavailable: {error}"))?;
    let target =
        std::fs::canonicalize(path).map_err(|error| format!("plugin file unavailable: {error}"))?;
    let root_text = root.to_string_lossy().replace('/', "\\").to_lowercase();
    let target_text = target.to_string_lossy().replace('/', "\\").to_lowercase();
    if target_text != root_text && !target_text.starts_with(&(root_text + "\\")) {
        return Err("plugin file read escaped the plugin directory".into());
    }
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("plugin source path is not a file".into());
    }
    if metadata.len() > MAX_PLUGIN_SOURCE_BYTES {
        return Err(format!(
            "plugin source file exceeds {} bytes",
            MAX_PLUGIN_SOURCE_BYTES
        ));
    }
    std::fs::read_to_string(&target).map_err(|error| format!("plugin source read failed: {error}"))
}

fn default_host_role() -> String {
    "logic".into()
}

/// One token entry: `token = None` drops every token of that plugin (unload).
#[derive(serde::Deserialize)]
pub struct HostTokenEntry {
    pub id: String,
    pub token: Option<String>,
    #[serde(default = "default_host_role")]
    pub role: String,
}

/// The supervisor registers each logic iframe's token (per plugin load).
/// Label-gated to the shared host window.
#[tauri::command]
pub fn plugin_logic_register_tokens(
    entries: Vec<HostTokenEntry>,
    window: tauri::WebviewWindow,
    perms: State<'_, crate::plugin_perm::PluginPermState>,
) -> Result<(), String> {
    if window.label() != LOGIC_HOST_LABEL {
        return Err("plugin_logic_register_tokens: wrong window".into());
    }
    for e in entries {
        if e.token.is_some() && !matches!(e.role.as_str(), "service" | "logic") {
            return Err(format!("unknown host role \"{}\"", e.role));
        }
        match e.token {
            Some(token) => crate::plugin_perm::register_host_token(&perms, &token, &e.id, &e.role),
            None => crate::plugin_perm::drop_host_tokens(&perms, &e.id),
        }
    }
    Ok(())
}

/// supervisor 监听器就绪 → main（重）发全部 load。覆盖两种竞态：建窗后
/// 启动器的 load 指令先于本页监听器（事件丢失），以及崩溃恢复后的重载。
#[tauri::command]
pub fn plugin_logic_supervisor_ready(
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    if window.label() != LOGIC_HOST_LABEL {
        return Err("plugin_logic_supervisor_ready: wrong window".into());
    }
    app.emit_to("main", "plugin-logic-host-ready", ())
        .map_err(|e| e.to_string())
}

/// 启动器 → 宿主的一条指令。label 门控 main。
/// `kind`: `"load"` / `"unload"` / `"event"`（lume.on.* 事件）/ `"hook"`
/// （hook 调用，payload = {callId, name, args}）。
#[tauri::command]
pub fn plugin_logic_push(
    id: String,
    kind: String,
    payload: serde_json::Value,
    window: tauri::WebviewWindow,
    app: AppHandle,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("plugin_logic_push: launcher window only".into());
    }
    app.emit_to(
        LOGIC_HOST_LABEL,
        "plugin-logic-event",
        serde_json::json!({ "id": id, "kind": kind, "payload": payload }),
    )
    .map_err(|e| e.to_string())
}

/// 宿主 supervisor → 启动器：ctx 的 app.* 动作（toast/setQuery/redirect/…）
/// 与生命周期通告。令牌 → id 强制归属（归属错了 emit 的就是伪造身份）。
#[tauri::command]
pub fn plugin_logic_action(
    token: String,
    action: String,
    args: serde_json::Value,
    window: tauri::WebviewWindow,
    perms: State<'_, crate::plugin_perm::PluginPermState>,
    app: AppHandle,
) -> Result<(), String> {
    if window.label() != LOGIC_HOST_LABEL {
        return Err("plugin_logic_action: wrong window".into());
    }
    let id = resolve_plugin_caller(&perms, &window, None, Some(&token))?
        .ok_or_else(|| "plugin_logic_action: token resolved to no plugin".to_string())?;
    app.emit_to(
        "main",
        "plugin-logic-action",
        serde_json::json!({ "id": id, "action": action, "args": args }),
    )
    .map_err(|e| e.to_string())
}

/// 宿主 supervisor → 启动器：一次 hook 调用的回执（registry 按 callId 收口）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn plugin_logic_result(
    token: String,
    call_id: u64,
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
    window: tauri::WebviewWindow,
    perms: State<'_, crate::plugin_perm::PluginPermState>,
    app: AppHandle,
) -> Result<(), String> {
    if window.label() != LOGIC_HOST_LABEL {
        return Err("plugin_logic_result: wrong window".into());
    }
    let id = resolve_plugin_caller(&perms, &window, None, Some(&token))?
        .ok_or_else(|| "plugin_logic_result: token resolved to no plugin".to_string())?;
    app.emit_to(
        "main",
        "plugin-logic-result",
        serde_json::json!({ "id": id, "callId": call_id, "ok": ok, "result": result, "error": error }),
    )
    .map_err(|e| e.to_string())
}
