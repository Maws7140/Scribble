# Builds the helper's installers, one per architecture, into installer\output.
#   .\build.ps1                      both, x64 and arm64
#   .\build.ps1 -Arch arm64          one
# Needs the .NET 10 SDK (dotnet on PATH, or $env:DOTNET_ROOT) and Inno Setup 6 (iscc on PATH, or -Iscc).
param(
  [string[]]$Arch = @("x64", "arm64"),
  [string]$Iscc = ""
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$version = (Get-Content (Join-Path $root "plugin\manifest.json") -Raw | ConvertFrom-Json).version
$dotnet = if ($env:DOTNET_ROOT -and (Test-Path (Join-Path $env:DOTNET_ROOT "dotnet.exe"))) { Join-Path $env:DOTNET_ROOT "dotnet.exe" } else { "dotnet" }
if (-not $Iscc) {
  $Iscc = @((Get-Command iscc -ErrorAction SilentlyContinue).Source,
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe", "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe") | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
if (-not $Iscc) { throw "Inno Setup 6 not found: install it, or pass -Iscc <path to ISCC.exe>." }

foreach ($a in $Arch) {
  $publish = Join-Path $root "helper\publish-$a"
  if (Test-Path $publish) { Remove-Item -Recurse -Force $publish }
  & $dotnet publish (Join-Path $root "helper\InkOverlay.csproj") -c Release -r "win-$a" -o $publish "-p:Version=$version"
  if ($LASTEXITCODE) { throw "publish for $a failed" }
  & $Iscc "/DAppVersion=$version" "/DArch=$a" "/DSource=$publish" (Join-Path $here "Scribble.iss")
  if ($LASTEXITCODE) { throw "installer for $a failed" }
}
Get-ChildItem (Join-Path $here "output") -Filter "Scribble-helper-$version-*.exe" | ForEach-Object { "{0}  {1:N0} MB" -f $_.Name, ($_.Length / 1MB) }
