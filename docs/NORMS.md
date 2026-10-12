# 项目规范（Norms）

跨功能的通用约定。每个新功能在设计阶段都要对照本文件；与 `AGENTS.md`
的硬性约定、`docs/UI_GUIDELINES.md` 配合使用。

## 目录结构（exe 同级便携目录）

所有配置、数据、资源都位于 **exe 所在目录**（release 为 `lume.exe` 同级；
dev 为 `src-tauri/target/debug/` 下）。Lume 因此可以整体拷贝带走（便携式）。

```
<exe_dir>/
├── settings/      # 设置文件：settings.toml 唯一生效（含 default/backup）
├── languages/     # i18n 语言文件（JSON + i18next）
├── res/           # 软件资源（图标、音乐等）；res/icons/ 放应用图标
├── data/          # lume.db、plugin_store.db 与可重建的索引/图标缓存
└── plugins/       # 磁盘插件：<id>/plugin.toml + 入口/视图/私有 files/
```

**安装模式（Program Files）**：当 exe 位于 `Program Files`（普通用户只读）
时，所有可写数据（`settings/`、`data/`、`languages/` 覆盖层）搬到
`%LOCALAPPDATA%\Lume\`，内部目录结构不变；`res/` 等只读资源留在 exe 同级。
便携式（exe 不在 Program Files）维持 exe 同级。双模式判定与数据根目录统一
在 `paths.rs`（`install_detected()` / `base_dir()`）；首启把 exe 同级的旧
数据复制到 LocalAppData（只拷不删）。SYSTEM 服务通过
`HKLM\Software\Lume\DataDir` 定位同一数据目录（其自身的 `%LOCALAPPDATA%`
是系统配置目录，不能用）。

## settings/ 设置文件

- `settings.toml` — **唯一被软件读取生效**的文件。启动时读取；若不存在则
  复制 `default.toml` 并改名为 `settings.toml`。
- `default.toml` — 出厂默认设置，只读语义，不随运行修改。
- `backup.toml` — 每次「保存」「应用」或「导入」前，把当前生效的
  `settings.toml` 原样覆盖备份到这里。
- 导出 = 将当前设置另存为一个外部 toml；导入 = 选择外部 toml 覆盖当前
  `settings.toml`（覆盖前同样先备份）。
- 结构见 `docs/SETTINGS.md` 的 schema。

## languages/ i18n 文件

- 每种语言一个 JSON 文件（如 `en.json`、`zh-CN.json`、`zh-TW.json`），
  通过 i18next 加载。
- 所有 UI 字符串必须走 i18n 字符串表，禁止硬编码（既有约定，延续）。

## res/ 资源

- 图标、音乐等所有软件资源统一放 `res/`；应用图标放 `res/icons/`。

## data/ 数据库

- 程序所有 SQLite / 数据库文件放 `data/`：
  - `lume.db` — 剪贴板历史、最近使用、固定项；
  - `plugin_store.db` — 插件文档库与声明式设置值；
  - `system32_cache.db` / `user_cache.db` / `icons.db` — 可随时重建的索引缓存。

## plugins/ 插件目录

- 每个磁盘插件占 `<base>/plugins/<id>/`，清单为 `plugin.toml`，入口/视图
  资产相对插件目录解析；插件私有文件写在 `<id>/files/`。
- 清单 `permissions` 是强制执行的能力台账，不是展示字段；新增能力必须同时
  更新前端 RPC 台账与 Rust 侧 `plugin_perm.rs`。
- `.lupx` 是插件分发包；安装、签名、覆盖升级与私有文件保留由
  `plugin_install.rs` / `plugin_sign.rs` 负责。
- 内置插件（apps / clipboard / preview）与磁盘插件走同一注册表和启停路径。

## 组件质量（UI）

- 所有 UI 组件要求**现代且美观**：干净的层级、克制的配色、圆角、自然
  的过渡，与 `docs/UI_GUIDELINES.md` 的视觉契约一致。
- 当自建组件无法满足需求时，**可以从网络寻找外部组件库**（SolidJS 生态
  优先），但需保持风格统一、不破坏三语言 i18n 与简约原则。

## 版本号（双版本机制）

- **对外标签**：用户可见版本，位于 `src/appVersion.ts` 的 `APP_VERSION_LABEL`，
  About 页渲染它（当前 `Pre-26.10`，`<年份-月份>` 预发布格式）。
- **内部 semver**：`Cargo.toml` / `tauri.conf.json` / `package.json` 的
  `version`，仅用于构建/打包，**必须满足 semver**（tauri 构建强制校验版本，
  报 `'tauri.conf.json > version' must be a semver string`）。当前为 `2.8.0`。
- 两者相互独立、需手动同步；发布时先改两者，再打 tag / 建 GitHub Release。

## 开发流程：每次改动必编译

- **每完成一处改动，立即编译验证**，交付时必须是「可直接运行测试」的状态，
  方便用户马上验证：Rust 侧跑 `cargo check` + 相关单测；前端改动跑
  `pnpm run build` + `pnpm exec tsc --noEmit`；大改动/收尾时用
  `pnpm run tauri build --debug --no-bundle` 出内嵌前端的 debug exe 供 CDP
  冒烟；发布/手工分发用 `pnpm run tauri build --no-bundle`，便携包用
  `pnpm run package:zip`。
- **编译或测试失败不允许声称完成**——如实报告失败输出，修复通过后再交付。
- 涉及新 i18n 文案时，编译前确认 en / zh-CN / zh-TW 三语键已同步（`Messages`
  类型以 en.json 为准，缺键会导致 tsc 报错）。
- **每次同步 GitHub 后必须编译测试**——拉取远程提交（快进/合并/清理）后，
  对新状态立即验证：`cargo check` + `cargo test` + `pnpm exec tsc --noEmit`
  （必要时再跑前端 build），确认远程改动在本机可编译、测试通过后再交付测试。
  若失败，如实报告并定位后再继续。
