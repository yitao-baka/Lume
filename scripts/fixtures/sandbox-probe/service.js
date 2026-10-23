const SCHEMA = "lume.collection/v1";
export default function create(ctx) {
  let revision = 0;
  let probe = null;
  function snapshot() {
    revision += 1;
    return { runtime: "lume.page/v1", schema: SCHEMA, revision, status: "ready", data: { probe, items: [], groups: [], total: 0, window: { offset: 0, limit: 1 } }, actions: [{ id: "report", label: "Report probe" }] };
  }
  return {
    getModel() { return snapshot(); },
    async onIntent(intent) {
      if (intent.type === "item.action" && intent.actionId === "report") {
        probe = intent.payload && intent.payload.probe || null;
        await ctx.storage.set("probe", JSON.stringify(probe));
        ctx.page.publish(snapshot());
        return { status: "completed" };
      }
      return { status: "accepted" };
    },
  };
}
