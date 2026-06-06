// Required as './sub/b' by ../a.js. Its own './c' specifier must resolve against
// fixtures/nested/sub (this file's dir), not a.js's dir or the entry's.
const path = require('node:path');
const c = require('./c'); // -> fixtures/nested/sub/c.js

exports.value = 2;
exports.sum = 2 + c.value;
exports.dir = path.basename(__dirname); // 'sub'
