# Main launcher window probe/mover — how scripts/cdp_window_position_verify.mjs
# drives a REAL user-style window move (docs/ROADMAP_HISTORY.md #41).
#
# Finds lume.exe's main window even while hidden: class "Tauri Window",
# title "Lume", WS_EX_TOPMOST (设置/插件窗口不是 topmost；preview 标题不同).
# NOTE: SetWindowPos with SWP_NOSIZE is silently ignored for this tao window
# (verified on hardware), so the mover keeps the size and uses MoveWindow.
#
# Output: "<left>,<top>,<right>,<bottom>" in the probe process's screen space
# (DPI-unaware PowerShell sees virtualized coordinates — the same DIP space as
# window.screenX on this 150% display). With $env:LUME_MOVE="x,y" the window is
# first MoveWindow()'d there, then the (new) rect is printed.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LumeMainPos {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
$pids = @(Get-Process lume -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$script:main = [IntPtr]::Zero
$cb = [LumeMainPos+EnumProc] {
  param($h, $l)
  $owner = 0
  [void][LumeMainPos]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($pids -contains [int]$owner) {
    $cn = New-Object System.Text.StringBuilder 64
    [void][LumeMainPos]::GetClassName($h, $cn, 64)
    if ($cn.ToString() -eq 'Tauri Window') {
      $tt = New-Object System.Text.StringBuilder 64
      [void][LumeMainPos]::GetWindowText($h, $tt, 64)
      if ($tt.ToString() -eq 'Lume' -and ([int64][LumeMainPos]::GetWindowLongPtr($h, -20) -band 0x8) -ne 0) {
        $script:main = $h
      }
    }
  }
  return $true
}
[void][LumeMainPos]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:main -eq [IntPtr]::Zero) { Write-Output "NONE"; exit 1 }
$r = New-Object LumeMainPos+RECT
if ($env:LUME_MOVE) {
  $p = $env:LUME_MOVE.Split(',')
  [void][LumeMainPos]::GetWindowRect($script:main, [ref]$r)
  [void][LumeMainPos]::MoveWindow($script:main, [int]$p[0], [int]$p[1], ($r.Right - $r.Left), ($r.Bottom - $r.Top), $true)
  Start-Sleep -Milliseconds 200
}
[void][LumeMainPos]::GetWindowRect($script:main, [ref]$r)
Write-Output ("{0},{1},{2},{3}" -f $r.Left, $r.Top, $r.Right, $r.Bottom)
