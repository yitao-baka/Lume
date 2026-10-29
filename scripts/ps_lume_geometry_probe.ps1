# Native launcher-geometry probe. Prints one compact JSON object per sample.
# Coordinates are physical screen pixels; work-area fields come from
# GetMonitorInfoW(MONITORINFOEX) so a DPI-aware caller sees the true taskbar edge.
param(
  [int]$IntervalMs = 1,
  [int]$DurationMs = 2500
)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LumeGeomProbe {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
  }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX mi);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr m, int type, out uint x, out uint y);
}
"@
[void][LumeGeomProbe]::SetProcessDPIAware()
$pids = @(Get-Process lume -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$script:main = [IntPtr]::Zero
$cb = [LumeGeomProbe+EnumProc] {
  param($h, $l)
  $owner = 0
  [void][LumeGeomProbe]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($pids -contains [int]$owner) {
    $cn = New-Object System.Text.StringBuilder 64
    [void][LumeGeomProbe]::GetClassName($h, $cn, 64)
    $tt = New-Object System.Text.StringBuilder 64
    [void][LumeGeomProbe]::GetWindowText($h, $tt, 64)
    if ($cn.ToString() -eq 'Tauri Window' -and $tt.ToString() -eq 'Lume') { $script:main = $h }
  }
  return $true
}
[void][LumeGeomProbe]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:main -eq [IntPtr]::Zero) { Write-Output '{"error":"main not found"}'; exit 1 }
$end = [DateTime]::UtcNow.AddMilliseconds($DurationMs)
while ([DateTime]::UtcNow -lt $end) {
  $r = New-Object LumeGeomProbe+RECT
  $c = New-Object LumeGeomProbe+RECT
  $mi = New-Object LumeGeomProbe+MONITORINFOEX
  $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
  [void][LumeGeomProbe]::GetWindowRect($script:main, [ref]$r)
  [void][LumeGeomProbe]::GetClientRect($script:main, [ref]$c)
  $hm = [LumeGeomProbe]::MonitorFromWindow($script:main, 2)
  [void][LumeGeomProbe]::GetMonitorInfo($hm, [ref]$mi)
  [uint32]$dpiX = 0; [uint32]$dpiY = 0
  [void][LumeGeomProbe]::GetDpiForMonitor($hm, 0, [ref]$dpiX, [ref]$dpiY)
  [pscustomobject]@{
    t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    visible = [LumeGeomProbe]::IsWindowVisible($script:main)
    left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom
    clientW = ($c.Right - $c.Left); clientH = ($c.Bottom - $c.Top)
    workLeft = $mi.rcWork.Left; workTop = $mi.rcWork.Top
    workRight = $mi.rcWork.Right; workBottom = $mi.rcWork.Bottom
    monitorLeft = $mi.rcMonitor.Left; monitorTop = $mi.rcMonitor.Top
    dpiX = $dpiX; dpiY = $dpiY
  } | ConvertTo-Json -Compress
  Start-Sleep -Milliseconds $IntervalMs
}
