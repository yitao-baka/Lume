// P2.5b 示例（docs/PLUGIN_GAP_ANALYSIS.md P2.5 / PLUGIN_API §6E）：清单
// 插件 —— kind = "mode" + template = "list"，没有 view.html。
//
// 宿主把本文件装进启动器窗口（provider 同款 ctx），内置列表组件渲染
// search(q) 返回的行；↑/↓/Enter 由共享键盘导航驱动（宿主读 rows()/selected/
// activate），点击行 → onEnter(item)。
//
// 数据存在插件文档库里（P3.1）：第一次进入预置两行演示数据。
//
// 类型：下面的 reference + @ts-check 让本文件过 `tsc` 校验（类型面见
// examples/plugins/plugin-api.d.ts；校验命令见 examples/tsconfig.json）。

/// <reference path="../plugin-api.d.ts" />
// @ts-check

const DEMO = [
  { name: "买牛奶", description: "演示数据 · Enter 复制到剪贴板" },
  { name: "还书", description: "演示数据 · Enter 复制到剪贴板" },
];

/** @param {LumePluginCtx} ctx @returns {LumeProviderLogic} */
export default function create(ctx) {
  let items = DEMO.slice();

  async function seed() {
    // 幂等播种：文档库里没有标记文档时写入演示数据。
    try {
      const marker = await ctx.db.get("seeded");
      if (!marker) {
        await ctx.db.put({ _id: "seeded", note: "list-demo 首次进入" });
      }
    } catch {
      /* 文档库不可用不影响演示 */
    }
  }

  return {
    // 必需：返回 ProviderResult[]（name 必填；description/icon 可选）。
    search: (q) => {
      const kw = (q || "").trim().toLowerCase();
      return Promise.resolve(
        items.filter(
          (it) => !kw || it.name.toLowerCase().includes(kw)
        )
      );
    },
    // 可选：行激活（点击 / Enter）。启动器保持打开 —— 本例复制后自动隐藏。
    onEnter: (item) => {
      ctx.clipboard
        .writeText(item.name)
        .then(() => {
          ctx.app.toast(`已复制：${item.name}`);
          ctx.app.hide();
        })
        .catch((err) => ctx.app.toast(`复制失败: ${err}`));
    },
    // 可选：声明式进入（[[features]] quick-add）——把「买 …」追加为一条。
    onFeature: (info) => {
      if (info.code !== "quick-add") return;
      const text = (info.payload || "").replace(/^买\s*/, "").trim();
      if (!text) return;
      items = [{ name: text, description: "刚添加" }, ...items];
      ctx.app.toast(`已添加：${text}`);
      ctx.app.setQuery("");
    },
    onShow: () => void seed(),
  };
}
