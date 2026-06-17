// Blob/File `endings` option (node:buffer). With endings:'native', line endings
// in *string* parts are converted to the platform newline; binary parts
// (Buffer/ArrayBuffer/views) are copied verbatim. The default ('transparent')
// leaves strings untouched. Platform-portable: the expected byte count is
// derived from process.platform so it matches the Node oracle on the same host.
const assert = require('node:assert/strict');

const nl = process.platform === 'win32' ? 2 : 1; // '\r\n' vs '\n'

// '\n' and '\r\n' convert to the native newline; a lone '\r' is left as-is (Node parity).
assert.equal(new Blob(['a\nb'], { endings: 'native' }).size, 1 + nl + 1); // \n -> EOL
assert.equal(new Blob(['a\r\nb'], { endings: 'native' }).size, 1 + nl + 1); // \r\n -> EOL
assert.equal(new Blob(['a\rb'], { endings: 'native' }).size, 3); // lone \r preserved
assert.equal(new Blob(['x\ry\r\nz'], { endings: 'native' }).size, 4 + nl); // mix

// default is transparent (no conversion)
assert.equal(new Blob(['a\nb']).size, 3);
assert.equal(new Blob(['a\nb'], { endings: 'transparent' }).size, 3);

// binary parts are not line-converted, only string parts are
assert.equal(new Blob([Buffer.from([0x0a]), 'x\ny'], { endings: 'native' }).size, 1 + (1 + nl + 1));

// File inherits the same option
assert.equal(new File(['a\nb'], 'f.txt', { endings: 'native' }).size, 1 + nl + 1);
