#+build windows
package lava_runtime

import "core:sys/windows"

// Windows implementations of os.odin's platform procs. The node-compat oracle is
// POSIX-path-shaped and does not run on Windows (see ci.yml), so this layer is
// best-effort: memory, CPU count and uptime are real (GlobalMemoryStatusEx /
// GetSystemInfo / GetTickCount64); user/host info come from the environment;
// per-CPU times, load average and network interfaces are not implemented (zeroed /
// empty) since they need iphlpapi/PDH walks that no test here exercises.

foreign import kernel32 "system:Kernel32.lib"
@(default_calling_convention = "stdcall")
foreign kernel32 {
	GetTickCount64 :: proc() -> u64 ---
}

when ODIN_ARCH == .amd64 {
	WIN_MACHINE :: "x86_64"
} else when ODIN_ARCH == .arm64 {
	WIN_MACHINE :: "arm64"
} else when ODIN_ARCH == .i386 {
	WIN_MACHINE :: "i686"
} else {
	WIN_MACHINE :: "unknown"
}

os_hostname :: proc() -> string {
	return os_getenv_or("COMPUTERNAME", "localhost")
}

os_uname :: proc(field: Uname_Field) -> string {
	switch field {
	case .SYSNAME:
		return "Windows_NT"
	case .RELEASE:
		// Accurate build (e.g. "10.0.19045") needs RtlGetVersion from ntdll, which
		// is not in the link set; report a stable placeholder until that lands.
		return "10.0.0"
	case .VERSION:
		return "Windows"
	case .MACHINE:
		return WIN_MACHINE
	}
	return ""
}

os_totalmem :: proc() -> u64 {
	status: windows.MEMORYSTATUSEX
	status.dwLength = windows.DWORD(size_of(windows.MEMORYSTATUSEX))
	if !windows.GlobalMemoryStatusEx(&status) {
		return 0
	}
	return u64(status.ullTotalPhys)
}

os_freemem :: proc() -> u64 {
	status: windows.MEMORYSTATUSEX
	status.dwLength = windows.DWORD(size_of(windows.MEMORYSTATUSEX))
	if !windows.GlobalMemoryStatusEx(&status) {
		return 0
	}
	return u64(status.ullAvailPhys)
}

os_uptime :: proc() -> f64 {
	return f64(GetTickCount64()) / 1000.0
}

os_loadavg :: proc() -> [3]f64 {
	return {0, 0, 0} // Windows has no load average; Node also returns [0, 0, 0].
}

os_avail_parallelism :: proc() -> int {
	si: windows.SYSTEM_INFO
	windows.GetSystemInfo(&si)
	n := int(si.dwNumberOfProcessors)
	if n < 1 {
		return 1
	}
	return n
}

os_cpus :: proc() -> []Os_Cpu {
	count := os_avail_parallelism()
	model := os_getenv_or("PROCESSOR_IDENTIFIER", "unknown")
	cpus := make([]Os_Cpu, count, context.temp_allocator)
	for i in 0 ..< count {
		cpus[i] = Os_Cpu {
			model = model,
		}
	}
	return cpus
}

os_user_info :: proc() -> Os_User_Info {
	// Windows has no uid/gid; Node reports -1 for both and a null shell.
	return Os_User_Info {
		uid = -1,
		gid = -1,
		username = os_getenv_or("USERNAME", ""),
		homedir = os_getenv_or("USERPROFILE", ""),
		has_shell = false,
	}
}

os_network_interfaces :: proc() -> []Os_Net_Iface {
	return nil // Not implemented on Windows (needs a GetAdaptersAddresses walk).
}

os_get_priority :: proc(pid: int) -> (value: int, ok: bool) {
	return 0, true // PRIORITY_NORMAL; real priority classes are not wired up.
}

os_set_priority :: proc(pid: int, value: int) -> bool {
	return true // No-op until SetPriorityClass is wired up.
}
