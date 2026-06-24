#+build !linux
package lava_runtime

// Multi-worker is Linux-only — lava_resolve_worker_count rejects LAVA_WORKERS>1 on other platforms, so
// the supervisor is never invoked here. These stubs exist only so workers.odin (all-platform) compiles.

supervisor_block_signals :: proc() {}

supervisor_wait :: proc(workers: []Worker) {}
