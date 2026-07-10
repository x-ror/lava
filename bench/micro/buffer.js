'use strict';

// Buffer codec throughput — all codecs are always-native (no JS polyfills).
const { bench } = require('../lib/harness');

const buf = Buffer.alloc(1024);
for (let i = 0; i < buf.length; i++) buf[i] = i & 0xff;

const tiny = Buffer.alloc(16);
for (let i = 0; i < tiny.length; i++) tiny[i] = i & 0xff;

const text = 'héllo wörld — buffers ☕ '.repeat(16);
const utf8 = Buffer.from(text, 'utf8');

// Pure U+00xx code units so latin1 encode/decode round-trips (no em-dash etc.).
const latin1Text = 'HTTP/1.1 headers: café résumé \x80\xff '.repeat(32); // ~1 KiB
const latin1Buf = Buffer.from(latin1Text, 'latin1');

bench('buffer-to-hex', () => buf.toString('hex'), { iterations: 20000 });
bench('buffer-to-base64', () => buf.toString('base64'), { iterations: 20000 });
bench('buffer-from-utf8', () => Buffer.from(text, 'utf8'), {
  iterations: 30000,
});
bench('buffer-to-utf8', () => utf8.toString('utf8'), { iterations: 30000 });

// Tiny inputs still hit native (FFI floor vs Node is expected).
bench('buffer-to-hex-tiny', () => tiny.toString('hex'), { iterations: 50000 });
bench('buffer-from-hex-tiny', () => Buffer.from('deadbeefcafebabe', 'hex'), {
  iterations: 50000,
});

bench('buffer-to-latin1', () => latin1Buf.toString('latin1'), {
  iterations: 20000,
});
bench('buffer-from-latin1', () => Buffer.from(latin1Text, 'latin1'), {
  iterations: 20000,
});

const u16text = 'hello world — buffers '.repeat(24); // ~512 code units → 1 KiB
const u16buf = Buffer.from(u16text, 'utf16le');
bench('buffer-to-utf16le', () => u16buf.toString('utf16le'), {
  iterations: 20000,
});
bench('buffer-from-utf16le', () => Buffer.from(u16text, 'utf16le'), {
  iterations: 20000,
});
