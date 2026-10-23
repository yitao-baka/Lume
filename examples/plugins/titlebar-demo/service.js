const SCHEMA = "lume.collection/v1";
const FRUITS = ["apple 苹果", "banana 香蕉", "cherry 樱桃", "durian 榴莲",
  "grape 葡萄", "mango 芒果", "orange 橙子", "peach 桃子", "pear 梨", "watermelon 西瓜"];

export default function create(ctx) {
  let revision = 0;
  let query = "";

  function snapshot() {
    const q = query.trim().toLowerCase();
    const rows = FRUITS.filter((fruit) => !q || fruit.toLowerCase().includes(q));
    revision += 1;
    return {
      runtime: "lume.page/v1",
      schema: SCHEMA,
      revision,
      status: rows.length ? "ready" : "empty",
      data: {
        title: "Titlebar Demo",
        query,
        items: rows.map((label, index) => ({ id: "fruit:" + index + ":" + label, label, actions: [] })),
        groups: [],
        total: rows.length,
        window: { offset: 0, limit: rows.length || 1 },
        emptyText: "无匹配结果",
      },
    };
  }

  return {
    getModel() { return snapshot(); },
    onQuery(next) {
      query = String(next || "");
      ctx.page.publish(snapshot());
    },
  };
}
