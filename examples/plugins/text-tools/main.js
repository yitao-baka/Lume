// P2 示例（ROADMAP #25）：入口矩阵与搜索链路。
//
// 覆盖：
//   [[features]] over   —— 输入任意文本出现「文本工具：转为大写」行，
//                          激活把查询作为 payload 投递给 onFeature
//   [[features]] regex  —— 输入 URL 出现「打开这个网址」行
//   drill / select      —— 「文本转换…」行下钻出一层转换方式（Esc 回退）
//   filter              —— 下钻层里继续输入会过滤转换方式（宿主接管搜索框）
//   app.redirect        —— 跳到另一个插件（目标不可用时宿主 toast 提示）

const TRANSFORMS = {
  大写: (s) => s.toUpperCase(),
  小写: (s) => s.toLowerCase(),
  反转: (s) => Array.from(s).reverse().join(""),
  字数: (s) => `字符数 ${Array.from(s).length}，行数 ${s.split("\n").length}`,
};

export default function create(ctx) {
  /** The text the current round is about (drill rows are built from it). */
  let subject = "";

  function apply(kind, text) {
    const fn = TRANSFORMS[kind];
    if (!fn) return;
    const out = fn(text);
    ctx.clipboard
      .writeText(out)
      .then(() => ctx.app.toast(`${kind} → ${out.slice(0, 40)}`))
      .catch((err) => ctx.app.toast(`失败: ${err}`));
  }

  return {
    async search(query) {
      const q = query.trim();
      if (!q) return [];
      subject = q;
      return [
        {
          name: "文本转换…",
          description: "下钻：选择一种转换方式（可继续输入过滤）",
          drill: true,
        },
        {
          name: `复制「${q.slice(0, 12)}」的大写`,
          description: "动作条目：onEnter 直接执行",
          enter: true,
          action: "transform",
          kind: "大写",
        },
        {
          name: "在 Hello Mode 里打开",
          description: "app.redirect：跳到另一个插件并带 payload",
          enter: true,
          action: "redirect",
          target: "hello-mode",
        },
        {
          name: "跳到未安装的插件（演示失败提示）",
          description: "redirect 目标不存在时宿主会 toast 提示",
          enter: true,
          action: "redirect",
          target: "no-such-plugin",
        },
      ];
    },

    // 下钻层：返回这一层的行（宿主用它们替换网格，Esc 回上一级）。
    async select() {
      return Object.entries(TRANSFORMS).map(([kind, fn]) => ({
        name: `转换为${kind}`,
        description: `${kind}处理「${subject.slice(0, 16)}」`,
        enter: true,
        action: "transform",
        kind,
        sample: fn(subject).slice(0, 24),
      }));
    },

    // 下钻层里继续输入 → 宿主把文字喂给 filter（只显示名字匹配的行）。
    async filter(_item, query) {
      const q = query.trim();
      return Object.entries(TRANSFORMS)
        .filter(([kind]) => !q || kind.includes(q))
        .map(([kind, fn]) => ({
          name: `转换为${kind}`,
          description: `${kind}处理「${subject.slice(0, 16)}」`,
          enter: true,
          action: "transform",
          kind,
          sample: fn(subject).slice(0, 24),
        }));
    },

    onEnter(item) {
      if (item.action === "transform") {
        apply(item.kind, subject);
        return;
      }
      if (item.action === "redirect") {
        ctx.app.redirect(item.target, { code: "from-text-tools", payload: subject });
      }
    },

    // 声明式进入（features）的载荷投递：{code, type, payload}。
    onFeature(info) {
      if (info.code === "upper") {
        apply("大写", info.payload);
        return;
      }
      if (info.code === "open-url") {
        ctx.app.toast(`regex 命中，打开 ${info.payload}`);
        ctx.app.openPath(info.payload);
      }
    },
  };
}
