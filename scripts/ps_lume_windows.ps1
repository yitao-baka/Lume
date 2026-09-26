# Launcher window-state probe — how many of lume.exe's top-level windows are
# visible right now. Used by scripts/cdp_p1_verify.mjs (and handy by hand):
# the paste flow hides the launcher, and document.visibilityState does NOT
# reflect that in WebView2, so the check has to come from the OS side.
#
# Output: one line, `visible=<n> total=<m>`, counting only the "Tauri Window"
# class entries (the launcher + settings + preview). Tao's internal
# "Tao Thread Event Target" window is always visible and is excluded — it is
# what made Get-Process MainWindowHandle report a wrong answer first.
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class LumeWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
}
"@
$pids = @(Get-Process lume -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
$visible = 0
$total = 0
$cb = [LumeWin+EnumProc] {
  param($h, $l)
  $owner = 0
  [void][LumeWin]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($pids -contains [int]$owner) {
    $cn = New-Object System.Text.StringBuilder 256
    [void][LumeWin]::GetClassName($h, $cn, 256)
    if ($cn.ToString() -eq 'Tauri Window') {
      $script:total++
      if ([LumeWin]::IsWindowVisible($h)) { $script:visible++ }
    }
  }
  return $true
}
[void][LumeWin]::EnumWindows($cb, [IntPtr]::Zero)
Write-Output ("visible=" + $visible + " total=" + $total)
