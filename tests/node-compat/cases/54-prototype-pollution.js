// URL, URLSearchParams, and Web Streams must keep working while
// Array.prototype's mutation methods are overridden — Node's implementations
// use primordials, so pollution cannot reach their internals, and Lava's must
// match. Before this guard, a single Array.prototype.push override made
// `new URL(...)` report a spec-shaped (and silently wrong) "Invalid URL".
//
// Pattern: pollute -> run the operation -> restore -> log, so the logging
// itself never runs under pollution and the diff stays about the operation.
const assert = require('node:assert/strict');

const saved = {};
function pollute() {
  for (const name of ['push', 'pop', 'shift', 'splice', 'join', 'map', 'sort']) {
    saved[name] = Array.prototype[name];
    Array.prototype[name] = function () {
      throw new Error('polluted ' + name);
    };
  }
}
function restore() {
  for (const name of Object.keys(saved)) Array.prototype[name] = saved[name];
}

function underPollution(fn) {
  pollute();
  try {
    return fn();
  } finally {
    restore();
  }
}

async function main() {
  // URL parsing end-to-end: path segments, host, query, fragment.
  const href = underPollution(
    () => new URL('https://user:pw@example.com:8443/a/b/c?x=1&y=2#frag').href,
  );
  console.log('url:', href);

  // Percent-encoding path (non-ASCII + reserved characters).
  const enc = underPollution(() => new URL('https://example.com/päth space?q=ä#f ä').href);
  console.log('encoded:', enc);

  // URLSearchParams is deliberately NOT exercised under pollution here: Node's
  // own parseParams calls a raw Array.prototype.push, so Node itself throws —
  // Lava is stronger than Node there, which an oracle cannot express. That
  // guarantee lives in cmd/lava/primordials_test.odin instead.

  // Web Streams: construct + enqueue + close under pollution (the internal
  // queue's append path), restore, then read. The await itself must run
  // restored — Node's own tick plumbing (popAsyncContext) calls a raw
  // Array.prototype.pop, so crossing a tick while polluted kills Node.
  const rs = underPollution(
    () =>
      new ReadableStream({
        start(c) {
          c.enqueue('one');
          c.enqueue('two');
          c.close();
        },
      }),
  );
  const reader = rs.getReader();
  const a = await reader.read();
  const b = await reader.read();
  const end = await reader.read();
  console.log('stream:', JSON.stringify([a.value, b.value, end.done]));

  assert.equal(href, 'https://user:pw@example.com:8443/a/b/c?x=1&y=2#frag');
  console.log('ok');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
