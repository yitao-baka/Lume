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
//! The agent uses the Windows subsystem in **every** build profile so a
//! task-triggered `--serve` never flashes a console window that would steal
//! focus (~60s idle or, in 常驻 mode, indefinitely). That also means stderr is
//! invisible, so failures are reported back over the pipe (`status`/
//! `inject_ack`) and the install/uninstall outcome over the result file — the
//! same lesson LumeSVC learned (ROADMAP #20.1: under the SCM stderr does not
//! exist).

#![windows_subsystem = "windows"]

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some(verb @ ("--install-task" | "--uninstall-task")) => {
            // No console here either (the subsystem applies in debug too), so
            // the outcome is handed back over the result file that the
            // launcher waits for — an invisible failure otherwise surfaces as
            // a blank "注册失败" with no way to know why.
            let result = if verb == "--install-task" {
                lume_lib::agent::install_task()
            } else {
                lume_lib::agent::uninstall_task()
            };
            lume_lib::agent::write_install_result(&result);
            if let Err(e) = &result {
                eprintln!("[lume-agent] {e}");
            }
            std::process::exit(if result.is_ok() { 0 } else { 1 });
        }
        // `--serve`, or no argument at all (the task's action).
        _ => {
            if let Err(e) = lume_lib::agent::serve() {
                eprintln!("[lume-agent] {e}");
                std::process::exit(1);
            }
        }
    }
}
