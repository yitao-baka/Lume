//! `lume-agent.exe` — the elevated input-injection helper (docs/ROADMAP.md #22).
//!
//! Deliberately tiny and single-purpose: it owns one named pipe and can do
//! exactly one thing with it (inject a configured hotkey into a foreground
//! window). It has no UI, opens no files and launches no processes, because
//! it runs with a high-integrity token.
//!
//! Normally started silently by its scheduled task (`--serve`); the two
//! install verbs run once, elevated, via the settings 系统 page (UAC).
//!
//! Release builds use the Windows subsystem so a task-triggered start never
//! flashes a console window. That also means stderr is invisible, so failures
//! are reported back over the pipe (`status`/`inject_ack`) — the same lesson
//! LumeSVC learned (ROADMAP #20.1: under the SCM stderr does not exist).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result = match args.first().map(String::as_str) {
        Some("--install-task") => lume_lib::agent::install_task(),
        Some("--uninstall-task") => lume_lib::agent::uninstall_task(),
        // `--serve`, or no argument at all (the task's action).
        _ => lume_lib::agent::serve(),
    };
    if let Err(e) = result {
        eprintln!("[lume-agent] {e}");
        std::process::exit(1);
    }
}
