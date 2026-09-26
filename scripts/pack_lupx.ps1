# Pack a plugin directory into a `.lupx` archive (plugin_install.rs 的输入格式).
#
# Usage:  powershell -NoProfile -File scripts/pack_lupx.ps1 <plugin-dir> <out.lupx>
#   e.g. powershell -NoProfile -File scripts/pack_lupx.ps1 examples/plugins/web-search web-search.lupx
#
# The archive layout: `plugin.toml` plus the plugin's assets at the archive
# root (a nested single-directory layout is accepted on install too, but the
# flat one is canonical). The manifest must declare `id` — a packaged plugin
# has no directory name to fall back to.
#
# Note: .NET's ZipArchive writes the UTF-8 flag for non-ASCII entry names, so
# Chinese file names survive; plain ASCII names are still the safest choice.
param(
    [Parameter(Mandatory = $true)][string]$PluginDir,
    [Parameter(Mandatory = $true)][string]$OutPath
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path (Join-Path $PluginDir "plugin.toml"))) {
    throw "no plugin.toml in '$PluginDir' — a .lupx must carry a manifest"
}

if (Test-Path $OutPath) { Remove-Item $OutPath -Force }

# Compress-Archive copies the CHILDREN when given "dir/*", producing the
# canonical root layout (plugin.toml at the archive root).
Compress-Archive -Path (Join-Path $PluginDir "*") -DestinationPath $OutPath

Write-Host "packed $OutPath"
Get-ChildItem $OutPath | Format-List Name, Length
