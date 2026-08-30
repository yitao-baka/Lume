// 逻辑钩子（可选）。ctx = { app, clipboard, storage } — 与 iframe 页面内的
// window.lume 同一套能力。页面自身通过 lume.on.query 等接收事件，这里的
// 钩子适合做页面做不了的事（例如把查询发到外部服务）。
export default function create(ctx) {
  return {
    onQuery(q) {
      console.log("[hello-mode] query:", q);
    },
  };
}
