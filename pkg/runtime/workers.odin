package lava_runtime

import "core:os"
import "core:strconv"
import "core:sync"
import "core:thread"
import eventloop "lava:pkg/runtime/eventloop"

// Multi-core workers (Slice 3a). JSC contexts can't share a heap and a shared VM serializes, so "use N
// cores" means N independent shared-nothing workers — each its own { event loop + JSC context +
// Runtime_State } running the app, with the kernel load-balancing connections via SO_REUSEPORT (commit
// 5). This file is the supervisor + the startup barrier; shutdown (signalfd / stop state machine) and
// listener sharing land in later commits.

// LAVA_WORKERS_MAX bounds the worker count so a typo/overflow can't spawn thousands of threads.
LAVA_WORKERS_MAX :: 256

// lava_resolve_worker_count reads LAVA_WORKERS and resolves how many workers to run. Unset / "1" -> 1
// (the single inline path, unchanged). "auto" -> the CPU core count. An explicit integer in
// [1, LAVA_WORKERS_MAX] -> that. Anything else fails fast (ok=false + a message), never a silent
// degrade: malformed / 0 / negative / oversized, or LAVA_WORKERS>1 on a non-Linux platform
// (multi-worker needs SO_REUSEPORT/signalfd/io_uring — Linux only).
lava_resolve_worker_count :: proc() -> (count: int, ok: bool, msg: string) {
	raw, has := os.lookup_env("LAVA_WORKERS", context.temp_allocator)
	if !has || raw == "" || raw == "1" do return 1, true, ""

	n: int
	if raw == "auto" {
		n = os.get_processor_core_count()
		if n < 1 do n = 1
	} else {
		parsed, pok := strconv.parse_int(raw)
		if !pok do return 0, false, "LAVA_WORKERS must be a positive integer or 'auto'"
		n = parsed
	}
	if n < 1 do return 0, false, "LAVA_WORKERS must be >= 1"
	if n > LAVA_WORKERS_MAX do return 0, false, "LAVA_WORKERS exceeds the maximum of 256"
	when ODIN_OS != .Linux {
		if n > 1 do return 0, false, "multi-worker (LAVA_WORKERS > 1) is supported only on Linux"
	}
	return n, true, ""
}

// g_multi_worker is read by net_listen_cb (commit 5) to decide whether to set SO_REUSEPORT. The
// supervisor sets it true ONCE before spawning any worker; workers only read it, and the thread
// spawn is the happens-before edge, so a plain bool needs no atomics.
g_multi_worker: bool

// --- startup barrier (abortable two-phase) -------------------------------------------------------
//
// Each worker, after its top-level eval succeeds, reports "ready" and blocks until ALL expected
// workers have reported. All ready -> RELEASE (workers run their loops); any FAILED (eval errored
// before its hook, or a thread never started) -> ABORT (ready workers skip run() and tear down). A
// server must not start serving on some cores while another core failed to come up (#293 §6.2).
// Self-deciding: the last reporter computes the outcome, so no separate supervisor broadcast is
// needed. The mutex is the happens-before edge that publishes the outcome to the blocked workers.
Worker_Barrier :: struct {
	mutex:      sync.Mutex,
	cond:       sync.Cond,
	total:      int, // workers expected to report
	reported:   int, // ready + failed
	any_failed: bool, // a worker failed, or a thread never started
	decided:    bool,
	released:   bool, // outcome (valid once decided): true = run, false = abort
}

// barrier_settle records one report under the mutex and, once all expected workers have reported,
// decides (release iff nobody failed) and wakes everyone. failed=true marks a startup failure.
@(private = "file")
barrier_settle :: proc(b: ^Worker_Barrier, failed: bool) {
	sync.lock(&b.mutex)
	defer sync.unlock(&b.mutex)
	if failed do b.any_failed = true
	b.reported += 1
	if b.reported >= b.total && !b.decided {
		b.decided = true
		b.released = !b.any_failed
	}
	sync.cond_broadcast(&b.cond)
}

// barrier_ready_wait is the success path: report ready, then block until the barrier decides. Returns
// whether to proceed (released) or abort.
@(private = "file")
barrier_ready_wait :: proc(b: ^Worker_Barrier) -> bool {
	sync.lock(&b.mutex)
	defer sync.unlock(&b.mutex)
	b.reported += 1
	if b.reported >= b.total && !b.decided {
		b.decided = true
		b.released = !b.any_failed
	}
	sync.cond_broadcast(&b.cond)
	for !b.decided do sync.cond_wait(&b.cond, &b.mutex)
	return b.released
}

// Worker is one shared-nothing instance: it runs eval() on its own thread with its own loop + JSC
// context. The input fields are read-only after spawn; reported/result are written only by this
// worker's thread (read by the supervisor after join).
Worker :: struct {
	source:      string,
	source_name: string,
	script_args: []string,
	barrier:     ^Worker_Barrier,
	reported:    bool, // did the ready hook run? (else the wrapper reports a startup failure)
	result:      Result,
}

@(private = "file")
worker_pre_run :: proc(user_data: rawptr) -> bool {
	w := cast(^Worker)user_data
	w.reported = true
	return barrier_ready_wait(w.barrier)
}

@(private = "file")
worker_main :: proc(data: rawptr) {
	w := cast(^Worker)data
	loop := eventloop.init(real_time = true)
	// eval consumes the loop (destroys it on every path); the pre-run hook is the barrier rendezvous.
	w.result = eval(w.source, w.source_name, &loop, false, w.script_args, worker_pre_run, w)
	// If eval returned before the ready hook ran (JSC create / top-level throw / bind failure), this
	// worker failed startup — report it so blocked peers abort instead of waiting forever.
	if !w.reported do barrier_settle(w.barrier, true)
}

// lava_run_workers is the multi-worker supervisor: read the entry once, spawn `count` workers each
// running it on its own loop + context, and join them. Returns the process exit code. (Graceful
// shutdown via signalfd and SO_REUSEPORT listener sharing arrive in later commits; this commit is
// spawn + the startup barrier + join, exercisable with a non-server script.)
lava_run_workers :: proc(path: string, count: int, script_args: []string) -> int {
	data, err := os.read_entire_file(path, context.allocator)
	if err != os.ERROR_NONE {
		process_write(os.stderr, "lava: could not read ", path, "\n")
		return 1
	}
	defer delete(data, context.allocator)
	source := string(data)

	g_multi_worker = true

	barrier := Worker_Barrier {
		total = count,
	}
	workers := make([]Worker, count, context.allocator)
	defer delete(workers, context.allocator)
	threads := make([dynamic]^thread.Thread, 0, count, context.allocator)
	defer delete(threads)

	for i in 0 ..< count {
		workers[i] = Worker {
			source      = source,
			source_name = path,
			script_args = script_args,
			barrier     = &barrier,
		}
		t := thread.create_and_start_with_data(&workers[i], worker_main, nil, .Normal, false)
		if t != nil {
			append(&threads, t)
		} else {
			// A thread that never started can't report — settle a failure on its behalf so the
			// barrier reaches `total` (no forever-wait) and ready peers abort.
			barrier_settle(&barrier, true)
		}
	}

	for t in threads {
		thread.join(t)
		thread.destroy(t)
	}

	// Non-zero if startup was aborted (a worker / thread failed) or any worker exited non-zero.
	code := 0
	if barrier.any_failed do code = 1
	for i in 0 ..< count {
		if workers[i].result.exit_code != 0 do code = workers[i].result.exit_code
		result_destroy(&workers[i].result)
	}
	return code
}
