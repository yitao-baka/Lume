// 导航页栏目（navBars）示例。ctx = { app, clipboard, storage } — 与其它
// 插件形态同一套宿主能力。navBars 在每次呼出与插件刷新时被调用，可以按
// storage 里的状态动态返回不同栏目；返回 [] 或不实现该钩子 = 不贡献。
//
// 每个栏目 { id, title, items }：
// - id     — 插件内唯一即可（宿主会加上 "插件id:" 前缀作为键盘导航键）；
// - title  — 栏目标题，直接渲染（插件自行决定文案/语言）；
// - items  — { name, path, icon? } 条目：path 是文件绝对路径或 URL，激活时
//   经 launch_app 打开（与搜索结果条目一致，启动后启动器隐藏）；icon 可省
//   （文件路径走图标管线，URL 用未知图标回退；data:/https: 直接使用，本地
//   文件路径自动转 asset 协议）。
export default function create(ctx) {
  return {
    async navBars() {
      // 异步也可以 — 宿主会等待并做形状校验（坏条目丢弃并记控制台日志）。
      return [
        {
          id: "links",
          title: "快速链接",
          items: [
            {
              name: "GitHub",
              path: "https://github.com",
              icon:
                "data:image/svg+xml;utf8," +
                encodeURIComponent(
                  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#24292f"/></svg>'
                ),
            },
            { name: "Bing", path: "https://www.bing.com" },
          ],
        },
      ];
    },
  };
}
