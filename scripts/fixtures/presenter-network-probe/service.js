// __PROBE_BASE__ is replaced by the regression script. The logic frame has no
// network permission; CSP must block even this direct browser request.
try {
  fetch("__PROBE_BASE__/service-fetch", { method: "POST", body: "service-bypass" });
} catch {}

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
