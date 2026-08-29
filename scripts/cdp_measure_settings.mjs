// One-off: measure settings layout widths via CDP.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; pending.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value;
  };
  return { ws, evalJs };
}
const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
const pages = list.filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
for (const t of pages) {
  const c = await connect(t.webSocketDebuggerUrl);
  const isSettings = await c.evalJs(`document.body.classList.contains("settings-window")`);
  if (isSettings) {
    const m = await c.evalJs(`JSON.stringify({
      inner: window.innerWidth,
      main: document.querySelector(".settings-main")?.offsetWidth,
      body: document.querySelector(".settings-body")?.offsetWidth,
      group: document.querySelector(".settings-group")?.offsetWidth,
      groupCS: getComputedStyle(document.querySelector(".settings-group")).width,
    })`);
    console.log(m);
    await c.ws.close();
    break;
  }
  await c.ws.close();
}
process.exit(0);
