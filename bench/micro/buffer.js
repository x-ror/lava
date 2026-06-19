'use strict';

// Buffer codec throughput: hex / base64 encoding and utf8 decode/encode. These exercise
// the native byte-op fast paths (NATIVE_BYTEOP_MIN gating in buffer.js) on a 1 KiB buffer.
const { bench } = require('../lib/harness');

const buf = Buffer.alloc(1024);
for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;

const text = 'héllo wörld — buffers ☕ '.repeat(16);
const utf8 = Buffer.from(text, 'utf8');

bench('buffer-to-hex', () => buf.toString('hex'), { iterations: 20000 });
bench('buffer-to-base64', () => buf.toString('base64'), { iterations: 20000 });
bench('buffer-from-utf8', () => Buffer.from(text, 'utf8'), {
  iterations: 30000,
});
bench('buffer-to-utf8', () => utf8.toString('utf8'), { iterations: 30000 });
