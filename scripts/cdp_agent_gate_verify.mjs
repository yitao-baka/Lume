// 自动化「使用提权代理」开启前的注册校验（settings → automation）。
// Usage: pnpm run tauri build --debug --no-bundle
//        node scripts/cdp_agent_gate_verify.mjs
//
// 本机未注册代理时（本脚本的主路径）：
//  ① 已开启但未注册 → 该行摘要直接提示未注册
//  ② 点击关闭 → 立即生效、不弹窗（关闭方向不做检查）
//  ③ 再点击开启 → 弹模态提示，开关保持关闭（阻止开启）
//  ④ 弹窗主按钮跳转「系统」页
// 代理已注册时改走反向断言：点击开启直接生效（不弹窗），随后还原原值。
// 截图：test/agent-gate/gate.png、test/agent-gate/summary.png
import { spawn, execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";

const CDP_PORT = 9231;
const APP = "src-tauri/target/debug/lume.exe";
const OUT = "test/agent-gate";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (name, condition, extra = "") => {
  console.log(`[${condition ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
  if (!condition) failures++;
};

try { execSync("taskkill /F /T /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
try { execSync("taskkill /F /IM msedgewebview2.exe 2>NUL", { stdio: "ignore" }); } catch {}
await sleep(300);
mkdirSync(OUT, { recursive: true });
spawn(APP, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: "ignore",
});

async function getTargets() {
  for (let i = 0; i < 60; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); }
    catch { await sleep(250); }
  }
  throw new Error(`CDP not available on :${CDP_PORT}`);
}

async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  const send = (method, params) => new Promise((resolve) => {
    const key = ++id;
    pending.set(key, resolve);
    ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evalJs = async (expression) => {
    const reply = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (reply.result?.exceptionDetails) {
      throw new Error(reply.result.exceptionDetails.exception?.description ?? "eval failed");
    }
    return reply.result?.result?.value;
  };
  const shot = async (name) => {
    const image = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(image.result.data, "base64"));
  };
  return { ws, send, evalJs, shot };
}

let mainTarget = null;
let settings = null;
for (let attempt = 0; attempt < 60 && (!settings || !mainTarget); attempt++) {
  const pages = (await getTargets()).filter((target) =>
    target.type === "page" && target.url.includes("tauri.localhost"),
  );
  for (const page of pages) {
    if (page.webSocketDebuggerUrl === mainTarget?.webSocketDebuggerUrl) continue;
    try {
      const client = await connect(page.webSocketDebuggerUrl);
      const kind = await client.evalJs(`document.body.classList.contains('settings-window')
        ? 'settings'
        : document.querySelector('#search-input') ? 'main' : ''`);
      if (kind === "settings" && !settings) settings = client;
      else if (kind === "main" && !mainTarget) {
        mainTarget = page;
        client.ws.close();
      } else client.ws.close();
    } catch {}
  }
  if (!settings || !mainTarget) await sleep(250);
}
if (!settings || !mainTarget) throw new Error("main/settings targets missing");
const main = await connect(mainTarget.webSocketDebuggerUrl);
const invoke = (cmd, args) =>
  main.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args ?? null)})`);

const agent = JSON.parse(await main.evalJs(`(async () => JSON.stringify(
  await window.__TAURI_INTERNALS__.invoke("agent_status")))()`));
console.log("[agent_status]", JSON.stringify(agent));

const settingsBefore = JSON.parse(await main.evalJs(`(async () => JSON.stringify(
  await window.__TAURI_INTERNALS__.invoke("get_settings")))()`));
const initialUseAgent = settingsBefore.automation.use_agent === true;

await invoke("open_settings");
for (let i = 0; i < 40; i++) {
  if (await settings.evalJs(`!!document.querySelector('.settings-page-content')`)) break;
  await sleep(150);
}

const ROW = `document.querySelector('[data-setting-id="automation.use_agent"]')`;
const TOGGLE = `${ROW}.querySelector('.settings-toggle')`;
const state = () => settings.evalJs(`${TOGGLE}.getAttribute('aria-checked')`);
const dialogOpen = () => settings.evalJs(`!!document.querySelector('.settings-confirm')`);
async function waitFor(fn, ms = 3000) {
  for (let waited = 0; waited < ms; waited += 100) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

await settings.evalJs(`document.querySelector('.settings-nav[data-section="automation"]')?.click(); true`);
await waitFor(async () => await settings.evalJs(`!!document.querySelector('[data-setting-id="automation.use_agent"]')`));

if (!agent.installed) {
  // ① 已开启但未注册 → 行摘要提示未注册（默认值即开启，这是常见的初始态）
  // 摘要来自进入本页时的一次异步探测，等它落地再断言。
  const summaryText = () =>
    settings.evalJs(`${ROW}.querySelector('.settings-row-summary')?.textContent ?? ''`);
  const hintShown = await waitFor(async () => /未注册|not registered/i.test(await summaryText()), 4000);
  check("未注册 + 已开启时行摘要提示未注册", hintShown, JSON.stringify(await summaryText()));
  await settings.shot("summary");

  // ④ 关闭方向不做检查：先把开关关掉（若本来就是开的）
  if ((await state()) === "true") {
    await settings.evalJs(`${TOGGLE}.click(); true`);
    check(
      "关闭提权代理不弹窗、立即生效",
      (await waitFor(async () => (await state()) === "false")) && !(await dialogOpen()),
      `state=${await state()}`,
    );
  } else {
    console.log("[SKIP] 关闭方向（初始值即为关闭）");
  }

  // ③ 点击开启 → 弹模态提示，且开关保持关闭
  await settings.evalJs(`${TOGGLE}.click(); true`);
  const opened = await waitFor(dialogOpen);
  const title = await settings.evalJs(`document.querySelector('.settings-confirm-title')?.textContent ?? ''`);
  const stateWithDialog = await state();
  check(
    "未注册时开启 → 弹模态提示且开关保持关闭",
    opened && /未注册|not registered/i.test(title) && stateWithDialog === "false",
    JSON.stringify({ opened, title, state: stateWithDialog }),
  );
  await settings.shot("gate");

  // ④ 主按钮跳转「系统」页
  await settings.evalJs(`document.querySelector('.settings-confirm .settings-action-primary')?.click(); true`);
  const navigated = await waitFor(async () =>
    (await settings.evalJs(`document.querySelector('.settings-nav.active')?.dataset.section`)) === "system");
  check("弹窗主按钮跳转「系统」页", navigated && !(await dialogOpen()));
  await settings.shot("system");
} else {
  // 反向断言：已注册 → 开启直接生效（不弹窗），再点一次还原
  const before = await state();
  await settings.evalJs(`${TOGGLE}.click(); true`);
  const flipped = await waitFor(async () => (await state()) !== before);
  check("已注册时代理开关直接生效（无弹窗）", flipped && !(await dialogOpen()),
    JSON.stringify({ before, after: await state() }));
  await settings.evalJs(`${TOGGLE}.click(); true`);
  await waitFor(async () => (await state()) === before);
  check("反向断言后开关还原", (await state()) === before);
}

// 还原 use_agent 原值（未注册时界面无法把它打开，只能走命令）
const after = JSON.parse(await main.evalJs(`(async () => JSON.stringify(
  await window.__TAURI_INTERNALS__.invoke("get_settings")))()`));
if (after.automation.use_agent !== initialUseAgent) {
  await invoke("save_settings_patch", { patch: { automation: { use_agent: initialUseAgent } } });
  const restored = JSON.parse(await main.evalJs(`(async () => JSON.stringify(
    await window.__TAURI_INTERNALS__.invoke("get_settings")))()`));
  check("测试后还原 automation.use_agent", restored.automation.use_agent === initialUseAgent,
    `initial=${initialUseAgent} now=${restored.automation.use_agent}`);
} else {
  console.log("[PASS] automation.use_agent 未被改动");
}

console.log(`\n${failures} failures`);
process.exit(failures === 0 ? 0 : 1);
