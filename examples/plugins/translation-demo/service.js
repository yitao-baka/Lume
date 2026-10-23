// Page Service for translation-demo. This is the only part that touches the
// network, cache, settings or secrets. The two Presenters only see the model.

const SCHEMA = "translator.translation/v1";
const ENGINES = [
  { id: "local", label: "Local translator" },
  { id: "upper", label: "Upper-case translator" },
];
const LANGS = [
  { id: "auto", label: "Auto" },
  { id: "zh", label: "Chinese" },
  { id: "en", label: "English" },
  { id: "ja", label: "Japanese" },
];

export default function create(ctx) {
  let revision = 0;
  let settings = { endpoint: "http://127.0.0.1:18765/translate", timeout_ms: "8000" };
  let sequence = 0;
  let activeCancel = null;
  const cache = new Map();
  let model = {
    sourceText: "",
    translatedText: "",
    sourceLang: "auto",
    targetLang: "en",
    engine: "local",
    engines: ENGINES,
    languages: LANGS,
    phase: "idle",
    requestId: 0,
    cacheHit: false,
    hasApiKey: false,
    timeoutMs: 8000,
    notice: "",
    actionTarget: {
      id: "translation",
      actions: ["translate", "cancel", "swap-languages", "select-engine"],
    },
  };

  function snapshot(status = model.phase === "error" ? "error" : "ready", error) {
    revision += 1;
    return {
      runtime: "lume.page/v1",
      schema: SCHEMA,
      revision,
      status,
      data: { ...model },
      actions: [
        { id: "translate", label: "Translate", kind: "primary" },
        { id: "cancel", label: "Cancel" },
        { id: "swap-languages", label: "Swap languages" },
        { id: "select-engine", label: "Select engine" },
      ],
      ...(error ? { error } : {}),
    };
  }

  function publish(status) {
    ctx.page.publish(snapshot(status));
  }

  async function refreshSecretState() {
    try {
      model.hasApiKey = await ctx.secrets.has("api_key");
    } catch {
      model.hasApiKey = false;
    }
  }

  async function loadCache() {
    try {
      const raw = await ctx.storage.get("translation-cache");
      if (raw && typeof raw === "object") {
        for (const [key, value] of Object.entries(raw)) cache.set(key, String(value));
      }
    } catch {}
  }

  async function saveCache() {
    const plain = {};
    const entries = [...cache.entries()].slice(-80);
    for (const [key, value] of entries) plain[key] = value;
    try { await ctx.storage.set("translation-cache", plain); } catch {}
  }

  async function translate() {
    const text = String(model.sourceText || "").trim();
    if (!text) {
      model.phase = "idle";
      model.notice = "Enter text";
      publish("empty");
      return;
    }
    await refreshSecretState();
    try {
      settings.endpoint = await ctx.settings.get("endpoint") || settings.endpoint;
      settings.timeout_ms = await ctx.settings.get("timeout_ms") || settings.timeout_ms;
    } catch {}
    model.timeoutMs = Math.max(1000, Math.min(60000, Number(settings.timeout_ms) || 8000));
    const key = [model.engine, model.sourceLang, model.targetLang, text].join("\u0000");
    const cached = cache.get(key);
    if (cached != null) {
      model.translatedText = cached;
      model.cacheHit = true;
      model.phase = "ready";
      model.notice = "";
      publish("ready");
      return;
    }
    const requestId = ++sequence;
    model.requestId = requestId;
    model.phase = "loading";
    model.cacheHit = false;
    model.notice = "";
    publish("loading");
    let secret = null;
    try { secret = await ctx.secrets.get("api_key"); } catch {}
    try {
      let abortRequest;
      const request = ctx.http.request({
        url: String(settings.endpoint || ""),
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(secret ? { authorization: "Bearer " + secret } : {}),
        },
        body: JSON.stringify({
          text,
          source: model.sourceLang,
          target: model.targetLang,
          engine: model.engine,
        }),
        timeoutMs: model.timeoutMs,
      });
      const timeout = new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("translation request timeout")), model.timeoutMs);
        abortRequest = () => { clearTimeout(timer); reject(new Error("translation canceled")); };
      });
      activeCancel = abortRequest;
      const response = await Promise.race([request, timeout]);
      activeCancel = null;
      if (requestId !== sequence) return;
      const body = response.json();
      model.translatedText = String(body.translation ?? "");
      model.phase = "ready";
      model.notice = "";
      cache.set(key, model.translatedText);
      await saveCache();
      publish("ready");
    } catch (err) {
      activeCancel = null;
      if (requestId !== sequence) return;
      model.phase = "error";
      model.notice = String(err && err.message ? err.message : err);
      publish("error", { code: "translation.failed", message: model.notice, retryable: true });
    }
  }

  return {
    async getModel() {
      await loadCache();
      await refreshSecretState();
      return snapshot("ready");
    },
    onQuery(query) {
      model.sourceText = String(query || "");
      publish("ready");
    },
    async onIntent(intent) {
      if (intent.type === "query.submit") {
        model.sourceText = String(intent.payload && intent.payload.query || model.sourceText || "");
        await translate();
        return { status: "completed" };
      }
      if (intent.type === "page.cancel") {
        sequence += 1;
        if (activeCancel) activeCancel();
        activeCancel = null;
        model.phase = "canceled";
        model.notice = "Canceled";
        publish("ready");
        return { status: "completed" };
      }
      if (intent.type === "item.action") {
        if (intent.actionId === "translate") {
          await translate();
          return { status: "completed" };
        }
        if (intent.actionId === "cancel") {
          sequence += 1;
          if (activeCancel) activeCancel();
          activeCancel = null;
          model.phase = "canceled";
          model.notice = "Canceled";
          publish("ready");
          return { status: "completed" };
        }
        if (intent.actionId === "swap-languages") {
          const source = model.sourceLang === "auto" ? "en" : model.sourceLang;
          model.sourceLang = model.targetLang;
          model.targetLang = source;
          publish("ready");
          return { status: "completed" };
        }
        if (intent.actionId === "select-engine") {
          const engine = String(intent.payload && intent.payload.engine || "");
          if (ENGINES.some((item) => item.id === engine)) {
            model.engine = engine;
            publish("ready");
            return { status: "completed" };
          }
          return { status: "failed", code: "engine.invalid", message: "Unknown engine" };
        }
      }
      return { status: "accepted" };
    },
    onSettings(values) {
      settings = { ...settings, ...values };
      publish("ready");
    },
    onShow() { publish("ready"); },
    onHide() {},
  };
}
