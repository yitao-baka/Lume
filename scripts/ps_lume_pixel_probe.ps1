# Capture one screen pixel and return "r,g,b". Used to verify the launcher is
# opaque after the native transparent flag was removed.
param([int]$X, [int]$Y)
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap 1,1
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X,$Y,0,0,(New-Object System.Drawing.Size 1,1))
$c = $bmp.GetPixel(0,0)
[void]$g.Dispose(); [void]$bmp.Dispose()
Write-Output ("{0},{1},{2}" -f $c.R,$c.G,$c.B)
