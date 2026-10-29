# Move the real launcher HWND to a physical monitor coordinate without changing
# its size. DPI-aware so mixed-scale monitors share one coordinate space with
# ps_lume_geometry_probe.ps1. Output: "<left>,<top>,<right>,<bottom>".
param([int]$X, [int]$Y)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LumeMove {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][LumeMove]::SetProcessDPIAware()
$pids = @(Get-Process lume -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$script:main = [IntPtr]::Zero
$cb = [LumeMove+EnumProc] {
  param($h, $l)
  $owner = 0
  [void][LumeMove]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($pids -contains [int]$owner) {
    $cn = New-Object System.Text.StringBuilder 64
    [void][LumeMove]::GetClassName($h, $cn, 64)
    $tt = New-Object System.Text.StringBuilder 64
    [void][LumeMove]::GetWindowText($h, $tt, 64)
    if ($cn.ToString() -eq 'Tauri Window' -and $tt.ToString() -eq 'Lume' -and
        ([int64][LumeMove]::GetWindowLongPtr($h, -20) -band 0x8) -ne 0) {
      $script:main = $h
    }
  }
  return $true
}
[void][LumeMove]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:main -eq [IntPtr]::Zero) { Write-Output 'NONE'; exit 1 }
$r = New-Object LumeMove+RECT
[void][LumeMove]::GetWindowRect($script:main, [ref]$r)
[void][LumeMove]::MoveWindow($script:main, $X, $Y, ($r.Right - $r.Left), ($r.Bottom - $r.Top), $true)
Start-Sleep -Milliseconds 180
[void][LumeMove]::GetWindowRect($script:main, [ref]$r)
Write-Output ("{0},{1},{2},{3}" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
