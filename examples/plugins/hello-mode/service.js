const SCHEMA = "lume.collection/v1";

export default function create(ctx) {
  let revision = 0;
  let model = {
    query: "",
    enter: null,
    count: 0,
    clipboardText: "",
    subInputText: "",
    subInputActive: false,
    theme: { pref: "system", mode: "dark", host: "dark" },
    height: 560,
    actions: ["toast", "clip-write", "clip-read", "count", "back", "grow", "theme-cycle", "sub-input", "sub-input-remove"],
  };

  function snapshot() {
    revision += 1;
    return {
      runtime: "lume.page/v1",
      schema: SCHEMA,
      revision,
      status: "ready",
      data: { ...model, items: [], groups: [], total: 0, window: { offset: 0, limit: 1 } },
      actions: model.actions.map((id) => ({ id, label: id })),
    };
  }
  function publish() { ctx.page.publish(snapshot()); }
  async function nextTheme() {
    const current = model.theme && model.theme.pref || "system";
    const next = current === "system" ? "dark" : current === "dark" ? "light" : "system";
    await ctx.theme.set(next);
    model.theme = await ctx.theme.get();
    publish();
  }

  return {
    async getModel() {
      try { model.count = Number(await ctx.storage.get("count")) || 0; } catch {}
      try { model.theme = await ctx.theme.get(); } catch {}
      return snapshot();
    },
    async onQuery(query) {
      model.query = String(query || "");
      if (model.query === "theme:dark" || model.query === "theme:light" || model.query === "theme:system") {
        await ctx.theme.set(model.query.slice(6));
        model.theme = await ctx.theme.get();
      }
      publish();
    },
    onEnter(info) {
      model.enter = info;
      try { ctx.storage.set("lastEnter", info); } catch {}
      publish();
    },
    onSubInput(text) {
      model.subInputText = String(text || "");
      publish();
    },
    async onIntent(intent) {
      if (intent.type !== "item.action") return { status: "accepted" };
      switch (intent.actionId) {
        case "toast":
          ctx.app.toast("来自 hello-mode 的问候");
          return { status: "completed" };
        case "clip-write":
          await ctx.clipboard.writeText("hello from hello-mode");
          ctx.app.toast("已写入剪贴板");
          return { status: "completed" };
        case "clip-read":
          model.clipboardText = await ctx.clipboard.readText() || "";
          publish();
          return { status: "completed" };
        case "count":
          model.count += 1;
          await ctx.storage.set("count", model.count);
          publish();
          return { status: "completed" };
        case "back":
          await ctx.app.setQuery("");
          return { status: "completed" };
        case "grow":
          model.height = Math.min(900, model.height + 120);
          publish();
          return { status: "completed" };
        case "theme-cycle":
          await nextTheme();
          return { status: "completed" };
        case "sub-input":
          await ctx.app.setSubInput({ placeholder: "子输入框：输入会送到插件（Esc 退出模式）" });
          model.subInputActive = true;
          publish();
          return { status: "completed" };
        case "sub-input-remove":
          await ctx.app.removeSubInput();
          model.subInputActive = false;
          model.subInputText = "";
          publish();
          return { status: "completed" };
        default:
          return { status: "failed", code: "action.unsupported", message: String(intent.actionId) };
      }
    },
  };
}
