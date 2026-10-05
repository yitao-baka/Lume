//! 插件逻辑的全局类型（ROADMAP #32.10）。
//!
//! 在 `@ts-check` 的插件 JS 顶部引用本文件即可获得 ctx 与钩子的类型：
//!
//!   /// <reference path="../plugin-api.d.ts" />
//!   // @ts-check
//!
//! 校验：`pnpm exec tsc -p examples/tsconfig.json`（examples 下的示例随仓库
//! 一起过类型检查）。契约细节见 `docs/PLUGIN_API.md`（§5 Provider、§6D 能力面、
//! §6F 数据层）。

/** 一行搜索结果（provider `search` 的元素）。 */
interface LumeProviderResult {
  name: string;
  description?: string;
  /** 图标：`data:`/`asset:`/`http(s):` URI 或相对插件目录的文件路径。 */
  icon?: string;
  /** 条目路径（打开/去重键；可省）。 */
  path?: string;
}

/** 声明式进入规则的载荷（`[[features]]` 命中后投给 `onFeature`）。 */
interface LumeFeatureInfo {
  code: string;
  payload?: string;
  type?: string;
}

interface LumeAppApi {
  /** 隐藏启动器（通常与 toast 搭配，激活条目后调用）。 */
  hide(): Promise<void>;
  /** 应用内 toast；`opts` 的可选形状见 PLUGIN_API.md §6B.0。 */
  toast(text: string, opts?: { type?: "info" | "warn" | "error"; timeout?: number }): Promise<void>;
  /** 写入启动器搜索框并触发搜索。 */
  setQuery(q: string): Promise<void>;
  setPlaceholder(text: string): Promise<void>;
  /** 打开文件/URL/目录（ShellExecute）。 */
  openPath(path: string): Promise<void>;
  revealPath(path: string): Promise<void>;
  /** 送进回收站（权限 `trash`）。 */
  trash(paths: string[]): Promise<void>;
  /** 系统通知（权限 `notify`；启动器隐藏时也能触达）。 */
  notify(title: string, body: string): Promise<void>;
  /** 跳到另一个插件（`code`/`payload` 随跳转下发）。 */
  redirect(pluginId: string, opts?: { code?: string; payload?: string }): Promise<void>;
  /** 呼出前的前台窗口快照（权限 `window`）。 */
  foreground(): Promise<{ process: string; className: string; title: string } | null>;
}

interface LumeHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 二进制体（优先于 body）。 */
  bodyBase64?: string;
  /** 钳制 1–60 秒。 */
  timeoutMs?: number;
}

interface LumeHttpResponse {
  status: number;
  /** 键小写。 */
  headers: Record<string, string>;
  /** 响应体解码为 UTF-8 文本。 */
  text(): string;
  json<T = unknown>(): T;
  /** 超过 4 MiB 被截断。 */
  truncated: boolean;
}

interface LumeHttpApi {
  /** 权限 `network`；默认拒绝内网目标（清单 `network_allow` 放行）。 */
  request(req: LumeHttpRequest): Promise<LumeHttpResponse>;
}

interface LumeClipboardApi {
  readText(): Promise<string | null>;
  writeText(text: string): Promise<void>;
  readFiles(): Promise<string[]>;
  writeFiles(paths: string[]): Promise<void>;
  readImage(): Promise<string | null>;
  writeImage(base64: string): Promise<void>;
  paste(payload?: { text?: string; image?: string; files?: string[] }): Promise<void>;
}

interface LumeDbDoc {
  _id?: string;
  _rev?: number;
  [key: string]: unknown;
}

interface LumeDbApi {
  /** 文档存储（`<base>/data/plugin_store.db`，按插件隔离）。 */
  get(docId: string): Promise<LumeDbDoc | null>;
  put(doc: LumeDbDoc & { _id: string }): Promise<{ id: string; rev: number }>;
  remove(docId: string, rev: number): Promise<void>;
  allDocs(opts?: {
    idStartsWith?: string;
    limit?: number;
  }): Promise<LumeDbDoc[]>;
  bulkDocs(docs: LumeDbDoc[]): Promise<unknown>;
}

interface LumeSettingsApi {
  /** 清单 `[[settings]]` 声明键的生效值（默认 ⊕ 用户存储）。 */
  get(key: string): Promise<unknown>;
  all(): Promise<Record<string, unknown>>;
}

interface LumeFsApi {
  /** 任意路径读（权限 `fs.read`）。 */
  readText(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  /** 私有目录（`<plugin>/files/`，无需权限）。 */
  writeText(name: string, text: string): Promise<string>;
  readPrivate(name: string): Promise<string>;
  listPrivate(): Promise<string[]>;
  privatePath(name: string): Promise<string>;
  removePrivate(name: string): Promise<void>;
  thumb(path: string): Promise<string>;
}

/** 页面（view/titlebar/逻辑）可挂的事件钩子。 */
interface LumeEvents {
  query?(q: string): void;
  show?(): void;
  hide?(): void;
  key?(e: KeyboardEvent): void;
  theme?(mode: "dark" | "light"): void;
  /** 独立窗口状态恢复：桥自动回放表单/滚动后调用（custom 层，见 §6C）。 */
  restore?(state: unknown): void;
  /** 快照的 custom 层来源（返回可 JSON 化对象）。 */
  snapshot?(): unknown;
}

/** 传给 `create(ctx)` 的宿主能力面（注入的 `window.lume`）。 */
interface LumePluginCtx {
  app: LumeAppApi;
  http: LumeHttpApi;
  clipboard: LumeClipboardApi;
  db: LumeDbApi;
  settings: LumeSettingsApi;
  fs: LumeFsApi;
  on: LumeEvents;
}

/** Provider 插件的逻辑对象（`create(ctx)` 的返回值）。 */
interface LumeProviderLogic {
  /** 必填：查询 → 结果行。 */
  search(q: string): LumeProviderResult[] | Promise<LumeProviderResult[]>;
  /** 结果行激活（Enter/点击）。 */
  onEnter?(item: LumeProviderResult): void | Promise<void>;
  /** `[[features]]` 命中。 */
  onFeature?(info: LumeFeatureInfo): void | Promise<void>;
  /** 二级下钻：返回新一批行。 */
  select?(item: LumeProviderResult): LumeProviderResult[] | Promise<LumeProviderResult[]>;
  /** 下钻层内过滤。 */
  filter?(item: LumeProviderResult, q: string): LumeProviderResult[] | Promise<LumeProviderResult[]>;
  onSettings?(values: Record<string, unknown>): void;
  onShow?(): void;
  onHide?(): void;
  /** 输入变化（宿主侧已做 120ms 节流）。 */
  onQuery?(q: string): void;
  onSubInput?(text: string): void;
}
