// Required (extensionless) by cases/14-nested-require.js. Its './sub/b' specifier
// must resolve against THIS file's directory (fixtures/nested), not the entry's.
const path = require('node:path');
const b = require('./sub/b'); // -> fixtures/nested/sub/b.js

exports.value = 1;
exports.sum = 1 + b.sum;
exports.dir = path.basename(__dirname); // 'nested'
exports.bdir = b.dir; // 'sub'
