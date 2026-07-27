'use strict';

// TextEncoder / TextDecoder throughput. Covers BOTH decoder routes, because they
// have completely different cost models and only one of them was ever measured:
//   * the native Buffer fast path — a fresh, non-streaming, non-fatal utf-8
//     decode, which is what most user code and url.js's lenient percent-decode hit;
//   * the JS code-unit loop — utf-16le, windows-1252, {fatal:true} and
//     {stream:true}. url.js's percentDecodeHostStrict decodes every
//     percent-encoded host through the fatal decoder, so this path is on the URL
//     hot path even though no user ever asks for it by name.
// The JS loop is the one that regressed 1.43x when its accumulator was routed
// through a variadic primordial wrapper, with `make bench` blind to it because
// bench/ had no encoding coverage at all.
const { bench } = require('../lib/harness');

const text = 'Lorem ipsum dolor sit amet, cönsectetur adipiscing élit — 你好世界 😀 ';
const big = text.repeat(60); // ~3.9k code units, over the 0x2000 chunk boundary

const u8 = new TextEncoder().encode(big);
const u16 = (() => {
  const a = new Uint8Array(big.length * 2);
  for (let i = 0; i < big.length; i++) {
    const c = big.charCodeAt(i);
    a[i * 2] = c & 0xff;
    a[i * 2 + 1] = c >> 8;
  }
  return a;
})();
const latin = new Uint8Array(4096);
for (let i = 0; i < latin.length; i++) latin[i] = i & 0xff;

const decUtf8 = new TextDecoder();
const decUtf8Fatal = new TextDecoder('utf-8', { fatal: true });
const dec16 = new TextDecoder('utf-16le');
const dec1252 = new TextDecoder('windows-1252');
const enc = new TextEncoder();
const dest = new Uint8Array(big.length * 4);

bench('decode-utf8-fastpath', () => decUtf8.decode(u8), { iterations: 20000 });
bench('decode-utf8-fatal', () => decUtf8Fatal.decode(u8), { iterations: 2000 });
bench('decode-utf16le', () => dec16.decode(u16), { iterations: 2000 });
bench('decode-win1252', () => dec1252.decode(latin), { iterations: 2000 });
bench(
  'decode-utf8-stream',
  () => {
    const d = new TextDecoder();
    d.decode(u8.subarray(0, 100), { stream: true });
    d.decode(u8.subarray(100));
  },
  { iterations: 2000 },
);
bench('encode-utf8', () => enc.encode(big), { iterations: 20000 });
bench('encode-into', () => enc.encodeInto(big, dest), { iterations: 20000 });
bench('new-textdecoder', () => new TextDecoder('utf-8'), { iterations: 200000 });
