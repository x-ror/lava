package jsc

// lava_jsc_init configures JavaScriptCore once before the first
// JSGlobalContextCreate: on Windows it disables the baseline JIT tier (broken in
// this bun-webkit build — see the .cpp) and runs JSC's process bring-up
// (WTF::initializeMainThread + JSC::initialize). Without it, heavy JS corrupts
// memory mid-execution (0xC0000409). The implementation is in build/jsc_init.lib
// (scripts/build-jsc-init-windows.sh, from pkg/jsc/jsc_init_windows.cpp) and is
// idempotent. No-op on Linux/macOS — so callers can invoke it unconditionally.
when ODIN_OS == .Windows {
	foreign import jsc_init_lib "system:jsc_init.lib"

	@(default_calling_convention = "c", link_prefix = "")
	foreign jsc_init_lib {
		lava_jsc_init :: proc() ---
	}
} else {
	lava_jsc_init :: proc() {}
}
