//! 提权注入代理 — `lume-agent.exe` (docs/ROADMAP.md #22).
//!
//! `SendInput` is subject to UIPI: a medium-integrity process cannot inject
//! input into a higher-integrity window, and the failure is silent ("neither
//! GetLastError nor the return value will indicate the failure was caused by
//! UIPI blocking" — MSDN). An integrity level is a *process* property, so the
//! only fix is to inject from a process that already has the right token:
//! this tiny helper, and nothing else. Lume's own process stays non-elevated.
//!
//! How it is started: a pre-registered Task Scheduler task
//! (`Lume\LumeAgent`, `RunLevel=HighestAvailable`) — the user consents once
//! when registering it, after which Windows starts it silently. A medium-IL
//! Lume triggers it on demand with `schtasks /Run` (no prompt) and the agent
//! exits again once idle, unless a client asked it to stay resident.
//!
//! Security boundary (this is a high-integrity key injector — the ACL is the
//! feature, not a detail):
//! - the pipe DACL grants the **installing user's SID** and SYSTEM only —
//!   deliberately *not* `Authenticated Users` like `\\.\pipe\LumeSVC`, which
//!   would let any process on the machine drive it;
//! - the caller must be in this agent's session and be the sibling
//!   `lume.exe` (defence in depth on top of the DACL);
//! - a request can only inject one combo into a window that is **currently
//!   foreground** and owned by the pid it names — never into a background
//!   window, and never an arbitrary command or process launch.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::input;

/// The companion helper's file name (lives next to `lume.exe`).
pub const AGENT_EXE: &str = "lume-agent.exe";
/// The agent's control pipe.
pub const AGENT_PIPE: &str = r"\\.\pipe\LumeAgent";
/// Scheduled-task name (inside the `Lume` folder) that starts it elevated.
pub const TASK_NAME: &str = "LumeAgent";
/// Full task path as `schtasks` wants it.
pub const TASK_PATH: &str = r"Lume\LumeAgent";
/// Idle seconds before the agent exits, unless a client asked it to stay.
/// Must comfortably exceed [`MAX_INJECT_DELAY_MS`] or a pending injection
/// could be cut off — hence the watchdog also requires zero in-flight requests.
pub const IDLE_EXIT_SECS: u64 = 60;
/// Longest accepted 延迟触发 for a request (mirrors `settings::MAX_ACTION_DELAY_MS`).
pub const MAX_INJECT_DELAY_MS: u64 = 60_000;
/// How long `ensure` waits for a triggered agent to answer.
pub const STARTUP_WAIT: Duration = Duration::from_millis(2500);
/// Timeout for a plain `status`/`hello` round trip.
const PING_TIMEOUT: Duration = Duration::from_millis(500);
/// Timeout for `inject` — the agent may be sleeping its 延迟触发 first.
const INJECT_TIMEOUT: Duration = Duration::from_secs(5);

/// Machine reason keys reported by [`inject`] / [`inject_via_agent`] and mapped
/// to localized messages by the settings UI.
pub mod reason {
    /// Input was blocked and the target is elevated and so are we — but the
    /// send still failed (rare; e.g. a lower-integrity agent).
    pub const UIPI: &str = "uipi";
    /// Input was blocked for an unexplained reason (`BlockInput`, etc.).
    pub const BLOCKED: &str = "blocked";
    /// The agent itself is not elevated, so a higher-integrity target is out of
    /// reach — the task ran with a limited token.
    pub const NOT_ELEVATED: &str = "not_elevated";
    /// The foreground moved away during the delay and 抢回焦点 is off.
    pub const FOCUS_MOVED: &str = "focus_moved";
    /// Windows refused the foreground change.
    pub const FOCUS_FAILED: &str = "focus_failed";
    /// No usable window of the target process is left.
    pub const NO_WINDOW: &str = "no_window";
    /// The combo string does not parse.
    pub const BAD_COMBO: &str = "bad_combo";
    /// A key in the combo cannot be synthesized.
    pub const UNSUPPORTED: &str = "unsupported";
    /// The caller is in another session.
    pub const DENIED_SESSION: &str = "denied_session";
    /// The caller is not the sibling `lume.exe`.
    pub const DENIED_CLIENT: &str = "denied_client";
    /// Client-side: the target is elevated and no agent is available.
    pub const NEEDS_AGENT: &str = "needs_agent";
    /// Client-side: the agent could not be reached at all.
    pub const UNAVAILABLE: &str = "unavailable";
}

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

/// One request. The wire format is `{"t":"<verb>", ...}` — the same
/// length-prefixed JSON framing `\\.\pipe\LumeSVC` uses (`crate::pipe`).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "t")]
pub enum AgentRequest {
    #[serde(rename = "hello")]
    Hello,
    /// Send `combo` once to the window owned by `pid` (and, normally,
    /// `hwnd`). `delay_ms` is the rule's 延迟触发, applied inside the agent so
    /// the foreground re-check happens at the moment of sending.
    #[serde(rename = "inject")]
    Inject {
        combo: String,
        pid: u32,
        hwnd: isize,
        #[serde(default)]
        delay_ms: u64,
        #[serde(default)]
        force_focus: bool,
    },
    /// Ask the agent to stay resident instead of exiting when idle.
    #[serde(rename = "stay")]
    Stay,
    #[serde(rename = "status")]
    Status,
    /// Ask the agent to exit (used by agent uninstall).
    #[serde(rename = "shutdown")]
    Shutdown,
}

/// One reply. Internally tagged so it serializes as `{"t":"inject_ack",...}`.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "t")]
pub enum AgentReply {
    #[serde(rename = "hello_ack")]
    HelloAck { ok: bool, elevated: bool, session: u32 },
    #[serde(rename = "inject_ack")]
    InjectAck {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        sent: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
    },
    #[serde(rename = "stay_ack")]
    StayAck { ok: bool },
    #[serde(rename = "shutdown_ack")]
    ShutdownAck { ok: bool },
    #[serde(rename = "status")]
    Status {
        elevated: bool,
        session: u32,
        sent_total: u64,
        uptime_s: u64,
    },
    #[serde(rename = "error")]
    Error { message: String },
}

impl AgentReply {
    fn inject_ok(sent: u32) -> Self {
        AgentReply::InjectAck {
            ok: true,
            sent: Some(sent),
            reason: None,
        }
    }

    fn inject_fail(reason: &str) -> Self {
        AgentReply::InjectAck {
            ok: false,
            sent: None,
            reason: Some(reason.to_string()),
        }
    }

    /// Serialize for the wire. A reply that fails to serialize is a bug, but
    /// never a reason to drop the connection silently.
    fn to_wire(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|e| {
            format!(r#"{{"t":"error","message":"reply serialize: {e}"}}"#)
        })
    }
}

/// Parse an `inject_ack` reply into the number of events sent, or the machine
/// reason key. Pure — the unit tests drive it directly.
pub fn parse_inject_ack(reply: &str) -> Result<u32, String> {
    #[derive(Deserialize)]
    struct Ack {
        ok: bool,
        #[serde(default)]
        sent: Option<u32>,
        #[serde(default)]
        reason: Option<String>,
    }
    let ack: Ack = serde_json::from_str(reply).map_err(|_| reason::UNAVAILABLE.to_string())?;
    if ack.ok {
        // A successful send always reports its event count; treat a missing
        // count as zero rather than inventing one.
        Ok(ack.sent.unwrap_or(0))
    } else {
        Err(ack.reason.unwrap_or_else(|| reason::UNAVAILABLE.into()))
    }
}

/// The agent's own report, as parsed by the Lume client.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct AgentInfo {
    #[serde(default)]
    pub elevated: bool,
    #[serde(default)]
    pub session: u32,
    #[serde(default)]
    pub sent_total: u64,
    #[serde(default)]
    pub uptime_s: u64,
}

/// Status of the helper, for the settings 系统 page.
#[derive(Debug, Serialize)]
pub struct AgentStatus {
    /// The scheduled task exists (the consent to run elevated was given).
    pub installed: bool,
    /// An agent is currently answering on the pipe.
    pub running: bool,
    /// The running agent's own token is elevated.
    pub elevated: bool,
    pub session: Option<u32>,
    pub sent_total: u64,
    /// The agent binary's expected path (next to the launcher).
    pub bin_path: Option<String>,
    /// Task name, shown so the user can find it in Task Scheduler.
    pub task_name: String,
    /// Idle seconds after which an on-demand agent exits.
    pub idle_exit_secs: u64,
}

// ---------------------------------------------------------------------------
// Task Scheduler (install / uninstall / run)
// ---------------------------------------------------------------------------

/// `CREATE_NO_WINDOW`: `schtasks.exe` and the agent itself must never flash a
/// console in the user's face.
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

fn agent_exe_path() -> PathBuf {
    crate::paths::exe_dir().join(AGENT_EXE)
}

/// The XML Task Scheduler gets. Built as XML rather than with `schtasks /SC`
/// because three settings are not expressible on that command line:
/// *no battery pause*, `MultipleInstancesPolicy=IgnoreNew` (never two agents
/// fighting over the pipe) and `ExecutionTimeLimit=PT0S` (**unlimited** — the
/// default 72-hour limit would kill a resident agent). The logon trigger is
/// what makes the resident option work; an on-demand agent started by it
/// simply exits again when idle.
fn task_xml(exe: &Path, user_sid: &str) -> String {
    // Task Scheduler accepts a quoted <Command>, but its own UI writes the
    // bare path — only quote when the path actually needs it.
    let path = exe.to_string_lossy();
    let command = if path.contains(' ') {
        format!("\"{path}\"")
    } else {
        path.into_owned()
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Lume elevation agent - injects a configured hotkey into higher-integrity windows (input only; no UI, no files).</Description>
    <URI>{TASK_PATH}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>{user_sid}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>{user_sid}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>{command}</Command>
      <Arguments>--serve</Arguments>
    </Exec>
  </Actions>
</Task>
"#
    )
}

/// Run `schtasks` silently and return its combined output on failure.
fn schtasks(args: &[&str]) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("schtasks.exe");
    cmd.args(args).creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| format!("schtasks: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let msg = if msg.is_empty() {
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    } else {
        msg
    };
    Err(format!("schtasks {} failed: {msg}", args.join(" ")))
}

/// Is the helper's scheduled task registered?
pub fn task_installed() -> bool {
    schtasks(&["/Query", "/TN", TASK_PATH]).is_ok()
}

/// Start the registered task (elevated, no UAC prompt) — the on-demand path.
pub fn run_task() -> Result<(), String> {
    schtasks(&["/Run", "/TN", TASK_PATH])
}

/// Register the task. Runs inside the **elevated** agent (`--install-task`).
pub fn install_task() -> Result<(), String> {
    crate::svc::ensure_elevated()?;
    let exe = agent_exe_path();
    if !exe.exists() {
        return Err(format!("{AGENT_EXE} not found next to the launcher"));
    }
    let sid = current_user_sid().ok_or("cannot resolve the current user SID")?;
    let xml = task_xml(&exe, &sid);
    let tmp = std::env::temp_dir().join("lume-agent-task.xml");
    std::fs::write(&tmp, xml.as_bytes()).map_err(|e| format!("writing task xml: {e}"))?;
    let result = schtasks(&[
        "/Create",
        "/XML",
        &tmp.to_string_lossy(),
        "/TN",
        TASK_PATH,
        "/F",
    ]);
    let _ = std::fs::remove_file(&tmp);
    result
}

/// Remove the task and stop any running agent. Runs inside the **elevated**
/// agent (`--uninstall-task`).
pub fn uninstall_task() -> Result<(), String> {
    crate::svc::ensure_elevated()?;
    // Ask a live agent to quit first so the exe can be replaced afterwards.
    let _ = shutdown();
    schtasks(&["/Delete", "/TN", TASK_PATH, "/F"])
}

// ---------------------------------------------------------------------------
// Client (Lume side)
// ---------------------------------------------------------------------------

/// One exchange with the agent, or `Err` when it is not answering.
pub fn status() -> Result<AgentInfo, String> {
    let reply = crate::pipe::transact(AGENT_PIPE, r#"{"t":"status"}"#, PING_TIMEOUT)?;
    serde_json::from_str(&reply).map_err(|_| reason::UNAVAILABLE.to_string())
}

/// A live agent, if any.
pub fn ping() -> Option<AgentInfo> {
    status().ok()
}

/// Ask a live agent to stay resident (常驻 model). Best effort.
pub fn stay() -> bool {
    crate::pipe::transact(AGENT_PIPE, r#"{"t":"stay"}"#, PING_TIMEOUT).is_ok()
}

/// Ask a live agent to exit (used before removing the task). Best effort.
pub fn shutdown() -> bool {
    crate::pipe::transact(AGENT_PIPE, r#"{"t":"shutdown"}"#, PING_TIMEOUT).is_ok()
}

/// Make sure an agent is reachable, triggering the scheduled task when not.
/// Returns `false` when the agent is not installed or would not come up.
pub fn ensure(wait: Duration) -> bool {
    if ping().is_some() {
        return true;
    }
    if !task_installed() || run_task().is_err() {
        return false;
    }
    let deadline = Instant::now() + wait;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(60));
        if ping().is_some() {
            return true;
        }
    }
    false
}

/// Send one inject request through the agent.
///
/// `Err` carries a machine reason key (`reason::*`). Callers must check the
/// return: an agent that answers is *not* proof the key arrived.
pub fn inject(
    combo: &str,
    pid: u32,
    hwnd: isize,
    delay_ms: u64,
    force_focus: bool,
) -> Result<u32, String> {
    let request = serde_json::json!({
        "t": "inject",
        "combo": combo,
        "pid": pid,
        "hwnd": hwnd,
        "delay_ms": delay_ms,
        "force_focus": force_focus,
    })
    .to_string();
    let reply = crate::pipe::transact(AGENT_PIPE, &request, INJECT_TIMEOUT)
        .map_err(|_| reason::UNAVAILABLE.to_string())?;
    parse_inject_ack(&reply)
}


// ---------------------------------------------------------------------------
// Server (agent side, `lume-agent.exe --serve`)
// ---------------------------------------------------------------------------

/// Shared agent state, borrowed by every connection thread.
struct Ctx {
    elevated: bool,
    session: Option<u32>,
    /// The only client we accept: the `lume.exe` beside this binary.
    allowed_client: PathBuf,
    started: Instant,
    sent_total: AtomicU64,
    /// Epoch millis of the last request, for the idle watchdog.
    last_activity: AtomicU64,
    /// In-flight requests — the watchdog never exits under load.
    active: AtomicU32,
    /// Set by a client that wants the agent to stay after it goes idle.
    stay: AtomicBool,
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// The SDDL for the agent pipe: the installing user + SYSTEM, nothing else.
/// Deliberately *not* `AU` — see the module header.
fn build_sddl(user_sid: &str) -> String {
    format!("D:(A;;GA;;;{user_sid})(A;;GA;;;SY)")
}

/// The current user's SID as a string, or `None` when it cannot be read.
/// The agent refuses to serve without it: failing open here would widen the
/// pipe to every authenticated user on the machine.
fn current_user_sid() -> Option<String> {
    use windows::Win32::Foundation::{CloseHandle, HLOCAL, HANDLE, LocalFree};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TOKEN_USER, TokenUser};
    use windows::Win32::Security::TOKEN_QUERY;
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    unsafe {
        let mut token = HANDLE(std::ptr::null_mut());
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).ok()?;
        let mut buf = vec![0u8; 256];
        let mut len = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenUser,
            Some(buf.as_mut_ptr() as *mut core::ffi::c_void),
            buf.len() as u32,
            &mut len,
        );
        let _ = CloseHandle(token);
        ok.ok()?;
        let user = &*(buf.as_ptr() as *const TOKEN_USER);
        let mut sid_string = windows::core::PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut sid_string).ok()?;
        let sid = sid_string.to_string().ok();
        let _ = LocalFree(Some(HLOCAL(sid_string.0 as *mut core::ffi::c_void)));
        sid
    }
}

/// Run the agent: own `\\.\pipe\LumeAgent` until asked to stop or idle out.
/// Blocks for the process lifetime.
pub fn serve() -> Result<(), String> {
    let sid = current_user_sid()
        .ok_or("cannot resolve the current user SID (refusing to serve an unscoped pipe)")?;
    let ctx = Arc::new(Ctx {
        elevated: input::is_elevated(),
        session: input::current_session_id(),
        allowed_client: crate::paths::exe_dir().join("lume.exe"),
        started: Instant::now(),
        sent_total: AtomicU64::new(0),
        last_activity: AtomicU64::new(now_millis()),
        active: AtomicU32::new(0),
        stay: AtomicBool::new(false),
    });

    spawn_idle_watchdog(&ctx);

    let sddl = build_sddl(&sid);
    let name = crate::pipe::wide(AGENT_PIPE);
    let sddl_wide = crate::pipe::wide(&sddl);

    loop {
        // One instance at a time, recreated immediately after a client is
        // accepted so the next request can connect while the previous one is
        // still being served (a long 延迟触发 must not block a 测试).
        let pipe = match create_pipe(&name, &sddl_wide) {
            Some(p) => p,
            None => {
                std::thread::sleep(Duration::from_millis(500));
                continue;
            }
        };
        let connected = unsafe {
            windows::Win32::System::Pipes::ConnectNamedPipe(pipe, None)
        }
        .is_ok();
        if !connected {
            // The client vanished between create and connect.
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(pipe) };
            continue;
        }
        let ctx = Arc::clone(&ctx);
        // The handle has to cross a thread boundary; it is a process-wide
        // kernel handle, so moving it is sound.
        let pipe = SendHandle(pipe);
        let _ = std::thread::Builder::new()
            .name("agent-conn".into())
            .spawn(move || serve_connection(pipe, &ctx));
    }
}

/// A pipe handle on its way to a connection thread. Windows handles are
/// process-wide objects, so `Send` is sound here (the `windows` crate cannot
/// know that and types `HANDLE` as a raw pointer).
struct SendHandle(windows::Win32::Foundation::HANDLE);
unsafe impl Send for SendHandle {}

/// Create the pipe instance with the agent's DACL.
fn create_pipe(
    name: &[u16],
    sddl: &[u16],
) -> Option<windows::Win32::Foundation::HANDLE> {
    use windows::Win32::Foundation::{HLOCAL, INVALID_HANDLE_VALUE, LocalFree};
    use windows::Win32::Security::Authorization::ConvertStringSecurityDescriptorToSecurityDescriptorW;
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
    use windows::Win32::System::Pipes::{
        CreateNamedPipeW, NAMED_PIPE_MODE, PIPE_READMODE_MESSAGE, PIPE_TYPE_MESSAGE,
        PIPE_UNLIMITED_INSTANCES,
    };

    let mut sd = PSECURITY_DESCRIPTOR(std::ptr::null_mut());
    let has_sa = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            windows::core::PCWSTR(sddl.as_ptr()),
            1,
            &mut sd,
            None,
        )
    }
    .is_ok();
    if !has_sa {
        // Without a scoped descriptor we would have to fall back to a wider
        // ACL — refuse instead. A high-integrity key injector must fail closed.
        eprintln!("[agent] cannot build the pipe security descriptor; refusing to serve");
        return None;
    }
    let sa = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0,
        bInheritHandle: false.into(),
    };
    let pipe = unsafe {
        CreateNamedPipeW(
            windows::core::PCWSTR(name.as_ptr()),
            windows::Win32::Storage::FileSystem::PIPE_ACCESS_DUPLEX,
            NAMED_PIPE_MODE(PIPE_TYPE_MESSAGE.0 | PIPE_READMODE_MESSAGE.0),
            PIPE_UNLIMITED_INSTANCES,
            4096,
            4096,
            0,
            Some(&sa as *const SECURITY_ATTRIBUTES),
        )
    };
    let _ = unsafe { LocalFree(Some(HLOCAL(sd.0))) };
    (pipe != INVALID_HANDLE_VALUE).then_some(pipe)
}

/// Serve one connection: read, dispatch, reply, then linger until the client
/// hangs up before recycling the instance.
fn serve_connection(wrapper: SendHandle, ctx: &Arc<Ctx>) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Storage::FileSystem::{ReadFile, WriteFile};
    use windows::Win32::System::Pipes::DisconnectNamedPipe;

    let pipe = wrapper.0;
    ctx.active.fetch_add(1, Ordering::SeqCst);
    ctx.last_activity.store(now_millis(), Ordering::SeqCst);

    let reply = match read_request(pipe) {
        Some(payload) => {
            let (reply, shutdown) = dispatch(pipe, ctx, &payload);
            let wire = reply.to_wire();
            let mut out = Vec::with_capacity(wire.len() + 4);
            out.extend_from_slice(&(wire.len() as u32).to_le_bytes());
            out.extend_from_slice(wire.as_bytes());
            let _ = unsafe { WriteFile(pipe, Some(&out), None, None) };
            if shutdown {
                // Give the client time to read the reply before the process
                // goes away; the socket closing first would lose it.
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(250));
                    std::process::exit(0);
                });
            }
            true
        }
        None => false,
    };

    if reply {
        // `DisconnectNamedPipe` discards data the client has not read yet, so
        // an immediate disconnect would race the reply out of the buffer (the
        // classic lost-reply bug LumeSVC already documents). Blocking until
        // the client closes its handle is what makes the reply reliable.
        let mut drain = [0u8; 64];
        let mut n: u32 = 0;
        let _ = unsafe { ReadFile(pipe, Some(&mut drain), Some(&mut n), None) };
    }

    ctx.active.fetch_sub(1, Ordering::SeqCst);
    ctx.last_activity.store(now_millis(), Ordering::SeqCst);
    let _ = unsafe { DisconnectNamedPipe(pipe) };
    let _ = unsafe { CloseHandle(pipe) };
}

/// Read one framed request. `None` = the client hung up or sent nothing.
fn read_request(pipe: windows::Win32::Foundation::HANDLE) -> Option<String> {
    use windows::Win32::Storage::FileSystem::ReadFile;
    let mut buf = [0u8; 4096];
    let mut n: u32 = 0;
    let ok = unsafe { ReadFile(pipe, Some(&mut buf), Some(&mut n), None) };
    if ok.is_err() || n < 4 {
        return None;
    }
    let len = u32::from_le_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len + 4 > n as usize {
        return None;
    }
    Some(String::from_utf8_lossy(&buf[4..4 + len]).into_owned())
}

/// Handle one request. Returns the reply and whether the agent should exit.
fn dispatch(
    pipe: windows::Win32::Foundation::HANDLE,
    ctx: &Arc<Ctx>,
    payload: &str,
) -> (AgentReply, bool) {
    let request: AgentRequest = match serde_json::from_str(payload) {
        Ok(r) => r,
        Err(_) => {
            return (
                AgentReply::Error {
                    message: "bad json".into(),
                },
                false,
            );
        }
    };

    let session = ctx.session.unwrap_or(u32::MAX);
    match request {
        AgentRequest::Hello => (
            AgentReply::HelloAck {
                ok: true,
                elevated: ctx.elevated,
                session,
            },
            false,
        ),
        AgentRequest::Status => (
            AgentReply::Status {
                elevated: ctx.elevated,
                session,
                sent_total: ctx.sent_total.load(Ordering::Relaxed),
                uptime_s: ctx.started.elapsed().as_secs(),
            },
            false,
        ),
        AgentRequest::Stay => {
            ctx.stay.store(true, Ordering::SeqCst);
            (AgentReply::StayAck { ok: true }, false)
        }
        AgentRequest::Shutdown => (AgentReply::ShutdownAck { ok: true }, true),
        AgentRequest::Inject {
            combo,
            pid,
            hwnd,
            delay_ms,
            force_focus,
        } => {
            // Gate on who is asking before doing any work: a session mismatch
            // or a foreign client is refused outright.
            if let Some(reason_key) = deny_reason(pipe, ctx) {
                return (AgentReply::inject_fail(reason_key), false);
            }
            (
                inject_one(ctx, &combo, pid, hwnd, delay_ms, force_focus),
                false,
            )
        }
    }
}

/// The security gate for an `inject`: same session, and the sibling `lume.exe`.
fn deny_reason(pipe: windows::Win32::Foundation::HANDLE, ctx: &Arc<Ctx>) -> Option<&'static str> {
    use windows::Win32::System::Pipes::{GetNamedPipeClientProcessId, GetNamedPipeClientSessionId};

    let mut client_pid = 0u32;
    if unsafe { GetNamedPipeClientProcessId(pipe, &mut client_pid) }.is_err() {
        return Some(reason::DENIED_CLIENT);
    }
    // Same session only — another session's user has no business here even if
    // the ACL somehow allowed it.
    let mut client_session = u32::MAX;
    if unsafe { GetNamedPipeClientSessionId(pipe, &mut client_session) }.is_ok() {
        if let Some(ours) = ctx.session {
            if client_session != ours {
                return Some(reason::DENIED_SESSION);
            }
        }
    }
    // And the caller must be the launcher that shipped beside us.
    let expected = ctx.allowed_client.to_string_lossy().to_ascii_lowercase();
    match input::exe_of_pid(client_pid) {
        Some((path, _)) if path.to_ascii_lowercase() == expected => None,
        _ => Some(reason::DENIED_CLIENT),
    }
}

/// Apply the rule's policy and inject once. Mirrors what the in-process
/// fallback does, but with a token that can actually reach the target.
fn inject_one(
    ctx: &Arc<Ctx>,
    combo: &str,
    pid: u32,
    hwnd: isize,
    delay_ms: u64,
    force_focus: bool,
) -> AgentReply {
    let delay = delay_ms.min(MAX_INJECT_DELAY_MS);
    if delay > 0 {
        std::thread::sleep(Duration::from_millis(delay));
    }

    // Re-check the foreground at the moment of sending: with a user-set delay
    // the target may have lost focus, and a hotkey must never land in an
    // unrelated application.
    if input::foreground_pid() != Some(pid) {
        if !force_focus {
            return AgentReply::inject_fail(reason::FOCUS_MOVED);
        }
        let Some(window) = input::target_window(hwnd, Some(pid)) else {
            return AgentReply::inject_fail(reason::NO_WINDOW);
        };
        if !input::force_foreground(window) {
            return AgentReply::inject_fail(reason::FOCUS_FAILED);
        }
    }

    match input::send_combo(combo) {
        Ok(0) => {
            // SendInput reports zero events when the input was blocked; MSDN
            // is explicit that the cause cannot be read from GetLastError, so
            // we infer it from the token comparison we *can* do.
            let target_higher = input::is_process_elevated(pid).unwrap_or(false);
            let key = if target_higher && !ctx.elevated {
                reason::NOT_ELEVATED
            } else if target_higher {
                reason::UIPI
            } else {
                reason::BLOCKED
            };
            AgentReply::inject_fail(key)
        }
        Ok(sent) => {
            ctx.sent_total.fetch_add(u64::from(sent), Ordering::Relaxed);
            AgentReply::inject_ok(sent)
        }
        Err(input::ComboError::BadCombo) => AgentReply::inject_fail(reason::BAD_COMBO),
        Err(input::ComboError::Unsupported) => AgentReply::inject_fail(reason::UNSUPPORTED),
    }
}

/// Exit the process once the agent has been idle (and unasked to stay).
fn spawn_idle_watchdog(ctx: &Arc<Ctx>) {
    let ctx = Arc::clone(ctx);
    let _ = std::thread::Builder::new()
        .name("agent-idle".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(5));
            if ctx.stay.load(Ordering::Relaxed) || ctx.active.load(Ordering::Relaxed) > 0 {
                continue;
            }
            let idle = now_millis().saturating_sub(ctx.last_activity.load(Ordering::Relaxed));
            if idle >= IDLE_EXIT_SECS * 1000 {
                std::process::exit(0);
            }
        });
}

// ---------------------------------------------------------------------------
// Tauri commands (settings 系统 page)
// ---------------------------------------------------------------------------

/// Report the helper's state. Never starts it — a status query must not spawn
/// a high-integrity process as a side effect.
#[tauri::command]
pub fn agent_status() -> Result<AgentStatus, String> {
    let info = ping();
    Ok(AgentStatus {
        installed: task_installed(),
        running: info.is_some(),
        elevated: info.as_ref().map(|i| i.elevated).unwrap_or(false),
        session: info.as_ref().map(|i| i.session),
        sent_total: info.as_ref().map(|i| i.sent_total).unwrap_or(0),
        bin_path: Some(agent_exe_path().to_string_lossy().into_owned()),
        task_name: TASK_PATH.to_string(),
        idle_exit_secs: IDLE_EXIT_SECS,
    })
}

/// Register the helper's scheduled task (one UAC prompt). The elevated
/// `lume-agent.exe --install-task` does the actual work and exits.
#[tauri::command]
pub fn agent_install() -> Result<(), String> {
    let exe = agent_exe_path();
    if !exe.exists() {
        return Err(format!("{AGENT_EXE} not found next to the launcher"));
    }
    crate::svc::launch_elevated(&exe, "--install-task")
}

/// Remove the task and stop the helper (one UAC prompt).
#[tauri::command]
pub fn agent_uninstall() -> Result<(), String> {
    let exe = agent_exe_path();
    if !exe.exists() {
        return Err(format!("{AGENT_EXE} not found next to the launcher"));
    }
    crate::svc::launch_elevated(&exe, "--uninstall-task")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_parses_each_verb() {
        assert_eq!(serde_json::from_str::<AgentRequest>(r#"{"t":"hello"}"#).unwrap(), AgentRequest::Hello);
        assert_eq!(serde_json::from_str::<AgentRequest>(r#"{"t":"stay"}"#).unwrap(), AgentRequest::Stay);
        assert_eq!(serde_json::from_str::<AgentRequest>(r#"{"t":"status"}"#).unwrap(), AgentRequest::Status);
        assert_eq!(
            serde_json::from_str::<AgentRequest>(r#"{"t":"shutdown"}"#).unwrap(),
            AgentRequest::Shutdown
        );
        assert!(serde_json::from_str::<AgentRequest>(r#"{"t":"nope"}"#).is_err());
        assert!(serde_json::from_str::<AgentRequest>("not json").is_err());
    }

    /// Omitted optional fields must default, so an older rule payload still parses.
    #[test]
    fn inject_defaults_delay_and_force_focus() {
        let r: AgentRequest =
            serde_json::from_str(r#"{"t":"inject","combo":"Ctrl+S","pid":7,"hwnd":99}"#).unwrap();
        assert_eq!(
            r,
            AgentRequest::Inject {
                combo: "Ctrl+S".into(),
                pid: 7,
                hwnd: 99,
                delay_ms: 0,
                force_focus: false,
            }
        );
    }

    /// The reply shape the client parses, including every failure reason key.
    #[test]
    fn replies_round_trip_and_parse() {
        let ok = AgentReply::inject_ok(2).to_wire();
        assert_eq!(ok, r#"{"t":"inject_ack","ok":true,"sent":2}"#);
        assert_eq!(parse_inject_ack(&ok), Ok(2));

        for key in [
            reason::UIPI,
            reason::BLOCKED,
            reason::NOT_ELEVATED,
            reason::FOCUS_MOVED,
            reason::FOCUS_FAILED,
            reason::NO_WINDOW,
            reason::BAD_COMBO,
            reason::UNSUPPORTED,
            reason::DENIED_SESSION,
            reason::DENIED_CLIENT,
        ] {
            let wire = AgentReply::inject_fail(key).to_wire();
            assert_eq!(parse_inject_ack(&wire), Err(key.to_string()));
        }
    }

    /// A malformed reply is `unavailable`, never a panic.
    #[test]
    fn malformed_reply_is_unavailable() {
        assert_eq!(parse_inject_ack("garbage"), Err(reason::UNAVAILABLE.into()));
        assert_eq!(
            parse_inject_ack(r#"{"t":"error","message":"bad json"}"#),
            Err(reason::UNAVAILABLE.into())
        );
    }

    /// Every reply variant must serialize to a `t`-tagged object.
    #[test]
    fn reply_tags_are_snake_case_wire_names() {
        assert!(AgentReply::HelloAck { ok: true, elevated: true, session: 1 }
            .to_wire()
            .starts_with(r#"{"t":"hello_ack""#));
        assert!(AgentReply::StayAck { ok: true }.to_wire().starts_with(r#"{"t":"stay_ack""#));
        assert!(AgentReply::ShutdownAck { ok: true }
            .to_wire()
            .starts_with(r#"{"t":"shutdown_ack""#));
        assert!(AgentReply::Status {
            elevated: true,
            session: 1,
            sent_total: 0,
            uptime_s: 0
        }
        .to_wire()
        .starts_with(r#"{"t":"status""#));
    }

    /// The client's status parse tolerates a partial reply.
    #[test]
    fn agent_info_defaults_missing_fields() {
        let info: AgentInfo = serde_json::from_str(r#"{"t":"status","elevated":true}"#).unwrap();
        assert!(info.elevated);
        assert_eq!(info.session, 0);
        assert_eq!(info.sent_total, 0);
    }

    /// The pipe ACL must scope to the user, never to `Authenticated Users`
    /// (that is the difference between a helper and a local privilege-escalation
    /// primitive).
    #[test]
    fn sddl_scopes_to_the_user_and_system_only() {
        let sddl = build_sddl("S-1-5-21-1-2-3-1001");
        assert_eq!(
            sddl,
            "D:(A;;GA;;;S-1-5-21-1-2-3-1001)(A;;GA;;;SY)"
        );
        assert!(!sddl.contains(";;;AU)"), "must not grant Authenticated Users: {sddl}");
        assert!(!sddl.contains(";;;WD)"), "must not grant Everyone: {sddl}");
    }

    /// The task definition carries the four settings the whole design rests on.
    #[test]
    fn task_xml_carries_the_load_bearing_settings() {
        let xml = task_xml(Path::new(r"C:\Program Files\Lume\lume-agent.exe"), "S-1-5-21-1-2-3-1001");
        assert!(xml.contains("<RunLevel>HighestAvailable</RunLevel>"), "silent elevation");
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"), "unlimited runtime");
        assert!(xml.contains("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>"));
        assert!(xml.contains("<LogonTrigger>"), "resident mode starts at logon");
        assert!(xml.contains("<Arguments>--serve</Arguments>"));
        // A path with spaces must be quoted for Task Scheduler.
        assert!(xml.contains(r#"<Command>"C:\Program Files\Lume\lume-agent.exe"</Command>"#));
        // …and one without spaces must not be (the Task Scheduler UI never quotes).
        let plain = task_xml(Path::new(r"C:\Lume\lume-agent.exe"), "S-1-5-21-1-2-3-1001");
        assert!(plain.contains(r"<Command>C:\Lume\lume-agent.exe</Command>"));
        assert!(!plain.contains(r#""C:\Lume"#));
    }

    /// The trigger and principal must both name the installing user.
    #[test]
    fn task_xml_pins_the_user_sid() {
        let xml = task_xml(Path::new(r"C:\Lume\lume-agent.exe"), "S-1-5-21-9-9-9-1001");
        assert_eq!(xml.matches("<UserId>S-1-5-21-9-9-9-1001</UserId>").count(), 2);
        assert!(xml.contains("<URI>Lume\\LumeAgent</URI>"));
    }

    /// Live round trip against a running agent: register it (设置/系统 →
    /// 注册代理) so the helper is up, then
    /// `cargo test -- --ignored live_agent`.
    ///
    /// Verifies the two things a unit test cannot: that the scoped pipe ACL
    /// actually lets this user's process in, and that the identity gate refuses
    /// a caller that is not the sibling `lume.exe` (the test harness is not).
    #[test]
    #[ignore] // requires the agent task registered and the agent running
    fn live_agent_answers_and_refuses_foreign_clients() {
        let info = status().expect("agent must answer — register it in 设置/系统 first");
        eprintln!(
            "agent: elevated={} session={} sent_total={} uptime={}s",
            info.elevated, info.session, info.sent_total, info.uptime_s
        );
        assert!(info.session > 0, "the agent must report its session");

        let err = inject("Ctrl+Alt+S", std::process::id(), 0, 0, false)
            .expect_err("a client that is not the sibling lume.exe must be refused");
        assert_eq!(err, reason::DENIED_CLIENT);
    }
}
