import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  LumeSession,
  ROOT,
  readLogTail,
  stageRuntime,
} from "./cdp.mjs";

function detailText(value) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function emitCheck(entry) {
  const suffix = entry.detail ? ` - ${entry.detail}` : "";
  console.log(`[${entry.pass ? "PASS" : "FAIL"}] ${entry.name}${suffix}`);
}

export function createTestContext({ suiteId, resultDir, main, session }) {
  const checks = [];
  const artifacts = [];
  const screenshotsDir = join(resultDir, "screenshots");
  mkdirSync(screenshotsDir, { recursive: true });

  const record = (name, pass, detail) => {
    const entry = { name, pass: !!pass, detail: detailText(detail) };
    checks.push(entry);
    emitCheck(entry);
    return !!pass;
  };

  const context = {
    suiteId,
    resultDir,
    runtimeDir: join(resultDir, "runtime"),
    session,
    main: main.connection,
    checks,
    artifacts,
    check: record,
    require(name, pass, detail) {
      if (!record(name, pass, detail)) throw new Error(`required check failed: ${name}`);
      return true;
    },
    equal(name, actual, expected, detail) {
      const pass = Object.is(actual, expected);
      return record(name, pass, pass ? detail : { actual, expected, detail });
    },
    deepEqual(name, actual, expected) {
      const a = JSON.stringify(actual);
      const b = JSON.stringify(expected);
      return record(name, a === b, a === b ? "" : { actual, expected });
    },
    evaluate: (expression, options) => main.connection.evaluate(expression, options),
    invoke: (command, args, options) => main.connection.invoke(command, args, options),
    waitFor: (expression, timeoutMs) => main.connection.waitFor(expression, timeoutMs),
    sleep: (ms) => delay(ms),
    log: (...args) => console.log(`[${suiteId}]`, ...args),
    async screenshot(name, connection = main.connection, clip) {
      const file = join(screenshotsDir, `${name}.png`);
      await connection.screenshot(file, clip);
      artifacts.push(file);
      return file;
    },
    async ensureLauncherVisible() {
      const visible = await main.connection.invoke("plugin:window|is_visible", { label: "main" });
      if (!visible) await main.connection.invoke("toggle_launcher");
      await main.connection.waitFor(
        `window.__TAURI_INTERNALS__.invoke("plugin:window|is_visible", { label: "main" })`,
        5000,
      );
    },
    async setQuery(value) {
      return main.connection.evaluate(`(() => {
        const input = document.getElementById("search-input");
        if (!input) return false;
        input.focus();
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
    },
    async clickText(selector, text) {
      return main.connection.evaluate(`(() => {
        const node = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find((item) => item.textContent.includes(${JSON.stringify(text)}));
        if (!node) return false;
        node.click();
        return true;
      })()`);
    },
    async openSettings() {
      await main.connection.invoke("open_settings");
      const settings = await session.settings();
      await settings.connection.waitFor('!!document.querySelector(".settings-page-content")', 8000);
      return settings.connection;
    },
    recordError(error) {
      const entry = {
        name: "suite completed without an uncaught error",
        pass: false,
        detail: error?.stack ?? String(error),
      };
      checks.push(entry);
      emitCheck(entry);
    },
  };
  return context;
}

export async function runSuite(suite, {
  runId,
  resultsRoot = join(ROOT, "test", "verify"),
  exe,
  keepRuntime = process.env.KEEP_TEST_RUN === "1",
  readyTimeoutMs,
  extraEnv = suite.env ?? {},
} = {}) {
  const resultDir = join(resultsRoot, runId, suite.id);
  mkdirSync(resultDir, { recursive: true });
  const startedAt = new Date();
  const started = performance.now();
  let session;
  let context;
  let fatalError;

  try {
    const staged = await stageRuntime({
      runDir: resultDir,
      exe,
      fixtures: suite.fixtures ?? [],
      extraFiles: suite.extraFiles ?? [],
      prepareRuntime: suite.prepareRuntime,
    });
    session = await LumeSession.launch({
      ...staged,
      runDir: resultDir,
      instanceId: `verify-${process.pid}-${suite.id}-${Date.now()}`,
      readyTimeoutMs,
      extraEnv,
    });
    const main = await session.main();
    context = createTestContext({ suiteId: suite.id, resultDir, main, session });
    await suite.run(context);
  } catch (error) {
    fatalError = error;
    console.error(`[${suite.id}] ERROR: ${error?.stack ?? error}`);
    context?.recordError(error);
  } finally {
    await session?.close();
  }

  const checks = context?.checks ?? [];
  const failed = checks.filter((check) => !check.pass).length;
  const result = {
    suite: suite.id,
    description: suite.description,
    status: failed === 0 && !fatalError ? "passed" : "failed",
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    checks,
    passed: checks.length - failed,
    failed,
    fatalError: fatalError ? (fatalError.stack ?? String(fatalError)) : undefined,
    artifacts: context?.artifacts ?? [],
    runtimeDir: join(resultDir, "runtime"),
    log: session?.logPath,
  };
  if (result.status === "failed" && session) result.logTail = readLogTail(session);
  writeFileSync(join(resultDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);

  if (!keepRuntime && result.status === "passed" && existsSync(result.runtimeDir)) {
    rmSync(result.runtimeDir, { recursive: true, force: true });
  }

  console.log(
    `[${suite.id}] ${result.status.toUpperCase()} ` +
      `(${result.passed}/${checks.length}, ${(result.durationMs / 1000).toFixed(1)}s)`,
  );
  if (result.status === "failed") {
    console.log(`[${suite.id}] artifacts: ${resultDir}`);
    if (result.logTail) console.log(`[${suite.id}] log tail:\n${result.logTail}`);
  }
  return result;
}
