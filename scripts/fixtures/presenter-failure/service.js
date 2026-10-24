export default function create() {
  return {
    getModel() {
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
