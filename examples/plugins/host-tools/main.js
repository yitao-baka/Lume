// P1 示例（ROADMAP：宿主能力面扩张）。
//
// 输入「h:」前缀进入本插件的动作面板：
//   h:                     列出全部动作
//   h:https://example.com  经宿主 HTTP 拉取该 URL（无 CORS 限制）
//   h:通知 / h:文件 / h:图片 / h:粘贴 / h:屏幕 / h:文件列表
//
// 覆盖的宿主能力：
//   ctx.http.request        宿主 HTTP（WinHTTP，绕过 CORS；text()/json() 便利方法）
//   ctx.app.notify          系统通知（启动器隐藏时也能触达用户）
//   ctx.dialog.open/save    原生文件选择 / 保存对话框
//   ctx.clipboard.writeImage / writeFiles / readFiles / paste
//   ctx.screen.cursor/displays

/** A 64×64 gradient PNG as a data URI — generated at runtime with a canvas. */
function makePng() {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 64, 64);
  grad.addColorStop(0, "#4aa3ff");
  grad.addColorStop(1, "#8b5cf6");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  g.fillStyle = "#fff";
  g.font = "bold 28px sans-serif";
  g.fillText("Lu", 12, 42);
  return c.toDataURL("image/png");
}

const ACTIONS = [
  { key: "通知", desc: "系统通知（气泡 / 通知中心）", run: (ctx) => ctx.app.notify("Lume 插件通知", "来自 host-tools 示例：宿主通知可用。") },
  { key: "文件", desc: "打开原生文件选择对话框", run: async (ctx) => {
      const files = await ctx.dialog.open({ title: "选择任意文件", multiple: true, filters: [{ name: "文本", extensions: ["txt", "md", "json"] }] });
      ctx.app.toast(files.length ? `已选择 ${files.length} 个文件` : "已取消选择");
    } },
  { key: "保存", desc: "打开原生保存对话框", run: async (ctx) => {
      const path = await ctx.dialog.save({ title: "保存到哪里？", fileName: "lume-demo.txt", filters: [{ name: "文本", extensions: ["txt"] }] });
      ctx.app.toast(path ? `保存路径：${path}` : "已取消保存");
    } },
  { key: "图片", desc: "把生成的 PNG 写入剪贴板", run: async (ctx) => {
      await ctx.clipboard.writeImage(makePng());
      ctx.app.toast("图片已复制到剪贴板");
    } },
  { key: "粘贴", desc: "把文本粘贴到前台窗口（Ctrl+V）", run: (ctx) => ctx.clipboard.paste({ text: "来自 Lume 插件的粘贴" }) },
  { key: "文件列表", desc: "读取剪贴板中的文件列表", run: async (ctx) => {
      const files = await ctx.clipboard.readFiles();
      ctx.app.toast(files.length ? `剪贴板里有 ${files.length} 个文件：${files[0]}` : "剪贴板里没有文件");
    } },
  { key: "屏幕", desc: "光标位置与显示器信息", run: async (ctx) => {
      const pos = await ctx.screen.cursor();
      const ds = await ctx.screen.displays();
      const main = ds.find((d) => d.primary) ?? ds[0];
      ctx.app.toast(`光标 (${pos.x}, ${pos.y})，${ds.length} 台显示器，主屏 ${main.width}×${main.height}`);
    } },
];

export default function create(ctx) {
  return {
    async search(query) {
      const q = query.trim();
      if (!q.toLowerCase().startsWith("h:")) return [];
      const arg = q.slice(2).trim();

      // h:<url> → fetch it through the host (no CORS) and offer the result.
      if (/^https?:\/\//i.test(arg)) {
        return [
          {
            name: `GET ${arg}`,
            description: "宿主 HTTP：点击拉取并 toast 状态码/长度",
            enter: true,
            action: "http",
            url: arg,
          },
        ];
      }

      const actions = arg
        ? ACTIONS.filter((a) => a.key.includes(arg))
        : ACTIONS;
      return actions.map((a) => ({
        name: `h: ${a.key}`,
        description: a.desc,
        enter: true,
        action: "run",
        key: a.key,
      }));
    },

    async onEnter(item) {
      if (item.action === "http") {
        ctx.app.toast(`请求中… ${item.url}`);
        try {
          const res = await ctx.http.request({ url: item.url, timeoutMs: 15000 });
          const text = res.text();
          ctx.app.toast(`HTTP ${res.status} · ${text.length} 字节${res.truncated ? "（已截断）" : ""}`);
        } catch (err) {
          ctx.app.toast(`请求失败：${err}`);
        }
        return;
      }
      if (item.action === "run") {
        const action = ACTIONS.find((a) => a.key === item.key);
        if (!action) return;
        try {
          await action.run(ctx);
        } catch (err) {
          ctx.app.toast(`动作失败：${err}`);
        }
      }
    },
  };
}
