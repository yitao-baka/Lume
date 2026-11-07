#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { DEBUG_EXE, RELEASE_EXE, ROOT } from "./test-harness/cdp.mjs";
import { runSuite } from "./test-harness/runner.mjs";

const MANIFEST_PATH = join(ROOT, "scripts", "test-manifest.json");
const RESULTS_ROOT = join(ROOT, "test", "verify");
const MANIFEST = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));

const BUILD_INPUTS = [
  "src",
  "languages",
  "res",
  "package.json",
  "pnpm-lock.yaml",
  "vite.config.ts",
  "index.html",
  "settings.html",
  "plugin.html",
  "pluginLogic.html",
  "pluginLogicFrame.html",
  "blank.html",
  "preview.html",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
  "src-tauri/src",
];

const FRONTEND_UNIT_SCRIPTS = [
  "scripts/page_runtime_unit_test.mjs",
  "scripts/clipboard_model_unit_test.mjs",
  "scripts/clipboard_store_unit_test.mjs",
  "scripts/skin_system_unit_test.mjs",
];

function commandName(name) {
  if (process.platform !== "win32") return name;
  if (name === "pnpm") return "pnpm.cmd";
  return name;
}

function runStep(label, command, args = [], { cwd = ROOT, allowFailure = false } = {}) {
  console.log(`\n[verify] ${label}`);
  console.log(`[verify] ${command} ${args.join(" ")}`);
  const useCommandShell = process.platform === "win32" && command === "pnpm";
  const executable = useCommandShell ? (process.env.ComSpec ?? "cmd.exe") : commandName(command);
  const executableArgs = useCommandShell
    ? ["/d", "/s", "/c", [commandName(command), ...args].join(" ")]
    : args;
  const result = spawnSync(executable, executableArgs, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  const ok = result.status === 0;
  if (!ok && !allowFailure) {
    const reason = result.error ? `: ${result.error.message}` : "";
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}${reason}`);
  }
  return ok;
}

function node(script, args = [], options) {
  return runStep(script, process.execPath, [script, ...args], options);
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      flags._.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split("=", 2);
    if (inline !== undefined) flags[name] = inline;
    else if (["no-build", "force-build", "changed", "keep-runtime", "list", "help"].includes(name)) flags[name] = true;
    else flags[name] = argv[++index];
  }
  return flags;
}

function parseList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    newest = Math.max(newest, newestMtime(child));
  }
  return newest;
}

function needsBuild(exe, flags) {
  if (flags["no-build"]) return false;
  if (flags["force-build"]) return true;
  if (!existsSync(exe)) return true;
  const exeTime = statSync(exe).mtimeMs;
  return BUILD_INPUTS.some((input) => newestMtime(join(ROOT, input)) > exeTime + 1000);
}

function ensureDebugBuild(flags) {
  if (!needsBuild(DEBUG_EXE, flags)) {
    console.log(`[verify] debug build is current: ${DEBUG_EXE}`);
    return;
  }
  runStep("build embedded debug executable", "pnpm", [
    "exec",
    "tauri",
    "build",
    "--debug",
    "--no-bundle",
  ]);
}

function ensureReleaseBuild(flags) {
  if (!needsBuild(RELEASE_EXE, flags)) {
    console.log(`[verify] release build is current: ${RELEASE_EXE}`);
    return;
  }
  runStep("build embedded release executable", "pnpm", [
    "exec",
    "tauri",
    "build",
    "--no-bundle",
  ]);
}

function runDocs() {
  node("scripts/check_docs.mjs");
}

function runStatic() {
  runDocs();
  runStep("TypeScript typecheck", "pnpm", ["exec", "tsc", "--noEmit"]);
  node("scripts/check_i18n.mjs");
  for (const script of FRONTEND_UNIT_SCRIPTS) node(script);
}

function runFast(_flags) {
  runStatic();
  runStep("frontend production build + plugin contract", "pnpm", ["run", "build"]);
  runStep("Rust unit tests", "cargo", ["test"], { cwd: join(ROOT, "src-tauri") });
}

function changedFiles() {
  const diff = execFileSync("git", ["diff", "--name-only", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return [...new Set(`${diff}\n${untracked}`.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

function suitesForChanges(files) {
  const selected = new Set();
  for (const file of files) {
    for (const rule of MANIFEST.impact ?? []) {
      if (rule.paths.some((prefix) => file === prefix || file.startsWith(prefix))) {
        for (const suite of rule.suites) selected.add(suite);
      }
    }
  }
  if (selected.size === 0) {
    for (const suite of MANIFEST.fallbackSuites ?? ["smoke"]) selected.add(suite);
  }
  return [...selected];
}

function resolveSelectedSuites(flags) {
  if (flags.list) return [];
  const explicit = parseList(flags.suite);
  if (explicit.length > 0) return explicit;
  if (flags.changed) return suitesForChanges(changedFiles());
  return Object.keys(MANIFEST.suites);
}

function pruneResults(root, keep = 20) {
  if (!existsSync(root)) return;
  const rootAbs = resolve(root);
  const runs = readdirSync(rootAbs, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(rootAbs, entry.name);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const stale of runs.slice(keep)) {
    const target = resolve(stale.path);
    if (!target.startsWith(`${rootAbs}${sep}`)) continue;
    rmSync(target, { recursive: true, force: true });
  }
}

async function runUi(flags) {
  if (flags.list) {
    const ids = flags.changed ? suitesForChanges(changedFiles()) : Object.keys(MANIFEST.suites);
    console.log(flags.changed ? "Selected suites for the current diff:" : "Harness suites:");
    for (const id of ids) {
      const entry = MANIFEST.suites[id];
      console.log(`${id.padEnd(18)} ${entry.description}`);
    }
    return true;
  }

  const selected = resolveSelectedSuites(flags);
  for (const id of selected) {
    if (!MANIFEST.suites[id]) throw new Error(`unknown UI suite: ${id}`);
  }
  if (flags.exe) console.log(`[verify] custom executable: ${resolve(ROOT, flags.exe)}`);
  else ensureDebugBuild(flags);
  const exe = flags.exe ? resolve(ROOT, flags.exe) : DEBUG_EXE;
  if (!existsSync(exe)) throw new Error(`test executable not found: ${exe}`);

  pruneResults(RESULTS_ROOT);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const results = [];
  console.log(`\n[verify] UI suites: ${selected.join(", ")}`);
  for (const id of selected) {
    const entry = MANIFEST.suites[id];
    const moduleUrl = pathToFileURL(join(ROOT, "scripts", "test-harness", entry.module)).href;
    const suite = (await import(`${moduleUrl}?run=${runId}`)).default;
    const result = await runSuite(suite, {
      runId,
      resultsRoot: RESULTS_ROOT,
      exe,
      keepRuntime: flags["keep-runtime"],
    });
    results.push(result);
  }

  const summaryDir = join(RESULTS_ROOT, runId);
  mkdirSync(summaryDir, { recursive: true });
  const summary = {
    runId,
    status: results.every((result) => result.status === "passed") ? "passed" : "failed",
    startedAt: results[0]?.startedAt,
    suites: results.map(({ suite, status, passed, failed, durationMs, artifacts }) => ({
      suite,
      status,
      passed,
      failed,
      durationMs,
      artifacts,
    })),
  };
  writeFileSync(join(summaryDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\n[verify] UI ${summary.status.toUpperCase()}: ${join(summaryDir, "summary.json")}`);
  return summary.status === "passed";
}

function legacyScripts(flags) {
  if (flags.script) {
    const script = flags.script.startsWith("scripts/") ? flags.script : join("scripts", flags.script);
    return [script];
  }
  const groups = parseList(flags.group);
  if (groups.includes("all")) {
    return readdirSync(join(ROOT, "scripts"))
      .filter((name) => /^cdp_.*\.mjs$/.test(name))
      .sort()
      .map((name) => join("scripts", name));
  }
  if (groups.length === 0) return [];
  const scripts = new Set();
  for (const group of groups) {
    const entries = MANIFEST.legacyGroups?.[group];
    if (!entries) throw new Error(`unknown legacy group: ${group}`);
    for (const script of entries) scripts.add(script);
  }
  return [...scripts];
}

function runLegacy(flags) {
  if (flags.list || (!flags.group && !flags.script)) {
    console.log("Legacy groups:");
    for (const [name, scripts] of Object.entries(MANIFEST.legacyGroups ?? {})) {
      console.log(`  ${name.padEnd(18)} ${scripts.length} script(s)`);
    }
    console.log("Use --group <name[,name]> or --group all; --script <file> runs one file.");
    return true;
  }
  const scripts = legacyScripts(flags);
  ensureDebugBuild(flags);
  let failed = 0;
  for (const script of scripts) {
    if (!existsSync(join(ROOT, script))) throw new Error(`legacy script not found: ${script}`);
    console.log(`\n[verify] legacy: ${script}`);
    const ok = node(script, [], { allowFailure: true });
    if (!ok) failed++;
  }
  console.log(`\n[verify] legacy ${failed === 0 ? "PASS" : `FAIL (${failed} script(s))`}`);
  return failed === 0;
}

async function runRelease(flags) {
  runStatic();
  runStep("Rust unit tests", "cargo", ["test"], { cwd: join(ROOT, "src-tauri") });
  runStep("Rust clippy", "cargo", ["clippy", "--all-targets", "--message-format=short"], {
    cwd: join(ROOT, "src-tauri"),
  });
  const uiOk = await runUi({ ...flags, suite: undefined, changed: false });
  const legacyOk = runLegacy({ ...flags, group: "release-core" });
  ensureReleaseBuild(flags);
  console.log("\n[verify] Manual release checklist: docs/MANUAL_TESTING.md");
  return uiOk && legacyOk;
}

function printHelp() {
  console.log(`Usage:
  pnpm verify:docs
  pnpm verify:fast
  pnpm verify:ui [--suite smoke,plugin-runtime] [--changed] [--no-build] [--force-build]
  pnpm verify:legacy [--group release-core|all] [--script cdp_name.mjs] [--no-build]
  pnpm verify:release [--no-build]

UI flags:
  --suite <ids>       Run selected harness suites.
  --changed           Select suites from the current git diff.
  --no-build          Use the current embedded debug executable as-is.
  --force-build       Rebuild the embedded debug executable before running.
  --exe <path>        Use another executable (advanced/manual).
  --keep-runtime      Keep the isolated runtime directory for passing suites.
  --list              List suites or legacy groups without running anything.`);
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const flags = parseArgs(rest);
  if (flags.help || command === "help") {
    printHelp();
    return true;
  }
  switch (command) {
    case "docs":
      runDocs();
      return true;
    case "fast":
      runFast(flags);
      return true;
    case "ui":
      return runUi(flags);
    case "legacy":
      return runLegacy(flags);
    case "release":
      return runRelease(flags);
    default:
      throw new Error(`unknown verify command: ${command}`);
  }
}

try {
  const ok = await main();
  process.exit(ok === false ? 1 : 0);
} catch (error) {
  console.error(`\n[verify] FAILED: ${error?.stack ?? error}`);
  process.exit(1);
}
