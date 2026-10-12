# Rules

Non-negotiable development rules for Lume. Derived from the project
philosophy in `README.md`.

## 1. Fast

Everything should feel instant. Targets:

- Launcher popup < 50ms
- Search response < 20ms
- Idle CPU < 0.2%

Implications:

- Index in-memory and lazily; never block startup on disk scans.
- Keep IPC payloads small (top-N results, not full lists).
- Guard against out-of-order responses when the frontend fires per-keystroke
  searches.

## 2. Minimal

Avoid unnecessary features. Every feature must answer:

> "Does this make users faster?"

Implications:

- Prefer a small, coherent settings surface over exposing every implementation
  detail.
- Extract real icons because the first-party search surface needs them; do not
  grow into a general-purpose icon/favicon service.
- Prefer deleting a feature over maintaining it.

## 3. Elegant

The UI should feel native, clean and focused. Follow
`docs/UI_GUIDELINES.md` strictly.

## 4. Architecture

- **Business logic lives in Rust.** The webview renders and collects input
  only. If new logic can run in Rust, it does. Filesystem, network, privilege,
  database and Windows API work belongs to Rust.
- One module, one responsibility (`window`, `apps`, `clipboard`, `plugins`,
  `plugin_perm`, `filesearch`, ...).
- New commands go through `tauri::generate_handler!` in `lib.rs`.
- Use the Tauri v2 capability system for anything exposed to the webview.
- Plugin code uses the documented capability ledger; new host APIs must update
  the RPC surface, frontend permission map and Rust-side whitelist together.
- Keep privilege boundaries separate: `lume.exe` stays at medium integrity;
  privileged work belongs in the narrow helper/service binaries.

## 5. Platform

- Windows is the only supported platform for now.
- Use native APIs (`ShellExecuteW`, `RegisterHotKey`) instead of shelling out
  where practical.

## 6. Dependencies

- Network is unreliable in this environment: **use mirror sources** for every
  download (crates.io mirrors, npm registry mirrors).
- Question every new dependency against the "Minimal" rule.
