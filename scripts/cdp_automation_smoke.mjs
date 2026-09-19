// Dev helper: 自动化 (auto-actions) recorder smoke test.
//  1. 自动化 section renders (master toggle + empty state + add row)
//  2. the shortcut control is a press-to-record button, not a text field
//  3. the program field accepts typed text
//  4. recording Ctrl+Alt+S validates and commits the combo
//  5. a modifier-less key is rejected with the need-modifier message
//  6. Esc cancels recording
//  7. Add commits a rule row; the rule renders with its program + combo
//  8. an armed recorder never blocks typing in the program field
// Screenshots: test/automation_*.png
// Usage: node scripts/cdp_automation_smoke.mjs
import { spawn, execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const CDP_PORT = 9222;
const APP = "src-tauri/target/release/lume.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}
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

async function findSettingsTarget() {
  const pages = (await getTargets()).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    const c = await connect(t.webSocketDebuggerUrl);
    const isSettings = await c.evalJs(`document.body.classList.contains("settings-window")`);
    if (isSettings) return { settingsT: t, mainT: pages.find((p) => p !== t) };
    c.ws.close();
  }
  return {};
}

/** Type `text` into the focused element (real text insertion → input events). */
async function type(s, text) {
  await s.send("Input.insertText", { text });
  await sleep(60);
}

/** Press a combination (modifiers bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8). */
async function press(s, { code, key, vk, modifiers = 0 }) {
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers, code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  await sleep(40);
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers, code, key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}

let settingsT = null, mainT = null;
for (let i = 0; i < 30 && !settingsT; i++) {
  ({ settingsT, mainT } = await findSettingsTarget());
  if (!settingsT) await sleep(500);
}
if (!settingsT || !mainT) { console.error("targets missing"); process.exit(1); }

const m = await connect(mainT.webSocketDebuggerUrl);
await m.evalJs(`document.querySelector('.icon-btn[aria-label]')?.click(); "clicked"`);
await sleep(1200);
const s = await connect(settingsT.webSocketDebuggerUrl);
await sleep(600);

// 自动化 nav (matched by its icon so this stays language-agnostic)
await s.evalJs(`(() => { const navs = Array.from(document.querySelectorAll('.settings-nav'));
  (navs.find((b) => /automation/.test(b.querySelector('img')?.src ?? "")) ?? navs[6])?.click(); return "ok"; })()`);
await sleep(300);

const P = `document.querySelector('.settings-listadd input.settings-text-input')`;
const R = `document.querySelector('.settings-listadd .settings-hotkey-btn')`;
const D = `document.querySelector('.settings-listadd .settings-delay-input')`;

// 1. structure
const shape = await s.evalJs(`({
  toggles: document.querySelectorAll('.settings-group .settings-toggle').length,
  empty: document.querySelector('.settings-empty')?.textContent ?? "",
  textInputs: document.querySelectorAll('.settings-listadd input.settings-text-input').length,
  recorders: document.querySelectorAll('.settings-listadd .settings-hotkey-btn').length,
  delayFields: document.querySelectorAll('.settings-listadd .settings-delay-input').length,
})`);
check("自动化 renders master toggle + empty state", shape.toggles >= 2 && shape.empty.length > 0, JSON.stringify(shape));
check("shortcut is a recorder button, not a second text field",
  shape.recorders === 1 && shape.textInputs === 1, JSON.stringify(shape));
check("延迟触发 number field is present", shape.delayFields === 1, JSON.stringify(shape));

// 抢回焦点 policy toggle: starts off, flips on and marks the settings dirty.
const forceFocus = await s.evalJs(`(() => {
  const toggles = document.querySelectorAll('.settings-group .settings-toggle');
  const t = toggles[1]; // [0] = 启用自动动作, [1] = 抢回焦点
  const before = t.classList.contains('on');
  t.click();
  return { before, after: t.classList.contains('on') };
})()`);
await sleep(200);
const dirtyAfterToggle = await s.evalJs(`!document.querySelector('.settings-footer .settings-action-primary').disabled`);
check("抢回焦点 toggle defaults off, flips on, and marks the settings dirty",
  forceFocus.before === false && forceFocus.after === true && dirtyAfterToggle === true,
  JSON.stringify({ ...forceFocus, dirtyAfterToggle }));
// put it back so the rest of the run uses the safe default
await s.evalJs(`document.querySelectorAll('.settings-group .settings-toggle')[1].click(); "reset"`);
await sleep(150);

// 2. the program field must accept typed text
await s.evalJs(`${P}.focus(); "focused"`);
await type(s, "notepad");
await sleep(250);
const typed = await s.evalJs(`${P}.value`);
check("program field accepts typed text", typed === "notepad", JSON.stringify(typed));
await s.evalJs(`(() => { const i = ${P}; i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);

// 3. record Ctrl+Alt+S
await s.evalJs(`${R}.click(); "armed"`);
await sleep(200);
const armed = await s.evalJs(`${R}.classList.contains('active')`);
check("recorder arms on click", armed === true);
await press(s, { code: "KeyS", key: "s", vk: 83, modifiers: 3 });
await sleep(400);
const recorded = await s.evalJs(`({
  text: ${R}?.textContent.trim(),
  active: ${R}?.classList.contains('active'),
  addDisabled: document.querySelector('.settings-listadd .settings-icon-btn')?.disabled,
})`);
check("Ctrl+Alt+S is captured and armed state clears",
  recorded.text === "Ctrl+Alt+S" && recorded.active === false, JSON.stringify(recorded));

// 4. an ARMED recorder must not block typing in the program field
await s.evalJs(`${R}.click(); "armed again"`);
await sleep(150);
const armed2 = await s.evalJs(`${R}.classList.contains('active')`);
await s.evalJs(`${P}.focus(); "focused program"`);
await sleep(150);
await type(s, "abc");
await sleep(250);
const afterTyping = await s.evalJs(`({ value: ${P}.value, recorderActive: ${R}.classList.contains('active') })`);
check("typing works even with the recorder armed (it cancels on focus change)",
  armed2 === true && afterTyping.value === "abc", JSON.stringify({ armed2, ...afterTyping }));
await s.evalJs(`(() => { const i = ${P}; i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);

// 5. add the rule (program typed for real, combo re-recorded, custom delay)
await s.evalJs(`${P}.focus(); "focused"`);
await type(s, "notepad.exe");
await s.evalJs(`${R}.click(); "armed"`);
await sleep(150);
await press(s, { code: "KeyS", key: "s", vk: 83, modifiers: 3 });
await sleep(400);
const defaultDelay = await s.evalJs(`${D}?.value`);
check("delay field defaults to 120 ms", defaultDelay === "120", JSON.stringify(defaultDelay));
// set a custom delay through the field
await s.evalJs(`(() => { const d = ${D}; d.value = "2500"; d.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(150);
// an out-of-range value must clamp to 60000
await s.evalJs(`(() => { const d = ${D}; d.value = "999999"; d.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(150);
const clamped = await s.evalJs(`${D}?.value`);
check("delay clamps above 60000", clamped === "60000", JSON.stringify(clamped));
await s.evalJs(`(() => { const d = ${D}; d.value = "2500"; d.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(150);
const readyToAdd = await s.evalJs(`({ program: ${P}.value, combo: ${R}.textContent.trim(), delay: ${D}.value, addDisabled: document.querySelector('.settings-listadd .settings-icon-btn')?.disabled })`);
check("program + shortcut + delay ready to add", readyToAdd.program === "notepad.exe" && readyToAdd.combo === "Ctrl+Alt+S" && readyToAdd.delay === "2500" && readyToAdd.addDisabled === false, JSON.stringify(readyToAdd));
let shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/automation_recorded.png", Buffer.from(shot.result.data, "base64"));

await s.evalJs(`document.querySelector('.settings-listadd .settings-icon-btn').click(); "added"`);
await sleep(300);
const rows = await s.evalJs(`Array.from(document.querySelectorAll('.settings-listrow')).map((r) => r.textContent.trim())`);
check("rule row renders with program + combo",
  rows.length === 1 && rows[0].includes("notepad.exe") && rows[0].includes("Ctrl+Alt+S"), JSON.stringify(rows));
const rowDelay = await s.evalJs(`document.querySelector('.settings-listrow .settings-delay-input')?.value`);
check("rule row keeps the per-rule delay", rowDelay === "2500", JSON.stringify(rowDelay));
// the add-row draft resets to the default delay
const draftDelay = await s.evalJs(`${D}?.value`);
check("add-row draft resets the delay to the default", draftDelay === "120", JSON.stringify(draftDelay));
// editing the rule's own delay persists in the working copy
await s.evalJs(`(() => { const d = document.querySelector('.settings-listrow .settings-delay-input'); d.value = "800"; d.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(200);
const editedDelay = await s.evalJs(`document.querySelector('.settings-listrow .settings-delay-input')?.value`);
check("per-rule delay is editable", editedDelay === "800", JSON.stringify(editedDelay));

// 6. a modifier-less key must be rejected (keeps recording + shows a reason)
await s.evalJs(`${R}.click(); "armed"`);
await sleep(150);
await press(s, { code: "KeyK", key: "k", vk: 75 });
await sleep(400);
const rejected = await s.evalJs(`({
  active: ${R}.classList.contains('active'),
  error: document.querySelector('.settings-listadd .settings-error')?.textContent ?? null,
})`);
check("modifier-less key is rejected with a message and stays recording",
  rejected.active === true && (rejected.error ?? "").length > 0, JSON.stringify(rejected));
shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/automation_rejected.png", Buffer.from(shot.result.data, "base64"));

// 7. Esc cancels recording
await press(s, { code: "Escape", key: "Escape", vk: 27 });
await sleep(250);
check("Esc cancels recording", (await s.evalJs(`${R}.classList.contains('active')`)) === false);

// 8. 选择 picker — lists the programs that currently have windows.
// Launch a real windowed app so the assertion is deterministic.
const notepad = spawn("notepad.exe", [], { detached: true, stdio: "ignore" });
notepad.unref?.();
await sleep(3000);
await s.evalJs(`document.querySelector('.settings-pick-btn').click(); "opened"`);
await sleep(700);
const picker = await s.evalJs(`({
  open: !!document.querySelector('.picker'),
  title: document.querySelector('.picker-title')?.textContent ?? "",
  rows: document.querySelectorAll('.picker-row').length,
  names: Array.from(document.querySelectorAll('.picker-name')).map((n) => n.textContent.trim()),
  filteredShowsPaths: Array.from(document.querySelectorAll('.picker-path')).every((p) => (p.textContent ?? "").includes("\\\\")),
})`);
check("picker opens and lists windowed programs", picker.open && picker.rows > 0, JSON.stringify({ rows: picker.rows }));
check("every row shows the executable path", picker.filteredShowsPaths === true);
check("a real windowed app (notepad*) is detected",
  picker.names.some((n) => n.toLowerCase().includes("notepad")), JSON.stringify(picker.names.slice(0, 10)));
shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/automation_picker.png", Buffer.from(shot.result.data, "base64"));

// filter narrows the list
await s.evalJs(`(() => { const f = document.querySelector('.picker-filter'); f.value = "notepad"; f.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(250);
const filtered = await s.evalJs(`Array.from(document.querySelectorAll('.picker-name')).map((n) => n.textContent.trim())`);
check("filter narrows the picker list",
  filtered.length >= 1 && filtered.every((n) => n.toLowerCase().includes("notepad")), JSON.stringify(filtered));

// picking a row fills the program field and closes the picker
await s.evalJs(`(() => { const f = document.querySelector('.picker-filter'); f.value = ""; f.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
await sleep(250);
// Match loosely: on this machine the notepad handler is Notepad3.exe.
const targetName = await s.evalJs(`(() => {
  const row = Array.from(document.querySelectorAll('.picker-row'))
    .find((r) => r.querySelector('.picker-name').textContent.trim().toLowerCase().includes("notepad"));
  const name = row?.querySelector('.picker-name').textContent.trim() ?? null;
  row?.click();
  return name;
})()`);
await sleep(300);
const picked = await s.evalJs(`({ program: ${P}.value, pickerOpen: !!document.querySelector('.picker') })`);
check("picking fills the program field and closes the picker",
  !!targetName && picked.program === targetName && picked.pickerOpen === false,
  JSON.stringify({ targetName, ...picked }));

// Esc closes the picker without touching the field
await s.evalJs(`document.querySelector('.settings-pick-btn').click(); "opened"`);
await sleep(400);
await press(s, { code: "Escape", key: "Escape", vk: 27 });
await sleep(300);
check("Esc closes the picker", (await s.evalJs(`!!document.querySelector('.picker')`)) === false);

// 9. 「测试」 fires a rule on demand, ignoring the new-window trigger.
const notepadPid = execSync(
  `powershell -NoProfile -Command "(Get-Process Notepad3 -ErrorAction SilentlyContinue | Select-Object -First 1).Id"`,
  { encoding: "utf8" }
).trim();
console.log("[notepad pid]", notepadPid || "(none)");
check("rule row has a 测试 button",
  (await s.evalJs(`document.querySelectorAll('.settings-listrow .settings-test-btn').length`)) === 1);

// The picker test left "Notepad3.exe" (this machine's real notepad) in the add
// row — record a combo for it and add a second rule that can actually be tested.
await s.evalJs(`${R}.click(); "armed"`);
await sleep(150);
await press(s, { code: "KeyS", key: "s", vk: 83, modifiers: 3 });
await sleep(400);
check("add row now targets the running notepad",
  (await s.evalJs(`${P}.value`)) === "Notepad3.exe", await s.evalJs(`${P}.value`));
await s.evalJs(`document.querySelector('.settings-listadd .settings-icon-btn').click(); "added"`);
await sleep(300);
const rowsAfter = await s.evalJs(`document.querySelectorAll('.settings-listrow').length`);
check("second rule added", rowsAfter === 2, JSON.stringify(rowsAfter));

// Command-level: happy path, not-running, and unsendable shortcut.
const call = (args) =>
  s.evalJs(`(async () => JSON.stringify(await window.__TAURI_INTERNALS__.invoke("test_automation_rule", ${JSON.stringify(args)})))()`);

const testOk = JSON.parse(await call({ process: "Notepad3.exe", combo: "Ctrl+Alt+S" }));
check("test_automation_rule sends to the running target",
  testOk.ok === true && /Notepad3\.exe \(pid \d+\)/.test(testOk.detail), JSON.stringify(testOk));

const testMissing = JSON.parse(await call({ process: "definitely-not-running.exe", combo: "Ctrl+Alt+S" }));
check("test_automation_rule reports a program that is not running",
  testMissing.ok === false && testMissing.reason === "not_running", JSON.stringify(testMissing));

const testBadCombo = JSON.parse(await call({ process: "Notepad3.exe", combo: "nonsense" }));
check("test_automation_rule rejects an unsendable shortcut",
  testBadCombo.ok === false && testBadCombo.reason === "invalid_combo", JSON.stringify(testBadCombo));

// The button itself goes through the same command and reports the outcome.
await s.evalJs(`document.querySelectorAll('.settings-listrow .settings-test-btn')[1].click(); "clicked"`);
await sleep(1200);
const toastText = await s.evalJs(`document.querySelector('.settings-toast')?.textContent ?? ""`);
check("测试 button reports the outcome for the targeted program",
  toastText.includes("Notepad3.exe"), JSON.stringify(toastText));
shot = await s.send("Page.captureScreenshot", { format: "png" });
writeFileSync("test/automation_test_button.png", Buffer.from(shot.result.data, "base64"));

try { execSync("taskkill /F /IM notepad.exe 2>NUL", { stdio: "ignore" }); } catch {}

console.log(failures === 0 ? "[automation smoke] ALL PASS" : `[automation smoke] ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
