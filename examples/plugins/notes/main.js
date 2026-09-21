// 速记 (Notes) — P3 示例（ROADMAP #26）。
//
// 这个 Provider 演示 P3 的全部新面：
//   ctx.db.*       文档库（uTools/CouchDB 形状：_rev 乐观锁、allDocs、bulkDocs）
//   ctx.settings.* + onSettings   声明式设置（[[settings]] 在 plugin.toml）
//   ctx.fs.writeText / privatePath  插件私有目录（plugins/notes/files/，无需权限）
//   ctx.fs.writeFile + ctx.dialog.save  任意路径写入（需要 fs.write + dialog 声明）
//   permissions    未声明的能力会被宿主明确拒绝（本插件没声明 network）
//
// 触发：输入任意文本（1..80 字符，非「笔记」/「notes」）→「速记：保存这段文字」
// 行；输入「笔记」/「notes」→ 笔记列表 + 导出/清空/文档库与权限演示行。

/** 当前生效的设置（onSettings 推送；加载时会先推一次）。 */
let values = {};

/** 笔记文档 id 前缀 —— allDocs 的 idStartsWith 也用它。 */
const NOTE_PREFIX = "note:";
/** 列表关键字。 */
const LIST_RE = /^(笔记|notes)\s*$/i;
/** 演示「同一 _rev 写两次」用的固定文档 id。 */
const CONFLICT_ID = "demo:conflict";

function noteId() {
  return NOTE_PREFIX + Date.now() + ":" + Math.random().toString(36).slice(2, 6);
}

function textOf(doc) {
  return String(doc && doc.text != null ? doc.text : "");
}

function label(doc) {
  const prefix = typeof values.prefix === "string" ? values.prefix : "";
  return prefix + textOf(doc);
}

/** 全部笔记文档，按设置排序。 */
async function loadNotes(ctx) {
  const docs = await ctx.db.allDocs({ idStartsWith: NOTE_PREFIX });
  const newest = values.sort !== "oldest";
  docs.sort((a, b) => (newest ? (b.at || 0) - (a.at || 0) : (a.at || 0) - (b.at || 0)));
  return docs;
}

export default function create(ctx) {
  /** 存一条笔记（[[features]] 的保存动作与 bulkDocs 演示都用它）。 */
  async function save(text) {
    const body = { text: String(text).slice(0, 500), at: Date.now() };
    // 没有 _rev = 新建文档；id 由插件自己决定（时间戳 + 随机后缀）。
    const out = await ctx.db.put(Object.assign({ _id: noteId() }, body));
    if (values.autoCopy === true) await ctx.clipboard.writeText(body.text);
    ctx.app.toast(
      "已保存（_rev " + out._rev + "）" + (values.autoCopy === true ? " · 已复制" : "")
    );
  }

  /** 文档库演示：同一 _rev 写两次，第二次必须被拒绝。 */
  async function demoConflict() {
    const a = await ctx.db.put({ _id: CONFLICT_ID, text: "乐观锁 v1", at: Date.now() });
    const b = await ctx.db.put({ _id: CONFLICT_ID, text: "乐观锁 v2", at: Date.now(), _rev: a._rev });
    try {
      await ctx.db.put({ _id: CONFLICT_ID, text: "乐观锁 v3", at: Date.now(), _rev: a._rev });
      ctx.app.toast("乐观锁异常：旧 _rev 的写入竟然成功了");
    } catch (err) {
      const msg = String((err && err.message) || err);
      ctx.app.toast("已按预期拒绝（latest=" + b._rev + "）：" + msg.slice(0, 70));
    } finally {
      // 清理演示文档（用刚读到的 rev 删除）。
      await ctx.db.remove({ _id: CONFLICT_ID, _rev: b._rev });
    }
  }

  /** bulkDocs 演示：一次事务写 3 条，逐条返回结果。 */
  async function demoBulk() {
    const at = Date.now();
    const out = await ctx.db.bulkDocs([
      { _id: noteId(), text: "批量 1", at },
      { _id: noteId(), text: "批量 2", at },
      { _id: noteId(), text: "批量 3", at },
    ]);
    const ok = out.filter((r) => !r.error).length;
    ctx.app.toast("bulkDocs：" + ok + "/" + out.length + " 条写入成功");
  }

  /** 私有目录导出（无需任何权限）。 */
  async function exportPrivate() {
    const docs = await loadNotes(ctx);
    const path = await ctx.fs.writeText("notes.txt", docs.map(textOf).join("\r\n"));
    ctx.app.toast("已导出 " + docs.length + " 条 → " + path);
  }

  /** 任意路径导出（fs.write 需要声明；未选路径则什么都不写）。 */
  async function exportAny(ctx2) {
    const docs = await loadNotes(ctx2);
    const target = await ctx2.dialog.save({
      title: "导出笔记",
      fileName: "lume-notes.txt",
      filters: [{ name: "文本", extensions: ["txt"] }],
    });
    if (!target) {
      ctx2.app.toast("未选择路径，已取消");
      return;
    }
    await ctx2.fs.writeFile(target, docs.map(textOf).join("\r\n"));
    ctx2.app.toast("已写入 " + target);
  }

  async function clearNotes() {
    const docs = await loadNotes(ctx);
    for (const d of docs) await ctx.db.remove({ _id: d._id, _rev: d._rev });
    ctx.app.toast("已清空 " + docs.length + " 条笔记");
  }

  /** 权限层演示：本插件没有声明 network —— 这次调用必须被拒绝。 */
  async function demoDenied() {
    try {
      await ctx.http.request({ url: "https://example.com", timeoutMs: 3000 });
      ctx.app.toast("权限层异常：未声明 network 却请求成功");
    } catch (err) {
      ctx.app.toast("权限层拒绝：" + String((err && err.message) || err));
    }
  }

  /** 对照：clipboard 已在 permissions 里声明 —— 同样的调用必须成功。 */
  async function demoAllowed() {
    await ctx.clipboard.writeText("速记：剪贴板写入成功（已声明 clipboard）");
    ctx.app.toast("剪贴板写入成功（已声明 clipboard）");
  }

  return {
    /** 列表关键字 → 笔记行 + 演示动作行；其它查询不出行（保存走 [[features]]）。 */
    async search(q) {
      const query = q.trim();
      if (!LIST_RE.test(query)) return [];
      const notes = await loadNotes(ctx);
      const rows = notes.map((d) => ({
        name: label(d),
        description: "_rev " + d._rev + " · " + new Date(d.at || 0).toLocaleString(),
        text: textOf(d),
        enter: true,
        action: "copy",
      }));
      rows.push(
        { name: "速记：导出到插件目录（fs.writeText）", enter: true, action: "exportPrivate" },
        { name: "速记：导出到选定路径…（dialog + fs.write）", enter: true, action: "exportAny" },
        { name: "速记：清空全部笔记（逐条 remove）", enter: true, action: "clear" },
        { name: "文档库：bulkDocs 批量写入 3 条", enter: true, action: "bulk" },
        { name: "文档库：乐观锁演示（同一 _rev 写两次）", enter: true, action: "conflict" },
        { name: "权限：调用 http.request（未声明 network）", enter: true, action: "denied" },
        { name: "权限：写剪贴板（已声明 clipboard）", enter: true, action: "allowed" }
      );
      return rows;
    },

    /** 动作行的回调（`enter: true` 的行不会打开任何东西）。 */
    onEnter(item) {
      const action = item && item.action;
      if (action === "copy") {
        return ctx.clipboard
          .writeText(item.text)
          .then(() => ctx.app.toast("已复制：" + item.text.slice(0, 30)));
      }
      if (action === "exportPrivate") return exportPrivate();
      if (action === "exportAny") return exportAny(ctx);
      if (action === "clear") return clearNotes();
      if (action === "bulk") return demoBulk();
      if (action === "conflict") return demoConflict();
      if (action === "denied") return demoDenied();
      if (action === "allowed") return demoAllowed();
      return undefined;
    },

    /** [[features]] 命中（声明式进入）：payload 就是输入的文本。 */
    onFeature(info) {
      if (info && info.code === "save") return save(info.payload);
      return undefined;
    },

    /** 设置变更（或加载时的首次推送）：面板里一改，插件立刻知道。 */
    onSettings(v) {
      values = v || {};
      ctx.app.toast(
        "速记设置已更新：前缀「" +
          (values.prefix != null ? values.prefix : "") +
          "」排序=" +
          (values.sort != null ? values.sort : "newest") +
          " 自动复制=" +
          (values.autoCopy === true ? "开" : "关")
      );
    },
  };
}
