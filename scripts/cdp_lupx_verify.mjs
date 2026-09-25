// .lupx 安装/卸载验证（ROADMAP #28 / P4 第一步）：
//   ① inspect   合法包（plugin.toml 在根）返回 id/版本/权限/文件数；不存在的
//               文件、无清单包、含 `../` 条目的包分别被明确拒绝
//   ② install   安装 → get_plugins 出现该插件 → 无需重启 provider 搜索行直接
//               可见（settings-applied + plugin-reload 生效）
//   ③ subdir    「右键压缩文件夹」形状（plugin.toml 在唯一顶层目录内）可装，
//               前缀外的散文件被忽略（确认卡与实际解压都是 2 个文件）
//   ④ upgrade   v1 → v2：inspect 报 existingVersion=1.0.0（覆盖警示的依据），
//               安装后 get_plugins 版本变 2.0.0，搜索行照常（模块已重 import）
//   ⑤ uninstall 卸载 → get_plugins 不再列出 → 搜索行消失；重复卸载不报错
//   ⑥ 设置页    工具栏有「安装插件」按钮；磁盘插件卡片有卸载按钮（两段式，
//               armed 类名出现再消失）；内置插件没有
// 说明：安装确认卡由 Solid 信号驱动，自动化无法从外部注入状态，卡片的渲染
// 以设置页手工清单兜底（docs/TESTING.md）；本脚本覆盖命令层全链路。
// 截图：test/lupx_settings.png
import { spawn, execSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, openSync, existsSync } from "node:fs";

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
const ZIP_SUBDIR = makeZip([
  ["lupx-demo/plugin.toml", manifest("1.0.0")],
  ["lupx-demo/main.js", MAIN_JS],
  ["README.txt", "stray file outside the plugin prefix"],
]);
const ZIP_EVIL = makeZip([["plugin.toml", manifest("9.9.9")], ["../evil.txt", "boom"]]);
const ZIP_NOMANIFEST = makeZip([["main.js", MAIN_JS]]);
writeFileSync("test/lupx_v1.lupx", ZIP_V1);
writeFileSync("test/lupx_v2.lupx", ZIP_V2);
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
  && Array.isArray(v1.ok.permissions) && v1.ok.fileCount === 2 && v1.ok.existingVersion === null,
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

// ── ④ upgrade：existingVersion + 覆盖 + 重 import ──
const v2 = await tryInvoke("plugin_lupx_inspect", { sourcePath: abs("lupx_v2.lupx") });
check("inspect: 已装同 id → existingVersion=1.0.0", v2.ok && v2.ok.existingVersion === "1.0.0", JSON.stringify(v2.ok?.existingVersion));
await tryInvoke("plugin_lupx_install", { sourcePath: abs("lupx_v2.lupx") });
await sleep(1400);
const info2 = (await invoke("get_plugins")).find((p) => p.id === "lupx-demo");
check("upgrade: get_plugins 版本变为 2.0.0", info2?.version === "2.0.0", info2?.version);
await type("zzqq");
await sleep(800);
check("upgrade: 重 import 后 provider 行仍可用", (await rowNames()).some((r) => r.includes("LUPX 测试条目")));

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
// 两段式：第一击武装（armed 类出现），不落第二击
const armed = await s.evalJs(`(() => {
  const b = document.querySelector('.plg-uninstall');
  b.click();
  return b.classList.contains("armed");
})()`);
await sleep(3500); // 等 3s 武装窗口自然解除
const disarmed = await s.evalJs(`!document.querySelector('.plg-uninstall')?.classList.contains("armed")`);
check("设置页: 卸载按钮两段式（武装→超时解除）", armed && disarmed, `armed=${armed} disarmed=${disarmed}`);
await s.shot("lupx_settings.png");

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
