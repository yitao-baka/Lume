import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const DEBUG_BASE = join(ROOT, "src-tauri", "target", "debug");
export const DEBUG_EXE = join(DEBUG_BASE, "lume.exe");
export const RELEASE_BASE = join(ROOT, "src-tauri", "target", "release");
export const RELEASE_EXE = join(RELEASE_BASE, "lume.exe");

const activeSessions = new Set();
let cleanupInstalled = false;

function killProcessTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // The process may already have exited.
  }
}

function installProcessCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  const stopAll = () => {
    for (const session of activeSessions) killProcessTree(session.pid);
  };
  process.once("exit", stopAll);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      stopAll();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

export async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolveClose) => server.close(resolveClose));
  if (!port) throw new Error("failed to allocate a CDP port");
  return port;
}

export async function waitFor(check, { timeoutMs = 8000, intervalMs = 100, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError ? ` (last error: ${lastError.message ?? lastError})` : "";
  throw new Error(`timed out waiting for ${label}${suffix}`);
}

export async function getTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`CDP target list returned ${response.status}`);
  return response.json();
}

export class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? "CDP command failed"));
      else entry.resolve(message);
    };
    ws.onclose = () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    };
  }

  static async connect(url, timeoutMs = 5000) {
    const ws = new WebSocket(url);
    await new Promise((resolveOpen, reject) => {
      const timer = setTimeout(() => reject(new Error("CDP websocket open timed out")), timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        resolveOpen();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP websocket failed to open"));
      };
    });
    return new CdpConnection(ws);
  }

  send(method, params = {}, timeoutMs = 10000) {
    return new Promise((resolveSend, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveSend, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { timeoutMs = 10000 } = {}) {
    const response = await this.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      timeoutMs,
    );
    const exception = response.result?.exceptionDetails;
    if (exception) {
      throw new Error(exception.exception?.description ?? exception.text ?? "Runtime.evaluate failed");
    }
    return response.result?.result?.value;
  }

  invoke(command, args = {}, options) {
    return this.evaluate(
      `window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
      options,
    );
  }

  async waitFor(expression, timeoutMs = 8000) {
    return waitFor(() => this.evaluate(expression), {
      timeoutMs,
      label: expression,
    });
  }

  async screenshot(filePath, clip) {
    mkdirSync(dirname(filePath), { recursive: true });
    const params = { format: "png" };
    if (clip) params.clip = { scale: 1, ...clip };
    const response = await this.send("Page.captureScreenshot", params);
    const data = response.result?.data;
    if (!data) throw new Error("Page.captureScreenshot returned no data");
    writeFileSync(filePath, Buffer.from(data, "base64"));
    return filePath;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // Ignore close races.
    }
  }
}

export async function stageRuntime({
  runDir,
  exe = DEBUG_EXE,
  fixtures = [],
  extraFiles = [],
  prepareRuntime,
}) {
  if (!existsSync(exe)) throw new Error(`Lume executable not found: ${exe}`);
  const runtimeDir = join(runDir, "runtime");
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });

  const exeName = process.platform === "win32" ? "lume.exe" : "lume";
  const stagedExe = join(runtimeDir, exeName);
  cpSync(exe, stagedExe);

  const sourceBase = dirname(exe);
  for (const folder of ["languages", "res"]) {
    const source = join(sourceBase, folder);
    if (existsSync(source)) cpSync(source, join(runtimeDir, folder), { recursive: true });
  }
  for (const file of extraFiles) {
    const source = join(sourceBase, file);
    if (!existsSync(source)) throw new Error(`required test helper not found: ${source}`);
    cpSync(source, join(runtimeDir, file));
  }
  mkdirSync(join(runtimeDir, "plugins"), { recursive: true });

  for (const fixture of fixtures) {
    const source = resolve(ROOT, fixture.source);
    const target = join(runtimeDir, fixture.target ?? join("plugins", fixture.source.split(/[\\/]/).at(-1)));
    if (!existsSync(source)) throw new Error(`test fixture not found: ${source}`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true });
  }
  if (prepareRuntime) await prepareRuntime(runtimeDir);
  return { runtimeDir, exe: stagedExe };
}

export class LumeSession {
  static async launch({
    runtimeDir,
    exe,
    runDir,
    instanceId,
    readyTimeoutMs = 20000,
  }) {
    installProcessCleanup();
    const port = await freePort();
    const logPath = join(runDir, "lume.log");
    const webviewDataDir = join(runDir, "webview2");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(webviewDataDir, { recursive: true });
    const logFd = openSync(logPath, "w");
    const browserArgs = [
      process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS,
      `--remote-debugging-port=${port}`,
    ].filter(Boolean).join(" ");
    const child = spawn(exe, [], {
      cwd: runtimeDir,
      env: {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: browserArgs,
        // A running installed Lume can already own the default WebView2 user
        // data folder. A private profile keeps this process's browser (and the
        // requested debugging port) isolated from the user's app.
        WEBVIEW2_USER_DATA_FOLDER: webviewDataDir,
        LUME_INSTANCE_ID: instanceId,
      },
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.once("error", (error) => {
      console.error(`[cdp] failed to launch ${exe}: ${error.message}`);
    });

    const session = new LumeSession({
      child,
      port,
      runtimeDir,
      logPath,
      instanceId,
    });
    activeSessions.add(session);
    await waitFor(() => getTargets(port), {
      timeoutMs: readyTimeoutMs,
      intervalMs: 150,
      label: `Lume CDP on :${port}`,
    });
    return session;
  }

  constructor({ child, port, runtimeDir, logPath, instanceId }) {
    this.child = child;
    this.pid = child.pid;
    this.port = port;
    this.runtimeDir = runtimeDir;
    this.logPath = logPath;
    this.instanceId = instanceId;
    this.connections = new Set();
    this.closed = false;
  }

  async targets() {
    return getTargets(this.port);
  }

  async connect(url) {
    const connection = await CdpConnection.connect(url);
    this.connections.add(connection);
    return connection;
  }

  async findPage(expression, { timeoutMs = 12000, intervalMs = 150 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
      try {
        const pages = (await this.targets()).filter((target) => target.type === "page");
        for (const target of pages) {
          let connection;
          try {
            connection = await this.connect(target.webSocketDebuggerUrl);
            if (await connection.evaluate(expression)) {
              return { target, connection };
            }
            connection.close();
            this.connections.delete(connection);
          } catch (error) {
            lastError = error;
            connection?.close();
            this.connections.delete(connection);
          }
        }
      } catch (error) {
        lastError = error;
      }
      await delay(intervalMs);
    }
    const suffix = lastError ? ` (last error: ${lastError.message ?? lastError})` : "";
    throw new Error(`timed out waiting for page ${expression}${suffix}`);
  }

  main() {
    return this.findPage('!!document.getElementById("search-input")', { timeoutMs: 20000 });
  }

  settings() {
    return this.findPage('document.body.classList.contains("settings-window")');
  }

  preview() {
    return this.findPage('location.pathname.endsWith("/preview.html") || !!document.querySelector(".preview-page")');
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    for (const connection of this.connections) connection.close();
    this.connections.clear();
    activeSessions.delete(this);
    killProcessTree(this.pid);
    await waitFor(() => this.child.exitCode !== null || this.child.signalCode !== null, {
      timeoutMs: 4000,
      intervalMs: 100,
      label: `Lume pid ${this.pid} to exit`,
    }).catch(() => {});
  }
}

export function readLogTail(session, lines = 80) {
  if (!existsSync(session.logPath)) return "";
  return readFileSync(session.logPath, "utf8").split(/\r?\n/).slice(-lines).join("\n");
}
