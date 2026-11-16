//! Lume EXE installer packaging.
//!
//! Builds the normal release layout, embeds it in the pinned MicaSetup 2.5.7
//! template, and writes `src-tauri/target/release/bundle/installer/`. The
//! portable zip remains a separate artifact (`package:zip`).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_DIR = path.join(ROOT, "src-tauri");
const RELEASE_DIR = path.join(TAURI_DIR, "target", "release");
const CACHE_DIR = path.join(TAURI_DIR, "target", "installer-cache");
const OUT_DIR = path.join(RELEASE_DIR, "bundle", "installer");
const MICA_VERSION = "2.5.7";
const MICA_SHA512 =
  "a88d717679931ce2a98cee3cb23a39b25fc812975a2b09ad610e41e05ebe0034f7834f1e78348bdd002529d47edbe4122312dc31ca96826e28a5b407b7e77cca";
const MICA_URL =
  process.env.LUME_INSTALLER_MICA_NUGET_URL ??
  `https://repo.huaweicloud.com/artifactory/api/nuget/v3/nuget-remote/micasetup.tools/${MICA_VERSION}/micasetup.tools.${MICA_VERSION}.nupkg`;
const INSTALLER_GUID = "2e137f1a-9c88-43fd-a2d8-8f72bfcecbb8";

const conf = JSON.parse(readFileSync(path.join(TAURI_DIR, "tauri.conf.json"), "utf8"));
const productName = conf.productName;
const version = conf.version;

const flags = new Set(process.argv.slice(2));
if (flags.has("--help") || flags.has("-h")) {
  console.log(`Usage: pnpm run package:installer [--no-build] [--keep-work]

  --no-build   reuse the current src-tauri/target/release binaries
  --keep-work  keep the generated MicaSetup work dir for inspection

Environment:
  LUME_INSTALLER_DOTNET_ROOT       dotnet root containing an SDK (when not on PATH)
  LUME_INSTALLER_MICA_NUGET_URL    alternate mirror for the pinned NuGet package`);
  process.exit(0);
}
for (const flag of flags) {
  if (!["--no-build", "--keep-work"].includes(flag)) {
    throw new Error(`unknown flag: ${flag}`);
  }
}

const noBuild = flags.has("--no-build");
const keepWork = flags.has("--keep-work");

function buildRelease() {
  if (noBuild) {
    console.log("[installer] reusing existing release binaries");
    return;
  }
  console.log(`[installer] tauri build (${productName} v${version})...`);
  const result = spawnSync("pnpm tauri build", {
    shell: true,
    stdio: "inherit",
    cwd: ROOT,
  });
  if (result.status !== 0) {
    throw new Error(`tauri build failed with exit code ${result.status ?? 1}`);
  }
}

function assertFile(filePath) {
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    throw new Error(`missing required file: ${filePath}`);
  }
}

function assertDir(dirPath) {
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) {
    throw new Error(`missing required directory: ${dirPath}`);
  }
}

function countFiles(dirPath) {
  let count = 0;
  for (const entry of readdirSync(dirPath)) {
    const child = path.join(dirPath, entry);
    count += statSync(child).isDirectory() ? countFiles(child) : 1;
  }
  return count;
}

function toJsonPath(filePath) {
  return path.resolve(filePath).replaceAll("\\", "/");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} exited with code ${result.status ?? "unknown"}`);
  }
  return result;
}

function sha512File(filePath) {
  return createHash("sha512").update(readFileSync(filePath)).digest("hex");
}

async function downloadFile(url, destination) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      console.log(`[installer] downloading MicaSetup tools (attempt ${attempt}/3): ${url}`);
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(180000),
        headers: { "user-agent": "Lume installer packaging" },
      });
      if (!response.ok || !response.body) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
      return;
    } catch (error) {
      lastError = error;
      rmSync(destination, { force: true });
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
  }
  throw new Error(`could not download MicaSetup tools: ${lastError?.message ?? lastError}`);
}

function extractNupkg(nupkgPath, destination) {
  mkdirSync(path.dirname(destination), { recursive: true });
  rmSync(destination, { recursive: true, force: true });
  const escapedSource = nupkgPath.replaceAll("'", "''");
  const escapedDestination = destination.replaceAll("'", "''");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `[System.IO.Compression.ZipFile]::ExtractToDirectory('${escapedSource}', '${escapedDestination}')`,
  ].join("; ");
  run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps]);
}

async function ensureMicaTools() {
  mkdirSync(CACHE_DIR, { recursive: true });
  const nupkgPath = path.join(CACHE_DIR, `MicaSetup.Tools.${MICA_VERSION}.nupkg`);
  const toolsDir = path.join(CACHE_DIR, `micasetup-tools-${MICA_VERSION}`);
  const makemica = path.join(toolsDir, "build", "makemica.exe");
  const sevenZip = path.join(toolsDir, "build", "bin", "7z.exe");
  const template = path.join(toolsDir, "build", "template", "default.7z");

  if (!existsSync(nupkgPath) || sha512File(nupkgPath) !== MICA_SHA512) {
    await downloadFile(MICA_URL, nupkgPath);
    const actual = sha512File(nupkgPath);
    if (actual !== MICA_SHA512) {
      throw new Error(`MicaSetup package SHA-512 mismatch: expected ${MICA_SHA512}, got ${actual}`);
    }
    rmSync(toolsDir, { recursive: true, force: true });
    extractNupkg(nupkgPath, toolsDir);
  } else if (!existsSync(makemica) || !existsSync(sevenZip) || !existsSync(template)) {
    extractNupkg(nupkgPath, toolsDir);
  }

  assertFile(makemica);
  assertFile(sevenZip);
  assertFile(template);
  return { makemica, sevenZip, template, templateDir: path.dirname(template) };
}

function sdkVersions(root) {
  const sdkParent = path.basename(root).toLowerCase() === "sdk" ? root : path.join(root, "sdk");
  if (!existsSync(sdkParent)) return [];
  return readdirSync(sdkParent)
    .filter((entry) => statSync(path.join(sdkParent, entry)).isDirectory())
    .filter((entry) => existsSync(path.join(sdkParent, entry, "Sdks", "Microsoft.NET.Sdk", "Sdk")))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
}

function resolveDotnetSdk() {
  const roots = [];
  const addRoot = (root) => {
    if (!root) return;
    const resolved = path.resolve(root);
    if (!roots.some((candidate) => candidate.toLowerCase() === resolved.toLowerCase())) roots.push(resolved);
  };

  addRoot(process.env.LUME_INSTALLER_DOTNET_ROOT);
  addRoot(process.env.DOTNET_ROOT);

  const listed = spawnSync("dotnet", ["--list-sdks"], { encoding: "utf8", windowsHide: true });
  if (listed.status === 0) {
    for (const line of listed.stdout.split(/\r?\n/)) {
      const match = line.match(/^\S+\s+\[(.+)\]$/);
      if (match) addRoot(path.dirname(match[1]));
    }
  }

  for (const root of roots) {
    const versions = sdkVersions(root);
    if (versions.length === 0) continue;
    const sdkParent = path.basename(root).toLowerCase() === "sdk" ? root : path.join(root, "sdk");
    return {
      root: path.basename(root).toLowerCase() === "sdk" ? path.dirname(root) : root,
      sdkDir: path.join(sdkParent, versions[0]),
      version: versions[0],
    };
  }

  throw new Error(
    "No .NET SDK found. Install a .NET SDK (10.0.404 is used by this repository) " +
      "or set LUME_INSTALLER_DOTNET_ROOT to the dotnet root containing sdk/.",
  );
}

function resolveMsBuild() {
  const vswhere =
    process.env.VSWHERE_PATH ??
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\Program Files (x86)",
      "Microsoft Visual Studio",
      "Installer",
      "vswhere.exe",
    );
  assertFile(vswhere);
  const result = spawnSync(
    vswhere,
    [
      "-latest",
      "-products",
      "*",
      "-requires",
      "Microsoft.Component.MSBuild",
      "-version",
      "[17.0,)",
      "-property",
      "installationPath",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const install = (result.stdout ?? "").trim().split(/\r?\n/).pop();
  if (result.status !== 0 || !install) {
    throw new Error("Visual Studio 2022/2026 with MSBuild was not found via vswhere.");
  }
  const msbuild = path.join(install, "MSBuild", "Current", "Bin", "MSBuild.exe");
  assertFile(msbuild);
  return msbuild;
}

function patchOnce(filePath, search, replacement) {
  const source = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
  if (!source.includes(search)) {
    throw new Error(`MicaSetup template changed; could not patch ${path.basename(filePath)}: ${search}`);
  }
  writeFileSync(filePath, source.replace(search, replacement));
}

function patchTemplate(templateDir) {
  const installProgram = path.join(templateDir, "Program.cs");
  const uninstProgram = path.join(templateDir, "Program.un.cs");
  for (const filePath of [installProgram, uninstProgram]) {
    patchOnce(
      filePath,
      'option.SupportLanguages = ["en", "zh-Hans", "zh-Hant", "ja"];',
      'option.SupportLanguages = ["en", "zh-Hans", "zh-Hant"];',
    );
  }

  patchOnce(installProgram, '[assembly: AssemblyTitle("MicaApp Setup")]', '[assembly: AssemblyTitle("Lume Setup")]');
  patchOnce(installProgram, '[assembly: AssemblyProduct("MicaApp")]', '[assembly: AssemblyProduct("Lume")]');
  patchOnce(installProgram, '[assembly: AssemblyDescription("MicaApp Setup")]', '[assembly: AssemblyDescription("Lume Setup")]');
  patchOnce(installProgram, '[assembly: AssemblyCompany("Lemutec")]', '[assembly: AssemblyCompany("Lume")]');
  patchOnce(
    installProgram,
    '[assembly: AssemblyCopyright("Under MIT License. Copyright (c) Lemutec Contributors.")]',
    '[assembly: AssemblyCopyright("Copyright Lume contributors. Licensed under Apache-2.0.")]',
  );

  patchOnce(uninstProgram, '[assembly: AssemblyTitle("MicaApp Uninst")]', '[assembly: AssemblyTitle("Lume Uninstall")]');
  patchOnce(uninstProgram, '[assembly: AssemblyProduct("MicaApp")]', '[assembly: AssemblyProduct("Lume")]');
  patchOnce(uninstProgram, '[assembly: AssemblyDescription("MicaApp Uninst")]', '[assembly: AssemblyDescription("Lume Uninstall")]');
  patchOnce(uninstProgram, '[assembly: AssemblyCompany("Lemutec")]', '[assembly: AssemblyCompany("Lume")]');
  patchOnce(
    uninstProgram,
    '[assembly: AssemblyCopyright("Under MIT License. Copyright (c) Lemutec Contributors.")]',
    '[assembly: AssemblyCopyright("Copyright Lume contributors. Licensed under Apache-2.0.")]',
  );

  patchOnce(
    path.join(templateDir, "Languages.props"),
    "<SupportedLanguages Condition=\"'$(SupportedLanguages)' == ''\">en;zh-Hans;zh-Hant;ja</SupportedLanguages>",
    "<SupportedLanguages Condition=\"'$(SupportedLanguages)' == ''\">en;zh-Hans;zh-Hant</SupportedLanguages>",
  );

  const installHelper = path.join(templateDir, "Helper", "Setup", "InstallHelper.cs");
  patchOnce(
    installHelper,
    "        if (Option.Current.CloseApplications.Length > 0)\n        {\n            CloseApplicationHelper.CloseApplications();\n        }\n",
    "        if (Option.Current.CloseApplications.Length > 0)\n        {\n            CloseApplicationHelper.CloseApplications();\n        }\n\n        LumeCompanion.PrepareForInstall();\n",
  );
  patchOnce(
    installHelper,
    "        try\n        {\n            StartMenuHelper.AddToRecent(Path.Combine(Option.Current.InstallLocation, Option.Current.ExeName));\n        }\n        catch (Exception e)\n        {\n            Logger.Error(e);\n        }\n    }\n\n    public static void CreateUninst",
    "        try\n        {\n            StartMenuHelper.AddToRecent(Path.Combine(Option.Current.InstallLocation, Option.Current.ExeName));\n        }\n        catch (Exception e)\n        {\n            Logger.Error(e);\n        }\n\n        LumeCompanion.RestoreAfterInstall();\n    }\n\n    public static void CreateUninst",
  );

  patchOnce(
    uninstProgram,
    "                option.IsEnableUninstallDelayUntilReboot = true;\n",
    "                option.IsEnableUninstallDelayUntilReboot = true;\n                option.KeepMyData = !MicaSetup.Helper.LumeCompanion.PurgeRequested();\n",
  );

  patchOnce(
    path.join(templateDir, "ViewModels", "Uninst", "MainViewModel.cs"),
    "    private void StartUninstall()\n    {\n        try\n",
    "    private void StartUninstall()\n" +
      "    {\n" +
      "        if (!KeepMyData && RuntimeHelper.IsElevated)\n" +
      "        {\n" +
      "            if (Design.Controls.MessageBox.Question(ApplicationDispatcherHelper.MainWindow, \"LumePurgeConfirmTips\".Tr()) != WindowDialogResult.Yes)\n" +
      "            {\n" +
      "                return;\n" +
      "            }\n" +
      "        }\n" +
      "        try\n",
  );

  patchOnce(
    path.join(templateDir, "ViewModels", "Uninst", "MainViewModel.cs"),
    "                Option.Current.InstallLocation = uinfo.InstallLocation;\n                if (!FileWritableHelper.CheckWritable(Path.Combine(Option.Current.InstallLocation, Option.Current.ExeName)))\n",
    "                Option.Current.InstallLocation = uinfo.InstallLocation;\n" +
      "                if (LumeCompanion.HasOwnedRunningProcesses() && Design.Controls.MessageBox.Question(ApplicationDispatcherHelper.MainWindow, \"LumeCloseRunningTips\".Tr()) != WindowDialogResult.Yes)\n" +
      "                {\n" +
      "                    return;\n" +
      "                }\n" +
      "                Exception? processError = LumeCompanion.StopOwnedLauncherProcesses();\n" +
      "                if (processError != null)\n" +
      "                {\n" +
      "                    _ = Design.Controls.MessageBox.Info(ApplicationDispatcherHelper.MainWindow, \"LockedTipsAndExitTry\".Tr(Option.Current.ExeName));\n" +
      "                    return;\n" +
      "                }\n" +
      "                bool installExecutableWritable = FileWritableHelper.CheckWritable(Path.Combine(Option.Current.InstallLocation, Option.Current.ExeName));\n" +
      "                for (int attempt = 0; !installExecutableWritable && attempt < 10; attempt++)\n" +
      "                {\n" +
      "                    System.Threading.Thread.Sleep(200);\n" +
      "                    installExecutableWritable = FileWritableHelper.CheckWritable(Path.Combine(Option.Current.InstallLocation, Option.Current.ExeName));\n" +
      "                }\n" +
      "                if (!installExecutableWritable)\n",
  );

  patchOnce(
    path.join(templateDir, "ViewModels", "Inst", "MainViewModel.cs"),
    "        try\n        {\n            if (!FileWritableHelper.CheckWritable(Path.Combine(InstallPath, Option.Current.ExeName)))\n",
    "        try\n" +
      "        {\n" +
      "            if (LumeCompanion.HasOwnedRunningProcesses() && MessageBox.Question(ApplicationDispatcherHelper.MainWindow, \"LumeCloseRunningTips\".Tr()) != WindowDialogResult.Yes)\n" +
      "            {\n" +
      "                return;\n" +
      "            }\n" +
      "            Exception? processError = LumeCompanion.StopOwnedLauncherProcesses();\n" +
      "            if (processError != null)\n" +
      "            {\n" +
      "                _ = MessageBox.Info(ApplicationDispatcherHelper.MainWindow, \"LockedTipsAndExitTry\".Tr(Option.Current.ExeName));\n" +
      "                return;\n" +
      "            }\n" +
      "            bool installExecutableWritable = FileWritableHelper.CheckWritable(Path.Combine(InstallPath, Option.Current.ExeName));\n" +
      "            for (int attempt = 0; !installExecutableWritable && attempt < 10; attempt++)\n" +
      "            {\n" +
      "                System.Threading.Thread.Sleep(200);\n" +
      "                installExecutableWritable = FileWritableHelper.CheckWritable(Path.Combine(InstallPath, Option.Current.ExeName));\n" +
      "            }\n" +
      "            if (!installExecutableWritable)\n",
  );

  const uninstallHelper = path.join(templateDir, "Helper", "Setup", "UninstallHelper.cs");
  patchOnce(
    uninstallHelper,
    "        Option.Current.InstallLocation = uinfo.InstallLocation;\n",
    "        Option.Current.InstallLocation = uinfo.InstallLocation;\n" +
      "        Exception? companionError = LumeCompanion.RemoveOwnedInstall();\n" +
      "        if (!Option.Current.KeepMyData)\n" +
      "        {\n" +
      "            LumeCompanion.PurgeAllData(companionError);\n" +
      "        }\n" +
      "        else if (companionError != null)\n" +
      "        {\n" +
      "            Logger.Error(companionError);\n" +
      "        }\n",
  );

  patchUninstallLanguageStrings(templateDir);

  copyFileSync(
    path.join(ROOT, "scripts", "installer", "LumeCompanion.cs"),
    path.join(templateDir, "Helper", "Setup", "LumeCompanion.cs"),
  );
  copyFileSync(path.join(ROOT, "scripts", "installer", "NuGet.Config"), path.join(templateDir, "NuGet.Config"));
}

function patchUninstallLanguageStrings(templateDir) {
  const languages = path.join(templateDir, "Resources", "Languages");
  const files = {
    en: {
      keep: "Keep my settings and personal data",
      warning: "If '{0}' is not checked, Lume will permanently delete this Windows user's settings, clipboard history, plugins, WebView data, startup entry, service data, and saved plugin credentials. Portable copies under the same Windows user share some of these items.",
      reboot: "Some Lume data is still in use and was scheduled for deletion at the next restart. Restart Windows to finish the cleanup.",
      failed: "Lume could not remove all personal data. Close every Lume and WebView2 process, restart Windows, and remove any remaining items if they are still present.",
      confirm: "Permanently delete all Lume settings, clipboard history, plugins, WebView data, startup entries, service data, and saved plugin credentials for this Windows user?",
      closeRunning: "Lume is running. Continuing will close the running Lume launcher, elevation agent, and LumeSVC service. Continue?",
    },
    "zh-Hans": {
      keep: "保留设置和个人数据",
      warning: "不勾选“{0}”将永久删除当前 Windows 用户的 Lume 设置、剪贴板历史、插件、WebView 数据、开机启动项、服务数据和已保存的插件凭据。同一 Windows 账户下的便携版也会共用其中部分数据。",
      reboot: "部分 Lume 数据仍被占用，已安排在下一次重启时删除。请重启 Windows 完成清理。",
      failed: "Lume 未能删除全部个人数据。请关闭所有 Lume 与 WebView2 进程，重启 Windows；如仍有残留，请手动删除。",
      confirm: "要永久删除当前 Windows 用户的全部 Lume 设置、剪贴板历史、插件、WebView 数据、开机启动项、服务数据和已保存的插件凭据吗？",
      closeRunning: "检测到 Lume 正在运行。继续后将关闭正在运行的 Lume 启动器、提权代理和 LumeSVC 服务。是否继续？",
    },
    "zh-Hant": {
      keep: "保留設定與個人資料",
      warning: "未勾選「{0}」將永久刪除目前 Windows 使用者的 Lume 設定、剪貼簿歷程、外掛、WebView 資料、開機啟動項目、服務資料與已儲存的外掛認證。同一 Windows 帳戶下的可攜版也會共用其中部分資料。",
      reboot: "部分 Lume 資料仍被占用，已安排於下次重新啟動時刪除。請重新啟動 Windows 完成清理。",
      failed: "Lume 未能刪除全部個人資料。請關閉所有 Lume 與 WebView2 程序，重新啟動 Windows；如仍有殘留，請手動刪除。",
      confirm: "要永久刪除目前 Windows 使用者的全部 Lume 設定、剪貼簿歷程、外掛、WebView 資料、開機啟動項目、服務資料與已儲存的外掛認證嗎？",
      closeRunning: "偵測到 Lume 正在執行。繼續後將關閉正在執行的 Lume 啟動器、提權代理與 LumeSVC 服務。是否繼續？",
    },
  };

  for (const [language, strings] of Object.entries(files)) {
    const file = path.join(languages, `${language}.xaml`);
    const source = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const keepPattern = /<s:String x:Key="KeepMyDataTips">[\s\S]*?<\/s:String>/;
    const warningPattern = /<s:String x:Key="NotKeepMyDataTips">[\s\S]*?<\/s:String>/;
    const finalKeyPattern = /(<s:String x:Key="InstallationInfoLostHint">[\s\S]*?<\/s:String>)\n<\/ResourceDictionary>/;
    if (!keepPattern.test(source) || !warningPattern.test(source) || !finalKeyPattern.test(source)) {
      throw new Error(`MicaSetup language template changed; could not patch ${language}.xaml`);
    }
    const updated = source
      .replace(keepPattern, `<s:String x:Key="KeepMyDataTips">${strings.keep}</s:String>`)
      .replace(warningPattern, `<s:String x:Key="NotKeepMyDataTips">${strings.warning}</s:String>`)
      .replace(
        finalKeyPattern,
        `$1\n    <s:String x:Key="LumePurgeRebootTips">${strings.reboot}</s:String>\n` +
          `    <s:String x:Key="LumePurgeFailedTips">${strings.failed}</s:String>\n` +
          `    <s:String x:Key="LumePurgeConfirmTips">${strings.confirm}</s:String>\n` +
          `    <s:String x:Key="LumeCloseRunningTips">${strings.closeRunning}</s:String>\n</ResourceDictionary>`,
      );
    writeFileSync(file, updated);
  }
}

function stagePayload(stage) {
  assertDir(path.join(RELEASE_DIR, "languages"));
  assertDir(path.join(ROOT, "res", "icons"));
  mkdirSync(stage, { recursive: true });

  for (const exe of ["lume.exe", "lume-agent.exe", "lume-svc.exe"]) {
    const source = path.join(RELEASE_DIR, exe);
    assertFile(source);
    copyFileSync(source, path.join(stage, exe));
  }
  cpSync(path.join(ROOT, "languages"), path.join(stage, "languages"), { recursive: true });
  mkdirSync(path.join(stage, "res"), { recursive: true });
  cpSync(path.join(ROOT, "res", "icons"), path.join(stage, "res", "icons"), { recursive: true });
  copyFileSync(path.join(ROOT, "LICENSE"), path.join(stage, "LICENSE"));
  copyFileSync(path.join(ROOT, "THIRD_PARTY_NOTICES.md"), path.join(stage, "THIRD_PARTY_NOTICES.md"));

  console.log(`[installer] staged ${countFiles(stage)} payload files`);
}

function makeTemplate(tools, workDir) {
  const templateDir = path.join(workDir, "template");
  mkdirSync(templateDir, { recursive: true });
  run(tools.sevenZip, ["x", tools.template, `-o${templateDir}`, "-y"], { cwd: tools.templateDir });
  patchTemplate(templateDir);

  const derived = path.join(workDir, "lume-template.7z");
  run(tools.sevenZip, ["a", derived, "*", "-t7z", "-mx=5", "-mf=BCJ2", "-r", "-y"], { cwd: templateDir });
  assertFile(derived);
  return derived;
}

function makePayload(tools, stage, workDir) {
  const payload = path.join(workDir, "publish.7z");
  run(tools.sevenZip, ["a", payload, "*", "-t7z", "-mx=5", "-mf=BCJ2", "-r", "-y"], { cwd: stage });
  assertFile(payload);
  return payload;
}

function writeConfig(workDir, template, payload, output) {
  const config = {
    MinimalVersion: MICA_VERSION,
    Template: toJsonPath(template),
    Package: toJsonPath(payload),
    Output: toJsonPath(output),
    AppName: productName,
    KeyName: productName,
    ExeName: "lume.exe",
    Publisher: "Lume",
    Version: version,
    TargetFramework: "net472",
    Guid: INSTALLER_GUID,
    Favicon: toJsonPath(path.join(TAURI_DIR, "icons", "icon-transparent.png")),
    Icon: toJsonPath(path.join(TAURI_DIR, "icons", "icon.ico")),
    UnIcon: toJsonPath(path.join(TAURI_DIR, "icons", "icon.ico")),
    // MicaSetup 2.5.7 removes the per-culture license resources when a custom
    // license is configured, then still asks the WPF build for them. Keep the
    // installer's license page disabled; LICENSE is shipped in the payload.
    RequestExecutionLevel: "admin",
    IsCreateDesktopShortcut: true,
    IsCreateUninst: true,
    IsUninstLower: false,
    IsCreateStartMenu: true,
    IsPinToStartMenu: false,
    IsCreateQuickLaunch: false,
    IsCreateRegistryKeys: true,
    IsCreateAsAutoRun: false,
    IsCustomizeVisiableAutoRun: false,
    IsAllowFullFolderSecurity: false,
    IsAllowFirewall: false,
    IsForceOpenAsNormalUser: true,
    IsRefreshExplorer: true,
    IsEnableUninstallDelayUntilReboot: true,
    IsEnvironmentVariable: false,
    OverlayInstallRemoveExt: "exe,dll,pdb,7z,zip,json",
    // LumeCompanion terminates only the executables owned by this install
    // directory. MicaSetup's name-only CloseApplications can kill a portable
    // copy elsewhere that happens to use the same binary names.
    CloseApplications: [],
  };
  const configPath = path.join(workDir, "micasetup.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function safeRemoveWorkDir(workDir) {
  const resolved = path.resolve(workDir);
  const allowedRoot = path.resolve(TAURI_DIR, "target", "installer-work");
  if (!resolved.startsWith(`${allowedRoot}${path.sep}`)) {
    throw new Error(`refusing to remove work dir outside installer-work: ${resolved}`);
  }
  rmSync(resolved, { recursive: true, force: true });
}

buildRelease();

const dotnet = resolveDotnetSdk();
const msbuild = resolveMsBuild();
const tools = await ensureMicaTools();

const workRoot = path.join(TAURI_DIR, "target", "installer-work");
const workDir = path.join(workRoot, `${Date.now()}-${process.pid}`);
mkdirSync(workDir, { recursive: true });
const stage = path.join(workDir, "payload");
const output = path.join(OUT_DIR, `${productName}_${version}_x64_setup.exe`);
mkdirSync(OUT_DIR, { recursive: true });

let failed = true;
try {
  console.log(`[installer] dotnet SDK ${dotnet.version}: ${dotnet.root}`);
  console.log(`[installer] MSBuild: ${msbuild}`);
  stagePayload(stage);
  const template = makeTemplate(tools, workDir);
  const payload = makePayload(tools, stage, workDir);
  const configPath = writeConfig(workDir, template, payload, output);

  const sdksPath = path.join(dotnet.sdkDir, "Sdks");
  const env = {
    ...process.env,
    DOTNET_ROOT: dotnet.root,
    DOTNET_HOST_PATH: path.join(dotnet.root, "dotnet.exe"),
    PATH: `${dotnet.root}${path.delimiter}${process.env.PATH ?? ""}`,
    MSBuildSDKsPath: sdksPath,
    DOTNET_MSBUILD_SDK_RESOLVER_SDKS_DIR: sdksPath,
    MSBuildEnableWorkloadResolver: "false",
    NUGET_PACKAGES: path.join(CACHE_DIR, "nuget-packages"),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_NOLOGO: "1",
  };

  run(tools.makemica, [configPath], { cwd: workDir, env });
  assertFile(output);
  const size = statSync(output).size;
  const hash = sha512File(output);
  console.log(`[installer] complete: ${output}`);
  console.log(`[installer] size: ${(size / 1024 / 1024).toFixed(2)} MiB`);
  console.log(`[installer] SHA-512: ${hash}`);
  failed = false;
} finally {
  if (failed || keepWork) {
    console.log(`[installer] work dir: ${workDir}`);
  } else {
    safeRemoveWorkDir(workDir);
  }
}
