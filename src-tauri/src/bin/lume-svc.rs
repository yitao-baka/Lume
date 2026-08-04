//! LumeSVC — the companion SYSTEM service binary (not a Tauri app).
//!
//! Runs as the local system account to own the periodic index-cache refresh
//! (docs/ROADMAP service iteration). Invocations:
//! - `lume-svc.exe --install`    register + start (needs elevation, UAC)
//! - `lume-svc.exe --uninstall`  stop + unregister (needs elevation, UAC)
//! - `lume-svc.exe --foreground [--data-dir <path>]`  dev: run without SCM
//! - `lume-svc.exe` (no args)    run as a service via the SCM dispatcher
//!
//! Intentionally a console-subsystem binary: `--foreground` logs to stdout, and
//! the GUI launches `--install`/`--uninstall` with `SW_HIDE` so no window pops.

use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("--install") => lume_lib::svc::install(),
        Some("--uninstall") => lume_lib::svc::uninstall(),
        Some("--foreground") => {
            let dir = args
                .iter()
                .position(|a| a == "--data-dir")
                .and_then(|i| args.get(i + 1))
                .map(PathBuf::from);
            lume_lib::svc::run_foreground(dir)
        }
        _ => lume_lib::svc::run_service(), // SCM dispatch (blocking)
    };
    if let Err(e) = result {
        eprintln!("[lume-svc] {e}");
        std::process::exit(1);
    }
}
