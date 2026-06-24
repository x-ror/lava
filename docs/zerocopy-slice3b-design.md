# MSG_ZEROCOPY for large writes (Slice 3b) — design (review before impl)

Status: **CONVERGED (rev.3)** — three adversarial review rounds (rev.1: 3 critical/12 high; rev.2: 0
critical/7 high — all in the state-machine *prose*; rev.3 round-3: **0 critical/0 high**, 1 medium + 1
low, both folded in). The approach (reuse Slice 2b's `F_MORE` slot-lifetime machinery for `SEND_ZC`'s
two-CQE shape) is validated; §3 is now **ordered pseudocode mirroring the proven
`net_recv_ring_complete`/`on_send_complete` template verbatim** (send_op-clear first, `!conn.closing`
guard, `net_op_finished` LAST). Ready for review-before-impl.

**Scope:** the proactor send path. Sends ≥ a threshold go via `IORING_OP_SEND_ZC` (kernel transmits
from user pages instead of copying); smaller sends keep the plain copy-`SEND`. Headline hello-world
bench unaffected. Linux/io_uring only. Final piece of the proactor epic.

---

## 1. The `SEND_ZC` two-CQE ABI (source: kernel io_uring `io_uring.h`, NOT the Odin bindings)

The Odin bindings provide only the `SEND_ZC`/`SENDMSG_ZC` opcode enum values and
`IO_Uring_CQE_Flags_Bits.MORE`(bit1)/`.NOTIF`(bit3); they model neither the SQE layout nor the two-CQE
shape — that is the kernel ABI. The SQE is a `#raw_union`, so writing `opcode=.SEND_ZC`, `addr`, `len`,
`msg_flags={.NOSIGNAL}` hits the right byte offsets despite the `raw_union_tag`s not listing `.SEND_ZC`
(tag = fmt metadata only). Plain user buffer; `FIXED_BUF` out of scope.

Kernel guarantees (re-assert at review against the running kernel; `SEND_ZC` is ≥ 6.0):
1. A `SEND_ZC` that **enters transmission** posts a **result** CQE with `F_MORE` **set** (`res` = bytes
   sent ≥ 0, possibly **partial**), then exactly **one** **notification** CQE with `F_NOTIF` set,
   `F_MORE` **clear**, when the pages are released (buffer then free). The notif is strictly **ordered
   after** the result for the same `user_data`; never reordered. `F_MORE` and `F_NOTIF` never both set.
2. A `SEND_ZC` that **fails before transmission** (opcode `-EINVAL`, `-EBADF`, `-ENOTSOCK`,
   `-EAGAIN`/`-EINTR` with zero bytes, optmem `-ENOBUFS`/`-ENOMEM`) posts a **single** CQE, `F_MORE`
   **clear**, **no** notification. Zero bytes sent; buffer never pinned.
3. A **cancel** of an op already past its result CQE typically returns `-ENOENT`/`-EALREADY` and cannot
   un-pin handed-off pages; the notification still fires. A cancel that **beats** transmission yields a
   single `-ECANCELED` (`F_MORE` clear, no notif).

**Load-bearing consequence:** the buffer is freeable **exactly on the first `F_MORE`-clear CQE** for the
op (notif, single error, or `-ECANCELED`) — never on a `F_MORE`-set result. So `more := .MORE in
cqe.flags` means "still pinned, terminal owed" (true) vs "free now, terminal" (false). `F_NOTIF` is
informational; the slot lifetime is driven by `F_MORE`, identical to multishot RECV.

---

## 2. Eventloop layer — a ZC-send completion + a distinct slot kind

Slot lifetime is **reused unchanged** from 2b: `drain_uring_completions` releases the slot + decrements
`active_io_count` only on the `F_MORE`-clear CQE, leaving both on `F_MORE`-set. So a `SEND_ZC` op is
**one** slot / **one** `active_io_count` / **one** `dispose` from submit to its terminal — no new
release path, no underflow, no leak.

- **`Op_Send_Completion :: proc(loop, user_data, res: i32, more: bool)`** — new completion type.
- **`Uring_Op_Slot.send_cb`** — new field, **mutually exclusive** with `callback` and `recv_cb`.
- **`uring_op_alloc_slot_send`** sets **only** `send_cb`; **`uring_op_release_slot` must also null
  `send_cb`** (else a reused slot misdispatches). Debug assert at alloc: exactly one callback field set.
- **Drain dispatch order `recv_cb → send_cb → callback`** (mutually exclusive). The `recv_cb` arm (with
  its `bid := transmute(u32)cqe.flags>>16` BUFFER-select read) is never reached by a ZC CQE (a send slot
  has `recv_cb == nil`).
- **`submit_send_zc`** allocates via `uring_op_alloc_slot_send`, **zeroes the SQE** (`sqe^ = {}`, like
  `uring_arm_rw` — a recycled SQE carries stale bytes in the ZC-specific union arms / addr2 / addr_len /
  ioprio), then sets `opcode=.SEND_ZC`, `addr`/`len`=buf, `msg_flags={.NOSIGNAL}`, `ioprio=0`
  (`SEND_ZC_REPORT_USAGE` out of scope, §8). Staged + flushed on the wait `enter` like SEND (1b
  batching unaffected). `len` capped at `URING_MAX_RW` like SEND.

---

## 3. Net layer — the ZC send completion (ordered pseudocode, mirrors the template)

`net_send_zc_complete` is the `send_cb`. It MUST be structured like `net_recv_ring_complete` /
`on_send_complete`: **early-return on the intermediate; on the terminal, clear the op id first, wrap the
buffer decision in `if !conn.closing`, and call `net_op_finished` LAST and unconditionally.** Invariants:

- **INV-1 (result CQE, `more=true`) touches ONLY `active_send_off`.** It must NOT call
  `net_op_finished`, clear `send_op`, touch/rotate/clear/free `active_send`, re-submit, emit `'drain'`,
  re-arm reads, cancel, or close. This is STRICTER than recv's `more=true` path (which pauses multishot)
  — a ZC result is purely `off += res` then return. (Drop rev.2's "exactly like recv's if more" analogy;
  recv's intermediate is not side-effect-free, this one is.)
- **INV-2 — on the terminal (`more=false`): `send_op = OP_ID_INVALID` FIRST**, then the buffer decision
  **only `if !conn.closing`**, then **`net_op_finished` LAST** (unconditional — the sole terminal act
  that runs even while closing). This exact order is what `on_send_complete` (net.odin:689→712) and
  `net_recv_ring_complete` (net.odin:448→516) use; `net_op_finished` last is what keeps `inflight ≥ 1`
  across any re-submit so `net_maybe_free` can't transiently free mid-window (the C1 guard).
- **INV-3 — the terminal `res` is meaningless for byte accounting** (notif `res` = 0/usage). Bytes come
  only from the result CQE. The terminal acts on the recorded `off`; it classifies its own `res` ONLY in
  the no-transmission case (no prior result).
- **INV-4 — `off` advances only on a non-negative result.** A negative `res` (any error) leaves `off`
  untouched, so a fallback/retry re-sends exactly `active_send[off:]` (no double-send/skip). `off`
  monotonic, ≤ `len(active_send)`.

`saw_result` (per-conn, distinguishes "notif after a transmission" from "single error CQE") is **reset
to false in the single submit choke point `net_proactor_submit`** (§4) — so EVERY submission (initial,
state-(c) tail, rotation, fallback-to-plain) clears it exactly once; it is never carried stale into the
next op.

```
net_send_zc_complete(loop, conn, res, more):
  # ---- INTERMEDIATE: result CQE. INV-1: record off ONLY. ----
  if more:
    conn.saw_result = true
    if res >= 0: conn.active_send_off += int(res)
    # (more=true, res<0 is ABI-unreachable per §1(2): a pre-transmission error is a single more=false.
    #  If it ever occurs, do NOTHING here — NEVER close/cancel/free on more=true (INV-1); the owed
    #  terminal will handle it. No state needs recording: the terminal's saw_result=true path acts on
    #  off, which is unchanged, so it re-sends the un-acked tail — safe.)
    return

  # ---- TERMINAL: more=false. Buffer is free (§1). ----
  saw := conn.saw_result
  conn.send_op = OP_ID_INVALID                  # FIRST — re-entrant write()/kick sees a clear gate
  if !conn.closing:
    if saw:                                      # notif after (possibly partial) transmission; ignore res (INV-3)
      if conn.active_send_off < len(conn.active_send):
        net_proactor_submit(conn)                # unsent tail; choke point re-picks ZC vs plain (§4)
      else if len(conn.pending_writes) > 0:
        net_proactor_kick_send(conn)             # rotate pending -> active, then submit VIA net_proactor_submit (§4) — so a large rotated chunk gets ZC
      else:
        clear(conn.active_send); conn.active_send_off = 0
        net_proactor_on_drained(conn)            # emit 'drain', re-arm reads, end_after_drain close
    else:                                        # single terminal, NO transmission: res is the real result (INV-4: off unchanged)
      switch res:
        == 0:                       net_emit_error(conn); net_close_conn(conn, true)   # write-stalled (buffer non-empty by §4 gate)
        -EINVAL and conn.send_was_zc: disable_zc(loop); net_proactor_submit(conn)      # capability -> plain (§5)
        -ENOBUFS, -ENOMEM:          net_proactor_submit(conn)                          # optmem pressure -> copy-send (NOT fatal, §5)
        -EINTR, -EAGAIN:            net_proactor_submit(conn)                          # transient retry (off==0, re-sends whole buffer)
        -ECANCELED:                 pass                                               # benign (closing handled by the guard)
        else:                       net_emit_error(conn); net_close_conn(conn, true)   # fatal
  net_op_finished(conn)                          # LAST, unconditional (mirrors on_send_complete:712)
```

Note: every `net_proactor_submit` above runs BEFORE `net_op_finished`, so `inflight` never transiently
hits 0 (the re-submit re-sets `send_op`+`inflight`); its own internal submit-failure close is safe for
the same reason. On a closing conn the terminal does only `net_op_finished` → `net_maybe_free` (which
frees `active_send` exactly once now that the buffer is unpinned), matching the template's `!closing`
envelope. A ZC submit never stages an empty buffer (the §4 threshold gate implies `len(active_send[off:])
≥ 16 KiB > 0`), so a `res==0` terminal is a genuine stall, not "nothing to send".

---

## 4. The submit choke point, threshold, partial sends, serialization

- **Single choke point `net_proactor_submit(conn)`** decides per submission:
  `use_zc := zc_ok && len(active_send[off:]) >= NET_ZC_THRESHOLD` (proposal 16 KiB). It resets
  `conn.saw_result = false` and sets `conn.send_was_zc = use_zc` (recomputed EVERY submission, like
  `recv_multishot` in `net_maybe_arm_recv` — never stale), then calls `submit_send_zc`
  (`send_cb=net_send_zc_complete`) or the plain `submit_send` (`callback=on_send_complete`). It is the
  **single submitter** that owns `send_op`+`inflight`. All submit sites route through it: the initial
  kick, the state-(c) tail, the §5 fallbacks, AND `net_proactor_kick_send` — which is updated to rotate
  `pending_writes`→`active_send` and then call `net_proactor_submit` (NOT the old plain
  `net_proactor_submit_send` directly), so a back-to-back large rotated chunk gets ZC instead of
  silently degrading to copy-send. (`net_proactor_submit` absorbs the old `net_proactor_submit_send`
  body; `kick_send` only rotates + gates on `send_op != INVALID`.)
- **Partial tail re-evaluates the threshold**: a 16 KiB ZC send that partials to a 4 KiB tail re-sends
  the tail as **plain** (sub-threshold) — no second pin+notif for a small tail. A connection thus mixes
  ZC and plain SENDs across submissions of one buffer; the completion variant follows whichever was
  submitted.
- **One in-flight ZC per conn**: `send_op` held until the terminal (INV-2) → a `write()` in the
  result→terminal window appends to `pending_writes` and `net_proactor_kick_send` no-ops (gated on
  `send_op != INVALID`). No second op, no rotation of the pinned backing.
- **Serialization latency (accepted tradeoff)**: the next write — even a small plain one (HTTP
  keep-alive next header after a big body) — waits one notification RTT, since `send_op` is held to the
  notif, not the result. v1 accepts this (ZC = large bodies). A per-op owned-buffer model that lets a
  later plain copy-SEND overlap the pinned window was considered and **deferred** (§9 Q2).
- A buffer > `URING_MAX_RW` (~2 GiB) is sent as **multiple serialized ops, each its own result+notif
  pair** (the tail is a fresh op via the choke point) — not one op with many notifs.

---

## 5. Capability + transient fallback (per-op attribution)

- **`-EINVAL` (kernel < 6.0)** is state-(d) (single `more=false`, no notif, buffer never pinned). Only
  a `send_was_zc` op treats it as a capability signal: `disable_zc(loop)` (loop-global `zc_ok=false` in
  `Platform_Loop`, gated by `disable_zc` mirroring `disable_multishot`), then `net_proactor_submit` —
  which now picks plain (zc_ok false) and re-sends `active_send[off:]` (`off` untouched, INV-4 → exact
  tail). A **plain**-send `-EINVAL` (`send_was_zc=false`) stays fatal — no fallback loop.
- **`-ENOBUFS`/`-ENOMEM` (optmem/`RLIMIT_MEMLOCK` pressure)** is **transient, not fatal** — symmetric
  with the recv side's `-ENOBUFS` (which parks, never closes). State-(d) routes it to
  `net_proactor_submit` (copy-send fallback for this op); the connection is not closed. Under the
  large-body-to-many/slow-clients workload ZC targets, treating it as fatal would mass-drop connections.
- **Ordering** (already in the §3 pseudocode): clear `send_op` → `net_proactor_submit` (re-sets
  `send_op`+`inflight`; its internal failure-close is safe because this op's `inflight` is still
  counted) → `net_op_finished` LAST. So `inflight` never transiently hits 0 mid-close.
- **Storm bound (corrected)**: `zc_ok` is checked at submit, so once the first `-EINVAL` terminal flips
  it no new ZC is attempted; the residual is bounded by the large sends **already in flight** when that
  terminal lands (per worker) × N workers — **not** "exactly one". Self-limiting; tests must not assert
  "exactly one".

---

## 6. Teardown — buffer frees strictly on the first `more=false`

- Frees on the **first `F_MORE`-clear CQE**, whatever its shape (notif / single error / `-ECANCELED`).
  Never on a `more=true` result; never on a cancel ack of an already-transmitting op.
- `net_close_conn_proactor` cancels `send_op` for promptness, but per §1(3) a cancel past the result is
  best-effort (`-ENOENT`/`-EALREADY`) — the **notification** is the guaranteed terminal that releases
  buffer+slot+`inflight`; `-ECANCELED` does not substitute for it. `conn.inflight` (held to the terminal
  via INV-2) keeps `active_send` alive until then.
- **Loop destroy:** `uring.destroy()` closes the ring fd (kernel won't touch the pages after), then
  `platform_destroy`'s dispose loop fires **once** for the one in-use slot (a post-result/pre-notif op
  is still `in_use` — `more=true` never released it), so `on_op_dispose → net_op_finished` frees
  `active_send` once. Exactly-once **because** INV-1 guarantees the result freed/decremented nothing.

---

## 7. Drain / `want_drain` / `end()` timing + the 2b recv-pause interaction

Moving the full-drain transition from the result to the **notification** (INV-2) shifts timing:
- `'drain'` + read re-arm (`net_proactor_on_drained`) and `end_after_drain` close fire on the terminal
  (one notif RTT later than plain). `end()` after a ≥threshold write closes only after the notif (closing
  on the result would free a pinned buffer — UAF). All three are terminal-`!closing`-only (§3).
- **The transitional window** (result done: `off==len`, so `net_proactor_buffered` ≈ 0, but
  `active_send` not cleared and `'drain'` not emitted until the notif): a recv terminal landing here must
  **not resume reads before `'drain'`** (an ordering break, not a memory hazard — re-arming a recv
  touches the recv ring, not `active_send`). rev.2 claimed `want_drain` keeps reads paused, but that gate
  exists **only** on the multishot `-ECANCELED` recv branch (net.odin:511); the single-shot normal
  terminal and the `-ENOBUFS` re-arm (`net_park_or_rearm`) call `net_maybe_arm_recv` with no
  `want_drain` check, and `net_maybe_arm_recv` gates only on `read_paused = buffered>=HWM` — which is
  false in the window. **Requirement:** fold the `want_drain` check **into `net_maybe_arm_recv`** (reads
  stay paused while a `'drain'` is owed), so ALL recv re-arm paths honor it, not just the `-ECANCELED`
  branch. This also simplifies the 2b `-ECANCELED` branch (its bespoke `!want_drain` guard becomes
  redundant). To be asserted in test (2a single-shot: a recv data terminal in the ZC window must not
  re-arm while `want_drain` is owed).
  - **This also tightens the pre-ZC 2a/1b steady state** (a behavior change beyond ZC, flagged for
    review): today the 2a single-shot, 1b Proactor data, `-EINTR`/`-EAGAIN`, and `-ENOBUFS`
    (`net_park_or_rearm`) re-arms resume reads as soon as `buffered < HWM` — on a *partial* drain,
    before `'drain'`. After the move they stay paused until **full** drain (Node's
    input-paused-until-`'drain'` semantics — the intent already documented in the 2b `-ECANCELED`
    comment); an improvement, not a regression. `read_paused = buffered >= HWM` is still needed for the
    **no-owed-drain** case (a slow consumer that never crossed HWM, so `want_drain` is false) — the two
    gates are complementary. The §10 read-pause test must also cover the non-ZC 2a/1b partial-send case
    so this earlier-slice change is regression-covered.
- `net_proactor_buffered` counts `active_send[off:]` + `pending_writes`, correct mid-ZC for HWM/want_drain.
  A `write()` in the window appends to `pending_writes` (so `buffered` rises again) and
  `net_maybe_pause_multishot` (2b) stays consistent.

---

## 8. Scope guards
- **`SENDMSG_ZC` is unneeded** (not merely deferred): `pending_writes`/`active_send` are a single
  **contiguous** `[dynamic]byte` (writes concatenate), so there is no iovec to scatter-gather —
  single-buffer `SEND_ZC` suffices under the current and a future owned-buffer model.
- **`SEND_ZC_REPORT_USAGE` out of scope** for production — but a debug/verification build may set it to
  **assert the kernel actually zerocopied** (notif `res==0`) vs silently copied (loopback always copies,
  §9 Q5).
- Not the recv side; not below-threshold sends; no readiness-path change.

---

## 9. Open questions for review
1. **Threshold** — 16 KiB vs 32/64 KiB?
2. **Serialized one-ZC-per-conn (§4)** vs a per-op owned-buffer model letting a plain send overlap the
   pinned window — accept the one-notif-RTT serialization for v1 (recommended)?
3. **`-ENOBUFS`** — per-op copy-fallback only (recommended) vs also a `zc_ok` cooldown?
4. **Capability** — first-`-EINVAL` latch (recommended, matches 2b) vs a startup `SEND_ZC` probe
   (extend `uring_probe_proactor`) to gate `zc_ok` up front and skip the per-conn first-send `-EINVAL`
   on < 6.0?
5. **Bench interface** — ZC ≈ no-op on loopback (kernel copies); bench on a real NIC, or document the
   caveat + use `SEND_ZC_REPORT_USAGE` in a verification build to confirm actual zerocopy?

---

## 10. Test & verification plan
- **Unit (eventloop)**: `SEND_ZC` socketpair round-trip — assert the two-CQE sequence (result
  `more=true` `res`=bytes, then notif `more=false`); `active_io_count` stays 1 across the result, → 0
  only on the notif; slot released once; the ZC op never enters the `recv_cb` arm. Forced fallback
  (`zc_ok=false` → plain). Teardown: an in-flight ZC op left **post-result/pre-notif** disposed exactly
  once at destroy → conn freed once (ASAN). A forced submit-failure during the `-EINVAL` fallback frees
  the conn exactly once.
- **State-machine rows (a)–(d)**: result-then-notif; single error vs notif (the `saw_result`
  distinction); a `write()` between result and notif lands in `pending_writes`, NO second op until the
  terminal; `off` advances only on non-negative result; a notif arriving on a **closing** conn runs only
  `net_op_finished` (no submit/drain/emit).
- **Buffer-lifetime (load-bearing, ASAN)**: large ZC write, **cancel AFTER the result but before the
  notif** → `active_send` freed only on the notif, never on the cancel/`-ECANCELED`; peer RST mid-send.
- **2b interaction**: 2a single-shot — a recv data terminal in the ZC result→notif window must NOT
  re-arm reads while `want_drain` is owed (the §7 `net_maybe_arm_recv` gate).
- **Net/HTTP smoke**: large body (≥ threshold) byte-for-byte vs Node, proactor (ZC) + readiness (no ZC);
  partial-send (small socket buf + large body) body integrity across ZC→plain tail; `end()` right after
  a ≥threshold write closes only after the notif.
- **Bench**: large-body throughput vs plain on a real interface (or document the loopback copy caveat);
  hello-world unchanged. Optional verification build asserts actual zerocopy via `REPORT_USAGE`.

## 11. Commit staging (one 3b PR)
1. Eventloop: `Op_Send_Completion` + `send_cb` slot field + `uring_op_alloc_slot_send` + release nulls
   it + `recv→send→callback` dispatch + `submit_send_zc` (SQE-zeroed) — with the eventloop unit tests.
2. Net: the §3 state machine (INV-1..4, ordered exactly as the pseudocode) + the `net_proactor_submit`
   choke point (threshold + `saw_result`/`send_was_zc` reset) + `zc_ok`/`disable_zc` +
   `-EINVAL`/`-ENOBUFS` fallbacks + the §7 `want_drain`-into-`net_maybe_arm_recv` move.
3. Tests (buffer-lifetime incl. cancel-after-result, state rows, large-body integrity, end-after-write,
   2b-window read-pause) + bench + docs.
