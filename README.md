<div align="center">
  <img src="src-tauri/icons/icon-transparent.png" width="112" alt="Lume" />
  <h1>Lume</h1>
  <p><strong>快速、轻量、可扩展的 Windows 启动器。</strong></p>
  <p>把应用与文件检索、剪贴板历史、自动化和插件，收进同一个键盘入口。</p>
</div>

> Lume is a fast, minimal and extensible productivity launcher for Windows.

## Lume 是什么

Lume 是一个面向 Windows 的本地生产力启动器。呼出后，你可以直接输入应用名、拼音或关键词，继续搜索整盘文件、取回剪贴板内容，或进入插件页面完成更具体的工作。

它的目标不是成为大而全的工具箱，而是缩短高频操作与结果之间的距离：

- **快**：隐藏启动、键盘优先，搜索与呼出路径始终围绕低延迟设计。
- **轻**：常驻资源受限，辅助窗口按需创建并回收，不把重媒体塞进主渲染器。
- **可扩展**：核心页面与第三方插件走同一套页面运行时，扩展不必改动启动器外壳。

Lume 借鉴 Spotlight、uTools 等键盘启动器的交互方式，但保持自己的实现、视觉与插件模型。

## 主要能力

### 启动与检索

- 可配置全局快捷键，默认 `Alt+Space`；快捷键被其他程序占用时会明确报告冲突。
- 隐藏启动、单实例运行、失焦自动隐藏，并可从系统托盘切换、重启或退出；再次双击 `lume.exe` 或桌面快捷方式会唤醒并聚焦已有主窗口。
- 首次使用提供独立欢迎窗口与四步交互引导：呼出快捷键、模式切换、打开设置与开机自启；可从“设置 → 关于”重新观看。
- 搜索应用与常用文件，支持模糊匹配和中文拼音检索。
- 首页提供最近使用、固定应用与插件上下文栏目，支持键盘、鼠标和拖拽排序。
- 检测资源管理器当前文件夹，可直接在 CMD、PowerShell 中打开或复制路径。
- 支持以管理员身份启动应用；整盘文件搜索优先使用运行中的 Everything，否则使用 `LumeSVC` 的 NTFS USN/MFT 索引。
- 需要确认内容时，可在启动器右侧的非激活卫星窗中预览文本、图片、音视频或 PDF，不占用主渲染器。

### 剪贴板历史

- 记录文本、图片、文件和媒体文件等剪贴板内容，并追踪来源应用。
- 支持分类、搜索、固定、删除与撤销、暂停记录、忽略应用和内容去重。
- 可多选条目后合并粘贴，也可把历史内容复制回系统剪贴板。
- 支持富文本、纯文本复制、图片与多文件的还原，以及粘贴到呼出前的前台窗口。


### 插件平台

Lume 的插件由 `plugin.toml` 清单和入口代码组成，分为三类贡献：

| 类型 | 作用 |
| --- | --- |
| `provider` | 向搜索结果追加条目或动作 |
| `mode` | 提供完整页面，由 Page Service 与一个或多个 Presenter 组成 |
| `service` | 订阅显示、隐藏与查询等生命周期事件 |

插件能力包括沙箱化的 mode 页面、Rust 侧 fail-closed 权限校验、分离窗口、声明式设置、私有文件与文档存储、开发热重载，以及带签名校验的 `.lupx` 安装包。内置导航与剪贴板页面通过同一插件注册体系接入；导航首页是固定入口，剪贴板页面可启停。

从 [插件开发指南](docs/PLUGINS.md) 开始编写插件；完整契约见 [插件 API 参考](docs/PLUGIN_API.md)。

### 个性化与系统集成

- 简体中文、繁体中文、英文三套界面。
- Quiet / Chromatic 双皮肤，可分别设置启动器与设置窗口；支持明暗模式、主题色、主窗口颜色和整体不透明度。
- 设置窗口包含外观、启动器、剪贴板、搜索、快捷键、自动化、插件、系统与关于九个分区。
- 自动化规则可在指定程序打开新窗口时发送一次配置热键。
- 支持开机启动、系统托盘、后台索引服务与最小权限提权代理。

## 设计边界

Lume 只维护能明显缩短高频操作路径的能力。磁盘插件使用标准 Web API 与沙箱桥接，不提供 Node.js 级无沙箱运行时；项目不内置重型媒体或浏览器内核，也不把模拟键鼠开放给普通插件。

开放事项与明确不做列表见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 快速开始

### 环境要求

- Windows x64（使用 WebView2；验证环境为 Windows 11）
- Rust stable（MSVC toolchain）
- Visual Studio Build Tools，包含“使用 C++ 的桌面开发”和 Windows SDK
- Node.js 24 与 pnpm `12.3.4`
- 构建 EXE 安装包时另需 .NET SDK 10+ 与可用的 MSBuild

仓库通过 `.npmrc` 使用 npm 镜像。依赖版本以 `pnpm-lock.yaml` 与 `package.json` 的 `packageManager` 为准。

```powershell
git clone https://github.com/yitao-baka/Lume.git
cd Lume
corepack enable
pnpm install
pnpm run tauri dev
```

### 构建便携包

```powershell
pnpm run package:zip
```

产物位于：

```text
src-tauri/target/release/bundle/zip/Lume_<version>_x64_portable.zip
```

将 zip 完整解压后运行 `lume.exe`。`lume.exe`、`lume-svc.exe` 与 `lume-agent.exe` 必须保持在同一个目录，`languages/` 和 `res/icons/` 也应随包保留。

### 构建 EXE 安装包

Lume 使用 [MicaSetup](https://github.com/lemutec/MicaSetup) 2.5.7 生成带安装界面的 EXE；不使用 MSI 或 NSIS：

```powershell
pnpm run package:installer
```

产物位于：

```text
src-tauri/target/release/bundle/installer/Lume_<version>_x64_setup.exe
```

脚本从华为云 NuGet 镜像读取固定版本的 MicaSetup 工具，并校验 SHA-512。默认安装到 `Program Files\Lume`，安装包保留现有的服务与提权代理选择；升级前会暂停归属当前安装目录的服务/任务，升级后恢复，卸载时只清理同一目录拥有的注册。用户数据仍保留在 `%LOCALAPPDATA%\Lume\`。

如果 .NET SDK 不在 `PATH`，把 `LUME_INSTALLER_DOTNET_ROOT` 指向包含 `sdk/` 的 dotnet 根目录。安装包默认不做 Authenticode 签名，正式发布前需要完成代码签名。

单独构建二进制时：

```powershell
# 内嵌前端的 debug exe，适合隔离 UI 验证
pnpm run tauri build --debug --no-bundle

# 无控制台的 release exe
pnpm run tauri build --no-bundle
```

Tauri 构建会通过 `beforeBuildCommand` 自动执行前端生产构建，不需要在构建前手动运行 `pnpm run build`。

## 架构

```text
SolidJS + TypeScript WebView
          │
          │ Tauri IPC / invoke
          ▼
Rust core ── SQLite + Windows API
          │
          ├─ Everything IPC
          ├─ LumeSVC named pipe
          └─ elevation agent named pipe
```

Lume 由三个同目录二进制组成：

| 二进制 | 职责 |
| --- | --- |
| `lume.exe` | 启动器、设置、剪贴板、搜索与插件宿主，保持中完整性 |
| `lume-svc.exe` | SYSTEM 权限的 NTFS 文件索引服务，通过受限命名管道响应查询 |
| `lume-agent.exe` | 最小提权代理，只负责向指定前台窗口发送一次配置好的热键 |

核心原则：

- **业务逻辑属于 Rust**。WebView 只调用命令并渲染结果，不直接访问数据库或设置文件。
- **数据留在本机**。应用不依赖账号或云服务；插件网络访问经由宿主能力与权限检查。
- **权限必须显式声明**。插件页面运行在沙箱中，前端守卫与 Rust 命令侧白名单共同执行 fail-closed 校验。
- **提权面保持最小**。启动器本身不提权；文件索引服务与按键注入代理各自承担单一职责。

### 项目结构

| 路径 | 内容 |
| --- | --- |
| `src/` | SolidJS 启动器、设置页、Page Runtime、Presenter 与内置插件 |
| `src-tauri/src/` | Rust 核心、Windows 集成、三个二进制与全部业务逻辑 |
| `scripts/` | 验证入口、隔离 CDP 测试、便携/安装包构建与契约检查 |
| `languages/` | `en`、`zh-CN`、`zh-TW` 三套运行时文案 |
| `res/` | 主题图标等只读资源 |
| `examples/plugins/` | 可加载的插件示例与构建产物 |
| `docs/` | 活跃契约文档及历史归档 |

### 数据位置

便携运行时，数据位于 exe 同级目录；装在 `Program Files` 下时，可写数据迁移到 `%LOCALAPPDATA%\Lume\`。

```text
<base>/
├── settings/
│   ├── settings.toml   # 唯一生效的设置
│   ├── default.toml    # 出厂默认值
│   └── backup.toml     # 保存前快照
├── data/
│   ├── lume.db         # 剪贴板、最近使用、固定应用
│   ├── plugin_store.db # 插件文档
│   ├── PictureCache/   # 剪贴板图片
│   └── *.db            # 可重建的索引缓存
└── languages/

<exe_dir>/
└── res/icons/          # 只读运行资源，保持在 exe 同级
```

更完整的模块、生命周期与数据规则见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 开发与验证

日常代码门禁：

```powershell
pnpm verify:docs       # 文档链接、UTF-8 与测试清单
pnpm verify:fast       # 静态检查、前端单测/构建、Rust 单测
pnpm verify:ui         # 隔离的 Windows CDP UI 套件
pnpm verify:ui:changed # 按当前 diff 选择 UI 套件
pnpm verify:release    # 发布前自动门禁
```

常用 Rust 检查：

```powershell
cd src-tauri
cargo check
cargo test
```

UI 套件会复制独立 exe、语言和资源到 `test/verify/`，使用私有数据目录、动态调试端口和自己的 WebView2 profile，只终止自身进程树。真实 UAC、服务注册、系统级快捷键和原生窗口交互仍需按 [手工测试清单](docs/MANUAL_TESTING.md) 验证。

完整的变更矩阵、套件说明与排障方式见 [docs/TESTING.md](docs/TESTING.md)。

## 插件开发

推荐阅读顺序：

1. [docs/PLUGINS.md](docs/PLUGINS.md)：从清单、入口到权限和安装的最小指南。
2. [docs/PLUGIN_API.md](docs/PLUGIN_API.md)：Provider、Page Service、Presenter、宿主能力与调试契约。
3. [examples/plugins/](examples/plugins/)：可直接加载的 provider、mode、service、分离窗口、标题栏与文件搜索示例。

新增宿主能力时，需要同步更新前端 RPC、权限台账与 Rust 侧校验；跨 `postMessage` 的返回值必须可结构化克隆。

## 文档索引

| 主题 | 文档 |
| --- | --- |
| 仓库工作守则与命令 | [AGENTS.md](AGENTS.md) |
| 模块划分、窗口与数据生命周期 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 启动器视觉契约 | [docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md) |
| 设置窗口与字段规范 | [docs/SETTINGS.md](docs/SETTINGS.md) |
| 皮肤与主题令牌 | [docs/SKIN_SYSTEM.md](docs/SKIN_SYSTEM.md) |
| 插件上手指南 | [docs/PLUGINS.md](docs/PLUGINS.md) |
| 插件 API 参考 | [docs/PLUGIN_API.md](docs/PLUGIN_API.md) |
| 自动化验证 | [docs/TESTING.md](docs/TESTING.md) |
| 真实桌面/UAC 清单 | [docs/MANUAL_TESTING.md](docs/MANUAL_TESTING.md) |
| 开放事项 | [docs/ROADMAP.md](docs/ROADMAP.md) |
| 版本记录 | [CHANGELOG.md](CHANGELOG.md) |
| 迭代与实现历史 | [docs/ROADMAP_HISTORY.md](docs/ROADMAP_HISTORY.md) |

## 许可证

Lume 以 [Apache License 2.0](LICENSE) 发布。