#+build linux, darwin, windows
package lava_runtime

import "core:net"
import "core:strings"
import "core:sync"
import "core:thread"
import eventloop "lava:pkg/runtime/eventloop"

// Bounded DNS resolver pool (#77). Hostname resolution is a blocking getaddrinfo,
// so it runs off the event-loop thread. The previous design spawned ONE thread per
// lookup (thread.create_and_start_with_data per request); under many concurrent
// hostname fetches that could exhaust the process thread limit. This is a small
// fixed pool fed by a shared queue, mirroring libuv's default of 4 resolver
// threads — lazily created on first need, so a program that never resolves a
// hostname spawns no threads.
//
// Lifetime / safety: a worker NEVER touches the Fetch_Request or anything on the
// loop except the final eventloop.post_async handoff — it operates only on its own
// DNS_Job (an owned host copy + result fields). The job carries the result back to
// the loop thread, where fetch_dns_pool_complete_cb reads it and drives the connect.
//   - The loop is kept alive across the lookup by async_begin (balanced by the
//     drain_async decrement when the completion runs).
//   - The Fetch_Request is pinned against reclaim by drive_pending, so a request
//     cancelled mid-lookup is not freed before its completion runs — the completion
//     then sees req.settled and no-ops, exactly like the read-resume drive.
//   - At teardown the pool is stopped and its workers joined BEFORE the loop is
//     destroyed (fetch_dns_pool_shutdown, from fetch_shutdown_active), so no worker
//     can post into a destroyed loop — the same guarantee the old per-request join
//     gave, now bounded to at most FETCH_DNS_POOL_SIZE in-flight resolves.

FETCH_DNS_POOL_SIZE :: 4

// DNS_Job is one resolution request. It owns `host` (a copy — the request's strings
// may be freed independently) and carries the result back. Allocated on submit and
// freed by its completion, or by fetch_dns_pool_shutdown for a job whose completion
// is dropped when the loop tears down.
DNS_Job :: struct {
	host: string,
	loop: ^eventloop.Loop,
	req:  ^Fetch_Request,
	ip4:  [4]u8,
	ok:   bool,
}

Fetch_DNS_Pool :: struct {
	mutex:       sync.Mutex,
	wake:        sync.Cond, // workers sleep here until a job arrives or stop is requested
	pending:     [dynamic]^DNS_Job, // submitted, not yet picked up (mutex-guarded)
	threads:     [dynamic]^thread.Thread,
	outstanding: [dynamic]^DNS_Job, // every live job (loop-thread-only; for teardown free)
	started:     bool,
	stopping:    bool,
}

@(private = "file")
g_fetch_dns_pool: Fetch_DNS_Pool

// fetch_dns_pool_submit hands a hostname resolution to the pool, returning false
// only if no worker thread could be started. Loop-thread only. On success the
// request settles later via fetch_dns_pool_complete_cb; the caller has already done
// async_begin (loop keep-alive) and bumped drive_pending (memory pin).
fetch_dns_pool_submit :: proc(req: ^Fetch_Request, host: string) -> bool {
	if !fetch_dns_pool_ensure_started() do return false
	pool := &g_fetch_dns_pool
	job := new(DNS_Job)
	job.host = strings.clone(host)
	job.loop = req.loop
	job.req = req
	// outstanding is mutated only on the loop thread (here, the completion, and
	// teardown), so it needs no lock; pending is shared with the workers.
	append(&pool.outstanding, job)
	sync.lock(&pool.mutex)
	append(&pool.pending, job)
	sync.cond_signal(&pool.wake)
	sync.unlock(&pool.mutex)
	return true
}

@(private = "file")
fetch_dns_pool_ensure_started :: proc() -> bool {
	pool := &g_fetch_dns_pool
	if pool.started do return true
	pool.stopping = false
	for _ in 0 ..< FETCH_DNS_POOL_SIZE {
		t := thread.create_and_start_with_data(pool, fetch_dns_pool_worker, nil, .Normal, false)
		if t != nil do append(&pool.threads, t)
	}
	// As long as at least one worker started, the pool can make progress.
	if len(pool.threads) == 0 do return false
	pool.started = true
	return true
}

@(private = "file")
fetch_dns_pool_worker :: proc(data: rawptr) {
	pool := cast(^Fetch_DNS_Pool)data
	for {
		sync.lock(&pool.mutex)
		for len(pool.pending) == 0 && !pool.stopping {
			sync.cond_wait(&pool.wake, &pool.mutex)
		}
		if pool.stopping && len(pool.pending) == 0 {
			sync.unlock(&pool.mutex)
			return
		}
		job := pop(&pool.pending) // LIFO — resolution order does not matter
		sync.unlock(&pool.mutex)

		// Blocking resolution, off the loop. The worker writes only into `job`.
		if ep, dns_err := net.resolve_ip4(job.host); dns_err == nil {
			if ip4, ip_ok := ep.address.(net.IP4_Address); ip_ok {
				job.ip4 = transmute([4]u8)ip4
				job.ok = true
			}
		}
		free_all(context.temp_allocator) // release this lookup's resolver scratch
		// Hand back to the loop thread. After this the worker must not touch the job
		// — the completion (or teardown) owns it now.
		eventloop.post_async(job.loop, fetch_dns_pool_complete_cb, job)
	}
}

// fetch_dns_pool_complete_cb runs on the loop thread once a lookup finishes: it
// drives the connect to the resolved address (or rejects on failure), then frees
// the job. A request cancelled mid-lookup is already settled here, so the lookup
// result is simply dropped — the drive_pending decrement lets it be reclaimed.
fetch_dns_pool_complete_cb :: proc(loop: ^eventloop.Loop, user_data: rawptr) {
	job := cast(^DNS_Job)user_data
	req := job.req
	ip4 := job.ip4
	ok := job.ok
	fetch_dns_pool_release_job(job)
	if req == nil do return
	req.drive_pending -= 1
	if req.settled do return
	if !ok {
		fetch_settle_error(req, "fetch: could not resolve host")
		return
	}
	if connected, conn_err := fetch_connect_ip4(req, ip4, req.port); !connected {
		fetch_settle_error(req, conn_err)
	}
}

// fetch_dns_pool_release_job removes a job from the loop-thread outstanding set and
// frees it (host copy + struct).
@(private = "file")
fetch_dns_pool_release_job :: proc(job: ^DNS_Job) {
	pool := &g_fetch_dns_pool
	for i in 0 ..< len(pool.outstanding) {
		if pool.outstanding[i] == job {
			unordered_remove(&pool.outstanding, i)
			break
		}
	}
	delete(job.host)
	free(job)
}

// fetch_dns_pool_shutdown stops the pool and joins its workers, so no worker can
// post into a loop about to be destroyed. Loop-thread only; idempotent (a no-op
// once stopped). The join blocks until any in-flight blocking resolve returns —
// bounded to at most FETCH_DNS_POOL_SIZE lookups, the same blocking the old
// per-request join had. After the join, any job whose completion was posted but
// will be dropped by the loop teardown is freed here (its request is freed
// separately by fetch_destroy_pending). Workers are recreated lazily on the next
// lookup.
fetch_dns_pool_shutdown :: proc() {
	pool := &g_fetch_dns_pool
	if !pool.started do return
	sync.lock(&pool.mutex)
	pool.stopping = true
	sync.cond_broadcast(&pool.wake)
	sync.unlock(&pool.mutex)
	for t in pool.threads {
		thread.join(t)
		thread.destroy(t)
	}
	clear(&pool.threads)
	// The workers have exited, so nothing can touch a job now — free any whose
	// completion will never run (dropped with the loop's async queue at teardown).
	for job in pool.outstanding {
		delete(job.host)
		free(job)
	}
	clear(&pool.outstanding)
	clear(&pool.pending)
	pool.started = false
}
