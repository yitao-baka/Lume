// Copy the release `lume-svc.exe` into `src-tauri/binaries/` so Tauri's
// `bundle.externalBin` can ship it next to `lume.exe` (docs/ROADMAP service
// iteration). Runs as `beforeBundleCommand`; only needed for installer bundles.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "src-tauri", "target", "release", "lume-svc.exe");
const dstDir = resolve(root, "src-tauri", "binaries");
// Tauri v2 externalBin requires the target-triple suffix on the file name; it
// strips it back to `lume-svc.exe` when bundling next to `lume.exe`.
const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? "x86_64-pc-windows-msvc";
const dst = resolve(dstDir, `lume-svc-${triple}.exe`);

if (!existsSync(src)) {
  console.error(
    `[copy-lume-svc] ${src} not found — run \`cargo build --release --bin lume-svc\` first.`
  );
  process.exit(1);
}
mkdirSync(dstDir, { recursive: true });
cpSync(src, dst, { force: true });
console.log(`[copy-lume-svc] bundled ${src} -> ${dst}`);
