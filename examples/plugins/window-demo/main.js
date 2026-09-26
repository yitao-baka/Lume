// P4 示例（ROADMAP #29 / docs/PLUGIN_API.md §6E.1 window 规则）：
// 活动窗口匹配 —— 呼出前的前台窗口命中 [[features]] type="window" 规则时，
// 空查询主菜单出现「<label>」行；激活后 onFeature 收到
// info.window = {process, className, title, path?}。
//
// 典型用法：用户正在某个应用里 → 呼出 Lume → 插件针对「用户此刻在哪」出
// 动作行（对当前文件夹做 X、对当前窗口做 Y），而不是先搜关键字。
//
// 注意：
//   - 匹配是宿主做的（看清单声明即可），无需权限；
//   - `ctx.app.foreground()`（window 权限）可以在插件运行时再取一次快照，
//     它与进入时投递的 info.window 是同一来源（呼出瞬间的前台窗口）；
//   - 依赖搜索框输入的模式（子输入框/query 驱动）与 window 行互补，不冲突。

export default function create(ctx) {
  function describeWindow(w) {
    const lines = [
      `进程 ${w.process || "?"}`,
      `类名 ${w.className || "?"}`,
      `标题「${w.title || ""}」`,
    ];
    if (w.path) lines.push(`文件夹 ${w.path}`);
    return lines.join("｜");
  }

  return {
    search: (q) =>
      Promise.resolve([
        {
          name: "窗口工具 (Window Demo)",
          path: `lume-plugin://demo/${encodeURIComponent(q)}`,
          description:
            "让记事本/资源管理器在前台，按热键呼出 Lume → 空查询出现「窗口工具」行",
          enter: true,
        },
      ]),
    onEnter: (item) => {
      ctx.app.toast("让记事本或资源管理器在前台后呼出 Lume 即可演示");
      void item;
    },
    onFeature: (info) => {
      if (info.type === "window" && info.window) {
        ctx.app.toast(`命中窗口规则「${info.code}」：${describeWindow(info.window)}`);
        return;
      }
      ctx.app.toast(`feature ${info.code}: ${info.payload.slice(0, 40)}`);
    },
  };
}
