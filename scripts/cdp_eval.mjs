// Dev helper: connects to a WebView2 page and evaluates an expression,
// printing the JSON result. Used to verify the UI over CDP (docs/TESTING.md).
// Launch with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222,
// grab the page's webSocketDebuggerUrl from http://127.0.0.1:9222/json/list,
// then: node scripts/cdp_eval.mjs <wsUrl> <expr>
const wsUrl = process.argv[2];
const expr = process.argv[3];

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();

ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
};
const send = (method, params) =>
  new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

ws.onopen = async () => {
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  console.log(JSON.stringify(r.result?.result?.value ?? r, null, 2));
  ws.close();
  process.exit(0);
};
ws.onerror = (e) => {
  console.error("WS error:", e.message ?? e);
  process.exit(1);
};
