//! 磁盘插件 entry 的 ESM 加载器（P6.5 从 registry.ts 抽出）。
//!
//! 同一套「取文本 → 相对导入改写为 blob URL → `import()`」机制，文件获取
//! 方式由调用方注入：
//! - 启动器主窗口（历史路径 / 未来复用）：`fetchDiskFile`（asset 协议）；
//! - 逻辑宿主 iframe（P6.5）：经桥 RPC `__readPluginFile` 由 supervisor
//!   代理读取——opaque origin 里 `fetch(asset://)` 被 CORS 拒绝。
//!
//! blob URL 在创建它的 realm 内自洽：iframe 里创建、iframe 里 import，
//! 不需要 same-origin。模块缓存随 loader 实例走（逻辑帧每次重载都是
//! 新帧 → 天然全新缓存）。

/** Static `from "..."` / bare `import "..."` / dynamic `import("...")` with a
 * relative specifier. */
export const RELATIVE_IMPORT_RE =
  /(from\s*|import\s*\(\s*|import\s*)(["'])(\.{1,2}\/[^"']+)\2/g;

/** One blob-imported module: its URL (for parent rewrites) + namespace. */
export interface CompiledModule {
  url: string;
  mod: unknown;
}

/** Normalized cache key for a module path. */
function moduleKey(p: string): string {
  return p.replace(/\//g, "\\").toLowerCase();
}

/** The directory part of a Windows path (any separator mix). */
export function parentDir(p: string): string {
  const norm = p.replace(/\//g, "\\");
  const i = norm.lastIndexOf("\\");
  return i > 0 ? norm.slice(0, i) : norm;
}

/** Resolve `dir` + relative `spec` (`./x.js`, `../../y/z.js`) to a plain
 * Windows path without drive-dependent logic. */
export function resolveRelative(dir: string, spec: string): string {
  const parts = (dir + "\\" + spec.replace(/\//g, "\\")).split("\\");
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("\\");
}

/** Build a loader bound to one file-text transport. `fetchText(path)` fetches
 * ONE file (exact path); extension probing (`.js` / `index.js`) happens here
 * so every transport gets the same semantics. */
export function createDiskLoader(fetchText: (path: string) => Promise<string>) {
  /** Path → compiled module promise. Cache across loads within this loader;
   * cleared explicitly on reload so re-imported code is re-read from disk. */
  const moduleCache = new Map<string, Promise<CompiledModule>>();

  /** Fetch a module file's text. Without an extension, `.js` then
   * `<dir>/index.js` are tried (extensionless relative imports). */
  async function fetchModuleText(path: string): Promise<string> {
    const candidates = /\.[a-zA-Z0-9]+$/.test(path)
      ? [path]
      : [path + ".js", path + "\\index.js"];
    let lastErr: unknown;
    for (const c of candidates) {
      try {
        return await fetchText(c);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error(`module not found: ${path}`);
  }

  /** Compile one module (and, recursively, its relative imports). `root` is
   * the plugin dir — `//# sourceURL` names are displayed relative to it. */
  function compileDiskModule(absPath: string, root: string): Promise<CompiledModule> {
    const key = moduleKey(absPath);
    const cached = moduleCache.get(key);
    if (cached) return cached;
    const compiled = (async (): Promise<CompiledModule> => {
      const text = await fetchModuleText(absPath);
      const dir = parentDir(absPath);
      const deps = new Map<string, Promise<string>>(); // specifier → blob URL
      for (const m of text.matchAll(RELATIVE_IMPORT_RE)) {
        const spec = m[3];
        if (!deps.has(spec)) {
          deps.set(
            spec,
            compileDiskModule(resolveRelative(dir, spec), root).then((c) => c.url)
          );
        }
      }
      const urls = new Map<string, string>(
        await Promise.all(
          [...deps.entries()].map(
            async ([s, pr]) => [s, await pr] as [string, string]
          )
        )
      );
      const rewritten = text.replace(RELATIVE_IMPORT_RE, (m, pre, q, spec) => {
        const url = urls.get(spec);
        return url ? pre + q + url + q : m;
      });
      // DevTools 里按真实文件名显示（否则是匿名 blob hash）。
      const rel =
        root && absPath.toLowerCase().startsWith(root.toLowerCase())
          ? absPath.slice(root.length + 1)
          : absPath;
      const labeled =
        rewritten + `\n//# sourceURL=lume-plugin/${rel.replace(/\\/g, "/")}\n`;
      const url = URL.createObjectURL(new Blob([labeled], { type: "text/javascript" }));
      return { url, mod: await import(url) };
    })();
    moduleCache.set(key, compiled);
    return compiled;
  }

  return {
    /** Import a plugin entry (`dir` + entry path, either separator). */
    async importEntry(dir: string, entry: string): Promise<unknown> {
      return (await compileDiskModule(dir + "\\" + entry.replace(/\//g, "\\"), dir)).mod;
    },
    clearCache() {
      moduleCache.clear();
    },
  };
}

/** Accepts both the legacy plain-object form and the v2 factory form.
 * `def` may also be a module namespace — the default export is used.
 * `api` is the host API handed to the factory (`create(ctx)`). */
export function resolveLogic(def: unknown, api: unknown): Record<string, unknown> {
  const ns = def as { default?: unknown } | null;
  if (ns && typeof ns === "object" && "default" in ns && !("search" in ns)) {
    def = ns.default;
  }
  if (typeof def === "function") {
    const produced = (def as (ctx: unknown) => unknown)(api);
    return (produced && typeof produced === "object" ? produced : {}) as Record<string, unknown>;
  }
  return (def && typeof def === "object" ? def : {}) as Record<string, unknown>;
}
