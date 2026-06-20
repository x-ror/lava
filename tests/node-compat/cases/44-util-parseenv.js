// util.parseEnv — parse a .env-format string. node and lava must produce identical
// output. (BS = a single backslash, built via fromCharCode to avoid any ambiguity.)
const assert = require('node:assert/strict');
const { parseEnv } = require('node:util');
const BS = String.fromCharCode(92);

// basic key=value, last-wins on duplicates, blank/comment lines
assert.deepEqual({ ...parseEnv('FOO=bar\nBAZ=qux') }, { FOO: 'bar', BAZ: 'qux' });
assert.deepEqual({ ...parseEnv('D=1\nD=2') }, { D: '2' });
assert.deepEqual({ ...parseEnv('# c\nK=v\n#d\nL=w') }, { K: 'v', L: 'w' });

// `export ` prefix, key/value trimming, empty value
assert.deepEqual({ ...parseEnv('export X=1') }, { X: '1' });
assert.deepEqual({ ...parseEnv('  SP  =  val  ') }, { SP: 'val' });
assert.deepEqual({ ...parseEnv('E=\nN=5') }, { E: '', N: '5' });

// quotes: single/double/backtick stripped; '=' and spaces kept inside quotes
assert.deepEqual(
  { ...parseEnv('A="hello world"\nB=' + "'single'" + '\nC=`tick`') },
  { A: 'hello world', B: 'single', C: 'tick' },
);
assert.deepEqual({ ...parseEnv('U=a=b=c') }, { U: 'a=b=c' });

// double quotes expand only \n -> newline; everything else is literal
assert.deepEqual({ ...parseEnv('M="a' + BS + 'nb"') }, { M: 'a\nb' });
assert.deepEqual({ ...parseEnv('T="a' + BS + 'tb"') }, { T: 'a' + BS + 'tb' });
// real newline inside a double-quoted value (multiline)
assert.deepEqual({ ...parseEnv('M2="one\ntwo"\nAFTER=x') }, { M2: 'one\ntwo', AFTER: 'x' });
// single quotes are fully literal (no escape expansion)
assert.deepEqual({ ...parseEnv("S='a" + BS + "nb'") }, { S: 'a' + BS + 'nb' });

// inline `#` comment on an unquoted value
assert.deepEqual({ ...parseEnv('A=1 # comment\nB=2') }, { A: '1', B: '2' });
assert.deepEqual({ ...parseEnv('H=ab#cd') }, { H: 'ab' });
// unquoted values keep interior spaces, colons, slashes
assert.deepEqual({ ...parseEnv('URL=http://x:8080/p') }, { URL: 'http://x:8080/p' });

console.log('ok');
