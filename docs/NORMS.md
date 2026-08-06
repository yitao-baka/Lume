# 项目规范（Norms）

跨功能的通用约定。每个新功能在设计阶段都要对照本文件；与 `CLAUDE.md`
的 Conventions、`docs/UI_GUIDELINES.md` 配合使用。

## 目录结构（exe 同级便携目录）

所有配置、数据、资源都位于 **exe 所在目录**（release 为 `lume.exe` 同级；
dev 为 `src-tauri/target/debug/` 下）。Lume 因此可以整体拷贝带走（便携式）。

```
<exe_dir>/
├── settings/      # 设置文件：settings.toml 唯一生效（含 default/backup）
├── languages/     # i18n 语言文件（JSON + i18next）
├── res/           # 软件资源（图标、音乐等）；res/icons/ 放应用图标
├── data/          # 程序所有数据库（lume.db 等）
└── plugins/       # （预留）插件配置，插件系统实现后启用
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

- 程序所有 SQLite / 数据库文件放 `data/`。剪贴板历史即 `data/lume.db`。

## 插件配置（预留）

- 每个插件一个独立配置文件；插件系统实现后生效，届时再细化。

## 组件质量（UI）

- 所有 UI 组件要求**现代且美观**：干净的层级、克制的配色、圆角、自然
  的过渡，与 `docs/UI_GUIDELINES.md` 的视觉契约一致。
- 当自建组件无法满足需求时，**可以从网络寻找外部组件库**（SolidJS 生态
  优先），但需保持风格统一、不破坏三语言 i18n 与简约原则。

## 开发流程：每次改动必编译

- **每完成一处改动，立即编译验证**，交付时必须是「可直接运行测试」的状态，
  方便用户马上验证：Rust 侧跑 `cargo check` + 相关单测；前端改动跑
  `npm run build` + `npx tsc --noEmit`；大改动/收尾时用
  `npm run tauri build -- --no-bundle` 出独立 exe 并启动冒烟测试。
- **编译或测试失败不允许声称完成**——如实报告失败输出，修复通过后再交付。
- 涉及新 i18n 文案时，编译前确认 en / zh-CN / zh-TW 三语键已同步（`Messages`
  类型以 en.json 为准，缺键会导致 tsc 报错）。
- **每次同步 GitHub 后必须编译测试**——拉取远程提交（快进/合并/清理）后，
  对新状态立即验证：`cargo check` + `cargo test` + `npx tsc --noEmit`
  （必要时再跑前端 build），确认远程改动在本机可编译、测试通过后再交付测试。
  若失败，如实报告并定位后再继续。
