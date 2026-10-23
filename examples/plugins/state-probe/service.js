const SCHEMA = "lume.collection/v1";

export default function create(ctx) {
  let revision = 0;
  let fields = { src: "", flag: false, multi: [], note: "note", scroll: "0", late: "", lastEvent: "" };
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
        title: "State Probe",
        query,
        enter,
        fields: { ...fields, multi: [...fields.multi] },
        items: [],
        groups: [],
        total: 0,
        window: { offset: 0, limit: 1 },
      },
    };
  }
  function publish() { ctx.page.publish(snapshot()); }
  function applyQuery(value) {
    query = String(value == null ? "" : value);
    fields.lastEvent = "q:" + query;
    let match;
    if ((match = /^src:(.*)$/.exec(query))) fields.src = match[1];
    else if (query === "flag:on") fields.flag = true;
    else if (query === "flag:off") fields.flag = false;
    else if ((match = /^multi:(.*)$/.exec(query))) fields.multi = match[1] ? match[1].split(",") : [];
    else if ((match = /^note:(.*)$/.exec(query))) fields.note = match[1];
    else if ((match = /^scroll:(\d+)$/.exec(query))) fields.scroll = match[1];
    else if ((match = /^late:(.*)$/.exec(query))) fields.late = match[1];
  }
  function updateField(id, value, checked, selected) {
    if (id === "flag") fields.flag = !!checked;
    else if (id === "multi") fields.multi = Array.isArray(selected) ? selected.map(String) : [];
    else if (id === "note") fields.note = String(value == null ? "" : value);
    else if (id === "scrollmirror") fields.scroll = String(value == null ? "" : value);
    else if (Object.prototype.hasOwnProperty.call(fields, id)) fields[id] = String(value == null ? "" : value);
    fields.lastEvent = "field:" + id;
  }

  return {
    getModel() { return snapshot(); },
    onQuery(value) {
      applyQuery(value);
      publish();
    },
    onShow() { publish(); },
    onEnter(info) {
      enter = info;
      fields.lastEvent = "enter:" + String(info && info.payload);
      if (info && info.payload != null) fields.src = String(info.payload);
      publish();
    },
    onIntent(intent) {
      if (intent.type === "item.action" && intent.actionId === "set-field") {
        const payload = intent.payload || {};
        updateField(String(payload.id || ""), payload.value, payload.checked, payload.selected);
        publish();
        return { status: "completed" };
      }
      return { status: "accepted" };
    },
  };
}
