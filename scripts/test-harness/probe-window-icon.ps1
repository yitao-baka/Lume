param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$OutputPath
)

Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class LumeWindowIconProbe {
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")]
    public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int index);
}
'@

$process = Get-Process -Id $ProcessId
$process.Refresh()
$hwnd = $process.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw "process has no main window" }

# WM_GETICON: ICON_BIG drives taskbar/Alt-Tab, ICON_SMALL drives title-bar paths.
$iconBig = [LumeWindowIconProbe]::SendMessage($hwnd, 0x7F, [IntPtr]::new(1), [IntPtr]::Zero)
$iconSmall = [LumeWindowIconProbe]::SendMessage($hwnd, 0x7F, [IntPtr]::new(0), [IntPtr]::Zero)
$classIcon = [LumeWindowIconProbe]::GetClassLongPtr($hwnd, -14)
$iconHandle = if ($iconBig -ne [IntPtr]::Zero) { $iconBig } else { $classIcon }
if ($iconHandle -eq [IntPtr]::Zero) { throw "window has no big/class icon" }

$icon = [System.Drawing.Icon]::FromHandle($iconHandle)
$bitmap = $icon.ToBitmap()
$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$right = $bitmap.GetPixel(29, 16)

# The bundle icon's rounded rice-white plate is opaque at (29,16); the
# transparent brand mark is fully transparent there.
[pscustomobject]@{
  hwnd = $hwnd.ToInt64()
  bigHandle = $iconBig.ToInt64()
  smallHandle = $iconSmall.ToInt64()
  classHandle = $classIcon.ToInt64()
  width = $bitmap.Width
  height = $bitmap.Height
  rightAlpha = $right.A
  rightR = $right.R
  rightG = $right.G
  rightB = $right.B
  output = $OutputPath
} | ConvertTo-Json -Compress

$bitmap.Dispose()
# Do not dispose $icon: it wraps the window-owned HICON still in use by the
# running process.
