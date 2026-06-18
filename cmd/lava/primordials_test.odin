#+build linux, darwin
package main

import "core:testing"
import lava "lava:pkg/runtime"
import eventloop "lava:pkg/runtime/eventloop"

// Proves the primordials hardening (pkg/runtime/js/internal/primordials.js): a
// script that overwrites the Array/Object intrinsics EventEmitter uses internally
// must not be able to break it. This is a Lava-only test, NOT a node-compat oracle
// case: Node's own EventEmitter is *not* immune here (its _addListener calls a raw
// Array.prototype.push), so Lava is deliberately stronger than Node and the two
// diverge — which an oracle could not express. The script self-asserts (throws on
// any wrong value) and restores the intrinsics before printing, so a clean eval
// (status Ok, exit 0) means EventEmitter stayed correct throughout the pollution.
POLLUTION_SCRIPT :: `
'use strict';
const EventEmitter = require('node:events');

const realPush = Array.prototype.push;
const realUnshift = Array.prototype.unshift;
const realSlice = Array.prototype.slice;
const realSplice = Array.prototype.splice;
const realMap = Array.prototype.map;
const realCreate = Object.create;
const speciesDesc = Object.getOwnPropertyDescriptor(Array, Symbol.species);
const boom = function () {
  throw new Error('intrinsic pollution leaked into a built-in');
};

Array.prototype.push = boom;
Array.prototype.unshift = boom;
Array.prototype.slice = boom;
Array.prototype.splice = boom;
Array.prototype.map = boom;
Object.create = boom;
// Poison Array[Symbol.species] too: slice/map/splice consult it, so a clean run
// proves EventEmitter copies its listener arrays without going through species.
Object.defineProperty(Array, Symbol.species, {
  configurable: true,
  get: function () {
    throw new Error('species pollution leaked into a built-in');
  },
});

let calls = 0;
const ee = new EventEmitter();
const a = function () { calls = calls + 1; };
const b = function () { calls = calls + 1; };
const c = function () { calls = calls + 1; };
const d = function () { calls = calls + 1; };

ee.on('e', a);
ee.on('e', b);
ee.on('e', c);
ee.prependListener('e', d);
ee.emit('e');
ee.removeListener('e', b);
const namesLen = ee.eventNames().length;
const listenerCount = ee.listeners('e').length;
ee.emit('e');

Array.prototype.push = realPush;
Array.prototype.unshift = realUnshift;
Array.prototype.slice = realSlice;
Array.prototype.splice = realSplice;
Array.prototype.map = realMap;
Object.create = realCreate;
Object.defineProperty(Array, Symbol.species, speciesDesc);

if (calls !== 7) throw new Error('calls=' + calls);
if (namesLen !== 1) throw new Error('namesLen=' + namesLen);
if (listenerCount !== 3) throw new Error('listenerCount=' + listenerCount);
console.log('primordials-pollution ok');
`

@(test)
primordials_pollution_immunity :: proc(t: ^testing.T) {
	loop := eventloop.init()
	// eval consumes (destroys) the loop on every path; do not destroy it here.
	result := lava.eval(POLLUTION_SCRIPT, "<primordials-test>", &loop, false)
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

// primordials is an internal-only module: internal factories require() it, but it
// must not leak through the public resolver (it would shadow a user package named
// "primordials" and wrongly answer require('node:primordials')). This evals user
// code and asserts both specifiers fail with MODULE_NOT_FOUND while a genuine
// builtin still resolves. A clean run means the loader's publicReq gate holds.
HIDDEN_FROM_REQUIRE_SCRIPT :: `
'use strict';
function notFound(fn) {
  try {
    fn();
    return false;
  } catch (e) {
    return e && e.code === 'MODULE_NOT_FOUND';
  }
}
if (!notFound(function () { require('primordials'); }))
  throw new Error("require('primordials') must not resolve");
if (!notFound(function () { require('node:primordials'); }))
  throw new Error("require('node:primordials') must not resolve");
if (typeof require('node:events') !== 'function')
  throw new Error('a real builtin must still resolve');
console.log('primordials-hidden ok');
`

@(test)
primordials_hidden_from_user_require :: proc(t: ^testing.T) {
	loop := eventloop.init()
	result := lava.eval(HIDDEN_FROM_REQUIRE_SCRIPT, "<primordials-hidden-test>", &loop, false)
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

