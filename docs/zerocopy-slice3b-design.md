# MSG_ZEROCOPY for large writes (Slice 3b) — design (review before impl)

Status: **rev.4** — three internal adversarial rounds (rev.1: 3 crit/12 high; rev.2: 0 crit/7 high;
rev.3 round-3: 0 crit/0 high) + a Codex review round (5 findings, all real, folded into rev.4). Codex's
key correction: the `io_uring_enter(2)` ABI is subtler than rev.3 assumed — **`F_MORE` (pinned?) and
`res` (bytes/errno) are independent axes**: an *errored* ZC can still pin+notify (so `more=true,res<0`
is real, the error must be carried), and a *copied* ZC is a single `res>0` CQE with no notif (a success,
not a close). §1 + the §3 state machine are now two-axis; `zc_ok` inits `true`; transient fallbacks pass
`force_plain`; `-EOPNOTSUPP` joins `-EINVAL` as a capability fallback. The 2b `F_MORE` slot-lifetime
reuse + the template-mirrored ordering (send_op-clear first, `!closing` guard, `net_op_finished` LAST)
are unchanged. Ready for review-before-impl.

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

Kernel guarantees (per the `io_uring_enter(2)` `IORING_OP_SEND_ZC` text — re-assert at review against
the running kernel; `SEND_ZC` is ≥ 6.0). **The cardinal rule: check `F_MORE`, NOT `res`.** `res` (the
byte count or `-errno`) and `F_MORE` (whether the pages are pinned and a notification is owed) are
**independent** — every `(F_MORE, sign-of-res)` combination occurs:
1. **Pinned (`F_MORE` set on the result):** the pages are held; **exactly one** notification CQE
   (`F_NOTIF` set, `F_MORE` clear) follows when they release. This happens whether the result `res` is
   **≥ 0** (bytes sent, possibly partial) **OR `< 0`** — *an errored request may still have pinned and
   thus still notifies* (man page: "even failed requests may generate a notification"). The notif is
   strictly **ordered after** the result for the same `user_data`. `F_MORE`+`F_NOTIF` never co-occur.
2. **Not pinned (`F_MORE` clear — a single CQE, no notification):** the buffer is free immediately.
   Zerocopy is best-effort — the kernel may **copy** a send (small/unaligned/loopback/non-SG NIC, §9
   Q5), completing it as a single `res > 0` CQE with **no** `F_MORE` and **no** notif — *a normal
   success that must advance the offset, not an error*. Pre-transmission failures (`-EINVAL`,
   `-EOPNOTSUPP`, `-EBADF`, `-ENOTSOCK`, `-EAGAIN`/`-EINTR` zero-byte, optmem `-ENOBUFS`/`-ENOMEM`) are
   also single `F_MORE`-clear CQEs (`res < 0`, never pinned); `res == 0` is a zero-byte stall.
3. A **cancel** past the result returns `-ENOENT`/`-EALREADY` and cannot un-pin handed-off pages — the
   notification still fires. A cancel that **beats** transmission yields a single `-ECANCELED`
   (`F_MORE` clear, no notif).

**Load-bearing consequences:**
- **Buffer lifetime** is driven by `F_MORE` ALONE: the buffer is freeable **exactly on the first
  `F_MORE`-clear CQE** for the op (the notification, or a single non-pinned CQE), never on a
  `F_MORE`-set result. `F_NOTIF` is informational; the slot lifetime is identical to multishot RECV.
- **Result classification** is `res`-driven and is the *separate* axis: a `F_MORE`-set result records
  bytes (`res ≥ 0`) or a sticky error (`res < 0`) to act on at the terminal; a `F_MORE`-clear single
  CQE is a success (`res > 0` → advance), a stall (`res == 0`), or an error (`res < 0`). §3 is the
  full two-axis state machine.

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

- **INV-1 (result CQE, `more=true` — pinned, notif owed) RECORDS ONLY; acts at the terminal.** It does
  exactly one of: `off += res` (if `res ≥ 0`) **or** record a sticky `conn.zc_err = res` (if `res < 0`
  — an errored-but-pinned send still notifies, so the error must be carried, NOT dropped). It must NOT
  `net_op_finished`, clear `send_op`, touch/rotate/clear/free `active_send`, re-submit, emit `'drain'`,
  re-arm, cancel, or close. (Stricter than recv's `more=true`, which pauses multishot.)
- **INV-2 — on the terminal (`more=false`): `send_op = OP_ID_INVALID` FIRST**, then the buffer decision
  **only `if !conn.closing`**, then **`net_op_finished` LAST** (unconditional — the sole terminal act
  that runs even while closing). This exact order is what `on_send_complete` (net.odin:689→712) and
  `net_recv_ring_complete` (net.odin:448→516) use; `net_op_finished` last keeps `inflight ≥ 1` across
  any re-submit so `net_maybe_free` can't transiently free mid-window (the C1 guard).
- **INV-3 — two `res` sources, never confused.** When `saw_result` (a `more=true` result preceded this
  terminal), the terminal IGNORES its own `res` (the notif's `res` is 0/usage) and acts on the recorded
  `off`/`zc_err`. When NOT `saw_result` (a single `F_MORE`-clear CQE — a copied success, stall, or
  pre-transmission error), the terminal's `res` IS the real result and is classified.
- **INV-4 — `off` advances only on a non-negative result** (a `more=true` result `res ≥ 0`, or a
  single-CQE `res > 0`). Any negative `res` leaves `off` untouched, so a fallback/retry re-sends exactly
  `active_send[off:]` (no double-send/skip). `off` monotonic, ≤ `len(active_send)`.

`saw_result` and `zc_err` (per-conn — safe because one send op per conn, §4) are **reset in the single
submit choke point `net_proactor_submit`** (§4), so EVERY submission (initial, tail, rotation, fallback)
clears them; never stale-carried.

```
net_send_zc_complete(loop, conn, res, more):
  # ---- INTERMEDIATE: result CQE, pages PINNED, notif owed. INV-1: RECORD ONLY, then return. ----
  if more:
    conn.saw_result = true
    if res >= 0: conn.active_send_off += int(res)   # bytes sent (possibly partial)
    else:        conn.zc_err = res                  # errored-but-pinned: carry it; the notif surfaces it
    return

  # ---- TERMINAL: more=false, buffer FREE (F_MORE clear, §1). Mirror the template. ----
  saw := conn.saw_result
  conn.send_op = OP_ID_INVALID                       # FIRST — a re-entrant write()/kick sees a clear gate
  if !conn.closing:
    # Resolve the effective error and advance off for a single-CQE (non-pinned) success (INV-3/INV-4).
    err: i32 = 0
    if saw:           err = conn.zc_err              # 0 if the result succeeded; <0 if it errored (ignore THIS cqe's res)
    elif res > 0:     conn.active_send_off += int(res)   # single-CQE COPIED success — kernel didn't ZC; advance like plain
    elif res < 0:     err = res                      # single-CQE pre-transmission error
    # (saw=false, res==0 falls through with err=0 -> the zero-byte stall close below)

    if err < 0:                                      # off untouched on any error (INV-4) -> re-sends the exact tail
      switch err:
        -EINVAL, -EOPNOTSUPP (and conn.send_was_zc): disable_zc(loop); net_proactor_submit(conn, force_plain=true)  # protocol/capability -> plain
        -ENOBUFS, -ENOMEM:                            net_proactor_submit(conn, force_plain=true)                   # optmem -> copy-send, transient (NOT fatal)
        -EINTR, -EAGAIN:                              net_proactor_submit(conn)                                     # transient retry
        -ECANCELED:                                   pass                                                          # benign
        else:                                         net_emit_error(conn); net_close_conn(conn, true)              # fatal (EPIPE, …)
    elif !saw and res == 0:                          net_emit_error(conn); net_close_conn(conn, true)               # zero-byte stall (plain-path parity)
    elif conn.active_send_off < len(conn.active_send): net_proactor_submit(conn)                                   # unsent tail (choke point re-picks ZC vs plain)
    elif len(conn.pending_writes) > 0:                net_proactor_kick_send(conn)                                  # rotate + submit via the choke point
    else:                                            clear(conn.active_send); conn.active_send_off = 0
                                                     net_proactor_on_drained(conn)                                  # 'drain' + re-arm + end_after_drain close
  conn.zc_err = 0; conn.saw_result = false           # reset (also reset in the choke point at next submit)
  net_op_finished(conn)                              # LAST, unconditional (mirrors on_send_complete:712)
```

Notes: every `net_proactor_submit`/`kick_send` runs BEFORE `net_op_finished`, so `inflight` never
transiently hits 0 (the re-submit re-sets `send_op`+`inflight`); the re-submit's own internal
submit-failure close is safe for the same reason. On a closing conn the terminal does only
`net_op_finished` → `net_maybe_free` (frees `active_send` once, the buffer being unpinned), matching the
template's `!closing` envelope. The two **success** entries (`saw` with `zc_err==0`; or `!saw` with
`res>0`) converge on the same off-based decision (tail / rotate / drain); a single-CQE `res>0` is a
**copied** send the kernel chose not to zerocopy (§1(2)) — a normal success, not an error.

---

## 4. The submit choke point, threshold, partial sends, serialization

- **Single choke point `net_proactor_submit(conn, force_plain := false)`** decides per submission:
  `use_zc := !force_plain && zc_ok && len(active_send[off:]) >= NET_ZC_THRESHOLD` (proposal 16 KiB;
  `force_plain` is the §5 transient-fallback one-shot). It resets `conn.saw_result = false` and
  `conn.zc_err = 0`, sets `conn.send_was_zc = use_zc` (recomputed EVERY submission, like `recv_multishot`
  in `net_maybe_arm_recv` — never stale), then calls `submit_send_zc`
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

- **`zc_ok` is initialized `true`** at proactor bring-up (where `multishot_ok` is set — `buf_ring_init`
  / the proactor probe), NOT left at Odin's `false` default. It is only ever *cleared* by `disable_zc`,
  so without the explicit init the submit predicate `zc_ok && …` would be false forever and ZC would
  **never** be attempted. (`zc_ok` lives in `Platform_Loop` like `multishot_ok`; `disable_zc` mirrors
  `disable_multishot`.)
- **`force_plain` — the one-shot the fallbacks need.** `net_proactor_submit(conn, force_plain := false)`
  computes `use_zc := !force_plain && zc_ok && len(active_send[off:]) >= NET_ZC_THRESHOLD`. A transient
  fallback (below) MUST pass `force_plain=true`: otherwise the choke point recomputes `use_zc` from the
  still-true `zc_ok` + still-large buffer and re-issues **another `SEND_ZC`** — re-failing/stalling
  instead of making progress.
- **`-EINVAL` / `-EOPNOTSUPP` (kernel < 6.0, or a protocol/socket without zerocopy support)** — a
  capability signal. Only a `send_was_zc` op treats it so: `disable_zc(loop)` (latches `zc_ok=false`
  loop-wide) **and** `net_proactor_submit(conn, force_plain=true)` — re-sends `active_send[off:]`
  (`off` untouched, INV-4 → exact tail) as plain. A **plain**-send `-EINVAL` (`send_was_zc=false`) stays
  fatal — no fallback loop. (Both the single-CQE form and an errored-but-pinned `zc_err` form route here
  via §3's `err<0` branch; `off` is untouched either way so the plain re-send is exact.)
- **`-ENOBUFS`/`-ENOMEM` (optmem/`RLIMIT_MEMLOCK` pressure)** is **transient, not fatal** — symmetric
  with the recv side's `-ENOBUFS` (which parks, never closes). Routes to `net_proactor_submit(conn,
  force_plain=true)` (copy-send for THIS op; does NOT latch `zc_ok` off — pressure is transient). Under
  the large-body-to-many/slow-clients workload ZC targets, treating it as fatal would mass-drop
  connections.
- **Ordering** (in the §3 pseudocode): clear `send_op` → `net_proactor_submit` (re-sets
  `send_op`+`inflight`; its internal failure-close is safe because this op's `inflight` is still
  counted) → `net_op_finished` LAST. So `inflight` never transiently hits 0 mid-close.
- **Storm bound (corrected)**: `zc_ok` is checked at submit, so once the first `-EINVAL`/`-EOPNOTSUPP`
  terminal latches it off, no new ZC is attempted; the residual is bounded by the large sends **already
  in flight** when that terminal lands (per worker) × N workers — **not** "exactly one". Self-limiting;
  tests must not assert "exactly one".

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
- **State-machine — every `(more, res, saw_result)` cell** (the Codex-round additions): result-then-notif
  success; **`more=true, res<0` (errored-but-pinned)** → the notif surfaces the error (close/fallback),
  NOT a silent tail-resubmit; **`more=false, res>0` single-CQE COPIED success** → advances `off` and
  drains, does NOT close; `more=false, res==0` stall → close; `-EINVAL`/`-EOPNOTSUPP` → `disable_zc` +
  plain re-send; `-ENOBUFS` → `force_plain` re-send, conn NOT closed and `zc_ok` NOT latched off;
  `write()` between result and notif lands in `pending_writes`, NO second op until the terminal; `off`
  advances only on non-negative `res`; a notif on a **closing** conn runs only `net_op_finished`.
- **`zc_ok` init**: with no kernel `SEND_ZC` support, the FIRST large send `-EINVAL`s, latches
  `zc_ok=false`, and falls back to plain — and `zc_ok` must start `true` so ZC is attempted at all
  (assert a large send actually attempts ZC on a ≥6.0 kernel).
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
