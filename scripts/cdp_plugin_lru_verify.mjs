// LRU 淘汰语义 + 新 enter 优先 端到端验证（docs/ROADMAP_HISTORY.md #42）：
//   ① 一次超上限只淘汰 LRU 一页（旧实现的同步淘汰循环会把候选整批淘汰）；
//   ② 淘汰帧快照不会覆盖之后到达的新 enter payload（onEnter 作废陈旧帧）。
//
// 夹具：examples/plugins/state-probe + 7 个脚本生成的极简 mode 插件
// （lru-fill-1..7）。流程：
//   A 打开 state-probe，种下 n=7 / #src=pre-lru；
//   B 依次访问 7 个填充模式 → 第 9 个挂载触发一次淘汰（victim = state-probe）；
//   C 回导航页，用 "sp:new-lru" 特征行重进 → #src 必须 = sp:new-lru、
//     n 必须没有被旧快照（custom/auto）回填成 7。
import { spawn, execSync } from "node:child_process";
import { mkdirSync, rmSync, cpSync, openSync, writeFileSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
const PORT = 9236;
const FILLERS = Array.from({ length: 7 }, (_, i) => `lru-fill-${i + 1}`);
mkdirSync("test", { recursive: true });
rmSync(`${BASE}/plugins/state-probe`, { recursive: true, force: true });
cpSync("examples/plugins/state-probe", `${BASE}/plugins/state-probe`, { recursive: true });
for (const [i, id] of FILLERS.entries()) {
  const dir = `${BASE}/plugins/${id}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/plugin.toml`, [
    `id = "${id}"`,
    `name = "LRU Fill ${i + 1}"`,
    `version = "1.0.0"`,
    `kind = "mode"`,
    `description = "LRU 淘汰验证填充模式（脚本生成，可删）"`,
    `view = "view.html"`,
    "",
  ].join("\n"));
  writeFileSync(`${dir}/view.html`, [
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>fill</title></head>",
    `<body style="font:13px sans-serif;padding:14px">LRU fill ${i + 1} — keep-alive 占位页</body></html>`,
    "",
  ].join("\n"));
}
const logFd = openSync("test/plugin_lru_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP unavailable");
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; p.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) throw new Error(String(r.result.exceptionDetails.exception?.description ?? "eval failed"));
    return r?.result?.result?.value;
  };
  return { ws, send, evalJs };
}
async function findWindow(match, probe) {
  for (let i = 0; i < 40; i++) {
    const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes(match));
    for (const t of pages) {
      try {
        const c = await connect(t.webSocketDebuggerUrl);
        const ok = probe ? await probe(c) : true;
        if (ok) return { target: t, conn: c };
        c.ws.close();
      } catch {}
    }
    await sleep(400);
  }
  return null;
}

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  console.log((ok ? "PASS" : "FAIL") + " " + name + (ok ? "" : (extra ? " — " + extra : "")));
  ok ? pass++ : fail++;
};

const mainT = await findWindow("tauri.localhost", async (c) => {
  const ok = await c.evalJs(`!!document.getElementById("search-input")`);
  c.ws.close();
  return ok;
});
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
// The probe socket was closed by findWindow's check — reconnect for real use
// (same pattern as cdp_plugin_state_verify).
const m = await connect(mainT.target.webSocketDebuggerUrl);
const invoke = (cmd, args = {}) => m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const clickPill = async (label) => {
  for (let i = 0; i < 20; i++) {
    const hit = await m.evalJs(`(() => {
      const el = [...document.querySelectorAll(".mode-switch-item")].find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!el) return false; el.click(); return true;
    })()`);
    if (hit) return true;
    await sleep(400);
  }
  return false;
};
const clickRow = async (label) => {
  for (let i = 0; i < 15; i++) {
    const hit = await m.evalJs(`(() => {
      const el = [...document.querySelectorAll(".result-box")].find((b) => b.textContent.includes(${JSON.stringify(label)}));
      if (!el) return false; el.click(); return true;
    })()`);
    if (hit) return true;
    await sleep(400);
  }
  return false;
};
// Latest reported field value from a view frame (name "" = view frames).
const readField = (id) => m.evalJs(`(() => {
  const st = (window.__frameStates || []).filter((s) => s.name === "");
  for (let i = st.length - 1; i >= 0; i--) {
    const v = (st[i].values || []).find((x) => x.id === ${JSON.stringify(id)});
    if (v) return v.value;
  }
  return null;
})()`);
const expectField = async (id, want, tries = 20) => {
  for (let i = 0; i < tries; i++) {
    const v = await readField(id);
    if (v != null && String(v) === String(want)) return true;
    await sleep(350);
  }
  return false;
};
const sessionTap = () => m.evalJs(`JSON.stringify(window.__sessionFrames ?? [])`);

await invoke("set_plugin_enabled", { id: "state-probe", enabled: true });
await sleep(1200);
await invoke("toggle_launcher");
await sleep(1500);

// ═══ A. seed state-probe ═══
check("A: open state-probe", await clickPill("State Probe"));
// The iframe loads asynchronously — wait for the first frame-state report
// before driving it (a query typed into the void is replayed as the LAST
// query only, so an earlier "js:7" would be lost).
let live = false;
for (let i = 0; i < 30 && !live; i++) {
  live = (await readField("src")) != null;
  if (!live) await sleep(300);
}
check("A: view frame live", live, "no #src report");
await type("js:7");
check("A: seeded js counter = 7", await expectField("jsn", "7", 8), String(await readField("jsn")));
await type("src:pre-lru");
check("A: seeded #src = pre-lru", await expectField("src", "pre-lru", 8), String(await readField("src")));

// ═══ B. overflow the 8-page cap exactly once ═══
for (const f of FILLERS) {
  const ok = await clickPill(`LRU Fill ${FILLERS.indexOf(f) + 1}`);
  check(`B: visit ${f}`, ok);
  await sleep(900);
}
await sleep(2500);
const hosts = await m.evalJs(`JSON.stringify([...document.querySelectorAll(".mode-host")].map((h) => h.dataset.mode))`);
const hostList = JSON.parse(hosts);
check("B: cap holds (8 live hosts)", hostList.length === 8, hosts);
check("B: LRU victim state-probe unmounted", !hostList.includes("state-probe"), hosts);
check("B: every newer page survives", FILLERS.every((f) => hostList.includes(f)), hosts);
let tap = JSON.parse(await sessionTap());
const evicts = tap.filter((e) => e.op === "evict");
check("B: exactly one eviction for one overflow", evicts.length === 1, JSON.stringify(evicts));
check("B: victim evicted with a view snapshot", evicts[0]?.id === "state-probe" && tap.some((e) => e.op === "put" && e.id === "state-probe" && e.frame === "view" && e.ok), JSON.stringify(tap));

// ═══ C. re-enter with a NEW payload — it must beat the stale frame ═══
check("C: back to home", await clickPill("导航"));
await sleep(500);
await type("sp:new-lru");
await sleep(700);
check("C: feature row visible", await clickRow("State Probe：注入"));
await sleep(5200); // ready handshake + the 4s restore-correction window
const activePill = await m.evalJs(`document.querySelector(".mode-switch-item.active")?.textContent?.trim() ?? ""`);
check("C: re-entered state-probe", activePill.includes("State Probe"), activePill);
const srcC = await readField("src");
const nC = await readField("jsn");
check("C: new enter payload won (#src = sp:new-lru)", srcC === "sp:new-lru", String(srcC));
check("C: stale custom/auto state NOT restored (js counter empty)", nC !== "7", String(nC));
tap = JSON.parse(await sessionTap());
check("C: stale frame cleared on the new enter (drop-all, no take)",
  tap.some((e) => e.op === "drop-all" && e.id === "state-probe") &&
    !tap.some((e) => e.op === "take" && e.id === "state-probe" && (e.frames ?? []).includes("view")),
  JSON.stringify(tap));

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
for (const f of FILLERS) rmSync(`${BASE}/plugins/${f}`, { recursive: true, force: true });
console.log(`\nLRU-VERIFY ${pass}/${pass + fail}`);
console.log(fail === 0 ? "LRU-VERIFY-ALL-PASS" : `LRU-VERIFY-FAILURES=${fail}`);
process.exit(fail === 0 ? 0 : 1);
