// The event loop must keep running past any fixed iteration ceiling (issue #55).
// Pre-fix the runtime drove the loop with run_until_idle's default 1024-iteration
// cap, so a chain of more than ~1024 ticks was silently truncated and never
// reached the end. This setImmediate chain runs N (> 1024) ticks; on a correct
// runtime it prints the final count, on the capped one it printed nothing.
const N = 3000;
let count = 0;

function tick() {
  count++;
  if (count < N) {
    setImmediate(tick);
  } else {
    console.log('done', count);
  }
}

setImmediate(tick);
