// dns-teardown.js — schedules dns.lookup()s and then throws synchronously at the
// top level, so the event loop never runs (JSEvaluateScript returns an exception
// and eval returns before eventloop.run). The runtime must join the in-flight
// resolver workers during teardown instead of letting one post a completion into
// a freed loop/context (use-after-free).
//
// Not a compared node-vs-lava case: the uncaught-error text differs between
// runtimes. The contract this fixture verifies is behavioral — both node and lava
// must exit non-zero from the uncaught throw WITHOUT crashing (no SIGSEGV/abort).
const dns = require('node:dns');

// A spread of in-flight lookups (full enumeration + a slow real query) so at
// least one worker is likely still resolving when teardown runs.
for (let i = 0; i < 8; i++) {
  dns.lookup(`lava-teardown-${i}.invalid`, { all: true }, () => {});
}
dns.lookup('localhost', { family: 4 }, () => {});
dns.lookup('::1', () => {});

throw new Error('boom before the event loop runs');
