package lava_runtime

// configure_jsc_options pins JSC engine options that must be in place before the
// first JSGlobalContextCreate — JSC reads its JSC_* options from the environment
// when it initializes Options at first VM creation. Idempotent; only the first
// call (before any VM exists) is observed by JSC. Called from eval() just before
// the context is created. See the platform branches below for the rationale.

when ODIN_OS == .Windows {
	// JSC reads options via the CRT getenv. os.set_env uses SetEnvironmentVariableW
	// (the Win32 environment block), which the CRT does NOT re-read after process
	// startup, so an option set that way is invisible to JSC. _putenv_s writes the
	// CRT environment directly (and UCRT keeps the Win32 block in sync), so getenv
	// sees it. libucrt.lib is already on the link line (see core:c/libc).
	foreign import libucrt "system:libucrt.lib"

	@(default_calling_convention = "c")
	foreign libucrt {
		_putenv_s :: proc(name: cstring, value: cstring) -> i32 ---
	}

	configure_jsc_options :: proc() {
		// Concurrent JIT compiles bytecode on a background thread while the main
		// thread keeps executing. On Windows that races and crashes the process
		// mid-execution under a heavy JS workload (STATUS_STACK_BUFFER_OVERRUN /
		// 0xC0000409, surfaced by the runner as exit 127), even though the script is
		// correct — verified against the node-compat URL and crypto cases. Compiling
		// JIT synchronously removes the race; JIT itself stays on, so there is no
		// interpreter-only performance cliff (disabling useJIT entirely made the
		// crash markedly *worse*, not better).
		_putenv_s("JSC_useConcurrentJIT", "false")
	}
} else {
	// Concurrent JIT is stable and faster on the other platforms; nothing to pin.
	configure_jsc_options :: proc() {}
}
