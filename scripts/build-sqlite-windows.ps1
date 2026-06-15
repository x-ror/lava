param(
	[string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

. "$PSScriptRoot\lib\msvc.ps1"

$bash = Find-GitBash
$vcvars = Find-VcVars
$vcToolsVer = Find-VcToolsVersion -VcVarsPath $vcvars

Write-Host "Using MSVC environment: $vcvars"
Write-Host "Using bash: $bash"

$vcArgs = $Arch
if ($vcToolsVer) {
	Write-Host "Pinning MSVC toolset: $vcToolsVer"
	$vcArgs = "$Arch -vcvars_ver=$vcToolsVer"
}

$command = "call `"$vcvars`" $vcArgs && `"$bash`" scripts/build-sqlite-windows.sh"
& cmd.exe /d /s /c $command
exit $LASTEXITCODE
