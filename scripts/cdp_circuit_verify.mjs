// One-off verify for the #32.4 circuit false-positive fix: a pure-view mode
// (file-search, no `entry`) must NEVER route onQuery/onSubInput into the
// logic relay — pre-fix, every summon's clearSearch() broadcast setQuery("")
// reached the supervisor, which silently dropped it (no frame, no token) and
// the registry burned the 8s timeout → 3 summons = circuit open toast
// 「文件秒搜」连续调用失败 without ever opening the plugin.
//
// Sequence: summon/hide ×3 (each cycle used to count one failure), wait past
// the 8s timeout, then assert __logicCircuit is clean. hello-mode (enabled
// for this run, has entry) proves the entry path still flows: its onQuery
// console.log is captured inside the logic frame via a console patch.
//
// Run against the built debug exe (no vite): rebuild first with
// `pnpm run tauri build --debug --no-bundle`. Settings: the script enables
// hello-mode for the run and restores settings.toml afterwards — the exe is
// killed BEFORE the restore so it cannot write its in-memory copy back.
import { spawn, execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETTINGS = "src-tauri/target/debug/settings/settings.toml";
const settingsOriginal = readFileSync(SETTINGS, "utf8");
const MARK = "# __circuit_verify__";

function enableHelloMode() {
  const edited = settingsOriginal.replace(/(\n\s*)"hello-mode",/, `$1${MARK} "hello-mode",`);
  if (edited === settingsOriginal) throw new Error("hello-mode not found in disabled list");
  writeFileSync(SETTINGS, edited);
}
function restoreSettings() {
  try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  writeFileSync(SETTINGS, settingsOriginal);
}

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch("http://127.0.0.1:9222/json/list")).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP unavailable");
}
function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  const send = (method, params) => new Promise((r) => { const k = ++id; p.set(k, r); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); }
  };
  return new Promise((res, rej) => {
    ws.onopen = () => res({ evalJs, close: () => ws.close() });
    ws.onerror = rej;
  });
}

let pass = false;
try {
  enableHelloMode();
  try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
  spawn("src-tauri/target/debug/lume.exe", [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
    stdio: "ignore",
  });
  mkdirSync("test", { recursive: true });

  let mainT = null, logicT = null;
  for (let i = 0; i < 40 && (!mainT || !logicT); i++) {
    const pages = (await getTargets()) ?? [];
    for (const t of pages) {
      try {
        if (t.url.includes("pluginLogic.html")) { logicT ??= t; continue; }
        if (t.type !== "page" || !(t.url.includes("tauri.localhost") || t.url.includes("localhost:1420"))) continue;
        const c = await connect(t.webSocketDebuggerUrl);
        const ok = await c.evalJs(`!!document.getElementById("search-input")`);
        c.close();
        if (ok) mainT ??= t;
      } catch {}
    }
    if (!mainT || !logicT) await sleep(500);
  }
  if (!mainT) throw new Error("main window missing");
  console.log("main window found; supervisor target:", !!logicT);

  const m = await connect(mainT.webSocketDebuggerUrl);
  // 隐藏窗口 evaluate 可能挂起（AGENTS.md 踩坑清单）→ 先呼出再查。
  await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`);
  await sleep(1500);

  // 正面探针（supervisor 的 __logicEntries，OOPIF 帧不在 /json/list）：
  // 1) hello-mode 的逻辑帧已 load（pushLogicLoad → 帧建 → load 成功）；
  // 2) 包住 entry.calls.set 记录 hook 派发，调用结束后 calls 清空 = 帧有回执
  //    （新守卫若误伤 entry 插件，这里会是 0 次派发或 calls 永不清空）。
  let helloPatched = false;
  if (logicT) {
    try {
      const h = await connect(logicT.webSocketDebuggerUrl);
      helloPatched = await h.evalJs(
        `(() => { const e = window.__logicEntries?.get("hello-mode");
           if (!e) return "no entry yet";
           window.__hookCalls = [];
           const orig = e.calls.set.bind(e.calls);
           e.calls.set = (k, v) => { if (v && v.kind === "hook") window.__hookCalls.push(k); return orig(k, v); };
           return e.loaded ? "patched (loaded)" : "patched (NOT loaded)"; })()`
      );
      h.close();
    } catch (err) {
      console.log("supervisor patch failed (positive probe skipped):", String(err).slice(0, 120));
    }
  }
  console.log("hello-mode probe:", helloPatched);

  // ── 复现序列：3 轮呼出/隐藏（修复前每轮 ≥1 次超时计数，第 3 次开熔断）──
  for (let i = 0; i < 3; i++) {
    await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`); // hide
    await sleep(1200);
    await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`); // show
    await sleep(1200);
  }
  // 等过 logicCall 的 8s 超时（若有泄漏调用，此处让它落账）。
  await sleep(9500);

  const circuit = await m.evalJs(
    `(() => { const c = window.__logicCircuit; return c ? {
       offline: [...c.offline], failCounts: Object.fromEntries(c.failCounts),
       log: c.log.map((e) => e.id + ": " + e.why) } : null; })()`
  );
  console.log("__logicCircuit:", JSON.stringify(circuit));

  let helloProbe = null;
  if (logicT) {
    try {
      const h = await connect(logicT.webSocketDebuggerUrl);
      helloProbe = await h.evalJs(
        `(() => { const e = window.__logicEntries?.get("hello-mode");
           return { loaded: e?.loaded ?? null,
                    hookDispatched: window.__hookCalls?.length ?? null,
                    callsLeft: e?.calls.size ?? null }; })()`
      );
      h.close();
    } catch {}
  }
  console.log("hello-mode probe:", JSON.stringify(helloProbe));

  const toast = await m.evalJs(
    `(() => { const el = document.querySelector(".toast"); return el ? el.textContent : null; })()`
  );
  console.log("toast:", JSON.stringify(toast));
  await m.evalJs(`window.__TAURI_INTERNALS__.invoke("toggle_launcher")`);

  const fails = circuit ? [...circuit.offline, ...Object.keys(circuit.failCounts)] : ["__logicCircuit missing"];
  pass = fails.length === 0;
  console.log(pass ? "PASS: circuit clean (no false-positive)" : `FAIL: circuit failures — ${fails.join(", ")}`);
  if (helloPatched && helloProbe) {
    // onMount clearSearch + 每轮 show/hide 各一次广播 → ≥3 次 onQuery hook；
    // callsLeft=0 = 帧对每次调用都有回执（守卫没把 entry 路径打断）。
    const n = helloProbe.hookDispatched ?? 0;
    if (helloProbe.loaded === true && n >= 3 && helloProbe.callsLeft === 0) {
      console.log(`PASS: entry-mode hooks still flow (loaded, ${n} dispatched, ${helloProbe.callsLeft} pending)`);
    } else {
      console.log(`FAIL: hello-mode entry path broken: ${JSON.stringify(helloProbe)}`);
      pass = false;
    }
  } else {
    console.log("WARN: positive probe unavailable (supervisor entry not found)");
  }
  if (toast && toast.includes("连续调用失败")) { console.log("FAIL: circuit toast visible"); pass = false; }
} catch (err) {
  console.error("VERIFY ERROR:", String(err).slice(0, 300));
} finally {
  restoreSettings();
}
process.exit(pass ? 0 : 1);
