#!/usr/bin/env bash
# Portable, zip-only release packaging (Git Bash / MSYS2 on Windows).
#
# Produces `target/release/Lume-<version>-win-x64.zip` — a self-contained folder
# (lume.exe + lume-agent.exe + lume-svc.exe + languages/ + res/) built from the
# current source. This is the standard release artifact; MSI/NSIS installers are
# not produced (bundle.targets is empty).
#
# `pnpm run tauri build --no-bundle` builds the frontend + Rust core; the three
# binaries are assembled under their plain names (the portable model expects the
# elevation agent and service to sit next to lume.exe).
set -euo pipefail
cd "$(dirname "$0")/.."

echo '[package] building frontend + Rust core (release)'
pnpm run tauri build --no-bundle
cargo build --release --bins --manifest-path src-tauri/Cargo.toml

VER="$(node -p "require('./package.json').version")"
PKG="Lume-$VER-win-x64"
REL="src-tauri/target/release"
DEST="$REL/$PKG"
rm -rf "$DEST"
mkdir -p "$DEST"

echo '[package] assembling portable folder'
cp "$REL/lume.exe"       "$DEST/"
cp "$REL/lume-agent.exe" "$DEST/"
cp "$REL/lume-svc.exe"   "$DEST/"
cp -r languages "$DEST/languages"
cp -r res "$DEST/res"

echo "[package] zipping → $REL/$PKG.zip"
rm -f "$REL/$PKG.zip"
powershell -NoProfile -Command "
  Compress-Archive -Path '$REL/$PKG' -DestinationPath '$REL/$PKG.zip' -Force
" > /dev/null
echo "[package] done: $(du -h "$REL/$PKG.zip" | cut -f1)  →  $REL/$PKG.zip"