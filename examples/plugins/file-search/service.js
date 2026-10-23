const SCHEMA = "lume.collection/v1";

export default function create(ctx) {
  let revision = 0;
  let sequence = 0;
  let entries = [];
  let targets = new Map();
  let model = {
    query: "",
    backend: "unknown",
    indexStatus: "unknown",
    phase: "idle",
    empty: "输入以搜索全盘文件",
    notice: "",
    selectedId: null,
    items: [],
    total: 0,
    window: { offset: 0, limit: 0 },
  };

  function describeStatus(info) {
    if (!info) return model;
    model.backend = info.backend || "none";
    model.indexStatus = info.status || "unavailable";
    const files = info.svc && info.svc.files != null ? "（" + info.svc.files + " 个文件）" : "";
    if (model.backend === "everything") model.notice = "后端：Everything 运行中（实时索引）";
    else if (model.backend === "svc" && model.indexStatus === "ready") model.notice = "后端：LumeSVC USN 索引就绪" + files;
    else if (model.backend === "svc" && model.indexStatus === "building") model.notice = "后端：LumeSVC 索引构建中，结果可能不全" + files;
    else if (model.backend === "svc") model.notice = "后端：LumeSVC 索引不可用";
    else model.notice = "后端：不可用 — 需要 Everything 或 LumeSVC 服务";
    return model;
  }

  function snapshot(status) {
    revision += 1;
    return {
      runtime: "lume.page/v1",
      schema: SCHEMA,
      revision,
      status: status || (model.phase === "error" ? "error" : model.items.length ? "ready" : "empty"),
      data: { ...model },
      selection: model.selectedId ? { primaryId: model.selectedId, selectedIds: [model.selectedId] } : undefined,
      actions: [
        { id: "open", label: "Open", kind: "default" },
        { id: "reveal", label: "Open location" },
        { id: "copy-path", label: "Copy path" },
      ],
      ...(model.phase === "error" ? { error: { code: "search.failed", message: model.notice, retryable: true } } : {}),
    };
  }
  function publish(status) { ctx.page.publish(snapshot(status)); }

  function select(index) {
    if (!entries.length) {
      model.selectedId = null;
      return;
    }
    const next = Math.max(0, Math.min(entries.length - 1, index));
    model.selectedId = "file:" + next + ":" + entries[next].path;
    publish("ready");
  }

  return {
    async getModel() {
      try { describeStatus(await ctx.search.status()); } catch {}
      return snapshot("ready");
    },
    async onQuery(query) {
      const q = String(query || "");
      model.query = q;
      const token = ++sequence;
      model.items = [];
      model.total = 0;
      targets.clear();
      model.selectedId = null;
      if (!q) {
        model.phase = "idle";
        model.empty = "输入以搜索全盘文件";
        publish("empty");
        return;
      }
      model.phase = "loading";
      model.empty = "正在搜索…";
      publish("loading");
      try {
        const output = await ctx.search.files(q, 50);
        if (token !== sequence) return;
        entries = Array.isArray(output && output.entries) ? output.entries : [];
        model.backend = output && output.backend || "none";
        model.indexStatus = output && output.status || "unknown";
        model.items = entries.map((entry, index) => {
          const id = "file:" + index + ":" + entry.path;
          targets.set(id, { index, entry });
          return {
            id,
            label: entry.name,
            description: entry.path,
            source: entry.isFolder ? "folder" : "file",
            badges: [entry.isFolder ? "folder" : (entry.name.split(".").pop() || "file")],
            actions: ["open", "reveal", "copy-path"],
          };
        });
        model.total = model.items.length;
        model.window = { offset: 0, limit: model.items.length };
        model.selectedId = model.items[0] && model.items[0].id || null;
        model.phase = model.items.length ? "ready" : "empty";
        model.empty = output && output.status === "building" ? "索引构建中，结果可能不全" : "无结果";
        publish(model.phase);
      } catch (error) {
        if (token !== sequence) return;
        model.phase = "error";
        model.notice = String(error && error.message ? error.message : error);
        model.empty = "搜索后端不可用";
        publish("error");
      }
    },
    onShow() { publish(); },
    async onIntent(intent) {
      if (intent.type === "selection.move") {
        const current = entries.findIndex((entry, index) => model.items[index] && model.items[index].id === model.selectedId);
        select(current + Number(intent.payload && intent.payload.delta || 0));
        return { status: "completed" };
      }
      if (intent.type === "selection.set") {
        const id = intent.payload && intent.payload.selectedIds && intent.payload.selectedIds[0];
        const index = model.items.findIndex((item) => item.id === id);
        if (index >= 0) select(index);
        return { status: "completed" };
      }
      if (intent.type === "item.activate" || intent.type === "item.action") {
        const found = targets.get(intent.targetId);
        if (!found) return { status: "failed", code: "target.missing", message: "File row is missing" };
        const action = intent.type === "item.activate" ? "open" : String(intent.actionId || "");
        if (action === "copy-path") {
          await ctx.clipboard.writeText(found.entry.path);
          ctx.app.toast("已复制路径");
          return { status: "completed" };
        }
        if (action === "reveal") {
          await ctx.app.revealPath(found.entry.path);
          return { status: "completed" };
        }
        if (action === "open") {
          await ctx.app.openPath(found.entry.path);
          await ctx.app.hide();
          return { status: "completed" };
        }
        return { status: "failed", code: "action.unsupported", message: action };
      }
      return { status: "accepted" };
    },
  };
}
