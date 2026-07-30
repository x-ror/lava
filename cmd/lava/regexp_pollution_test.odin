package main

// Lava-only: the network-facing validators must survive a replaced
// `RegExp.prototype.exec`, on the axes where node CANNOT be the oracle.
//
// Why this is not an oracle case. node's URL is native C++ and immune, so
// tests/node-compat/cases/54-url-pollution.js covers the URL half as a real
// differential. The HEADER half cannot go there: undici's header-name validator is
// JavaScript, so under the same poison node 24 ACCEPTS
// `Headers.set('X-Evil: 1\r\nInjected', 'v')` while Lava rejects it. That is a
// deliberate deviation in Lava's favour, and CLAUDE.md §1 requires a deviation to be
// pinned by a Lava-only test rather than left to a comment. This is that test.
//
// The second axis is availability, not validation, and it is the one a review
// caught: `RegExp.prototype[Symbol.replace]` in GLOBAL mode loops on RegExpExec and
// only advances `lastIndex` on an empty match, so a forged non-empty result never
// terminates. Before the fix, `new Headers().set('X-Ok', 'v')` — a valid header —
// never returned under this poison, and the URL path reached 1.4 GB RSS in four
// seconds. Both now answer promptly, which is what the timing-free assertions below
// actually check: the script simply has to finish.

import "core:testing"
import "lava:pkg/runtime/eventloop"
import lava "lava:pkg/runtime"

REGEXP_POLLUTION_SCRIPT :: `
const real = RegExp.prototype.exec;
const forged = ['forged'];
forged.index = 0;
forged.input = '';

// Poison for the duration of one call, then restore before inspecting — reading the
// result through the poisoned prototype would tell us nothing about the runtime.
function under(fn) {
  RegExp.prototype.exec = function () {
    return forged;
  };
  let out;
  try {
    out = fn();
  } catch (e) {
    out = 'THREW:' + e.name;
  } finally {
    RegExp.prototype.exec = real;
  }
  return out;
}

const results = [];

// A header name carrying CRLF is header injection on the wire. Lava must reject it
// even with the validator's carrier replaced; node accepts it here.
results.push(
  'inject=' +
    under(() => {
      const h = new Headers();
      h.set('X-Evil: 1\r\nInjected', 'v');
      return 'ACCEPTED';
    }),
);

// A space is the cheaper, more common shape of the same vector.
results.push(
  'space=' +
    under(() => {
      const h = new Headers();
      h.set('a b', 'v');
      return 'ACCEPTED';
    }),
);

// A VALID header must still work. This is the availability half: it used to hang
// forever in normalizeHeaderValue's global replaceAll, so reaching this line at all
// is the assertion.
results.push(
  'valid=' +
    under(() => {
      const h = new Headers();
      h.set('X-Ok', '  v  ');
      return h.get('x-ok');
    }),
);

// The same spin on the URL path, via the tab/newline strip.
results.push('tab=' + under(() => new URL('http://exa\tmple.com/x').href));

// And the IDNA separator fold, which an uppercase host reaches.
results.push('upper=' + under(() => new URL('http://EXAMPLE.com/').href));

const want = [
  'inject=THREW:TypeError',
  'space=THREW:TypeError',
  'valid=v',
  'tab=http://example.com/x',
  'upper=http://example.com/',
];
for (let i = 0; i < want.length; i++) {
  if (results[i] !== want[i]) {
    throw new Error('want ' + want[i] + ' got ' + results[i]);
  }
}
console.log('regexp-pollution ok');
`

@(test)
regexp_pollution_immunity :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(REGEXP_POLLUTION_SCRIPT, "<regexp-pollution-test>", &loop, false)
	defer lava.result_destroy(&result)

	testing.expectf(
		t,
		result.status == .Ok,
		"eval did not complete cleanly: status=%v message=%q",
		result.status,
		result.message,
	)
	testing.expectf(t, result.exit_code == 0, "eval exit code=%d (want 0)", result.exit_code)
}
