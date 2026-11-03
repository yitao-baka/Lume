//! Static i18n checks (docs/TESTING.md):
//!
//!   1. `languages/en.json`, `zh-CN.json` and `zh-TW.json` carry the same key
//!      set (the `Messages` type and the runtime override merge are per key).
//!   2. Every key is referenced from `src/**` or `src-tauri/src/**` as a quoted
//!      literal — an unused key is dead weight that still has to be translated.
//!      Plural variants (`<key>_one` / `<key>_other`) are covered by their base
//!      key, which i18next resolves with a numeric `count`.
//!   3. Every Chinese settings-search keyword in `src/settings/catalog.ts` has
//!      its other-script twin in the same array, so a query in either script
//!      hits the row (the glossary lives in ZH_GROUPS below; a new term must be
//!      added there, which keeps this check honest).
//!
//! Usage: node scripts/check_i18n.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LANGS = ["en", "zh-CN", "zh-TW"];
const bundles = Object.fromEntries(
  LANGS.map((lang) => [lang, JSON.parse(fs.readFileSync(path.join(root, "languages", `${lang}.json`), "utf8"))]),
);

const failures = [];
const fail = (message) => failures.push(message);

// ── 1. key parity ──
const baseKeys = Object.keys(bundles.en);
const baseKeySet = new Set(baseKeys);
for (const lang of LANGS.slice(1)) {
  const keys = new Set(Object.keys(bundles[lang]));
  const missing = baseKeys.filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !baseKeySet.has(key));
  if (missing.length) fail(`${lang}: missing keys ${missing.join(", ")}`);
  if (extra.length) fail(`${lang}: keys not in en.json ${extra.join(", ")}`);
}

// ── 2. dead keys ──
const sources = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(ts|tsx|rs|mjs|js|html)$/.test(entry.name)) sources.push(full);
  }
};
for (const dir of ["src", "src-tauri/src"]) walk(path.join(root, dir));
const corpus = sources.map((file) => fs.readFileSync(file, "utf8")).join("\n");
for (const key of baseKeys) {
  if (/(_one|_other)$/.test(key)) continue;
  if (!new RegExp(`["'\`]${key}["'\`]`).test(corpus)) fail(`unreferenced key: ${key}`);
}

// ── 3. settings-search keyword pairing ──
// One entry per term: every variant of that term that a user might type. Terms
// whose characters are identical in both scripts sit alone.
const ZH_GROUPS = [
  ["语言", "語言"], ["中文"], ["主题", "主題"], ["主题色", "主題色"],
  ["浅色", "淺色"], ["日之耀面"], ["月之暗面"],
  ["皮肤", "皮膚"], ["风格", "風格"], ["设置窗口", "設定視窗"],
  ["强调色", "強調色"], ["调色盘", "調色盤"],
  ["配色"], ["宽度", "寬度"], ["高度"], ["内容", "內容"], ["位置"],
  ["鼠标", "滑鼠"], ["资源管理器", "資源管理器", "檔案總管"], ["文件夹", "資料夾"],
  ["固定"], ["展开", "展開"], ["模式"], ["图标", "圖示"], ["页面", "頁面"],
  ["重启", "重啟"], ["搜索词", "搜尋詞"], ["数量", "數量"], ["占位符", "佔位符"],
  ["输入法", "輸入法"],
  ["剪贴板", "剪貼簿"], ["条目", "條目"], ["格子"], ["圆形", "圓形"],
  ["历史", "歷史"], ["图片", "圖片"], ["文件", "檔案"], ["记录", "記錄"],
  ["合并", "合併"], ["合并窗口", "合併視窗"], ["隐私", "隱私"], ["来源", "來源"],
  ["应用", "應用"], ["时间", "時間"], ["悬停", "懸停"], ["收藏"], ["置顶", "置頂"],
  ["勾选", "勾選"], ["记住", "記住"], ["索引"], ["目录", "目錄"],
  ["用户索引", "使用者索引"], ["缓存", "快取"], ["刷新"], ["快捷键", "快捷鍵"],
  ["切换", "切換"], ["呼出"], ["自动", "自動"], ["焦点", "焦點"], ["提权", "提權"],
  ["代理"], ["常驻", "常駐"], ["规则", "規則"], ["状态", "狀態"], ["安装", "安裝"],
  ["插件", "外掛"], ["开发", "開發"], ["授权", "授權"], ["开机", "開機"],
  ["服务", "服務"], ["管理员", "管理員"], ["导出", "匯出"], ["导入", "匯入"],
  ["恢复", "還原"], ["备份", "備份"], ["默认", "預設"], ["重设", "重設"],
  ["版本"], ["许可证", "許可證"], ["主页", "主頁"], ["首頁"], ["最近"], ["最近使用"],
  ["深色"], ["闲置", "閒置"], ["重置"], ["分钟", "分鐘"], ["提示"], ["上限"],
  ["去重"], ["忽略"], ["选取", "選取"], ["粘贴", "貼上"], ["预览", "預覽"],
  ["重建"], ["删除", "刪除"], ["初始化"], ["全盘", "全盤"], ["前景"], ["信任"],
];
const groupOf = new Map();
for (const group of ZH_GROUPS) {
  for (const term of group) {
    if (groupOf.has(term)) fail(`ZH_GROUPS lists "${term}" twice`);
    groupOf.set(term, group);
  }
}

const catalog = fs.readFileSync(path.join(root, "src/settings/catalog.ts"), "utf8");
const arrays = [...catalog.matchAll(/keywords:\s*\[([^\]]*)\]/g)].map((m) =>
  [...m[1].matchAll(/"([^"]*)"/g)].map((q) => q[1]),
);
if (arrays.length === 0) fail("catalog.ts: no keywords arrays found");
for (const words of arrays) {
  for (const word of words) {
    if (!/[\u4e00-\u9fff]/.test(word)) continue;
    const group = groupOf.get(word);
    if (!group) {
      fail(`catalog.ts: "${word}" is not in ZH_GROUPS (add the term and its twin)`);
      continue;
    }
    const twins = group.filter((term) => term !== word);
    if (twins.length && !twins.some((term) => words.includes(term))) {
      fail(`catalog.ts: "${word}" is missing its other-script twin (${twins.join(" / ")}) in [${words.join(", ")}]`);
    }
  }
}

if (failures.length) {
  console.error(`i18n check FAILED (${failures.length}):`);
  for (const message of failures) console.error(`  - ${message}`);
  process.exit(1);
}
console.log(
  `i18n check PASS — ${baseKeys.length} keys × ${LANGS.length} languages, ` +
    `${arrays.length} keyword arrays paired`,
);
