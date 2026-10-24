let attempts = 0;

export default function create() {
  return {
    getModel() {
      attempts += 1;
      if (attempts === 1) throw new Error("first Page Service boot fails");
      return {
        runtime: "lume.page/v1",
        schema: "lume.collection/v1",
        revision: 1,
        status: "ready",
        data: { items: [], groups: [], total: 0, window: { offset: 0, limit: 1 } },
      };
    },
  };
}
