// P0 示例（ROADMAP：provider 结果模型扩展 + 多文件入口）。
//
// 这个插件演示四件事：
// 1. 多文件入口 —— 清单 `entry = "dist/"`（目录），本文件经相对导入引用
//    ./util.js，宿主加载器会把相对导入改写为 blob URL（无需打包工具）。
// 2. `enter: true` 动作条目 —— 激活时回调 onEnter(item)，不打开任何文件；
//    启动器保持打开，插件用 ctx.app.hide() 自行决定何时隐藏。
// 3. `description` —— 结果网格中名字下的第二行副标题。
// 4. `icon` —— 显式条目图标（data: URI / 文件路径均可），覆盖默认图标管线。

import { nowText } from "./util.js";

const clockIcon =
  "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>" +
  "<circle cx='12' cy='12' r='10' fill='%234aa3ff'/>" +
  "<path d='M12 6v6l4 2' stroke='white' stroke-width='2' fill='none' stroke-linecap='round'/></svg>";

export default function create(ctx) {
  return {
    async search(query) {
      const q = query.trim();
      if (!q) return [];
      return [
        {
          name: "复制当前时间",
          description: "动作条目：点击执行 onEnter（不打开文件）",
          icon: clockIcon,
          enter: true,
          action: "time",
        },
        {
          name: `搜索 "${q}"`,
          description: "普通条目：经 launch_app 打开（Bing）",
          path: `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
        },
      ];
    },

    // `enter` 条目的激活回调 —— 收到的就是 search 返回的那个对象
    // （额外的自定义字段如 action 原样保留）。
    onEnter(item) {
      if (item.action === "time") {
        const text = nowText();
        ctx.clipboard
          .writeText(text)
          .then(() => ctx.app.toast("已复制 " + text))
          .catch((err) => ctx.app.toast("复制失败: " + err));
      }
    },
  };
}
