const SCHEMA = "lume.collection/v1";

export default function create(ctx) {
  let revision = 0;
  let query = "";
  let enter = null;

  function snapshot() {
    revision += 1;
    return {
      runtime: "lume.page/v1",
      schema: SCHEMA,
      revision,
      status: "ready",
      data: {
        title: "Hidden Mode",
        query,
        enter,
        items: [],
        groups: [],
        total: 0,
        window: { offset: 0, limit: 1 },
      },
    };
  }

  return {
    getModel() { return snapshot(); },
    onQuery(next) {
      query = String(next || "");
      ctx.page.publish(snapshot());
    },
    onEnter(info) {
      enter = info;
      ctx.page.publish(snapshot());
    },
  };
}
