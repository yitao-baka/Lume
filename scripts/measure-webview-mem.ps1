# measure-webview-mem.ps1
# Measure Lume's webview memory footprint WITHOUT touching any app code.
#
# A "snapshot" = the whole descendant process tree of lume.exe:
#   lume.exe          the Rust host (small)
#   msedgewebview2.exe  browser   — WebView2 browser process (no --type=)
#                       renderer  — the page itself (the one that matters)
#                       gpu-process / utility / ... — Chromium helpers
#
# Numbers reported per process type:
#   priv-WS = private working set  (real RAM this tree owns, not shared)
#   WS      = total working set     (incl. shared/pool pages)
#   commit  = private commit        (paged-in + paged-out, shows peak tendency)
#
# Usage (from the repo root):
#   powershell -ExecutionPolicy Bypass -File scripts\measure-webview-mem.ps1            # guided 4-stage run
#   powershell -ExecutionPolicy Bypass -File scripts\measure-webview-mem.ps1 -Label mem # one-shot snapshot
#
# Guided stages: 1 baseline (hidden) / 2 clipboard page / 3 settings window / 4 big-image preview.
# Requires Windows PowerShell 5+ (built into Windows 11).

param(
  [string]$Label = "",
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$MB = 1.0 * 1024 * 1024
# Make console output UTF-8 so Chinese prompts/snapshots survive any terminal
# (Windows Terminal is UTF-8; legacy GBK consoles would still show garbage but
# the saved .txt files are always correct UTF-8 regardless).
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$Exe = Join-Path $PSScriptRoot "..\src-tauri\target\release\lume.exe"

if ($OutDir -eq "") { $OutDir = Join-Path $env:TEMP "LumeMemMeasure" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

# ── classify a process by name + command line ─────────────────────────────
function Get-ProcTypeName {
  param([string]$Name, [string]$Cmd)
  if ($Name -like "lume*") { return "app" }          # the Rust host
  if ($Cmd -match "--type=([a-z-]+)") { return $Matches[1] }   # renderer / gpu-process / utility / ...
  return "browser"                                    # WebView2 browser process (no --type=)
}

# ── private working set map (pid → MB) via perf counters ──────────────────
# Task Manager's "内存" column is private working set. Win32_Process'
# WorkingSetPrivateSize is NULL on many systems, so read the perf counter
# `\Process(*)\Working Set - Private` and map it to PIDs via `\ID Process`.
# Key insight: for multi-instance processes the *InstanceName* is the bare
# name (all 50 svchosts are "svchost") — the unique `#N` index only lives in
# the counter *Path* (`\process(svchost#12)\...`), so we join on that.
function Get-CounterInstance {
  param([string]$Path)
  if ($Path -match 'process\(([^)]+)\)') { return $Matches[1] }
  return $null
}

function Get-PrivateWSMap {
  param([int[]]$Pids)
  $map = @{}
  try {
    # Instance→PID from \ID Process (reliable). The bare InstanceName is NOT
    # unique for multi-instance processes, so join on the `process(...)` token
    # extracted from the full counter Path.
    $idByInst = @{}
    foreach ($s in (Get-Counter "\Process(*)\ID Process" -ErrorAction SilentlyContinue).CounterSamples) {
      $inst = Get-CounterInstance $s.Path
      if ($inst) { $idByInst[$inst] = [int]$s.CookedValue }
    }
    # Reverse: PID → instance, but only for the PIDs we care about.
    $instByPid = @{}
    foreach ($inst in $idByInst.Keys) {
      $pidv = $idByInst[$inst]
      if ($Pids -contains $pidv) { $instByPid[$pidv] = $inst }
    }
    if ($instByPid.Count -eq 0) { return $map }
    # Query private WS for exactly those instances in one call. The #N index in
    # the process instance list is stable across process counters, so resolving
    # the same instance name gives the same process.
    $paths = $instByPid.Values | ForEach-Object { "\Process($($_))\Working Set - Private" }
    $samples = @(Get-Counter -Counter $paths -ErrorAction SilentlyContinue)
    foreach ($c in $samples) {
      foreach ($s in $c.CounterSamples) {
        $inst = Get-CounterInstance $s.Path
        if ($inst -and $idByInst.ContainsKey($inst)) {
          $map[$idByInst[$inst]] = [math]::Round($s.CookedValue / $MB, 1)
        }
      }
    }
  } catch { }
  return $map
}

# ── walk every descendant of the given root PID (arbitrary depth) ─────────
function Get-DescendantProcs {
  param([int]$RootPid)
  $all = @(Get-CimInstance Win32_Process |
    Where-Object { $_.Name -eq "lume.exe" -or $_.Name -eq "msedgewebview2.exe" } |
    Select-Object ProcessId, ParentProcessId, Name, CommandLine,
                  WorkingSetSize, WorkingSetPrivateSize, PrivatePageCount)

  $kids = @{}
  foreach ($p in $all) {
    $k = [int]$p.ParentProcessId
    if (-not $kids.ContainsKey($k)) { $kids[$k] = [System.Collections.Generic.List[object]]::new() }
    $kids[$k].Add($p)
  }

  $out = [System.Collections.Generic.List[object]]::new()
  $stack = [System.Collections.Generic.Stack[object]]::new()
  if ($kids.ContainsKey($RootPid)) { foreach ($c in $kids[$RootPid]) { $stack.Push($c) } }
  while ($stack.Count -gt 0) {
    $p = $stack.Pop()
    $out.Add($p)
    if ($kids.ContainsKey([int]$p.ProcessId)) {
      foreach ($c in $kids[[int]$p.ProcessId]) { $stack.Push($c) }
    }
  }
  return $out
}

# ── one labeled memory snapshot ────────────────────────────────────────────
function New-MemSnapshot {
  param([string]$SnapLabel)
  $lume = Get-Process -Name "lume" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $lume) { throw "lume.exe 未在运行 —— 请先启动 release 版 Lume（src-tauri\target\release\lume.exe）。" }

  $tree = @(Get-DescendantProcs -RootPid $lume.Id)
  if ($tree.Count -eq 0) { throw "lume.exe 在运行，但没找到它的 WebView2 子进程（可能是 dev 模式或刚启动，稍后再试）。" }

  $privMap = Get-PrivateWSMap -Pids @($tree | ForEach-Object { [int]$_.ProcessId })
  $rows = foreach ($p in $tree) {
    $privWS = if ($privMap.ContainsKey([int]$p.ProcessId)) { $privMap[[int]$p.ProcessId] } else { $null }
    [pscustomobject]@{
      Type      = Get-ProcTypeName -Name $p.Name -Cmd $p.CommandLine
      Pid       = $p.ProcessId
      WS_MB     = [math]::Round(($p.WorkingSetSize) / $MB, 1)
      PrivWS_MB = $privWS          # Task-Manager-style private working set (MB)
      Commit_MB = [math]::Round(($p.PrivatePageCount) / $MB, 1)
    }
  }
  # Perf counter failed → fall back to total WS so we never print a bogus 0.
  $havePriv = ($rows | Where-Object { $null -ne $_.PrivWS_MB }).Count -gt 0
  if (-not $havePriv) {
    foreach ($r in $rows) { $r.PrivWS_MB = $r.WS_MB }
    Write-Host "  (注: 性能计数器未返回私有工作集，priv-WS 列暂用总工作集代替)"
  }

  $byType = $rows | Group-Object Type | ForEach-Object {
    [pscustomobject]@{
      Type      = $_.Name
      Count     = $_.Count
      WS_MB     = [math]::Round(($_.Group | Measure-Object WS_MB -Sum).Sum, 1)
      PrivWS_MB = [math]::Round(($_.Group | Measure-Object PrivWS_MB -Sum).Sum, 1)
      Commit_MB = [math]::Round(($_.Group | Measure-Object Commit_MB -Sum).Sum, 1)
    }
  }

  [pscustomobject]@{
    Label       = $SnapLabel
    Time        = Get-Date -Format "HH:mm:ss"
    Rows        = $rows
    ByType      = $byType
    TotalWS     = [math]::Round(($rows | Measure-Object WS_MB -Sum).Sum, 1)
    TotalPrivWS = [math]::Round(($rows | Measure-Object PrivWS_MB -Sum).Sum, 1)
    TotalCommit = [math]::Round(($rows | Measure-Object Commit_MB -Sum).Sum, 1)
  }
}

function Write-Snapshot {
  param($Snap)
  Write-Host ""
  Write-Host ("=" * 66)
  Write-Host ("  快照: {0}   [{1}]" -f $Snap.Label, $Snap.Time)
  Write-Host ("=" * 66)
  $Snap.ByType | Sort-Object Type | ForEach-Object {
    Write-Host ("  {0,-12} x{1,-3} priv-WS {2,8} MB   WS {3,8} MB   commit {4,8} MB" -f `
      $_.Type, $_.Count, $_.PrivWS_MB, $_.WS_MB, $_.Commit_MB)
  }
  Write-Host ("  " + ("-" * 60))
  Write-Host ("  TOTAL             priv-WS {0,8} MB   WS {1,8} MB   commit {2,8} MB" -f `
    $Snap.TotalPrivWS, $Snap.TotalWS, $Snap.TotalCommit)
  Write-Host ""
}

function Save-Snapshot {
  param($Snap)
  $safe = ($Snap.Label -replace '[^A-Za-z0-9_-]', '_')
  $path = Join-Path $OutDir ("{0}-{1}.txt" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $safe)
  $lines = [System.Collections.Generic.List[string]]::new()
  $lines.Add("Label: $($Snap.Label)")
  $lines.Add("Time : $($Snap.Time)")
  $lines.Add("")
  $Snap.ByType | Sort-Object Type | ForEach-Object {
    $lines.Add(("{0,-12} x{1,-3} priv-WS {2,8} MB   WS {3,8} MB   commit {4,8} MB" -f `
      $_.Type, $_.Count, $_.PrivWS_MB, $_.WS_MB, $_.Commit_MB))
  }
  $lines.Add("-" * 60)
  $lines.Add(("TOTAL priv-WS {0,8} MB   WS {1,8} MB   commit {2,8} MB" -f `
    $Snap.TotalPrivWS, $Snap.TotalWS, $Snap.TotalCommit))
  $lines.Add("")
  $lines.Add("Per-process (by priv-WS desc):")
  $Snap.Rows | Sort-Object { $_.PrivWS_MB } -Descending | ForEach-Object {
    $lines.Add(("  {0,-12} pid {1,-7} priv-WS {2,7} MB   WS {3,7} MB   commit {4,7} MB" -f `
      $_.Type, $_.Pid, $_.PrivWS_MB, $_.WS_MB, $_.Commit_MB))
  }
  Set-Content -Path $path -Value $lines -Encoding UTF8
  Write-Host ("  明细已存 → " + $path)
}

function Test-AppRunning {
  return [bool](Get-Process -Name "lume" -ErrorAction SilentlyContinue)
}

# ── one-shot mode ─────────────────────────────────────────────────────────
if ($Label -ne "") {
  try {
    $s = New-MemSnapshot -SnapLabel $Label
    Write-Snapshot $s
    Save-Snapshot $s
  } catch {
    Write-Host ("ERROR: " + $_.Exception.Message)
    exit 1
  }
  exit 0
}

# ── guided mode ───────────────────────────────────────────────────────────
Write-Host "Lume webview 内存测量（不改任何代码）"
Write-Host "说明: 快照 = lume.exe + 全部 msedgewebview2 子进程；priv-WS 是真正归 Lume 用的内存。"
Write-Host "      请用 release 版（src-tauri\target\release\lume.exe），不要用 npm run tauri dev。"
Write-Host ""

if (-not (Test-AppRunning)) {
  Write-Host "未检测到 lume.exe。"
  $ans = Read-Host "自动启动 release 版 Lume？(Y/n)"
  if ($ans -eq "" -or $ans -match "^[Yy]") {
    if (-not (Test-Path $Exe)) { Write-Host ("找不到 " + $Exe); exit 1 }
    Start-Process $Exe
    $tries = 0
    while (-not (Test-AppRunning) -and $tries -lt 20) { Start-Sleep -Milliseconds 500; $tries++ }
    if (-not (Test-AppRunning)) { Write-Host "启动失败（可能已有一个实例）。请手动启动。"; exit 1 }
    Write-Host "已启动，等它稳定 6 秒……"
    Start-Sleep -Seconds 6
  } else {
    Write-Host "请手动启动 release 版 Lume 后再运行本脚本。"; exit 0
  }
}

$stages = @(
  @{ n = 1; short = "baseline";  title = "基线（应用刚启动、全隐藏、设置从未打开）" }
  @{ n = 2; short = "clipboard"; title = "剪贴板页（Alt+Space 唤出 → Tab 切剪贴板 → 点「图片」分类让缩略图加载）" }
  @{ n = 3; short = "settings";  title = "设置窗口（点主窗口齿轮打开设置窗口）" }
  @{ n = 4; short = "bigimage";  title = "大图预览（剪贴板选一张图片行 → 预览区出现 → 点图放大全图）" }
)

$snaps = [System.Collections.Generic.List[object]]::new()
foreach ($st in $stages) {
  Write-Host ""
  Write-Host ("[第 {0}/4 步] {1}" -f $st.n, $st.short)
  Write-Host ("  目标状态: {0}" -f $st.title)
  if ($st.n -gt 1) { Write-Host "  操作: 把 Lume 调到本步目标状态后，Alt+Space 可随时唤出/隐藏。" }
  Read-Host "  调好界面后按回车（失焦会自动隐藏窗口——隐藏不卸载页面，3 秒后快照正好测常驻成本）" | Out-Null
  Write-Host "  快照中……"
  Start-Sleep -Seconds 3
  try {
    $s = New-MemSnapshot -SnapLabel ("stage{0}-{1}" -f $st.n, $st.short)
    Write-Snapshot $s
    Save-Snapshot $s
    $snaps.Add($s)
  } catch {
    Write-Host ("  快照失败: " + $_.Exception.Message)
    Read-Host "  按回车继续下一阶段（或 Ctrl+C 中止）" | Out-Null
  }
}

# ── comparison report ─────────────────────────────────────────────────────
if ($snaps.Count -ge 2) {
  $base = $snaps[0]
  Write-Host ""
  Write-Host ("=" * 66)
  Write-Host "  对比（priv-WS 为真正归 Lume 用的内存；Δ 是相对基线的增量）"
  Write-Host ("=" * 66)
  Write-Host ("  {0,-16} {1,10} {2,10} {3,12}" -f "阶段", "priv-WS MB", "WS MB", "Δ vs 基线")
  foreach ($s in $snaps) {
    $delta = if ($s -eq $base) { "--" } else { ("{0:+0.0; -0.0}" -f ($s.TotalPrivWS - $base.TotalPrivWS)) }
    Write-Host ("  {0,-16} {1,10} {2,10} {3,12}" -f $s.Label, $s.TotalPrivWS, $s.TotalWS, $delta)
  }
  Write-Host ""
  Write-Host "读法:"
  Write-Host "  baseline → clipboard 的增量 = 剪贴板大页面在常驻 webview 里的成本"
  Write-Host "  baseline → settings 的增量  = 第二个常驻 webview（设置窗口）的成本"
  Write-Host "  settings → bigimage 的增量  = 大图预览的峰值尖刺（改 asset:// 后可回落）"
  Write-Host "  baseline 本身               = WebView2 的固定开销（两个常驻窗口的基线）"
  Write-Host ""
  Write-Host ("全部明细文件在: " + $OutDir)
  Write-Host ""
} else {
  Write-Host "有效快照不足 2 个，跳过对比表。"
}
