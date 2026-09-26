// P2.2 示例（docs/PLUGIN_GAP_ANALYSIS.md P2.2 / PLUGIN_API §6E）：files 拖入
// 与 img 剪贴板图片进入。
//
// 覆盖：
//   [[features]] type="files" —— 拖入文件（或呼出后拖入）出现
//     「文件处理器：处理 N 个文件」行；激活后 onFeature 收到
//     info.paths（仅命中 extensions 的子集），用 fs.readText 读第一个
//     文件前 200 字符做真实读取演示
//   [[features]] type="img"   —— 剪贴板有图时空查询出「图片处理器」行；
//     激活后 clipboard.readImage() 返回 PNG data URI（toast 报告其长度）
//   search(q)                 —— provider 形状要求；给一行用法说明

export default function create(ctx) {
  async function handleFiles(paths) {
    // 一次 toast 报告两件事（路径子集 + 真实读取），避免两支 toast 互相覆盖。
    try {
      const text = await ctx.fs.readText(paths[0]); // 需要清单声明 fs.read
      const head = text.slice(0, 200).replace(/\s+/g, " ");
      ctx.app.toast(
        `收到 ${paths.length} 个文件（首个 ${paths[0]}）｜前 200 字符：${head || "(空文件)"}`
      );
    } catch (err) {
      ctx.app.toast(`收到 ${paths.length} 个文件，但读取失败: ${err}`);
    }
  }

  async function handleImage() {
    try {
      const data = await ctx.clipboard.readImage();
      if (!data) {
        ctx.app.toast("剪贴板里没有图片了（可能已被覆盖）");
        return;
      }
      // data 是 data:image/png;base64,… —— 直接可以放进 <img src>。
      ctx.app.toast(`读到图片：PNG base64 ${data.length} 字符`);
    } catch (err) {
      ctx.app.toast(`读图失败: ${err}`);
    }
  }

  return {
    search: (q) =>
      Promise.resolve([
        {
          name: "文件处理器 (Files & Image Demo)",
          path: `lume-plugin://demo/${encodeURIComponent(q)}`,
          description:
            "拖 .md/.txt 或文件夹/图片到 Lume；或截图后空查询呼出 → 「图片处理器」行",
          enter: true,
        },
      ]),
    onEnter: (item) => {
      ctx.app.toast("在主菜单拖入文件或复制图片后呼出即可演示");
      void item;
    },
    onFeature: (info) => {
      if (info.type === "files") {
        // folders 走只报路径的分支（readText 读不了目录）；extensions 命中的
        // 文本文件走真实读取；fileType=image 只报清单。
        if (info.code === "handle-folders") {
          ctx.app.toast(`收到 ${info.paths.length} 个文件夹：${info.paths.join("、")}`);
        } else {
          void handleFiles(info.paths ?? []);
        }
      } else if (info.type === "img") void handleImage();
      else ctx.app.toast(`feature ${info.code}: ${info.payload.slice(0, 40)}`);
    },
  };
}
