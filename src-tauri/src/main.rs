// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // CLI tools run without a window (plugin_sign.rs, #32.2): key generation
    // and .lupx signing. Anything else launches the launcher.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Some(code) = lume_lib::plugin_sign::run_cli(&args) {
        std::process::exit(code);
    }
    lume_lib::run()
}
