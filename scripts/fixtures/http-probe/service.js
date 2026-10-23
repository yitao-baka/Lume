const SCHEMA = "lume.collection/v1";
export default function create(ctx) {
  let revision = 0;
  let running = false;
  let model = { phase: "idle", query: "", results: {}, notice: "等待 HTTP 探针", items: [], groups: [], total: 0, window: { offset: 0, limit: 1 } };
  function snapshot() { revision += 1; return { runtime: "lume.page/v1", schema: SCHEMA, revision, status: model.phase === "error" ? "error" : "ready", data: { ...model } }; }
  function publish() { ctx.page.publish(snapshot()); }
  function textOf(payload, query) {
    if (typeof payload === "string") return payload;
    if (payload && typeof payload.payload === "string") return payload.payload;
    if (payload && typeof payload.text === "string") return payload.text;
    return typeof query === "string" ? query : "";
  }
  function portFrom(value) { const match = String(value || "").match(/\d{2,5}/); return match ? Number(match[0]) : 0; }

  async function run(query) {
    if (running) return;
    const port = portFrom(query);
    model.query = String(query || "");
    if (!port) { model.phase = "error"; model.notice = "未提供本地探针端口"; publish(); return; }
    running = true;
    model.phase = "loading"; model.notice = "探测中…"; model.results = {}; publish();
    const results = { started: Date.now(), query: model.query, port };
    const base = "http://127.0.0.1:" + port;
    try {
      const t0 = Date.now();
      const res = await ctx.http.request({ url: base + "/json", timeoutMs: 5000 });
      results.json = { ms: Date.now() - t0, status: res && res.status, hasText: typeof (res && res.text), hasJson: typeof (res && res.json), textLen: res && res.text ? res.text().length : -1, ok: (() => { try { return res.json().ok === true; } catch { return false; } })(), contentType: res && res.headers && res.headers["content-type"], truncated: res && res.truncated };
    } catch (error) { results.json = { error: String(error) }; }
    try {
      const res = await ctx.http.request({ url: base + "/err", timeoutMs: 5000 });
      results.err = { status: res && res.status, body: res && res.text ? res.text() : null };
    } catch (error) { results.err = { error: String(error) }; }
    try {
      const t0 = Date.now();
      const res = await ctx.http.request({ url: base + "/slow?ms=12000", timeoutMs: 20000 });
      results.slow = { ms: Date.now() - t0, status: res && res.status, ok: (() => { try { return res.json().ok === true; } catch { return false; } })() };
    } catch (error) { results.slow = { error: String(error) }; }
    const hangStart = Date.now();
    try {
      const res = await ctx.http.request({ url: base + "/hang", timeoutMs: 3000 });
      results.hang = { ms: Date.now() - hangStart, resolved: res === undefined ? "undefined" : JSON.stringify(res).slice(0, 80) };
    } catch (error) { results.hang = { ms: Date.now() - hangStart, error: String(error) }; }
    try { await ctx.storage.get("no-such-doc"); results.afterHangRpc = "ok"; } catch (error) { results.afterHangRpc = "error: " + String(error); }
    results.finished = Date.now();
    model.results = results;
    model.phase = "ready";
    model.notice = "探针完成";
    running = false;
    await ctx.storage.set("probe", JSON.stringify(results));
    publish();
  }

  return {
    getModel() { return snapshot(); },
    onQuery(query) { model.query = String(query || ""); publish(); },
    onEnter(info) { const text = textOf(info); model.query = text; publish(); void run(text); },
    onShow() { publish(); },
  };
}
