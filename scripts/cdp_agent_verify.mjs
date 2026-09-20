// Dev helper: end-to-end verification of the elevation agent (ROADMAP #22).
//
// Proves the whole client → pipe → inject path works without needing UAC:
//   1. starts lume-agent.exe --serve (unelevated — the *permission* part of the
//      feature is what the manual UAC steps in docs/TESTING.md cover)
//   2. starts Lume, which is the only client the agent accepts
//   3. invokes `test_automation_rule` for a real target program
//   4. asserts the key actually arrived, by sending that program a combo it
//      cannot ignore (Alt+F4 closes Notepad)
//   5. reports the agent's own event accounting (sent_total)
//
// Usage: node scripts/cdp_agent_verify.mjs
// Leaves nothing running: Notepad, the agent and Lume are cleaned up.
import { spawn, execSync } from "node:child_process";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";
const AGENT = "src-tauri/target/release/lume-agent.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};
const taskkill = (image) => {
  try { execSync(`taskkill /F /IM ${image} 2>NUL`, { stdio: "ignore" }); } catch {}
};
const running = (image) => {
  try {
    return execSync(`tasklist /FI "IMAGENAME eq ${image}" /NH`, { encoding: "utf8" }).includes(image);
  } catch { return false; }
};

taskkill("lume.exe");
taskkill("lume-agent.exe");
taskkill("Notepad3.exe");
await sleep(400);

// 1. The agent, plain `--serve` (no task needed for this verification).
const agent = spawn(AGENT, ["--serve"], { stdio: "ignore", detached: true });
await sleep(1200);
check("agent starts and stays up", running("lume-agent.exe"));

// 2. Lume, with CDP. It is `lume.exe` beside the agent, so the identity gate allows it.
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP not available on :" + CDP_PORT);
}

async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; pending.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  return { ws, send, evalJs };
}

const pages = (await getTargets()).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
if (!pages.length) { console.error("no Lume page target"); process.exit(1); }
const lume = await connect(pages[0].webSocketDebuggerUrl);
const invoke = (cmd, args = {}) =>
  lume.evalJs(`(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})))()`);

// 3. The agent reports itself to the GUI.
const status = JSON.parse(await invoke("agent_status"));
check("agent_status sees the running agent", status.running === true, JSON.stringify(status));
check("agent_status reports it unelevated (started by hand)", status.elevated === false, JSON.stringify(status));
check("agent_status carries the agent's session", typeof status.session === "number" && status.session > 0, JSON.stringify(status));
const sentBefore = status.sent_total;

// 4. A real target program, then an injection that it cannot ignore.
spawn("C:\\Windows\\System32\\notepad.exe", [], { stdio: "ignore", detached: true });
await sleep(2500);
// On this machine `notepad.exe` is hijacked to Notepad3.exe (same as the
// automation smoke test notes), so target the real process name.
check("notepad target is running", running("Notepad3.exe"));

const result = JSON.parse(
  await invoke("test_automation_rule", { process: "Notepad3", combo: "Alt+F4" }),
);
check("test_automation_rule reports success through the agent", result.ok === true, JSON.stringify(result));
check("the reported target is the real window owner", /Notepad3\.exe \(pid \d+\)/i.test(result.detail ?? ""), JSON.stringify(result));

// 5. The proof: Alt+F4 reached Notepad, so it closed.
await sleep(1200);
check("the injected Alt+F4 actually closed notepad", !running("Notepad3.exe"));

const after = JSON.parse(await invoke("agent_status"));
check("the agent counted the injected events", after.sent_total > sentBefore, JSON.stringify({ sentBefore, sentTotal: after.sent_total }));

// Cleanup.
lume.ws.close();
taskkill("Notepad3.exe");
taskkill("lume.exe");
try { process.kill(-agent.pid); } catch {}
taskkill("lume-agent.exe");

console.log(failures === 0 ? "[agent verify] ALL PASS" : `[agent verify] ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
