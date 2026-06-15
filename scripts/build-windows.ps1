param(
	[string]$Arch = "x64"
)

# Local Windows build of build/lava.exe (JSC-backed). The Unix scripts/build.sh
# links system JavaScriptCore via pkg-config, which does not exist on Windows;
# here we set up the MSVC environment, dump it for scripts/link-windows-local.sh,
# and run that link step (the local port of the CI Windows link).
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

. "$PSScriptRoot\lib\msvc.ps1"

# JavaScriptCore (bun-webkit) is provisioned out of git into .deps/. Fail early
# with an actionable hint rather than deep inside the linker.
if (-not (Test-Path "$Root\.deps\webkit\bun-webkit\lib")) {
	throw "JavaScriptCore (bun-webkit) is not provisioned at .deps\webkit\bun-webkit\lib. Run: make bootstrap-windows-deps"
}

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

New-Item -ItemType Directory -Force -Path "$Root\build" | Out-Null

# Dump the activated MSVC environment (LIB/INCLUDE/PATH + the rest) so
# link-windows-local.sh can consume it. Write ASCII (no BOM) so the script's
# grep can read it under both Windows PowerShell 5.1 and PowerShell 7; the
# script already tolerates the CRLF line endings Out-File emits.
$envFile = "$Root\build\vcvars-env.txt"
& cmd.exe /d /s /c "call `"$vcvars`" $vcArgs >nul && set" |
	Out-File -FilePath $envFile -Encoding ascii
if (-not (Select-String -Path $envFile -Pattern '^LIB=' -Quiet)) {
	throw "MSVC environment dump did not contain LIB (vcvarsall '$vcArgs' may have failed). See $envFile."
}

& "$bash" scripts/link-windows-local.sh
exit $LASTEXITCODE
