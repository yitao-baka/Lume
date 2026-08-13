// Dev helper: verify delete → undo toast → restore on the running launcher.
// Connects to whichever page hosts .search (the launcher), runs the flow.
const PORT = 9222;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(url) {
  const w = new WebSocket(url);
  let i = 0; const pend = new Map();
  w.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const snd = (method, params) => new Promise((res) => { const k = ++i; pend.set(k, res); w.send(JSON.stringify({ id: k, method, params })); });
  await new Promise((res, rej) => { w.onopen = res; w.onerror = rej; });
  const r = await snd("Runtime.evaluate", { expression: "!!document.querySelector('.search')", returnByValue: true });
  w.close();
  return r.result?.result?.value === true;
}

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === "page");
let wsUrl = null;
for (const t of targets) if (await probe(t.webSocketDebuggerUrl)) { wsUrl = t.webSocketDebuggerUrl; break; }
if (!wsUrl) { console.error("launcher not found"); process.exit(1); }

const ws = new WebSocket(wsUrl);
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

// Ensure we're in clipboard mode.
await evalJs(`window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true })); "tab"`);
await sleep(700);

const before = await evalJs(`document.querySelectorAll(".clip-row").length`);
const beforeTotal = await evalJs(`(document.querySelector(".clip-status-count")?.textContent || "").replace(/[^0-9]/g, "")`);
console.log("[undo] before: rendered rows =", before, "status total =", beforeTotal);

// Click the first row's delete button → 120ms animation → toast with undo.
await evalJs(`document.querySelector(".clip-row .clip-act-danger")?.click(); "del"`);
await sleep(500);
const toastText = await evalJs(`document.querySelector(".toast-text")?.textContent ?? null`);
const hasUndo = await evalJs(`!!document.querySelector(".toast-undo-btn")`);
const afterDel = await evalJs(`document.querySelectorAll(".clip-row").length`);
console.log("[undo] toast =", JSON.stringify(toastText), "undo btn =", hasUndo, "rows after del =", afterDel);

// Undo → the deleted row comes back.
await evalJs(`document.querySelector(".toast-undo-btn")?.click(); "undo"`);
await sleep(500);
const afterUndo = await evalJs(`document.querySelectorAll(".clip-row").length`);
console.log("[undo] rows after undo =", afterUndo);

// Clear-all dialog: open, check confirm + keep-pinned checkbox.
await evalJs(`document.querySelector(".clip-clear-btn")?.click(); "clear"`);
await sleep(300);
const confirmVisible = await evalJs(`!!document.querySelector(".clip-confirm")`);
const checkLabel = await evalJs(`document.querySelector(".clip-confirm-check span")?.textContent ?? null`);
console.log("[clear] confirm =", confirmVisible, "checkbox label =", JSON.stringify(checkLabel));
// Cancel.
await evalJs(`document.querySelector(".clip-confirm-cancel")?.click(); "cancel"`);
await sleep(200);
console.log("[clear] confirm after cancel =", await evalJs(`!!document.querySelector(".clip-confirm")`));

process.exit(0);
