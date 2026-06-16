// Windows-only JavaScriptCore initialization shim.
//
// lava embeds JSC through the bare C API (JSGlobalContextCreate) and statically
// links the bun-webkit JavaScriptCore build. A dynamically-loaded JSC performs
// its one-time process bring-up via the OS loader; a statically-linked one never
// does, and the C API only lazily inits a minimal subset at first VM touch. The
// result on Windows is that JSC's JIT (executable-memory allocator, the
// concurrent-JIT worklist thread) and the parallel GC marker threads run on
// half-initialized engine state, which corrupts memory mid-execution under a
// heavy synchronous JS workload — surfacing as STATUS_STACK_BUFFER_OVERRUN
// (0xC0000409, reported by the test runner as exit 127). macOS/Linux are
// unaffected because the JSC there is a dylib that self-initializes.
//
// This is the same bring-up Bun (which ships the identical WebKit fork) performs
// before creating any VM: register the embedder's main thread, then run JSC's
// umbrella initialize() (Options finalize, JIT/GC threads, executable allocator,
// Config pages). Both calls are internally once-guarded and idempotent; we also
// guard the pair with std::call_once and run it on the process main thread before
// the first JSGlobalContextCreate. Keeping this correct lets us run FULL JIT.
//
// We FORWARD-DECLARE the two entry points rather than #include the WebKit C++
// headers: the bun-webkit release payload ships an incomplete internal header set
// (e.g. wtf/PlatformEnableWin.h is absent), and these functions are not in the
// public C API. Both are plain `void()` free functions in their namespaces, so
// these declarations mangle to exactly the symbols the static libs export
// (?initializeMainThread@WTF@@YAXXZ in WTF.lib, ?initialize@JSC@@YAXXZ in
// JavaScriptCore.lib) — no headers, no cmakeconfig/struct-layout concerns. If JSC
// ever renames or re-signatures these, the link fails loudly with the missing
// mangled symbol.
//
// Build: scripts/build-jsc-init-windows.sh compiles this with MSVC cl /MT (static
// CRT, matching the bun-webkit libs) into build/jsc_init.lib, put on the linker's
// LIB path; pkg/jsc imports the extern "C" entry below via `system:jsc_init.lib`.

#include <cstdlib>
#include <mutex>

namespace WTF {
void initializeMainThread();
}

namespace JSC {
void initialize();
}

extern "C" void lava_jsc_init(void) {
	static std::once_flag once;
	std::call_once(once, [] {
		// Disable the baseline JIT tier. That single tier is broken in this
		// bun-webkit Windows build in two ways, each of which corrupts memory
		// mid-execution (0xC0000409 / exit 127): its concurrent compilation races
		// the main thread (the node:url suite's crash), and its codegen for hot
		// numeric loops is wrong (the node:crypto/scrypt suite's crash). Disabling
		// just this tier fixes both while keeping the rest of the pipeline —
		// LLInt -> DFG -> FTL — so optimized JIT is retained (vastly better than
		// useJIT=false, which removes all JIT and itself destabilizes node:url).
		// Set via the CRT environment so JSC's Options finalize (inside initialize()
		// below) reads it through getenv; must be set BEFORE initialize().
		_putenv_s("JSC_useBaselineJIT", "false");

		WTF::initializeMainThread();
		JSC::initialize();
	});
}
