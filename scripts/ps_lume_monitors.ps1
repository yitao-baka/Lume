# Enumerate physical monitor work areas and effective DPI.
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class LumeMonitors {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, EnumProc cb, IntPtr data);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFOEX mi);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr m, int type, out uint x, out uint y);
}
"@
[void][LumeMonitors]::SetProcessDPIAware()
$result = New-Object System.Collections.Generic.List[object]
$cb = [LumeMonitors+EnumProc] {
  param($monitor, $hdc, $rect, $data)
  $mi = New-Object LumeMonitors+MONITORINFOEX
  $mi.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($mi)
  [void][LumeMonitors]::GetMonitorInfo($monitor, [ref]$mi)
  [uint32]$dpiX = 0; [uint32]$dpiY = 0
  [void][LumeMonitors]::GetDpiForMonitor($monitor, 0, [ref]$dpiX, [ref]$dpiY)
  $result.Add([pscustomobject]@{ device = $mi.szDevice; left = $mi.rcMonitor.Left; top = $mi.rcMonitor.Top; right = $mi.rcMonitor.Right; bottom = $mi.rcMonitor.Bottom; workLeft = $mi.rcWork.Left; workTop = $mi.rcWork.Top; workRight = $mi.rcWork.Right; workBottom = $mi.rcWork.Bottom; dpiX = $dpiX; dpiY = $dpiY })
  return $true
}
[void][LumeMonitors]::EnumDisplayMonitors([IntPtr]::Zero, [IntPtr]::Zero, $cb, [IntPtr]::Zero)
$result | ConvertTo-Json -Compress