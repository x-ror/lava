package lava_runtime

import "core:sync"
import "core:testing"
import "core:thread"

// Unit tests for the multi-worker primitives (Slice 3a): the pure LAVA_WORKERS parser and the
// abortable startup barrier. Deterministic and JSC-free (they touch no event loop or context).

// --- lava_parse_worker_count (pure: env + cpu count injected) ----------------------------------------
@(test)
worker_count_parsing :: proc(t: ^testing.T) {
	expect_ok :: proc(t: ^testing.T, raw: string, has: bool, cpu: int, want: int) {
		n, ok, _ := lava_parse_worker_count(raw, has, cpu)
		testing.expectf(t, ok && n == want, "parse(%q,%v,cpu=%d): got (n=%d ok=%v), want n=%d ok", raw, has, cpu, n, ok, want)
	}
	expect_fail :: proc(t: ^testing.T, raw: string, has: bool, cpu: int) {
		_, ok, msg := lava_parse_worker_count(raw, has, cpu)
		testing.expectf(t, !ok && len(msg) > 0, "parse(%q): expected failure with a message, got ok=%v", raw, ok)
	}

	// Unset / "1" / "" -> single inline path.
	expect_ok(t, "", false, 8, 1)
	expect_ok(t, "", true, 8, 1)
	expect_ok(t, "1", true, 8, 1)
	// auto -> cpu count (clamped to >=1).
	expect_ok(t, "auto", true, 8, 8)
	expect_ok(t, "auto", true, 0, 1)
	// explicit valid counts + the [1,256] boundary.
	expect_ok(t, "4", true, 8, 4)
	expect_ok(t, "256", true, 8, 256)
	// invalid: zero / negative / oversized / non-numeric / partial-or-reinterpreted.
	expect_fail(t, "0", true, 8)
	expect_fail(t, "-1", true, 8)
	expect_fail(t, "257", true, 8)
	expect_fail(t, "abc", true, 8)
	expect_fail(t, "0x10", true, 8) // base-10 + full-consume: NOT reinterpreted as hex 16
	expect_fail(t, "10abc", true, 8) // trailing junk rejected
	expect_fail(t, "4.5", true, 8)
	// parse_int accepts an underscore digit separator in any base, so "1_0" -> 10. Harmless (still
	// bounded by [1,256]); the dangerous reinterpretations (hex/trailing-junk) are what we reject.
	expect_ok(t, "1_0", true, 8, 10)
}

// --- startup barrier (real N-thread, deterministic) --------------------------------------------------
@(private = "file")
Barrier_Probe :: struct {
	barrier:  ^Worker_Barrier,
	fail:     bool, // this probe reports a startup failure instead of ready
	released: bool, // result of barrier_ready_wait (meaningful when !fail)
	done:     bool,
}

@(private = "file")
barrier_probe_run :: proc(data: rawptr) {
	p := cast(^Barrier_Probe)data
	if p.fail {
		barrier_settle(p.barrier, true)
	} else {
		p.released = barrier_ready_wait(p.barrier)
	}
	sync.atomic_store(&p.done, true)
}

@(private = "file")
run_barrier :: proc(t: ^testing.T, n_ready, n_fail: int) -> (released_all: bool, any_failed: bool) {
	total := n_ready + n_fail
	b := Worker_Barrier {
		total = total,
	}
	probes := make([]Barrier_Probe, total, context.allocator)
	defer delete(probes, context.allocator)
	threads := make([dynamic]^thread.Thread, 0, total, context.allocator)
	defer delete(threads)
	for i in 0 ..< total {
		probes[i] = Barrier_Probe {
			barrier = &b,
			fail    = i >= n_ready, // first n_ready report ready, the rest fail
		}
		th := thread.create_and_start_with_data(&probes[i], barrier_probe_run, nil, .Normal, false)
		testing.expect(t, th != nil, "probe thread spawned")
		if th != nil do append(&threads, th)
	}
	// join — this completes only if the barrier is deadlock-free (every reporter unblocked).
	for th in threads {
		thread.join(th)
		thread.destroy(th)
	}
	released_all = true
	for i in 0 ..< n_ready do if !probes[i].released do released_all = false
	return released_all, b.any_failed
}

// All-ready -> the barrier RELEASES (every ready worker proceeds) and no deadlock.
@(test)
barrier_all_ready_releases :: proc(t: ^testing.T) {
	released, any_failed := run_barrier(t, 4, 0)
	testing.expect(t, released, "all-ready barrier must release every worker")
	testing.expect(t, !any_failed, "no failure recorded")
}

// Any failure -> the barrier ABORTS (ready workers get released=false) and still no deadlock — the
// failing report wakes the blocked ready workers. This is the abort path a partial startup relies on.
@(test)
barrier_one_failure_aborts :: proc(t: ^testing.T) {
	released, any_failed := run_barrier(t, 3, 1)
	testing.expect(t, !released, "a failed startup must abort the ready workers (released=false)")
	testing.expect(t, any_failed, "failure recorded")
}
