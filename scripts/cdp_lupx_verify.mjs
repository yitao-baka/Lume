// .lupx 安装/卸载验证（docs/ROADMAP_HISTORY.md）：
//   ① inspect   合法包（plugin.toml 在根）返回 id/版本/权限/文件数；不存在的
//               文件、无清单包、含 `../` 条目的包分别被明确拒绝
//   ② install   安装 → get_plugins 出现该插件 → 无需重启 provider 搜索行直接
//               可见（settings-applied + plugin-reload 生效）
//   ③ subdir    「右键压缩文件夹」形状（plugin.toml 在唯一顶层目录内）可装，
//               前缀外的散文件被忽略（确认弹窗与实际解压都是 2 个文件）
//   ④ upgrade   v1 → v2：inspect 报 existingVersion=1.0.0 + relation="upgrade"
//               （版本判断的依据），私有 files/ 在覆盖后保留（#28.1）；安装后
//               get_plugins 版本变 2.0.0，搜索行照常（模块已重 import）；同
//               版本包再 inspect → relation="reinstall"
//   ⑤ uninstall 卸载 → get_plugins 不再列出 → 搜索行消失；重复卸载不报错
//   ⑥ 设置页    工具栏有「安装插件」按钮；磁盘插件卡片的卸载按钮打开确认
//               对话框（Esc 取消）；内置插件没有卸载按钮
//   ⑦ 安装弹窗  原生文件对话框无法从 CDP 驱动，这里把 `plugin:dialog|open`
//               换成返回固定包路径的桩（其余命令仍走真实 IPC），跑完
//               选包 → 模态确认 → 安装 的整条链路：事实块（名称/版本/kind/
//               能力 chips/文件数/签名）、背景 inert、焦点落在取消、Esc 关闭
//               并把焦点还给触发按钮、确认后真实落盘、降级关系黄字提示
// 截图：test/lupx_settings.png、test/lupx_install_dialog.png
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, openSync, existsSync, readFileSync } from "node:fs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try { execSync("taskkill /F /IM lume.exe 2>NUL", { stdio: "ignore" }); } catch {}

const BASE = "src-tauri/target/debug";
const CDP_PORT = 9233;
mkdirSync("test", { recursive: true });
// 目标 id 干净起步（之前的安装残留不能影响 inspect 的 existingVersion）。
rmSync(`${BASE}/plugins/lupx-demo`, { recursive: true, force: true });

// ── 最小 zip 写入器（stored 条目）：不引依赖就能造出合法包与恶意包 ──
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function makeZip(entries) {
  const enc = new TextEncoder();
  const local = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameB = enc.encode(name);
    const body = typeof data === "string" ? enc.encode(data) : data;
    const crc = crc32(body);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(20, 4);
    l.writeUInt16LE(0x0800, 6); // UTF-8 names
    l.writeUInt32LE(crc, 14);
    l.writeUInt32LE(body.length, 18);
    l.writeUInt32LE(body.length, 22);
    l.writeUInt16LE(nameB.length, 26);
    local.push(l, nameB, body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20); c.writeUInt32LE(body.length, 24);
    c.writeUInt16LE(nameB.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, nameB]));
    offset += 30 + nameB.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, eocd]);
}

const MAIN_JS = `export default {
  async search(query) {
    const q = query.trim();
    if (!q) return [];
    return [{ name: "LUPX 测试条目", description: "lupx-demo provider", path: "https://example.com/" }];
  },
};`;
const manifest = (v) => `id = "lupx-demo"\nname = "Lupx Demo"\nversion = "${v}"\nkind = "provider"\ndescription = ".lupx 验证插件"\nentry = "main.js"\n`;

const ZIP_V1 = makeZip([["plugin.toml", manifest("1.0.0")], ["main.js", MAIN_JS]]);
const ZIP_V2 = makeZip([["plugin.toml", manifest("2.0.0")], ["main.js", MAIN_JS]]);
const manifestPerms = (v) => `id = "lupx-demo"\nname = "Lupx Demo"\nversion = "${v}"\nkind = "provider"\ndescription = ".lupx 验证插件"\nentry = "main.js"\npermissions = ["clipboard", "network"]\n`;
const ZIP_PERMS = makeZip([["plugin.toml", manifestPerms("3.0.0")], ["main.js", MAIN_JS]]);
const ZIP_SUBDIR = makeZip([
  ["lupx-demo/plugin.toml", manifest("1.0.0")],
  ["lupx-demo/main.js", MAIN_JS],
  ["README.txt", "stray file outside the plugin prefix"],
]);
const ZIP_EVIL = makeZip([["plugin.toml", manifest("9.9.9")], ["../evil.txt", "boom"]]);
const ZIP_NOMANIFEST = makeZip([["main.js", MAIN_JS]]);
writeFileSync("test/lupx_v1.lupx", ZIP_V1);
writeFileSync("test/lupx_v2.lupx", ZIP_V2);
writeFileSync("test/lupx_perms.lupx", ZIP_PERMS);
writeFileSync("test/lupx_subdir.lupx", ZIP_SUBDIR);
writeFileSync("test/lupx_evil.lupx", ZIP_EVIL);
writeFileSync("test/lupx_nomanifest.lupx", ZIP_NOMANIFEST);
const abs = (f) => process.cwd().replaceAll("/", "\\") + "\\test\\" + f;

let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failures++;
};

const logFd = openSync("test/lupx_lume.log", "w");
spawn(`${BASE}/lume.exe`, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  stdio: ["ignore", logFd, logFd],
});

async function getTargets() {
  for (let i = 0; i < 40; i++) {
    try { return await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json(); } catch { await sleep(500); }
  }
  throw new Error("CDP unavailable");
}
async function connect(url) {
  const ws = new WebSocket(url);
  let id = 0; const p = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && p.has(m.id)) { p.get(m.id)(m); p.delete(m.id); } };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) => new Promise((res) => { const k = ++id; p.set(k, res); ws.send(JSON.stringify({ id: k, method, params })); });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r?.result?.exceptionDetails) {
      const ex = r.result.exceptionDetails.exception;
      // Tauri command rejections arrive as plain strings (no .description).
      throw new Error(String(ex?.description ?? ex?.value ?? "eval failed"));
    }
    return r?.result?.result?.value;
  };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync("test/" + name, Buffer.from(r.result.data, "base64"));
  };
  return { ws, evalJs, shot };
}
async function findWindow(probe) {
  const pages = ((await getTargets()) ?? []).filter((t) => t.type === "page" && t.url.includes("tauri.localhost"));
  for (const t of pages) {
    try {
      const c = await connect(t.webSocketDebuggerUrl);
      const ok = await c.evalJs(probe);
      c.ws.close();
      if (ok) return t;
    } catch {}
  }
  return null;
}

let mainT = null;
for (let i = 0; i < 40 && !mainT; i++) { await sleep(500); mainT = await findWindow(`!!document.getElementById("search-input")`); }
if (!mainT) { console.error("launcher window missing"); process.exit(1); }
const m = await connect(mainT.webSocketDebuggerUrl);
const invoke = async (cmd, args = {}) =>
  await m.evalJs(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`);
const tryInvoke = async (cmd, args = {}) => {
  try { return { ok: await invoke(cmd, args) }; }
  catch (e) { return { err: String(e) }; }
};
const type = (q) => m.evalJs(`(() => { const i = document.getElementById("search-input"); i.focus(); i.value = ${JSON.stringify(q)}; i.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
const rowNames = () => m.evalJs(`Array.from(document.querySelectorAll(".result-box-name")).map((n) => n.textContent)`);
const pluginIds = async () => (await invoke("get_plugins")).map((p) => p.id);

// ── ① inspect：形状与拒绝 ──
const v1 = await tryInvoke("plugin_lupx_inspect", { sourcePath: abs("lupx_v1.lupx") });
check("inspect: 合法包返回清单事实",
  v1.ok && v1.ok.id === "lupx-demo" && v1.ok.version === "1.0.0" && v1.ok.kind === "provider"
  && Array.isArray(v1.ok.permissions) && v1.ok.fileCount === 2 && v1.ok.existingVersion === null
  && v1.ok.relation === "fresh",
  JSON.stringify(v1.ok ?? v1.err));
const evil = await tryInvoke("plugin_lupx_inspect", { sourcePath: abs("lupx_evil.lupx") });
check("inspect: ../ 条目被拒", evil.err && evil.err.includes("escapes"), evil.err);
const nomanifest = await tryInvoke("plugin_lupx_inspect", { sourcePath: abs("lupx_nomanifest.lupx") });
check("inspect: 无 plugin.toml 被拒", nomanifest.err && nomanifest.err.includes("no plugin.toml"), nomanifest.err);
const missing = await tryInvoke("plugin_lupx_inspect", { sourcePath: "Z:/definitely/missing.lupx" });
check("inspect: 缺文件被拒", missing.err && missing.err.includes("cannot open"), missing.err);
const subdir = await tryInvoke("plugin_lupx_inspect", { sourcePath: abs("lupx_subdir.lupx") });
check("inspect: 顶层目录形状可解析且只计前缀内 2 个文件",
  subdir.ok && subdir.ok.id === "lupx-demo" && subdir.ok.fileCount === 2, JSON.stringify(subdir.ok ?? subdir.err));

// ── ② install → 无需重启即可用 ──
const inst = await tryInvoke("plugin_lupx_install", { sourcePath: abs("lupx_v1.lupx") });
check("install: 命令成功返回", inst.ok && inst.ok.id === "lupx-demo", JSON.stringify(inst.ok ?? inst.err));
await sleep(1200); // settings-applied → refreshPlugins → import
check("install: get_plugins 列出该插件", (await pluginIds()).includes("lupx-demo"), (await pluginIds()).join(","));
await type("zzqq");
await sleep(800);
const rows1 = await rowNames();
check("install: provider 搜索行直接可用（未重启）", rows1.some((r) => r.includes("LUPX 测试条目")), JSON.stringify(rows1));

// ── ③ subdir 形状安装（前缀外散文件不落盘） ──
const instSub = await tryInvoke("plugin_lupx_install", { sourcePath: abs("lupx_subdir.lupx") });
check("install: subdir 形状成功且 fileCount=2", instSub.ok && instSub.ok.fileCount === 2, JSON.stringify(instSub.ok ?? instSub.err));
await sleep(1200);
check("install: 前缀外 README.txt 未落盘", !existsSync(`${BASE}/plugins/README.txt`));
await type("zzqq");
await sleep(600);
const rowsSub = await rowNames();
check("install: subdir 安装后 provider 行仍在", Array.isArray(rowsSub) && rowsSub.some((r) => r.includes("LUPX 测试条目")), JSON.stringify(rowsSub));

// ── ④ upgrade：existingVersion + relation + 私有 files 保留 + 重 import ──
// 升级前写一个「插件运行期数据」文件（fs API 私有目录的等价物），升级后必须还在。
mkdirSync(`${BASE}/plugins/lupx-demo/files`, { recursive: true });
writeFileSync(`${BASE}/plugins/lupx-demo/files/upgrade-keep.txt`, "user data");
const v2 = await tryInvoke("plugin_lupx_inspect", { sourcePath: abs("lupx_v2.lupx") });
check("inspect: 已装同 id → existingVersion=1.0.0 + relation=upgrade",
  v2.ok && v2.ok.existingVersion === "1.0.0" && v2.ok.relation === "upgrade",
  JSON.stringify(v2.ok?.existingVersion));
await tryInvoke("plugin_lupx_install", { sourcePath: abs("lupx_v2.lupx") });
await sleep(1400);
check("upgrade: 私有 files/ 保留（升级不清数据）",
  existsSync(`${BASE}/plugins/lupx-demo/files/upgrade-keep.txt`)
  && readFileSync(`${BASE}/plugins/lupx-demo/files/upgrade-keep.txt`, "utf8") === "user data");
const info2 = (await invoke("get_plugins")).find((p) => p.id === "lupx-demo");
check("upgrade: get_plugins 版本变为 2.0.0", info2?.version === "2.0.0", info2?.version);
await type("zzqq");
await sleep(800);
check("upgrade: 重 import 后 provider 行仍可用", (await rowNames()).some((r) => r.includes("LUPX 测试条目")));
const again = await tryInvoke("plugin_lupx_inspect", { sourcePath: abs("lupx_v2.lupx") });
check("inspect: 同版本包 → relation=reinstall", again.ok?.relation === "reinstall", JSON.stringify(again.ok?.relation));

// ── ⑤ uninstall ──
const uni = await tryInvoke("plugin_uninstall", { id: "lupx-demo" });
check("uninstall: 成功", !uni.err, uni.err);
await sleep(1200);
check("uninstall: get_plugins 不再列出", !(await pluginIds()).includes("lupx-demo"), (await pluginIds()).join(","));
await type("zzqq");
await sleep(800);
check("uninstall: provider 行消失", !(await rowNames()).some((r) => r.includes("LUPX 测试条目")), JSON.stringify(await rowNames()));
const uniAgain = await tryInvoke("plugin_uninstall", { id: "lupx-demo" });
check("uninstall: 重复卸载不报错", !uniAgain.err, uniAgain.err);
const uniBad = await tryInvoke("plugin_uninstall", { id: "../evil" });
check("uninstall: 非法 id 被拒", uniBad.err && uniBad.err.includes("invalid plugin id"), uniBad.err);

// ── ⑥ 设置页：安装按钮 + 卸载按钮 ──
await m.evalJs(`document.querySelector('.icon-btn[aria-label]')?.click(); "clicked"`);
await sleep(1200);
let s = null;
for (let i = 0; i < 20 && !s; i++) {
  const t = await findWindow(`document.body.classList.contains("settings-window")`);
  if (t) s = await connect(t.webSocketDebuggerUrl);
  else await sleep(500);
}
if (!s) { console.error("settings window missing"); process.exit(1); }
await s.evalJs(`Array.from(document.querySelectorAll('.settings-nav')).find((b) => b.textContent.includes("插件"))?.click(); "ok"`);
await sleep(600);
const ui = await s.evalJs(`({
  installBtn: !!document.querySelector('.plg-install-btn'),
  uninstallBtns: document.querySelectorAll('.plg-uninstall').length,
  cards: document.querySelectorAll('.plg-card').length,
})`);
check("设置页: 工具栏有「安装插件」按钮", ui.installBtn, JSON.stringify(ui));
check("设置页: 磁盘插件卡片有卸载按钮（内置无）",
  ui.uninstallBtns > 0 && ui.uninstallBtns < ui.cards, JSON.stringify(ui));
// 卸载按钮 → 共享确认对话框；Esc 取消不落盘
await s.evalJs(`document.querySelector('.plg-uninstall')?.click(); true`);
await sleep(250);
const uninstallDialog = await s.evalJs(`({
  open: !!document.querySelector('.settings-confirm[role="dialog"]'),
  title: document.querySelector('.settings-confirm-title')?.textContent ?? '',
  inert: document.querySelector('.settings-content')?.hasAttribute('inert') ?? false,
})`);
check("设置页: 卸载按钮打开确认对话框（背景 inert）",
  uninstallDialog.open && uninstallDialog.title.includes("卸载") && uninstallDialog.inert, JSON.stringify(uninstallDialog));
await s.evalJs(`document.querySelector('.settings-confirm')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
await sleep(200);
check("设置页: Esc 取消卸载（对话框关闭、插件仍在）",
  !(await s.evalJs(`!!document.querySelector('.settings-confirm')`)) && (await pluginIds()).length > 0);

// ── ⑦ 安装确认弹窗：选包 → 模态确认 → 安装 ──
// 原生文件对话框没法从 CDP 驱动。Windows 上 Tauri 的 IPC 走 fetch
// （http://ipc.localhost/<cmd>），而 __TAURI_INTERNALS__.invoke 是只读属性
// 换不掉 —— 所以拦 fetch：只把 `plugin:dialog|open` 换成返回固定包路径的
// 合成响应，其余命令继续走真实 IPC；事实块仍由真实 inspect 产出。
const stubOk = await s.evalJs(`(() => {
  const internals = window.__TAURI_INTERNALS__;
  if (typeof internals?.convertFileSrc !== "function") return false;
  const ipcUrl = internals.convertFileSrc("plugin:dialog|open", "ipc");
  const realFetch = window.fetch.bind(window);
  window.__lupxRealFetch = realFetch;
  window.__lupxDialogTarget = null;
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url ?? "";
    if (url === ipcUrl && window.__lupxDialogTarget) {
      return Promise.resolve(new Response(JSON.stringify(window.__lupxDialogTarget), {
        status: 200,
        headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
      }));
    }
    return realFetch(input, init);
  };
  return window.fetch !== realFetch;
})()`);
check("弹窗: 原生文件对话框可被 CDP 桩替换", stubOk === true, String(stubOk));
if (stubOk === true) {
  const installWith = async (file) => {
    await s.evalJs(`window.__lupxDialogTarget = ${JSON.stringify(abs(file))}; true`);
    await s.evalJs(`document.querySelector('.plg-install-btn')?.click(); true`);
    await sleep(900);
  };

  // 出现动画的逐帧采样：旧实现复用底部 toast 的 `toast-in` 关键帧，只带
  // translateX(-50%)，动画期间丢掉对话框的 translateY(-50%) —— 弹窗先低半高、
  // 末帧跳回居中（"卡一下"）。这里钉住"8px 滑入 + 末帧居中 + 淡入"。
  await s.evalJs(`(() => {
    window.__confirmFrames = [];
    window.__confirmSampleStop = false;
    let last = performance.now();
    const loop = (now) => {
      const el = document.querySelector('.settings-confirm');
      if (el) {
        const r = el.getBoundingClientRect();
        window.__confirmFrames.push({
          top: r.top,
          height: r.height,
          opacity: +getComputedStyle(el).opacity,
          dt: +(now - last).toFixed(1),
        });
      }
      last = now;
      if (!window.__confirmSampleStop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return true;
  })()`);

  // ① fresh 包（v1，未声明能力）：模态 + 事实块 + 安全焦点
  await installWith("lupx_v1.lupx");
  const modal1 = await s.evalJs(`(() => {
    const dialog = document.querySelector('.settings-confirm[role="dialog"]');
    const facts = dialog?.querySelector('.plg-install-facts');
    return {
      open: !!dialog,
      modal: dialog?.getAttribute('aria-modal') ?? '',
      title: dialog?.querySelector('.settings-confirm-title')?.textContent ?? '',
      hint: dialog?.querySelector('.settings-confirm-hint')?.textContent ?? '',
      name: facts?.querySelector('.plg-name')?.textContent ?? '',
      version: facts?.querySelector('.plg-ver')?.textContent ?? '',
      kind: facts?.querySelector('.plg-badge')?.textContent ?? '',
      permsLabel: facts?.querySelector('.plg-dlabel')?.textContent ?? '',
      noPerms: facts?.querySelector('.plg-dsec .plg-note')?.textContent ?? '',
      stats: facts?.querySelector('.plg-install-stats')?.textContent ?? '',
      overlay: !!document.querySelector('.settings-confirm-overlay'),
      inert: document.querySelector('.settings-content')?.hasAttribute('inert') ?? false,
      focusCancel: document.activeElement === dialog?.querySelector('.settings-confirm-actions .settings-action:not(.settings-action-primary)'),
    };
  })()`);
  check("弹窗: 「安装插件」打开模态确认框（overlay + aria-modal + 标题）",
    modal1.open && modal1.overlay && modal1.modal === "true" && modal1.title.includes("安装插件"), JSON.stringify(modal1));
  check("弹窗: 事实块显示名称/版本/kind/文件数",
    modal1.name === "Lupx Demo" && modal1.version === "1.0.0" && modal1.kind.length > 0 && /2 个文件/.test(modal1.stats), JSON.stringify(modal1));
  check("弹窗: 未声明能力时给出说明行（不为空）",
    modal1.permsLabel.length > 0 && modal1.noPerms.includes("未声明"), JSON.stringify(modal1));
  check("弹窗: 背景 inert 且焦点落在取消（安全动作）",
    modal1.inert && modal1.focusCancel, JSON.stringify({ inert: modal1.inert, focusCancel: modal1.focusCancel }));
  check("弹窗: 提示确认前不写入", modal1.hint.includes("确认前不会写入"), modal1.hint);

  const appear = await s.evalJs(`(() => {
    window.__confirmSampleStop = true;
    const frames = window.__confirmFrames;
    const tops = frames.map((f) => f.top);
    const vh = innerHeight;
    const h = frames[0]?.height ?? 0;
    return {
      frames: frames.length,
      jump: +(Math.max(...tops) - Math.min(...tops)).toFixed(1),
      maxDt: +Math.max(...frames.map((f) => f.dt)).toFixed(1),
      firstOpacity: frames[0]?.opacity ?? -1,
      lastOpacity: frames.at(-1)?.opacity ?? -1,
      lastTop: +tops.at(-1).toFixed(1),
      centeredTop: +((vh - h) / 2).toFixed(1),
    };
  })()`);
  check("弹窗: 出现动画无跳变（8px 滑入、末帧居中、淡入）",
    appear.frames >= 4 && appear.jump <= 12
      && Math.abs(appear.lastTop - appear.centeredTop) <= 1.5
      && appear.firstOpacity < 0.9 && appear.lastOpacity === 1,
    JSON.stringify(appear));

  // ② Esc 关闭 → 背景恢复、焦点还给触发按钮、不落盘
  await s.evalJs(`document.querySelector('.settings-confirm')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await sleep(250);
  const escClosed = await s.evalJs(`({
    open: !!document.querySelector('.settings-confirm'),
    inert: document.querySelector('.settings-content')?.hasAttribute('inert') ?? true,
    focusBack: document.activeElement?.classList?.contains('plg-install-btn') ?? false,
  })`);
  check("弹窗: Esc 关闭、背景解除 inert、焦点回到触发按钮",
    !escClosed.open && !escClosed.inert && escClosed.focusBack, JSON.stringify(escClosed));
  check("弹窗: Esc 取消不落盘", !(await pluginIds()).includes("lupx-demo"), (await pluginIds()).join(","));

  // ③ 带权限的包（3.0.0）：能力 chips + 未签名哈希提示
  await installWith("lupx_perms.lupx");
  const modal2 = await s.evalJs(`(() => {
    const dialog = document.querySelector('.settings-confirm');
    const chips = Array.from(dialog?.querySelectorAll('.plg-perm-chip') ?? []);
    return {
      open: !!dialog,
      chips: chips.map((c) => c.textContent),
      chipTitles: chips.map((c) => c.getAttribute('title') ?? ''),
      unsigned: dialog?.querySelector('.plg-note[title]')?.textContent ?? '',
    };
  })()`);
  check("弹窗: 声明能力渲染为本地化 chips（带说明 title）",
    modal2.open && modal2.chips.length === 2 && modal2.chips.join(",").includes("剪贴板")
      && modal2.chipTitles.every((title) => title.length > 0), JSON.stringify(modal2));
  check("弹窗: 未签名包显示 SHA-256 提示", modal2.unsigned.includes("SHA-256"), modal2.unsigned);

  // ④ 确认安装 → 真实落盘 + 列表刷新 + toast（弹窗关闭）
  await s.evalJs(`document.querySelector('.settings-confirm-actions .settings-action-primary')?.click(); true`);
  await sleep(1600);
  const afterInstall = await s.evalJs(`({
    open: !!document.querySelector('.settings-confirm'),
    toast: document.querySelector('.settings-status')?.textContent ?? '',
    cards: Array.from(document.querySelectorAll('.plg-card .plg-name')).map((n) => n.textContent),
  })`);
  const installed = (await invoke("get_plugins")).find((p) => p.id === "lupx-demo");
  check("弹窗: 确认后弹窗关闭、列表出现新卡并提示安装完成",
    !afterInstall.open && afterInstall.cards.some((n) => n.includes("Lupx Demo")) && afterInstall.toast.includes("已安装"),
    JSON.stringify(afterInstall));
  check("弹窗: 落盘版本来自包内清单（3.0.0）", installed?.version === "3.0.0", installed?.version);

  // ⑤ 已装 3.0.0 再选 1.0.0 → 降级黄字提示；取消按钮不写盘
  await installWith("lupx_v1.lupx");
  const modal3 = await s.evalJs(`({
    open: !!document.querySelector('.settings-confirm'),
    warn: document.querySelector('.settings-confirm .plg-note.warn')?.textContent ?? '',
    warnCount: document.querySelectorAll('.settings-confirm .plg-note.warn').length,
  })`);
  check("弹窗: 降级包按关系显示黄字回退提示",
    modal3.open && modal3.warnCount === 1 && modal3.warn.includes("回退") && modal3.warn.includes("3.0.0"),
    JSON.stringify(modal3));
  await s.shot("lupx_install_dialog.png");
  await s.evalJs(`document.querySelector('.settings-confirm-actions .settings-action:not(.settings-action-primary)')?.click(); true`);
  await sleep(300);
  const stillInstalled = (await invoke("get_plugins")).find((p) => p.id === "lupx-demo");
  check("弹窗: 取消按钮关闭且保持已装版本 3.0.0",
    !(await s.evalJs(`!!document.querySelector('.settings-confirm')`)) && stillInstalled?.version === "3.0.0",
    stillInstalled?.version);

  // 收尾：清掉测试插件、还原真实 invoke
  await tryInvoke("plugin_uninstall", { id: "lupx-demo" });
  await sleep(600);
  await s.evalJs(`(() => {
    if (window.__lupxRealFetch) window.fetch = window.__lupxRealFetch;
    window.__lupxDialogTarget = null;
    return true;
  })()`);
  check("弹窗: 收尾卸载测试插件", !(await pluginIds()).includes("lupx-demo"), (await pluginIds()).join(","));
}

await s.shot("lupx_settings.png");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
