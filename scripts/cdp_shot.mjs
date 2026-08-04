// Dev helper: capture a PNG screenshot of a WebView2 page via CDP.
// Usage: node scripts/cdp_shot.mjs <wsUrl> <out.png>
const { writeFileSync } = await import("node:fs");
const wsUrl = process.argv[2];
const out = process.argv[3];

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
  await send("Page.enable");
  const r = await send("Page.captureScreenshot", { format: "png" });
  const b64 = r.result?.data;
  if (b64) {
    writeFileSync(out, Buffer.from(b64, "base64"));
    console.log("saved " + out);
  } else {
    console.error("no screenshot data", r);
    process.exit(1);
  }
  ws.close();
  process.exit(0);
};
ws.onerror = (e) => {
  console.error("WS error:", e.message ?? e);
  process.exit(1);
};
