//! 便携 zip 打包 —— 现阶段唯一的分发格式。
//!
//! `pnpm tauri build` 只出二进制（tauri.conf.json 的 bundle.targets 为空数组 =
//! 不产 MSI/NSIS）；本脚本按便携布局（docs/NORMS.md：一切都在 exe 旁边）暂存
//! 并压缩为 zip。产物：`src-tauri/target/release/bundle/zip/Lume_<版本>_x64_portable.zip`，
//! zip 根是一个 `Lume/` 文件夹，解压即用。
//!
//! 内容清单（缺一不可）：
//!   lume.exe / lume-agent.exe / lume-svc.exe —— agent 与 svc 都按
//!     `exe_dir()` 定位自身（agent.rs AGENT_EXE、svc.rs）；
//!   languages/*.json —— i18n 运行时覆盖（paths::languages_dir()）；
//!   res/icons/* —— 深浅主题应用图标（图标本身已 include_bytes! 进二进制，
//!     随包携带与 tauri resources 映射保持一致）。

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tauriDir = path.join(root, "src-tauri");
const release = path.join(tauriDir, "target", "release");
const conf = JSON.parse(readFileSync(path.join(tauriDir, "tauri.conf.json"), "utf8"));
const productName = conf.productName;
const version = conf.version;

console.log(`[package] tauri build (${productName} v${version})…`);
const build = spawnSync("pnpm tauri build", { shell: true, stdio: "inherit", cwd: root });
if (build.status !== 0) process.exit(build.status ?? 1);

const stageRoot = path.join(release, "bundle", "portable");
const stage = path.join(stageRoot, productName);
rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const exe of ["lume.exe", "lume-agent.exe", "lume-svc.exe"]) {
  const src = path.join(release, exe);
  if (!existsSync(src)) {
    console.error(`[package] 缺少 ${exe} —— cargo 构建未完成？`);
    process.exit(1);
  }
  cpSync(src, path.join(stage, exe));
}

/** 复制目录（递归）；源不存在则报错退出 —— 便携包不能静默缺目录。 */
function copyDir(src, dst) {
  if (!existsSync(src)) {
    console.error(`[package] 缺少目录 ${src}`);
    process.exit(1);
  }
  cpSync(src, dst, { recursive: true });
  console.log(`[package] + ${path.relative(stage, dst)} (${countFiles(src)} 个文件)`);
}

function countFiles(dir) {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = path.join(dir, e);
    n += statSync(p).isDirectory() ? countFiles(p) : 1;
  }
  return n;
}

copyDir(path.join(root, "languages"), path.join(stage, "languages"));
copyDir(path.join(root, "res", "icons"), path.join(stage, "res", "icons"));

const outDir = path.join(release, "bundle", "zip");
mkdirSync(outDir, { recursive: true });
const zipName = `${productName}_${version}_x64_portable.zip`;
const zipPath = path.join(outDir, zipName);
rmSync(zipPath, { force: true });

// Compress-Archive 以 -Path 指向的文件夹本身作为 zip 根（Lume/…）。
const ps =
  `Compress-Archive -Path '${stage.replaceAll("'", "''")}'` +
  ` -DestinationPath '${zipPath.replaceAll("'", "''")}' -CompressionLevel Optimal`;
const zip = spawnSync(
  "powershell.exe",
  ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
  { stdio: "inherit" }
);
if (zip.status !== 0) process.exit(zip.status ?? 1);

console.log(`[package] 完成: ${zipPath}`);
