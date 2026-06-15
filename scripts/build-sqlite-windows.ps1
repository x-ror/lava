param(
	[string]$Arch = "x64"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Get-ProgramFilesRoots {
	# When launched from a 32-bit process (e.g. ezwinports make), $env:ProgramFiles
	# reflects the WOW64 view ("C:\Program Files (x86)"), so it cannot be trusted
	# to locate 64-bit installs. ProgramW6432 always points at the real
	# "C:\Program Files" regardless of process bitness.
	return @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)}) |
		Where-Object { $_ } |
		Select-Object -Unique
}

function Find-GitBash {
	if ($env:GIT_BASH -and (Test-Path $env:GIT_BASH)) {
		return $env:GIT_BASH
	}

	$candidates = foreach ($root in Get-ProgramFilesRoots) {
		"$root\Git\bin\bash.exe"
		"$root\Git\usr\bin\bash.exe"
	}

	foreach ($candidate in $candidates) {
		if ($candidate -and (Test-Path $candidate)) {
			return $candidate
		}
	}

	# Derive from git on PATH: <gitroot>\cmd\git.exe -> <gitroot>\bin\bash.exe.
	$git = Get-Command git -ErrorAction SilentlyContinue
	if ($git) {
		$gitRoot = Split-Path -Parent (Split-Path -Parent $git.Source)
		foreach ($leaf in @("bin\bash.exe", "usr\bin\bash.exe")) {
			$candidate = Join-Path $gitRoot $leaf
			if (Test-Path $candidate) {
				return $candidate
			}
		}
	}

	$cmd = Get-Command bash -ErrorAction SilentlyContinue
	if ($cmd -and $cmd.Source -notlike "*\WindowsApps\bash.exe") {
		return $cmd.Source
	}

	throw "Git Bash was not found. Install Git for Windows or set GIT_BASH to bash.exe."
}

function Find-VcVars {
	if ($env:VCVARS64 -and (Test-Path $env:VCVARS64)) {
		return $env:VCVARS64
	}

	# Ask vswhere for the env-setup batch file directly. -all -prerelease covers
	# editions and newer VS versions (e.g. VS 18, which ships only vcvarsall.bat
	# and no longer provides the per-arch vcvars64.bat). Prefer vcvarsall.bat
	# (called with the arch argument) and fall back to vcvars64.bat.
	$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
	if (Test-Path $vswhere) {
		foreach ($leaf in @("vcvarsall.bat", "vcvars64.bat")) {
			$found = & $vswhere -all -prerelease -products * -find "VC\Auxiliary\Build\$leaf" |
				Where-Object { $_ -and (Test-Path $_) } |
				Select-Object -First 1
			if ($found) {
				return $found
			}
		}
	}

	# Fallback: scan all Program Files roots, common editions and VS versions.
	$roots = Get-ProgramFilesRoots
	$versions = @("18", "2022")
	$editions = @("BuildTools", "Community", "Professional", "Enterprise")
	foreach ($root in $roots) {
		foreach ($version in $versions) {
			foreach ($edition in $editions) {
				$base = Join-Path $root "Microsoft Visual Studio\$version\$edition\VC\Auxiliary\Build"
				foreach ($leaf in @("vcvarsall.bat", "vcvars64.bat")) {
					$candidate = Join-Path $base $leaf
					if (Test-Path $candidate) {
						return $candidate
					}
				}
			}
		}
	}

	throw "MSVC environment script (vcvarsall.bat / vcvars64.bat) was not found. Install Visual Studio Build Tools with the 'Desktop development with C++' workload, or set VCVARS64 to the full path of vcvarsall.bat or vcvars64.bat."
}

function Find-VcToolsVersion {
	param([string]$VcVarsPath)

	# vcvarsall.bat picks a "default" toolset from its props files, but on some
	# installs that pointer names a toolset that was never fully installed (its
	# include/bin dirs are missing), which leaves INCLUDE/LIB empty and the build
	# fails with "Cannot open include file: 'stdarg.h'". Pick the highest toolset
	# that is actually complete on disk and pin it via -vcvars_ver.
	if ($VcVarsPath -notlike "*\vcvarsall.bat") {
		return $null
	}

	$vcRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $VcVarsPath))
	$msvc = Join-Path $vcRoot "Tools\MSVC"
	if (-not (Test-Path $msvc)) {
		return $null
	}

	$complete = Get-ChildItem $msvc -Directory -ErrorAction SilentlyContinue |
		Where-Object {
			(Test-Path (Join-Path $_.FullName "include\stdarg.h")) -and
			(Test-Path (Join-Path $_.FullName "bin\HostX64\x64\cl.exe"))
		} |
		Sort-Object { [version]($_.Name) } -Descending |
		Select-Object -First 1

	if ($complete) {
		return $complete.Name
	}
	return $null
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

$command = "call `"$vcvars`" $vcArgs && `"$bash`" scripts/build-sqlite-windows.sh"
& cmd.exe /d /s /c $command
exit $LASTEXITCODE
