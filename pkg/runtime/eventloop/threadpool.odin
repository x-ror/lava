package eventloop

import "core:sync"
import "core:thread"

// Generic worker pool. Any blocking or CPU-bound operation (file I/O, a crypto KDF)
// runs OFF the loop thread on a fixed set of workers, then its completion is handed
// back to the loop thread through the same post_async path the async DNS resolver
// uses. This generalizes fetch_dns_pool: instead of one DNS-specific job type, a
// caller supplies a `work` proc (run off-loop) and a `done` proc (run on the loop).
//
// The pool is OWNED BY THE LOOP (Loop.pool), not a process global: each loop has its
// own workers, and destroy() tears down only that loop's pool. (A process-global pool
// would race across loops — notably the parallel test runner, where one loop's
// destroy would join another loop's still-running workers.)
//
// Lifetime / safety mirrors the DNS pool:
//   - The pool is lazily started on the first submit, so a loop that never offloads
//     work spawns no threads.
//   - pool_submit does async_begin(loop) so the loop stays alive and parked in poll
//     until the completion is posted; the matching decrement happens in drain_async
//     when the completion runs.
//   - A worker touches ONLY its job's user_data (never the loop or the JS engine);
//     the single cross-thread handoff is the post_async at the end. The lock/unlock
//     inside post_async publishes whatever the worker wrote into user_data.
//   - At teardown destroy() calls pool_shutdown(loop), which stops and joins every
//     worker BEFORE the loop's async_queue is touched, so no worker can post into a
//     destroyed loop.

// THREADPOOL_SIZE mirrors libuv's default UV_THREADPOOL_SIZE.
THREADPOOL_SIZE :: 4

// Pool_Work runs on a worker thread, off the loop. It must touch only its own
// user_data — no loop calls, no JS engine access — since it runs concurrently with
// the loop thread. Its result is carried back through user_data.
Pool_Work :: proc(user_data: rawptr)

// Pool_Done runs on the loop thread after the work finishes (delivered through
// post_async), so it may safely touch the loop and the JS engine.
Pool_Done :: proc(loop: ^Loop, user_data: rawptr)

// Pool_Job pairs a unit of off-loop work with its on-loop completion. Allocated by
// pool_submit and freed by its completion (pool_complete) — or by pool_shutdown for
// a job whose completion is dropped when the loop tears down. user_data is owned by
// the caller, not the pool.
Pool_Job :: struct {
	work:      Pool_Work,
	done:      Pool_Done,
	user_data: rawptr,
	loop:      ^Loop,
}

// Thread_Pool is embedded in Loop. Its zero value is an unstarted pool (the dynamic
// arrays are nil until first use), so a loop that never submits work allocates and
// spawns nothing.
Thread_Pool :: struct {
	mutex:       sync.Mutex,
	wake:        sync.Cond, // workers sleep here until a job arrives or stop is requested
	pending:     [dynamic]^Pool_Job, // submitted, not yet picked up (mutex-guarded)
	threads:     [dynamic]^thread.Thread,
	outstanding: [dynamic]^Pool_Job, // every live job (loop-thread-only; for teardown free)
	started:     bool,
	stopping:    bool,
}

// pool_submit hands a unit of work to the loop's pool. `work` runs off-loop; `done`
// runs on the loop thread once it finishes. Returns false only if no worker thread
// could be started (or on a nil loop/work), in which case nothing is scheduled.
// Loop-thread only.
pool_submit :: proc(loop: ^Loop, work: Pool_Work, done: Pool_Done, user_data: rawptr = nil) -> bool {
	if loop == nil || work == nil do return false
	pool := &loop.pool

	// Keep the loop alive (and blocking in poll) until the completion is posted.
	// Undone if the pool can't be started, so the loop is not pinned forever.
	async_begin(loop)
	if !pool_ensure_started(loop) {
		async_cancel(loop)
		return false
	}

	job := new(Pool_Job)
	job.work = work
	job.done = done
	job.user_data = user_data
	job.loop = loop

	// outstanding is mutated only on the loop thread (submit, complete, shutdown), so
	// it needs no lock; pending is shared with the workers.
	append(&pool.outstanding, job)
	sync.lock(&pool.mutex)
	append(&pool.pending, job)
	sync.cond_signal(&pool.wake)
	sync.unlock(&pool.mutex)
	return true
}

@(private = "file")
pool_ensure_started :: proc(loop: ^Loop) -> bool {
	pool := &loop.pool
	if pool.started do return true
	pool.stopping = false
	// Workers receive the loop pointer and reach the pool through loop.pool; the loop
	// outlives them (destroy joins every worker before the loop is freed).
	for _ in 0 ..< THREADPOOL_SIZE {
		th := thread.create_and_start_with_data(loop, pool_worker, nil, .Normal, false)
		if th != nil do append(&pool.threads, th)
	}
	// As long as one worker started, the pool can make progress.
	if len(pool.threads) == 0 do return false
	pool.started = true
	return true
}

@(private = "file")
pool_worker :: proc(data: rawptr) {
	loop := cast(^Loop)data
	pool := &loop.pool
	for {
		sync.lock(&pool.mutex)
		for len(pool.pending) == 0 && !pool.stopping {
			sync.cond_wait(&pool.wake, &pool.mutex)
		}
		if pool.stopping && len(pool.pending) == 0 {
			sync.unlock(&pool.mutex)
			return
		}
		// FIFO: take the oldest queued job so a burst of submissions cannot starve an
		// early one behind them (the queue stays small, so pop_front's shift is cheap).
		job := pop_front(&pool.pending)
		sync.unlock(&pool.mutex)

		if job.work != nil do job.work(job.user_data)
		// Release any per-job scratch the work left on this worker's temp arena.
		free_all(context.temp_allocator)
		// Hand back to the loop thread. After this the worker must not touch the job —
		// the completion (or teardown) owns it now.
		post_async(job.loop, pool_complete, job)
	}
}

// pool_complete runs on the loop thread once a job's work finishes: it frees the job
// wrapper, then invokes the caller's `done` with (loop, user_data). The job is
// released before `done` runs so a `done` that submits more work cannot observe a
// half-freed wrapper. The async_begin from submit is balanced by drain_async's
// decrement around this call.
@(private = "file")
pool_complete :: proc(loop: ^Loop, user_data: rawptr) {
	job := cast(^Pool_Job)user_data
	done := job.done
	ud := job.user_data
	pool_release_job(loop, job)
	if done != nil do done(loop, ud)
}

@(private = "file")
pool_release_job :: proc(loop: ^Loop, job: ^Pool_Job) {
	pool := &loop.pool
	for i in 0 ..< len(pool.outstanding) {
		if pool.outstanding[i] == job {
			unordered_remove(&pool.outstanding, i)
			break
		}
	}
	free(job)
}

// pool_shutdown stops the loop's pool and joins its workers, so no worker can post
// into a loop about to be destroyed. Loop-thread only; idempotent (a no-op once
// stopped, or when never started). Queued-but-unstarted jobs are dropped under the
// lock before the workers are woken, so the join blocks only on work already in
// flight — at most THREADPOOL_SIZE units, not the whole backlog. After the join every
// still-outstanding job is freed (the dropped-queue ones, plus any whose completion
// was posted but will be discarded when the loop's async_queue is torn down — that
// task's callback is never invoked, so the freed pointer is not dereferenced).
//
// A dropped job's `done` does NOT run, so a caller whose user_data needs releasing on
// abnormal teardown must track its own in-flight requests (as fetch does) — the pool
// owns only the Pool_Job wrapper, never the caller's user_data.
pool_shutdown :: proc(loop: ^Loop) {
	pool := &loop.pool
	if !pool.started do return
	sync.lock(&pool.mutex)
	pool.stopping = true
	clear(&pool.pending)
	sync.cond_broadcast(&pool.wake)
	sync.unlock(&pool.mutex)
	for th in pool.threads {
		thread.join(th)
		thread.destroy(th)
	}
	clear(&pool.threads)
	for job in pool.outstanding {
		free(job)
	}
	clear(&pool.outstanding)
	pool.started = false
}
