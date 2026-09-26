// 逻辑钩子（可选）。ctx = { app, clipboard, storage } — 与 iframe 页面内的
// window.lume 同一套能力。页面自身通过 lume.on.query 等接收事件，这里的
// 钩子适合做页面做不了的事（例如把查询发到外部服务）。
export default function create(ctx) {
  return {
    onQuery(q) {
      console.log("[hello-mode] query:", q);
    },
    // 声明式进入（features）/ redirect 的逻辑钩子 —— 与页面的 lume.on.enter
    // 同时收到（钩子做逻辑，事件刷 UI）。
    onEnter(info) {
      console.log("[hello-mode] enter:", info.code, info.type, info.payload);
      ctx.storage.set("lastEnter", info);
    },
    // 页面接管搜索框后（app.setSubInput），按键也会经过这个钩子。
    onSubInput(text) {
      console.log("[hello-mode] subInput:", text);
    },
  };
}
