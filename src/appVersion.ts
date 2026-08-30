//! 双版本号机制 (dual version).
//!
//! `tauri.conf.json > version` 与 `Cargo.toml > version` 被构建强制要求为
//! semver（否则报 `must be a semver string`）。因此面向用户的公开版本号放在
//! 这里由前端渲染，而打包用的内部 semver 为 `1.0.0`（见上述文件）。
//!
//! 发布时手动保持两处同步：
//!   - 对外标签 = APP_VERSION_LABEL  （About 页展示，如 "Pre-26.8.1"）
//!   - 内部 semver = Cargo.toml / tauri.conf.json / package.json 的 version
export const APP_VERSION_LABEL = "Pre-26.8.1";
