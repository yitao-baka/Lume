//! 插件目录 dev 监听（ROADMAP #32.7）—— 编辑插件代码自动热重载。
//!
//! 仅 `plugins.dev_mode` 开启时工作：递归监听 `<base>/plugins`，静默 800ms
//! 后向 main 窗口发 `plugin-dev-changed`；前端（registry.refreshPlugins）
//! 只重载 manifest 标了 `development` 的插件——与设置页「↻ 重载」按钮同一
//! 路径。零轮询：`FindFirstChangeNotificationW` 是内核等待，空闲不占 CPU
//! （与 `dirwatch.rs` 同一模式，句柄重建由 generation 计数器驱动，settings
//! 保存时经 `rebuild` 启停）。

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
use windows::Win32::Storage::FileSystem::{
    FindCloseChangeNotification, FindFirstChangeNotificationW, FindNextChangeNotification,
    FILE_NOTIFY_CHANGE, FILE_NOTIFY_CHANGE_DIR_NAME, FILE_NOTIFY_CHANGE_FILE_NAME,
    FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
};
use windows::Win32::System::Threading::WaitForMultipleObjects;

/// 静默窗口：一次保存（编辑器写临时文件 + rename）常连发多个事件。
const DEBOUNCE: Duration = Duration::from_millis(800);
/// 空闲时重查 generation 的间隔（ms）。
const POLL: u32 = 2000;

const NOTIFY_FILTER: FILE_NOTIFY_CHANGE = FILE_NOTIFY_CHANGE(
    FILE_NOTIFY_CHANGE_FILE_NAME.0
        | FILE_NOTIFY_CHANGE_DIR_NAME.0
        | FILE_NOTIFY_CHANGE_LAST_WRITE.0
        | FILE_NOTIFY_CHANGE_SIZE.0,
);

/// 监听状态：启用开关（dev_mode）+ generation（settings 保存时递增）。
pub struct DevWatchState {
    pub enabled: Mutex<bool>,
    pub generation: AtomicU32,
}

impl Default for DevWatchState {
    fn default() -> Self {
        Self {
            enabled: Mutex::new(false),
            generation: AtomicU32::new(0),
        }
    }
}

/// 启动后台监听线程（句柄随 generation 惰性建立）。
pub fn start(app: &AppHandle) {
    rebuild(app);
    let app = app.clone();
    std::thread::Builder::new()
        .name("plugin-devwatch".into())
        .spawn(move || watch_thread(app))
        .ok();
}

/// 重新读取 dev_mode 开关。启动 + 每次设置保存时调用。
pub fn rebuild(app: &AppHandle) {
    let Some(state) = app.try_state::<DevWatchState>() else {
        return;
    };
    let settings = app.state::<crate::settings::SettingsState>().current();
    *state.enabled.lock().unwrap() = settings.plugins.dev_mode;
    state.generation.fetch_add(1, Ordering::Relaxed);
}

fn plugins_dir_path() -> PathBuf {
    crate::paths::base_dir().join("plugins")
}

fn watch_thread(app: AppHandle) {
    let mut last_gen = 0u32;
    let mut handle: Option<HANDLE> = None;
    let mut dirty_since: Option<Instant> = None;

    loop {
        let state = app.state::<DevWatchState>();
        let gen = state.generation.load(Ordering::Relaxed);

        if gen != last_gen {
            if let Some(h) = handle.take() {
                unsafe {
                    let _ = FindCloseChangeNotification(h);
                }
            }
            let enabled = *state.enabled.lock().unwrap();
            handle = enabled
                .then(|| {
                    let dir = plugins_dir_path();
                    if !dir.is_dir() {
                        return None;
                    }
                    let wide: Vec<u16> = dir
                        .to_string_lossy()
                        .encode_utf16()
                        .chain(std::iter::once(0))
                        .collect();
                    unsafe {
                        FindFirstChangeNotificationW(PCWSTR(wide.as_ptr()), true, NOTIFY_FILTER).ok()
                    }
                })
                .flatten();
            last_gen = gen;
            dirty_since = None;
        }

        let Some(h) = handle else {
            std::thread::sleep(Duration::from_millis(POLL as u64));
            continue;
        };

        let result = unsafe { WaitForMultipleObjects(std::slice::from_ref(&h), false, POLL) };
        if result.0 >= WAIT_OBJECT_0.0 && result.0 < WAIT_OBJECT_0.0 + 1 {
            unsafe {
                let _ = FindNextChangeNotification(h);
            }
            if dirty_since.is_none() {
                dirty_since = Some(Instant::now());
            }
        }

        if let Some(since) = dirty_since {
            if since.elapsed() >= DEBOUNCE {
                eprintln!("[plugins] dev watch: change detected → plugin-dev-changed");
                let _ = app.emit_to("main", "plugin-dev-changed", ());
                dirty_since = None;
            }
        }
    }
}
