// Themed Icons 示例逻辑（template = "list"，docs/ROADMAP_HISTORY.md #44）。
//
// 行图标两种写法：
//   icon: "icon.svg"                           旧版单图（兼容；部分位置仍反相）
//   icon: { light: "a.svg", dark: "b.svg" }    显式两套（相对路径相对插件目录）
// 宿主按当前表面主题选一套；显式变体按原样渲染、不反相。省略 icon 的行回退到
// 清单的 icon_light / icon_dark。

export default function create(ctx) {
  return {
    async search(query) {
      const q = query.trim();
      const rows = [
        {
          name: "双色行图标（显式 light / dark 对）",
          description: "浅色表面是绿方块，深色表面是粉方块",
          icon: { light: "icons/row-light.svg", dark: "icons/row-dark.svg" },
        },
        {
          name: "清单默认图标（icon_light / icon_dark）",
          description: "这一行没有自己的 icon，用插件清单的两套图",
        },
        {
          name: "旧版单图（兼容路径）",
          description: "字符串 icon 仍走旧约定：在会反相的位置深色下依旧反相",
          icon: "icons/pill-light.svg",
        },
      ];
      if (!q) return rows;
      return [
        ...rows.filter((r) => r.name.includes(q) || r.description.includes(q)),
        { name: `Themed Icons：输入「${q}」` },
      ];
    },
    onEnter(item) {
      // 仅示例反馈（app.toast 无需权限）；真实插件可换取剪贴板/存储等。
      if (ctx?.app?.toast) ctx.app.toast(`已激活：${item.name}`);
    },
  };
}
